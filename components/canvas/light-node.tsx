"use client";

import { memo } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import { FileText, Image as ImageIcon, Paperclip, Video } from "lucide-react";
import { PlusHandle } from "./image-node";

/**
 * 轻量节点（P4-05）：远景或超出完整预算时代替完整组件。只画轮廓、类型图标与名称；
 * 宽高由场景投影写入 style（与完整组件测得的尺寸相同），手柄与完整组件同一组件同一位置，
 * 所以切换层级不会移动节点或连线端点。不加载媒体、不渲染 Markdown、不挂播放器。
 */
const ICONS = { image: ImageIcon, video: Video, asset: Paperclip, canvasText: FileText } as const;

export const LightNode = memo(function LightNode({ type, data, selected }: NodeProps) {
  const kind = (type.startsWith("light-") ? type.slice(6) : type) as keyof typeof ICONS;
  const Icon = ICONS[kind] ?? FileText;
  const name = typeof data?.name === "string" ? data.name : "";
  return (
    <div
      className={`flex h-full w-full items-start gap-1.5 overflow-hidden rounded-xl border bg-card/70 p-2 text-xs text-muted-foreground ${selected ? "border-primary" : "border-border"}`}
      data-lod="light"
    >
      <PlusHandle type="target" position={Position.Left} />
      <PlusHandle type="source" position={Position.Right} />
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </div>
  );
});

export const LIGHT_NODE_TYPES = { "light-image": LightNode, "light-video": LightNode, "light-asset": LightNode, "light-canvasText": LightNode } as const;
