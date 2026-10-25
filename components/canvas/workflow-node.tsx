"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FileText, Film, Library } from "lucide-react";
type WorkflowData = {
  name: string;
  text: string;
  stage: string;
  count: number;
  assetName?: string;
  [key: string]: unknown;
};
export function WorkflowNode({
  data,
}: NodeProps<Node<WorkflowData, "workflow">>) {
  const Icon =
    data.stage === "assembly"
      ? Film
      : data.stage === "source"
        ? Library
        : FileText;
  return (
    <div className="studio-workflow-node">
      <Handle type="target" position={Position.Left} />
      <div className="studio-eyebrow">
        <Icon size={14} /> {data.stage.toUpperCase()}
      </div>
      <h3>{data.name}</h3>
      <p>{data.text}</p>
      <span>
        {data.count} {data.stage === "source" ? "份素材" : "个镜头"}
      </span>
      {data.assetName && (
        <a className="nodrag" href={`/api/assets/${data.assetName}`} download>
          {data.stage === "assembly" ? "下载成片" : "查看素材"}
        </a>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
