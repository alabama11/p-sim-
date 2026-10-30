// Floating Scope window: plots the logged inputs of one Scope block.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SignalLog } from '../sim/engine';

const LEGEND_H = 30;
const COLORS = ['#e8a33d', '#4a9eff', '#e5484d', '#30a46c', '#8e4ec6', '#12a594', '#d6409f', '#978365'];

interface Props {
  title: string;
  log?: SignalLog;
  index: number;
  onClose(): void;
  onParams(): void;
}

export function ScopeWindow({ title, log, index, onClose, onParams }: Props) {
  const [pos, setPos] = useState({ x: 40 + index * 30, y: 16 + index * 30 });
  const boxRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Open along the right edge of the canvas so the diagram stays visible.
  useLayoutEffect(() => {
    const parent = boxRef.current?.parentElement;
    if (!parent) return;
    const w = boxRef.current!.offsetWidth;
    setPos({ x: Math.max(16, parent.clientWidth - w - 16 - index * 30), y: 16 + index * 30 });
  }, [index]);

  useEffect(() => {
    const el = plotRef.current!;
    if (!log || log.t.length === 0) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--scope-ink').trim() || '#ccc';
    const grid = css.getPropertyValue('--scope-grid').trim() || '#333';
    const axis = { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight - LEGEND_H,
      scales: { x: { time: false } },
      axes: [{ ...axis, label: 't [s]' }, { ...axis }],
      series: [
        { label: 't' },
        ...log.y.map((_, i) => ({ label: `u${i + 1}`, stroke: COLORS[i % COLORS.length], width: 1.5 })),
      ],
      cursor: { drag: { x: true, y: true, uni: 20 } },
      legend: { live: true },
    };
    const plot = new uPlot(opts, [log.t, ...log.y], el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: el.clientHeight - LEGEND_H }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [log]);

  const exportCsv = () => {
    if (!log) return;
    const header = ['t', ...log.y.map((_, i) => `u${i + 1}`)].join(',');
    const rows = log.t.map((t, i) => [t, ...log.y.map((ch) => ch[i])].join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div ref={boxRef} className="scope-window" style={{ left: pos.x, top: pos.y }}>
      <header
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
        onPointerMove={(e) => {
          if (dragRef.current) setPos({ x: e.clientX - dragRef.current.dx, y: Math.max(0, e.clientY - dragRef.current.dy) });
        }}
        onPointerUp={() => (dragRef.current = null)}
      >
        <span>{title}</span>
        <span className="scope-buttons">
          <button onClick={exportCsv} disabled={!log} title="Uložiť dáta ako CSV">CSV</button>
          <button onClick={onParams} title="Parametre bloku">⚙</button>
          <button onClick={onClose} title="Zavrieť">✕</button>
        </span>
      </header>
      <div className="scope-plot" ref={plotRef}>
        {!log && <p className="scope-empty">Spustite simuláciu (▶).</p>}
      </div>
      <footer className="scope-hint">Ťahaním myšou priblížite, dvojklikom vrátite pôvodný rozsah.</footer>
    </div>
  );
}
