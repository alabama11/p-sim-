import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCKS } from '../sim/blocks';
import { runWorkspace, type Scope } from '../sim/expr';
import { simulate, SimError, type SimResult } from '../sim/engine';
import { SOLVER_LABELS } from '../sim/solvers';
import { defaultSettings, emptyModel, type Model, type SolverName } from '../sim/types';
import { Canvas, type View } from './Canvas';
import { ParamDialog, SettingsDialog, WorkspaceDialog } from './dialogs';
import { EXAMPLES } from './examples';
import { blockSize } from './geometry';
import { Library } from './Library';
import { addBlock, copySelection, deleteSelection, paste, pruneLinks, type Clip } from './modelOps';
import { ScopeWindow } from './ScopeWindow';

const APP_NAME = 'P-Sim';
const AUTOSAVE_KEY = 'psim:autosave';

type Dialog = { kind: 'params'; id: string } | { kind: 'settings' } | { kind: 'workspace' } | { kind: 'help' } | null;

interface History {
  past: Model[];
  present: Model;
  future: Model[];
}

function loadInitial(): Model {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return parseModelFile(raw);
  } catch {
    // storage unavailable or corrupt: fall back to an example
  }
  return EXAMPLES[0].make();
}

function parseModelFile(text: string): Model {
  const data = JSON.parse(text);
  const m = data?.format === 'p-sim' ? data.model : data;
  if (!m || !Array.isArray(m.blocks) || !Array.isArray(m.links)) throw new Error('Súbor neobsahuje model P-Sim.');
  for (const b of m.blocks) if (!BLOCKS[b.type]) throw new Error(`Neznámy typ bloku „${b.type}“.`);
  return {
    ...emptyModel(),
    ...m,
    workspace: m.workspace ?? '',
    settings: { ...defaultSettings(), ...m.settings },
  };
}

export function App() {
  const [hist, setHist] = useState<History>(() => ({ past: [], present: loadInitial(), future: [] }));
  const model = hist.present;
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [openScopes, setOpenScopes] = useState<string[]>([]);
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<{ message: string; blockId?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const clipRef = useRef<Clip | null>(null);
  const pasteCount = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setModel = useCallback((m: Model, record = true) => {
    setHist((h) => (record ? { past: [...h.past, h.present].slice(-200), present: m, future: [] } : { ...h, present: m }));
  }, []);
  const checkpoint = useCallback(() => {
    setHist((h) => ({ past: [...h.past, h.present].slice(-200), present: h.present, future: [] }));
  }, []);
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));

  useEffect(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ format: 'p-sim', version: 1, model }));
    } catch {
      // autosave is a convenience only
    }
  }, [model]);

  useEffect(() => {
    document.title = `${model.name} – ${APP_NAME}`;
  }, [model.name]);

  const fitView = useCallback((m: Model) => {
    const el = mainRef.current;
    if (!el || m.blocks.length === 0) return setView({ x: 40, y: 40, k: 1 });
    const xs = m.blocks.flatMap((b) => [b.x, b.x + blockSize(b).w]);
    const ys = m.blocks.flatMap((b) => [b.y, b.y + blockSize(b).h + 16]);
    const x1 = Math.min(...xs) - 40, x2 = Math.max(...xs) + 40, y1 = Math.min(...ys) - 40, y2 = Math.max(...ys) + 40;
    const k = Math.min(1.2, el.clientWidth / (x2 - x1), el.clientHeight / (y2 - y1));
    setView({ k, x: (el.clientWidth - (x2 - x1) * k) / 2 - x1 * k, y: (el.clientHeight - (y2 - y1) * k) / 2 - y1 * k });
  }, []);

  useEffect(() => fitView(model), []); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceModel = (m: Model) => {
    setHist({ past: [], present: m, future: [] });
    setSelection(new Set());
    setOpenScopes([]);
    setResult(null);
    setError(null);
    requestAnimationFrame(() => fitView(m));
  };

  const run = () => {
    setRunning(true);
    setError(null);
    // Let the "running" state paint before the synchronous simulation.
    setTimeout(() => {
      try {
        const r = simulate(model);
        setResult(r);
        const scopes = model.blocks.filter((b) => b.type === 'Scope').map((b) => b.id);
        setOpenScopes((open) => (open.length ? open : scopes));
      } catch (e) {
        setResult(null);
        setError({ message: (e as Error).message, blockId: e instanceof SimError ? e.blockId : undefined });
      } finally {
        setRunning(false);
      }
    }, 20);
  };

  const viewCenter = () => {
    const el = mainRef.current!;
    return { x: (el.clientWidth / 2 - view.x) / view.k, y: (el.clientHeight / 2 - view.y) / view.k };
  };

  const add = (type: string, at = viewCenter()) => {
    const r = addBlock(model, type, Math.round((at.x - 30) / 5) * 5, Math.round((at.y - 22) / 5) * 5);
    setModel(r.model);
    setSelection(new Set([r.id]));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        setModel(deleteSelection(model, selection));
        setSelection(new Set());
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection(new Set([...model.blocks.map((b) => b.id), ...model.links.map((l) => l.id)]));
      } else if (mod && e.key.toLowerCase() === 'c' && selection.size) {
        clipRef.current = copySelection(model, selection);
        pasteCount.current = 0;
      } else if (mod && e.key.toLowerCase() === 'v' && clipRef.current?.blocks.length) {
        pasteCount.current++;
        const r = paste(model, clipRef.current, 20 * pasteCount.current);
        setModel(r.model);
        setSelection(new Set(r.ids));
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      } else if (e.key === 'F5' || (mod && e.key === 'Enter')) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = () => {
    const blob = new Blob([JSON.stringify({ format: 'p-sim', version: 1, model }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${model.name || 'model'}.psim`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const open = async (file: File) => {
    try {
      replaceModel(parseModelFile(await file.text()));
    } catch (e) {
      setError({ message: `Súbor sa nepodarilo otvoriť: ${(e as Error).message}` });
    }
  };

  const openBlock = (id: string) => {
    const b = model.blocks.find((x) => x.id === id);
    if (!b) return;
    if (b.type === 'Scope') setOpenScopes((s) => (s.includes(id) ? s : [...s, id]));
    else setDialog({ kind: 'params', id });
  };

  const displays: Record<string, string> = {};
  if (result) {
    for (const b of model.blocks) {
      const log = result.logs[b.id];
      if (b.type === 'Display' && log?.t.length) displays[b.id] = String(+log.y[0][log.y[0].length - 1].toPrecision(5));
    }
  }

  let scope: Scope = {};
  try {
    scope = runWorkspace(model.workspace);
  } catch {
    // glyphs fall back to raw parameter text
  }

  const dialogBlock = dialog?.kind === 'params' ? model.blocks.find((b) => b.id === dialog.id) : undefined;
  const fixedSolver = !['ode45', 'ode23'].includes(model.settings.solver);

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">{APP_NAME}</span>
        <input
          className="model-name"
          value={model.name}
          onChange={(e) => setModel({ ...model, name: e.target.value.replace(/[^\p{L}\p{N}_-]/gu, '_') }, false)}
          title="Názov modelu"
        />
        <div className="tool-group">
          <button onClick={() => replaceModel(emptyModel())} title="Nový prázdny model">Nový</button>
          <button onClick={() => fileRef.current!.click()} title="Otvoriť súbor .psim">Otvoriť</button>
          <button onClick={save} title="Uložiť model (Ctrl+S)">Uložiť</button>
          <select
            value=""
            onChange={(e) => {
              const ex = EXAMPLES[Number(e.target.value)];
              if (ex) replaceModel(ex.make());
            }}
            title="Otvoriť ukážkový model"
          >
            <option value="" disabled>Príklady…</option>
            {EXAMPLES.map((ex, i) => <option key={i} value={i}>{ex.title}</option>)}
          </select>
        </div>
        <div className="tool-group">
          <button onClick={undo} disabled={!hist.past.length} title="Späť (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={!hist.future.length} title="Znova (Ctrl+Y)">↷</button>
          <button onClick={() => fitView(model)} title="Zobraziť celý model">⤢</button>
        </div>
        <div className="tool-group">
          <select
            value={model.settings.solver}
            onChange={(e) => setModel({ ...model, settings: { ...model.settings, solver: e.target.value as SolverName } })}
            title={SOLVER_LABELS[model.settings.solver]}
          >
            {Object.keys(SOLVER_LABELS).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="inline" title="Čas konca simulácie [s]">
            Koniec
            <input
              className="stop-time"
              value={model.settings.stopTime}
              onChange={(e) => setModel({ ...model, settings: { ...model.settings, stopTime: e.target.value } }, false)}
            />
          </label>
          {fixedSolver && <span className="muted">krok {model.settings.fixedStep}</span>}
          <button onClick={() => setDialog({ kind: 'settings' })} title="Nastavenia simulácie">⚙</button>
          <button onClick={() => setDialog({ kind: 'workspace' })} title="Premenné modelu (pracovný priestor)">x =</button>
          <button className="run" onClick={run} disabled={running} title="Spustiť simuláciu (F5)">
            {running ? '…' : '▶'} Spustiť
          </button>
        </div>
        <button className="help-btn" onClick={() => setDialog({ kind: 'help' })} title="Nápoveda">?</button>
        <input
          ref={fileRef}
          type="file"
          accept=".psim,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) open(f);
            e.target.value = '';
          }}
        />
      </header>

      <div className="workspace">
        <Library onAdd={(t) => add(t)} />
        <main ref={mainRef} className="main">
          <Canvas
            model={model}
            view={view}
            setView={setView}
            selection={selection}
            setSelection={setSelection}
            onChange={setModel}
            onCheckpoint={checkpoint}
            onOpenBlock={openBlock}
            onDropBlock={(t, at) => add(t, at)}
            errorBlock={error?.blockId}
            displays={displays}
            scope={scope}
          />
          {model.blocks.length === 0 && (
            <div className="empty-hint">
              Pretiahnite bloky z knižnice vľavo a prepojte ich ťahaním od výstupu (▷) k vstupu.
            </div>
          )}
          {openScopes
            .map((id) => model.blocks.find((b) => b.id === id))
            .map((b, i) => b && (
              <ScopeWindow
                key={b.id}
                index={i}
                title={b.name}
                log={result?.logs[b.id]}
                onClose={() => setOpenScopes((s) => s.filter((x) => x !== b.id))}
                onParams={() => setDialog({ kind: 'params', id: b.id })}
              />
            ))}
        </main>
      </div>

      <footer className={error ? 'statusbar error' : 'statusbar'}>
        {error
          ? `Chyba: ${error.message}`
          : running
            ? 'Simulácia beží…'
            : result
              ? `Hotovo: t = ${+result.tEnd.toPrecision(6)} s, ${result.steps} krokov` +
                (result.rejected ? ` (${result.rejected} zamietnutých)` : '') +
                `, ${result.elapsedMs.toFixed(0)} ms` +
                (result.warnings.length ? ` · Upozornenie: ${result.warnings[0]}` + (result.warnings.length > 1 ? ` (+${result.warnings.length - 1})` : '') : '')
              : 'Pripravené. Dvojklik na blok otvorí jeho parametre, dvojklik na Scope zobrazí graf.'}
      </footer>

      {dialog?.kind === 'params' && dialogBlock && (
        <ParamDialog
          block={dialogBlock}
          workspace={model.workspace}
          onClose={() => setDialog(null)}
          onApply={(b) => {
            setModel(pruneLinks({ ...model, blocks: model.blocks.map((x) => (x.id === b.id ? b : x)) }));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          settings={model.settings}
          onClose={() => setDialog(null)}
          onApply={(s) => {
            setModel({ ...model, settings: s });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'workspace' && (
        <WorkspaceDialog
          workspace={model.workspace}
          onClose={() => setDialog(null)}
          onApply={(ws) => {
            setModel({ ...model, workspace: ws });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header>Nápoveda</header>
        <div className="modal-body help">
          <table>
            <tbody>
              <tr><td>Pridať blok</td><td>pretiahnuť z knižnice, alebo dvojklik v knižnici</td></tr>
              <tr><td>Prepojiť</td><td>ťahať od výstupu bloku (vpravo) k vstupu (vľavo)</td></tr>
              <tr><td>Odbočka čiary</td><td>ťahať z existujúcej čiary k ďalšiemu vstupu</td></tr>
              <tr><td>Parametre</td><td>dvojklik na blok</td></tr>
              <tr><td>Graf</td><td>dvojklik na Scope</td></tr>
              <tr><td>Posun plátna</td><td>ťahať prázdne miesto</td></tr>
              <tr><td>Priblíženie</td><td>koliesko myši</td></tr>
              <tr><td>Výber viacerých</td><td>Shift + klik, alebo Shift + ťahanie</td></tr>
              <tr><td>Zmazať</td><td>Delete</td></tr>
              <tr><td>Späť / znova</td><td>Ctrl+Z / Ctrl+Y</td></tr>
              <tr><td>Kopírovať / vložiť</td><td>Ctrl+C / Ctrl+V</td></tr>
              <tr><td>Spustiť</td><td>F5 alebo Ctrl+Enter</td></tr>
              <tr><td>Uložiť</td><td>Ctrl+S (súbor .psim)</td></tr>
            </tbody>
          </table>
        </div>
        <footer><button className="primary" onClick={onClose}>Zavrieť</button></footer>
      </div>
    </div>
  );
}
