// Block library: parameters, port counts and runtime behaviour of every block type.
// Signals are scalars in this version.

import { ExprError, type Value } from './expr';

export interface ParamDef {
  name: string;
  label: string;
  default: string;
  /** expr = evaluated expression (default), text = raw string, choice = one of `choices`. */
  kind?: 'expr' | 'text' | 'choice';
  choices?: string[];
}

export type Params = Record<string, Value | string>;

export interface StepCtx {
  /** Major time step: modes may change and discrete blocks may sample. Minor steps are solver stages. */
  major: boolean;
  /** This block's sample hit (only for discrete blocks, only in major steps). */
  hit: boolean;
}

export interface BlockRuntime {
  /** Output depends directly on the current input, so the block must run after its sources. */
  feedthrough: boolean;
  /** Period of a discrete block in seconds; undefined for continuous/inherited blocks. */
  sampleTime?: number;
  /** Number of continuous states. */
  nx?: number;
  x0?: number[];
  output(t: number, x: Float64Array, u: number[], y: number[], ctx: StepCtx): void;
  derivative?(t: number, x: Float64Array, u: number[], dx: Float64Array): void;
  /** Discrete state update at a sample hit, after all outputs of the major step are computed. */
  update?(t: number, u: number[]): void;
  /** Next time strictly after t where the output has a discontinuity; the solver steps exactly onto it. */
  nextEvent?(t: number): number;
  /** Inputs are recorded at every major step (Scope, Display). */
  sink?: boolean;
}

export interface BlockDef {
  type: string;
  label: string;
  category: string;
  description: string;
  params: ParamDef[];
  ports(raw: Record<string, string>): { inputs: number; outputs: number };
  create(p: Params): BlockRuntime;
}

export const CATEGORIES = ['Zdroje', 'Matematika', 'Spojité', 'Diskrétne', 'Nespojitosti', 'Smerovanie', 'Výstupy'];

function num(p: Params, name: string): number {
  const v = p[name];
  if (typeof v === 'string' || v.length !== 1) throw new ExprError(`Parameter „${name}“ musí byť skalár`);
  return v[0];
}

function vec(p: Params, name: string): number[] {
  const v = p[name];
  if (typeof v === 'string') throw new ExprError(`Parameter „${name}“ musí byť číslo alebo vektor`);
  return v;
}

function str(p: Params, name: string): string {
  return String(p[name]);
}

function positive(p: Params, name: string): number {
  const v = num(p, name);
  if (!(v > 0) || !isFinite(v)) throw new ExprError(`Parameter „${name}“ musí byť kladné číslo`);
  return v;
}

const io = (inputs: number, outputs: number) => () => ({ inputs, outputs });

/** Sum and Product take their input count from a sign string like "+-" or "*\/". */
function signChars(raw: string | undefined, allowed: string): string[] {
  return [...(raw ?? '')].filter((c) => allowed.includes(c));
}

/** Smallest event time strictly after t among start + k*period + offsets. */
function nextPeriodic(t: number, start: number, period: number, offsets: number[]): number {
  if (t < start) return start + Math.min(...offsets);
  const k = Math.floor((t - start) / period);
  let best = Infinity;
  for (const kk of [k, k + 1]) {
    for (const o of offsets) {
      const te = start + kk * period + o;
      if (te > t + 1e-12 * Math.max(1, Math.abs(t)) && te < best) best = te;
    }
  }
  return best;
}

const defs: BlockDef[] = [
  // ---------- Sources ----------
  {
    type: 'Constant', label: 'Constant', category: 'Zdroje',
    description: 'Konštantný výstup.',
    params: [{ name: 'value', label: 'Hodnota', default: '1' }],
    ports: io(0, 1),
    create(p) {
      const c = num(p, 'value');
      return { feedthrough: false, output(_t, _x, _u, y) { y[0] = c; } };
    },
  },
  {
    type: 'Step', label: 'Step', category: 'Zdroje',
    description: 'Skok z počiatočnej na koncovú hodnotu v zadanom čase.',
    params: [
      { name: 'time', label: 'Čas skoku [s]', default: '1' },
      { name: 'before', label: 'Počiatočná hodnota', default: '0' },
      { name: 'after', label: 'Koncová hodnota', default: '1' },
    ],
    ports: io(0, 1),
    create(p) {
      const T = num(p, 'time'), a = num(p, 'before'), b = num(p, 'after');
      let value = a;
      return {
        feedthrough: false,
        output(t, _x, _u, y, ctx) {
          if (ctx.major) value = t >= T ? b : a;
          y[0] = value;
        },
        nextEvent: (t) => (t < T ? T : Infinity),
      };
    },
  },
  {
    type: 'Ramp', label: 'Ramp', category: 'Zdroje',
    description: 'Lineárne rastúci signál od zadaného času.',
    params: [
      { name: 'slope', label: 'Sklon', default: '1' },
      { name: 'start', label: 'Čas začiatku [s]', default: '0' },
      { name: 'initial', label: 'Počiatočná hodnota', default: '0' },
    ],
    ports: io(0, 1),
    create(p) {
      const k = num(p, 'slope'), t0 = num(p, 'start'), y0 = num(p, 'initial');
      return {
        feedthrough: false,
        output(t, _x, _u, y) { y[0] = t < t0 ? y0 : y0 + k * (t - t0); },
        nextEvent: (t) => (t < t0 ? t0 : Infinity),
      };
    },
  },
  {
    type: 'SineWave', label: 'Sine Wave', category: 'Zdroje',
    description: 'y = A·sin(ω·t + φ) + posun',
    params: [
      { name: 'amplitude', label: 'Amplitúda A', default: '1' },
      { name: 'frequency', label: 'Uhlová frekvencia ω [rad/s]', default: '1' },
      { name: 'phase', label: 'Fáza φ [rad]', default: '0' },
      { name: 'bias', label: 'Posun', default: '0' },
    ],
    ports: io(0, 1),
    create(p) {
      const A = num(p, 'amplitude'), w = num(p, 'frequency'), ph = num(p, 'phase'), b = num(p, 'bias');
      return { feedthrough: false, output(t, _x, _u, y) { y[0] = A * Math.sin(w * t + ph) + b; } };
    },
  },
  {
    type: 'PulseGenerator', label: 'Pulse Generator', category: 'Zdroje',
    description: 'Periodické obdĺžnikové impulzy.',
    params: [
      { name: 'amplitude', label: 'Amplitúda', default: '1' },
      { name: 'period', label: 'Perióda [s]', default: '1' },
      { name: 'width', label: 'Šírka impulzu [% periódy]', default: '50' },
      { name: 'delay', label: 'Oneskorenie [s]', default: '0' },
    ],
    ports: io(0, 1),
    create(p) {
      const A = num(p, 'amplitude'), P = positive(p, 'period'), d = num(p, 'delay');
      const W = (num(p, 'width') / 100) * P;
      if (!(W > 0 && W < P)) throw new ExprError('Šírka impulzu musí byť medzi 0 a 100 %');
      let value = 0;
      return {
        feedthrough: false,
        output(t, _x, _u, y, ctx) {
          if (ctx.major) {
            const phase = t - d - Math.floor((t - d) / P + 1e-12) * P;
            value = t >= d && phase < W - 1e-12 * P ? A : 0;
          }
          y[0] = value;
        },
        nextEvent: (t) => nextPeriodic(t, d, P, [0, W]),
      };
    },
  },
  {
    type: 'Clock', label: 'Clock', category: 'Zdroje',
    description: 'Výstupom je simulačný čas.',
    params: [],
    ports: io(0, 1),
    create() {
      return { feedthrough: false, output(t, _x, _u, y) { y[0] = t; } };
    },
  },

  // ---------- Math ----------
  {
    type: 'Gain', label: 'Gain', category: 'Matematika',
    description: 'y = K·u',
    params: [{ name: 'K', label: 'Zosilnenie K', default: '1' }],
    ports: io(1, 1),
    create(p) {
      const K = num(p, 'K');
      return { feedthrough: true, output(_t, _x, u, y) { y[0] = K * u[0]; } };
    },
  },
  {
    type: 'Sum', label: 'Sum', category: 'Matematika',
    description: 'Súčet vstupov so znamienkami, napr. „+-“ znamená u1 − u2.',
    params: [{ name: 'signs', label: 'Znamienka (napr. ++ alebo +-)', default: '++', kind: 'text' }],
    ports: (raw) => ({ inputs: Math.max(1, signChars(raw.signs, '+-').length), outputs: 1 }),
    create(p) {
      const s = signChars(str(p, 'signs'), '+-').map((c) => (c === '-' ? -1 : 1));
      if (s.length === 0) throw new ExprError('Zadajte aspoň jedno znamienko + alebo -');
      return {
        feedthrough: true,
        output(_t, _x, u, y) {
          let acc = 0;
          for (let i = 0; i < s.length; i++) acc += s[i] * u[i];
          y[0] = acc;
        },
      };
    },
  },
  {
    type: 'Product', label: 'Product', category: 'Matematika',
    description: 'Súčin a podiel vstupov, napr. „*/“ znamená u1 / u2.',
    params: [{ name: 'ops', label: 'Operácie (napr. ** alebo */)', default: '**', kind: 'text' }],
    ports: (raw) => ({ inputs: Math.max(1, signChars(raw.ops, '*/').length), outputs: 1 }),
    create(p) {
      const ops = signChars(str(p, 'ops'), '*/');
      if (ops.length === 0) throw new ExprError('Zadajte aspoň jeden znak * alebo /');
      return {
        feedthrough: true,
        output(_t, _x, u, y) {
          let acc = 1;
          for (let i = 0; i < ops.length; i++) acc = ops[i] === '*' ? acc * u[i] : acc / u[i];
          y[0] = acc;
        },
      };
    },
  },
  {
    type: 'MathFunction', label: 'Function', category: 'Matematika',
    description: 'Matematická funkcia jedného vstupu.',
    params: [{
      name: 'fn', label: 'Funkcia', default: 'sin', kind: 'choice',
      choices: ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs', 'square', 'sign'],
    }],
    ports: io(1, 1),
    create(p) {
      const fns: Record<string, (x: number) => number> = {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log,
        sqrt: Math.sqrt, abs: Math.abs, square: (x) => x * x, sign: Math.sign,
      };
      const f = fns[str(p, 'fn')];
      if (!f) throw new ExprError(`Neznáma funkcia ${str(p, 'fn')}`);
      return { feedthrough: true, output(_t, _x, u, y) { y[0] = f(u[0]); } };
    },
  },

  // ---------- Continuous ----------
  {
    type: 'Integrator', label: 'Integrator', category: 'Spojité',
    description: 'y = ∫u dt s počiatočnou podmienkou.',
    params: [{ name: 'x0', label: 'Počiatočná podmienka', default: '0' }],
    ports: io(1, 1),
    create(p) {
      return {
        feedthrough: false,
        nx: 1,
        x0: [num(p, 'x0')],
        output(_t, x, _u, y) { y[0] = x[0]; },
        derivative(_t, _x, u, dx) { dx[0] = u[0]; },
      };
    },
  },
  {
    type: 'TransferFcn', label: 'Transfer Fcn', category: 'Spojité',
    description: 'Prenosová funkcia G(s) = čitateľ(s) / menovateľ(s), koeficienty od najvyššej mocniny s.',
    params: [
      { name: 'num', label: 'Čitateľ', default: '[1]' },
      { name: 'den', label: 'Menovateľ', default: '[1 1]' },
    ],
    ports: io(1, 1),
    create(p) {
      const ss = tfToStateSpace(vec(p, 'num'), vec(p, 'den'));
      const n = ss.a.length;
      return {
        feedthrough: ss.d !== 0,
        nx: n,
        x0: new Array(n).fill(0),
        output(_t, x, u, y) {
          let acc = ss.d * u[0];
          for (let i = 0; i < n; i++) acc += ss.c[i] * x[i];
          y[0] = acc;
        },
        derivative(_t, x, u, dx) {
          let top = u[0];
          for (let i = 0; i < n; i++) top -= ss.a[i] * x[i];
          for (let i = n - 1; i > 0; i--) dx[i] = x[i - 1];
          dx[0] = top;
        },
      };
    },
  },
  {
    type: 'PID', label: 'PID Controller', category: 'Spojité',
    description: 'Paralelný PID regulátor: P + I/s + D·N/(1 + N/s)',
    params: [
      { name: 'P', label: 'Proporcionálna zložka P', default: '1' },
      { name: 'I', label: 'Integračná zložka I', default: '1' },
      { name: 'D', label: 'Derivačná zložka D', default: '0' },
      { name: 'N', label: 'Koeficient filtra N', default: '100' },
    ],
    ports: io(1, 1),
    create(p) {
      const P = num(p, 'P'), I = num(p, 'I'), D = num(p, 'D'), N = num(p, 'N');
      if (D !== 0 && !(N > 0)) throw new ExprError('Koeficient filtra N musí byť kladný');
      return {
        feedthrough: true,
        nx: 2,
        x0: [0, 0],
        // x[0] = integral of u, x[1] = derivative filter state
        output(_t, x, u, y) { y[0] = P * u[0] + I * x[0] + D * N * (u[0] - x[1]); },
        derivative(_t, x, u, dx) {
          dx[0] = u[0];
          dx[1] = D !== 0 ? N * (u[0] - x[1]) : 0;
        },
      };
    },
  },

  // ---------- Discrete ----------
  {
    type: 'UnitDelay', label: 'Unit Delay', category: 'Diskrétne',
    description: 'Oneskorenie o jednu vzorku: y(k) = u(k−1).',
    params: [
      { name: 'x0', label: 'Počiatočná hodnota', default: '0' },
      { name: 'Ts', label: 'Perióda vzorkovania [s]', default: '1' },
    ],
    ports: io(1, 1),
    create(p) {
      let state = num(p, 'x0');
      return {
        feedthrough: false,
        sampleTime: positive(p, 'Ts'),
        output(_t, _x, _u, y) { y[0] = state; },
        update(_t, u) { state = u[0]; },
      };
    },
  },
  {
    type: 'ZeroOrderHold', label: 'Zero-Order Hold', category: 'Diskrétne',
    description: 'Vzorkuje vstup a drží hodnotu do ďalšej vzorky.',
    params: [{ name: 'Ts', label: 'Perióda vzorkovania [s]', default: '1' }],
    ports: io(1, 1),
    create(p) {
      let held = 0;
      return {
        feedthrough: true,
        sampleTime: positive(p, 'Ts'),
        output(_t, _x, u, y, ctx) {
          if (ctx.hit) held = u[0];
          y[0] = held;
        },
      };
    },
  },
  {
    type: 'DiscreteIntegrator', label: 'Discrete-Time Integrator', category: 'Diskrétne',
    description: 'Diskrétny integrátor (dopredná Eulerova metóda): y(k) = y(k−1) + K·Ts·u(k−1).',
    params: [
      { name: 'K', label: 'Zosilnenie K', default: '1' },
      { name: 'x0', label: 'Počiatočná hodnota', default: '0' },
      { name: 'Ts', label: 'Perióda vzorkovania [s]', default: '1' },
    ],
    ports: io(1, 1),
    create(p) {
      const K = num(p, 'K'), Ts = positive(p, 'Ts');
      let state = num(p, 'x0');
      return {
        feedthrough: false,
        sampleTime: Ts,
        output(_t, _x, _u, y) { y[0] = state; },
        update(_t, u) { state += K * Ts * u[0]; },
      };
    },
  },

  // ---------- Discontinuities ----------
  {
    type: 'Saturation', label: 'Saturation', category: 'Nespojitosti',
    description: 'Obmedzí signál na interval [dolná, horná].',
    params: [
      { name: 'upper', label: 'Horná hranica', default: '0.5' },
      { name: 'lower', label: 'Dolná hranica', default: '-0.5' },
    ],
    ports: io(1, 1),
    create(p) {
      const hi = num(p, 'upper'), lo = num(p, 'lower');
      if (lo > hi) throw new ExprError('Dolná hranica je väčšia ako horná');
      return { feedthrough: true, output(_t, _x, u, y) { y[0] = Math.min(hi, Math.max(lo, u[0])); } };
    },
  },
  {
    type: 'Relay', label: 'Relay', category: 'Nespojitosti',
    description: 'Dvojpolohový prepínač s hysteréziou.',
    params: [
      { name: 'on', label: 'Bod zapnutia', default: '0.1' },
      { name: 'off', label: 'Bod vypnutia', default: '-0.1' },
      { name: 'yon', label: 'Výstup v stave zapnuté', default: '1' },
      { name: 'yoff', label: 'Výstup v stave vypnuté', default: '0' },
    ],
    ports: io(1, 1),
    create(p) {
      const on = num(p, 'on'), off = num(p, 'off'), yon = num(p, 'yon'), yoff = num(p, 'yoff');
      if (off > on) throw new ExprError('Bod vypnutia musí byť menší alebo rovný bodu zapnutia');
      let state = false;
      return {
        feedthrough: true,
        output(_t, _x, u, y, ctx) {
          if (ctx.major) {
            if (u[0] >= on) state = true;
            else if (u[0] <= off) state = false;
          }
          y[0] = state ? yon : yoff;
        },
      };
    },
  },

  // ---------- Routing ----------
  {
    type: 'Switch', label: 'Switch', category: 'Smerovanie',
    description: 'Prepúšťa vstup 1, ak riadiaci vstup 2 splní podmienku, inak vstup 3.',
    params: [
      { name: 'criterion', label: 'Podmienka', default: 'u2 >= prah', kind: 'choice', choices: ['u2 >= prah', 'u2 > prah', 'u2 ~= 0'] },
      { name: 'threshold', label: 'Prah', default: '0' },
    ],
    ports: io(3, 1),
    create(p) {
      const crit = str(p, 'criterion'), th = num(p, 'threshold');
      let first = true;
      return {
        feedthrough: true,
        output(_t, _x, u, y, ctx) {
          if (ctx.major) first = crit === 'u2 > prah' ? u[1] > th : crit === 'u2 ~= 0' ? u[1] !== 0 : u[1] >= th;
          y[0] = first ? u[0] : u[2];
        },
      };
    },
  },

  // ---------- Sinks ----------
  {
    type: 'Scope', label: 'Scope', category: 'Výstupy',
    description: 'Zobrazí priebehy vstupných signálov v čase.',
    params: [{ name: 'inputs', label: 'Počet vstupov', default: '1' }],
    ports: (raw) => ({ inputs: clampInt(raw.inputs, 1, 8), outputs: 0 }),
    create() {
      return { feedthrough: true, sink: true, output() {} };
    },
  },
  {
    type: 'Display', label: 'Display', category: 'Výstupy',
    description: 'Ukáže poslednú hodnotu vstupu priamo v bloku.',
    params: [],
    ports: io(1, 0),
    create() {
      return { feedthrough: true, sink: true, output() {} };
    },
  },
];

function clampInt(raw: string | undefined, lo: number, hi: number): number {
  const n = parseInt(raw ?? '', 10);
  return isNaN(n) ? lo : Math.min(hi, Math.max(lo, n));
}

/** Controllable canonical form of num(s)/den(s): x' = A x + B u, y = C x + D u. */
export function tfToStateSpace(numIn: number[], denIn: number[]) {
  const trim = (v: number[]) => { const i = v.findIndex((c) => c !== 0); return i < 0 ? [] : v.slice(i); };
  const num = trim(numIn), den = trim(denIn);
  if (den.length === 0) throw new ExprError('Menovateľ nesmie byť nulový');
  if (num.length > den.length) throw new ExprError('Stupeň čitateľa je väčší ako stupeň menovateľa');
  const n = den.length - 1;
  const a = den.slice(1).map((c) => c / den[0]); // a1..an
  const b = [...new Array(den.length - num.length).fill(0), ...num].map((c) => c / den[0]); // b0..bn
  const d = b[0];
  const c = a.map((ai, i) => b[i + 1] - ai * d);
  return { a, c, d, n };
}

export const BLOCKS: Record<string, BlockDef> = Object.fromEntries(defs.map((d) => [d.type, d]));
export const BLOCK_LIST = defs;
