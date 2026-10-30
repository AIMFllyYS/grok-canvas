import { createSpatialIndex, type CanvasRect } from "./canvas-runtime/spatial-index";

type PlacementNode = { position: { x: number; y: number }; width?: number; height?: number; measured?: { width?: number; height?: number } };

/** 一批插入只建一次几何索引；新节点立即加入，后续节点不会与它重叠。 */
export function createPlacementIndex(nodes: readonly PlacementNode[]) {
  const spatial = createSpatialIndex();
  let count = 0;
  let right = -Infinity;
  const add = (node: PlacementNode) => {
    const width = node.width ?? node.measured?.width ?? 280;
    spatial.upsert(String(count++), { ...node.position, width, height: node.height ?? node.measured?.height ?? 240 });
    right = Math.max(right, node.position.x + width + 24);
  };
  for (const node of nodes) add(node);
  return { add, rightmost: () => right, occupied: (rect: CanvasRect) => spatial.query(rect).length > 0 };
}

/** Keep newly inserted cards clear of existing cards while staying near the requested point. */
export function placeNewNode(at: { x: number; y: number }, nodes: PlacementNode[], size = { width: 304, height: 264 }, index?: ReturnType<typeof createPlacementIndex>) {
  for (let ring = 0; ring < 20; ring++) {
    const offsets = ring === 0 ? [[0, 0]] : [[ring * 320, 0], [0, ring * 280], [-ring * 320, 0], [0, -ring * 280], [ring * 320, ring * 280]];
    for (const [dx, dy] of offsets) {
      const point = { x: at.x + dx!, y: at.y + dy! };
      const occupied = index
        ? index.occupied({ x: point.x - 24, y: point.y - 24, width: size.width + 48, height: size.height + 48 })
        : nodes.some(n => point.x < n.position.x + (n.width ?? n.measured?.width ?? 280) + 24 && point.x + size.width + 24 > n.position.x && point.y < n.position.y + (n.height ?? n.measured?.height ?? 240) + 24 && point.y + size.height + 24 > n.position.y);
      if (!occupied) return point;
    }
  }
  let right = at.x;
  if (index) right = Math.max(right, index.rightmost());
  else for (const node of nodes) right = Math.max(right, node.position.x + (node.width ?? node.measured?.width ?? 280) + 24);
  return { x: right, y: at.y };
}
