/**
 * 按实体订阅的文档 Store（contracts.md C1）。持有正式实体与确认版本；
 * 手势覆盖、选择、相机、执行与预显示状态不在这里。
 * - 外部只拿到冻结对象，不暴露可修改 Map；无变化时 getter 返回同一引用。
 * - applyDelta 先在影子变更集上校验整批，全部通过后一次发布再通知。
 * - 订阅判定只比较版本与顶层引用，不做 JSON.stringify 或深比较。
 */
import { createGraphIndexes, emptyCounters, type GraphIndexes, type IndexCounters } from "./indexes";
import type { CanvasRect } from "./spatial-index";
import type { Delta, DocumentRecord, EdgeRecord, Geometry, NodeSummary, Subscription } from "./types";

export type CanvasStoreSeed = {
  canvasId: string;
  revision: number;
  name?: string;
  nodes: readonly NodeSummary[];
  documents: readonly DocumentRecord[];
  edges: readonly EdgeRecord[];
};

export type StoreSnapshot = Readonly<{
  canvasId: string;
  revision: number;
  name: string;
  nodes: readonly NodeSummary[];
  documents: readonly DocumentRecord[];
  edges: readonly EdgeRecord[];
}>;

export type CanvasInfo = Readonly<{ id: string; name: string; revision: number }>;

export type ApplyDeltaResult = {
  revision: number;
  changedNodeIds: string[];
  removedNodeIds: string[];
  changedDocumentIds: string[];
  removedDocumentIds: string[];
  changedEdgeIds: string[];
  removedEdgeIds: string[];
  /** 主图 assetName 改变的节点的直接下游（outgoing 目标）。 */
  dependentNodeIds: string[];
  structural: boolean;
};

export class StoreDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreDeltaError";
  }
}

type Listener = () => void;

// ---------------------------------------------------------------- 冻结与引用复用

function deepFreezeCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy)) as T;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = deepFreezeCopy((value as Record<string, unknown>)[key]);
  return Object.freeze(copy) as T;
}

const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** 顶层逐键 Object.is；嵌套值来自已冻结的旧对象时即可复用。 */
function shallowSameData(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!Object.hasOwn(b, key) || !Object.is(a[key], b[key])) return false;
  return true;
}

function freezeNode(next: NodeSummary, previous?: NodeSummary): NodeSummary {
  const geometry = previous && sameGeometry(previous.geometry, next.geometry) ? previous.geometry : Object.freeze({ x: next.geometry.x, y: next.geometry.y, width: next.geometry.width, height: next.geometry.height });
  const data = previous && shallowSameData(previous.data, next.data) ? previous.data : deepFreezeCopy({ ...next.data });
  if (previous && geometry === previous.geometry && data === previous.data
    && previous.type === next.type && previous.schemaVersion === next.schemaVersion
    && previous.entityVersion === next.entityVersion && previous.geometryVersion === next.geometryVersion
    && previous.documentId === next.documentId && previous.canvasId === next.canvasId) return previous;
  return Object.freeze({
    id: next.id, canvasId: next.canvasId, type: next.type, schemaVersion: next.schemaVersion,
    geometry, entityVersion: next.entityVersion, geometryVersion: next.geometryVersion,
    documentId: next.documentId, data,
  });
}

function freezeDocument(next: DocumentRecord, previous?: DocumentRecord): DocumentRecord {
  if (previous && previous.content === next.content && previous.version === next.version && previous.nodeId === next.nodeId) return previous;
  return Object.freeze({ id: next.id, nodeId: next.nodeId, content: next.content, version: next.version });
}

function freezeEdge(next: EdgeRecord, previous?: EdgeRecord): EdgeRecord {
  if (previous && previous.source === next.source && previous.target === next.target && previous.role === next.role && previous.version === next.version && previous.canvasId === next.canvasId) return previous;
  return Object.freeze({ id: next.id, canvasId: next.canvasId, source: next.source, target: next.target, role: next.role, version: next.version });
}

// ---------------------------------------------------------------- 校验工具

const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (message: string): never => { throw new StoreDeltaError(message); };

function checkGeometry(id: string, geometry: Geometry) {
  if (!geometry || ![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) fail(`节点 ${id} 几何无效`);
}

// ---------------------------------------------------------------- Store

export function createCanvasStore(seed: CanvasStoreSeed) {
  const canvasId = seed.canvasId;
  let revision = seed.revision;
  let name = seed.name ?? "";
  let disposed = false;
  let counters: IndexCounters = emptyCounters();
  const nodes = new Map<string, NodeSummary>();
  const documents = new Map<string, DocumentRecord>();
  const edges = new Map<string, EdgeRecord>();
  let indexes: GraphIndexes = createGraphIndexes(counters);

  const nodeListeners = new Map<string, Set<{ fn: Listener }>>();
  const documentListeners = new Map<string, Set<{ fn: Listener }>>();
  const edgeListeners = new Map<string, Set<{ fn: Listener }>>();
  const structureListeners = new Set<{ fn: Listener }>();
  const canvasListeners = new Set<{ fn: Listener }>();
  let subscriptionCount = 0;

  let nodeIds: readonly string[] = Object.freeze([]);
  let edgeIds: readonly string[] = Object.freeze([]);
  let snapshotCache: StoreSnapshot | null = null;
  let canvasCache: CanvasInfo | null = null;

  const rebuildNodeIds = () => { counters.listRebuilds++; nodeIds = Object.freeze([...nodes.keys()]); };
  const rebuildEdgeIds = () => { counters.listRebuilds++; edgeIds = Object.freeze([...edges.keys()]); };
  const assertLive = () => { if (disposed) throw new StoreDeltaError("store 已 dispose"); };

  // 初始化：一次 O(N+E)。
  for (const raw of seed.nodes) {
    counters.nodeVisits++;
    if (raw.canvasId !== canvasId) fail(`节点 ${raw.id} 不属于画布 ${canvasId}`);
    if (nodes.has(raw.id)) fail(`节点 ID 重复：${raw.id}`);
    checkGeometry(raw.id, raw.geometry);
    const node = freezeNode(raw);
    nodes.set(node.id, node);
    indexes.upsertGeometry(node.id, node.geometry);
    indexes.updateAssets(node.id, node.data);
  }
  for (const raw of seed.documents) {
    if (!nodes.has(raw.nodeId)) fail(`文档 ${raw.id} 的节点不存在`);
    documents.set(raw.id, freezeDocument(raw));
  }
  for (const raw of seed.edges) {
    if (raw.canvasId !== canvasId) fail(`连线 ${raw.id} 不属于画布 ${canvasId}`);
    if (!nodes.has(raw.source) || !nodes.has(raw.target)) fail(`连线 ${raw.id} 端点不存在`);
    if (edges.has(raw.id)) fail(`连线 ID 重复：${raw.id}`);
    const edge = freezeEdge(raw);
    edges.set(edge.id, edge);
    indexes.addEdge(edge);
  }
  rebuildNodeIds();
  rebuildEdgeIds();

  function subscribeIn(map: Map<string, Set<{ fn: Listener }>>, id: string, fn: Listener): Subscription {
    assertLive();
    const token = { fn };
    let set = map.get(id);
    if (!set) { set = new Set(); map.set(id, set); }
    set.add(token);
    subscriptionCount++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = map.get(id);
      if (current?.delete(token)) {
        subscriptionCount--;
        if (!current.size) map.delete(id);
      }
    };
  }
  function subscribeSet(set: Set<{ fn: Listener }>, fn: Listener): Subscription {
    assertLive();
    const token = { fn };
    set.add(token);
    subscriptionCount++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (set.delete(token)) subscriptionCount--;
    };
  }

  function applyDelta(delta: Delta): ApplyDeltaResult {
    assertLive();
    // ---- 影子校验：不改任何状态。
    if (delta.canvasId !== canvasId) fail(`增量属于画布 ${delta.canvasId}，当前为 ${canvasId}`);
    if (delta.fromRevision !== revision) fail(`增量起点修订号 ${delta.fromRevision} 与当前 ${revision} 不一致`);
    if (!isVersion(delta.revision) || delta.revision < delta.fromRevision) fail("增量修订号无效");

    const requestedRemovals = new Set(delta.removedNodeIds);
    const removedNodes = new Set<string>();
    for (const id of requestedRemovals) if (nodes.has(id)) removedNodes.add(id);
    const upsertNodes = new Map<string, NodeSummary>();
    for (const raw of delta.nodes) {
      counters.nodeVisits++;
      if (raw.canvasId !== canvasId) fail(`节点 ${raw.id} 不属于画布 ${canvasId}`);
      if (upsertNodes.has(raw.id)) fail(`增量内节点重复：${raw.id}`);
      if (requestedRemovals.has(raw.id)) fail(`节点 ${raw.id} 同时被更新和删除`);
      if (!isVersion(raw.entityVersion) || !isVersion(raw.geometryVersion)) fail(`节点 ${raw.id} 版本无效`);
      checkGeometry(raw.id, raw.geometry);
      const existing = nodes.get(raw.id);
      if (existing && (raw.entityVersion < existing.entityVersion || raw.geometryVersion < existing.geometryVersion)) fail(`节点 ${raw.id} 版本回退`);
      upsertNodes.set(raw.id, raw);
    }
    const nodeExists = (id: string) => upsertNodes.has(id) || (nodes.has(id) && !removedNodes.has(id));
    const nodeAfter = (id: string) => upsertNodes.get(id) ?? (removedNodes.has(id) ? undefined : nodes.get(id));

    // 级联：被删节点的正文与入/出边。
    const removedEdges = new Set<string>();
    for (const id of delta.removedEdgeIds) if (edges.has(id)) removedEdges.add(id);
    const removedDocs = new Set<string>();
    for (const id of delta.removedDocumentIds) if (documents.has(id)) removedDocs.add(id);
    for (const id of removedNodes) {
      for (const edgeId of indexes.incidentEdgeIds(id)) removedEdges.add(edgeId);
      const documentId = nodes.get(id)!.documentId;
      if (documentId && documents.has(documentId)) removedDocs.add(documentId);
    }

    const upsertDocs = new Map<string, DocumentRecord>();
    for (const raw of delta.documents) {
      if (upsertDocs.has(raw.id)) fail(`增量内文档重复：${raw.id}`);
      if (removedDocs.has(raw.id)) fail(`文档 ${raw.id} 同时被更新和删除`);
      if (!isVersion(raw.version)) fail(`文档 ${raw.id} 版本无效`);
      const owner = nodeAfter(raw.nodeId);
      if (!owner) fail(`文档 ${raw.id} 的节点 ${raw.nodeId} 不存在`);
      if (owner!.documentId !== raw.id) fail(`文档 ${raw.id} 与节点 ${raw.nodeId} 的 documentId 不符`);
      const existing = documents.get(raw.id);
      if (existing && raw.version < existing.version) fail(`文档 ${raw.id} 版本回退`);
      upsertDocs.set(raw.id, raw);
    }
    for (const node of upsertNodes.values()) {
      if (node.documentId !== null && !upsertDocs.has(node.documentId) && !(documents.has(node.documentId) && !removedDocs.has(node.documentId))) fail(`节点 ${node.id} 的正文文档 ${node.documentId} 不存在`);
    }

    const upsertEdges = new Map<string, EdgeRecord>();
    for (const raw of delta.edges) {
      counters.edgeVisits++;
      if (raw.canvasId !== canvasId) fail(`连线 ${raw.id} 不属于画布 ${canvasId}`);
      if (upsertEdges.has(raw.id)) fail(`增量内连线重复：${raw.id}`);
      if (removedEdges.has(raw.id)) fail(`连线 ${raw.id} 同时被更新和删除`);
      if (raw.source === raw.target) fail(`连线 ${raw.id} 不能指向自身`);
      if (!nodeExists(raw.source) || !nodeExists(raw.target)) fail(`连线 ${raw.id} 的端点不存在`);
      if (!isVersion(raw.version)) fail(`连线 ${raw.id} 版本无效`);
      const existing = edges.get(raw.id);
      if (existing && raw.version < existing.version) fail(`连线 ${raw.id} 版本回退`);
      upsertEdges.set(raw.id, raw);
    }

    // ---- 发布：此后不再抛出校验错误。
    const changedNodes: string[] = [], changedDocs: string[] = [], changedEdges: string[] = [];
    const dependents = new Set<string>();
    let nodeStructure = false, edgeStructure = false;

    for (const id of removedEdges) {
      indexes.removeEdge(edges.get(id)!);
      edges.delete(id);
      edgeStructure = true;
    }
    for (const id of removedDocs) documents.delete(id);
    for (const id of removedNodes) {
      indexes.removeNode(id);
      nodes.delete(id);
      nodeStructure = true;
    }
    for (const raw of upsertNodes.values()) {
      const previous = nodes.get(raw.id);
      const next = freezeNode(raw, previous);
      if (next === previous) continue;
      nodes.set(next.id, next);
      changedNodes.push(next.id);
      if (!previous) {
        nodeStructure = true;
        indexes.upsertGeometry(next.id, next.geometry);
        indexes.updateAssets(next.id, next.data);
        continue;
      }
      if (next.geometry !== previous.geometry) indexes.upsertGeometry(next.id, next.geometry);
      if (next.data !== previous.data) {
        indexes.updateAssets(next.id, next.data);
        if (!Object.is(next.data.assetName, previous.data.assetName)) {
          for (const edgeId of indexes.outgoingIds(next.id)) {
            const target = (upsertEdges.get(edgeId) ?? edges.get(edgeId))?.target;
            if (target && target !== next.id) dependents.add(target);
          }
        }
      }
    }
    for (const raw of upsertDocs.values()) {
      const previous = documents.get(raw.id);
      const next = freezeDocument(raw, previous);
      if (next === previous) continue;
      documents.set(next.id, next);
      changedDocs.push(next.id);
    }
    for (const raw of upsertEdges.values()) {
      const previous = edges.get(raw.id);
      const next = freezeEdge(raw, previous);
      if (next === previous) continue;
      if (previous) indexes.removeEdge(previous);
      else edgeStructure = true;
      edges.set(next.id, next);
      indexes.addEdge(next);
      changedEdges.push(next.id);
    }

    const revisionChanged = delta.revision !== revision;
    const nameChanged = delta.name !== undefined && delta.name !== name;
    revision = delta.revision;
    if (nameChanged) name = delta.name!;
    if (nodeStructure) rebuildNodeIds();
    if (edgeStructure) rebuildEdgeIds();
    const anyChange = nodeStructure || edgeStructure || changedNodes.length || changedDocs.length || changedEdges.length || removedDocs.size;
    if (anyChange || revisionChanged || nameChanged) snapshotCache = null;
    if (revisionChanged || nameChanged) canvasCache = null;

    // ---- 通知：全部状态已发布；单个回调异常不阻断其他回调，结束后抛出第一个异常。
    const queue: Listener[] = [];
    const collect = (set: Set<{ fn: Listener }> | undefined) => { if (set) for (const token of set) queue.push(token.fn); };
    for (const id of [...changedNodes, ...removedNodes]) collect(nodeListeners.get(id));
    for (const id of [...changedDocs, ...removedDocs]) collect(documentListeners.get(id));
    for (const id of [...changedEdges, ...removedEdges]) collect(edgeListeners.get(id));
    if (nodeStructure || edgeStructure) collect(structureListeners);
    if (revisionChanged || nameChanged) collect(canvasListeners);
    let firstError: unknown = null;
    for (const fn of queue) {
      try { fn(); } catch (error) { firstError ??= error; }
    }
    const result: ApplyDeltaResult = {
      revision,
      changedNodeIds: changedNodes,
      removedNodeIds: [...removedNodes],
      changedDocumentIds: changedDocs,
      removedDocumentIds: [...removedDocs],
      changedEdgeIds: changedEdges,
      removedEdgeIds: [...removedEdges],
      dependentNodeIds: [...dependents].filter(id => nodes.has(id)),
      structural: nodeStructure || edgeStructure,
    };
    if (firstError) throw firstError;
    return result;
  }

  return {
    canvasId,
    getNode: (id: string): NodeSummary | undefined => nodes.get(id),
    getDocument: (id: string): DocumentRecord | undefined => documents.get(id),
    getEdge: (id: string): EdgeRecord | undefined => edges.get(id),
    getNodeIds: (): readonly string[] => nodeIds,
    getEdgeIds: (): readonly string[] => edgeIds,
    getRevision: () => revision,
    getCanvas(): CanvasInfo {
      return canvasCache ??= Object.freeze({ id: canvasId, name, revision });
    },
    getIncoming: (nodeId: string): string[] => indexes.incomingOf(nodeId),
    getOutgoing: (nodeId: string): string[] => indexes.outgoingOf(nodeId),
    getNodesUsingAsset: (assetName: string): string[] => indexes.nodesUsingAsset(assetName),
    queryRect: (rect: CanvasRect): string[] => indexes.query(rect),
    subscribeNode: (id: string, fn: Listener) => subscribeIn(nodeListeners, id, fn),
    subscribeDocument: (id: string, fn: Listener) => subscribeIn(documentListeners, id, fn),
    subscribeEdge: (id: string, fn: Listener) => subscribeIn(edgeListeners, id, fn),
    subscribeStructure: (fn: Listener) => subscribeSet(structureListeners, fn),
    subscribeCanvas: (fn: Listener) => subscribeSet(canvasListeners, fn),
    applyDelta,
    /** 稳定快照：只有实际变化后才重新物化数组。 */
    snapshot(): StoreSnapshot {
      if (snapshotCache) return snapshotCache;
      const nodeList = nodeIds.map(id => nodes.get(id)!);
      const documentList: DocumentRecord[] = [];
      for (const node of nodeList) if (node.documentId) { const record = documents.get(node.documentId); if (record) documentList.push(record); }
      snapshotCache = Object.freeze({
        canvasId, revision, name,
        nodes: Object.freeze(nodeList),
        documents: Object.freeze(documentList),
        edges: Object.freeze(edgeIds.map(id => edges.get(id)!)),
      });
      return snapshotCache;
    },
    stats() {
      return { nodes: nodes.size, edges: edges.size, documents: documents.size, subscriptions: subscriptionCount, ...counters, spatial: indexes.spatialStats() };
    },
    resetStats() {
      const fresh = emptyCounters();
      Object.assign(counters, fresh);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      nodeListeners.clear(); documentListeners.clear(); edgeListeners.clear();
      structureListeners.clear(); canvasListeners.clear();
      subscriptionCount = 0;
      indexes.clear();
      nodes.clear(); documents.clear(); edges.clear();
      snapshotCache = null; canvasCache = null;
      indexes = createGraphIndexes(counters = emptyCounters());
    },
  };
}

export type CanvasStore = ReturnType<typeof createCanvasStore>;
