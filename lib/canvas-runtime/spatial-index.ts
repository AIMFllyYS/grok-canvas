export type CanvasRect = { x: number; y: number; width: number; height: number };
const CELL_SIZE = 512;
const MAX_ENTITY_CELLS = 64;
const MAX_QUERY_CELLS = 4096;
const overlaps = (a: CanvasRect, b: CanvasRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** 有界网格：超大实体独立保存，远景全域查询退化为一次扫描，不展开无限桶。 */
export function createSpatialIndex() {
  const rects = new Map<string, CanvasRect>();
  const buckets = new Map<string, Set<string>>();
  const memberships = new Map<string, string[]>();
  const overflow = new Set<string>();
  let lastQueryVisited = 0;
  function keys(rect: CanvasRect, limit: number): string[] | null {
    if (![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new Error("空间索引几何无效");
    const x0 = Math.floor(rect.x / CELL_SIZE), x1 = Math.floor((rect.x + rect.width) / CELL_SIZE);
    const y0 = Math.floor(rect.y / CELL_SIZE), y1 = Math.floor((rect.y + rect.height) / CELL_SIZE);
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > limit) return null;
    const result: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) result.push(`${x}:${y}`);
    return result;
  }
  function remove(id: string) {
    for (const key of memberships.get(id) ?? []) {
      const bucket = buckets.get(key)!;
      bucket.delete(id);
      if (!bucket.size) buckets.delete(key);
    }
    memberships.delete(id); overflow.delete(id); rects.delete(id);
  }
  function query(rect: CanvasRect): string[] {
    const cells = keys(rect, MAX_QUERY_CELLS);
    const candidates = cells ? new Set(overflow) : rects.keys();
    if (cells) for (const cell of cells) for (const id of buckets.get(cell) ?? []) (candidates as Set<string>).add(id);
    const result: string[] = [];
    lastQueryVisited = 0;
    for (const id of candidates) {
      lastQueryVisited++;
      if (overlaps(rects.get(id)!, rect)) result.push(id);
    }
    return result;
  }
  return {
    upsert(id: string, rect: CanvasRect) {
      const cells = keys(rect, MAX_ENTITY_CELLS);
      remove(id);
      rects.set(id, { ...rect });
      if (!cells) { overflow.add(id); return; }
      memberships.set(id, cells);
      for (const cell of cells) {
        let bucket = buckets.get(cell);
        if (!bucket) { bucket = new Set(); buckets.set(cell, bucket); }
        bucket.add(id);
      }
    },
    remove,
    query,
    size: () => rects.size,
    stats: () => ({ cells: buckets.size, overflow: overflow.size, lastQueryVisited }),
  };
}
