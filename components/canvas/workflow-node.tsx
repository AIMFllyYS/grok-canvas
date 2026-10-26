"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FileText, Film, Library } from "lucide-react";
import { FileChip, WorkButton } from "@/components/pre/primitives";
import { MessageResponse } from "@/components/ai-elements/message";
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
      <FileChip name={data.name} kind="text"/>
      <div className="pre-workflow-body nodrag nopan nowheel"><MessageResponse mode="static">{data.text}</MessageResponse></div>
      <footer><span>{data.count} {data.stage === "source" ? "份素材" : "个镜头"}</span></footer>
      {data.assetName && (
        <a className="pre-button pre-button-secondary nodrag" href={`/api/assets/${data.assetName}`} download>
          {data.stage === "assembly" ? "下载成片" : "查看素材"}
        </a>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
