// Block diagram canvas: draws blocks and signal lines, and handles moving, wiring,
// panning, zooming and selection.

import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as RPointerEvent } from 'react';
import type { Scope } from '../sim/expr';
import type { Diagram, PortRef } from '../sim/types';
import { Glyph } from './glyphs';
import { blockSize, linkRoute, nearestPort, pointsToPath, portCounts, portDir, portPos, routeLink, type Pt } from './geometry';

export interface View {
  x: number;
  y: number;
  k: number;
}

export const DRAG_MIME = 'application/x-psim-block';

type Drag =
  | { kind: 'move'; start: Pt; orig: Map<string, Pt>; moved: boolean }
  | { kind: 'pan'; client: Pt; orig: View; moved: boolean }
  | { kind: 'wire'; from: PortRef; fromKind: 'in' | 'out'; cur: Pt; checkpointed?: boolean }
  | { kind: 'box'; start: Pt; cur: Pt }
  | { kind: 'linkPress'; linkId: string; start: Pt };

interface Props {
  model: Diagram;
  view: View;
  setView(v: View): void;
  selection: Set<string>;
  setSelection(s: Set<string>): void;
  /** record = false while a gesture is in progress (no undo entry). */
  onChange(d: Diagram, record: boolean): void;
  onCheckpoint(): void;
  onOpenBlock(id: string): void;
  onDropBlock(type: string, at: Pt): void;
  errorBlock?: string;
  displays: Record<string, string>;
  /** Width of the signal on each link of this diagram after the last simulation (by link id). */
  linkWidths?: Record<string, number>;
  /** Workspace variables, so icons can show evaluated parameters. */
  scope: Scope;
}

const GRID = 5;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function Canvas(p: Props) {
  const { model, view } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const toWorld = (clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  // Wheel zoom around the cursor (needs a non-passive listener to prevent page scroll).
  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
      p.setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const capture = (e: RPointerEvent) => svgRef.current!.setPointerCapture(e.pointerId);

  const onBlockDown = (e: RPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e);
    let sel = p.selection;
    if (e.shiftKey) {
      sel = new Set(sel);
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      p.setSelection(sel);
    } else if (!sel.has(id)) {
      sel = new Set([id]);
      p.setSelection(sel);
    }
    const orig = new Map(model.blocks.filter((b) => sel.has(b.id)).map((b) => [b.id, { x: b.x, y: b.y }]));
    setDrag({ kind: 'move', start: toWorld(e.clientX, e.clientY), orig, moved: false });
  };

  const onPortDown = (e: RPointerEvent, ref: PortRef, kind: 'in' | 'out') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e);
    const cur = toWorld(e.clientX, e.clientY);
    if (kind === 'in') {
      // Dragging a connected input detaches its line so it can be re-routed.
      const existing = model.links.find((l) => l.dst.block === ref.block && l.dst.port === ref.port);
      if (existing) {
        p.onCheckpoint();
        p.onChange({ ...model, links: model.links.filter((l) => l !== existing) }, false);
        setDrag({ kind: 'wire', from: existing.src, fromKind: 'out', cur, checkpointed: true });
        return;
      }
    }
    setDrag({ kind: 'wire', from: ref, fromKind: kind, cur });
  };

  const onLinkDown = (e: RPointerEvent, linkId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capture(e);
    setDrag({ kind: 'linkPress', linkId, start: toWorld(e.clientX, e.clientY) });
  };

  const onBackgroundDown = (e: RPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    capture(e);
    if (e.shiftKey && e.button === 0) {
      const pt = toWorld(e.clientX, e.clientY);
      setDrag({ kind: 'box', start: pt, cur: pt });
    } else {
      setDrag({ kind: 'pan', client: { x: e.clientX, y: e.clientY }, orig: view, moved: false });
    }
  };

  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const pt = toWorld(e.clientX, e.clientY);
    switch (drag.kind) {
      case 'move': {
        const dx = snap(pt.x - drag.start.x), dy = snap(pt.y - drag.start.y);
        if (!drag.moved && dx === 0 && dy === 0) return;
        if (!drag.moved) {
          p.onCheckpoint();
          setDrag({ ...drag, moved: true });
        }
        p.onChange({
          ...model,
          blocks: model.blocks.map((b) => {
            const o = drag.orig.get(b.id);
            return o ? { ...b, x: o.x + dx, y: o.y + dy } : b;
          }),
        }, false);
        break;
      }
      case 'pan': {
        const dx = e.clientX - drag.client.x, dy = e.clientY - drag.client.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        p.setView({ ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy });
        break;
      }
      case 'wire':
      case 'box':
        setDrag({ ...drag, cur: pt });
        break;
      case 'linkPress': {
        if (Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) * view.k < 4) return;
        // Dragging from an existing line starts a branch from the same source.
        const link = model.links.find((l) => l.id === drag.linkId);
        if (link) setDrag({ kind: 'wire', from: link.src, fromKind: 'out', cur: pt });
        break;
      }
    }
  };

  const onUp = (e: RPointerEvent) => {
    if (!drag) return;
    const pt = toWorld(e.clientX, e.clientY);
    if (drag.kind === 'wire') {
      const targetKind = drag.fromKind === 'out' ? 'in' : 'out';
      const target = nearestPort(model, pt, targetKind, 14 / Math.min(1, view.k));
      if (target) {
        const src = drag.fromKind === 'out' ? drag.from : target;
        const dst = drag.fromKind === 'out' ? target : drag.from;
        if (!drag.checkpointed) p.onCheckpoint();
        p.onChange({
          ...model,
          links: [
            ...model.links.filter((l) => !(l.dst.block === dst.block && l.dst.port === dst.port)),
            { id: newId('l'), src, dst },
          ],
        }, false);
      }
    } else if (drag.kind === 'box') {
      const x1 = Math.min(drag.start.x, drag.cur.x), x2 = Math.max(drag.start.x, drag.cur.x);
      const y1 = Math.min(drag.start.y, drag.cur.y), y2 = Math.max(drag.start.y, drag.cur.y);
      const ids = model.blocks
        .filter((b) => {
          const { w, h } = blockSize(b);
          return b.x < x2 && b.x + w > x1 && b.y < y2 && b.y + h > y1;
        })
        .map((b) => b.id);
      const set = new Set(ids);
      for (const l of model.links) if (set.has(l.src.block) && set.has(l.dst.block)) ids.push(l.id);
      p.setSelection(new Set(ids));
    } else if (drag.kind === 'pan' && !drag.moved) {
      p.setSelection(new Set());
    } else if (drag.kind === 'linkPress') {
      p.setSelection(new Set(e.shiftKey ? [...p.selection, drag.linkId] : [drag.linkId]));
    }
    setDrag(null);
  };

  // Pointer capture retargets events to the <svg>, so find the block by position.
  const onDoubleClick = (e: MouseEvent) => {
    const pt = toWorld(e.clientX, e.clientY);
    const hit = [...model.blocks].reverse().find((b) => {
      const { w, h } = blockSize(b);
      return pt.x >= b.x && pt.x <= b.x + w && pt.y >= b.y && pt.y <= b.y + h;
    });
    if (hit) p.onOpenBlock(hit.id);
  };

  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DRAG_MIME);
    if (!type) return;
    e.preventDefault();
    p.onDropBlock(type, toWorld(e.clientX, e.clientY));
  };

  let preview: Pt[] | null = null;
  if (drag?.kind === 'wire') {
    const fb = model.blocks.find((b) => b.id === drag.from.block);
    if (fb) {
      const a = portPos(fb, drag.fromKind, drag.from.port);
      const dir = portDir(fb, drag.fromKind);
      preview = drag.fromKind === 'out' ? routeLink(a, drag.cur, dir, dir) : routeLink(drag.cur, a, -dir, -dir);
    }
  }

  const gridSize = 20 * view.k;

  return (
    <svg
      ref={svgRef}
      className="canvas"
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()}
      onDrop={onDrop}
      onDoubleClick={onDoubleClick}
    >
      <defs>
        <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse" x={view.x % gridSize} y={view.y % gridSize}>
          <circle cx={1} cy={1} r={1} className="grid-dot" />
        </pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
        </marker>
        <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="arrow-head selected" />
        </marker>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {model.links.map((l) => {
          const route = linkRoute(model, l.src, l.dst);
          if (!route) return null;
          const d = pointsToPath(route);
          const sel = p.selection.has(l.id);
          const width = p.linkWidths?.[l.id] ?? 1;
          const cls = ['link', sel && 'selected', width > 1 && 'vector'].filter(Boolean).join(' ');
          const a = route[0], dir = route[1] && route[1].x < a.x ? -1 : 1;
          return (
            <g key={l.id} onPointerDown={(e) => onLinkDown(e, l.id)} className="link-group">
              <path d={d} className="link-hit" />
              <path d={d} className={cls} markerEnd={sel ? 'url(#arrow-sel)' : 'url(#arrow)'} />
              {width > 1 && (
                <text x={a.x + 6 * dir} y={a.y - 5} textAnchor={dir > 0 ? 'start' : 'end'} className="link-width">{width}</text>
              )}
            </g>
          );
        })}

        {model.blocks.map((b) => {
          const { w, h } = blockSize(b);
          const { inputs, outputs } = portCounts(b);
          const sel = p.selection.has(b.id);
          const cls = ['block', sel && 'selected', p.errorBlock === b.id && 'error'].filter(Boolean).join(' ');
          return (
            <g key={b.id} transform={`translate(${b.x},${b.y})`}>
              <g
                className={cls}
                onPointerDown={(e) => onBlockDown(e, b.id)}
              >
                {b.type === 'Gain' ? (
                  <path d={b.flip ? `M${w},0 L0,${h / 2} L${w},${h} Z` : `M0,0 L${w},${h / 2} L0,${h} Z`} className="block-body" />
                ) : (
                  <rect width={w} height={h} rx={b.type === 'Mux' || b.type === 'Demux' ? 1 : 4} className={b.type === 'Mux' || b.type === 'Demux' ? 'block-body bar' : 'block-body'} />
                )}
                <Glyph b={b} w={w} h={h} display={p.displays[b.id]} scope={p.scope} />
              </g>
              <text x={w / 2} y={h + 13} textAnchor="middle" className="block-name">{b.name}</text>
              {Array.from({ length: inputs }, (_, i) => {
                const y = (h * (i + 1)) / (inputs + 1);
                const x = b.flip ? w : 0, s = b.flip ? -1 : 1;
                return (
                  <g key={`i${i}`} className="port" onPointerDown={(e) => onPortDown(e, { block: b.id, port: i }, 'in')}>
                    <circle cx={x} cy={y} r={8} className="port-hit" />
                    <path d={`M${x - 6 * s},${y - 4} L${x - s},${y} L${x - 6 * s},${y + 4}`} className="port-mark" />
                  </g>
                );
              })}
              {Array.from({ length: outputs }, (_, i) => {
                const y = (h * (i + 1)) / (outputs + 1);
                const x = b.flip ? 0 : w, s = b.flip ? -1 : 1;
                return (
                  <g key={`o${i}`} className="port" onPointerDown={(e) => onPortDown(e, { block: b.id, port: i }, 'out')}>
                    <circle cx={x} cy={y} r={8} className="port-hit" />
                    <path d={`M${x + s},${y - 4} L${x + 6 * s},${y} L${x + s},${y + 4}`} className="port-mark" />
                  </g>
                );
              })}
            </g>
          );
        })}

        {preview && <path d={pointsToPath(preview)} className="link preview" />}
        {drag?.kind === 'box' && (
          <rect
            x={Math.min(drag.start.x, drag.cur.x)}
            y={Math.min(drag.start.y, drag.cur.y)}
            width={Math.abs(drag.cur.x - drag.start.x)}
            height={Math.abs(drag.cur.y - drag.start.y)}
            className="select-box"
          />
        )}
      </g>
    </svg>
  );
}

let idCounter = 0;
export function newId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}
