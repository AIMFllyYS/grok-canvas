/**
 * Partial 工具输入 → 只读预显示条目（P5-02）。
 * - 只读 SDK 已解析的 partial 对象（不对原始 JSON 逐 token 正则重解析），不猜还没出现的节点数量；
 * - 一个条目要有 type 才画占位；名称不全时用类型默认名，正文只取前 512 字符；
 * - 同一调用 100ms 内最多更新一次（条目数变化时立即更新）；
 * - edit_canvas_nodes：要修改的节点叠「正在修改」标记，要删除的节点叠「待删除」标记，都不改正式文档。
 */
import type { PreviewEntry } from "../canvas-runtime/preview-store";

export const PARTIAL_MERGE_MS = 100;
export const PREVIEW_EXCERPT = 512;

const DEFAULT_SIZE = { canvasText: { width: 360, height: 260 }, image: { width: 304, height: 264 }, video: { width: 304, height: 264 } } as const;
const DEFAULT_NAME = { canvasText: "文稿", image: "图片", video: "视频" } as const;
type Item = Record<string, unknown>;
const isType = (value: unknown): value is "image" | "video" | "canvasText" => value === "image" || value === "video" || value === "canvasText";

export function addEntries(canvasId: string, toolCallId: string, input: unknown): PreviewEntry[] {
  const nodes = (input as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: PreviewEntry[] = [];
  nodes.slice(0, 20).forEach((raw, index) => {
    const node = (raw ?? {}) as Item;
    if (!isType(node.type)) return;
    const type = node.type;
    const size = DEFAULT_SIZE[type];
    const explicit = typeof node.x === "number" && typeof node.y === "number";
    out.push({
      canvasId, toolCallId, itemIndex: index, kind: "add", nodeType: type,
      label: typeof node.name === "string" && node.name.trim() ? node.name.slice(0, 160) : DEFAULT_NAME[type],
      x: explicit ? (node.x as number) : 0, y: explicit ? (node.y as number) : 0,
      width: typeof node.width === "number" ? Math.min(Math.max(node.width, 200), 560) : size.width,
      height: typeof node.height === "number" ? Math.min(Math.max(node.height, 120), 1120) : size.height,
      status: "pending",
      explicit,
      ...(typeof node.ref === "string" ? { ref: node.ref } : {}),
      ...(Array.isArray(node.from) ? { from: (node.from as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 10) } : {}),
      ...(typeof node.content === "string" && node.content ? { excerpt: node.content.slice(0, PREVIEW_EXCERPT) } : {}),
    });
  });
  return out;
}

export function editEntries(canvasId: string, toolCallId: string, input: unknown): PreviewEntry[] {
  const value = (input ?? {}) as { updates?: unknown; remove?: unknown };
  const out: PreviewEntry[] = [];
  let index = 0;
  for (const raw of Array.isArray(value.updates) ? value.updates.slice(0, 30) : []) {
    const id = (raw as Item | null)?.id;
    if (typeof id === "string" && id) out.push({ canvasId, toolCallId, itemIndex: index++, kind: "edit", label: "Agent 正在修改", x: 0, y: 0, width: 0, height: 0, status: "pending", targetId: id });
  }
  for (const id of Array.isArray(value.remove) ? value.remove.slice(0, 30) : []) {
    if (typeof id === "string" && id) out.push({ canvasId, toolCallId, itemIndex: index++, kind: "remove", label: "待删除", x: 0, y: 0, width: 0, height: 0, status: "pending", targetId: id });
  }
  return out;
}

/** 每个调用 100ms 合并一次；条目数变化（新条目出现）立即放行。 */
export function createPartialGate(ms = PARTIAL_MERGE_MS) {
  const last = new Map<string, { at: number; count: number }>();
  return {
    allow(key: string, count: number, now: number): boolean {
      const previous = last.get(key);
      if (previous && previous.count === count && now - previous.at < ms) return false;
      last.set(key, { at: now, count });
      if (last.size > 200) last.delete(last.keys().next().value!);
      return true;
    },
    forget(key: string) { last.delete(key); },
  };
}
