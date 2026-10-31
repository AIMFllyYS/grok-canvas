/**
 * 边的保守包围盒（P4-04）。画布连线是 React Flow 的贝塞尔曲线：源在节点右侧手柄、目标在左侧手柄，
 * 控制点沿水平方向偏移。贝塞尔曲线落在控制点凸包内，所以用两个端点与两个控制点的包围盒，
 * 宁可少量假阳性也不漏掉穿过视口的曲线。
 */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** PlusHandle 向外偏移 12px；端点再留 4px 余量。 */
export const HANDLE_OUTSET = 16;
const CURVATURE = 0.25;

/** 与 React Flow getBezierPath 的控制点偏移一致（calculateControlOffset）。 */
function controlOffset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

export const sourceHandle = (node: Rect): Point => ({ x: node.x + node.width + HANDLE_OUTSET, y: node.y + node.height / 2 });
export const targetHandle = (node: Rect): Point => ({ x: node.x - HANDLE_OUTSET, y: node.y + node.height / 2 });

/** 源→目标曲线的包围盒（含控制点）。线宽与命中区额外外扩 pad。 */
export function edgeBounds(source: Rect, target: Rect, pad = 8): Rect {
  const s = sourceHandle(source), t = targetHandle(target);
  const offset = controlOffset(t.x - s.x);
  const xs = [s.x, t.x, s.x + offset, t.x - offset];
  const ys = [s.y, t.y];
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

export function unionRect(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width); maxY = Math.max(maxY, r.y + r.height);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}
