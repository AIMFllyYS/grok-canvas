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

// ---------------------------------------------------------------------------------------------
// 流程布局：节点按连线从左到右分列（资料 → 脚本 → 分镜 → 成片），同列竖排、整列对齐上游中心，
// 连线因此只在相邻列之间短距离横向走，不绕回、不交叉成团。
// ---------------------------------------------------------------------------------------------

export type FlowLayoutNode = { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; measured?: { width?: number; height?: number }; data?: Record<string, unknown> };
export type FlowLayoutEdge = { source: string; target: string };
type Point = { x: number; y: number };
type Box = { width: number; height: number };

/** 列间留给曲线连线的横向空间。 */
export const FLOW_GAP_X = 200;
/** 同列卡片的纵向间距（不含标题条）。 */
export const FLOW_GAP_Y = 64;
/** 新的独立流程放在已有内容下方的距离。 */
export const FLOW_GROUP_GAP = 160;
/** 卡片上方的标题条（-top-7 + 图标）占位，碰撞与间距都要算上。 */
export const FLOW_TITLE_SPACE = 32;
const MEDIA_BOX = 280, EMPTY_IMAGE_BOX = 240;

function ratioOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [w, h] = value.split(":").map(Number);
  return w && h && w > 0 && h > 0 ? w / h : null;
}

/**
 * 画布上卡片的实际占地（与 image-node / video-node 的盒子规则一致）：文本用自身尺寸；
 * 媒体按比例取 280 的长边；图片比例为 auto 且未生成时是 240 的方形占位。
 */
export function flowNodeSize(node: FlowLayoutNode): Box {
  const measured = node.measured;
  if (node.type === "canvasText") return { width: node.width ?? measured?.width ?? 360, height: node.height ?? measured?.height ?? 260 };
  if (node.width && node.height) return { width: node.width, height: node.height };
  if (measured?.width && measured?.height) return { width: measured.width, height: measured.height };
  if (node.type === "image" || node.type === "video") {
    const ratio = ratioOf(node.data?.aspectRatio) ?? (node.type === "video" ? 16 / 9 : null);
    if (ratio === null) return node.data?.assetName ? { width: MEDIA_BOX, height: MEDIA_BOX } : { width: EMPTY_IMAGE_BOX, height: EMPTY_IMAGE_BOX };
    return ratio >= 1 ? { width: MEDIA_BOX, height: Math.round(MEDIA_BOX / ratio) } : { width: Math.max(120, Math.round(MEDIA_BOX * ratio)), height: MEDIA_BOX };
  }
  return { width: node.width ?? 280, height: node.height ?? 240 };
}

/**
 * 把 moving 中的节点按左→右分层流程排好，返回 id → 新位置；不在 moving 中的节点保持不动并被避让。
 * - 列号 = moving 内最长上游路径；有固定上游的节点至少放在其上游右侧 FLOW_GAP_X 处。
 * - 同列按上游中心的平均值排序（减少交叉），竖向堆叠后整列平移，使整体居中对齐上游。
 * - 没有上游的起点：arrange 模式保持第一列原来的左上角；append 模式放在已有内容下方左对齐。
 * - 与固定节点重叠时整列下移，不覆盖用户内容。
 */
export function layoutFlowNodes(
  canvas: { nodes: readonly FlowLayoutNode[]; edges: readonly FlowLayoutEdge[] },
  moving: readonly FlowLayoutNode[],
  options: { mode?: "append" | "arrange"; anchor?: Point } = {},
): Map<string, Point> {
  const movingIds = new Set(moving.map(node => node.id));
  const fixed = canvas.nodes.filter(node => !movingIds.has(node.id));
  const byId = new Map<string, FlowLayoutNode>();
  for (const node of fixed) byId.set(node.id, node);
  for (const node of moving) byId.set(node.id, node);
  const order = new Map(moving.map((node, index) => [node.id, index]));
  const parents = new Map<string, string[]>();
  for (const edge of canvas.edges) {
    if (!movingIds.has(edge.target) || !byId.has(edge.source) || edge.source === edge.target) continue;
    const list = parents.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    parents.set(edge.target, list);
  }

  // 列号：最长路径；环上的回边忽略（visiting 中的节点视作 0 层）。
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const parent of parents.get(id) ?? []) if (movingIds.has(parent)) value = Math.max(value, rankOf(parent) + 1);
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  const columns: FlowLayoutNode[][] = [];
  for (const node of moving) (columns[rankOf(node.id)] ??= []).push(node);

  const sizes = new Map(moving.map(node => [node.id, flowNodeSize(node)]));
  const placed = new Map<string, Point>();
  const rectOf = (id: string) => {
    const node = byId.get(id)!;
    const at = placed.get(id) ?? node.position;
    const size = sizes.get(id) ?? flowNodeSize(node);
    return { x: at.x, y: at.y, ...size };
  };
  const fixedRight = (id: string) => Math.max(...(parents.get(id) ?? []).filter(p => !movingIds.has(p)).map(p => { const r = rectOf(p); return r.x + r.width + FLOW_GAP_X; }), -Infinity);

  // 起点锚：arrange 保持原左上角；append 放在已有内容下方。
  let anchor = options.anchor;
  if (!anchor) {
    // 以第一列（起点）的左上角为锚：个别被拖乱的下游节点不会把整条流程拽走。
    const roots = columns.find(column => column?.length) ?? [];
    if (options.mode === "arrange" && roots.length) anchor = { x: Math.min(...roots.map(n => n.position.x)), y: Math.min(...roots.map(n => n.position.y)) };
    else if (fixed.length) {
      const rects = fixed.map(n => ({ ...n.position, ...flowNodeSize(n) }));
      anchor = { x: Math.min(...rects.map(r => r.x)), y: Math.max(...rects.map(r => r.y + r.height)) + FLOW_GROUP_GAP + FLOW_TITLE_SPACE };
    } else anchor = { x: 0, y: 0 };
  }

  // 障碍矩形已含 24 的外边距与标题条；查询命中即重叠。
  const obstacles = createSpatialIndex();
  const obstacleRects = fixed.map(node => { const size = flowNodeSize(node); return { x: node.position.x - 24, y: node.position.y - FLOW_TITLE_SPACE - 24, width: size.width + 48, height: size.height + FLOW_TITLE_SPACE + 48 }; });
  obstacleRects.forEach((rect, index) => obstacles.upsert(String(index), rect));

  let columnX = anchor.x, previousRight = -Infinity;
  for (const column of columns) {
    if (!column?.length) continue;
    const x = Math.max(previousRight === -Infinity ? anchor.x : previousRight, ...column.map(node => fixedRight(node.id)));
    columnX = Number.isFinite(x) ? x : anchor.x;
    // 期望中心：上游中心的平均值（上游已放好或固定）。
    const desired = new Map<string, number>();
    for (const node of column) {
      const ups = (parents.get(node.id) ?? []).filter(p => !movingIds.has(p) || placed.has(p));
      if (ups.length) desired.set(node.id, ups.reduce((sum, p) => { const r = rectOf(p); return sum + r.y + r.height / 2; }, 0) / ups.length);
    }
    const sorted = [...column].sort((a, b) => (desired.get(a.id) ?? Infinity) - (desired.get(b.id) ?? Infinity) || order.get(a.id)! - order.get(b.id)!);
    // 先按期望位置依次向下堆叠（不重叠），再整列平移使有期望的节点平均偏差为 0。
    const tops = new Map<string, number>();
    let cursor = -Infinity;
    for (const node of sorted) {
      const size = sizes.get(node.id)!;
      const want = desired.has(node.id) ? desired.get(node.id)! - size.height / 2 : (cursor === -Infinity ? anchor.y : cursor);
      const top = cursor === -Infinity ? want : Math.max(want, cursor);
      tops.set(node.id, top);
      cursor = top + size.height + FLOW_TITLE_SPACE + FLOW_GAP_Y;
    }
    const withDesire = sorted.filter(node => desired.has(node.id));
    let shift = withDesire.length ? withDesire.reduce((sum, node) => sum + desired.get(node.id)! - (tops.get(node.id)! + sizes.get(node.id)!.height / 2), 0) / withDesire.length : 0;
    // 与固定节点重叠时整列下移，直到该列每张卡片都落在障碍下方。
    for (let attempt = 0; attempt < 64; attempt++) {
      let needed = shift;
      for (const node of sorted) {
        const size = sizes.get(node.id)!, top = tops.get(node.id)! + shift;
        for (const hit of obstacles.query({ x: columnX, y: top - FLOW_TITLE_SPACE, width: size.width, height: size.height + FLOW_TITLE_SPACE })) {
          const r = obstacleRects[Number(hit)]!;
          needed = Math.max(needed, r.y + r.height + FLOW_TITLE_SPACE + FLOW_GAP_Y - 24 - tops.get(node.id)!);
        }
      }
      if (needed === shift) break;
      shift = needed;
    }
    for (const node of sorted) placed.set(node.id, { x: Math.round(columnX), y: Math.round(tops.get(node.id)! + shift) });
    previousRight = columnX + Math.max(...column.map(node => sizes.get(node.id)!.width)) + FLOW_GAP_X;
  }
  return placed;
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
