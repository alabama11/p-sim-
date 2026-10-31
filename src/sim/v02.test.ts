import { describe, expect, it } from 'vitest';
import { ModelBuilder } from './build';
import { simulate } from './engine';
import type { Model } from './types';

const last = (log: { y: number[][] }, ch = 0) => log.y[ch][log.y[ch].length - 1];
function valueAt(log: { t: number[]; y: number[][] }, t: number, ch = 0) {
  const i = log.t.findIndex((tt) => Math.abs(tt - t) < 1e-9);
  expect(i).toBeGreaterThanOrEqual(0);
  return log.y[ch][i];
}

describe('zero-crossing detection', () => {
  it('integrates |sin t| accurately', () => {
    const m = new ModelBuilder('abs', { stopTime: '2*pi', relTol: '1e-8', absTol: '1e-10' });
    const sw = m.add('SineWave', 'sin');
    const ab = m.add('MathFunction', 'abs', { fn: 'abs' });
    const i = m.add('Integrator', 'int');
    const s = m.add('Scope', 'scope');
    m.connect(sw, 0, ab, 0).connect(ab, 0, i, 0).connect(i, 0, s, 0);
    expect(last(simulate(m.model).logs[s])).toBeCloseTo(4, 7);
  });

  it('places a step exactly where saturation starts', () => {
    const m = new ModelBuilder('sat', { stopTime: '3' });
    const sw = m.add('SineWave', 'sin');
    const sat = m.add('Saturation', 'sat', { upper: '0.5', lower: '-0.5' });
    const i = m.add('Integrator', 'int');
    const s = m.add('Scope', 'scope');
    m.connect(sw, 0, sat, 0).connect(sat, 0, i, 0).connect(i, 0, s, 0);
    const log = simulate(m.model).logs[s];
    expect(log.t.some((t) => Math.abs(t - Math.PI / 6) < 1e-8)).toBe(true);
    // ∫ of the clipped sine up to 5π/6 = (1 − cos π/6) + 0.5·(4π/6)
    const exact = (1 - Math.cos(Math.PI / 6)) + 0.5 * (4 * Math.PI / 6) + (Math.cos(5 * Math.PI / 6) - Math.cos(3));
    expect(last(log)).toBeCloseTo(exact, 5);
  });

  it('switches a relay exactly at its threshold', () => {
    const m = new ModelBuilder('relay', { stopTime: '2' });
    const c = m.add('Clock', 'clock');
    const r = m.add('Relay', 'relay', { on: '1.234', off: '0' });
    const i = m.add('Integrator', 'int');
    const s = m.add('Scope', 'scope');
    m.connect(c, 0, r, 0).connect(r, 0, i, 0).connect(i, 0, s, 0);
    expect(last(simulate(m.model).logs[s])).toBeCloseTo(2 - 1.234, 8);
  });
});

describe('ode23s', () => {
  // x' = -1000 (x - cos t): stiff, solution follows cos t after a fast transient.
  const stiff = (solver: 'ode23s' | 'ode45') => {
    const m = new ModelBuilder('stiff', { solver, stopTime: '10', relTol: '1e-3', absTol: '1e-6' });
    const clk = m.add('Clock', 'clock');
    const cos = m.add('MathFunction', 'cos', { fn: 'cos' });
    const sum = m.add('Sum', 'sum', { signs: '+-' });
    const g = m.add('Gain', 'g', { K: '1000' });
    const i = m.add('Integrator', 'x');
    const s = m.add('Scope', 'scope');
    m.connect(clk, 0, cos, 0).connect(cos, 0, sum, 0).connect(i, 0, sum, 1).connect(sum, 0, g, 0)
      .connect(g, 0, i, 0).connect(i, 0, s, 0);
    return { r: simulate(m.model), s };
  };

  it('solves a stiff problem in far fewer steps than ode45', () => {
    const a = stiff('ode23s'), b = stiff('ode45');
    const exact = (t: number) => (1e6 * Math.cos(t) + 1000 * Math.sin(t)) / (1e6 + 1);
    expect(Math.abs(last(a.r.logs[a.s]) - exact(10))).toBeLessThan(5e-3);
    expect(a.r.steps * 5).toBeLessThan(b.r.steps);
  });

  it('matches ode45 on a non-stiff oscillator', () => {
    const m = new ModelBuilder('osc', { solver: 'ode23s', stopTime: '2*pi', relTol: '1e-6', absTol: '1e-9' });
    const v = m.add('Integrator', 'v');
    const x = m.add('Integrator', 'x', { x0: '1' });
    const g = m.add('Gain', 'g', { K: '-1' });
    const s = m.add('Scope', 'scope');
    m.connect(v, 0, x, 0).connect(x, 0, g, 0).connect(g, 0, v, 0).connect(x, 0, s, 0);
    expect(last(simulate(m.model).logs[s])).toBeCloseTo(1, 3);
  });
});

describe('subsystems and masks', () => {
  function withSubsystem(masked: boolean): { model: Model; scope: string } {
    const m = new ModelBuilder('sub', { stopTime: '1' }, 'K = 3');
    const c = m.add('Constant', 'c', { value: '2' });
    const sub = m.add('Subsystem', 'S', masked ? { gain: 'K + 1' } : {});
    const s = m.add('Scope', 'scope');
    const inner = new ModelBuilder('inner');
    const ip = inner.add('Inport', 'In1', { port: '1' });
    const g = inner.add('Gain', 'g', { K: masked ? 'gain' : 'K' });
    const op = inner.add('Outport', 'Out1', { port: '1' });
    const sc = inner.add('Scope', 'inner scope');
    inner.connect(ip, 0, g, 0).connect(g, 0, op, 0).connect(g, 0, sc, 0);
    const sb = m.model.blocks.find((b) => b.id === sub)!;
    sb.children = { blocks: inner.model.blocks, links: inner.model.links };
    if (masked) sb.mask = { title: 'Zosilňovač', description: '', params: [{ name: 'gain', label: 'Zosilnenie', default: '1' }] };
    m.connect(c, 0, sub, 0).connect(sub, 0, s, 0);
    return { model: m.model, scope: s };
  }

  it('flattens a subsystem and logs scopes inside it', () => {
    const { model, scope } = withSubsystem(false);
    const r = simulate(model);
    expect(r.warnings).toEqual([]);
    expect(last(r.logs[scope])).toBe(6);
    const innerKey = Object.keys(r.logs).find((k) => k.includes('/'))!;
    expect(innerKey).toMatch(/^b2\//);
    expect(r.logs[innerKey].name).toBe('S/inner scope');
  });

  it('passes mask parameters to the blocks inside', () => {
    const { model, scope } = withSubsystem(true);
    expect(last(simulate(model).logs[scope])).toBe(8);
  });

  it('reports errors inside a subsystem with the path', () => {
    const { model } = withSubsystem(false);
    model.blocks[1].children!.blocks[1].params.K = 'neznama';
    expect(() => simulate(model)).toThrow(/S\/g/);
  });
});

describe('new blocks', () => {
  it('discrete transfer function 1/(z − 0.5)', () => {
    const m = new ModelBuilder('dtf', { stopTime: '4' });
    const c = m.add('Constant', 'c');
    const d = m.add('DiscreteTransferFcn', 'G', { num: '[1]', den: '[1 -0.5]', Ts: '1' });
    const s = m.add('Scope', 'scope');
    m.connect(c, 0, d, 0).connect(d, 0, s, 0);
    const log = simulate(m.model).logs[s];
    expect([0, 1, 2, 3].map((t) => valueAt(log, t))).toEqual([0, 1, 1.5, 1.75]);
  });

  it('transport delay shifts a ramp', () => {
    const m = new ModelBuilder('delay', { stopTime: '5' });
    const r = m.add('Ramp', 'ramp');
    const d = m.add('TransportDelay', 'delay', { delay: '1.5' });
    const s = m.add('Scope', 'scope');
    m.connect(r, 0, d, 0).connect(d, 0, s, 0);
    expect(last(simulate(m.model).logs[s])).toBeCloseTo(3.5, 6);
  });

  it('derivative of a ramp is its slope', () => {
    const m = new ModelBuilder('deriv', { stopTime: '3' });
    const r = m.add('Ramp', 'ramp', { slope: '2' });
    const d = m.add('Derivative', 'd');
    const s = m.add('Scope', 'scope');
    m.connect(r, 0, d, 0).connect(d, 0, s, 0);
    expect(last(simulate(m.model).logs[s])).toBeCloseTo(2, 9);
  });

  it('logic, comparison, min/max and dead zone', () => {
    const m = new ModelBuilder('logic', { stopTime: '1' });
    const a = m.add('Constant', 'a', { value: '2' });
    const b = m.add('Constant', 'b', { value: '-3' });
    const rel = m.add('RelationalOperator', 'rel', { op: '>' });
    const not = m.add('LogicalOperator', 'not', { op: 'NOT' });
    const mm = m.add('MinMax', 'mm', { fn: 'min' });
    const dz = m.add('DeadZone', 'dz', { start: '-1', end: '1' });
    const s = m.add('Scope', 'scope', { inputs: '4' });
    m.connect(a, 0, rel, 0).connect(b, 0, rel, 1).connect(rel, 0, not, 0)
      .connect(a, 0, mm, 0).connect(b, 0, mm, 1).connect(b, 0, dz, 0)
      .connect(rel, 0, s, 0).connect(not, 0, s, 1).connect(mm, 0, s, 2).connect(dz, 0, s, 3);
    const log = simulate(m.model).logs[s];
    expect([0, 1, 2, 3].map((ch) => last(log, ch))).toEqual([1, 0, -3, -2]);
  });

  it('random numbers repeat with the same seed', () => {
    const run = (seed: string) => {
      const m = new ModelBuilder('rnd', { stopTime: '1' });
      const r = m.add('RandomNumber', 'r', { seed, Ts: '0.1' });
      const s = m.add('Scope', 'scope');
      m.connect(r, 0, s, 0);
      return simulate(m.model).logs[s].y[0];
    };
    expect(run('5')).toEqual(run('5'));
    expect(run('5')).not.toEqual(run('6'));
  });
});
