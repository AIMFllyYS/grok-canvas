"use client";

import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowProps } from "@xyflow/react";
import type { GestureStore } from "@/lib/canvas-runtime/gesture-store";
import { createSceneProjector, projectScene } from "@/lib/canvas-runtime/scene-adapter";
import { CanvasZoomStyle } from "./canvas-zoom-style";

type CanvasSceneProps = Omit<ReactFlowProps<Node, Edge>, "nodes" | "children"> & {
  /** 正式工作文档：手势途中不变。 */
  nodes: Node[];
  gesture: GestureStore;
  children?: ReactNode;
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
  return (
    <ReactFlow nodes={projected} {...flowProps}>
      <CanvasZoomStyle />
      {children}
    </ReactFlow>
  );
}
