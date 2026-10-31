import { describe, expect, it } from 'vitest';
import { evaluate, ExprError, runWorkspace } from './expr';

describe('expressions', () => {
  it('evaluates arithmetic with precedence', () => {
    expect(evaluate('1 + 2*3^2')).toEqual([19]);
    expect(evaluate('-2^2')).toEqual([-4]);
    expect(evaluate('2*pi')[0]).toBeCloseTo(2 * Math.PI);
    expect(evaluate('sqrt(16) + abs(-1)')).toEqual([5]);
  });

  it('parses vectors like Octave', () => {
    expect(evaluate('[1 2 3]')).toEqual([1, 2, 3]);
    expect(evaluate('[1, -2]')).toEqual([1, -2]);
    expect(evaluate('[1 -2]')).toEqual([1, -2]);
    expect(evaluate('[1 - 2]')).toEqual([-1]);
    expect(evaluate('[1-2 3]')).toEqual([-1, 3]);
    expect(evaluate('[sin(0) -1]')).toEqual([0, -1]);
    expect(evaluate('2*[1 2]')).toEqual([2, 4]);
    expect(evaluate('[1 2].*[3 4]')).toEqual([3, 8]);
  });

  it('runs workspace assignments in order', () => {
    const ws = runWorkspace('m = 2; k = 8 % tuhost\nw = sqrt(k/m)');
    expect(ws.w).toEqual([2]);
    expect(evaluate('[1 2*w]', ws)).toEqual([1, 4]);
  });

  it('reports errors', () => {
    expect(() => evaluate('1 +')).toThrow(ExprError);
    expect(() => evaluate('foo')).toThrow(/foo/);
    expect(() => evaluate('[1 2]*[3 4]')).toThrow(ExprError);
    expect(() => runWorkspace('3 = x')).toThrow(ExprError);
  });
});
