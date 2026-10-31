/**
 * 预显示协调器（P5-02）：给预显示条目算出画面位置。
 * - 新增条目没有显式坐标时，用与服务端 add_canvas_nodes 相同的流程排版（layoutFlowNodes，append 模式）估算，
 *   from 可以是已有节点 ID 或同一调用里的 ref；所以占位出现在正式节点将要出现的位置附近，不再全部堆在原点；
 * - 修改/待删除标记覆盖在目标节点的当前矩形上；目标不在画布中的标记不显示；
 * - 只计算位置，不写任何正式数据。
 */
import { layoutFlowNodes, type FlowLayoutNode } from "../node-placement";
import type { PreviewEntry } from "./preview-store";

export type PlacedPreview = PreviewEntry & { x: number; y: number; width: number; height: number };

export function placePreviews(entries: readonly PreviewEntry[], nodes: readonly FlowLayoutNode[], edges: readonly { source: string; target: string }[]): PlacedPreview[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const out: PlacedPreview[] = [];
  const groups = new Map<string, PreviewEntry[]>();
  for (const entry of entries) {
    if (entry.kind === "add") {
      if (entry.explicit) { out.push(entry); continue; }
      const list = groups.get(entry.toolCallId) ?? [];
      list.push(entry);
      groups.set(entry.toolCallId, list);
      continue;
    }
    const target = entry.targetId ? byId.get(entry.targetId) : undefined;
    if (!target) continue;
    const width = target.width ?? target.measured?.width ?? 280, height = target.height ?? target.measured?.height ?? 240;
    out.push({ ...entry, x: target.position.x, y: target.position.y, width, height });
  }
  for (const [toolCallId, group] of groups) {
    const draftId = (entry: PreviewEntry) => `preview:${toolCallId}:${entry.itemIndex}`;
    const byRef = new Map(group.filter(entry => entry.ref).map(entry => [entry.ref!, draftId(entry)]));
    const drafts: FlowLayoutNode[] = group.map(entry => ({ id: draftId(entry), type: entry.nodeType ?? "image", position: { x: 0, y: 0 }, width: entry.width, height: entry.height }));
    const links: Array<{ source: string; target: string }> = [];
    for (const entry of group) for (const from of entry.from ?? []) {
      const source = byRef.get(from) ?? (byId.has(from) ? from : undefined);
      if (source) links.push({ source, target: draftId(entry) });
    }
    let positions: Map<string, { x: number; y: number }>;
    try { positions = layoutFlowNodes({ nodes: [...nodes, ...drafts], edges: [...edges, ...links] }, drafts, { mode: "append" }); }
    catch { positions = new Map(); }
    for (const entry of group) {
      const at = positions.get(draftId(entry)) ?? { x: entry.x, y: entry.y };
      out.push({ ...entry, x: at.x, y: at.y });
    }
  }
  return out;
}
