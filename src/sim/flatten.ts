// Expands subsystems into one flat list of blocks and links before compilation.
// Inport/Outport blocks stay as pass-through blocks; masked subsystems add their
// parameter values as variables visible to the blocks inside.

import { BLOCKS } from './blocks';
import { evaluate, type Scope } from './expr';
import type { BlockModel, Diagram, Model, PortRef } from './types';

export interface FlatBlock {
  /** Path id, e.g. "s1/b3" for block b3 inside subsystem s1. */
  id: string;
  /** Path name for messages, e.g. "Regulátor/Gain". */
  name: string;
  block: BlockModel;
  scope: Scope;
  inputs: number;
  outputs: number;
}

export interface FlatLink {
  src: PortRef;
  dst: PortRef;
}

export class FlattenError extends Error {
  constructor(message: string, public blockId?: string) {
    super(message);
  }
}

export function portNumber(b: BlockModel): number {
  const n = parseInt(b.params.port ?? '1', 10);
  return isNaN(n) ? 1 : n;
}

/** Inport/Outport blocks of a subsystem, ordered by port number. */
export function subsystemPorts(b: BlockModel) {
  const kids = b.children?.blocks ?? [];
  const byNum = (x: BlockModel, y: BlockModel) => portNumber(x) - portNumber(y);
  return {
    inports: kids.filter((k) => k.type === 'Inport').sort(byNum),
    outports: kids.filter((k) => k.type === 'Outport').sort(byNum),
  };
}

/** Port counts as shown in the editor. */
export function blockPorts(b: BlockModel): { inputs: number; outputs: number } {
  if (b.type === 'Subsystem') {
    const { inports, outports } = subsystemPorts(b);
    return { inputs: inports.length, outputs: outports.length };
  }
  return BLOCKS[b.type]?.ports(b.params) ?? { inputs: 0, outputs: 0 };
}

/** Variables a masked subsystem defines for its contents, evaluated in the parent's scope. */
export function maskScope(b: BlockModel, parent: Scope, pathName: string): Scope {
  if (!b.mask?.params.length) return parent;
  const scope = { ...parent };
  for (const mp of b.mask.params) {
    const raw = b.params[mp.name] ?? mp.default;
    try {
      scope[mp.name] = evaluate(raw, parent);
    } catch (e) {
      throw new FlattenError(`Blok „${pathName}“, parameter „${mp.label || mp.name}“: ${(e as Error).message}`, undefined);
    }
  }
  return scope;
}

/** Scope seen by blocks in the diagram at `path` (ids of nested subsystems). */
export function scopeAt(model: Model, path: string[], root: Scope): Scope {
  let scope = root;
  let diagram: Diagram = model;
  for (const id of path) {
    const b = diagram.blocks.find((x) => x.id === id);
    if (!b?.children) break;
    scope = maskScope(b, scope, b.name);
    diagram = b.children;
  }
  return scope;
}

export function flatten(model: Model, root: Scope): { blocks: FlatBlock[]; links: FlatLink[] } {
  const blocks: FlatBlock[] = [];
  const links: FlatLink[] = [];

  const walk = (d: Diagram, prefix: string, namePrefix: string, scope: Scope) => {
    const byId = new Map(d.blocks.map((b) => [b.id, b]));
    for (const b of d.blocks) {
      const id = prefix + b.id;
      const name = namePrefix + b.name;
      if (b.type === 'Subsystem') {
        let inner: Scope;
        try {
          inner = maskScope(b, scope, name);
        } catch (e) {
          throw new FlattenError((e as Error).message, id);
        }
        walk(b.children ?? { blocks: [], links: [] }, id + '/', name + '/', inner);
        continue;
      }
      const isPort = b.type === 'Inport' || b.type === 'Outport';
      const { inputs, outputs } = isPort ? { inputs: 1, outputs: 1 } : blockPorts(b);
      blocks.push({ id, name, block: b, scope, inputs, outputs });
    }

    // A link touching a subsystem connects to the matching Inport/Outport inside it.
    const resolve = (ref: PortRef, side: 'src' | 'dst'): PortRef | null => {
      const b = byId.get(ref.block);
      if (!b) return null;
      if (b.type !== 'Subsystem') return { block: prefix + b.id, port: ref.port };
      const { inports, outports } = subsystemPorts(b);
      const port = (side === 'src' ? outports : inports)[ref.port];
      return port ? { block: `${prefix}${b.id}/${port.id}`, port: 0 } : null;
    };
    for (const l of d.links) {
      const src = resolve(l.src, 'src'), dst = resolve(l.dst, 'dst');
      if (src && dst) links.push({ src, dst });
    }
  };

  walk(model, '', '', root);
  return { blocks, links };
}
