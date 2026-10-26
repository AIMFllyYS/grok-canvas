import { isImageAssetName } from "./canvas-library";
import { parseVideoEdgeRole, referenceTokenMap, VIDEO_REFERENCE_MAX, type VideoInput, type VideoInputRole } from "./video-references";
import type { PromptReference } from "./prompt-references";

export const IMAGE_REFERENCE_MAX = 5;
export type ReferenceNode = { id: string; type?: string; data: Record<string, unknown> };
export type ReferenceEdge = { id?: string; source: string; target: string; data?: Record<string, unknown> };
export function isWorkflowControlEdge(edge:ReferenceEdge):boolean{return edge.data?.studioControl===true;}
export type ResolvedReferences = { assets: string[]; inputs: VideoInput[]; references: PromptReference[]; occupied: number; pending: number };

export function validateImageReferences(values: unknown): string[] {
  if (!Array.isArray(values) || !values.every(isImageAssetName)) throw new Error("参考图必须是有效的本地图片");
  const assets = [...new Set(values as string[])];
  if (assets.length > IMAGE_REFERENCE_MAX) throw new Error(`参考图最多 ${IMAGE_REFERENCE_MAX} 张`);
  return assets;
}

export function resolveCanvasReferences(node: ReferenceNode, nodes: ReferenceNode[], edges: ReferenceEdge[]): ResolvedReferences {
  const video = node.type === "video";
  const incoming = edges.filter(edge => edge.target === node.id&&!isWorkflowControlEdge(edge) && edge.data?.promptInput !== true && !["text", "prompt"].includes(nodes.find(n => n.id === edge.source)?.type ?? ""));
  const byId = new Map(nodes.map(source => [source.id, source]));
  const names = { ...node.data.attachmentNames as Record<string, string> | undefined };
  const inputs: VideoInput[] = [];
  const pendingRoles: VideoInputRole[] = [];
  const seen = new Map<string, VideoInputRole>();
  const add = (assetName: unknown, role: VideoInputRole, name?: unknown) => {
    if (!isImageAssetName(assetName)) throw new Error("来源不是可用的图片");
    const previous = seen.get(assetName);
    if (previous) {
      if (video && previous !== role) throw new Error("同一图片不能兼任首尾帧与参考图");
      return;
    }
    seen.set(assetName, role);
    inputs.push({ assetName, role });
    if (typeof name === "string" && name) names[assetName] = name;
  };
  for (const edge of incoming) {
    const source = byId.get(edge.source);
    const role = video ? parseVideoEdgeRole(edge.data?.role) : "reference";
    if (source?.data.assetName == null) { pendingRoles.push(role); continue; }
    add(source.data.assetName, role, source.data.name);
  }
  if (video) {
    for (const input of (node.data.uploadInputs as VideoInput[] | undefined) ?? []) add(input.assetName, parseVideoEdgeRole(input.role));
    referenceTokenMap(inputs);
    const allRoles = [...inputs.map(input => input.role), ...pendingRoles];
    if (allRoles.filter(role => role === "first").length > 1) throw new Error("首帧最多一张");
    if (allRoles.filter(role => role === "last").length > 1) throw new Error("尾帧最多一张");
    if (allRoles.filter(role => role === "reference").length > VIDEO_REFERENCE_MAX) throw new Error(`参考图最多 ${VIDEO_REFERENCE_MAX} 张（含未就绪连线）`);
  } else {
    for (const name of (node.data.uploadAttachments as string[] | undefined) ?? []) add(name, "reference");
    if (inputs.length + pendingRoles.length > IMAGE_REFERENCE_MAX) throw new Error(`参考图最多 ${IMAGE_REFERENCE_MAX} 张（含未就绪连线）`);
  }
  return {
    assets: inputs.map(input => input.assetName), inputs, pending: pendingRoles.length, occupied: inputs.length + pendingRoles.length,
    references: inputs.filter(input => input.role === "reference").map(input => ({ assetName: input.assetName, name: names[input.assetName] || "参考图" })),
  };
}

/** 返回一次性提交的节点补丁；任一项验证失败都不改变原输入。 */
export function addFixedReferences(node: ReferenceNode, nodes: ReferenceNode[], edges: ReferenceEdge[], references: PromptReference[], role: VideoInputRole = "reference"): Record<string, unknown> {
  if (node.type !== "image" && node.type !== "video") throw new Error("请先选择图片或视频节点");
  if (node.data.status === "running") throw new Error("生成期间不能修改参考图");
  const names = { ...node.data.attachmentNames as Record<string, string> | undefined };
  for (const item of references) {
    if (!isImageAssetName(item.assetName)) throw new Error("素材不是可用的图片");
    names[item.assetName] = item.name;
  }
  let patch: Record<string, unknown>;
  if (node.type === "video") {
    const inputs = [...((node.data.uploadInputs as VideoInput[] | undefined) ?? [])];
    for (const item of references) {
      const previous = inputs.find(input => input.assetName === item.assetName);
      if (previous && previous.role !== role) throw new Error("同一图片不能兼任首尾帧与参考图");
      if (!previous) inputs.push({ assetName: item.assetName, role });
    }
    patch = { uploadInputs: inputs, attachmentNames: names };
  } else {
    patch = { uploadAttachments: [...new Set([...((node.data.uploadAttachments as string[] | undefined) ?? []), ...references.map(item => item.assetName)])], attachmentNames: names };
  }
  resolveCanvasReferences({ ...node, data: { ...node.data, ...patch } }, nodes, edges);
  return patch;
}
