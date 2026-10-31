// Block sizes, port positions and link routing on the canvas (world coordinates).

import { blockPorts } from '../sim/flatten';
import type { BlockModel, Diagram, PortRef } from '../sim/types';

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
  Subsystem: { w: 110, h: 60 },
  Inport: { w: 40, h: 24 },
  Outport: { w: 40, h: 24 },
  RelationalOperator: { w: 50, h: 44 },
  LogicalOperator: { w: 56, h: 44 },
  DiscreteTransferFcn: { w: 96, h: 50 },
  TransportDelay: { w: 70, h: 44 },
  Mux: { w: 8, h: 44 },
  Terminator: { w: 30, h: 30 },
  Unsupported: { w: 90, h: 44 },
  Demux: { w: 8, h: 44 },
  Fcn: { w: 100, h: 40 },
  OctaveFcn: { w: 110, h: 60 },
};

export function portCounts(b: BlockModel) {
  return blockPorts(b);
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
  const left = (kind === 'in') !== !!b.flip;
  return { x: left ? b.x : b.x + w, y: b.y + (h * (port + 1)) / (n + 1) };
}

/** +1 when the port points right (normal output, flipped input), else -1. */
export function portDir(b: BlockModel | undefined, kind: 'in' | 'out'): 1 | -1 {
  return (kind === 'out') !== !!b?.flip ? 1 : -1;
}

/**
 * Orthogonal route from an output port to an input port. `sa` is the direction the
 * output points (+1 right), `db` the direction a line travels when entering the input.
 */
export function routeLink(a: Pt, b: Pt, sa = 1, db = 1): Pt[] {
  if (sa === db) {
    if ((b.x - a.x) * sa >= 20) {
      const mx = Math.round((a.x + b.x) / 2);
      return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
    }
    // Target is behind the source: go around below/above the midpoint.
    const out = a.x + 15 * sa, back = b.x - 15 * db;
    const my = Math.abs(a.y - b.y) > 40 ? (a.y + b.y) / 2 : Math.max(a.y, b.y) + 40;
    return [a, { x: out, y: a.y }, { x: out, y: my }, { x: back, y: my }, { x: back, y: b.y }, b];
  }
  // Ports face opposite ways: wrap around the outer side of both.
  const x = sa === 1 ? Math.max(a.x, b.x) + 15 : Math.min(a.x, b.x) - 15;
  return [a, { x, y: a.y }, { x, y: b.y }, b];
}

/** Route of a link between two blocks, respecting flipped blocks. */
export function linkRoute(model: Diagram, src: PortRef, dst: PortRef): Pt[] | null {
  const ends = linkEnds(model, src, dst);
  if (!ends) return null;
  const sb = model.blocks.find((b) => b.id === src.block), tb = model.blocks.find((b) => b.id === dst.block);
  return routeLink(ends[0], ends[1], portDir(sb, 'out'), -portDir(tb, 'in'));
}

export function pointsToPath(pts: Pt[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}

export function linkEnds(model: Diagram, src: PortRef, dst: PortRef): [Pt, Pt] | null {
  const sb = model.blocks.find((b) => b.id === src.block);
  const db = model.blocks.find((b) => b.id === dst.block);
  if (!sb || !db) return null;
  return [portPos(sb, 'out', src.port), portPos(db, 'in', dst.port)];
}

/** Nearest port of the given kind within `radius`, used to snap a wire while dragging. */
export function nearestPort(model: Diagram, p: Pt, kind: 'in' | 'out', radius: number): PortRef | null {
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
