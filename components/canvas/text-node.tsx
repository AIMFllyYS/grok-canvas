"use client";

import { NodeResizer, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { FileText } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { NodeSurface } from "@/components/ui/node-surface";
import { NodeActions } from "./node-actions";
import { NodeTitle } from "./node-title";
import { PlusHandle } from "./image-node";

export type TextNodeData = { name: string; content: string; [key: string]: unknown };
export type TextFlowNode = Node<TextNodeData, "canvasText">;

export function TextNode({ id, data, selected, draggable }: NodeProps<TextFlowNode>) {
  const zoom = useStore(state => state.transform[2]);
  return <div className="group relative h-full w-full">
    <NodeActions id={id} name={data.name} selected={selected} pinned={draggable === false} />
    <NodeResizer isVisible={selected} minWidth={200} minHeight={120} maxWidth={3000} maxHeight={3000}
      lineClassName="canvas-text-resize !border-primary/60" handleClassName="!h-2 !w-2 !rounded-full !border !border-primary !bg-background" />
    <PlusHandle type="target" position={Position.Left} className={selected ? "!opacity-100" : ""} />
    <PlusHandle type="source" position={Position.Right} className={selected ? "!opacity-100" : ""} />
    <div className="absolute -top-7 left-0 flex cursor-grab items-center gap-1.5">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <NodeTitle nodeId={id} name={data.name} />
    </div>
    <NodeSurface selected={selected} zoom={zoom} className="h-full w-full bg-card p-4">
      {/* 正文占比铺满卡片，所以不能再标 .nodrag：React Flow 会丢弃落在 .nodrag 元素内的按下点，
          整块标注就等于只剩 16px 内边距和标题条能拖。滚动改由 nowheel 保证。 */}
      <div className="nowheel h-full overflow-auto text-sm text-foreground" aria-label="文本节点内容">
        <MessageResponse mode="static">{data.content || ""}</MessageResponse>
      </div>
    </NodeSurface>
  </div>;
}
