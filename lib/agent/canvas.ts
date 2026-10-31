import { loadCanvas, publicCanvas, updateCanvas, type CanvasDoc } from "../canvas-store";
import { createReferenceIndex, resolveCanvasReferences } from "../canvas-references";
import { createPlacementIndex, flowNodeSize, layoutFlowNodes, placeNewNode } from "../node-placement";
import { AgentError } from "./store";
import { diffCanvasOperations } from "../canvas-operations";
import { editLeaseActive } from "../canvas-edit-leases";
// The standard media-node reference is 280 canvas units.
export const AGENT_TEXT_MAX_WIDTH = 560;
export const AGENT_TEXT_MAX_HEIGHT = 1120;
export type CanvasNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: Record<string, unknown>;
};
export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: Record<string, unknown>;
};
export async function readCanvas(id: string) {
  const c = await loadCanvas(id);
  if (!c) throw new AgentError("画布不存在", 404);
  // 命令元数据只属于服务端，不交给模型或工具结果。
  return publicCanvas(c);
}
export async function mutateCanvas(id: string, edit: (doc: CanvasDoc) => void) {
  const saved = await updateCanvas(id, (doc) => {
    const before = structuredClone(doc);
    edit(doc);
    for (const op of diffCanvasOperations(before, doc)) {
      if (op.target !== "node" || !op.entityId) continue;
      const fields = op.path.length === 0 ? ["content", "prompt"] : op.path[0] === "data" ? [op.path[1]] : [];
      for (const field of fields) if ((field === "content" || field === "prompt") && editLeaseActive(id, op.entityId, field)) throw new AgentError("用户正在编辑该节点内容，请稍后重试", 409);
    }
  });
  if (!saved) throw new AgentError("画布不存在", 404);
  return publicCanvas(saved);
}
export type AgentNodeInput = {
  type: "image" | "video" | "canvasText";
  name?: string;
  prompt: string;
  content?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** 本批内的临时代号，供后续条目的 from 引用。 */
  ref?: string;
  /** 上游：已有节点 ID 或本批的 ref；据此连线并按流程放在上游右侧。 */
  from?: string[];
};
export type AgentLink = { source: string; target: string };

/** 媒体参考只允许 图片/素材 → 图片/视频；涉及文本的连线只表示关系。 */
export function validAgentLink(source: { type: string }, target: { type: string }) {
  if (source.type === "canvasText" || target.type === "canvasText") return true;
  return ["image", "asset"].includes(source.type) && ["image", "video"].includes(target.type);
}

/**
 * 计算新增节点（不写库）：有上游或未给坐标的节点按左→右流程排布（layoutFlowNodes），
 * 只有显式给了坐标且没有上游的节点才按坐标就近避让。返回节点与要新建的连线。
 */
export function planAgentNodes(c: CanvasDoc, items: AgentNodeInput[], idFor: (index: number) => string = () => crypto.randomUUID()): { nodes: CanvasNode[]; links: AgentLink[] } {
  const existing = c.nodes as CanvasNode[];
  const byRef = new Map<string, string>();
  const drafts = items.map((item, index) => {
    const size = item.type === "canvasText"
      ? { width: Math.min(item.width ?? 360, AGENT_TEXT_MAX_WIDTH), height: Math.min(item.height ?? 260, AGENT_TEXT_MAX_HEIGHT) }
      : undefined;
    const n: CanvasNode = {
      id: idFor(index),
      type: item.type,
      position: { x: item.x ?? 0, y: item.y ?? 0 },
      ...(size ?? {}),
      data: item.type === "canvasText" ? { name: item.name ?? "文稿", content: item.content ?? "" } : {
        name: item.name ?? (item.type === "image" ? "图片" : "视频"),
        prompt: item.prompt,
        status: "idle",
        assetName: null,
        aspectRatio: "16:9",
        resolution: item.type === "video" ? "720p" : "1k",
        quality: "low",
        generationCount: 1,
        duration: 6,
        audio: false,
        uploadAttachments: [],
        uploadInputs: [],
      },
    };
    if (item.ref) {
      if (byRef.has(item.ref)) throw new AgentError(`ref 重复：${item.ref}`);
      byRef.set(item.ref, n.id);
    }
    return n;
  });
  const all = new Map<string, CanvasNode>([...existing.map((n) => [n.id, n] as const), ...drafts.map((n) => [n.id, n] as const)]);
  const links: AgentLink[] = [];
  items.forEach((item, index) => {
    for (const from of item.from ?? []) {
      const source = all.get(byRef.get(from) ?? from);
      const target = drafts[index]!;
      if (!source || source.id === target.id) throw new AgentError(`上游节点不存在：${from}`);
      if (!validAgentLink(source, target)) throw new AgentError("连线端点无效；图片可作为图片或视频参考，文本可连接任何节点");
      if (!links.some((l) => l.source === source.id && l.target === target.id)) links.push({ source: source.id, target: target.id });
    }
  });
  const linked = new Set(links.map((l) => l.target));
  const explicit = drafts.filter((n, i) => items[i]!.x !== undefined && items[i]!.y !== undefined && !linked.has(n.id));
  const flow = drafts.filter((n) => !explicit.includes(n));
  const placement = createPlacementIndex(existing);
  const settled = [...existing];
  for (const n of explicit) {
    n.position = placeNewNode(n.position, settled, flowNodeSize(n), placement);
    settled.push(n);
    placement.add(n);
  }
  if (flow.length) {
    const positions = layoutFlowNodes({ nodes: [...settled, ...flow], edges: [...(c.edges as CanvasEdge[]), ...links] }, flow, { mode: "append" });
    for (const n of flow) n.position = positions.get(n.id) ?? n.position;
  }
  return { nodes: drafts, links };
}

/** 本地副本上新增节点与连线（测试与旧路径使用；正式写入走 planAgentNodes + 命令）。 */
export function addNodes(c: CanvasDoc, items: AgentNodeInput[]) {
  const { nodes, links } = planAgentNodes(c, items);
  (c.nodes as CanvasNode[]).push(...nodes);
  if (links.length) editNodes(c, { updates: [], remove: [], connect: links, disconnect: [] });
  return nodes;
}

/** 重排指定节点为左→右流程；其余节点不动并被避让。正在生成的节点保持原位。 */
export function planArrangement(c: CanvasDoc, nodeIds: string[]) {
  const nodes = c.nodes as CanvasNode[];
  const ids = new Set(nodeIds);
  for (const id of ids) if (!nodes.some((n) => n.id === id)) throw new AgentError(`节点不存在：${id}`);
  const moving = nodes.filter((n) => ids.has(n.id) && n.data.status !== "running");
  const positions = layoutFlowNodes({ nodes, edges: c.edges as CanvasEdge[] }, moving, { mode: "arrange" });
  return moving.flatMap((n) => {
    const to = positions.get(n.id);
    return to && (to.x !== n.position.x || to.y !== n.position.y) ? [{ id: n.id, x: to.x, y: to.y }] : [];
  });
}
export function editNodes(
  c: CanvasDoc,
  edit: {
    updates: {
      id: string;
      name?: string;
      prompt?: string;
      content?: string;
      width?: number;
      height?: number;
      x?: number;
      y?: number;
    }[];
    remove: string[];
    connect: {
      source: string;
      target: string;
      role?: "first" | "last" | "reference";
    }[];
    disconnect: string[];
  },
) {
  const copy = structuredClone(c),
    nodes = copy.nodes as CanvasNode[];
  let edges = copy.edges as CanvasEdge[];
  for (const id of [...edit.updates.map((u) => u.id), ...edit.remove]) {
    const n = nodes.find((n) => n.id === id);
    if (!n) throw new AgentError(`节点不存在：${id}`);
    if (n.data.status === "running")
      throw new AgentError("节点正在生成，请稍后修改");
  }
  for (const u of edit.updates) {
    const n = nodes.find((n) => n.id === u.id)!;
    if (u.name !== undefined) n.data.name = u.name;
    if (u.content !== undefined || u.width !== undefined || u.height !== undefined) {
      if (n.type !== "canvasText") throw new AgentError("仅文本节点支持正文和调整尺寸");
      if (u.content !== undefined) n.data.content = u.content;
      if (u.width !== undefined) n.width = Math.min(u.width, AGENT_TEXT_MAX_WIDTH);
      if (u.height !== undefined) n.height = Math.min(u.height, AGENT_TEXT_MAX_HEIGHT);
    }
    if (u.prompt !== undefined) {
      if (!["image", "video"].includes(n.type))
        throw new AgentError("仅图片和视频节点支持提示词");
      n.data.prompt = u.prompt;
    }
    if (u.x !== undefined) n.position.x = u.x;
    if (u.y !== undefined) n.position.y = u.y;
  }
  copy.nodes = nodes.filter((n) => !edit.remove.includes(n.id));
  edges = edges.filter(
    (e) =>
      !edit.remove.includes(e.source) &&
      !edit.remove.includes(e.target) &&
      !edit.disconnect.includes(e.id),
  );
  for (const link of edit.connect) {
    const source = (copy.nodes as CanvasNode[]).find(
        (n) => n.id === link.source,
      ),
      target = (copy.nodes as CanvasNode[]).find((n) => n.id === link.target);
    if (
      !source ||
      !target ||
      source.id === target.id ||
      !validAgentLink(source, target)
    )
      throw new AgentError("连线端点无效；图片可作为图片或视频参考");
    const textLink = source.type === "canvasText" || target.type === "canvasText";
    if (!textLink && target.data.status === "running")
      throw new AgentError("目标节点正在生成");
    if (!edges.some((e) => e.source === source.id && e.target === target.id))
      edges.push({
        id: crypto.randomUUID(),
        source: source.id,
        target: target.id,
        type: "scissor",
        data: !textLink && target.type === "video" ? { role: link.role ?? "reference" } : {},
      });
  }
  copy.edges = edges;
  const referenceIndex = createReferenceIndex(copy.nodes as CanvasNode[], edges);
  for (const n of copy.nodes as CanvasNode[])
    if (["image", "video"].includes(n.type))
      resolveCanvasReferences(
        n,
        copy.nodes as CanvasNode[],
        copy.edges as CanvasEdge[],
        referenceIndex,
      );
  Object.assign(c, copy);
}
