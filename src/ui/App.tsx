import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCKS } from '../sim/blocks';
import { runWorkspace, type Scope } from '../sim/expr';
import { scopeAt, subsystemPorts } from '../sim/flatten';
import { simulate, SimError, type SimResult } from '../sim/engine';
import { SOLVER_LABELS } from '../sim/solvers';
import { defaultSettings, emptyModel, type BlockModel, type Diagram, type Model, type SolverName } from '../sim/types';
import { Canvas, type View } from './Canvas';
import { MaskDialog, Modal, ParamDialog, SettingsDialog, WorkspaceDialog } from './dialogs';
import { importSimulink } from '../io/simulink';
import { EXAMPLES } from './examples';
import { blockSize } from './geometry';
import { Library } from './Library';
import {
  addBlock, copySelection, createSubsystem, deleteSelection, findByPath, getDiagram, paste, pathNames, pruneLinks,
  setDiagram, validPath, type Clip,
} from './modelOps';
import { ScopeWindow } from './ScopeWindow';

const APP_NAME = 'P-Sim';
const AUTOSAVE_KEY = 'psim:autosave';

type Dialog = { kind: 'params'; id: string } | { kind: 'mask'; id: string } | { kind: 'settings' } | { kind: 'workspace' } | { kind: 'help' } | null;

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
  const check = (d: Diagram) => {
    for (const b of d.blocks) {
      if (!BLOCKS[b.type]) throw new Error(`Neznámy typ bloku „${b.type}“.`);
      if (b.children) check(b.children);
    }
  };
  check(m);
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
  const [rawPath, setPath] = useState<string[]>([]);
  // Undo can remove the subsystem being viewed; fall back to the deepest level that exists.
  const path = validPath(model, rawPath);
  const diagram = getDiagram(model, path);
  const prefix = path.length ? path.join('/') + '/' : '';
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [openScopes, setOpenScopes] = useState<string[]>([]);
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<{ message: string; blockId?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<{ title: string; intro: string; items: string[] } | null>(null);
  const clipRef = useRef<Clip | null>(null);
  const pasteCount = useRef(0);
  const mainRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setModel = useCallback((m: Model, record = true) => {
    const pm = pruneLinks(m);
    setHist((h) => (record ? { past: [...h.past, h.present].slice(-200), present: pm, future: [] } : { ...h, present: pm }));
  }, []);
  /** Replaces the diagram currently shown (top level or inside a subsystem). */
  const setLevel = (d: Diagram, record = true) => setModel(setDiagram(model, path, d), record);
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

  const fitView = useCallback((m: Diagram) => {
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
    setPath([]);
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
        // Open the scopes of the top level and of the level being viewed.
        const scopes = [
          ...model.blocks.filter((b) => b.type === 'Scope').map((b) => b.id),
          ...(path.length ? diagram.blocks.filter((b) => b.type === 'Scope').map((b) => prefix + b.id) : []),
        ];
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
    const r = addBlock(diagram, type, Math.round((at.x - 30) / 5) * 5, Math.round((at.y - 22) / 5) * 5);
    setLevel(r.diagram);
    setSelection(new Set([r.id]));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        setLevel(deleteSelection(diagram, selection));
        setSelection(new Set());
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection(new Set([...diagram.blocks.map((b) => b.id), ...diagram.links.map((l) => l.id)]));
      } else if (mod && e.key.toLowerCase() === 'c' && selection.size) {
        clipRef.current = copySelection(diagram, selection);
        pasteCount.current = 0;
      } else if (mod && e.key.toLowerCase() === 'v' && clipRef.current?.blocks.length) {
        pasteCount.current++;
        const r = paste(diagram, clipRef.current, 20 * pasteCount.current);
        setLevel(r.diagram);
        setSelection(new Set(r.ids));
      } else if (mod && e.key.toLowerCase() === 'i' && selectedBlocks.length) {
        e.preventDefault();
        flipSelected();
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        group();
      } else if (mod && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (selectedSubsystem) setDialog({ kind: 'mask', id: selectedSubsystem.id });
      } else if (e.key === 'Escape' && path.length) {
        goTo(path.length - 1);
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
      if (/\.(slx|mdl)$/i.test(file.name)) {
        const { model: m, warnings } = await importSimulink(file.name, new Uint8Array(await file.arrayBuffer()));
        replaceModel(m);
        if (warnings.length) {
          setReport({
            title: `Import: ${file.name}`,
            intro: 'Model sa otvoril. Niektoré časti nemajú v P-Sim zodpovedajúci blok alebo nastavenie:',
            items: warnings,
          });
        }
      } else {
        replaceModel(parseModelFile(await file.text()));
      }
    } catch (e) {
      setError({ message: `Súbor sa nepodarilo otvoriť: ${(e as Error).message}` });
    }
  };

  const enter = (id: string) => {
    const b = diagram.blocks.find((x) => x.id === id);
    if (!b?.children) return;
    setPath([...path, id]);
    setSelection(new Set());
    setDialog(null);
    requestAnimationFrame(() => fitView(b.children!));
  };

  const goTo = (level: number) => {
    const p = path.slice(0, level);
    setPath(p);
    setSelection(new Set());
    requestAnimationFrame(() => fitView(getDiagram(model, p)));
  };

  const group = () => {
    const r = createSubsystem(diagram, selection);
    if (!r) return;
    setLevel(r.diagram);
    setSelection(new Set([r.id]));
  };

  const openBlock = (id: string) => {
    const b = diagram.blocks.find((x) => x.id === id);
    if (!b) return;
    if (b.type === 'Scope') setOpenScopes((s) => (s.includes(prefix + id) ? s : [...s, prefix + id]));
    else if (b.type === 'Subsystem' && !b.mask) enter(id);
    else setDialog({ kind: 'params', id });
  };

  const flipSelected = () =>
    setLevel({ ...diagram, blocks: diagram.blocks.map((b) => (selection.has(b.id) ? { ...b, flip: !b.flip } : b)) });

  const updateBlock = (b: BlockModel) => setLevel({ ...diagram, blocks: diagram.blocks.map((x) => (x.id === b.id ? b : x)) });

  const selectedBlocks = diagram.blocks.filter((b) => selection.has(b.id));
  const selectedSubsystem = selectedBlocks.length === 1 && selectedBlocks[0].type === 'Subsystem' ? selectedBlocks[0] : undefined;

  // Error inside a subsystem: highlight the block at this level that contains it.
  let errorBlock: string | undefined;
  if (error?.blockId?.startsWith(prefix)) errorBlock = error.blockId.slice(prefix.length).split('/')[0];

  const displays: Record<string, string> = {};
  if (result) {
    for (const b of diagram.blocks) {
      const log = result.logs[prefix + b.id];
      if (b.type === 'Display' && log?.t.length) {
        const vals = log.y.map((ch) => +ch[ch.length - 1].toPrecision(5));
        displays[b.id] = vals.length === 1 ? String(vals[0]) : `[${vals.length > 6 ? `${vals.slice(0, 6).join(' ')} …` : vals.join(' ')}]`;
      }
    }
  }

  // Vector links are drawn thicker and labelled with their width.
  const linkWidths: Record<string, number> = {};
  if (result) {
    for (const l of diagram.links) {
      const sb = diagram.blocks.find((b) => b.id === l.src.block);
      if (!sb) continue;
      let key = `${prefix}${sb.id}:${l.src.port}`;
      if (sb.type === 'Subsystem') {
        const op = subsystemPorts(sb).outports[l.src.port];
        if (op) key = `${prefix}${sb.id}/${op.id}:0`;
      }
      const w = result.widths[key];
      if (w) linkWidths[l.id] = w;
    }
  }

  // Variables visible at this level: the workspace plus the masks of enclosing subsystems.
  let scope: Scope = {};
  let scopeError: string | undefined;
  try {
    scope = scopeAt(model, path, runWorkspace(model.workspace));
  } catch (e) {
    scopeError = (e as Error).message;
  }

  const dialogBlock = dialog && 'id' in dialog ? diagram.blocks.find((b) => b.id === dialog.id) : undefined;
  const names = pathNames(model, path);
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
          <button onClick={() => fileRef.current!.click()} title="Otvoriť model .psim alebo model Simulinku .slx / .mdl">Otvoriť</button>
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
          <button onClick={() => fitView(diagram)} title="Zobraziť celý model">⤢</button>
        </div>
        <div className="tool-group">
          <button onClick={flipSelected} disabled={!selectedBlocks.length} title="Zrkadliť vybrané bloky – vstupy vpravo (Ctrl+I)">⇄</button>
          <button onClick={group} disabled={!selectedBlocks.length} title="Vytvoriť subsystém z vybraných blokov (Ctrl+G)">Subsystém</button>
          <button
            onClick={() => selectedSubsystem && setDialog({ kind: 'mask', id: selectedSubsystem.id })}
            disabled={!selectedSubsystem}
            title="Vytvoriť alebo upraviť masku vybraného subsystému (Ctrl+M)"
          >
            Maska
          </button>
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
          accept=".psim,.json,.slx,.mdl"
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
            model={diagram}
            view={view}
            setView={setView}
            selection={selection}
            setSelection={setSelection}
            onChange={setLevel}
            onCheckpoint={checkpoint}
            onOpenBlock={openBlock}
            onDropBlock={(t, at) => add(t, at)}
            errorBlock={errorBlock}
            displays={displays}
            linkWidths={linkWidths}
            scope={scope}
          />
          {path.length > 0 && (
            <nav className="breadcrumb">
              <button onClick={() => goTo(path.length - 1)} title="O úroveň vyššie (Esc)">↑</button>
              <a onClick={() => goTo(0)}>{model.name}</a>
              {names.map((n, i) => (
                <span key={i}>
                  {' › '}
                  {i === names.length - 1 ? <b>{n}</b> : <a onClick={() => goTo(i + 1)}>{n}</a>}
                </span>
              ))}
            </nav>
          )}
          {diagram.blocks.length === 0 && (
            <div className="empty-hint">
              Pretiahnite bloky z knižnice vľavo a prepojte ich ťahaním od výstupu (▷) k vstupu.
            </div>
          )}
          {openScopes
            .map((fid) => [fid, findByPath(model, fid)] as const)
            .map(([fid, b], i) => b && (
              <ScopeWindow
                key={fid}
                index={i}
                title={result?.logs[fid]?.name ?? b.name}
                log={result?.logs[fid]}
                onClose={() => setOpenScopes((s) => s.filter((x) => x !== fid))}
                onParams={() => {
                  const ids = fid.split('/');
                  setPath(ids.slice(0, -1));
                  setDialog({ kind: 'params', id: ids[ids.length - 1] });
                }}
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
                (result.warnings.length === 1 ? ` · Upozornenie: ${result.warnings[0]}` : '')
              : 'Pripravené. Dvojklik na blok otvorí jeho parametre, dvojklik na Scope zobrazí graf.'}
        {!error && !running && result && result.warnings.length > 1 && (
          <a
            className="status-more"
            onClick={() => setReport({ title: 'Upozornenia simulácie', intro: '', items: result.warnings })}
          >
            {` · ${result.warnings.length} upozornení (zobraziť)`}
          </a>
        )}
      </footer>

      {report && (
        <Modal title={report.title} onClose={() => setReport(null)} footer={<button className="primary" onClick={() => setReport(null)}>OK</button>}>
          {report.intro && <p className="hint">{report.intro}</p>}
          <ul className="report-list">
            {report.items.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Modal>
      )}

      {dialog?.kind === 'params' && dialogBlock && (
        <ParamDialog
          key={dialogBlock.id}
          block={dialogBlock}
          scope={scope}
          scopeError={scopeError}
          onClose={() => setDialog(null)}
          onApply={(b) => {
            updateBlock(b);
            setDialog(null);
          }}
          onOpenContents={dialogBlock.type === 'Subsystem' ? () => enter(dialogBlock.id) : undefined}
          onEditMask={dialogBlock.type === 'Subsystem' ? () => setDialog({ kind: 'mask', id: dialogBlock.id }) : undefined}
        />
      )}
      {dialog?.kind === 'mask' && dialogBlock && (
        <MaskDialog
          block={dialogBlock}
          onClose={() => setDialog(null)}
          onApply={(mask) => {
            const params = { ...dialogBlock.params };
            for (const mp of mask?.params ?? []) params[mp.name] ??= mp.default;
            updateBlock({ ...dialogBlock, mask, params });
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
              <tr><td>Zrkadliť blok</td><td>Ctrl+I (vstupy vpravo, pre spätné väzby)</td></tr>
              <tr><td>Subsystém z výberu</td><td>Ctrl+G</td></tr>
              <tr><td>Otvoriť subsystém</td><td>dvojklik (maskovaný: tlačidlo Otvoriť obsah)</td></tr>
              <tr><td>Späť o úroveň</td><td>Esc alebo ↑ v navigácii</td></tr>
              <tr><td>Maska subsystému</td><td>Ctrl+M</td></tr>
              <tr><td>Spustiť</td><td>F5 alebo Ctrl+Enter</td></tr>
              <tr><td>Uložiť</td><td>Ctrl+S (súbor .psim)</td></tr>
              <tr><td>Vektorové signály</td><td>Constant [1 2 3], Mux a Demux; vektorová čiara je hrubšia a ukazuje počet prvkov</td></tr>
              <tr><td>Vlastný kód</td><td>blok Fcn (výraz z u a t) alebo Octave Function (if, for, while, viac vstupov a výstupov)</td></tr>
              <tr><td>Otvoriť</td><td>súbory .psim aj modely Simulinku .slx a .mdl (nepodporované bloky sa nahradia zástupcom)</td></tr>
            </tbody>
          </table>
        </div>
        <footer><button className="primary" onClick={onClose}>Zavrieť</button></footer>
      </div>
    </div>
  );
}
