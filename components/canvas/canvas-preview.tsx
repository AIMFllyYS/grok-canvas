"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore, useStoreApi, ViewportPortal } from "@xyflow/react";
import { previewStore } from "@/lib/canvas-runtime/preview-store";
import { placePreviews, type PlacedPreview } from "@/lib/canvas-runtime/preview-coordinator";
import type { FlowLayoutNode } from "@/lib/node-placement";
import { ImagineLoading } from "./imagine-loading";

/**
 * 占位交接给正式节点时打标记：节点外壳加 .canvas-node-arrive，从占位处缓动弹到实际大小，
 * 动画结束后移除。只作用于刚由 Agent 创建的节点，打开画布、远端同步来的节点不动。
 */
function markArrival(nodeId: string) {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    if (!element) return;
    element.classList.add("canvas-node-arrive");
    element.addEventListener("animationend", () => element.classList.remove("canvas-node-arrive"), { once: true });
  });
}

/** 当前画布是否有预显示条目（空画布提示据此隐藏）。 */
export function useHasPreviews(canvasId: string): boolean {
  return useSyncExternalStore(previewStore.subscribe, () => previewStore.get(canvasId).length > 0, () => false);
}

/**
 * 新增占位：与生成中的媒体节点同一套动画（星点阵 + 扫光），只显示名称与字数，不渲染正文——
 * 撰写中每 400ms 都会推一次草稿，在画布上反复排版长文会拖慢整个画布；正文在面板的工具卡片里看。
 */
function AddPlaceholder({ entry }: { entry: PlacedPreview }) {
  return (
    <div className="absolute overflow-hidden rounded-xl ring-1 ring-primary/30" data-preview="add"
      style={{ transform: `translate(${entry.x}px, ${entry.y}px)`, width: entry.width, height: entry.height, pointerEvents: "none" }}>
      <ImagineLoading />
      <span className="absolute left-1/2 top-1/2 max-w-[85%] -translate-x-1/2 -translate-y-1/2 truncate rounded-full bg-popover px-3 py-1 text-xs text-foreground">
        {entry.label} · Agent 正在创建
      </span>
    </div>
  );
}

function TargetMarker({ entry }: { entry: PlacedPreview }) {
  return (
    <div data-preview={entry.kind}
      className={`absolute rounded-xl border border-dashed text-xs ${entry.kind === "remove" ? "border-destructive/70 bg-destructive/10 text-destructive" : "border-primary/70 bg-transparent text-primary"}`}
      style={{ transform: `translate(${entry.x}px, ${entry.y}px)`, width: entry.width, height: entry.height, pointerEvents: "none" }}>
      <span className="absolute left-2 top-2 truncate" style={{ maxWidth: entry.width - 16 }}>{entry.label}</span>
    </div>
  );
}

/**
 * 只读预显示层（P2-09 + P5-02）：画在 React Flow 视口坐标里，pointer-events:none，不进入正式节点数组、
 * 引用解析、素材扫描或撤销历史；不移动相机。
 * - 新增：动画占位，位置按流程排版估算（与服务端相同算法），正式节点出现后移除；
 * - 修改：目标节点上叠「Agent 正在修改」；删除：叠「待删除」，正式节点在命令提交前不被删除。
 */
export function CanvasPreview({ canvasId }: { canvasId: string }) {
  const entries = useSyncExternalStore(previewStore.subscribe, () => previewStore.get(canvasId), () => previewStore.get(canvasId));
  const simplified = useSyncExternalStore(previewStore.subscribe, previewStore.simplified, previewStore.simplified);
  const store = useStoreApi();
  // 只订阅“哪些预期节点已出现”这一个字符串，拖动等其他更新不会让本层重渲染。
  const arrived = useStore(state => entries.filter(entry => entry.nodeId && state.nodeLookup.has(entry.nodeId)).map(entry => `${entry.toolCallId}:${entry.itemIndex}`).join("|"));
  useEffect(() => {
    if (!arrived) return;
    for (const key of arrived.split("|")) {
      const at = key.lastIndexOf(":");
      const entry = entries.find(item => `${item.toolCallId}:${item.itemIndex}` === key);
      if (entry?.nodeId) markArrival(entry.nodeId);
      previewStore.remove(canvasId, key.slice(0, at), Number(key.slice(at + 1)));
    }
  }, [arrived, canvasId, entries]);
  // 位置只在条目变化时计算一次（读取当时的节点几何），不随拖动每帧重算。
  const placed = useMemo(() => {
    if (!entries.length) return [];
    const { nodes, edges } = store.getState();
    return placePreviews(entries, nodes as unknown as FlowLayoutNode[], edges);
  }, [entries, store]);
  if (!placed.length && !simplified) return null;
  return (
    <ViewportPortal>
      <div className="canvas-preview-layer" aria-hidden="true" style={{ pointerEvents: "none" }}>
        {placed.map(entry => entry.kind === "add"
          ? <AddPlaceholder key={`${entry.toolCallId}:${entry.itemIndex}`} entry={entry} />
          : <TargetMarker key={`${entry.toolCallId}:${entry.itemIndex}`} entry={entry} />)}
        {simplified && <div className="absolute left-0 top-0 text-xs text-muted-foreground" style={{ pointerEvents: "none" }}>预览已简化</div>}
      </div>
    </ViewportPortal>
  );
}
