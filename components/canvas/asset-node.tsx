"use client";

import { memo } from "react";
import { sameNodeView } from "@/lib/canvas-runtime/node-view";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { AssetImage } from "@/components/ui/asset-image";
import { NodeSurface } from "@/components/ui/node-surface";
import { ImageIcon } from "lucide-react";
import { NodeActions } from "./node-actions";
import { NodeTitle } from "./node-title";
import { PlusHandle } from "./image-node";

export type AssetNodeData = {
  name: string;
  assetName: string;
  [key: string]: unknown;
};

export type AssetFlowNode = Node<AssetNodeData, "asset">;

/** Uploaded material: a pure image reference, no panel and no generation. */
export const AssetNode = memo(function AssetNode({ id, data, selected, draggable }: NodeProps<AssetFlowNode>) {
  return (
    <div className="group relative">
      <NodeActions id={id} name={data.name} assetName={data.assetName} selected={selected} pinned={draggable === false} />
      <PlusHandle type="target" position={Position.Left} className={selected ? "!opacity-100" : ""} />
      <PlusHandle type="source" position={Position.Right} className={selected ? "!opacity-100" : ""} />
      <div className="nodrag absolute -top-7 left-0 flex items-center gap-1.5">
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <NodeTitle nodeId={id} name={data.name} />
      </div>
      <NodeSurface selected={selected} className="w-[220px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <AssetImage
          src={`/api/assets/${data.assetName}`}
          alt={data.name}
          className="w-full object-contain"
        />
      </NodeSurface>
    </div>
  );
}, sameNodeView);
