// Block library panel: drag a block onto the canvas or double-click to add it.

import { useState } from 'react';
import { BLOCK_LIST, CATEGORIES } from '../sim/blocks';
import { DRAG_MIME } from './Canvas';
import { blockSize } from './geometry';
import { Glyph } from './glyphs';
import { defaultParams } from './modelOps';

export function Library({ onAdd }: { onAdd(type: string): void }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  return (
    <aside className="library">
      <input
        className="library-search"
        placeholder="Hľadať blok…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {CATEGORIES.map((cat) => {
        const items = BLOCK_LIST.filter(
          (d) => d.category === cat && (!q || d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)),
        );
        if (!items.length) return null;
        return (
          <section key={cat}>
            <h3>{cat}</h3>
            <div className="library-grid">
              {items.map((d) => {
                const b = { id: 'preview', type: d.type, name: d.label, x: 0, y: 0, params: defaultParams(d.type) };
                const { w, h } = blockSize(b);
                return (
                  <div
                    key={d.type}
                    className="library-item"
                    title={`${d.label}: ${d.description}\nPretiahnite na plátno alebo dvakrát kliknite.`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_MIME, d.type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onDoubleClick={() => onAdd(d.type)}
                  >
                    <svg viewBox={`-8 -4 ${w + 16} ${h + 8}`} className="library-icon">
                      {d.type === 'Gain' ? (
                        <path d={`M0,0 L${w},${h / 2} L0,${h} Z`} className="block-body" />
                      ) : (
                        <rect width={w} height={h} rx={4} className="block-body" />
                      )}
                      <Glyph b={b} w={w} h={h} />
                    </svg>
                    <span>{d.label}</span>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
