// Icons drawn inside each block, in the block's local coordinates (0,0)–(w,h).

import type { ReactNode } from 'react';
import { evaluate, type Scope } from '../sim/expr';
import type { BlockModel } from '../sim/types';
import { subsystemPorts } from '../sim/flatten';
import { portCounts } from './geometry';

function short(s: string | undefined, max = 10) {
  const v = (s ?? '').trim();
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}

/** "[1 2 1]" → "s² + 2s + 1"; falls back to the raw text when it uses variables. */
export function formatPoly(raw: string | undefined, scope: Scope = {}, sym = 's'): string {
  let c: number[];
  try {
    c = evaluate(raw ?? '', scope);
  } catch {
    return short(raw, 14);
  }
  const sup = ['', '', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  const n = c.length - 1;
  const terms: string[] = [];
  c.forEach((v, i) => {
    if (v === 0) return;
    const p = n - i;
    const mag = Math.abs(v);
    const coef = mag === 1 && p > 0 ? '' : String(+mag.toPrecision(4));
    const pow = p === 0 ? '' : p === 1 ? sym : sym + (sup[p] ?? `^${p}`);
    terms.push((v < 0 ? '− ' : terms.length ? '+ ' : '') + coef + pow);
  });
  return terms.length ? terms.join(' ') : '0';
}

function Txt({ x, y, children, size = 13, anchor = 'middle' }: { x: number; y: number; children: ReactNode; size?: number; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <text x={x} y={y} fontSize={size} textAnchor={anchor} dominantBaseline="central" className="glyph-text">
      {children}
    </text>
  );
}

function Path({ d }: { d: string }) {
  return <path d={d} className="glyph-line" fill="none" />;
}

export function Glyph({ b, w, h, display, scope }: { b: BlockModel; w: number; h: number; display?: string; scope?: Scope }) {
  const cx = w / 2, cy = h / 2;
  const p = b.params;
  // Plot area for small waveform icons
  const L = 10, R = w - 10, T = 10, B = h - 10;
  switch (b.type) {
    case 'Constant':
      return <Txt x={cx} y={cy}>{short(p.value ?? '1', 8)}</Txt>;
    case 'Step':
      return <Path d={`M${L},${B} H${cx} V${T} H${R}`} />;
    case 'Ramp':
      return <Path d={`M${L},${B} H${L + 8} L${R},${T}`} />;
    case 'SineWave': {
      const pts = Array.from({ length: 33 }, (_, i) => {
        const x = L + ((R - L) * i) / 32;
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${(cy - ((B - T) / 2) * Math.sin((2 * Math.PI * i) / 32)).toFixed(1)}`;
      });
      return <Path d={pts.join(' ')} />;
    }
    case 'PulseGenerator': {
      const q = (R - L) / 4;
      return <Path d={`M${L},${B} V${T} H${L + q} V${B} H${L + 2 * q} V${T} H${L + 3 * q} V${B} H${R}`} />;
    }
    case 'Clock':
      return (
        <g className="glyph-line" fill="none">
          <circle cx={cx} cy={cy} r={Math.min(w, h) / 2 - 8} />
          <path d={`M${cx},${cy} V${cy - 9} M${cx},${cy} H${cx + 7}`} />
        </g>
      );
    case 'Gain':
      return <Txt x={b.flip ? w * 0.64 : w * 0.36} y={cy}>{short(p.K ?? '1', 6)}</Txt>;
    case 'Sum':
    case 'Product': {
      const { inputs } = portCounts(b);
      const chars = [...((b.type === 'Sum' ? p.signs : p.ops) ?? '')].filter((c) => '+-*/'.includes(c));
      const sym = (c: string) => ({ '+': '+', '-': '−', '*': '×', '/': '÷' })[c] ?? c;
      return (
        <g>
          <Txt x={b.flip ? cx - 5 : cx + 5} y={cy} size={16}>{b.type === 'Sum' ? 'Σ' : 'Π'}</Txt>
          {chars.slice(0, inputs).map((c, i) => (
            <Txt key={i} x={b.flip ? w - 8 : 8} y={(h * (i + 1)) / (inputs + 1)} size={11}>{sym(c)}</Txt>
          ))}
        </g>
      );
    }
    case 'MathFunction':
      return <Txt x={cx} y={cy} size={12}>{(p.fn ?? 'sin') === 'square' ? 'u²' : `${p.fn ?? 'sin'}(u)`}</Txt>;
    case 'Integrator':
      return <Fraction cx={cx} cy={cy} num="1" den="s" />;
    case 'TransferFcn':
      return <Fraction cx={cx} cy={cy} num={formatPoly(p.num ?? '[1]', scope)} den={formatPoly(p.den ?? '[1 1]', scope)} size={11} />;
    case 'PID':
      return <Txt x={cx} y={cy}>PID</Txt>;
    case 'UnitDelay':
      return <Fraction cx={cx} cy={cy} num="1" den="z" />;
    case 'DiscreteIntegrator':
      return <Fraction cx={cx} cy={cy} num="K·Ts" den="z − 1" size={11} />;
    case 'ZeroOrderHold': {
      const q = (R - L) / 4;
      return <Path d={`M${L},${B} H${L + q} V${cy + 4} H${L + 2 * q} V${T + 4} H${L + 3 * q} V${cy} H${R}`} />;
    }
    case 'Saturation':
      return (
        <g>
          <path d={`M${L},${cy} H${R} M${cx},${T} V${B}`} className="glyph-axis" />
          <Path d={`M${L},${B - 4} H${cx - 8} L${cx + 8},${T + 4} H${R}`} />
        </g>
      );
    case 'Relay':
      return (
        <g>
          <path d={`M${L},${cy} H${R} M${cx},${T} V${B}`} className="glyph-axis" />
          <Path d={`M${L},${B - 4} H${cx + 6} V${T + 4} H${R} M${cx - 6},${T + 4} V${B - 4}`} />
        </g>
      );
    case 'Switch': {
      const y1 = h / 4, y3 = (3 * h) / 4;
      return (
        <g>
          <Path d={`M8,${y1} H${cx - 6} L${w - 14},${cy} H${w - 4} M8,${y3} H${cx - 6}`} />
          <circle cx={cx - 6} cy={y3} r={2} className="glyph-dot" />
          <Txt x={14} y={cy} size={9} anchor="start">u2</Txt>
        </g>
      );
    }
    case 'Scope':
      return (
        <g>
          <rect x={8} y={8} width={w - 16} height={h - 16} rx={3} className="glyph-screen" />
          <Path d={`M12,${cy + 4} Q${cx - 6},${T - 4} ${cx},${cy} T${w - 12},${cy - 4}`} />
        </g>
      );
    case 'Subsystem': {
      if (b.mask) return <Txt x={cx} y={cy} size={12}>{short(b.mask.title || b.name, 16)}</Txt>;
      const { inports, outports } = subsystemPorts(b);
      return (
        <g>
          {inports.map((p, i) => (
            <Txt key={`i${i}`} x={b.flip ? w - 6 : 6} y={(h * (i + 1)) / (inports.length + 1)} size={9} anchor={b.flip ? 'end' : 'start'}>{short(p.name, 9)}</Txt>
          ))}
          {outports.map((p, i) => (
            <Txt key={`o${i}`} x={b.flip ? 6 : w - 6} y={(h * (i + 1)) / (outports.length + 1)} size={9} anchor={b.flip ? 'start' : 'end'}>{short(p.name, 9)}</Txt>
          ))}
          {inports.length + outports.length === 0 && <Txt x={cx} y={cy} size={11}>Subsystem</Txt>}
        </g>
      );
    }
    case 'Inport':
    case 'Outport':
      return <Txt x={cx} y={cy} size={12}>{p.port ?? '1'}</Txt>;
    case 'DeadZone':
      return (
        <g>
          <path d={`M${L},${cy} H${R} M${cx},${T} V${B}`} className="glyph-axis" />
          <Path d={`M${L},${B} L${cx - 8},${cy} H${cx + 8} L${R},${T}`} />
        </g>
      );
    case 'RelationalOperator':
      return <Txt x={cx} y={cy} size={14}>{(p.op ?? '<=').replace('<=', '≤').replace('>=', '≥').replace('~=', '≠')}</Txt>;
    case 'LogicalOperator':
      return <Txt x={cx} y={cy} size={11}>{p.op ?? 'AND'}</Txt>;
    case 'MinMax':
      return <Txt x={cx} y={cy} size={12}>{p.fn ?? 'min'}</Txt>;
    case 'Derivative':
      return <Fraction cx={cx} cy={cy} num="du" den="dt" size={12} />;
    case 'TransportDelay':
      return <Txt x={cx} y={cy} size={12}>{`e^(−${short(p.delay ?? '1', 4)}s)`}</Txt>;
    case 'DiscreteTransferFcn':
      return <Fraction cx={cx} cy={cy} num={formatPoly(p.num ?? '[1]', scope, 'z')} den={formatPoly(p.den ?? '[1 -0.5]', scope, 'z')} size={11} />;
    case 'RandomNumber': {
      const ys = [0.6, 0.2, 0.8, 0.4, 0.7, 0.3, 0.5];
      return <Path d={ys.map((v, i) => `${i ? 'L' : 'M'}${L + ((R - L) * i) / 6},${T + (B - T) * v}`).join(' ')} />;
    }
    case 'Display':
      return <Txt x={cx} y={cy} size={display && display.length > 12 ? 10 : 13}>{display ?? '—'}</Txt>;
    case 'Terminator':
      return <Path d={`M${L},${cy} H${cx} M${cx},${T + 2} V${B - 2}`} />;
    case 'Unsupported':
      return (
        <g>
          <Txt x={cx} y={cy - 7} size={14}>?</Txt>
          <Txt x={cx} y={cy + 9} size={9}>{short(p.kind ?? '', 14)}</Txt>
        </g>
      );
    case 'Mux':
    case 'Demux':
      return null; // drawn as a solid bar by the canvas
    case 'Fcn':
      return <Txt x={cx} y={cy} size={11}>{short(p.expr ?? 'u^2', 16)}</Txt>;
    case 'OctaveFcn': {
      const first = (p.code ?? '').split('\n').map((l) => l.replace(/[%#].*$/, '').trim()).find(Boolean) ?? '';
      return (
        <g>
          <Txt x={cx} y={cy - 8} size={13}>fcn</Txt>
          <text x={cx} y={cy + 12} textAnchor="middle" dominantBaseline="middle" className="glyph-code">{short(first, 18)}</text>
        </g>
      );
    }
    default:
      return <Txt x={cx} y={cy} size={10}>{b.type}</Txt>;
  }
}

function Fraction({ cx, cy, num, den, size = 13 }: { cx: number; cy: number; num: string; den: string; size?: number }) {
  const half = Math.max(num.length, den.length) * size * 0.3 + 4;
  return (
    <g>
      <Txt x={cx} y={cy - size * 0.7} size={size}>{num}</Txt>
      <path d={`M${cx - half},${cy} H${cx + half}`} className="glyph-line" />
      <Txt x={cx} y={cy + size * 0.75} size={size}>{den}</Txt>
    </g>
  );
}
