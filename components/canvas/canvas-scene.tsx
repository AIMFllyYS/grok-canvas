"use client";

import { Profiler, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowProps } from "@xyflow/react";
import type { GestureStore } from "@/lib/canvas-runtime/gesture-store";
import { canvasMetrics } from "@/lib/canvas-runtime/metrics";
import { createSceneProjector, projectScene } from "@/lib/canvas-runtime/scene-adapter";
import { CanvasZoomStyle } from "./canvas-zoom-style";

type CanvasSceneProps = Omit<ReactFlowProps<Node, Edge>, "nodes" | "children"> & {
  /** 正式工作文档：手势途中不变。 */
  nodes: Node[];
  gesture: GestureStore;
  children?: ReactNode;
};

/** 诊断开启时记录 React commit 耗时（P6-01）；生产构建 Profiler 不回调，默认关闭时 record 直接返回。 */
const onCommit = (_id: string, phase: string, actualDuration: number) => {
  canvasMetrics.record("react_commit_ms", actualDuration, { phase: phase === "mount" ? "mount" : "update" });
};

/**
 * React Flow 交互投影（P2-06）。只有这里订阅手势覆盖层：拖动/resize 每帧只重渲染本组件，
 * FlowCanvas 与面板不随 pointermove 重渲染；投影只替换参与节点对象，其余节点与 data 引用不变。
 * 只使用 React Flow 的公开 props，不读写库的私有 store。
 */
export function CanvasScene({ nodes, gesture, children, ...flowProps }: CanvasSceneProps) {
  const overlayVersion = useSyncExternalStore(gesture.subscribe, gesture.version, gesture.version);
  const [projector] = useState(() => createSceneProjector<Node>());
  // overlayVersion 是覆盖层的变化信号，投影本身从 gesture 读取当前值。
  const projected = useMemo(() => projectScene(nodes, gesture, projector) as Node[], [nodes, gesture, projector, overlayVersion]); // eslint-disable-line react-hooks/exhaustive-deps
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
  return (
    <Profiler id="canvas-scene" onRender={onCommit}>
      <ReactFlow nodes={projected} {...flowProps}>
        <CanvasZoomStyle />
        {children}
      </ReactFlow>
    </Profiler>
  );
}
