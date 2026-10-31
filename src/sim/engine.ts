// Compiles a Model into an executable block list and runs the simulation loop.
//
// Each major step: compute all outputs in sorted order, log sinks, update discrete
// states at their sample hits, then integrate continuous states to the next major
// time. Steps are shortened to land exactly on sample hits and source discontinuities.

import { BLOCKS, type BlockDef, type BlockRuntime, type Params, type StepCtx } from './blocks';
import { evaluate, runWorkspace, type Scope } from './expr';
import { FlattenError, flatten, type FlatBlock } from './flatten';
import { FIXED_STEP_SOLVERS, type Model, type SolverName } from './types';
import { TABLEAUS, type Tableau } from './solvers';

export class SimError extends Error {
  constructor(message: string, public blockId?: string) {
    super(message);
  }
}

interface CBlock {
  id: string;
  name: string;
  type: string;
  rt: BlockRuntime;
  /** Signal index feeding each input element, or -1 when unconnected (reads 0). */
  inSig: number[];
  /** Signal index written by each output element. */
  outSig: number[];
  u: number[];
  y: number[];
  xOff: number;
  nx: number;
  Ts?: number;
  k: number; // number of sample hits so far
  hitNow: boolean;
  /** Channel names of a sink: u1, u2(1), u2(2), ... */
  labels?: string[];
}

export interface Compiled {
  order: CBlock[];
  nx: number;
  nSignals: number;
  x0: Float64Array;
  scope: Scope;
  warnings: string[];
  /** Width of each output port of each flat block, keyed "blockId:port" (for the editor). */
  widths: Record<string, number>;
}

export interface SignalLog {
  blockId: string;
  name: string;
  t: number[];
  /** y[channel][sample] */
  y: number[][];
  labels: string[];
}

export interface SimResult {
  logs: Record<string, SignalLog>;
  warnings: string[];
  steps: number;
  rejected: number;
  tEnd: number;
  elapsedMs: number;
  widths: Record<string, number>;
}

interface Pre {
  fb: FlatBlock;
  def: BlockDef;
  params: Params;
  /** Source of each input port: index into pre[] and port, or null when unconnected. */
  src: ({ b: number; port: number } | null)[];
  outW: (number | undefined)[];
}

function callWide(pb: Pre, inW: number[]): number[] | null {
  try {
    return pb.def.wide!(pb.params, inW, pb.fb.scope);
  } catch (e) {
    throw new SimError(`Blok „${pb.fb.name}“: ${(e as Error).message}`, pb.fb.id);
  }
}

const sameW = (a: (number | undefined)[], b: (number | undefined)[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Signal widths (vector lengths) of every output port. Most blocks work element by
 * element: their width is the largest width among their inputs and their sliceable
 * parameters (Constant [1 2 3] has width 3). Wide blocks such as Mux decide their output
 * widths from all input widths. Widths are propagated to a fixed point; feedback loops
 * without any width information default to scalars.
 */
function inferWidths(pre: Pre[]) {
  const inW = (pb: Pre) => pb.src.map((s) => (s ? pre[s.b].outW[s.port] : 1));
  const step = (pb: Pre): (number | undefined)[] => {
    const w = inW(pb);
    if (pb.def.wide) {
      if (w.some((v) => v === undefined)) return pb.outW;
      const out = callWide(pb, w as number[]);
      if (out) return out;
    }
    let width: number | undefined = pb.src.length === 0 ? 1 : undefined;
    for (const v of w) if (v !== undefined) width = Math.max(width ?? 1, v);
    for (const name of pb.def.slice ?? []) {
      const v = pb.params[name];
      if (typeof v !== 'string' && v.length > 1) width = Math.max(width ?? 1, v.length);
    }
    // Never forget a width already found (e.g. a scalar assumed for a loop).
    return width === undefined ? pb.outW : pb.outW.map(() => width);
  };
  const limit = 20 + 4 * pre.length;
  for (let iter = 0; ; iter++) {
    if (iter > limit) throw new SimError('Šírky signálov sa nedajú určiť: slučka cez Mux stále zväčšuje vektor.');
    let changed = false;
    for (const pb of pre) {
      const nw = step(pb);
      if (!sameW(nw, pb.outW)) { pb.outW = nw; changed = true; }
    }
    if (changed) continue;
    // A loop with no width information: assume scalars and propagate again.
    const open = pre.find((pb) => pb.outW.some((v) => v === undefined));
    if (!open) break;
    open.outW = open.outW.map((v) => v ?? 1);
  }
  // Element-wise blocks: every input and sliced parameter must be scalar or full width.
  for (const pb of pre) {
    const w = inW(pb) as number[];
    if (pb.def.wide && callWide(pb, w)) continue;
    const width = pb.outW[0] ?? Math.max(1, ...w);
    w.forEach((v, q) => {
      if (v !== 1 && v !== width) {
        throw new SimError(`Blok „${pb.fb.name}“: vstup ${q + 1} má šírku ${v}, ostatné signály majú šírku ${width}.`, pb.fb.id);
      }
    });
    for (const name of pb.def.slice ?? []) {
      const v = pb.params[name];
      if (typeof v !== 'string' && v.length !== 1 && v.length !== width) {
        const label = pb.def.params.find((d) => d.name === name)?.label ?? name;
        throw new SimError(`Blok „${pb.fb.name}“: parameter „${label}“ má ${v.length} prvkov, signál má šírku ${width}.`, pb.fb.id);
      }
    }
  }
}

export function compile(model: Model): Compiled {
  let scope: Scope;
  try {
    scope = runWorkspace(model.workspace);
  } catch (e) {
    throw new SimError(`Pracovný priestor: ${(e as Error).message}`);
  }

  const warnings: string[] = [];
  let flat: ReturnType<typeof flatten>;
  try {
    flat = flatten(model, scope);
  } catch (e) {
    throw new SimError((e as Error).message, e instanceof FlattenError ? e.blockId : undefined);
  }

  // 1. Evaluate parameters.
  const pre: Pre[] = flat.blocks.map((fb) => {
    const bm = fb.block;
    const def = BLOCKS[bm.type];
    if (!def) throw new SimError(`Neznámy typ bloku „${bm.type}“`, fb.id);
    if (bm.type === 'Unsupported') warnings.push(`Blok „${fb.name}“ (${bm.params.kind}) nie je podporovaný, jeho výstup je 0.`);
    const params: Params = {};
    for (const pd of def.params) {
      const raw = bm.params[pd.name] ?? pd.default;
      if (pd.kind === 'text' || pd.kind === 'choice' || pd.kind === 'code') {
        params[pd.name] = raw;
        continue;
      }
      try {
        params[pd.name] = evaluate(raw, fb.scope);
      } catch (e) {
        throw new SimError(`Blok „${fb.name}“, parameter „${pd.label}“: ${(e as Error).message}`, fb.id);
      }
    }
    return { fb, def, params, src: new Array(fb.inputs).fill(null), outW: new Array(fb.outputs).fill(undefined) };
  });
  const index = new Map(pre.map((pb, i) => [pb.fb.id, i]));
  for (const l of flat.links) {
    const si = index.get(l.src.block), di = index.get(l.dst.block);
    if (si === undefined || di === undefined) continue;
    if (l.src.port >= pre[si].fb.outputs || l.dst.port >= pre[di].fb.inputs) continue;
    pre[di].src[l.dst.port] = { b: si, port: l.src.port };
  }
  for (const pb of pre) {
    // A top-level Inport has no outer signal by design.
    if (pb.fb.block.type === 'Inport' && !pb.fb.id.includes('/')) continue;
    pb.src.forEach((s, i) => {
      if (!s) warnings.push(`Blok „${pb.fb.name}“: vstup ${i + 1} nie je pripojený, použije sa 0.`);
    });
  }

  // 2. Widths and signal allocation.
  inferWidths(pre);
  let nSignals = 0;
  const outSignals = pre.map((pb) => pb.outW.map((w) => Array.from({ length: w! }, () => nSignals++)));
  const widths: Record<string, number> = {};
  pre.forEach((pb) => pb.outW.forEach((w, p) => (widths[`${pb.fb.id}:${p}`] = w!)));

  // 3. Runtimes: one per wide block, one per element for element-wise blocks.
  const blocks: CBlock[] = [];
  let nx = 0;
  const make = (pb: Pre, params: Params, inSig: number[], outSig: number[], inW?: number[]) => {
    let rt: BlockRuntime;
    try {
      rt = pb.def.create(params, inW, pb.fb.scope);
    } catch (e) {
      throw new SimError(`Blok „${pb.fb.name}“: ${(e as Error).message}`, pb.fb.id);
    }
    const cb: CBlock = {
      id: pb.fb.id, name: pb.fb.name, rt, type: pb.fb.block.type,
      inSig, outSig,
      u: new Array(inSig.length).fill(0),
      y: new Array(outSig.length).fill(0),
      xOff: nx, nx: rt.nx ?? 0, Ts: rt.sampleTime, k: 0, hitNow: false,
    };
    nx += cb.nx;
    blocks.push(cb);
    return cb;
  };
  for (let bi = 0; bi < pre.length; bi++) {
    const pb = pre[bi];
    const inW = pb.src.map((s) => (s ? pre[s.b].outW[s.port]! : 1));
    if (pb.def.wide && callWide(pb, inW)) {
      const inSig = pb.src.flatMap((s, q) => (s ? outSignals[s.b][s.port] : new Array(inW[q]).fill(-1)));
      const cb = make(pb, pb.params, inSig, outSignals[bi].flat(), inW);
      cb.labels = inW.flatMap((w, q) => (w === 1 ? [`u${q + 1}`] : Array.from({ length: w }, (_, i) => `u${q + 1}(${i + 1})`)));
      continue;
    }
    const width = pb.outW[0] ?? Math.max(1, ...inW);
    for (let i = 0; i < width; i++) {
      const params: Params = { ...pb.params };
      for (const name of pb.def.slice ?? []) {
        const v = params[name];
        if (typeof v !== 'string' && v.length === width && width > 1) params[name] = [v[i]];
      }
      const inSig = pb.src.map((s) => {
        if (!s) return -1;
        const sig = outSignals[s.b][s.port];
        return sig.length === 1 ? sig[0] : sig[i];
      });
      const cb = make(pb, params, inSig, outSignals[bi].map((sig) => sig[i]));
      if (pb.def.wide === undefined && cb.rt.sink) cb.labels = inSig.map((_, q) => `u${q + 1}`);
    }
  }

  const x0 = new Float64Array(nx);
  for (const b of blocks) b.rt.x0?.forEach((v, i) => (x0[b.xOff + i] = v));

  return { order: sortBlocks(blocks), nx, nSignals, x0, scope, warnings, widths };
}

/**
 * Topological order over direct-feedthrough dependencies: a block whose output depends
 * on its input runs after the blocks feeding it. A cycle of such blocks is an algebraic loop.
 */
function sortBlocks(blocks: CBlock[]): CBlock[] {
  const ownerOf = new Map<number, CBlock>();
  for (const b of blocks) for (const s of b.outSig) ownerOf.set(s, b);
  const deps = new Map<CBlock, Set<CBlock>>();
  const users = new Map<CBlock, CBlock[]>();
  for (const b of blocks) {
    const d = new Set<CBlock>();
    if (b.rt.feedthrough) {
      for (const s of b.inSig) {
        const src = s >= 0 ? ownerOf.get(s) : undefined;
        if (src) d.add(src);
      }
    }
    deps.set(b, d);
    for (const src of d) users.set(src, [...(users.get(src) ?? []), b]);
  }
  const order: CBlock[] = [];
  const ready = blocks.filter((b) => deps.get(b)!.size === 0);
  const remaining = new Map(blocks.map((b) => [b, deps.get(b)!.size]));
  while (ready.length) {
    const b = ready.shift()!;
    order.push(b);
    for (const user of users.get(b) ?? []) {
      const n = remaining.get(user)! - 1;
      remaining.set(user, n);
      if (n === 0) ready.push(user);
    }
  }
  if (order.length < blocks.length) {
    const loop = blocks.filter((b) => !order.includes(b)).map((b) => `„${b.name}“`);
    throw new SimError(
      `Algebraická slučka: bloky ${loop.join(', ')} na seba priamo závisia. ` +
        'Vložte do slučky Integrator, Unit Delay alebo prenosovú funkciu s vyšším stupňom menovateľa.',
    );
  }
  return order;
}

function evalSetting(src: string, scope: Scope, label: string): number {
  try {
    const v = evaluate(src, scope);
    if (v.length !== 1 || !isFinite(v[0])) throw new Error('musí byť konečné číslo');
    return v[0];
  } catch (e) {
    throw new SimError(`Nastavenie simulácie „${label}“: ${(e as Error).message}`);
  }
}

export interface SimOptions {
  maxSteps?: number;
  /** Extra output points per step for variable-step solvers (smoother plots). */
  refine?: number;
}

export function simulate(model: Model, opts: SimOptions = {}): SimResult {
  const started = performance.now();
  const c = compile(model);
  const s = model.settings;
  const t0 = evalSetting(s.startTime, c.scope, 'Začiatok');
  const tf = evalSetting(s.stopTime, c.scope, 'Koniec');
  if (!(tf > t0)) throw new SimError('Koniec simulácie musí byť väčší ako začiatok.');
  const span = tf - t0;
  const solver: SolverName = s.solver;
  const fixed = FIXED_STEP_SOLVERS.includes(solver);
  const discreteTs = c.order.map((b) => b.Ts).filter((v): v is number => v !== undefined);
  const autoFixed = discreteTs.length ? Math.min(...discreteTs) : span / 50;
  const hFixed = s.fixedStep.trim() === 'auto' ? autoFixed : evalSetting(s.fixedStep, c.scope, 'Pevný krok');
  const hMax = s.maxStep.trim() === 'auto' ? span / 50 : evalSetting(s.maxStep, c.scope, 'Maximálny krok');
  const rtol = evalSetting(s.relTol, c.scope, 'Relatívna tolerancia');
  const atol = evalSetting(s.absTol, c.scope, 'Absolútna tolerancia');
  if (!(hFixed > 0) || !(hMax > 0)) throw new SimError('Veľkosť kroku musí byť kladná.');
  if (!(rtol > 0) || !(atol > 0)) throw new SimError('Tolerancie musia byť kladné.');
  const maxSteps = opts.maxSteps ?? 500_000;
  const refine = fixed ? 1 : Math.max(1, opts.refine ?? 4);
  const implicit = solver === 'ode23s';
  // ode23s needs no tableau; ode23's provides the stage buffers and Hermite data it shares.
  const tableau: Tableau = TABLEAUS[solver === 'ode23s' ? 'ode23' : solver];
  const order = implicit ? 2 : tableau.order;
  const tTol = 1e-10 * Math.max(1, Math.abs(tf), Math.abs(t0));

  const signals = new Float64Array(c.nSignals);
  const ctx: StepCtx = { major: true, hit: false };
  const sinks = c.order.filter((b) => b.rt.sink);
  const logs: Record<string, SignalLog> = {};
  for (const b of sinks) logs[b.id] = { blockId: b.id, name: b.name, t: [], y: b.u.map(() => []), labels: b.labels ?? b.u.map((_, i) => `u${i + 1}`) };

  // Per-block views into the state arrays, cached per array.
  const viewCache = new Map<Float64Array, Float64Array[]>();
  const views = (arr: Float64Array) => {
    let v = viewCache.get(arr);
    if (!v) {
      v = c.order.map((b) => arr.subarray(b.xOff, b.xOff + b.nx));
      viewCache.set(arr, v);
    }
    return v;
  };

  const gather = (b: CBlock) => {
    for (let i = 0; i < b.inSig.length; i++) b.u[i] = b.inSig[i] >= 0 ? signals[b.inSig[i]] : 0;
  };

  const outputs = (t: number, x: Float64Array, major: boolean) => {
    const xv = views(x);
    ctx.major = major;
    for (let i = 0; i < c.order.length; i++) {
      const b = c.order[i];
      gather(b);
      ctx.hit = major && b.hitNow;
      // A discrete block computes its output only at its sample hits and holds it in between.
      if (b.Ts === undefined || ctx.hit) b.rt.output(t, xv[i], b.u, b.y, ctx);
      for (let j = 0; j < b.y.length; j++) signals[b.outSig[j]] = b.y[j];
    }
    // Non-feedthrough blocks may run before their sources; give everyone the final inputs.
    for (const b of c.order) gather(b);
  };

  const derivatives = (t: number, x: Float64Array, dx: Float64Array) => {
    const xv = views(x), dv = views(dx);
    for (let i = 0; i < c.order.length; i++) {
      const b = c.order[i];
      if (b.nx) b.rt.derivative!(t, xv[i], b.u, dv[i]);
    }
  };

  const f = (t: number, x: Float64Array, dx: Float64Array) => {
    outputs(t, x, false);
    derivatives(t, x, dx);
  };

  const logSinks = (t: number) => {
    for (const b of sinks) {
      const l = logs[b.id];
      l.t.push(t);
      for (let j = 0; j < b.u.length; j++) l.y[j].push(b.u[j]);
    }
  };

  const nx = c.nx;
  let x = Float64Array.from(c.x0);
  const k = Array.from({ length: tableau.c.length }, () => new Float64Array(nx));
  const xs = new Float64Array(nx); // stage state
  let xNew = new Float64Array(nx);
  const xErr = new Float64Array(nx);
  const fEnd = new Float64Array(nx);
  const xRef = new Float64Array(nx);

  /** One explicit Runge-Kutta step; k[0] must already hold f(t, x). */
  const rkStep = (t: number, h: number) => {
    const { a, b, c: cc } = tableau;
    for (let st = 1; st < cc.length; st++) {
      for (let i = 0; i < nx; i++) {
        let acc = x[i];
        for (let j = 0; j < st; j++) acc += h * a[st][j] * k[j][i];
        xs[i] = acc;
      }
      f(t + cc[st] * h, xs, k[st]);
    }
    for (let i = 0; i < nx; i++) {
      let acc = x[i];
      for (let j = 0; j < cc.length; j++) acc += h * b[j] * k[j][i];
      xNew[i] = acc;
    }
    if (tableau.e) {
      for (let i = 0; i < nx; i++) {
        let acc = 0;
        for (let j = 0; j < cc.length; j++) acc += h * tableau.e[j] * k[j][i];
        xErr[i] = acc;
      }
    }
  };

  const errorNorm = () => {
    let m = 0;
    for (let i = 0; i < nx; i++) {
      const sc = atol + rtol * Math.max(Math.abs(x[i]), Math.abs(xNew[i]));
      m = Math.max(m, Math.abs(xErr[i]) / sc);
    }
    return m;
  };

  // ---- Rosenbrock ode23s (Shampine & Reichelt), Jacobian by finite differences ----
  const J = new Float64Array(nx * nx);
  const W = new Float64Array(nx * nx);
  const piv = new Int32Array(nx);
  const dfdt = new Float64Array(nx);
  const col = new Float64Array(nx);
  const r1 = new Float64Array(nx), r2 = new Float64Array(nx), r3 = new Float64Array(nx);
  const F1 = new Float64Array(nx), F2 = new Float64Array(nx);
  const dR = 1 / (2 + Math.SQRT2), e32 = 6 + Math.SQRT2;
  let jacT = NaN; // time of the current Jacobian

  const jacobian = (t: number) => {
    const F0 = k[0];
    for (let j = 0; j < nx; j++) {
      const del = Math.sqrt(Number.EPSILON) * Math.max(Math.abs(x[j]), atol / rtol, 1e-5);
      xs.set(x);
      xs[j] += del;
      f(t, xs, col);
      for (let i = 0; i < nx; i++) J[i * nx + j] = (col[i] - F0[i]) / del;
    }
    const dt = Math.sqrt(Number.EPSILON) * Math.max(Math.abs(t), 1e-5);
    f(t + dt, x, col);
    for (let i = 0; i < nx; i++) dfdt[i] = (col[i] - F0[i]) / dt;
    jacT = t;
  };

  const rosenbrockStep = (t: number, h: number) => {
    if (jacT !== t) jacobian(t);
    const F0 = k[0];
    for (let i = 0; i < nx * nx; i++) W[i] = -h * dR * J[i];
    for (let i = 0; i < nx; i++) W[i * nx + i] += 1;
    if (!luFactor(W, nx, piv)) throw new SimError(`Singulárna matica pri ode23s v čase t = ${t.toPrecision(6)}.`);
    for (let i = 0; i < nx; i++) r1[i] = F0[i] + h * dR * dfdt[i];
    luSolve(W, nx, piv, r1); // k1
    for (let i = 0; i < nx; i++) xs[i] = x[i] + 0.5 * h * r1[i];
    f(t + 0.5 * h, xs, F1);
    for (let i = 0; i < nx; i++) r2[i] = F1[i] - r1[i];
    luSolve(W, nx, piv, r2);
    for (let i = 0; i < nx; i++) {
      r2[i] += r1[i]; // k2
      xNew[i] = x[i] + h * r2[i];
    }
    f(t + h, xNew, F2);
    for (let i = 0; i < nx; i++) r3[i] = F2[i] - e32 * (r2[i] - F1[i]) - 2 * (r1[i] - F0[i]) + h * dR * dfdt[i];
    luSolve(W, nx, piv, r3); // k3
    for (let i = 0; i < nx; i++) xErr[i] = (h / 6) * (r1[i] - 2 * r2[i] + r3[i]);
  };

  // ---- Zero crossings ----
  const zcBlocks = c.order.filter((b) => b.rt.nzc);
  const nz = zcBlocks.reduce((n, b) => n + b.rt.nzc!, 0);
  const zStart = new Float64Array(nz), zEnd = new Float64Array(nz), zMid = new Float64Array(nz);
  const zBuf: number[] = [];
  /** Zero-crossing values for the inputs currently gathered in every block. */
  const evalZc = (t: number, out: Float64Array) => {
    let o = 0;
    for (const b of zcBlocks) {
      b.rt.zc!(t, b.u, zBuf);
      for (let i = 0; i < b.rt.nzc!; i++) out[o++] = zBuf[i];
    }
  };
  const crossed = (a: Float64Array, b: Float64Array) => {
    for (let i = 0; i < nz; i++) if ((a[i] < 0 && b[i] >= 0) || (a[i] > 0 && b[i] <= 0)) return true;
    return false;
  };
  const hermite = (s: number, h: number, out: Float64Array) => {
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    for (let i = 0; i < nx; i++) out[i] = h00 * x[i] + h10 * h * k[0][i] + h01 * xNew[i] + h11 * h * fEnd[i];
  };
  /** Fraction of the step (0, 1] just past the first zero crossing, or 0 when none occurs. */
  const locateCrossing = (t: number, h: number): number => {
    f(t + h, xNew, fEnd);
    evalZc(t + h, zEnd);
    if (!crossed(zStart, zEnd)) return 0;
    let lo = 0, hi = 1;
    for (let it = 0; it < 60 && (hi - lo) * h > tTol; it++) {
      const mid = (lo + hi) / 2;
      hermite(mid, h, xRef);
      outputs(t + mid * h, xRef, false);
      evalZc(t + mid * h, zMid);
      if (crossed(zStart, zMid)) hi = mid; else lo = mid;
    }
    return hi;
  };

  /** Logs `refine - 1` interior points of the step using cubic Hermite interpolation of the states. */
  const logRefined = (t: number, h: number) => {
    if (refine <= 1 || sinks.length === 0) return;
    f(t + h, xNew, fEnd);
    for (let j = 1; j < refine; j++) {
      const s = j / refine;
      hermite(s, h, xRef);
      outputs(t + s * h, xRef, false);
      logSinks(t + s * h);
    }
  };

  let t = t0;
  let steps = 0;
  let rejected = 0;
  let hNext = 0; // variable-step proposal

  for (;;) {
    for (const b of c.order) b.hitNow = b.Ts !== undefined && Math.abs(t - (t0 + b.k * b.Ts)) <= tTol;
    outputs(t, x, true);
    logSinks(t);
    for (const b of c.order) b.rt.onMajor?.(t, b.u);
    if (nz) evalZc(t, zStart);
    for (const b of c.order) {
      if (!b.hitNow) continue;
      b.rt.update?.(t, b.u);
      b.k++;
    }
    if (t >= tf - tTol) break;
    if (++steps > maxSteps) {
      throw new SimError(
        `Prekročený počet krokov (${maxSteps}) v čase t = ${t.toPrecision(6)}. ` +
          'Systém môže byť tuhý (stiff) alebo divergovať; skúste iný riešič alebo väčší krok.',
      );
    }

    // Next point we must not step over: stop time, sample hit or source discontinuity.
    let tBreak = tf;
    for (const b of c.order) {
      if (b.Ts !== undefined) tBreak = Math.min(tBreak, t0 + b.k * b.Ts);
      if (b.rt.nextEvent) tBreak = Math.min(tBreak, b.rt.nextEvent(t));
    }

    if (nx === 0) {
      t = Math.min(tBreak, t + (fixed ? hFixed : hMax));
      continue;
    }

    derivatives(t, x, k[0]);

    if (fixed) {
      let h = hFixed;
      if (t + h > tBreak - tTol) h = tBreak - t;
      rkStep(t, h);
      t = t + h >= tBreak - tTol ? tBreak : t + h;
      [x, xNew] = [xNew, x];
    } else {
      if (hNext === 0) hNext = initialStep(x, k[0], atol, rtol, hMax);
      let hZc = 0; // step shortened to end just past a zero crossing
      for (;;) {
        let h = hZc || Math.min(hNext, hMax);
        const landing = t + h >= tBreak - tTol;
        if (landing) h = tBreak - t;
        if (implicit) rosenbrockStep(t, h); else rkStep(t, h);
        const err = errorNorm();
        if (!isFinite(err)) throw new SimError(`Simulácia divergovala v čase t = ${t.toPrecision(6)}.`);
        const factor = err === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * err ** (-1 / (order + 1))));
        if (err <= 1) {
          if (nz && !hZc) {
            const s = locateCrossing(t, h);
            if (s > 0 && s * h < h - tTol) {
              hZc = s * h;
              continue;
            }
          }
          logRefined(t, h);
          t = landing ? tBreak : t + h;
          [x, xNew] = [xNew, x];
          // Do not let a step shortened by an event or crossing shrink the next proposal.
          hNext = landing || hZc ? Math.max(hNext, h * factor) : h * factor;
          break;
        }
        hZc = 0;
        rejected++;
        hNext = h * Math.max(0.1, factor);
        if (hNext < 16 * Number.EPSILON * Math.max(1, Math.abs(t))) {
          throw new SimError(`Krok riešiča je príliš malý v čase t = ${t.toPrecision(6)}.`);
        }
      }
    }
    for (let i = 0; i < nx; i++) {
      if (!isFinite(x[i])) throw new SimError(`Simulácia divergovala v čase t = ${t.toPrecision(6)}.`);
    }
  }

  return { logs, warnings: c.warnings, steps, rejected, tEnd: t, elapsedMs: performance.now() - started, widths: c.widths };
}

/** In-place LU factorization with partial pivoting of the n×n row-major matrix A. */
function luFactor(A: Float64Array, n: number, piv: Int32Array): boolean {
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i * n + k]) > Math.abs(A[p * n + k])) p = i;
    piv[k] = p;
    if (A[p * n + k] === 0) return false;
    if (p !== k) for (let j = 0; j < n; j++) [A[k * n + j], A[p * n + j]] = [A[p * n + j], A[k * n + j]];
    for (let i = k + 1; i < n; i++) {
      const m = (A[i * n + k] /= A[k * n + k]);
      for (let j = k + 1; j < n; j++) A[i * n + j] -= m * A[k * n + j];
    }
  }
  return true;
}

/** Solves A x = b in place using the factors from luFactor. */
function luSolve(A: Float64Array, n: number, piv: Int32Array, b: Float64Array) {
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) [b[k], b[p]] = [b[p], b[k]];
    for (let i = k + 1; i < n; i++) b[i] -= A[i * n + k] * b[k];
  }
  for (let i = n - 1; i >= 0; i--) {
    let acc = b[i];
    for (let j = i + 1; j < n; j++) acc -= A[i * n + j] * b[j];
    b[i] = acc / A[i * n + i];
  }
}

function initialStep(x: Float64Array, f0: Float64Array, atol: number, rtol: number, hMax: number): number {
  let d0 = 0, d1 = 0;
  for (let i = 0; i < x.length; i++) {
    const sc = atol + rtol * Math.abs(x[i]);
    d0 = Math.max(d0, Math.abs(x[i]) / sc);
    d1 = Math.max(d1, Math.abs(f0[i]) / sc);
  }
  const h = d0 < 1e-5 || d1 < 1e-5 ? 1e-6 : 0.01 * (d0 / d1);
  return Math.min(hMax, Math.max(h, 1e-6 * hMax));
}
