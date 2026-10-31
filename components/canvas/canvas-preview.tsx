"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore, useStoreApi, ViewportPortal } from "@xyflow/react";
import { previewStore } from "@/lib/canvas-runtime/preview-store";
import { placePreviews } from "@/lib/canvas-runtime/preview-coordinator";
import type { FlowLayoutNode } from "@/lib/node-placement";

/**
 * 只读预显示层（P2-09 + P5-02）：画在 React Flow 视口坐标里，pointer-events:none，不进入正式节点数组、
 * 引用解析、素材扫描或撤销历史；不移动相机。
 * - 新增：虚线占位，位置按流程排版估算（与服务端相同算法），正式节点出现后移除；
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
      previewStore.remove(canvasId, key.slice(0, at), Number(key.slice(at + 1)));
    }
  }, [arrived, canvasId]);
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
        {placed.map(entry => (
          <div
            key={`${entry.toolCallId}:${entry.itemIndex}`}
            data-preview={entry.kind}
            className={`absolute rounded-xl border border-dashed text-xs ${entry.kind === "remove" ? "border-destructive/70 bg-destructive/10 text-destructive" : entry.kind === "edit" ? "border-primary/70 bg-transparent text-primary" : "border-primary/60 bg-primary/5 text-muted-foreground"}`}
            style={{ transform: `translate(${entry.x}px, ${entry.y}px)`, width: entry.width, height: entry.height, pointerEvents: "none" }}
          >
            <span className="absolute left-2 top-2 truncate" style={{ maxWidth: entry.width - 16 }}>{entry.kind === "add" ? `${entry.label} · Agent 正在创建` : entry.label}</span>
            {entry.kind === "add" && entry.excerpt && <p className="absolute inset-x-2 top-7 line-clamp-6 whitespace-pre-wrap opacity-70">{entry.excerpt}</p>}
          </div>
        ))}
        {simplified && <div className="absolute left-0 top-0 text-xs text-muted-foreground" style={{ pointerEvents: "none" }}>预览已简化</div>}
      </div>
    </ViewportPortal>
  );
}
