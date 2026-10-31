import { describe, expect, it } from 'vitest';
import { ModelBuilder } from './build';
import { simulate } from './engine';
import { compileScript, evaluate, ExprError, runWorkspace } from './expr';

const lastAll = (log: { y: number[][] }) => log.y.map((ch) => ch[ch.length - 1]);

describe('Octave syntax', () => {
  it('supports ranges, indexing, comparisons and logic', () => {
    expect(evaluate('1:4')).toEqual([1, 2, 3, 4]);
    expect(evaluate('0:0.5:1')).toEqual([0, 0.5, 1]);
    expect(evaluate('[1:3 10]')).toEqual([1, 2, 3, 10]);
    const sc = { v: [10, 20, 30] };
    expect(evaluate('v(2)', sc)).toEqual([20]);
    expect(evaluate('v([3 1])', sc)).toEqual([30, 10]);
    expect(evaluate('v > 15', sc)).toEqual([0, 1, 1]);
    expect(evaluate('1 < 2 && ~(3 == 4)')).toEqual([1]);
    expect(evaluate('mod(-1, 3) + rem(7, 4)')).toEqual([5]);
    expect(evaluate('1./[1 2]')).toEqual([1, 0.5]);
    expect(() => evaluate('v(4)', sc)).toThrow(/prekračuje/);
  });

  it('runs scripts with if, for and while', () => {
    const ws = runWorkspace(`
      s = 0;
      for k = 1:10
        if mod(k, 2) == 0, continue, end
        s = s + k;   % odd numbers only
      end
      n = 0;
      while true
        n = n + 1;
        if n >= 5
          break
        end
      end
      v(3) = 7;
      if s > 100
        c = 1;
      elseif s == 25
        c = 2;
      else
        c = 3;
      end`);
    expect(ws.s).toEqual([25]);
    expect(ws.n).toEqual([5]);
    expect(ws.v).toEqual([0, 0, 7]);
    expect(ws.c).toEqual([2]);
  });

  it('reports script errors', () => {
    expect(() => compileScript('if 1\n x = 2')).toThrow(/end/);
    expect(() => compileScript('x = (1')).toThrow(ExprError);
  });
});

describe('vector signals', () => {
  it('runs element-wise blocks once per element', () => {
    const m = new ModelBuilder('vec', { stopTime: '2', solver: 'ode45' });
    const c = m.add('Constant', 'c', { value: '[1 2 3]' });
    const g = m.add('Gain', 'g', { K: '[1 10 100]' });
    const i = m.add('Integrator', 'i', { x0: '0' });
    const s = m.add('Scope', 's');
    m.connect(c, 0, g, 0).connect(g, 0, i, 0).connect(i, 0, s, 0);
    const r = simulate(m.model);
    const log = r.logs[s];
    expect(log.labels).toEqual(['u1(1)', 'u1(2)', 'u1(3)']);
    lastAll(log).forEach((v, k) => expect(v).toBeCloseTo([2, 40, 600][k], 9));
    expect(r.widths[`${i}:0`]).toBe(3);
  });

  it('muxes, demuxes and expands scalars', () => {
    const m = new ModelBuilder('mux', { stopTime: '1' });
    const a = m.add('Constant', 'a', { value: '1' });
    const b = m.add('Constant', 'b', { value: '[2 3]' });
    const mux = m.add('Mux', 'mux', { inputs: '2' });
    const sum = m.add('Sum', 'sum', { signs: '++' });
    const k = m.add('Constant', 'k', { value: '10' });
    const dmx = m.add('Demux', 'dmx', { outputs: '2' });
    const tot = m.add('Sum', 'tot', { signs: '+' });
    const s1 = m.add('Scope', 's1', { inputs: '2' });
    const s2 = m.add('Display', 's2');
    m.connect(a, 0, mux, 0).connect(b, 0, mux, 1)
      .connect(mux, 0, sum, 0).connect(k, 0, sum, 1) // [11 12 13]
      .connect(sum, 0, dmx, 0)
      .connect(dmx, 0, s1, 0).connect(dmx, 1, s1, 1)
      .connect(sum, 0, tot, 0).connect(tot, 0, s2, 0);
    const r = simulate(m.model);
    expect(r.widths[`${dmx}:0`]).toBe(2);
    expect(r.widths[`${dmx}:1`]).toBe(1);
    expect(lastAll(r.logs[s1])).toEqual([11, 12, 13]);
    expect(lastAll(r.logs[s2])).toEqual([36]);
  });

  it('infers widths through feedback loops', () => {
    // x' = -x with x0 = [1 2]: the loop gets its width from the initial condition.
    const m = new ModelBuilder('loop', { stopTime: '1', relTol: '1e-8', absTol: '1e-10' });
    const i = m.add('Integrator', 'i', { x0: '[1 2]' });
    const g = m.add('Gain', 'g', { K: '-1' });
    const s = m.add('Scope', 's');
    m.connect(i, 0, g, 0).connect(g, 0, i, 0).connect(i, 0, s, 0);
    lastAll(simulate(m.model).logs[s]).forEach((v, k) => expect(v).toBeCloseTo((k + 1) * Math.exp(-1), 7));
  });

  it('rejects mismatched widths', () => {
    const m = new ModelBuilder('bad');
    const a = m.add('Constant', 'a', { value: '[1 2]' });
    const b = m.add('Constant', 'b', { value: '[1 2 3]' });
    const s = m.add('Sum', 'sum');
    const d = m.add('Display', 'd');
    m.connect(a, 0, s, 0).connect(b, 0, s, 1).connect(s, 0, d, 0);
    expect(() => simulate(m.model)).toThrow(/šírku/);
  });
});

describe('user functions', () => {
  it('evaluates Fcn expressions on vector inputs', () => {
    const m = new ModelBuilder('fcn', { stopTime: '1' }, 'k = 3');
    const c = m.add('Constant', 'c', { value: '[3 4]' });
    const f = m.add('Fcn', 'f', { expr: 'sqrt(u(1)^2 + u(2)^2) * k + t' });
    const d = m.add('Display', 'd');
    m.connect(c, 0, f, 0).connect(f, 0, d, 0);
    const r = simulate(m.model);
    expect(lastAll(r.logs[d])[0]).toBeCloseTo(16, 12);
  });

  it('runs Octave Function blocks with several inputs and outputs', () => {
    const m = new ModelBuilder('octave', { stopTime: '1' });
    const a = m.add('Constant', 'a', { value: '[1 -2 3]' });
    const b = m.add('Constant', 'b', { value: '2' });
    const code = 'y1 = 0;\nfor k = 1:length(u1)\n  if u1(k) > 0, y1 = y1 + u1(k)*u2; end\nend\ny2 = [max(u1) min(u1)];';
    const f = m.add('OctaveFcn', 'f', { code, inputs: '2', outputs: '2' });
    const d1 = m.add('Display', 'd1');
    const d2 = m.add('Display', 'd2');
    m.connect(a, 0, f, 0).connect(b, 0, f, 1).connect(f, 0, d1, 0).connect(f, 1, d2, 0);
    const r = simulate(m.model);
    expect(lastAll(r.logs[d1])).toEqual([8]);
    expect(lastAll(r.logs[d2])).toEqual([3, -2]);
    expect(r.widths[`${f}:1`]).toBe(2);
  });

  it('uses an Octave Function as a controller in a loop', () => {
    // Bang-bang control of an integrator around 1.
    const m = new ModelBuilder('bang', { stopTime: '5', solver: 'ode1', fixedStep: '0.01' });
    const ref = m.add('Constant', 'ref', { value: '1' });
    const sum = m.add('Sum', 'e', { signs: '+-' });
    const f = m.add('OctaveFcn', 'ctl', { code: 'if u > 0\n  y = 1;\nelse\n  y = -1;\nend' });
    const i = m.add('Integrator', 'x');
    const s = m.add('Scope', 's');
    m.connect(ref, 0, sum, 0).connect(i, 0, sum, 1).connect(sum, 0, f, 0).connect(f, 0, i, 0).connect(i, 0, s, 0);
    const y = simulate(m.model).logs[s].y[0];
    expect(Math.abs(y[y.length - 1] - 1)).toBeLessThan(0.02);
  });
});
