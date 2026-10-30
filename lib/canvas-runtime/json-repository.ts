/**
 * CommandRepository 的 JSON 兼容实现（contracts.md C2/C5 过渡）。
 * 复用画布写锁与原子整文件写：数据、回执、actor 水位、字段版本与 eventSeq 在一次写盘中落地。
 * 临时限制：每条命令都读写整份 CanvasDoc（O(N) IO）；命令执行器本身只按需转换涉及的实体。
 * SQL adapter（P3-05）直接实现同一 transact 能力，不再经过 CanvasDoc。
 */
import { commitCommandWrite, loadCanvas, type CanvasDoc } from "../canvas-store";
import { emptyCommandState, own, setOwn, deleteOwn, type CanvasCommandState, type NodeVersions, type StoredCommandResult } from "./command-state";
import { convertLegacyNode, deriveDocumentId, exportLegacyNode, fromCanvasDoc } from "./legacy-document";
import { isEmptyWriteSet, type EntityReader, type WriteSet } from "./command-reducer";
import type { CommandErrorCode, CommitReceipt, Delta, DocumentRecord, EdgeRecord, EdgeRole, NodeSummary } from "./types";

export type CommandRecordMeta = { commandId: string; actorId: string; actorSeq: number; hash: string };

export interface CommandTxn {
  readonly reader: EntityReader;
  readonly revision: number;
  readonly eventSeq: number;
  readonly storageEpoch: string;
  acceptedSeq(actorId: string): number;
  storedResult(commandId: string): StoredCommandResult | undefined;
  /** 提交写集（空写集即空变更）并记录回执；返回与落盘一致的回执。 */
  commit(writes: WriteSet, meta: CommandRecordMeta): CommitReceipt;
  /** 记录确定性拒绝：占用 actorSeq，同一命令重试得到同样的错误。 */
  reject(meta: CommandRecordMeta, error: { code: CommandErrorCode; message: string }): void;
}

export interface CommandRepository {
  /** 画布不存在/已删除时返回 null；edit 在画布写锁内同步执行。 */
  transact<T>(canvasId: string, edit: (txn: CommandTxn) => T): Promise<T | null>;
}

const ROLES = new Set<EdgeRole>(["first", "last", "reference"]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const versionsOf = (state: CanvasCommandState, id: string): NodeVersions => own(state.nodes, id) ?? { entity: 0, geometry: 0 };
const documentIdOf = (state: CanvasCommandState, nodeId: string) => own(state.documentIds, nodeId) ?? deriveDocumentId(nodeId);

/** 单次事务内对 CanvasDoc 的懒索引读取；只转换被访问的实体。 */
function createDocReader(doc: CanvasDoc, state: CanvasCommandState): EntityReader & { rawNode(id: string): Record<string, unknown> | undefined; explicitSize(id: string): boolean } {
  const rawNodes = new Map<string, Record<string, unknown>>();
  for (const raw of doc.nodes) if (isRecord(raw) && typeof raw.id === "string" && !rawNodes.has(raw.id)) rawNodes.set(raw.id, raw);
  const rawEdges = new Map<string, Record<string, unknown>>();
  for (const raw of doc.edges) if (isRecord(raw) && typeof raw.id === "string" && !rawEdges.has(raw.id)) rawEdges.set(raw.id, raw);
  let incoming: Map<string, string[]> | null = null, outgoing: Map<string, string[]> | null = null;
  const edgeIndex = () => {
    if (!incoming || !outgoing) {
      incoming = new Map(); outgoing = new Map();
      for (const [id, raw] of rawEdges) {
        const source = String(raw.source), target = String(raw.target);
        (outgoing.get(source) ?? outgoing.set(source, []).get(source)!).push(id);
        (incoming.get(target) ?? incoming.set(target, []).get(target)!).push(id);
      }
    }
    return { incoming: incoming!, outgoing: outgoing! };
  };
  const nodeCache = new Map<string, { summary: NodeSummary; content: string | null; explicit: boolean } | null>();
  const convert = (id: string) => {
    if (nodeCache.has(id)) return nodeCache.get(id)!;
    const raw = rawNodes.get(id);
    let result: { summary: NodeSummary; content: string | null; explicit: boolean } | null = null;
    if (raw) {
      const converted = convertLegacyNode(raw, doc.id, documentIdOf(state, id));
      if (converted.summary) {
        const versions = versionsOf(state, id);
        result = {
          summary: { ...converted.summary, entityVersion: versions.entity, geometryVersion: versions.geometry },
          content: "content" in converted ? converted.content : null,
          explicit: "explicitSize" in converted ? converted.explicitSize : false,
        };
      }
    }
    nodeCache.set(id, result);
    return result;
  };
  const documentOwner = new Map<string, string>(Object.entries(state.documentIds).map(([nodeId, docId]) => [docId, nodeId]));
  return {
    canvasId: doc.id,
    canvasName: () => doc.name,
    nameVersion: () => state.nameVersion,
    getNode: id => convert(id)?.summary,
    getDocument(docId) {
      const nodeId = documentOwner.get(docId) ?? (docId.startsWith("doc_") ? docId.slice(4) : "");
      const node = nodeId ? convert(nodeId) : null;
      if (!node || node.summary.documentId !== docId) return undefined;
      return { id: docId, nodeId, content: node.content ?? "", version: own(versionsOf(state, nodeId).fields ?? {}, "content") ?? 0 };
    },
    getEdge(id) {
      const raw = rawEdges.get(id);
      if (!raw) return undefined;
      const role = isRecord(raw.data) && ROLES.has(raw.data.role as EdgeRole) ? raw.data.role as EdgeRole : null;
      return { id, canvasId: doc.id, source: String(raw.source), target: String(raw.target), role, version: own(state.edges, id) ?? 0 };
    },
    incomingEdgeIds: nodeId => [...(edgeIndex().incoming.get(nodeId) ?? [])],
    outgoingEdgeIds: nodeId => [...(edgeIndex().outgoing.get(nodeId) ?? [])],
    fieldVersion: (nodeId, field) => own(versionsOf(state, nodeId).fields ?? {}, field) ?? 0,
    isNodeTombstoned: id => own(state.tombstones.nodes, id) !== undefined,
    isEdgeTombstoned: id => own(state.tombstones.edges, id) !== undefined,
    generationClaim: nodeId => doc.generationClaims && Object.hasOwn(doc.generationClaims, nodeId) ? doc.generationClaims[nodeId] : undefined,
    rawNode: id => rawNodes.get(id),
    explicitSize: id => convert(id)?.explicit ?? false,
  };
}

const cloneState = (state: CanvasCommandState): CanvasCommandState => ({
  ...state,
  nodes: { ...state.nodes }, edges: { ...state.edges },
  tombstones: { nodes: { ...state.tombstones.nodes }, edges: { ...state.tombstones.edges } },
  actors: { ...state.actors }, receipts: { ...state.receipts }, assets: { ...state.assets }, documentIds: { ...state.documentIds },
});

/** 把写集落到 CanvasDoc（写时复制，未变节点保持原引用）并更新命令元数据。 */
function applyWrites(doc: CanvasDoc, state: CanvasCommandState, reader: ReturnType<typeof createDocReader>, w: WriteSet): CanvasDoc {
  for (const [nodeId, fields] of w.nodeFieldVersions) {
    if (w.removedNodes.has(nodeId)) continue;
    const current = versionsOf(state, nodeId);
    const merged = { ...(current.fields ?? {}) };
    for (const [field, version] of fields) setOwn(merged, field, version);
    setOwn(state.nodes, nodeId, { ...current, fields: merged });
  }
  for (const node of w.nodes.values()) {
    const current = versionsOf(state, node.id);
    const document = node.documentId ? w.documents.get(node.documentId) : undefined;
    const fields = { ...(current.fields ?? {}) };
    if (document) setOwn(fields, "content", document.version);
    setOwn(state.nodes, node.id, { entity: node.entityVersion, geometry: node.geometryVersion, ...(Object.keys(fields).length ? { fields } : {}) });
    if (node.documentId && node.documentId !== deriveDocumentId(node.id)) setOwn(state.documentIds, node.id, node.documentId);
  }
  // 只有正文变化（节点摘要未在写集里）时也要记录文档版本。
  for (const document of w.documents.values()) {
    if (w.nodes.has(document.nodeId)) continue;
    const current = versionsOf(state, document.nodeId);
    setOwn(state.nodes, document.nodeId, { ...current, fields: { ...(current.fields ?? {}), content: document.version } });
  }
  for (const id of w.removedNodes) {
    if (reader.rawNode(id)) setOwn(state.tombstones.nodes, id, versionsOf(state, id));
    deleteOwn(state.nodes, id);
    deleteOwn(state.documentIds, id);
  }
  for (const id of w.removedEdges) {
    if (reader.getEdge(id)) setOwn(state.tombstones.edges, id, own(state.edges, id) ?? 0);
    deleteOwn(state.edges, id);
  }
  for (const edge of w.edges.values()) setOwn(state.edges, edge.id, edge.version);
  if (w.nameVersion !== undefined) state.nameVersion = w.nameVersion;
  for (const asset of w.assets.values()) setOwn(state.assets, asset.assetName, { kind: asset.kind, createdAt: asset.createdAt, missing: asset.missing });

  const contentFor = (node: NodeSummary) => {
    if (!node.documentId) return null;
    return w.documents.get(node.documentId)?.content ?? reader.getDocument(node.documentId)?.content ?? "";
  };
  const exported = (node: NodeSummary) => {
    const original = reader.rawNode(node.id);
    const before = reader.getNode(node.id);
    const sizeChanged = !!before && (before.geometry.width !== node.geometry.width || before.geometry.height !== node.geometry.height);
    return exportLegacyNode(node, { content: contentFor(node), explicitSize: reader.explicitSize(node.id) || sizeChanged || !original, original });
  };
  const nodes: unknown[] = [];
  for (const raw of doc.nodes) {
    const id = isRecord(raw) ? String(raw.id) : "";
    if (w.removedNodes.has(id)) continue;
    const updated = w.nodes.get(id);
    nodes.push(updated ? exported(updated) : raw);
  }
  for (const node of w.nodes.values()) if (!reader.rawNode(node.id)) nodes.push(exported(node));
  const edges: unknown[] = [];
  for (const raw of doc.edges) {
    const edge = isRecord(raw) ? raw : {};
    if (w.removedEdges.has(String(edge.id)) || w.removedNodes.has(String(edge.source)) || w.removedNodes.has(String(edge.target))) continue;
    edges.push(raw);
  }
  for (const edge of w.edges.values()) if (!reader.getEdge(edge.id)) edges.push({ id: edge.id, source: edge.source, target: edge.target, type: "scissor", data: edge.role ? { role: edge.role } : {} });
  return { ...doc, ...(w.name !== undefined ? { name: w.name } : {}), nodes, edges, commandState: state };
}

function buildDelta(canvasId: string, fromRevision: number, revision: number, w: WriteSet): Delta {
  return {
    canvasId, fromRevision, revision,
    nodes: [...w.nodes.values()].filter(node => !w.removedNodes.has(node.id)).map(node => structuredClone(node)),
    documents: [...w.documents.values()].map(doc => ({ ...doc })),
    edges: [...w.edges.values()].map(edge => ({ ...edge })),
    removedNodeIds: [...w.removedNodes],
    removedDocumentIds: [...w.removedDocuments],
    removedEdgeIds: [...w.removedEdges],
    assets: [...w.assets.values()].map(asset => ({ ...asset })),
    ...(w.name !== undefined ? { name: w.name } : {}),
  };
}

export const jsonCommandRepository: CommandRepository = {
  async transact<T>(canvasId: string, edit: (txn: CommandTxn) => T): Promise<T | null> {
    const outcome = await commitCommandWrite(canvasId, (doc) => {
      const state = doc.commandState ?? emptyCommandState();
      const reader = createDocReader(doc, state);
      let next: CanvasDoc | null = null;
      let bumpRevision = false;
      const txn: CommandTxn = {
        reader,
        revision: doc.revision,
        eventSeq: state.eventSeq,
        storageEpoch: state.storageEpoch,
        acceptedSeq: actorId => own(state.actors, actorId)?.acceptedSeq ?? 0,
        storedResult: commandId => own(state.receipts, commandId),
        commit(writes, meta) {
          for (const [name, asset] of writes.assets) {
            const existing = own(state.assets, name);
            if (existing && existing.kind === asset.kind && existing.createdAt === asset.createdAt && existing.missing === asset.missing) writes.assets.delete(name);
          }
          const changed = !isEmptyWriteSet(writes);
          const updated = cloneState(state);
          const revision = changed ? doc.revision + 1 : doc.revision;
          const eventSeq = changed ? state.eventSeq + 1 : state.eventSeq;
          updated.eventSeq = eventSeq;
          const receipt: CommitReceipt = {
            commandId: meta.commandId,
            revision,
            eventSeq,
            storageEpoch: state.storageEpoch,
            changedNodeIds: [...writes.nodes.keys()].filter(id => !writes.removedNodes.has(id)),
            changedEdgeIds: [...writes.edges.keys()],
            fieldVersions: [...writes.fieldVersions.values()],
            delta: buildDelta(doc.id, doc.revision, revision, writes),
            replayed: false,
          };
          setOwn(updated.actors, meta.actorId, { acceptedSeq: meta.actorSeq });
          setOwn(updated.receipts, meta.commandId, { hash: meta.hash, actorId: meta.actorId, actorSeq: meta.actorSeq, receipt });
          next = changed ? applyWrites(doc, updated, reader, writes) : { ...doc, commandState: updated };
          bumpRevision = changed;
          return receipt;
        },
        reject(meta, error) {
          const updated = cloneState(state);
          setOwn(updated.actors, meta.actorId, { acceptedSeq: meta.actorSeq });
          setOwn(updated.receipts, meta.commandId, { hash: meta.hash, actorId: meta.actorId, actorSeq: meta.actorSeq, error });
          next = { ...doc, commandState: updated };
          bumpRevision = false;
        },
      };
      const result = edit(txn);
      return { next, bumpRevision, result };
    });
    if (!outcome) return null;
    const result = outcome.result as unknown;
    if (isReceipt(result) && !result.replayed && result.revision !== outcome.saved.revision) {
      throw new Error(`回执修订号 ${result.revision} 与落盘 ${outcome.saved.revision} 不一致`);
    }
    return outcome.result;
  },
};

const isReceipt = (value: unknown): value is CommitReceipt => isRecord(value) && typeof value.commandId === "string" && typeof value.revision === "number" && isRecord(value.delta);

export type EntitySnapshot = {
  canvasId: string;
  revision: number;
  name: string;
  nameVersion: number;
  storageEpoch: string;
  eventSeq: number;
  nodes: NodeSummary[];
  documents: DocumentRecord[];
  edges: EdgeRecord[];
  actors: Record<string, { acceptedSeq: number }>;
};

/** 带版本的实体快照：供客户端初始化与测试取得 expectedVersion。整图转换，仅用于加载。 */
export async function loadEntitySnapshot(canvasId: string): Promise<EntitySnapshot | null> {
  const doc = await loadCanvas(canvasId);
  if (!doc) return null;
  const state = doc.commandState ?? emptyCommandState();
  const converted = fromCanvasDoc(doc, { documentIds: new Map(Object.entries(state.documentIds)) });
  return {
    canvasId: doc.id,
    revision: doc.revision,
    name: doc.name,
    nameVersion: state.nameVersion,
    storageEpoch: state.storageEpoch,
    eventSeq: state.eventSeq,
    nodes: converted.seed.nodes.map(node => {
      const versions = versionsOf(state, node.id);
      return { ...node, entityVersion: versions.entity, geometryVersion: versions.geometry };
    }),
    documents: converted.seed.documents.map(record => ({ ...record, version: own(versionsOf(state, record.nodeId).fields ?? {}, "content") ?? 0 })),
    edges: converted.seed.edges.map(edge => ({ ...edge, version: own(state.edges, edge.id) ?? 0 })),
    actors: { ...state.actors },
  };
}
