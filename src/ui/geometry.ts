// Block sizes, port positions and link routing on the canvas (world coordinates).

import { BLOCKS } from '../sim/blocks';
import type { BlockModel, Model, PortRef } from '../sim/types';

export interface Pt {
  x: number;
  y: number;
}

const BASE_SIZE: Record<string, { w: number; h: number }> = {
  TransferFcn: { w: 96, h: 50 },
  PID: { w: 70, h: 44 },
  Display: { w: 96, h: 34 },
  DiscreteIntegrator: { w: 80, h: 44 },
  Sum: { w: 44, h: 44 },
  Product: { w: 44, h: 44 },
  Switch: { w: 56, h: 64 },
  MathFunction: { w: 64, h: 40 },
};

export function portCounts(b: BlockModel) {
  const def = BLOCKS[b.type];
  return def ? def.ports(b.params) : { inputs: 0, outputs: 0 };
}

export function blockSize(b: BlockModel) {
  const base = BASE_SIZE[b.type] ?? { w: 60, h: 44 };
  const { inputs, outputs } = portCounts(b);
  return { w: base.w, h: Math.max(base.h, 18 * Math.max(inputs, outputs) + 10) };
}

export function portPos(b: BlockModel, kind: 'in' | 'out', port: number): Pt {
  const { w, h } = blockSize(b);
  const { inputs, outputs } = portCounts(b);
  const n = kind === 'in' ? inputs : outputs;
  return { x: kind === 'in' ? b.x : b.x + w, y: b.y + (h * (port + 1)) / (n + 1) };
}

/** Orthogonal route from an output port to an input port. */
export function routeLink(a: Pt, b: Pt): Pt[] {
  if (b.x >= a.x + 20) {
    const mx = Math.round((a.x + b.x) / 2);
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  // Target is behind the source: go around below/above the midpoint.
  const out = a.x + 15, back = b.x - 15;
  const my = Math.abs(a.y - b.y) > 40 ? (a.y + b.y) / 2 : Math.max(a.y, b.y) + 40;
  return [a, { x: out, y: a.y }, { x: out, y: my }, { x: back, y: my }, { x: back, y: b.y }, b];
}

export function pointsToPath(pts: Pt[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

export function linkEnds(model: Model, src: PortRef, dst: PortRef): [Pt, Pt] | null {
  const sb = model.blocks.find((b) => b.id === src.block);
  const db = model.blocks.find((b) => b.id === dst.block);
  if (!sb || !db) return null;
  return [portPos(sb, 'out', src.port), portPos(db, 'in', dst.port)];
}

/** Nearest port of the given kind within `radius`, used to snap a wire while dragging. */
export function nearestPort(model: Model, p: Pt, kind: 'in' | 'out', radius: number): PortRef | null {
  let best: PortRef | null = null;
  let bestD = radius;
  for (const b of model.blocks) {
    const { inputs, outputs } = portCounts(b);
    const n = kind === 'in' ? inputs : outputs;
    for (let i = 0; i < n; i++) {
      const q = portPos(b, kind, i);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { block: b.id, port: i };
      }
    }
  }
  return best;
}
