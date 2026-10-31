"use client";

import { Profiler, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ReactFlow, useReactFlow, useStoreApi, type Edge, type Node, type ReactFlowProps } from "@xyflow/react";
import type { GestureStore } from "@/lib/canvas-runtime/gesture-store";
import { canvasMetrics } from "@/lib/canvas-runtime/metrics";
import { createSceneProjector, displayGeometry, projectScene } from "@/lib/canvas-runtime/scene-adapter";
import { createVisibilityIndex, syncIndex, type Viewport } from "@/lib/canvas-runtime/visibility";
import { allocateFull, createLodState, needsRequery, type LodMode } from "@/lib/canvas-runtime/lod";
import type { Rect } from "@/lib/canvas-runtime/edge-index";
import { CanvasZoomStyle } from "./canvas-zoom-style";
import { CanvasOverview, registerEdgeEnds } from "./canvas-overview";

type CanvasSceneProps = Omit<ReactFlowProps<Node, Edge>, "nodes" | "children"> & {
  /** 正式工作文档：手势途中不变。 */
  nodes: Node[];
  gesture: GestureStore;
  /** 必须保持完整的节点（正在编辑的面板节点等）；拖动/resize/连线起点由场景自己加入。 */
  pinnedIds?: readonly string[];
  children?: ReactNode;
};

/** 诊断开启时记录 React commit 耗时（P6-01）；生产构建 Profiler 不回调，默认关闭时 record 直接返回。 */
const onCommit = (_id: string, phase: string, actualDuration: number) => {
  canvasMetrics.record("react_commit_ms", actualDuration, { phase: phase === "mount" ? "mount" : "update" });
};

type ViewSnapshot = { viewport: Viewport; screen: { width: number; height: number } };
type Plan = { mode: LodMode; candidates: Set<string>; full: Set<string>; pins: Set<string> };

/** 同一个源节点对象只派生一次轻量/隐藏版本，保持引用稳定，React Flow 不会因此重算全部节点。 */
const lightCache = new WeakMap<Node, Node>();
const hiddenCache = new WeakMap<Node, Node>();
function lightOf(node: Node): Node {
  let light = lightCache.get(node);
  if (!light) {
    const g = displayGeometry(node);
    light = { ...node, type: `light-${node.type}`, style: { ...node.style, width: g.width, height: g.height } };
    lightCache.set(node, light);
  }
  return light;
}
function hiddenOf(node: Node): Node {
  let hidden = hiddenCache.get(node);
  if (!hidden) { hidden = { ...node, hidden: true }; hiddenCache.set(node, hidden); }
  return hidden;
}

/**
 * React Flow 交互投影（P2-06）+ 可见性/细节层级（P4-04、P4-05）。
 * - 只有这里订阅手势覆盖层：拖动/resize 每帧只重渲染本组件；
 * - 可见性索引与 DOM 无关；视口走出上次查询的预取带才重新查询，平移途中不重算节点列表；
 * - 近景最多 80 个完整组件，其余轻量；候选过多进入 Canvas2D 概览，React Flow 只保留 pin；
 * - 离屏节点由 onlyRenderVisibleElements 不挂载，但仍在 React Flow store 中，选择/适配/连线语义不变。
 * 只使用 React Flow 的公开 API。
 */
export function CanvasScene({ nodes, gesture, pinnedIds, children, onConnectStart, onConnectEnd, onPaneClick, ...flowProps }: CanvasSceneProps) {
  const overlayVersion = useSyncExternalStore(gesture.subscribe, gesture.version, gesture.version);
  const [projector] = useState(() => createSceneProjector<Node>());
  // overlayVersion 是覆盖层的变化信号，投影本身从 gesture 读取当前值。
  const projected = useMemo(() => projectScene(nodes, gesture, projector) as Node[], [nodes, gesture, projector, overlayVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => flowProps.edges ?? [], [flowProps.edges]);
  const store = useStoreApi();
  const flow = useReactFlow();
  const [index] = useState(() => createVisibilityIndex());
  const [lod] = useState(() => createLodState());
  const [view, setView] = useState<ViewSnapshot | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [overviewUnavailable, setOverviewUnavailable] = useState(false);
  const lastQuery = useRef<{ rect: Rect; zoom: number } | null>(null);

  // 索引增量同步：只处理新增/移动/删除的节点与受影响的边。按正式文档同步（不是手势投影）：
  // 拖动途中正式文档不变，索引与层级规划都不随每帧重算；参与手势的节点是 pin，始终完整挂载。
  const indexVersion = useMemo(() => {
    syncIndex(index, nodes.map(node => ({ id: node.id, rect: displayGeometry(node) })), edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })));
    registerEdgeEnds(index, edges);
    return index.stats().updates;
  }, [index, nodes, edges]);

  // 视口变化：只有走出预取带或缩放明显变化时才更新快照（触发重新查询）。
  useEffect(() => {
    const check = () => {
      const { transform, width, height } = store.getState();
      if (!width || !height) return;
      const [x, y, zoom] = transform;
      const visible = { x: -x / zoom, y: -y / zoom, width: width / zoom, height: height / zoom };
      if (needsRequery(lastQuery.current, visible, zoom)) setView({ viewport: { x, y, zoom }, screen: { width, height } });
    };
    check();
    return store.subscribe(check);
  }, [store]);

  const pinKey = [...(pinnedIds ?? []), connecting ?? ""].join("|");
  const plan = useMemo<Plan | null>(() => {
    if (!view) return null;
    const pins = new Set<string>([...gesture.participants(), ...(pinnedIds ?? []), ...(connecting ? [connecting] : [])]);
    const query = index.queryViewport(view.viewport, view.screen, pins);
    lastQuery.current = { rect: query.rect, zoom: view.viewport.zoom };
    let mode = lod.update(view.viewport.zoom, query.nodeIds.size);
    if (mode === "overview" && overviewUnavailable) mode = "light";
    const zoom = view.viewport.zoom;
    const center = { x: (view.screen.width / 2 - view.viewport.x) / zoom, y: (view.screen.height / 2 - view.viewport.y) / zoom };
    const full = mode === "detail"
      ? allocateFull([...query.nodeIds].flatMap(id => { const rect = index.nodeRect(id); return rect ? [{ id, rect }] : []; }), query.pins, center)
      : new Set(query.pins);
    return { mode, candidates: query.nodeIds, full, pins: query.pins };
    // 手势参与者只在手势开始/结束时变化，拖动途中不重新分配。
  }, [view, index, lod, pinKey, indexVersion, overviewUnavailable, gesture.active()]); // eslint-disable-line react-hooks/exhaustive-deps

  const rendered = useMemo(() => {
    if (!plan) return projected;
    return projected.map(node => {
      if (plan.mode === "overview") return plan.pins.has(node.id) ? node : hiddenOf(node);
      if (plan.full.has(node.id) || !plan.candidates.has(node.id)) return node;
      return lightOf(node);
    });
  }, [projected, plan]);

  // 诊断：实际挂载层级的计数（P6）。hidden 节点不挂载，不计为「隐藏但仍在 DOM」。
  useEffect(() => {
    if (!plan) return;
    const light = plan.mode === "overview" ? 0 : [...plan.candidates].filter(id => !plan.full.has(id)).length;
    const full = plan.mode === "overview" ? plan.pins.size : plan.full.size;
    const summary = { mode: plan.mode, candidates: plan.candidates.size, full, light, total: projected.length };
    (globalThis as { __grokCanvasLod?: typeof summary }).__grokCanvasLod = summary;
    if (typeof document !== "undefined") document.documentElement.dataset.canvasLod = plan.mode;
    canvasMetrics.record("lod_full_mounted", full, { mode: plan.mode });
  }, [plan, projected.length]);

  // 诊断开启且手势进行中才采样帧间隔（rAF 间隔 ≠ pointer-to-paint，二者分开记录）。
  useEffect(() => {
    let frame = 0, last = 0;
    const loop = (time: number) => {
      if (last) canvasMetrics.record("frame_interval_ms", time - last, { participants: gesture.participants().length });
      last = time;
      frame = gesture.active() ? requestAnimationFrame(loop) : 0;
    };
    const unsubscribe = gesture.subscribe(() => {
      if (!canvasMetrics.enabled() || frame || !gesture.active()) return;
      last = 0;
      frame = requestAnimationFrame(loop);
    });
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [gesture]);

  const handleConnectStart = useCallback<NonNullable<ReactFlowProps["onConnectStart"]>>((event, params) => {
    setConnecting(params.nodeId ?? null);
    onConnectStart?.(event, params);
  }, [onConnectStart]);
  const handleConnectEnd = useCallback<NonNullable<ReactFlowProps["onConnectEnd"]>>((event, state) => {
    setConnecting(null);
    onConnectEnd?.(event, state);
  }, [onConnectEnd]);
  // 概览模式：点击轮廓经空间索引定位节点并放大到它。
  const pickOverview = useCallback((clientX: number, clientY: number) => {
    const point = flow.screenToFlowPosition({ x: clientX, y: clientY });
    const hit = index.hit(point);
    const rect = hit ? index.nodeRect(hit) : null;
    if (rect) void flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, { zoom: 1, duration: 250 });
  }, [flow, index]);

  const selected = useMemo(() => new Set(nodes.filter(node => node.selected).map(node => node.id)), [nodes]);
  return (
    <Profiler id="canvas-scene" onRender={onCommit}>
      <ReactFlow nodes={rendered} {...flowProps} onlyRenderVisibleElements onConnectStart={handleConnectStart} onConnectEnd={handleConnectEnd} onPaneClick={onPaneClick}>
        <CanvasZoomStyle />
        {plan?.mode === "overview" && <CanvasOverview index={index} version={indexVersion} selected={selected} onUnavailable={() => setOverviewUnavailable(true)} onPick={pickOverview} />}
        {children}
      </ReactFlow>
    </Profiler>
  );
}
