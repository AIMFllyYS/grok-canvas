/**
 * 细节层级（P4-05），带滞回避免在阈值附近来回切换：
 * - 缩放 < 0.30 进入远景（候选全部轻量），回到 ≥ 0.39 才退出；
 * - 视口候选 > 500 进入概览（Canvas2D 绘制，React Flow 只保留 pin），降到 < 350 才退出；
 * - 近景下最多 80 个完整组件：pin 优先，其余按到视口中心的距离；剩下的用轻量组件。
 * 轻量与完整组件使用相同宽高与手柄位置，切换层级不移动节点、不改持久尺寸。
 */
import type { Rect } from "./edge-index";

export type LodMode = "detail" | "light" | "overview";
export const LOD = { farEnter: 0.30, farExit: 0.39, overviewEnter: 500, overviewExit: 350, fullBudget: 80, lightTarget: 400 } as const;

export function createLodState() {
  let far = false;
  let overview = false;
  return {
    update(zoom: number, candidates: number): LodMode {
      if (!far && zoom < LOD.farEnter) far = true;
      else if (far && zoom >= LOD.farExit) far = false;
      if (!overview && candidates > LOD.overviewEnter) overview = true;
      else if (overview && candidates < LOD.overviewExit) overview = false;
      return overview ? "overview" : far ? "light" : "detail";
    },
    mode: (): LodMode => (overview ? "overview" : far ? "light" : "detail"),
  };
}

/** 分配完整组件：pin 全部保留（不计入裁剪），其余按距中心由近到远直到预算。 */
export function allocateFull(candidates: Iterable<{ id: string; rect: Rect }>, pins: ReadonlySet<string>, center: { x: number; y: number }, budget: number = LOD.fullBudget): Set<string> {
  const full = new Set<string>();
  const rest: Array<{ id: string; d: number }> = [];
  for (const { id, rect } of candidates) {
    if (pins.has(id)) { full.add(id); continue; }
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    rest.push({ id, d: (cx - center.x) ** 2 + (cy - center.y) ** 2 });
  }
  rest.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  for (const { id } of rest) {
    if (full.size >= budget && !pins.has(id)) break;
    full.add(id);
  }
  return full;
}

/** 视口是否已走出上次查询的范围（含预取带）或缩放变化足以影响层级，需要重新查询。 */
export function needsRequery(last: { rect: Rect; zoom: number } | null, visible: Rect, zoom: number): boolean {
  if (!last) return true;
  if (Math.abs(zoom - last.zoom) / last.zoom > 0.08) return true;
  const r = last.rect;
  return visible.x < r.x || visible.y < r.y || visible.x + visible.width > r.x + r.width || visible.y + visible.height > r.y + r.height;
}
