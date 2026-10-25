"use client";

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { ChevronRight, Pin, PinOff, X } from "lucide-react";

/** Shared edge affordance: resize with pointer or arrows; keep within the viewport. */
export function ResizeGrip({ name, storageKey, initial, min, max, onWidth }: {
  name: string; storageKey: string; initial: number; min: number; max: number;
  onWidth: (width: number) => void;
}) {
  const width = useRef(initial);
  const start = useRef<{ x: number; width: number } | null>(null);
  const callback = useRef(onWidth);
  callback.current = onWidth;
  const [current, setCurrent] = useState(initial);
  const set = (value: number) => {
    const next = Math.round(Math.min(Math.max(min, value), Math.max(min, Math.min(max, window.innerWidth - 56))));
    width.current = next; setCurrent(next); callback.current(next);
    try { localStorage.setItem(storageKey, String(next)); } catch {}
  };
  useEffect(() => {
    let saved = initial;
    try { const raw = Number(localStorage.getItem(storageKey)); if (Number.isFinite(raw) && raw > 0) saved = raw; } catch {}
    set(saved);
    const resize = () => set(width.current);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
    // The storage contract and bounds are fixed for each panel instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, initial, min, max]);
  return <div className="studio-resize-grip" role="separator" tabIndex={0}
    aria-label={name} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={current}
    onPointerDown={event => { event.preventDefault(); start.current = { x: event.clientX, width: width.current }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (start.current) set(start.current.width + event.clientX - start.current.x); }}
    onPointerUp={event => { start.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { start.current = null; }}
    onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); set(width.current + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 32 : 8)); } }} />;
}

export function EdgePanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false), [width, setWidth] = useState(248);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="studio-edge-dock" data-open={open || pinned} data-pinned={pinned} style={{ "--edge-width": `${width}px` } as CSSProperties}
    onMouseLeave={event => { if (!pinned && !event.buttons && !event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onBlur={event => { if (!pinned && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === "Escape") { setPinned(false); setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="studio-edge-trigger" aria-label="打开作品列表" aria-expanded={open || pinned}
      onClick={() => setOpen(true)}><ChevronRight size={13} /></button>
    <aside className="studio-edge-panel" aria-label="作品列表" inert={!open && !pinned}>
      <div className="studio-edge-heading"><span>作品</span><button className="studio-icon-button" aria-label={pinned ? "取消固定作品列表" : "固定作品列表"} aria-pressed={pinned} onClick={() => setPinned(value => !value)}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button><button className="studio-icon-button" aria-label="关闭作品列表" onClick={() => { setPinned(false); setOpen(false); trigger.current?.focus(); }}><X size={15} /></button></div>
      {children}
      <ResizeGrip name="调整作品列表宽度" storageKey="studio-project-panel-width" initial={248} min={208} max={380} onWidth={setWidth} />
    </aside>
  </div>;
}
