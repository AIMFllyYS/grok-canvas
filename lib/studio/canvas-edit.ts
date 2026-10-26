import { resolveCanvasReferences } from "../canvas-references";
import { isPromptNode } from "../prompt-nodes";
import type { CanvasDoc } from "../canvas-store";
type N = { id: string; type?: string; position: { x: number; y: number }; data: Record<string, unknown> };
type E = { id: string; source: string; target: string; type?: string; data?: Record<string, unknown> };
export type CanvasEdit = { updates: { id: string; name?: string; text?: string; prompt?: string; x?: number; y?: number }[]; remove: string[]; connect: { source: string; target: string; role?: "first" | "last" | "reference" }[]; disconnect: string[] };
/** Validate the complete change before persisting; project-managed media use director tools. */
export function editCanvasDocument(canvas: CanvasDoc, edit: CanvasEdit): CanvasDoc {
  let nodes = structuredClone(canvas.nodes) as N[], edges = structuredClone(canvas.edges) as E[];
  for (const id of edit.disconnect) {
    const edge = edges.find(e => e.id === id);
    if (!edge) throw new Error(`连线不存在：${id}`);
    if (nodes.some(n => (n.id === edge.source || n.id === edge.target) && n.data.studioProjectId)) throw new Error("导演台流程连线请通过分镜与参考绑定修改");
  }
  for (const id of [...edit.updates.map(u => u.id), ...edit.remove]) {
    const node = nodes.find(n => n.id === id);
    if (!node) throw new Error(`节点不存在：${id}`);
    if (node.data.studioProjectId) throw new Error("导演台管理的节点请通过脚本、参考图或分镜工具修改");
    if (node.data.status === "running" || node.data.taskId) throw new Error("节点正在生成，请等待完成");
  }
  for (const update of edit.updates) {
    const node = nodes.find(n => n.id === update.id)!;
    if (update.name !== undefined) node.data.name = update.name;
    if (update.text !== undefined) { if (!isPromptNode(node)) throw new Error("text 只适用于文本与提示词节点"); node.data.text = update.text; }
    if (update.prompt !== undefined) { if (!["image", "video"].includes(node.type ?? "")) throw new Error("prompt 只适用于图片与视频节点"); node.data.prompt = update.prompt; }
    if (update.x !== undefined) node.position.x = update.x;
    if (update.y !== undefined) node.position.y = update.y;
  }
  nodes = nodes.filter(n => !edit.remove.includes(n.id));
  edges = edges.filter(e => !edit.remove.includes(e.source) && !edit.remove.includes(e.target) && !edit.disconnect.includes(e.id));
  for (const connection of edit.connect) {
    const source = nodes.find(n => n.id === connection.source), target = nodes.find(n => n.id === connection.target);
    if (!source || !target || source.id === target.id) throw new Error("连线端点无效");
    if (!["image", "video"].includes(target.type ?? "")) throw new Error("目标必须是图片或视频节点");
    if (target.data.studioProjectId) throw new Error("请在导演台编辑此分镜的参考绑定");
    if (target.data.status === "running" || target.data.taskId) throw new Error("目标节点正在生成");
    if (!isPromptNode(source) && !["image", "asset"].includes(source.type ?? "")) throw new Error("来源必须是文本、提示词或图片节点");
    if (edges.some(e => e.source === source.id && e.target === target.id)) continue;
    edges.push({id:crypto.randomUUID(),source:source.id,target:target.id,type:"scissor",data:isPromptNode(source)?{promptInput:true}:target.type === "video"?{role:connection.role ?? "reference"}:{}});
  }
  for (const node of nodes.filter(n => n.type === "image" || n.type === "video")) resolveCanvasReferences(node, nodes, edges);
  return { ...canvas, nodes, edges };
}
