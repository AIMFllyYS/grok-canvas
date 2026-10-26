"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { MiniMap } from "@xyflow/react";
import { GripVertical, ImagePlus, MoveDiagonal2, Video } from "lucide-react";
import { CanvasControls } from "./canvas-controls";
import { ControlButton } from "../ui/control-button";
import { useWorkspacePreferences } from "../workspace-preferences";
import { fitFloatingRect } from "@/lib/floating-placement";
import {
  clampMinimapSize, MINIMAP_DEFAULT_SIZE, MINIMAP_SIZE_KEY, parseMinimapSize, parseToolbarPosition,
  toolbarPositionKey, toolbarTarget, type MinimapSize, type ToolbarPosition,
} from "@/lib/workspace-preferences";
import type { InteractionMode } from "@/lib/canvas-interaction";

type ResizeAxis = "x" | "y" | "both";

export function CanvasToolbar({ canvasId, containerRef, mode, onModeChange, minimapOpen, onToggleMinimap, onAddImage, onAddVideo, onDraggingChange }: {
  canvasId: string; containerRef: RefObject<HTMLDivElement | null>; mode: InteractionMode; onModeChange: (mode: InteractionMode) => void;
  minimapOpen: boolean; onToggleMinimap: () => void; onAddImage: () => void; onAddVideo: () => void; onDraggingChange: (dragging: boolean) => void;
}) {
  const { layout, positionReset } = useWorkspacePreferences();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ToolbarPosition>({ x: 12, y: 12 });
  const [ready, setReady] = useState(false);
  const current = useRef(position);
  const custom = useRef<ToolbarPosition | null>(null);
  const drag = useRef<{ x: number; y: number; origin: ToolbarPosition } | null>(null);
  const keyboardOrigin = useRef<ToolbarPosition | null>(null);
  const previousReset = useRef(positionReset);
  const place = useCallback((point: ToolbarPosition) => {
    const parent = containerRef.current, element = ref.current;
    if (!parent || !element) return point;
    const next = fitFloatingRect(point.x, point.y, element.offsetWidth, element.offsetHeight, parent.clientWidth, parent.clientHeight);
    const value = { x: next.left, y: next.top };
    current.current = value; setPosition(value); return value;
  }, [containerRef]);
  const persist = () => {
    custom.current = current.current;
    try { localStorage.setItem(toolbarPositionKey(canvasId), JSON.stringify(current.current)); } catch { /* 位置仍保留在内存。 */ }
  };
  useLayoutEffect(() => {
    if (previousReset.current !== positionReset) {
      previousReset.current = positionReset;
      custom.current = null;
      try { localStorage.removeItem(toolbarPositionKey(canvasId)); } catch { /* 可继续使用默认位置。 */ }
    } else {
      try { custom.current = parseToolbarPosition(localStorage.getItem(toolbarPositionKey(canvasId))); } catch { /* 无本地存储。 */ }
    }
    // 首次提交时祖先容器的 ref 还未挂载（布局阶段自底向上），此处不能直接放弃：
    // 否则 ready 永远为 false，工具栏会一直停在 visibility: hidden。
    let frame = 0;
    let attempts = 0;
    let observer: ResizeObserver | null = null;
    let disposed = false;
    const attach = () => {
      if (disposed) return;
      const parent = containerRef.current, element = ref.current;
      if (!parent || !element) {
        // 一直拿不到容器时先显示出来，不把控件永久藏住。
        if (++attempts > 60) { setReady(true); return; }
        frame = requestAnimationFrame(attach);
        return;
      }
      const update = () => {
        place(toolbarTarget(layout, custom.current,
          { width: parent.clientWidth, height: parent.clientHeight },
          { width: element.offsetWidth, height: element.offsetHeight }));
        setReady(true);
      };
      update();
      observer = new ResizeObserver(update);
      observer.observe(parent);
      observer.observe(element);
    };
    attach();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [canvasId, containerRef, layout, positionReset, place]);
  const stopDrag = (cancel = false) => {
    if (!drag.current) return;
    if (cancel) place(drag.current.origin);
    drag.current = null;
    persist(); onDraggingChange(false);
  };

  // ---- 小地图：聚合布局固定在画布右下角，拖左上角手柄调整尺寸 ----
  const [minimapSize, setMinimapSize] = useState<MinimapSize>(MINIMAP_DEFAULT_SIZE);
  const minimapSizeRef = useRef(minimapSize);
  minimapSizeRef.current = minimapSize;
  const resizing = useRef<{ x: number; y: number; width: number; height: number; axis: ResizeAxis } | null>(null);
  useEffect(() => {
    try { const saved = parseMinimapSize(localStorage.getItem(MINIMAP_SIZE_KEY)); if (saved) setMinimapSize(saved); } catch { /* 无本地存储时使用默认尺寸。 */ }
  }, []);
  const persistMinimap = (size: MinimapSize) => {
    try { localStorage.setItem(MINIMAP_SIZE_KEY, JSON.stringify(size)); } catch { /* 尺寸仍保留在内存。 */ }
  };
  // 容器缩小时把地图收回可视范围，避免溢出画布。
  useEffect(() => {
    if (!minimapOpen || layout !== "aggregated") return;
    const parent = containerRef.current;
    if (!parent) return;
    const fit = () => setMinimapSize(current => {
      const next = clampMinimapSize(current, { width: parent.clientWidth, height: parent.clientHeight });
      return next.width === current.width && next.height === current.height ? current : next;
    });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [containerRef, layout, minimapOpen]);
  const minimapContainer = () => ({ width: containerRef.current?.clientWidth ?? 0, height: containerRef.current?.clientHeight ?? 0 });
  // 手柄就是地图自身的边缘：热区始终在，指示只在贴边悬停／键盘聚焦／拖拽时才浮现。
  const startResize = (axis: ResizeAxis) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { x: event.clientX, y: event.clientY, ...minimapSizeRef.current, axis };
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = resizing.current;
    if (!start) return;
    setMinimapSize(clampMinimapSize({
      width: start.axis === "y" ? start.width : start.width - (event.clientX - start.x),
      height: start.axis === "x" ? start.height : start.height - (event.clientY - start.y),
    }, minimapContainer()));
  };
  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!resizing.current) return;
    resizing.current = null;
    persistMinimap(minimapSizeRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nudgeMinimap = (axis: ResizeAxis, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 24 : 8;
    // 左上角往外推即变大，方向键按同样语义微调。
    const growWidth = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    const growHeight = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    const next = clampMinimapSize({
      width: minimapSizeRef.current.width + (axis === "y" ? 0 : growWidth),
      height: minimapSizeRef.current.height + (axis === "x" ? 0 : growHeight),
    }, minimapContainer());
    setMinimapSize(next); persistMinimap(next);
  };
  const resizeHandle = (axis: ResizeAxis, hitArea: string, label: string, grip: ReactNode) => (
    <button type="button" aria-label={label} title={label} className={`group/edge absolute focus-visible:outline-none ${hitArea}`}
      onPointerDown={startResize(axis)} onPointerMove={moveResize} onPointerUp={stopResize}
      onPointerCancel={() => { resizing.current = null; }} onLostPointerCapture={stopResize} onKeyDown={event => nudgeMinimap(axis, event)}>
      {grip}
    </button>
  );
  const gripReveal = "pointer-events-none absolute opacity-0 transition-opacity duration-150 group-hover/edge:opacity-100 group-focus-visible/edge:opacity-100 group-active/edge:opacity-100";
  return <>
    <div ref={ref} role="toolbar" aria-label="画布工具栏" data-workspace-overlay className="ui-canvas-toolbar canvas-tool-overlay nodrag nopan nowheel absolute left-0 top-0 z-30 flex items-center rounded-full bg-popover px-2 py-1.5 text-popover-foreground shadow-xl ring-1 ring-foreground/10" style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)`, visibility: ready ? "visible" : "hidden" }}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {layout === "aggregated" && <ControlButton aria-label="拖动工具栏，方向键移动，Esc撤销" title="拖动工具栏" className="mr-1 flex h-8 w-5 cursor-grab items-center justify-center rounded-full text-muted-foreground active:cursor-grabbing"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, origin: current.current }; onDraggingChange(true); }}
      onPointerMove={event => { const start = drag.current; if (start) place({ x: start.origin.x + event.clientX - start.x, y: start.origin.y + event.clientY - start.y }); }}
      onPointerUp={event => { stopDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => stopDrag(true)} onLostPointerCapture={() => stopDrag()}
      onBlur={() => { stopDrag(); keyboardOrigin.current = null; }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); stopDrag(true); if (keyboardOrigin.current) { place(keyboardOrigin.current); persist(); keyboardOrigin.current = null; } return; }
        if (event.key === "Enter") { keyboardOrigin.current = null; return; }
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault(); keyboardOrigin.current ??= current.current;
        const step = event.shiftKey ? 24 : 8;
        place({ x: current.current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: current.current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) }); persist();
      }}><GripVertical size={15} /></ControlButton>}
    <CanvasControls mode={mode} onModeChange={onModeChange} minimapOpen={minimapOpen} onToggleMinimap={onToggleMinimap} leading={layout === "aggregated" ? <>
      <ControlButton aria-label="添加图片节点" title="添加图片节点" onClick={onAddImage} className="flex size-8 items-center justify-center rounded-full"><ImagePlus size={17} /></ControlButton>
      <ControlButton aria-label="添加视频节点" title="添加视频节点" onClick={onAddVideo} className="flex size-8 items-center justify-center rounded-full"><Video size={17} /></ControlButton>
      <span className="mx-1 h-4 w-px bg-border" />
    </> : undefined} />
    {minimapOpen && layout === "scattered" && <div className="absolute left-0 overflow-hidden rounded-xl border bg-popover p-1 shadow-xl" style={{ top: position.y >= 152 ? -144 : 48 }}>
      <MiniMap pannable zoomable nodeColor="var(--canvas-map-node)" maskColor="var(--canvas-map-mask)" style={{ position: "relative", margin: 0, width: 180, height: 128, background: "var(--popover)", borderRadius: 8 }} />
    </div>}
    </div>
    {minimapOpen && layout === "aggregated" && <div data-workspace-overlay className="nodrag nopan nowheel absolute bottom-4 right-4 z-20 rounded-xl border bg-popover p-1 shadow-xl"
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <MiniMap pannable zoomable nodeColor="var(--canvas-map-node)" maskColor="var(--canvas-map-mask)" style={{ position: "relative", margin: 0, width: minimapSize.width, height: minimapSize.height, background: "var(--popover)", borderRadius: 8 }} />
      {resizeHandle("x", "-left-1.5 top-4 bottom-4 z-10 w-3 cursor-ew-resize", "左右拖动调整小地图宽度，方向键微调",
        <span aria-hidden className={`${gripReveal} inset-y-2 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-foreground/35`} />)}
      {resizeHandle("y", "-top-1.5 left-4 right-4 z-10 h-3 cursor-ns-resize", "上下拖动调整小地图高度，方向键微调",
        <span aria-hidden className={`${gripReveal} inset-x-2 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground/35`} />)}
      {resizeHandle("both", "-left-2 -top-2 z-20 size-5 cursor-nwse-resize", "拖动左上角调整小地图大小，方向键微调",
        <span aria-hidden className={`${gripReveal} left-0 top-0 flex size-4 items-center justify-center rounded-full bg-popover text-muted-foreground shadow ring-1 ring-foreground/10`}><MoveDiagonal2 size={9} /></span>)}
    </div>}
  </>;
}
