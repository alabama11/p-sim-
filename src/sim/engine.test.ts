import { describe, expect, it } from 'vitest';
import { ModelBuilder } from './build';
import { simulate, SimError } from './engine';
import type { SolverName } from './types';

/** Max |log - exact| over all logged points of the given scope channel. */
function maxError(log: { t: number[]; y: number[][] }, exact: (t: number) => number, ch = 0) {
  return Math.max(...log.t.map((t, i) => Math.abs(log.y[ch][i] - exact(t))));
}

function valueAt(log: { t: number[]; y: number[][] }, t: number, ch = 0) {
  const i = log.t.findIndex((tt) => Math.abs(tt - t) < 1e-9);
  expect(i).toBeGreaterThanOrEqual(0);
  return log.y[ch][i];
}

describe('simulation engine', () => {
  it('integrates a constant', () => {
    const m = new ModelBuilder('ramp', { stopTime: '5' });
    const c = m.add('Constant', 'c', { value: '2' });
    const i = m.add('Integrator', 'int');
    const s = m.add('Scope', 'scope');
    m.connect(c, 0, i, 0).connect(i, 0, s, 0);
    const r = simulate(m.model);
    expect(r.tEnd).toBe(5);
    expect(maxError(r.logs[s], (t) => 2 * t)).toBeLessThan(1e-9);
  });

  it.each<[SolverName, string, number]>([
    ['ode45', 'auto', 1e-5],
    ['ode23', 'auto', 1e-4],
    ['ode4', '0.01', 1e-8],
    ['ode1', '0.001', 1e-3],
  ])('step response of 1/(s+1) with %s', (solver, fixedStep, tol) => {
    const m = new ModelBuilder('first-order', { solver, fixedStep, stopTime: '6', relTol: '1e-7', absTol: '1e-9' });
    const st = m.add('Step', 'step', { time: '1' });
    const tf = m.add('TransferFcn', 'G', { num: '[1]', den: '[1 1]' });
    const s = m.add('Scope', 'scope');
    m.connect(st, 0, tf, 0).connect(tf, 0, s, 0);
    const r = simulate(m.model);
    expect(maxError(r.logs[s], (t) => (t < 1 ? 0 : 1 - Math.exp(-(t - 1))))).toBeLessThan(tol);
  });

  it('solves the harmonic oscillator x\'\' = -x', () => {
    const m = new ModelBuilder('osc', { stopTime: '4*pi', relTol: '1e-9', absTol: '1e-11' });
    const i1 = m.add('Integrator', 'v', { x0: '0' });
    const i2 = m.add('Integrator', 'x', { x0: '1' });
    const g = m.add('Gain', 'g', { K: '-1' });
    const s = m.add('Scope', 'scope');
    m.connect(i1, 0, i2, 0).connect(i2, 0, g, 0).connect(g, 0, i1, 0).connect(i2, 0, s, 0);
    const r = simulate(m.model);
    expect(maxError(r.logs[s], Math.cos)).toBeLessThan(1e-6);
  });

  it('handles direct feedthrough in a transfer function', () => {
    const m = new ModelBuilder('lead', { stopTime: '5', relTol: '1e-8', absTol: '1e-10' });
    const st = m.add('Step', 'step', { time: '0' });
    const tf = m.add('TransferFcn', 'G', { num: '[1 2]', den: '[1 1]' });
    const s = m.add('Scope', 'scope');
    m.connect(st, 0, tf, 0).connect(tf, 0, s, 0);
    const r = simulate(m.model);
    expect(maxError(r.logs[s], (t) => 2 - Math.exp(-t))).toBeLessThan(1e-6);
  });

  it('PI control removes steady-state error', () => {
    const m = new ModelBuilder('pi', { stopTime: '20' });
    const ref = m.add('Step', 'ref', { time: '0' });
    const sum = m.add('Sum', 'e', { signs: '+-' });
    const pid = m.add('PID', 'pid', { P: '2', I: '1', D: '0' });
    const plant = m.add('TransferFcn', 'plant', { num: '[1]', den: '[2 1]' });
    const s = m.add('Scope', 'scope');
    m.connect(ref, 0, sum, 0).connect(sum, 0, pid, 0).connect(pid, 0, plant, 0)
      .connect(plant, 0, sum, 1).connect(plant, 0, s, 0);
    const r = simulate(m.model);
    expect(valueAt(r.logs[s], 20)).toBeCloseTo(1, 3);
  });

  it('samples discrete blocks exactly at their hits', () => {
    const m = new ModelBuilder('discrete', { stopTime: '3' });
    const c = m.add('Constant', 'c', { value: '1' });
    const di = m.add('DiscreteIntegrator', 'di', { Ts: '0.5' });
    const d = m.add('UnitDelay', 'z', { Ts: '0.5' });
    const s = m.add('Scope', 'scope', { inputs: '2' });
    m.connect(c, 0, di, 0).connect(di, 0, d, 0).connect(di, 0, s, 0).connect(d, 0, s, 1);
    const r = simulate(m.model);
    const log = r.logs[s];
    expect(valueAt(log, 2)).toBeCloseTo(2);   // 4 samples * 0.5
    expect(valueAt(log, 2, 1)).toBeCloseTo(1.5);
    // Held between samples.
    const between = log.t.map((t, i) => [t, log.y[0][i]]).filter(([t]) => t > 1 && t < 1.5);
    expect(between.length).toBeGreaterThan(0);
    for (const [, v] of between) expect(v).toBeCloseTo(1);
  });

  it('zero-order hold of a sine', () => {
    const m = new ModelBuilder('zoh', { stopTime: '2', solver: 'ode4', fixedStep: '0.1' });
    const sw = m.add('SineWave', 'sin');
    const z = m.add('ZeroOrderHold', 'zoh', { Ts: '0.5' });
    const s = m.add('Scope', 'scope');
    m.connect(sw, 0, z, 0).connect(z, 0, s, 0);
    const r = simulate(m.model);
    expect(valueAt(r.logs[s], 0.7)).toBeCloseTo(Math.sin(0.5));
    expect(valueAt(r.logs[s], 1.0)).toBeCloseTo(Math.sin(1.0));
  });

  it('pulse generator switches on its edges', () => {
    const m = new ModelBuilder('pulse', { stopTime: '3' });
    const p = m.add('PulseGenerator', 'p', { period: '1', width: '25', delay: '0.5' });
    const i = m.add('Integrator', 'int');
    const s = m.add('Scope', 'scope', { inputs: '2' });
    m.connect(p, 0, s, 0).connect(p, 0, i, 0).connect(i, 0, s, 1);
    const r = simulate(m.model);
    const log = r.logs[s];
    expect(valueAt(log, 0.5)).toBe(1);
    expect(valueAt(log, 0.75)).toBe(0);
    expect(valueAt(log, 1.5)).toBe(1);
    // Two full pulses of 0.25 s and part of the third (2.5–2.75) by t = 3.
    expect(valueAt(log, 3, 1)).toBeCloseTo(0.75, 9);
  });

  it('relay has hysteresis', () => {
    const m = new ModelBuilder('relay', { stopTime: '2*pi', solver: 'ode4', fixedStep: '0.001' });
    const sw = m.add('SineWave', 'sin');
    const rl = m.add('Relay', 'relay', { on: '0.5', off: '-0.5' });
    const s = m.add('Scope', 'scope');
    m.connect(sw, 0, rl, 0).connect(rl, 0, s, 0);
    const log = simulate(m.model).logs[s];
    expect(valueAt(log, 0.3)).toBe(0);   // sin < 0.5, still off
    expect(valueAt(log, 1)).toBe(1);     // switched on
    expect(valueAt(log, 3.3)).toBe(1);   // sin ≈ -0.16, still on
    expect(valueAt(log, 4)).toBe(0);     // below -0.5, off
  });

  it('detects algebraic loops', () => {
    const m = new ModelBuilder('loop');
    const c = m.add('Constant', 'c');
    const sum = m.add('Sum', 'sum', { signs: '+-' });
    const g = m.add('Gain', 'g', { K: '2' });
    m.connect(c, 0, sum, 0).connect(sum, 0, g, 0).connect(g, 0, sum, 1);
    expect(() => simulate(m.model)).toThrow(/Algebraická slučka/);
  });

  it('reports bad parameters with the block name', () => {
    const m = new ModelBuilder('bad', {}, 'K = 3');
    const c = m.add('Constant', 'zdroj', { value: 'K * nieco' });
    m.add('Scope', 'scope');
    expect(() => simulate(m.model)).toThrow(SimError);
    expect(() => simulate(m.model)).toThrow(/zdroj.*nieco/);
    expect(c).toBe('b1');
  });

  it('warns about unconnected inputs', () => {
    const m = new ModelBuilder('open');
    m.add('Gain', 'g');
    const r = simulate(m.model);
    expect(r.warnings[0]).toMatch(/nie je pripojený/);
  });
});
