/**
 * React Flow 场景投影与几何命令适配（P2-06，contracts.md C1/C3/C7）。
 * - projectScene：正式工作文档 + 手势覆盖层 → React Flow nodes。只为参与节点新建对象，
 *   其他节点与所有 data 引用保持不变；无变化时返回同一数组。
 * - routeNodeChanges：onNodesChange 分流。拖动/resize 进行中只进覆盖层；选择、自然测量、增删进正式文档。
 * - 确认几何缓存：服务端实体快照 + 回执，提供 move_nodes 的 expectedVersion 与 from，
 *   并按未确认命令预测下一次的前置版本。
 * 纯模块，不依赖 React。
 */
import type { CanvasOperation } from "../canvas-operations";
import type { GestureItem, GestureKind, GestureResult, GestureStore } from "./gesture-store";
import { historyReaderFromSnapshot, type HistoryReader } from "./history";
import { getNodeType, NODE_REGISTRY } from "./node-registry";
import type { CommitReceipt, DocumentRecord, EdgeRecord, Geometry, NodeSummary } from "./types";

type Point = { x: number; y: number };
export type FlowNodeLike = {
  id: string;
  type?: string;
  position: Point;
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  data: Record<string, unknown>;
  dragging?: boolean;
  resizing?: boolean;
};
type NodeChangeLike = {
  type: string;
  id?: string;
  position?: Point;
  dragging?: boolean;
  resizing?: boolean;
  dimensions?: { width?: number; height?: number };
  setAttributes?: boolean | "width" | "height";
  [key: string]: unknown;
};
export type MoveItem = { nodeId: string; expectedVersion: number; from: Geometry; to: Geometry };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
export const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const copy = (g: Geometry): Geometry => ({ x: g.x, y: g.y, width: g.width, height: g.height });

/** 画面上的几何：显式尺寸 > 测量尺寸 > 节点类型默认尺寸（与 convertLegacyNode 的回退一致）。 */
export function displayGeometry(node: FlowNodeLike): Geometry {
  const fallback = (node.type && getNodeType(node.type)?.defaultSize) || NODE_REGISTRY.image.defaultSize;
  return {
    x: node.position.x,
    y: node.position.y,
    width: positive(node.width) ? node.width : positive(node.measured?.width) ? node.measured!.width! : fallback.width,
    height: positive(node.height) ? node.height : positive(node.measured?.height) ? node.measured!.height! : fallback.height,
  };
}

/** 把一次几何写回旧节点：拖动只改位置；resize 写显式尺寸。 */
export function applyFlowGeometry<T extends FlowNodeLike>(node: T, geometry: Geometry, options: { size: boolean }): T {
  const next = { ...node, position: { x: geometry.x, y: geometry.y } } as T;
  if (options.size) { next.width = geometry.width; next.height = geometry.height; }
  return next;
}

// ---------------------------------------------------------------- 投影

type GestureReader = Pick<GestureStore, "version" | "participants" | "get" | "kind">;

export function createSceneProjector<T extends FlowNodeLike>() {
  let lastFormal: readonly T[] | null = null;
  let lastVersion = -1;
  let lastOut: readonly T[] | null = null;
  let index = new Map<string, number>();
  const cache = new Map<string, { source: T; overlay: Geometry; out: T }>();
  const stats = { projections: 0, created: 0, reused: 0 };
  return {
    project(formal: readonly T[], gesture: GestureReader): readonly T[] {
      const version = gesture.version();
      if (formal === lastFormal && version === lastVersion && lastOut) return lastOut;
      stats.projections++;
      if (formal !== lastFormal) index = new Map(formal.map((node, i) => [node.id, i]));
      const ids = gesture.participants();
      const kind = gesture.kind();
      lastFormal = formal;
      lastVersion = version;
      if (!ids.length || !kind) {
        cache.clear();
        lastOut = formal;
        return formal;
      }
      const out = formal.slice();
      const live = new Set<string>();
      for (const id of ids) {
        const at = index.get(id);
        const overlay = gesture.get(id);
        if (at === undefined || !overlay) continue;
        live.add(id);
        const source = formal[at]!;
        const cached = cache.get(id);
        if (cached && cached.source === source && sameGeometry(cached.overlay, overlay)) {
          out[at] = cached.out;
          stats.reused++;
          continue;
        }
        const projected = applyFlowGeometry(source, overlay, { size: kind === "resize" });
        if (kind === "drag") projected.dragging = true;
        else projected.resizing = true;
        cache.set(id, { source, overlay: copy(overlay), out: projected });
        out[at] = projected;
        stats.created++;
      }
      for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
      lastOut = out;
      return out;
    },
    stats: () => ({ ...stats }),
  };
}

export type SceneProjector<T extends FlowNodeLike> = ReturnType<typeof createSceneProjector<T>>;

/** 函数式入口：正式文档 + 视图（选择/测量已在正式工作文档中）+ 手势 → React Flow nodes。 */
export function projectScene<T extends FlowNodeLike>(formal: readonly T[], gesture: GestureReader, projector: SceneProjector<T>): readonly T[] {
  return projector.project(formal, gesture);
}

// ---------------------------------------------------------------- onNodesChange 分流

export type RoutedChanges<C> = {
  /** 应用到正式工作文档的变化（选择、自然测量、增删、replace）。 */
  formal: C[];
  /** 交给 change-tracker 的变化：手势只登记开始/结束，不再因坐标/尺寸标脏旧保存。 */
  tracker: NodeChangeLike[];
  /** 全部参与者都已松手，调用方应结束手势并提交。 */
  finished: boolean;
  /** 非手势的离散移动（键盘方向键），立即作为一次移动提交。 */
  discrete: GestureItem[];
};

export function routeNodeChanges<C extends NodeChangeLike>(
  changes: readonly C[],
  gesture: GestureStore,
  lookup: (id: string) => Geometry | undefined,
): RoutedChanges<C> {
  const formal: C[] = [];
  const tracker: NodeChangeLike[] = [];
  const discrete: GestureItem[] = [];
  const updates: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }> = [];
  let finished = false;
  const join = (kind: GestureKind, id: string): boolean => {
    if (gesture.has(id)) return gesture.kind() === kind;
    const geometry = lookup(id);
    if (!geometry) return false;
    if (!gesture.active()) { gesture.begin(kind, [{ id, geometry }]); return true; }
    if (gesture.kind() !== kind) return false;
    gesture.include([{ id, geometry }]);
    return true;
  };
  for (const change of changes) {
    const id = change.id ?? "";
    if (change.type === "position") {
      if (change.dragging === true) {
        if (join("drag", id)) {
          if (change.position) updates.push({ id, x: change.position.x, y: change.position.y });
          tracker.push({ type: "position", id, dragging: true });
          continue;
        }
      } else if (change.dragging === false) {
        if (gesture.has(id)) {
          if (change.position) updates.push({ id, x: change.position.x, y: change.position.y });
          tracker.push({ type: "position", id, dragging: false });
          finished = gesture.finish(id) || finished;
          continue;
        }
        // 已收尾的手势迟到的结束标记：只清逐节点手势锁，不标脏。
        tracker.push({ type: "position", id, dragging: false });
        continue;
      } else if (gesture.has(id)) {
        // 左上角 resize 同时改位置。
        if (change.position) updates.push({ id, x: change.position.x, y: change.position.y });
        continue;
      } else if (change.position) {
        const from = lookup(id);
        if (from) {
          discrete.push({ id, from, to: { ...from, x: change.position.x, y: change.position.y } });
          continue;
        }
      }
    } else if (change.type === "dimensions") {
      if (change.resizing === true && join("resize", id)) {
        updates.push({ id, width: change.dimensions?.width, height: change.dimensions?.height });
        tracker.push({ type: "dimensions", id, resizing: true });
        continue;
      }
      if (change.resizing === false && gesture.has(id) && gesture.kind() === "resize") {
        if (change.dimensions) updates.push({ id, width: change.dimensions.width, height: change.dimensions.height });
        tracker.push({ type: "dimensions", id, resizing: false });
        finished = gesture.finish(id) || finished;
        continue;
      }
    } else if (change.type === "remove") {
      gesture.drop(id);
    }
    formal.push(change);
    tracker.push(change);
  }
  if (updates.length) gesture.update(updates);
  return { formal, tracker, finished, discrete };
}

// ---------------------------------------------------------------- 旧保存 / 远端合并

const GEOMETRY_PATHS = new Set(["position", "width", "height"]);

/** 旧 operations 保存剥离受命令管理节点的几何；新增节点、未登记节点与其他字段照常发送。 */
export function withoutCommandGeometry(operations: readonly CanvasOperation[], managed: (nodeId: string) => boolean): CanvasOperation[] {
  return operations.filter(op => !(op.target === "node" && op.entityId && op.path.length > 0 && GEOMETRY_PATHS.has(op.path[0]!) && managed(op.entityId)));
}

/** 远端合并：已提交但未确认的本地几何不回弹，其余字段（正文等）取远端。 */
export function keepLocalGeometry<T extends FlowNodeLike>(remote: readonly T[], local: readonly T[], pending: (nodeId: string) => boolean): T[] {
  const byId = new Map(local.map(node => [node.id, node]));
  return remote.map(node => {
    if (!pending(node.id)) return node;
    const mine = byId.get(node.id);
    if (!mine) return node;
    const next = { ...node, position: { ...mine.position } } as T;
    if (positive(mine.width)) next.width = mine.width;
    if (positive(mine.height)) next.height = mine.height;
    return next;
  });
}

// ---------------------------------------------------------------- 确认几何缓存

export type ConfirmedSnapshot = {
  canvasId: string;
  revision: number;
  name: string;
  nameVersion: number;
  storageEpoch: string;
  nodes: readonly NodeSummary[];
  documents: readonly DocumentRecord[];
  edges: readonly EdgeRecord[];
  fieldVersions: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

export function createConfirmedGeometry(initial: ConfirmedSnapshot) {
  let snapshot = initial;
  let revision = initial.revision;
  const nodes = new Map<string, NodeSummary>();
  const predictions = new Map<string, { geometry: Geometry; geometryVersion: number }>();
  // P2-07：字段/正文/连线版本与未确认命令的预测。
  const fieldVersions = new Map<string, number>();
  const documentVersions = new Map<string, number>();
  const edges = new Map<string, EdgeRecord>();
  const predictedFields = new Map<string, number>();
  const predictedDocuments = new Map<string, number>();
  const predictedNodes = new Map<string, NodeSummary>();
  const predictedEdges = new Map<string, EdgeRecord>();
  const predictedRemovals = new Set<string>();
  const predictedEdgeRemovals = new Set<string>();
  const fieldKey = (id: string, field: string) => `${id}\u0000${field}`;
  const settle = () => {
    for (const [id, predicted] of predictions) {
      const node = nodes.get(id);
      if (!node || node.geometryVersion >= predicted.geometryVersion) predictions.delete(id);
    }
    for (const [key, version] of predictedFields) if ((fieldVersions.get(key) ?? 0) >= version || !nodes.has(key.split("\u0000")[0]!) && !predictedNodes.has(key.split("\u0000")[0]!)) predictedFields.delete(key);
    for (const [id, version] of predictedDocuments) if ((documentVersions.get(id) ?? -1) >= version) predictedDocuments.delete(id);
    for (const id of predictedNodes.keys()) if (nodes.has(id)) predictedNodes.delete(id);
    for (const id of predictedEdges.keys()) if (edges.has(id)) predictedEdges.delete(id);
    for (const id of predictedRemovals) if (!nodes.has(id)) predictedRemovals.delete(id);
    for (const id of predictedEdgeRemovals) if (!edges.has(id)) predictedEdgeRemovals.delete(id);
  };
  const load = (next: ConfirmedSnapshot) => {
    snapshot = next;
    revision = next.revision;
    nodes.clear();
    for (const node of next.nodes) nodes.set(node.id, node);
    fieldVersions.clear();
    for (const [nodeId, fields] of Object.entries(next.fieldVersions ?? {})) for (const [field, version] of Object.entries(fields)) fieldVersions.set(fieldKey(nodeId, field), version);
    documentVersions.clear();
    for (const document of next.documents) documentVersions.set(document.id, document.version);
    edges.clear();
    for (const edge of next.edges) edges.set(edge.id, edge);
    settle();
  };
  load(initial);
  const base = (id: string) => {
    const predicted = predictions.get(id);
    if (predicted) return predicted;
    const node = nodes.get(id);
    return node ? { geometry: node.geometry, geometryVersion: node.geometryVersion } : undefined;
  };
  const predictPayload = (kind: string, payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (kind === "batch") for (const item of (p.commands as Array<{ kind: string; payload: unknown }>)) predictPayload(item.kind, item.payload);
    else if (kind === "move_nodes") for (const item of p.items as MoveItem[]) predictions.set(item.nodeId, { geometry: copy(item.to), geometryVersion: item.expectedVersion + 1 });
    else if (kind === "patch_nodes") {
      for (const item of p.items as Array<{ nodeId: string; field: string; expectedVersion: number }>) {
        if (item.field === "content") {
          const documentId = (nodes.get(item.nodeId) ?? predictedNodes.get(item.nodeId))?.documentId;
          if (documentId) predictedDocuments.set(documentId, item.expectedVersion + 1);
        } else predictedFields.set(fieldKey(item.nodeId, item.field), item.expectedVersion + 1);
      }
    } else if (kind === "add_nodes") for (const node of (p.nodes as NodeSummary[])) predictedNodes.set(node.id, node);
    else if (kind === "delete_nodes") for (const item of p.items as Array<{ nodeId: string }>) predictedRemovals.add(item.nodeId);
    else if (kind === "edit_edges") {
      for (const edge of (p.add as EdgeRecord[])) predictedEdges.set(edge.id, edge);
      for (const item of (p.remove as Array<{ edgeId: string }>)) predictedEdgeRemovals.add(item.edgeId);
    }
  };
  return {
    load,
    get: (id: string) => nodes.get(id),
    has: (id: string) => nodes.has(id),
    /** 服务端已有、或已入队待确认新增，且未被本地待确认删除。 */
    known: (id: string) => (nodes.has(id) || predictedNodes.has(id)) && !predictedRemovals.has(id),
    edgeKnown: (id: string) => (edges.has(id) || predictedEdges.has(id)) && !predictedEdgeRemovals.has(id),
    getEdge: (id: string) => edges.get(id),
    /** move 的前置：未确认命令的预测优先，否则用服务端确认值。 */
    base,
    fieldVersion: (id: string, field: string) => predictedFields.get(fieldKey(id, field)) ?? fieldVersions.get(fieldKey(id, field)) ?? 0,
    documentVersion: (documentId: string) => predictedDocuments.get(documentId) ?? documentVersions.get(documentId) ?? 0,
    documentIdOf: (id: string) => (nodes.get(id) ?? predictedNodes.get(id))?.documentId ?? null,
    entityVersion: (id: string) => nodes.get(id)?.entityVersion ?? 0,
    edgeVersion: (id: string) => edges.get(id)?.version ?? 0,
    pending: (id: string) => predictions.has(id),
    /** 节点有任何未确认的本地命令（几何、字段、正文、新增）：远端合并时保留本地。 */
    nodePending(id: string) {
      if (predictions.has(id) || predictedNodes.has(id) || predictedRemovals.has(id)) return true;
      const documentId = nodes.get(id)?.documentId;
      if (documentId && predictedDocuments.has(documentId)) return true;
      const prefix = `${id}\u0000`;
      for (const key of predictedFields.keys()) if (key.startsWith(prefix)) return true;
      return false;
    },
    edgePending: (id: string) => predictedEdges.has(id) || predictedEdgeRemovals.has(id),
    pendingGeometry: () => new Map([...predictions].map(([id, p]) => [id, copy(p.geometry)])),
    predict(items: readonly MoveItem[]) {
      for (const item of items) predictions.set(item.nodeId, { geometry: copy(item.to), geometryVersion: item.expectedVersion + 1 });
    },
    predictCommand: (kind: string, payload: unknown) => predictPayload(kind, payload),
    unpredict(ids: Iterable<string>) { for (const id of ids) predictions.delete(id); },
    /** 丢弃全部非几何预测（冲突改基前调用，随后按改基后的命令重新预测）。 */
    clearPredictions() {
      predictedFields.clear(); predictedDocuments.clear(); predictedNodes.clear(); predictedEdges.clear();
      predictedRemovals.clear(); predictedEdgeRemovals.clear();
    },
    applyReceipt(receipt: CommitReceipt) {
      for (const node of receipt.delta.nodes) {
        const existing = nodes.get(node.id);
        if (!existing || node.entityVersion >= existing.entityVersion) nodes.set(node.id, node);
      }
      for (const id of receipt.delta.removedNodeIds) { nodes.delete(id); predictions.delete(id); }
      for (const document of receipt.delta.documents) documentVersions.set(document.id, Math.max(documentVersions.get(document.id) ?? 0, document.version));
      for (const id of receipt.delta.removedDocumentIds) documentVersions.delete(id);
      for (const edge of receipt.delta.edges) edges.set(edge.id, edge);
      for (const id of receipt.delta.removedEdgeIds) edges.delete(id);
      for (const ref of receipt.fieldVersions) {
        if (ref.target === "node" && ref.field !== "geometry" && ref.field !== "entity") fieldVersions.set(fieldKey(ref.id, ref.field), Math.max(fieldVersions.get(fieldKey(ref.id, ref.field)) ?? 0, ref.version));
        if (ref.target === "document") documentVersions.set(ref.id, Math.max(documentVersions.get(ref.id) ?? 0, ref.version));
      }
      revision = Math.max(revision, receipt.revision);
      settle();
    },
    revision: () => revision,
    storageEpoch: () => snapshot.storageEpoch,
    /** P2-04 历史读取器；predicted=true 时把未确认移动视为当前状态。 */
    reader(predicted = false): HistoryReader {
      const list = [...nodes.values()].map(node => {
        const p = predicted ? predictions.get(node.id) : undefined;
        return p ? { ...node, geometry: copy(p.geometry), geometryVersion: p.geometryVersion } : node;
      });
      return historyReaderFromSnapshot({ name: snapshot.name, nameVersion: snapshot.nameVersion, nodes: list, documents: snapshot.documents, edges: snapshot.edges, fieldVersions: snapshot.fieldVersions });
    },
  };
}

export type ConfirmedGeometry = ReturnType<typeof createConfirmedGeometry>;

/**
 * 手势结果 → move_nodes 条目。from/expectedVersion 取服务端确认几何（或未确认命令的预测）；
 * 拖动保持服务端尺寸（媒体节点的测量尺寸不提交），resize 才写新尺寸。服务端未知的节点交给旧路径。
 */
export function buildMoveItems(result: GestureResult | null, confirmed: Pick<ConfirmedGeometry, "base">): { items: MoveItem[]; unmanaged: string[] } {
  const items: MoveItem[] = [];
  const unmanaged: string[] = [];
  if (!result) return { items, unmanaged };
  for (const item of result.items) {
    const base = confirmed.base(item.id);
    if (!base) { unmanaged.push(item.id); continue; }
    const to = result.kind === "resize"
      ? copy(item.to)
      : { x: item.to.x, y: item.to.y, width: base.geometry.width, height: base.geometry.height };
    if (sameGeometry(to, base.geometry)) continue;
    items.push({ nodeId: item.id, expectedVersion: base.geometryVersion, from: copy(base.geometry), to });
  }
  return { items, unmanaged };
}
