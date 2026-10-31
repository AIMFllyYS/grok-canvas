/**
 * 可见性索引（P4-04）：节点与边的均匀网格，回答「这个视口里有哪些节点/边」，与 DOM 和挂载状态无关。
 *
 * - 节点按画布坐标包围盒入桶；边按含控制点的保守包围盒入桶，两端都离屏但穿过视口的边也能查到；
 * - 移动一个节点只更新它自己和它的入/出边，不重建全部边；删除时清理空桶；
 * - queryViewport 在屏幕四周加 300px 预取带，pin（编辑/拖动/resize/连线起点）总在结果里；
 * - 超大查询（桶数超过节点数）退化为一次轻几何全量扫描，结果相同。
 */
import { edgeBounds, intersects, type Rect } from "./edge-index";

export type IndexedNode = { id: string; rect: Rect };
export type IndexedEdge = { id: string; source: string; target: string };
export type Viewport = { x: number; y: number; zoom: number };
export type ScreenSize = { width: number; height: number };
export type ViewportQuery = { nodeIds: Set<string>; edgeIds: Set<string>; pins: Set<string>; rect: Rect };

export const PREFETCH_PX = 300;
const CELL = 512;

/** 屏幕矩形（含预取带）换算到画布坐标。React Flow 视口：screen = canvas * zoom + (x, y)。 */
export function viewportRect(viewport: Viewport, screen: ScreenSize, prefetchPx = PREFETCH_PX): Rect {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: (-viewport.x - prefetchPx) / zoom,
    y: (-viewport.y - prefetchPx) / zoom,
    width: (screen.width + 2 * prefetchPx) / zoom,
    height: (screen.height + 2 * prefetchPx) / zoom,
  };
}

const cellsOf = (r: Rect) => {
  const x0 = Math.floor(r.x / CELL), y0 = Math.floor(r.y / CELL);
  const x1 = Math.floor((r.x + r.width) / CELL), y1 = Math.floor((r.y + r.height) / CELL);
  return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
};

export function createVisibilityIndex() {
  const nodes = new Map<string, { rect: Rect; keys: string[] }>();
  const edges = new Map<string, { edge: IndexedEdge; rect: Rect; keys: string[] }>();
  const edgesByNode = new Map<string, Set<string>>();
  const nodeCells = new Map<string, Set<string>>();
  const edgeCells = new Map<string, Set<string>>();
  let updates = 0;

  const put = (cells: Map<string, Set<string>>, rect: Rect, id: string) => {
    const { x0, y0, x1, y1 } = cellsOf(rect);
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = `${cx}:${cy}`;
      let set = cells.get(key);
      if (!set) { set = new Set(); cells.set(key, set); }
      set.add(id);
      keys.push(key);
    }
    return keys;
  };
  const drop = (cells: Map<string, Set<string>>, keys: string[], id: string) => {
    for (const key of keys) {
      const set = cells.get(key);
      if (!set) continue;
      set.delete(id);
      if (!set.size) cells.delete(key);
    }
  };

  function indexEdge(edge: IndexedEdge) {
    const old = edges.get(edge.id);
    if (old) drop(edgeCells, old.keys, edge.id);
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target) { edges.set(edge.id, { edge, rect: { x: 0, y: 0, width: 0, height: 0 }, keys: [] }); return; }
    const rect = edgeBounds(source.rect, target.rect);
    edges.set(edge.id, { edge, rect, keys: put(edgeCells, rect, edge.id) });
    updates++;
  }

  const link = (nodeId: string, edgeId: string) => { let set = edgesByNode.get(nodeId); if (!set) { set = new Set(); edgesByNode.set(nodeId, set); } set.add(edgeId); };
  const unlink = (nodeId: string, edgeId: string) => { const set = edgesByNode.get(nodeId); if (!set) return; set.delete(edgeId); if (!set.size) edgesByNode.delete(nodeId); };

  return {
    /** 插入或移动节点；只刷新该节点的入/出边。 */
    setNode(id: string, rect: Rect) {
      const old = nodes.get(id);
      if (old && old.rect.x === rect.x && old.rect.y === rect.y && old.rect.width === rect.width && old.rect.height === rect.height) return;
      if (old) drop(nodeCells, old.keys, id);
      nodes.set(id, { rect: { ...rect }, keys: put(nodeCells, rect, id) });
      updates++;
      for (const edgeId of edgesByNode.get(id) ?? []) { const entry = edges.get(edgeId); if (entry) indexEdge(entry.edge); }
    },
    removeNode(id: string) {
      const old = nodes.get(id);
      if (!old) return;
      drop(nodeCells, old.keys, id);
      nodes.delete(id);
      for (const edgeId of [...(edgesByNode.get(id) ?? [])]) { const entry = edges.get(edgeId); if (entry) indexEdge(entry.edge); }
    },
    setEdge(edge: IndexedEdge) {
      const old = edges.get(edge.id);
      if (old && old.edge.source === edge.source && old.edge.target === edge.target) return;
      if (old) { unlink(old.edge.source, edge.id); unlink(old.edge.target, edge.id); }
      link(edge.source, edge.id); link(edge.target, edge.id);
      indexEdge(edge);
    },
    removeEdge(id: string) {
      const old = edges.get(id);
      if (!old) return;
      drop(edgeCells, old.keys, id);
      unlink(old.edge.source, id); unlink(old.edge.target, id);
      edges.delete(id);
    },
    nodeRect: (id: string) => nodes.get(id)?.rect ?? null,
    edgeRect: (id: string) => edges.get(id)?.rect ?? null,
    hasNode: (id: string) => nodes.has(id),
    nodeIds: () => nodes.keys(),
    edgeIds: () => edges.keys(),
    /** 画布矩形内的节点与边（保守）。 */
    query(rect: Rect): { nodeIds: Set<string>; edgeIds: Set<string> } {
      const nodeIds = new Set<string>(), edgeIds = new Set<string>();
      const cells = cellsOf(rect);
      if (cells.count > Math.max(64, nodes.size)) {
        for (const [id, entry] of nodes) if (intersects(entry.rect, rect)) nodeIds.add(id);
        for (const [id, entry] of edges) if (entry.keys.length && intersects(entry.rect, rect)) edgeIds.add(id);
        return { nodeIds, edgeIds };
      }
      for (let cx = cells.x0; cx <= cells.x1; cx++) for (let cy = cells.y0; cy <= cells.y1; cy++) {
        const key = `${cx}:${cy}`;
        for (const id of nodeCells.get(key) ?? []) if (!nodeIds.has(id) && intersects(nodes.get(id)!.rect, rect)) nodeIds.add(id);
        for (const id of edgeCells.get(key) ?? []) if (!edgeIds.has(id) && intersects(edges.get(id)!.rect, rect)) edgeIds.add(id);
      }
      return { nodeIds, edgeIds };
    },
    /** 视口 + 预取带；pin 总在结果里（即使已离屏）。 */
    queryViewport(viewport: Viewport, screen: ScreenSize, pinnedIds: Iterable<string> = []): ViewportQuery {
      const rect = viewportRect(viewport, screen);
      const result = this.query(rect);
      const pins = new Set<string>();
      for (const id of pinnedIds) if (nodes.has(id)) { pins.add(id); result.nodeIds.add(id); }
      return { ...result, pins, rect };
    },
    /** 命中测试：画布点落在哪个节点上（后插入的在上层）。 */
    hit(point: { x: number; y: number }): string | null {
      const { nodeIds } = this.query({ x: point.x, y: point.y, width: 0, height: 0 });
      let found: string | null = null;
      for (const id of nodes.keys()) if (nodeIds.has(id)) found = id;
      return found;
    },
    stats: () => ({ nodes: nodes.size, edges: edges.size, nodeCells: nodeCells.size, edgeCells: edgeCells.size, updates }),
  };
}

export type VisibilityIndex = ReturnType<typeof createVisibilityIndex>;

/** 把一组 React Flow 节点/边同步进索引：只处理新增、移动、删除。 */
export function syncIndex(index: VisibilityIndex, nodes: Iterable<IndexedNode>, edges: Iterable<IndexedEdge>) {
  const seenNodes = new Set<string>(), seenEdges = new Set<string>();
  for (const node of nodes) { seenNodes.add(node.id); index.setNode(node.id, node.rect); }
  for (const id of [...index.nodeIds()]) if (!seenNodes.has(id)) index.removeNode(id);
  for (const edge of edges) { seenEdges.add(edge.id); index.setEdge(edge); }
  for (const id of [...index.edgeIds()]) if (!seenEdges.has(id)) index.removeEdge(id);
}
