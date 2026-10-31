/**
 * 完整图操作语义（P4-04）：框选、全选与适配视图都基于完整文档的几何，不依赖哪些节点挂载在 DOM 里。
 */
import { intersects, unionRect, type Rect } from "./edge-index";
import type { ScreenSize, Viewport, VisibilityIndex } from "./visibility";

const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** 框选：mode=full 要求节点完全在框内（React Flow 默认），partial 只要相交。 */
export function selectRegion(index: VisibilityIndex, rect: Rect, mode: "full" | "partial" = "full"): Set<string> {
  const out = new Set<string>();
  for (const id of index.query(rect).nodeIds) {
    const node = index.nodeRect(id);
    if (node && (mode === "partial" ? intersects(node, rect) : contains(rect, node))) out.add(id);
  }
  return out;
}

/** 全选只保存 ID 集合。 */
export function selectAll(ids: Iterable<string>): Set<string> {
  return new Set(ids);
}

/** 适配整张文档：汇总全部节点包围盒，计算能放下它的视口。空文档返回 null。 */
export function fitDocument(rects: Iterable<Rect>, screen: ScreenSize, options: { padding?: number; minZoom?: number; maxZoom?: number } = {}): Viewport | null {
  const bounds = unionRect(rects);
  if (!bounds || screen.width <= 0 || screen.height <= 0) return null;
  const padding = options.padding ?? 0.1;
  const minZoom = options.minZoom ?? 0.1, maxZoom = options.maxZoom ?? 2;
  const width = Math.max(bounds.width, 1), height = Math.max(bounds.height, 1);
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(screen.width / (width * (1 + 2 * padding)), screen.height / (height * (1 + 2 * padding)))));
  return {
    zoom,
    x: screen.width / 2 - (bounds.x + width / 2) * zoom,
    y: screen.height / 2 - (bounds.y + height / 2) * zoom,
  };
}
