/**
 * 只读预显示层（P2-09，contracts.md C7/C8）：按 toolCallId:itemIndex 保存轻量条目，不复用正式 Node 数组，
 * 不进入引用解析、素材扫描或历史。当前只处理已完整确认的工具输入与工具结果（partial-input 留 P5）。
 * 按画布隔离：切换画布后迟到的调用事件不会出现在另一画布。
 */
import { RUNTIME_BUDGET } from "./runtime-budget";
import { addEntries, createPartialGate, editEntries } from "../agent/preview-input";

export type PreviewEntry = {
  canvasId: string;
  toolCallId: string;
  itemIndex: number;
  kind: "add" | "edit" | "remove";
  nodeType?: "image" | "video" | "canvasText";
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: "pending" | "failed";
  /** 工具已返回正式节点 ID：该节点出现在画布后移除预显示。 */
  nodeId?: string;
  /** P5-02：模型显式给了坐标；否则由预显示协调器按流程排版估算位置。 */
  explicit?: boolean;
  ref?: string;
  from?: string[];
  /** 正文前 512 字符。 */
  excerpt?: string;
  /** edit/remove：被修改或待删除的已有节点。 */
  targetId?: string;
};

const keyOf = (toolCallId: string, itemIndex: number) => `${toolCallId}:${itemIndex}`;
const bytesOf = (entry: PreviewEntry) => 96 + entry.label.length * 2 + entry.toolCallId.length * 2 + (entry.excerpt?.length ?? 0) * 2;

export function createPreviewStore(limits: { items?: number; bytes?: number } = {}) {
  const maxItems = limits.items ?? RUNTIME_BUDGET.previewQueueItems;
  const maxBytes = limits.bytes ?? RUNTIME_BUDGET.previewQueueBytes;
  const canvases = new Map<string, Map<string, PreviewEntry>>();
  const snapshots = new Map<string, readonly PreviewEntry[]>();
  const listeners = new Set<() => void>();
  let bytes = 0, items = 0;
  let simplified = false;
  const changed = (canvasId: string) => { snapshots.delete(canvasId); for (const fn of [...listeners]) fn(); };
  const drop = (canvasId: string, key: string) => {
    const map = canvases.get(canvasId);
    const entry = map?.get(key);
    if (!map || !entry) return false;
    map.delete(key);
    bytes -= bytesOf(entry); items--;
    if (!map.size) canvases.delete(canvasId);
    return true;
  };
  return {
    /** 新增或替换一条预显示；超出容量时拒绝新条目并标记已简化（正式提交不受影响）。 */
    upsert(entry: PreviewEntry): boolean {
      const key = keyOf(entry.toolCallId, entry.itemIndex);
      let map = canvases.get(entry.canvasId);
      const previous = map?.get(key);
      const delta = bytesOf(entry) - (previous ? bytesOf(previous) : 0);
      if (!previous && (items + 1 > maxItems || bytes + delta > maxBytes)) { simplified = true; changed(entry.canvasId); return false; }
      if (!map) { map = new Map(); canvases.set(entry.canvasId, map); }
      map.set(key, Object.freeze({ ...entry }));
      bytes += delta;
      if (!previous) items++;
      changed(entry.canvasId);
      return true;
    },
    /** 成功/失败/取消：只清该调用（可指定条目），不影响其他调用。 */
    remove(canvasId: string, toolCallId: string, itemIndex?: number): number {
      const map = canvases.get(canvasId);
      if (!map) return 0;
      let count = 0;
      for (const [key, entry] of [...map]) if (entry.toolCallId === toolCallId && (itemIndex === undefined || entry.itemIndex === itemIndex)) { if (drop(canvasId, key)) count++; }
      if (count) changed(canvasId);
      if (items < maxItems / 2 && bytes < maxBytes / 2) simplified = false;
      return count;
    },
    clearCanvas(canvasId: string) { const map = canvases.get(canvasId); if (!map) return; for (const key of [...map.keys()]) drop(canvasId, key); changed(canvasId); },
    /** 稳定快照：同一画布无变化时返回同一数组（useSyncExternalStore 友好）。 */
    get(canvasId: string): readonly PreviewEntry[] {
      let snapshot = snapshots.get(canvasId);
      if (!snapshot) { snapshot = Object.freeze([...(canvases.get(canvasId)?.values() ?? [])]); snapshots.set(canvasId, snapshot); }
      return snapshot;
    },
    simplified: () => simplified,
    load: () => ({ items, bytes }),
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type PreviewStore = ReturnType<typeof createPreviewStore>;

/** 浏览器内单例：Agent 面板写入、画布场景读取。 */
const globals = globalThis as typeof globalThis & { __grokCanvasPreviewStore?: PreviewStore };
export const previewStore: PreviewStore = globals.__grokCanvasPreviewStore ??= createPreviewStore();

type ToolPartLike = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown };
type SchedulerLike = { schedule(task: { key: string; priority: number; run: () => void; bytes?: number }): unknown; flushTerminals(): number; cancelPrefix(prefix: string): number };
const PREVIEW_PRIORITY = 3, TERMINAL_PRIORITY = 1;

/**
 * Agent 工具调用 → 预显示条目（只读，P2-09 + P5-02）：
 * - input-streaming：按 SDK 已解析的 partial 输入画占位（每调用 100ms 合并），input-available 用完整输入覆盖；
 * - edit_canvas_nodes：被修改的节点叠「正在修改」，待删除的叠「待删除」，正式文档不变；
 * - output-available：新增条目拿到正式节点 ID，正式节点出现后由 CanvasPreview 移除；修改/删除标记直接移除；
 * - output-error/denied 立即移除（终态优先级，flushTerminals 同步执行），不留残影。
 */
const partialGate = createPartialGate();
export function bridgeToolPart(store: PreviewStore, canvasId: string, part: ToolPartLike, scheduler?: SchedulerLike, now: number = Date.now()): void {
  const toolCallId = part.toolCallId;
  if (!toolCallId) return;
  const terminal = (run: () => void) => {
    partialGate.forget(`${canvasId}:${toolCallId}`);
    if (!scheduler) { run(); return; }
    scheduler.cancelPrefix(`${canvasId}:${toolCallId}:`);
    scheduler.schedule({ key: `${canvasId}:${toolCallId}:terminal`, priority: TERMINAL_PRIORITY, run });
    scheduler.flushTerminals();
  };
  if (part.state === "output-error" || part.state === "output-denied") { terminal(() => store.remove(canvasId, toolCallId)); return; }
  if (part.state === "output-available") {
    if ((part as { preliminary?: boolean }).preliminary) return; // 执行阶段，不是最终结果
    const nodes = (part.output as { nodes?: Array<{ id?: unknown }> } | undefined)?.nodes;
    terminal(() => {
      const current = store.get(canvasId).filter(entry => entry.toolCallId === toolCallId);
      if (!current.length) return;
      for (const entry of current) {
        const nodeId = entry.kind === "add" && Array.isArray(nodes) ? nodes[entry.itemIndex]?.id : undefined;
        if (typeof nodeId === "string") store.upsert({ ...entry, nodeId });
        else store.remove(canvasId, toolCallId, entry.itemIndex);
      }
    });
    return;
  }
  if (part.state !== "input-available" && part.state !== "input-streaming") return;
  const entries = part.type === "tool-add_canvas_nodes" ? addEntries(canvasId, toolCallId, part.input)
    : part.type === "tool-edit_canvas_nodes" && part.state === "input-available" ? editEntries(canvasId, toolCallId, part.input)
    : [];
  if (!entries.length) return;
  if (part.state === "input-streaming" && !partialGate.allow(`${canvasId}:${toolCallId}`, entries.length, now)) return;
  for (const entry of entries) {
    if (store.get(canvasId).some(existing => existing.toolCallId === toolCallId && existing.itemIndex === entry.itemIndex && existing.nodeId)) continue;
    if (scheduler) scheduler.schedule({ key: `${canvasId}:${toolCallId}:${entry.itemIndex}`, priority: PREVIEW_PRIORITY, run: () => store.upsert(entry), bytes: bytesOf(entry) });
    else store.upsert(entry);
  }
}
