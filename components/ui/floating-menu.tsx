"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fitFloatingRect } from "@/lib/floating-placement";
import { ControlButton } from "./control-button";

export function MenuItem({ label, shortcut, disabled, onClick, danger = false, icon }: {
  label: string; shortcut?: string; disabled?: boolean; onClick: () => void; danger?: boolean; icon?: ReactNode;
}) {
  return <ControlButton role="menuitem" data-danger={danger || label.startsWith("删除")} disabled={disabled} onClick={onClick}
    className="flex w-full items-center justify-between gap-6 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50">
    <span className="flex items-center gap-2">{icon}{label}</span>{shortcut && <span className="text-xs text-muted-foreground">{shortcut}</span>}
  </ControlButton>;
}

/** Shared menu navigation and viewport collision handling; actions stay with callers. */
export function FloatingMenu({ children, position, className = "", onClose }: {
  children: ReactNode;
  position?: { x: number; y: number };
  className?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coordinates, setCoordinates] = useState(position ? { left: position.x, top: position.y } : undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement;
    element.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !position) return;
    const update = () => setCoordinates(fitFloatingRect(position.x, position.y, element.offsetWidth, element.offsetHeight, innerWidth, innerHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [position?.x, position?.y]);
  return <div ref={ref} role="menu" aria-label="画布操作" tabIndex={-1}
    className={`ui-menu-surface z-50 min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md ${position ? "fixed" : "absolute"} ${className}`}
    style={{ ...coordinates, maxHeight: "calc(100dvh - 24px)", overflowY: "auto" }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</div>;
}
