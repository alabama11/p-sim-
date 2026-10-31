// Model edits shared by the canvas, keyboard shortcuts and the library.
// Edits work on one Diagram (the top level or the inside of a subsystem).

import { BLOCKS } from '../sim/blocks';
import { blockPorts, portNumber } from '../sim/flatten';
import type { BlockModel, Diagram, LinkModel, Model } from '../sim/types';
import { newId } from './Canvas';
import { blockSize } from './geometry';

export function defaultParams(type: string): Record<string, string> {
  return Object.fromEntries((BLOCKS[type]?.params ?? []).map((p) => [p.name, p.default]));
}

/** "Gain", "Gain1", "Gain2", ... — the first name not used in the diagram. */
export function uniqueName(d: Diagram, base: string): string {
  const names = new Set(d.blocks.map((b) => b.name));
  const stem = base.replace(/\d+$/, '');
  if (!names.has(stem)) return stem;
  for (let i = 1; ; i++) if (!names.has(`${stem}${i}`)) return `${stem}${i}`;
}

function nextPortNumber(d: Diagram, type: string) {
  return Math.max(0, ...d.blocks.filter((b) => b.type === type).map(portNumber)) + 1;
}

/** Contents of a new Subsystem: one input wired straight to one output. */
function defaultSubsystem(): Diagram {
  const inId = newId('b'), outId = newId('b');
  return {
    blocks: [
      { id: inId, type: 'Inport', name: 'In1', x: 60, y: 100, params: { port: '1' } },
      { id: outId, type: 'Outport', name: 'Out1', x: 300, y: 100, params: { port: '1' } },
    ],
    links: [{ id: newId('l'), src: { block: inId, port: 0 }, dst: { block: outId, port: 0 } }],
  };
}

export function addBlock<D extends Diagram>(d: D, type: string, x: number, y: number): { diagram: D; id: string } {
  const def = BLOCKS[type];
  const id = newId('b');
  const block: BlockModel = { id, type, name: '', x, y, params: defaultParams(type) };
  if (type === 'Inport' || type === 'Outport') {
    const n = nextPortNumber(d, type);
    block.params.port = String(n);
    const name = `${type === 'Inport' ? 'In' : 'Out'}${n}`;
    block.name = d.blocks.some((b) => b.name === name) ? uniqueName(d, name) : name;
  } else {
    block.name = uniqueName(d, def.label.replace(/[^A-Za-z0-9]/g, ''));
  }
  if (type === 'Subsystem') block.children = defaultSubsystem();
  return { diagram: { ...d, blocks: [...d.blocks, block] }, id };
}

export function deleteSelection<D extends Diagram>(d: D, sel: Set<string>): D {
  return {
    ...d,
    blocks: d.blocks.filter((b) => !sel.has(b.id)),
    links: d.links.filter((l) => !sel.has(l.id) && !sel.has(l.src.block) && !sel.has(l.dst.block)),
  };
}

export interface Clip {
  blocks: BlockModel[];
  links: LinkModel[];
}

export function copySelection(d: Diagram, sel: Set<string>): Clip {
  const blocks = d.blocks.filter((b) => sel.has(b.id));
  const ids = new Set(blocks.map((b) => b.id));
  return { blocks, links: d.links.filter((l) => ids.has(l.src.block) && ids.has(l.dst.block)) };
}

export function paste<D extends Diagram>(d: D, clip: Clip, offset: number): { diagram: D; ids: string[] } {
  const map = new Map<string, string>();
  let cur: Diagram = d;
  const blocks = clip.blocks.map((b) => {
    const id = newId('b');
    map.set(b.id, id);
    const nb = { ...b, id, name: uniqueName(cur, b.name), x: b.x + offset, y: b.y + offset, params: { ...b.params } };
    cur = { ...cur, blocks: [...cur.blocks, nb] };
    return nb;
  });
  const links = clip.links.map((l) => ({
    id: newId('l'),
    src: { block: map.get(l.src.block)!, port: l.src.port },
    dst: { block: map.get(l.dst.block)!, port: l.dst.port },
  }));
  return { diagram: { ...d, blocks: [...d.blocks, ...blocks], links: [...d.links, ...links] }, ids: [...blocks.map((b) => b.id), ...links.map((l) => l.id)] };
}

/** Drops links whose ports no longer exist, at every level (e.g. after a Sum or a subsystem loses a port). */
export function pruneLinks<D extends Diagram>(d: D): D {
  let changed = false;
  const blocks = d.blocks.map((b) => {
    if (!b.children) return b;
    const children = pruneLinks(b.children);
    if (children === b.children) return b;
    changed = true;
    return { ...b, children };
  });
  const ports = new Map(blocks.map((b) => [b.id, blockPorts(b)]));
  const links = d.links.filter((l) => {
    const s = ports.get(l.src.block), t = ports.get(l.dst.block);
    return s && t && l.src.port < s.outputs && l.dst.port < t.inputs;
  });
  if (!changed && links.length === d.links.length) return d;
  return { ...d, blocks, links };
}

/** The diagram at `path` (ids of nested subsystems); stops at the deepest valid level. */
export function getDiagram(model: Model, path: string[]): Diagram {
  let d: Diagram = model;
  for (const id of path) {
    const b = d.blocks.find((x) => x.id === id);
    if (!b?.children) break;
    d = b.children;
  }
  return d;
}

/** Longest prefix of `path` that still exists in the model (e.g. after undo). */
export function validPath(model: Model, path: string[]): string[] {
  const out: string[] = [];
  let d: Diagram = model;
  for (const id of path) {
    const b = d.blocks.find((x) => x.id === id);
    if (!b?.children) break;
    out.push(id);
    d = b.children;
  }
  return out;
}

export function setDiagram(model: Model, path: string[], nd: Diagram): Model {
  const rec = (d: Diagram, i: number): Diagram => {
    if (i === path.length) return { ...d, blocks: nd.blocks, links: nd.links };
    return {
      ...d,
      blocks: d.blocks.map((b) => (b.id === path[i] && b.children ? { ...b, children: rec(b.children, i + 1) } : b)),
    };
  };
  return rec(model, 0) as Model;
}

/** Names along a path, for the breadcrumb. */
export function pathNames(model: Model, path: string[]): string[] {
  const names: string[] = [];
  let d: Diagram = model;
  for (const id of path) {
    const b = d.blocks.find((x) => x.id === id);
    if (!b?.children) break;
    names.push(b.name);
    d = b.children;
  }
  return names;
}

/** Finds a block by its flat path id ("s1/b3"). */
export function findByPath(model: Model, flatId: string): BlockModel | undefined {
  const ids = flatId.split('/');
  const d = getDiagram(model, ids.slice(0, -1));
  return d.blocks.find((b) => b.id === ids[ids.length - 1]);
}

/**
 * Moves the selected blocks into a new Subsystem. Signals crossing the boundary get
 * Inport/Outport blocks inside and are reconnected to the new block's ports outside.
 */
export function createSubsystem<D extends Diagram>(d: D, sel: Set<string>): { diagram: D; id: string } | null {
  const inner = d.blocks.filter((b) => sel.has(b.id) && b.type !== 'Inport' && b.type !== 'Outport');
  if (inner.length === 0) return null;
  const ids = new Set(inner.map((b) => b.id));
  const xs = inner.flatMap((b) => [b.x, b.x + blockSize(b).w]);
  const ys = inner.flatMap((b) => [b.y, b.y + blockSize(b).h]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);

  const internal = d.links.filter((l) => ids.has(l.src.block) && ids.has(l.dst.block));
  const incoming = d.links.filter((l) => !ids.has(l.src.block) && ids.has(l.dst.block));
  const outgoing = d.links.filter((l) => ids.has(l.src.block) && !ids.has(l.dst.block));
  const key = (r: { block: string; port: number }) => `${r.block}:${r.port}`;

  const childBlocks: BlockModel[] = [...inner];
  const childLinks: LinkModel[] = [...internal];
  const outerLinks: LinkModel[] = d.links.filter((l) => !ids.has(l.src.block) && !ids.has(l.dst.block));
  const subId = newId('b');

  // One Inport per distinct outside source.
  const inSources = [...new Map(incoming.map((l) => [key(l.src), l.src])).values()];
  inSources.forEach((src, i) => {
    const pid = newId('b');
    childBlocks.push({ id: pid, type: 'Inport', name: `In${i + 1}`, x: x1 - 100, y: y1 + i * 50, params: { port: String(i + 1) } });
    for (const l of incoming.filter((l) => key(l.src) === key(src))) childLinks.push({ id: newId('l'), src: { block: pid, port: 0 }, dst: l.dst });
    outerLinks.push({ id: newId('l'), src, dst: { block: subId, port: i } });
  });
  // One Outport per distinct inside source that feeds something outside.
  const outSources = [...new Map(outgoing.map((l) => [key(l.src), l.src])).values()];
  outSources.forEach((src, i) => {
    const pid = newId('b');
    childBlocks.push({ id: pid, type: 'Outport', name: `Out${i + 1}`, x: x2 + 60, y: y1 + i * 50, params: { port: String(i + 1) } });
    childLinks.push({ id: newId('l'), src, dst: { block: pid, port: 0 } });
    for (const l of outgoing.filter((l) => key(l.src) === key(src))) outerLinks.push({ id: newId('l'), src: { block: subId, port: i }, dst: l.dst });
  });

  const sub: BlockModel = {
    id: subId,
    type: 'Subsystem',
    name: uniqueName(d, 'Subsystem'),
    x: Math.round((x1 + x2) / 2 / 5) * 5 - 55,
    y: Math.round((y1 + y2) / 2 / 5) * 5 - 30,
    params: {},
    children: { blocks: childBlocks, links: childLinks },
  };
  return { diagram: { ...d, blocks: [...d.blocks.filter((b) => !ids.has(b.id)), sub], links: outerLinks }, id: subId };
}
