"use client";
import { useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps, type Node } from "@xyflow/react";
import { FileText, SlidersHorizontal, Pencil, Check } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { FileChip, WorkButton } from "@/components/pre/primitives";
type TextData = { name: string; text: string; [key: string]: unknown };
export function TextNode({ id, data, type, selected }: NodeProps<Node<TextData>>) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const Icon = type === "prompt" ? SlidersHorizontal : FileText;
  return <article className="pre-text-node" data-selected={selected}>
    <header><Icon size={14}/><FileChip name={data.name} kind="text"/><WorkButton variant="ghost" className="nodrag" aria-label={editing ? "完成文本编辑" : "编辑文本节点"} onClick={() => setEditing(!editing)}>{editing ? <Check size={13}/> : <Pencil size={13}/>}</WorkButton></header>
    {editing ? <div className="pre-text-node-editor nodrag nopan nowheel"><input aria-label="文本节点名称" value={data.name} onChange={e => updateNodeData(id, { name: e.target.value })}/><textarea aria-label="文本节点内容" value={data.text} onChange={e => updateNodeData(id, { text: e.target.value })}/></div> : <div className="pre-text-node-body nodrag nopan nowheel"><MessageResponse mode="static">{data.text || (type === "prompt" ? "连接到图片或视频节点，作为提示词参数。" : "点击编辑，记录脚本、想法或素材说明。")}</MessageResponse></div>}
    <footer><span>{type === "prompt" ? "提示词参数" : "文本"}</span><span>{data.text.length} 字</span></footer><Handle type="source" position={Position.Right}/>
  </article>;
}
