// Model edits shared by the canvas, keyboard shortcuts and the library.

import { BLOCKS } from '../sim/blocks';
import type { BlockModel, Model } from '../sim/types';
import { newId } from './Canvas';

export function defaultParams(type: string): Record<string, string> {
  return Object.fromEntries((BLOCKS[type]?.params ?? []).map((p) => [p.name, p.default]));
}

/** "Gain", "Gain1", "Gain2", ... — the first name not used in the model. */
export function uniqueName(model: Model, base: string): string {
  const names = new Set(model.blocks.map((b) => b.name));
  const stem = base.replace(/\d+$/, '');
  if (!names.has(stem)) return stem;
  for (let i = 1; ; i++) if (!names.has(`${stem}${i}`)) return `${stem}${i}`;
}

export function addBlock(model: Model, type: string, x: number, y: number): { model: Model; id: string } {
  const def = BLOCKS[type];
  const id = newId('b');
  const block: BlockModel = { id, type, name: uniqueName(model, def.label.replace(/[^A-Za-z0-9]/g, '')), x, y, params: defaultParams(type) };
  return { model: { ...model, blocks: [...model.blocks, block] }, id };
}

export function deleteSelection(model: Model, sel: Set<string>): Model {
  return {
    ...model,
    blocks: model.blocks.filter((b) => !sel.has(b.id)),
    links: model.links.filter((l) => !sel.has(l.id) && !sel.has(l.src.block) && !sel.has(l.dst.block)),
  };
}

export interface Clip {
  blocks: BlockModel[];
  links: Model['links'];
}

export function copySelection(model: Model, sel: Set<string>): Clip {
  const blocks = model.blocks.filter((b) => sel.has(b.id));
  const ids = new Set(blocks.map((b) => b.id));
  return { blocks, links: model.links.filter((l) => ids.has(l.src.block) && ids.has(l.dst.block)) };
}

export function paste(model: Model, clip: Clip, offset: number): { model: Model; ids: string[] } {
  const map = new Map<string, string>();
  let m = model;
  const blocks = clip.blocks.map((b) => {
    const id = newId('b');
    map.set(b.id, id);
    const nb = { ...b, id, name: uniqueName(m, b.name), x: b.x + offset, y: b.y + offset, params: { ...b.params } };
    m = { ...m, blocks: [...m.blocks, nb] };
    return nb;
  });
  const links = clip.links.map((l) => ({
    id: newId('l'),
    src: { block: map.get(l.src.block)!, port: l.src.port },
    dst: { block: map.get(l.dst.block)!, port: l.dst.port },
  }));
  return { model: { ...m, links: [...m.links, ...links] }, ids: [...blocks.map((b) => b.id), ...links.map((l) => l.id)] };
}

/** Drops links whose ports no longer exist (e.g. after a Sum loses an input). */
export function pruneLinks(model: Model): Model {
  const ports = new Map(model.blocks.map((b) => [b.id, BLOCKS[b.type]?.ports(b.params) ?? { inputs: 0, outputs: 0 }]));
  const links = model.links.filter((l) => {
    const s = ports.get(l.src.block), d = ports.get(l.dst.block);
    return s && d && l.src.port < s.outputs && l.dst.port < d.inputs;
  });
  return links.length === model.links.length ? model : { ...model, links };
}
