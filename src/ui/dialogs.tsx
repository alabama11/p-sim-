// Modal dialogs: block parameters, simulation settings and workspace variables.

import { useState, type ReactNode } from 'react';
import { BLOCKS, type ParamDef, type Params } from '../sim/blocks';
import { evaluate, runWorkspace, type Scope } from '../sim/expr';
import { SOLVER_LABELS } from '../sim/solvers';
import { FIXED_STEP_SOLVERS, type BlockModel, type MaskDef, type MaskParam, type SimSettings, type SolverName } from '../sim/types';

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose(): void; footer: ReactNode }) {
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <header>{title}</header>
        <div className="modal-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}

export function ParamDialog({ block, scope, scopeError, onApply, onClose, onOpenContents, onEditMask }: {
  block: BlockModel;
  /** Variables visible at the block's level (workspace and enclosing masks). */
  scope: Scope;
  scopeError?: string;
  onApply(b: BlockModel): void;
  onClose(): void;
  onOpenContents?(): void;
  onEditMask?(): void;
}) {
  const masked = block.type === 'Subsystem' && block.mask;
  const def = BLOCKS[block.type];
  const paramDefs: ParamDef[] = masked
    ? block.mask!.params.map((mp) => ({ name: mp.name, label: mp.label || mp.name, default: mp.default }))
    : def.params;
  const title = masked ? block.mask!.title || block.name : def.label;
  const description = masked ? block.mask!.description : def.description;
  const [name, setName] = useState(block.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(paramDefs.map((p) => [p.name, block.params[p.name] ?? p.default])),
  );
  const [error, setError] = useState('');

  const apply = () => {
    if (!name.trim()) return setError('Názov bloku nesmie byť prázdny.');
    try {
      if (scopeError) throw new Error(scopeError);
      const params: Params = {};
      for (const pd of paramDefs) {
        const raw = values[pd.name];
        if (pd.kind === 'text' || pd.kind === 'choice') params[pd.name] = raw;
        else {
          try {
            params[pd.name] = evaluate(raw, scope);
          } catch (e) {
            throw new Error(`${pd.label}: ${(e as Error).message}`);
          }
        }
      }
      if (!masked) def.create(params);
    } catch (e) {
      return setError((e as Error).message);
    }
    onApply({ ...block, name: name.trim(), params: { ...block.params, ...values } });
  };

  return (
    <Modal
      title={`Parametre bloku: ${title}`}
      onClose={onClose}
      footer={<>
        {onEditMask && <button onClick={onEditMask}>Upraviť masku</button>}
        {onOpenContents && <button onClick={onOpenContents}>Otvoriť obsah</button>}
        <span className="spacer" />
        <button onClick={onClose}>Zrušiť</button>
        <button className="primary" onClick={apply}>OK</button>
      </>}
    >
      {description && <p className="hint">{description}</p>}
      <form onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <label>
          Názov
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {paramDefs.map((pd) => (
          <label key={pd.name}>
            {pd.label}
            {pd.kind === 'choice' ? (
              <select value={values[pd.name]} onChange={(e) => setValues({ ...values, [pd.name]: e.target.value })}>
                {pd.choices!.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <input
                value={values[pd.name]}
                spellCheck={false}
                onChange={(e) => setValues({ ...values, [pd.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        <button type="submit" hidden />
      </form>
      {paramDefs.some((pd) => !pd.kind || pd.kind === 'expr') && (
        <p className="hint">Hodnoty môžu byť výrazy, napr. <code>2*pi*f</code> alebo <code>[1 2 1]</code>, s premennými z pracovného priestoru.</p>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Defines a subsystem's mask: its title, help text and parameters. */
export function MaskDialog({ block, onApply, onClose }: {
  block: BlockModel;
  onApply(mask: MaskDef | undefined): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState(block.mask?.title ?? block.name);
  const [description, setDescription] = useState(block.mask?.description ?? '');
  const [params, setParams] = useState<MaskParam[]>(block.mask?.params ?? [{ name: 'K', label: 'Zosilnenie', default: '1' }]);
  const [error, setError] = useState('');

  const setRow = (i: number, patch: Partial<MaskParam>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const apply = () => {
    const names = params.map((p) => p.name.trim());
    const bad = names.find((n) => !IDENT.test(n));
    if (bad !== undefined) return setError(`„${bad}“ nie je platný názov premennej.`);
    if (new Set(names).size !== names.length) return setError('Názvy parametrov sa nesmú opakovať.');
    for (const p of params) {
      try {
        evaluate(p.default);
      } catch (e) {
        return setError(`Predvolená hodnota „${p.name}“: ${(e as Error).message}`);
      }
    }
    onApply({ title: title.trim(), description: description.trim(), params: params.map((p) => ({ ...p, name: p.name.trim() })) });
  };

  return (
    <Modal
      title={`Maska subsystému: ${block.name}`}
      onClose={onClose}
      footer={<>
        {block.mask && <button onClick={() => onApply(undefined)}>Odstrániť masku</button>}
        <span className="spacer" />
        <button onClick={onClose}>Zrušiť</button>
        <button className="primary" onClick={apply}>OK</button>
      </>}
    >
      <p className="hint">
        Maska dá subsystému vlastný dialóg parametrov. Každý parameter je premenná, ktorú môžu použiť bloky vo vnútri.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <label>Nadpis <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Popis <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <table className="mask-table">
          <thead><tr><th>Premenná</th><th>Popis v dialógu</th><th>Predvolená hodnota</th><th /></tr></thead>
          <tbody>
            {params.map((p, i) => (
              <tr key={i}>
                <td><input value={p.name} spellCheck={false} onChange={(e) => setRow(i, { name: e.target.value })} /></td>
                <td><input value={p.label} onChange={(e) => setRow(i, { label: e.target.value })} /></td>
                <td><input value={p.default} spellCheck={false} onChange={(e) => setRow(i, { default: e.target.value })} /></td>
                <td><button type="button" title="Odstrániť" onClick={() => setParams(params.filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={() => setParams([...params, { name: '', label: '', default: '0' }])}>+ Pridať parameter</button>
        <button type="submit" hidden />
      </form>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

export function SettingsDialog({ settings, onApply, onClose }: {
  settings: SimSettings;
  onApply(s: SimSettings): void;
  onClose(): void;
}) {
  const [s, setS] = useState(settings);
  const fixed = FIXED_STEP_SOLVERS.includes(s.solver);
  const field = (key: keyof SimSettings, label: string, hint?: string) => (
    <label>
      {label}
      <input value={s[key]} spellCheck={false} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
      {hint && <small>{hint}</small>}
    </label>
  );
  return (
    <Modal
      title="Nastavenia simulácie"
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Zrušiť</button>
        <button className="primary" onClick={() => onApply(s)}>OK</button>
      </>}
    >
      <form onSubmit={(e) => { e.preventDefault(); onApply(s); }}>
        <label>
          Riešič
          <select value={s.solver} onChange={(e) => setS({ ...s, solver: e.target.value as SolverName })}>
            {Object.entries(SOLVER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {field('startTime', 'Začiatok [s]')}
        {field('stopTime', 'Koniec [s]')}
        {fixed
          ? field('fixedStep', 'Pevný krok [s]', 'auto = najrýchlejšia vzorkovacia perióda, inak (koniec − začiatok) / 50')
          : <>
              {field('maxStep', 'Maximálny krok [s]', 'auto = (koniec − začiatok) / 50')}
              {field('relTol', 'Relatívna tolerancia')}
              {field('absTol', 'Absolútna tolerancia')}
            </>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function WorkspaceDialog({ workspace, onApply, onClose }: {
  workspace: string;
  onApply(ws: string): void;
  onClose(): void;
}) {
  const [text, setText] = useState(workspace);
  const [error, setError] = useState('');
  let vars: [string, number[]][] = [];
  try {
    vars = Object.entries(runWorkspace(text));
  } catch {
    // shown on OK
  }
  const apply = () => {
    try {
      runWorkspace(text);
      onApply(text);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title="Pracovný priestor (premenné modelu)"
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Zrušiť</button>
        <button className="primary" onClick={apply}>OK</button>
      </>}
    >
      <p className="hint">
        Premenné definované tu môžete použiť v parametroch blokov. Syntax ako v Octave: jeden príkaz na riadok
        alebo oddelené bodkočiarkou, komentár začína znakom %.
      </p>
      <textarea
        className="code"
        rows={8}
        value={text}
        spellCheck={false}
        placeholder={'m = 1;      % hmotnosť [kg]\nk = 4;      % tuhosť [N/m]\nw0 = sqrt(k/m)'}
        onChange={(e) => { setText(e.target.value); setError(''); }}
        autoFocus
      />
      {vars.length > 0 && (
        <table className="vars">
          <tbody>
            {vars.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td>{v.length === 1 ? +v[0].toPrecision(6) : `[${v.map((x) => +x.toPrecision(6)).join(' ')}]`}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
