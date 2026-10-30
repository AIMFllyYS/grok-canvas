"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useStore, ViewportPortal } from "@xyflow/react";
import { previewStore } from "@/lib/canvas-runtime/preview-store";

/**
 * 只读预显示层（P2-09）：画在 React Flow 视口坐标里，pointer-events:none，不进入正式节点数组、
 * 引用解析、素材扫描或撤销历史；不移动相机。工具返回的正式节点出现后移除对应预显示。
 */
export function CanvasPreview({ canvasId }: { canvasId: string }) {
  const entries = useSyncExternalStore(previewStore.subscribe, () => previewStore.get(canvasId), () => previewStore.get(canvasId));
  const simplified = useSyncExternalStore(previewStore.subscribe, previewStore.simplified, previewStore.simplified);
  // 只订阅“哪些预期节点已出现”这一个字符串，拖动等其他更新不会让本层重渲染。
  const arrived = useStore(state => entries.filter(entry => entry.nodeId && state.nodeLookup.has(entry.nodeId)).map(entry => `${entry.toolCallId}:${entry.itemIndex}`).join("|"));
  useEffect(() => {
    if (!arrived) return;
    for (const key of arrived.split("|")) {
      const at = key.lastIndexOf(":");
      previewStore.remove(canvasId, key.slice(0, at), Number(key.slice(at + 1)));
    }
  }, [arrived, canvasId]);
  if (!entries.length && !simplified) return null;
  return (
    <ViewportPortal>
      <div className="canvas-preview-layer" aria-hidden="true" style={{ pointerEvents: "none" }}>
        {entries.map(entry => (
          <div
            key={`${entry.toolCallId}:${entry.itemIndex}`}
            data-preview={entry.kind}
            className="absolute rounded-xl border border-dashed border-primary/60 bg-primary/5 text-xs text-muted-foreground"
            style={{ transform: `translate(${entry.x}px, ${entry.y}px)`, width: entry.width, height: entry.height, pointerEvents: "none" }}
          >
            <span className="absolute left-2 top-2">{entry.label} · Agent 正在创建</span>
          </div>
        ))}
        {simplified && <div className="absolute left-0 top-0 text-xs text-muted-foreground" style={{ pointerEvents: "none" }}>预览已简化</div>}
      </div>
    </ViewportPortal>
  );
}
