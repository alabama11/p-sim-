// Model as stored in a .psim file and edited by the UI.

export interface PortRef {
  block: string;
  port: number;
}

export interface BlockModel {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  /** Parameter values as typed by the user; expressions are evaluated at compile time. */
  params: Record<string, string>;
}

export interface LinkModel {
  id: string;
  src: PortRef;
  dst: PortRef;
}

export type SolverName = 'ode45' | 'ode23' | 'ode1' | 'ode2' | 'ode3' | 'ode4' | 'ode5';

export interface SimSettings {
  solver: SolverName;
  startTime: string;
  stopTime: string;
  /** Fixed-step solvers; 'auto' = (stop - start) / 50 or the fastest discrete rate. */
  fixedStep: string;
  /** Variable-step solvers; 'auto' = (stop - start) / 50. */
  maxStep: string;
  relTol: string;
  absTol: string;
}

export interface Model {
  name: string;
  blocks: BlockModel[];
  links: LinkModel[];
  /** Workspace statements such as `K = 2; T = 0.5`, visible to every block parameter. */
  workspace: string;
  settings: SimSettings;
}

export const FIXED_STEP_SOLVERS: SolverName[] = ['ode1', 'ode2', 'ode3', 'ode4', 'ode5'];

export function defaultSettings(): SimSettings {
  return {
    solver: 'ode45',
    startTime: '0',
    stopTime: '10',
    fixedStep: 'auto',
    maxStep: 'auto',
    relTol: '1e-3',
    absTol: '1e-6',
  };
}

export function emptyModel(name = 'bez_nazvu'): Model {
  return { name, blocks: [], links: [], workspace: '', settings: defaultSettings() };
}
