// 工具调用行的纯函数：节点名收集、一句话摘要、详情截断（无 React 依赖，便于测试）。
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const joinNames = (names: string[], max = 3) => names.slice(0, max).join("、") + (names.length > max ? ` 等 ${names.length} 个` : "");

/** 从整段对话收集 节点 ID → 名称。 */
export function collectNodeNames(messages: ReadonlyArray<{ parts: ReadonlyArray<{ type: string }> }>): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages)
    for (const part of message.parts) {
      if (!part.type.startsWith("tool-")) continue;
      const output = rec((part as { output?: unknown }).output);
      for (const node of list(output.nodes)) {
        const n = rec(node);
        const name = typeof n.name === "string" ? n.name : typeof rec(n.data).name === "string" ? String(rec(n.data).name) : null;
        if (typeof n.id === "string" && name) names.set(n.id, name);
      }
    }
  return names;
}

/** 一句话摘要：做了什么、对哪些节点。 */
export function summarizeTool(name: string, input: unknown, output: unknown, names: ReadonlyMap<string, string>): string {
  const i = rec(input), o = rec(output);
  const nodeName = (id: unknown) => (typeof id === "string" ? names.get(id) ?? "未命名节点" : "");
  switch (name) {
    case "read_canvas": {
      if (output === undefined) return "";
      const nodes = list(o.nodes).length, edges = list(o.edges).length;
      return nodes ? `${nodes} 个节点、${edges} 条连线` : "画布为空";
    }
    case "add_canvas_nodes": {
      const items = list(i.nodes).map(rec);
      const label = items.map(n => (typeof n.name === "string" ? n.name : n.type === "canvasText" ? "文稿" : n.type === "video" ? "视频" : "图片"));
      const connected = typeof o.connected === "number" && o.connected > 0 ? `，连线 ${o.connected} 条` : "";
      return label.length ? `${joinNames(label)}${connected}` : "";
    }
    case "edit_canvas_nodes": {
      const parts: string[] = [];
      const updates = list(i.updates).map(rec);
      if (updates.length) parts.push(`修改 ${joinNames(updates.map(u => nodeName(u.id)), 2)}`);
      if (list(i.connect).length) parts.push(`连线 ${list(i.connect).length} 条`);
      if (list(i.disconnect).length) parts.push(`断开 ${list(i.disconnect).length} 条`);
      if (list(i.remove).length) parts.push(`删除 ${list(i.remove).length} 个`);
      return parts.join("，");
    }
    case "arrange_canvas_nodes":
      return typeof o.moved === "number" ? (o.moved ? `移动 ${o.moved} 个节点` : "已经整齐") : `${list(i.nodeIds).length} 个节点`;
    case "attach_canvas_assets":
      return `${list(i.assets).length} 个素材 → ${nodeName(i.nodeId)}`;
    case "generate_image":
    case "generate_video":
    case "check_video_task":
      return nodeName(i.nodeId);
    default:
      return "";
  }
}

/** 展开详情里截断长文本，避免整段脚本或大 JSON 撑满对话。 */
export function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 280 ? `${value.slice(0, 280)}…（共 ${value.length} 字）` : value;
  if (Array.isArray(value)) return depth > 3 ? `[${value.length} 项]` : value.slice(0, 20).map(item => compactValue(item, depth + 1)).concat(value.length > 20 ? [`… 另 ${value.length - 20} 项`] : []);
  if (value && typeof value === "object") return depth > 3 ? "{…}" : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  return value;
}
