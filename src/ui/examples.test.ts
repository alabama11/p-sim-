import { describe, expect, it } from 'vitest';
import { simulate } from '../sim/engine';
import { EXAMPLES } from './examples';

describe('built-in examples', () => {
  it.each(EXAMPLES.map((e) => [e.title, e] as const))('%s simulates without warnings', (_, ex) => {
    const r = simulate(ex.make());
    expect(r.warnings).toEqual([]);
    expect(Object.keys(r.logs).length).toBeGreaterThan(0);
  });

  it('PID example settles at the reference', () => {
    const m = EXAMPLES[2].make();
    const r = simulate(m);
    const scope = m.blocks.find((b) => b.type === 'Scope')!;
    const y = r.logs[scope.id].y[0];
    expect(y[y.length - 1]).toBeCloseTo(1, 2);
  });

  it('vector example conserves energy', () => {
    const m = EXAMPLES.find((e) => e.title.startsWith('Vektorové'))!.make();
    const r = simulate(m);
    const scope = m.blocks.find((b) => b.name === 'Celková energia')!;
    const e = r.logs[scope.id].y[0];
    expect(e[0]).toBeCloseTo(7, 6); // 0.5·(1 + 4 + 9)
    expect(Math.max(...e) - Math.min(...e)).toBeLessThan(1e-3);
  });

  it('tank example follows the new level', () => {
    const m = EXAMPLES.find((e) => e.title.startsWith('Octave'))!.make();
    const r = simulate(m);
    const scope = m.blocks.find((b) => b.type === 'Scope')!;
    const h = r.logs[scope.id].y[0];
    expect(Math.abs(h[h.length - 1] - 2)).toBeLessThan(0.25);
  });
});
