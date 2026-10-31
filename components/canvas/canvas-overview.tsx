"use client";

import { useEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import type { VisibilityIndex } from "@/lib/canvas-runtime/visibility";
import { sourceHandle, targetHandle } from "@/lib/canvas-runtime/edge-index";

/**
 * 概览层（P4-05）：候选超过阈值时 React Flow 只保留 pin 节点，其余节点轮廓与连线由这里用 Canvas2D 绘制。
 * 只负责显示与命中（点击由场景经空间索引定位后局部放大），不承担正文编辑。
 * 按 DPR 缩放；视口变化在下一帧重绘；颜色取当前主题的 CSS 变量；拿不到 2D 上下文时报告 unavailable，场景退回轻量模式。
 */
const EDGE_LIMIT = 6000;

export function CanvasOverview({ index, version, selected, onUnavailable, onPick }: { index: VisibilityIndex; version: number; selected: ReadonlySet<string>; onUnavailable: () => void; onPick: (clientX: number, clientY: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const store = useStoreApi();
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) { unavailableRef.current(); return; }
    let frame = 0;
    const draw = () => {
      frame = 0;
      const { transform, width, height } = store.getState();
      const [tx, ty, zoom] = transform;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const style = getComputedStyle(canvas);
      const border = style.getPropertyValue("--border").trim() || "#888";
      const fill = style.getPropertyValue("--card").trim() || "#222";
      const edgeColor = style.getPropertyValue("--muted-foreground").trim() || "#999";
      const primary = style.getPropertyValue("--primary").trim() || "#4f8cff";
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * tx, dpr * ty);
      const view = { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom };
      const { nodeIds, edgeIds } = index.query(view);
      context.lineWidth = 1 / zoom;
      context.strokeStyle = edgeColor;
      context.globalAlpha = 0.5;
      context.beginPath();
      let drawn = 0;
      for (const id of edgeIds) {
        if (++drawn > EDGE_LIMIT) break;
        const ends = edgeEnds(index, id);
        if (!ends) continue;
        context.moveTo(ends.s.x, ends.s.y);
        context.lineTo(ends.t.x, ends.t.y);
      }
      context.stroke();
      context.globalAlpha = 1;
      for (const id of nodeIds) {
        const r = index.nodeRect(id);
        if (!r) continue;
        context.fillStyle = fill;
        context.fillRect(r.x, r.y, r.width, r.height);
        context.strokeStyle = selectedRef.current.has(id) ? primary : border;
        context.lineWidth = (selectedRef.current.has(id) ? 3 : 1.5) / zoom;
        context.strokeRect(r.x, r.y, r.width, r.height);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    schedule();
    const unsubscribe = store.subscribe(schedule);
    const lost = (event: Event) => { event.preventDefault(); unavailableRef.current(); };
    canvas.addEventListener("contextlost", lost);
    window.addEventListener("resize", schedule);
    // 点击识别：选择模式下按下空白处会开始框选、不触发 onPaneClick，所以在外层容器上自己识别「按下-抬起不移动」。
    const root = canvas.closest(".react-flow") as HTMLElement | null;
    let down: { x: number; y: number; at: number } | null = null;
    const onDown = (event: PointerEvent) => { down = event.button === 0 ? { x: event.clientX, y: event.clientY, at: performance.now() } : null; };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || performance.now() - start.at > 500) return;
      if (!(event.target instanceof Element) || !event.target.closest(".react-flow__pane, .react-flow__renderer")) return;
      pickRef.current(event.clientX, event.clientY);
    };
    root?.addEventListener("pointerdown", onDown, true);
    root?.addEventListener("pointerup", onUp, true);
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener("contextlost", lost);
      window.removeEventListener("resize", schedule);
      root?.removeEventListener("pointerdown", onDown, true);
      root?.removeEventListener("pointerup", onUp, true);
    };
  }, [index, store, version]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 z-[1] h-full w-full" aria-hidden data-lod="overview" />;
}

/** 边的端点：索引只存矩形，端点从两端节点矩形推出（与轻量/完整节点手柄同一偏移）。 */
const endsCache = new WeakMap<VisibilityIndex, Map<string, { source: string; target: string }>>();
export function registerEdgeEnds(index: VisibilityIndex, edges: Iterable<{ id: string; source: string; target: string }>) {
  const map = new Map<string, { source: string; target: string }>();
  for (const edge of edges) map.set(edge.id, { source: edge.source, target: edge.target });
  endsCache.set(index, map);
}
function edgeEnds(index: VisibilityIndex, id: string) {
  const edge = endsCache.get(index)?.get(id);
  if (!edge) return null;
  const s = index.nodeRect(edge.source), t = index.nodeRect(edge.target);
  return s && t ? { s: sourceHandle(s), t: targetHandle(t) } : null;
}
