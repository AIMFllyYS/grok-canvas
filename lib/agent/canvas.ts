import { loadCanvas, saveCanvas, type CanvasDoc } from "../canvas-store";
import { resolveCanvasReferences } from "../canvas-references";
import { placeNewNode } from "../node-placement";
import { AgentError } from "./store";
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
  return c;
}
export async function mutateCanvas(id: string, edit: (doc: CanvasDoc) => void) {
  const c = await readCanvas(id);
  edit(c);
  const saved = await saveCanvas(c, c.revision);
  if (!saved) throw new AgentError("画布已更新，请重新读取后操作", 409);
  return saved;
}
export function addNodes(
  c: CanvasDoc,
  items: {
    type: "image" | "video" | "canvasText";
    name: string;
    prompt: string;
    content?: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
  }[],
) {
  const nodes = c.nodes as CanvasNode[];
  const added = items.map((item) => {
    const size = item.type === "canvasText" ? { width: item.width ?? 360, height: item.height ?? 260 } : { width: 304, height: 264 };
    const position = placeNewNode({ x: item.x ?? 0, y: item.y ?? 0 }, nodes, size);
    const n = {
      id: crypto.randomUUID(),
      type: item.type,
      position,
      ...(item.type === "canvasText" ? size : {}),
      data: item.type === "canvasText" ? { name: item.name, content: item.content ?? "" } : {
        name: item.name,
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
    nodes.push(n);
    return n;
  });
  return added;
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
      if (u.width !== undefined) n.width = u.width;
      if (u.height !== undefined) n.height = u.height;
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
      (!(source.type === "canvasText" || target.type === "canvasText") &&
        (!["image", "asset"].includes(source.type) || !["image", "video"].includes(target.type)))
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
  for (const n of copy.nodes as CanvasNode[])
    if (["image", "video"].includes(n.type))
      resolveCanvasReferences(
        n,
        copy.nodes as CanvasNode[],
        copy.edges as CanvasEdge[],
      );
  Object.assign(c, copy);
}
