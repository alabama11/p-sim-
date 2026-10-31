// Block library: parameters, port counts and runtime behaviour of every block type.
// Signals may be vectors: most blocks are defined for one element and the engine runs
// one copy per element; `wide` blocks (Mux, Demux, Scope, ...) see whole vectors.

import { compileExpr, compileScript, ExprError, type Scope, type Value } from './expr';

export interface ParamDef {
  name: string;
  label: string;
  default: string;
  /** expr = evaluated expression (default), text = raw string, code = multi-line program, choice = one of `choices`. */
  kind?: 'expr' | 'text' | 'choice' | 'code';
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
  /**
   * Zero-crossing functions. Blocks keep their mode (which branch of a discontinuity
   * they are on) fixed during minor steps; the solver finds where a function changes
   * sign and ends the step there, so the mode switches exactly at the crossing.
   */
  nzc?: number;
  zc?(t: number, u: number[], out: number[]): void;
  /** Called after every major step with the final inputs (history of Derivative, Transport Delay). */
  onMajor?(t: number, u: number[]): void;
}

export interface BlockDef {
  type: string;
  label: string;
  category: string;
  description: string;
  params: ParamDef[];
  ports(raw: Record<string, string>): { inputs: number; outputs: number };
  /** Hidden from the library (internal block types). */
  hidden?: boolean;
  /**
   * Parameters given per element of a vector signal: Constant [1 2 3] outputs a
   * width-3 vector and Gain [1 2] scales each element by its own factor.
   */
  slice?: string[];
  /**
   * The block sees all elements of all inputs at once. Given the input widths it
   * returns the output widths, or null to work element by element after all.
   */
  wide?(p: Params, inW: number[], scope: Scope): number[] | null;
  /** inW is given only to wide blocks; scope holds workspace and mask variables. */
  create(p: Params, inW: number[] | undefined, scope: Scope): BlockRuntime;
}

export const CATEGORIES = ['Zdroje', 'Matematika', 'Logika', 'Spojité', 'Diskrétne', 'Nespojitosti', 'Smerovanie', 'Vlastné funkcie', 'Porty a subsystémy', 'Výstupy'];

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
    slice: ['value'],
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
    slice: ['time', 'before', 'after'],
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
    slice: ['slope', 'start', 'initial'],
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
    slice: ['amplitude', 'frequency', 'phase', 'bias'],
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
    slice: ['amplitude', 'period', 'width', 'delay'],
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
    slice: ['K'],
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
    ports: (raw) => ({ inputs: Math.max(1, signChars(raw.signs ?? '++', '+-').length), outputs: 1 }),
    // With a single input, the elements of the input vector are summed.
    wide: (p) => (signChars(str(p, 'signs'), '+-').length === 1 ? [1] : null),
    create(p, inW) {
      const s = signChars(str(p, 'signs'), '+-').map((c) => (c === '-' ? -1 : 1));
      if (s.length === 0) throw new ExprError('Zadajte aspoň jedno znamienko + alebo -');
      if (inW) {
        return { feedthrough: true, output(_t, _x, u, y) { let acc = 0; for (const v of u) acc += v; y[0] = s[0] * acc; } };
      }
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
    ports: (raw) => ({ inputs: Math.max(1, signChars(raw.ops ?? '**', '*/').length), outputs: 1 }),
    // With a single input, the elements of the input vector are multiplied.
    wide: (p) => (signChars(str(p, 'ops'), '*/').length === 1 ? [1] : null),
    create(p, inW) {
      const ops = signChars(str(p, 'ops'), '*/');
      if (ops.length === 0) throw new ExprError('Zadajte aspoň jeden znak * alebo /');
      if (inW) {
        const inv = ops[0] === '/';
        return { feedthrough: true, output(_t, _x, u, y) { let acc = 1; for (const v of u) acc *= inv ? 1 / v : v; y[0] = acc; } };
      }
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
      const fn = str(p, 'fn');
      const f = fns[fn];
      if (!f) throw new ExprError(`Neznáma funkcia ${fn}`);
      if (fn === 'abs' || fn === 'sign') {
        // Discontinuous at u = 0: hold the sign during minor steps and detect the crossing.
        let s = 1;
        return {
          feedthrough: true,
          nzc: 1,
          output(_t, _x, u, y, ctx) {
            if (ctx.major) s = Math.sign(u[0]);
            y[0] = fn === 'abs' ? s * u[0] : s;
          },
          zc(_t, u, out) { out[0] = u[0]; },
        };
      }
      return { feedthrough: true, output(_t, _x, u, y) { y[0] = f(u[0]); } };
    },
  },

  // ---------- Continuous ----------
  {
    type: 'Integrator', label: 'Integrator', category: 'Spojité',
    slice: ['x0'],
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

  {
    type: 'Derivative', label: 'Derivative', category: 'Spojité',
    description: 'Približná derivácia du/dt z posledných dvoch hlavných krokov.',
    params: [],
    ports: io(1, 1),
    create() {
      let tPrev = NaN, uPrev = 0, value = 0;
      return {
        feedthrough: true,
        output(t, _x, u, y, ctx) {
          if (ctx.major) value = t > tPrev ? (u[0] - uPrev) / (t - tPrev) : 0;
          y[0] = value;
        },
        onMajor(t, u) { tPrev = t; uPrev = u[0]; },
      };
    },
  },
  {
    type: 'TransportDelay', label: 'Transport Delay', category: 'Spojité',
    slice: ['initial'],
    description: 'Dopravné oneskorenie: y(t) = u(t − T).',
    params: [
      { name: 'delay', label: 'Oneskorenie T [s]', default: '1' },
      { name: 'initial', label: 'Počiatočný výstup', default: '0' },
    ],
    ports: io(1, 1),
    create(p) {
      const T = num(p, 'delay'), y0 = num(p, 'initial');
      if (!(T > 0)) throw new ExprError('Oneskorenie musí byť kladné');
      const ts: number[] = [], us: number[] = [];
      let start = 0; // first history index still needed
      return {
        feedthrough: false,
        output(t, _x, _u, y) {
          const td = t - T;
          if (ts.length === 0 || td < ts[0]) { y[0] = y0; return; }
          while (start + 1 < ts.length && ts[start + 1] <= td) start++;
          const i = start;
          if (i + 1 >= ts.length) { y[0] = us[i]; return; }
          const a = (td - ts[i]) / (ts[i + 1] - ts[i]);
          y[0] = us[i] + a * (us[i + 1] - us[i]);
        },
        onMajor(t, u) {
          if (ts.length && t <= ts[ts.length - 1]) return;
          ts.push(t);
          us.push(u[0]);
        },
      };
    },
  },

  // ---------- Discrete ----------
  {
    type: 'UnitDelay', label: 'Unit Delay', category: 'Diskrétne',
    slice: ['x0'],
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
    slice: ['K', 'x0'],
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

  {
    type: 'DiscreteTransferFcn', label: 'Discrete Transfer Fcn', category: 'Diskrétne',
    description: 'Diskrétna prenosová funkcia G(z) = čitateľ(z) / menovateľ(z), koeficienty od najvyššej mocniny z.',
    params: [
      { name: 'num', label: 'Čitateľ', default: '[1]' },
      { name: 'den', label: 'Menovateľ', default: '[1 -0.5]' },
      { name: 'Ts', label: 'Perióda vzorkovania [s]', default: '1' },
    ],
    ports: io(1, 1),
    create(p) {
      const den = vec(p, 'den'), numIn = vec(p, 'num');
      if (den[0] === 0) throw new ExprError('Prvý koeficient menovateľa nesmie byť nula');
      if (numIn.length > den.length) throw new ExprError('Stupeň čitateľa je väčší ako stupeň menovateľa');
      const n = den.length - 1;
      const a = den.map((c) => c / den[0]);
      const b = [...new Array(den.length - numIn.length).fill(0), ...numIn].map((c) => c / den[0]);
      // y(k) = b0 u(k) + b1 u(k-1) + ... - a1 y(k-1) - ...
      const uh = new Array(n).fill(0), yh = new Array(n).fill(0);
      let last = 0;
      return {
        feedthrough: b[0] !== 0,
        sampleTime: positive(p, 'Ts'),
        output(_t, _x, u, y) {
          let acc = b[0] * u[0];
          for (let i = 1; i <= n; i++) acc += b[i] * uh[i - 1] - a[i] * yh[i - 1];
          last = acc;
          y[0] = acc;
        },
        update(_t, u) {
          uh.unshift(u[0]); uh.pop();
          yh.unshift(last); yh.pop();
        },
      };
    },
  },
  {
    type: 'RandomNumber', label: 'Random Number', category: 'Zdroje',
    slice: ['mean', 'variance', 'seed'],
    description: 'Náhodné čísla s normálnym rozdelením, nová hodnota v každej vzorke.',
    params: [
      { name: 'mean', label: 'Stredná hodnota', default: '0' },
      { name: 'variance', label: 'Rozptyl', default: '1' },
      { name: 'seed', label: 'Semienko (seed)', default: '0' },
      { name: 'Ts', label: 'Perióda vzorkovania [s]', default: '0.1' },
    ],
    ports: io(0, 1),
    create(p) {
      const mean = num(p, 'mean'), sd = Math.sqrt(Math.max(0, num(p, 'variance')));
      const rand = mulberry32(num(p, 'seed'));
      return {
        feedthrough: false,
        sampleTime: positive(p, 'Ts'),
        output(_t, _x, _u, y) {
          // Box-Muller
          const u1 = Math.max(rand(), 1e-300), u2 = rand();
          y[0] = mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        },
      };
    },
  },

  // ---------- Discontinuities ----------
  {
    type: 'Saturation', label: 'Saturation', category: 'Nespojitosti',
    slice: ['upper', 'lower'],
    description: 'Obmedzí signál na interval [dolná, horná].',
    params: [
      { name: 'upper', label: 'Horná hranica', default: '0.5' },
      { name: 'lower', label: 'Dolná hranica', default: '-0.5' },
    ],
    ports: io(1, 1),
    create(p) {
      const hi = num(p, 'upper'), lo = num(p, 'lower');
      if (lo > hi) throw new ExprError('Dolná hranica je väčšia ako horná');
      let mode = 0; // -1 lower limit, 0 linear, 1 upper limit
      return {
        feedthrough: true,
        nzc: 2,
        output(_t, _x, u, y, ctx) {
          if (ctx.major) mode = u[0] >= hi ? 1 : u[0] <= lo ? -1 : 0;
          y[0] = mode === 1 ? hi : mode === -1 ? lo : u[0];
        },
        zc(_t, u, out) { out[0] = u[0] - hi; out[1] = u[0] - lo; },
      };
    },
  },
  {
    type: 'Relay', label: 'Relay', category: 'Nespojitosti',
    slice: ['on', 'off', 'yon', 'yoff'],
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
        nzc: 1,
        zc(_t, u, out) { out[0] = state ? u[0] - off : u[0] - on; },
      };
    },
  },

  {
    type: 'DeadZone', label: 'Dead Zone', category: 'Nespojitosti',
    slice: ['start', 'end'],
    description: 'Nulový výstup v pásme [začiatok, koniec], mimo neho vstup posunutý o hranicu pásma.',
    params: [
      { name: 'start', label: 'Začiatok pásma', default: '-0.5' },
      { name: 'end', label: 'Koniec pásma', default: '0.5' },
    ],
    ports: io(1, 1),
    create(p) {
      const a = num(p, 'start'), b = num(p, 'end');
      if (a > b) throw new ExprError('Začiatok pásma je väčší ako koniec');
      let mode = 0;
      return {
        feedthrough: true,
        nzc: 2,
        output(_t, _x, u, y, ctx) {
          if (ctx.major) mode = u[0] > b ? 1 : u[0] < a ? -1 : 0;
          y[0] = mode === 1 ? u[0] - b : mode === -1 ? u[0] - a : 0;
        },
        zc(_t, u, out) { out[0] = u[0] - a; out[1] = u[0] - b; },
      };
    },
  },

  // ---------- Logic ----------
  {
    type: 'RelationalOperator', label: 'Relational Operator', category: 'Logika',
    description: 'Porovná dva vstupy; výstup je 1 (pravda) alebo 0 (nepravda).',
    params: [{ name: 'op', label: 'Operátor', default: '<=', kind: 'choice', choices: ['==', '~=', '<', '<=', '>', '>='] }],
    ports: io(2, 1),
    create(p) {
      const op = str(p, 'op');
      const cmp: Record<string, (a: number, b: number) => boolean> = {
        '==': (a, b) => a === b, '~=': (a, b) => a !== b, '<': (a, b) => a < b,
        '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
      };
      const f = cmp[op];
      if (!f) throw new ExprError(`Neznámy operátor ${op}`);
      let v = 0;
      return {
        feedthrough: true,
        nzc: 1,
        output(_t, _x, u, y, ctx) {
          if (ctx.major) v = f(u[0], u[1]) ? 1 : 0;
          y[0] = v;
        },
        zc(_t, u, out) { out[0] = u[0] - u[1]; },
      };
    },
  },
  {
    type: 'LogicalOperator', label: 'Logical Operator', category: 'Logika',
    description: 'Logická operácia nad vstupmi (nenulová hodnota = pravda).',
    params: [
      { name: 'op', label: 'Operácia', default: 'AND', kind: 'choice', choices: ['AND', 'OR', 'NAND', 'NOR', 'XOR', 'NOT'] },
      { name: 'inputs', label: 'Počet vstupov', default: '2' },
    ],
    ports: (raw) => ({ inputs: raw.op === 'NOT' ? 1 : clampInt(raw.inputs, 2, 8), outputs: 1 }),
    create(p) {
      const op = str(p, 'op');
      return {
        feedthrough: true,
        output(_t, _x, u, y) {
          const b = u.map((v) => v !== 0);
          const any = b.some(Boolean), all = b.every(Boolean);
          const r = op === 'AND' ? all : op === 'OR' ? any : op === 'NAND' ? !all : op === 'NOR' ? !any
            : op === 'XOR' ? b.filter(Boolean).length % 2 === 1 : !b[0];
          y[0] = r ? 1 : 0;
        },
      };
    },
  },
  {
    type: 'MinMax', label: 'MinMax', category: 'Matematika',
    description: 'Minimum alebo maximum zo vstupov.',
    params: [
      { name: 'fn', label: 'Funkcia', default: 'min', kind: 'choice', choices: ['min', 'max'] },
      { name: 'inputs', label: 'Počet vstupov', default: '2' },
    ],
    ports: (raw) => ({ inputs: clampInt(raw.inputs ?? '2', 1, 8), outputs: 1 }),
    // With a single input: minimum or maximum over the elements of the vector.
    wide: (p) => (vec(p, 'inputs')[0] === 1 ? [1] : null),
    create(p) {
      const f = str(p, 'fn') === 'max' ? Math.max : Math.min;
      return { feedthrough: true, output(_t, _x, u, y) { y[0] = f(...u); } };
    },
  },

  // ---------- Routing ----------
  {
    type: 'Switch', label: 'Switch', category: 'Smerovanie',
    slice: ['threshold'],
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
        nzc: 1,
        zc(_t, u, out) { out[0] = crit === 'u2 ~= 0' ? u[1] : u[1] - th; },
      };
    },
  },

  {
    type: 'Mux', label: 'Mux', category: 'Smerovanie',
    description: 'Spojí vstupné signály do jedného vektora.',
    params: [{ name: 'inputs', label: 'Počet vstupov', default: '2' }],
    ports: (raw) => ({ inputs: clampInt(raw.inputs ?? '2', 1, 16), outputs: 1 }),
    wide: (_p, inW) => [inW.reduce((a, b) => a + b, 0)],
    create() {
      return { feedthrough: true, output(_t, _x, u, y) { for (let i = 0; i < u.length; i++) y[i] = u[i]; } };
    },
  },
  {
    type: 'Demux', label: 'Demux', category: 'Smerovanie',
    description: 'Rozdelí vektor na niekoľko signálov (prvky sa rozdelia rovnomerne).',
    params: [{ name: 'outputs', label: 'Počet výstupov', default: '2' }],
    ports: (raw) => ({ inputs: 1, outputs: clampInt(raw.outputs ?? '2', 1, 16) }),
    wide(p, inW) {
      const n = clampInt(String(vec(p, 'outputs')[0]), 1, 16), w = inW[0];
      if (w < n) throw new ExprError(`Vstup má len ${w} prvkov, výstupov je ${n}`);
      return Array.from({ length: n }, (_, i) => Math.floor(w / n) + (i < w % n ? 1 : 0));
    },
    create() {
      return { feedthrough: true, output(_t, _x, u, y) { for (let i = 0; i < u.length; i++) y[i] = u[i]; } };
    },
  },

  // ---------- User-defined functions ----------
  {
    type: 'Fcn', label: 'Fcn', category: 'Vlastné funkcie',
    description: 'Výraz v syntaxi Octave zo vstupu u (vektor: u(1), u(2), …) a času t, napr. „u(1)^2 + sin(t)“.',
    params: [{ name: 'expr', label: 'Výraz', default: 'u^2', kind: 'text' }],
    ports: io(1, 1),
    wide: (p, inW, scope) => [probeWidth(() => compileExpr(str(p, 'expr'))({ ...scope, u: zeros(inW[0]), t: [0] }))],
    create(p, _inW, scope) {
      const f = compileExpr(str(p, 'expr'));
      const sc: Scope = { ...scope };
      return {
        feedthrough: true,
        output(t, _x, u, y) {
          sc.u = u;
          sc.t = [t];
          const v = f(sc);
          for (let i = 0; i < y.length; i++) y[i] = v.length === 1 ? v[0] : v[i] ?? 0;
        },
      };
    },
  },
  {
    type: 'OctaveFcn', label: 'Octave Function', category: 'Vlastné funkcie',
    description:
      'Krátky program v syntaxi Octave/MATLAB. Vstupy sú u1, u2, … (pri jednom vstupe aj u), výstupy y1, y2, … ' +
      '(pri jednom výstupe aj y), čas t. Podporuje if/elseif/else, for, while a premenné z pracovného priestoru.',
    params: [
      { name: 'code', label: 'Kód', default: 'if u > 0\n  y = u;\nelse\n  y = 0;\nend', kind: 'code' },
      { name: 'inputs', label: 'Počet vstupov', default: '1' },
      { name: 'outputs', label: 'Počet výstupov', default: '1' },
    ],
    ports: (raw) => ({ inputs: clampInt(raw.inputs ?? '1', 0, 8), outputs: clampInt(raw.outputs ?? '1', 1, 8) }),
    wide(p, inW, scope) {
      const run = octaveFcn(p, scope);
      return probe(() => run(0, inW.map(zeros)), clampInt(String(vec(p, 'outputs')[0]), 1, 8));
    },
    create(p, inW, scope) {
      const run = octaveFcn(p, scope);
      return {
        feedthrough: true,
        output(t, _x, u, y) {
          // Inputs arrive flattened; split them back into u1, u2, ...
          let o = 0;
          const ins = inW!.map((w) => u.slice(o, (o += w)));
          const outs = run(t, ins);
          let k = 0;
          for (const v of outs) for (const x of v) y[k++] = x;
        },
      };
    },
  },

  // ---------- Ports & subsystems ----------
  // A Subsystem is flattened away before simulation; Inport/Outport become pass-through blocks.
  {
    type: 'Subsystem', label: 'Subsystem', category: 'Porty a subsystémy',
    description: 'Skupina blokov ako jeden blok. Dvojklikom otvoríte jeho obsah.',
    params: [],
    ports: io(1, 1), // real counts come from its Inport/Outport blocks
    create() { throw new ExprError('Subsystem sa pred simuláciou rozbalí'); },
  },
  {
    type: 'Inport', label: 'In', category: 'Porty a subsystémy',
    description: 'Vstup subsystému. Číslo portu určuje poradie vstupov.',
    params: [{ name: 'port', label: 'Číslo portu', default: '1' }],
    ports: io(0, 1),
    create: passThrough,
  },
  {
    type: 'Outport', label: 'Out', category: 'Porty a subsystémy',
    description: 'Výstup subsystému. Číslo portu určuje poradie výstupov.',
    params: [{ name: 'port', label: 'Číslo portu', default: '1' }],
    ports: io(1, 0),
    create: passThrough,
  },

  // ---------- Sinks ----------
  {
    type: 'Scope', label: 'Scope', category: 'Výstupy',
    description: 'Zobrazí priebehy vstupných signálov v čase.',
    params: [{ name: 'inputs', label: 'Počet vstupov', default: '1' }],
    ports: (raw) => ({ inputs: clampInt(raw.inputs, 1, 8), outputs: 0 }),
    wide: () => [],
    create() {
      return { feedthrough: true, sink: true, output() {} };
    },
  },
  {
    type: 'Display', label: 'Display', category: 'Výstupy',
    description: 'Ukáže poslednú hodnotu vstupu priamo v bloku.',
    params: [],
    ports: io(1, 0),
    wide: () => [],
    create() {
      return { feedthrough: true, sink: true, output() {} };
    },
  },
  {
    type: 'Terminator', label: 'Terminator', category: 'Výstupy',
    description: 'Ukončí nepoužitý signál (bez upozornenia na nepripojený výstup).',
    params: [],
    ports: io(1, 0),
    wide: () => [],
    create() {
      return { feedthrough: false, output() {} };
    },
  },
  {
    type: 'Unsupported', label: 'Nepodporovaný blok', category: 'Výstupy', hidden: true,
    description: 'Zástupca bloku z importovaného modelu, ktorý P-Sim zatiaľ nepozná. Jeho výstupy sú nulové.',
    params: [
      { name: 'kind', label: 'Pôvodný typ', default: '?', kind: 'text' },
      { name: 'inputs', label: 'Počet vstupov', default: '1', kind: 'text' },
      { name: 'outputs', label: 'Počet výstupov', default: '1', kind: 'text' },
    ],
    ports: (raw) => ({ inputs: clampInt(raw.inputs ?? '1', 0, 32), outputs: clampInt(raw.outputs ?? '1', 0, 32) }),
    create() {
      return { feedthrough: false, output(_t, _x, _u, y) { y.fill(0); } };
    },
  },
];

const zeros = (n: number) => new Array(n).fill(0);

/** Output width of a user expression, found by evaluating it once on zero inputs. */
function probeWidth(f: () => Value): number {
  try {
    return Math.max(1, f().length);
  } catch {
    return 1; // the real error is reported when the simulation runs
  }
}

function probe(f: () => Value[], n: number): number[] {
  try {
    return f().map((v) => Math.max(1, v.length));
  } catch {
    return new Array(n).fill(1);
  }
}

/** Compiles an Octave Function block: returns (t, inputs) => outputs. */
function octaveFcn(p: Params, scope: Scope) {
  const script = compileScript(str(p, 'code'));
  const nIn = clampInt(String(vec(p, 'inputs')[0]), 0, 8), nOut = clampInt(String(vec(p, 'outputs')[0]), 1, 8);
  return (t: number, ins: number[][]): Value[] => {
    const sc: Scope = { ...scope, t: [t] };
    ins.forEach((v, i) => (sc[`u${i + 1}`] = v));
    if (nIn === 1) sc.u = ins[0];
    script(sc);
    return Array.from({ length: nOut }, (_, i) => {
      const v = sc[`y${i + 1}`] ?? (nOut === 1 ? sc.y : undefined);
      if (!v) throw new ExprError(`Kód nepriradil výstup ${nOut === 1 ? 'y' : `y${i + 1}`}`);
      return v;
    });
  };
}

/** Inport/Outport after flattening: one input copied to one output. */
function passThrough(): BlockRuntime {
  return { feedthrough: true, output(_t, _x, u, y) { y[0] = u[0] ?? 0; } };
}

/** Small seeded PRNG so simulations are repeatable. */
function mulberry32(seed: number) {
  let a = Math.floor(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
