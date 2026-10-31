// Modal dialogs: block parameters, simulation settings and workspace variables.

import { useState, type ReactNode } from 'react';
import { BLOCKS, type Params } from '../sim/blocks';
import { evaluate, runWorkspace } from '../sim/expr';
import { SOLVER_LABELS } from '../sim/solvers';
import { FIXED_STEP_SOLVERS, type BlockModel, type SimSettings, type SolverName } from '../sim/types';

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

export function ParamDialog({ block, workspace, onApply, onClose }: {
  block: BlockModel;
  workspace: string;
  onApply(b: BlockModel): void;
  onClose(): void;
}) {
  const def = BLOCKS[block.type];
  const [name, setName] = useState(block.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.params.map((p) => [p.name, block.params[p.name] ?? p.default])),
  );
  const [error, setError] = useState('');

  const apply = () => {
    if (!name.trim()) return setError('Názov bloku nesmie byť prázdny.');
    try {
      const scope = runWorkspace(workspace);
      const params: Params = {};
      for (const pd of def.params) {
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
      def.create(params);
    } catch (e) {
      return setError((e as Error).message);
    }
    onApply({ ...block, name: name.trim(), params: values });
  };

  return (
    <Modal
      title={`Parametre bloku: ${def.label}`}
      onClose={onClose}
      footer={<>
        <button onClick={onClose}>Zrušiť</button>
        <button className="primary" onClick={apply}>OK</button>
      </>}
    >
      <p className="hint">{def.description}</p>
      <form onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <label>
          Názov
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {def.params.map((pd) => (
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
      {def.params.some((pd) => !pd.kind || pd.kind === 'expr') && (
        <p className="hint">Hodnoty môžu byť výrazy, napr. <code>2*pi*f</code> alebo <code>[1 2 1]</code>, s premennými z pracovného priestoru.</p>
      )}
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
