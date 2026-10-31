// Small helper to assemble models in code (tests and built-in examples).

import { emptyModel, type Model, type SimSettings } from './types';

export class ModelBuilder {
  readonly model: Model;
  private n = 0;

  constructor(name: string, settings: Partial<SimSettings> = {}, workspace = '') {
    this.model = emptyModel(name);
    Object.assign(this.model.settings, settings);
    this.model.workspace = workspace;
  }

  add(type: string, name: string, params: Record<string, string> = {}, x = 0, y = 0): string {
    const id = `b${++this.n}`;
    this.model.blocks.push({ id, type, name, x, y, params });
    return id;
  }

  /** Mirrors a block so its input is on the right (feedback paths). */
  flip(id: string): this {
    this.model.blocks.find((b) => b.id === id)!.flip = true;
    return this;
  }

  connect(src: string, srcPort: number, dst: string, dstPort: number): this {
    this.model.links.push({ id: `l${++this.n}`, src: { block: src, port: srcPort }, dst: { block: dst, port: dstPort } });
    return this;
  }
}
