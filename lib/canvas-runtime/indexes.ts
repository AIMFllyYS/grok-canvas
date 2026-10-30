/**
 * 实体图的增量索引（contracts.md C1）：incoming/outgoing、素材反查与空间网格。
 * 初始化 O(N+E)；之后每个操作只触碰涉及的节点/连线，并累计访问计数供测试断言复杂度。
 * 计数只证明“没有遍历全图”，不代表帧率。
 */
import { createSpatialIndex, type CanvasRect } from "./spatial-index";
import type { EdgeRecord, Geometry } from "./types";

export type IndexCounters = {
  nodeVisits: number;
  edgeVisits: number;
  assetVisits: number;
  spatialUpserts: number;
  listRebuilds: number;
};

export const emptyCounters = (): IndexCounters => ({ nodeVisits: 0, edgeVisits: 0, assetVisits: 0, spatialUpserts: 0, listRebuilds: 0 });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** 节点 data 中引用的全部素材名：主图、候选、附件与视频输入。只读这一个节点。 */
export function nodeAssetNames(data: Readonly<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) names.add(value); };
  add(data.assetName);
  if (Array.isArray(data.results)) for (const item of data.results) if (isRecord(item)) add(item.assetName);
  if (Array.isArray(data.uploadAttachments)) for (const item of data.uploadAttachments) add(item);
  if (Array.isArray(data.uploadInputs)) for (const item of data.uploadInputs) if (isRecord(item)) add(item.assetName);
  return [...names];
}

const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(value);
};
const removeFrom = (map: Map<string, Set<string>>, key: string, value: string) => {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
};

export function createGraphIndexes(counters: IndexCounters) {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const assetReverse = new Map<string, Set<string>>();
  const nodeAssets = new Map<string, string[]>();
  const spatial = createSpatialIndex();

  const setAssets = (nodeId: string, next: string[]) => {
    for (const name of nodeAssets.get(nodeId) ?? []) removeFrom(assetReverse, name, nodeId);
    if (next.length) nodeAssets.set(nodeId, next); else nodeAssets.delete(nodeId);
    for (const name of next) addTo(assetReverse, name, nodeId);
  };

  return {
    upsertGeometry(nodeId: string, geometry: Geometry) {
      counters.spatialUpserts++;
      spatial.upsert(nodeId, geometry);
    },
    updateAssets(nodeId: string, data: Readonly<Record<string, unknown>>) {
      counters.assetVisits++;
      setAssets(nodeId, nodeAssetNames(data));
    },
    removeNode(nodeId: string) {
      spatial.remove(nodeId);
      setAssets(nodeId, []);
      incoming.delete(nodeId);
      outgoing.delete(nodeId);
    },
    addEdge(edge: EdgeRecord) {
      counters.edgeVisits++;
      addTo(outgoing, edge.source, edge.id);
      addTo(incoming, edge.target, edge.id);
    },
    removeEdge(edge: EdgeRecord) {
      counters.edgeVisits++;
      removeFrom(outgoing, edge.source, edge.id);
      removeFrom(incoming, edge.target, edge.id);
    },
    /** 删节点时用于级联；每条相关边计一次访问。 */
    incidentEdgeIds(nodeId: string): string[] {
      const ids = [...(incoming.get(nodeId) ?? []), ...(outgoing.get(nodeId) ?? [])];
      counters.edgeVisits += ids.length;
      return ids;
    },
    outgoingIds(nodeId: string): string[] {
      const ids = [...(outgoing.get(nodeId) ?? [])];
      counters.edgeVisits += ids.length;
      return ids;
    },
    incomingOf: (nodeId: string): string[] => [...(incoming.get(nodeId) ?? [])],
    outgoingOf: (nodeId: string): string[] => [...(outgoing.get(nodeId) ?? [])],
    nodesUsingAsset: (assetName: string): string[] => [...(assetReverse.get(assetName) ?? [])],
    query: (rect: CanvasRect): string[] => spatial.query(rect),
    /** dispose 时释放映射；空间网格随索引对象一起丢弃。 */
    clear() {
      incoming.clear(); outgoing.clear(); assetReverse.clear(); nodeAssets.clear();
    },
    spatialStats: () => spatial.stats(),
  };
}

export type GraphIndexes = ReturnType<typeof createGraphIndexes>;
