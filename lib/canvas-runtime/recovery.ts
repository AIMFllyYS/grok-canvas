/**
 * v1 草稿恢复与恢复屏障（contracts.md C3）。
 * - recoverLegacy：v1 草稿（base/working/inflight）对照服务端当前实体一次转换成命令。
 *   服务端值 = working → 跳过；= base 或 inflight 快照 → 生成带服务端当前版本的命令；
 *   否则为冲突：进入保护态（editingPaused），不强推 working，也不清草稿。
 * - commitLegacyRecovery：转换命令、迁移标记与清除旧草稿同一事务；重复执行幂等。
 * - exportRecoveryBundle：用户可保存的 JSON；不含认证信息，不改变任何状态，也不视为服务器确认。
 * 浏览器模块。
 */
import type { CanvasDraft } from "../canvas-drafts";
import { canonicalJson, LIMITS } from "./command-schema";
import { JSON_STORAGE_EPOCH } from "./command-state";
import { historyReaderFromSnapshot, type HistoryReader } from "./history";
import { fromCanvasDoc } from "./legacy-document";
import { fieldAccess } from "./node-registry";
import { enqueueWithin, inTransaction, openCanvasDatabase, type CommandDraft, type Outbox, type OutboxRecord } from "./outbox";
import type { BatchItem, DocumentRecord, EdgeRecord, FieldRef, Geometry, LegacyCanvasDocV1, NodeSummary } from "./types";

export type RecoveryResult =
  | { status: "empty"; drafts: []; conflicts: []; editingPaused: false }
  | { status: "ready"; drafts: CommandDraft[]; conflicts: []; editingPaused: false; skipped: FieldRef[] }
  | { status: "conflict"; drafts: []; conflicts: FieldRef[]; editingPaused: true };

type Versions = { nodes?: Record<string, { entity: number; geometry: number; fields?: Record<string, number> }>; edges?: Record<string, number>; nameVersion?: number };

/** 用旧文档与版本表构造服务端读取器（测试与旧接口兼容期使用；P2-06 用实体快照）。 */
export function recoveryReaderFromLegacy(doc: LegacyCanvasDocV1, versions: Versions = {}): HistoryReader {
  const { seed } = fromCanvasDoc(doc);
  const nodeVersions = versions.nodes ?? {};
  const own = <T>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
  return historyReaderFromSnapshot({
    name: seed.name ?? "",
    nameVersion: versions.nameVersion ?? 0,
    nodes: seed.nodes.map(node => ({ ...node, entityVersion: own(nodeVersions, node.id)?.entity ?? 0, geometryVersion: own(nodeVersions, node.id)?.geometry ?? 0 })),
    documents: seed.documents.map(record => ({ ...record, version: own(nodeVersions, record.nodeId)?.fields?.content ?? 0 })),
    edges: seed.edges.map(edge => ({ ...edge, version: own(versions.edges ?? {}, edge.id) ?? 0 })),
    fieldVersions: Object.fromEntries(Object.entries(nodeVersions).map(([id, v]) => [id, v.fields ?? {}])),
  });
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const valueOf = (node: NodeSummary | undefined, field: string) => field === "pinned" ? node?.data.pinned === true : node?.data[field];
const chunk = <T>(items: T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; };

function index(doc: LegacyCanvasDocV1) {
  const { seed } = fromCanvasDoc(doc);
  return {
    name: seed.name ?? "",
    nodes: new Map(seed.nodes.map(node => [node.id, node])),
    docs: new Map(seed.documents.map(record => [record.nodeId, record])),
    edges: new Map(seed.edges.map(edge => [edge.id, edge])),
  };
}

export function recoverLegacy(draft: CanvasDraft, server: HistoryReader, options: { storageEpoch?: string; baseRevision?: number } = {}): RecoveryResult {
  const base = index(draft.base as LegacyCanvasDocV1), working = index(draft.working as LegacyCanvasDocV1);
  const snap = draft.pending ? index(draft.pending.snapshot as LegacyCanvasDocV1) : null;
  const conflicts: FieldRef[] = [], skipped: FieldRef[] = [];
  const moves: Array<{ nodeId: string; expectedVersion: number; from: Geometry; to: Geometry }> = [];
  const patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
  const adds: NodeSummary[] = [], addDocs: DocumentRecord[] = [];
  const deletes: Array<{ nodeId: string; expectedEntityVersion: number }> = [];
  const edgeAdds: EdgeRecord[] = [], edgeRemovals: Array<{ edgeId: string; expectedVersion: number }> = [];
  let rename: { expectedVersion: number; name: string } | null = null;
  /** 服务端仍是本地修改的起点（base 或已发出的 inflight 快照）。 */
  const startsFrom = (serverValue: unknown, baseValue: unknown, snapValue: unknown, hasSnap: boolean) => same(serverValue, baseValue) || (hasSnap && same(serverValue, snapValue));

  for (const [id, w] of working.nodes) {
    const b = base.nodes.get(id), s = server.getNode(id), sn = snap?.nodes.get(id);
    if (!b) {
      if (s) { if (!(same(s.geometry, w.geometry) && same(s.data, w.data))) conflicts.push({ target: "node", id, field: "entity" }); continue; }
      adds.push({ ...w, entityVersion: 0, geometryVersion: 0 });
      const document = working.docs.get(id);
      if (document) addDocs.push({ ...document, version: 0 });
      continue;
    }
    const changedLocally = !same(b.geometry, w.geometry) || !same(b.data, w.data) || !same(base.docs.get(id)?.content, working.docs.get(id)?.content);
    if (!s) { if (changedLocally) conflicts.push({ target: "node", id, field: "entity" }); continue; }
    if (!same(b.geometry, w.geometry) && !same(s.geometry, w.geometry)) {
      if (startsFrom(s.geometry, b.geometry, sn?.geometry, !!sn)) moves.push({ nodeId: id, expectedVersion: s.geometryVersion, from: { ...s.geometry }, to: { ...w.geometry } });
      else conflicts.push({ target: "node", id, field: "geometry" });
    }
    for (const field of new Set([...Object.keys(b.data), ...Object.keys(w.data)])) {
      if (fieldAccess(w.type, field) !== "user") continue;
      const bv = valueOf(b, field), wv = valueOf(w, field), sv = valueOf(s, field);
      if (same(bv, wv) || same(sv, wv)) continue;
      if (!startsFrom(sv, bv, valueOf(sn, field), !!sn)) { conflicts.push({ target: "node", id, field }); continue; }
      if (wv === undefined) { skipped.push({ target: "node", id, field }); continue; }
      patches.push({ nodeId: id, field, expectedVersion: server.fieldVersion(id, field), value: structuredClone(wv) });
    }
    const bc = base.docs.get(id)?.content, wc = working.docs.get(id)?.content;
    if (wc !== undefined && bc !== wc) {
      const serverDoc = s.documentId ? server.getDocument(s.documentId) : undefined;
      if (serverDoc?.content === wc) continue;
      if (serverDoc && startsFrom(serverDoc.content, bc, snap?.docs.get(id)?.content, !!snap)) patches.push({ nodeId: id, field: "content", expectedVersion: serverDoc.version, value: wc });
      else conflicts.push({ target: "document", id: s.documentId ?? id, field: "content" });
    }
  }
  for (const [id, b] of base.nodes) {
    if (working.nodes.has(id)) continue;
    const s = server.getNode(id);
    if (!s) continue;
    if (same(s.geometry, b.geometry) && same(s.data, b.data)) deletes.push({ nodeId: id, expectedEntityVersion: s.entityVersion });
    else conflicts.push({ target: "node", id, field: "entity" });
  }
  for (const [id, edge] of working.edges) {
    if (base.edges.has(id) || server.getEdge(id)) continue;
    edgeAdds.push({ ...edge, version: 0 });
  }
  for (const [id] of base.edges) {
    if (working.edges.has(id)) continue;
    const s = server.getEdge(id);
    if (s && !deletes.some(d => d.nodeId === s.source || d.nodeId === s.target)) edgeRemovals.push({ edgeId: id, expectedVersion: s.version });
  }
  if (base.name !== working.name && server.canvasName() !== working.name) {
    if (server.canvasName() === base.name || (snap && server.canvasName() === snap.name)) rename = { expectedVersion: server.nameVersion(), name: working.name };
    else conflicts.push({ target: "canvas", id: draft.canvasId, field: "name" });
  }

  if (conflicts.length) return { status: "conflict", drafts: [], conflicts, editingPaused: true };
  const items: BatchItem[] = [];
  for (const part of chunk(edgeRemovals, LIMITS.edgeRemove)) items.push({ kind: "edit_edges", payload: { add: [], remove: part } });
  for (const part of chunk(deletes, LIMITS.deleteItems)) items.push({ kind: "delete_nodes", payload: { items: part } });
  for (const part of chunk(adds, LIMITS.addNodes)) {
    const ids = new Set(part.map(node => node.id));
    items.push({ kind: "add_nodes", payload: { nodes: part, documents: addDocs.filter(d => ids.has(d.nodeId)) } });
  }
  for (const part of chunk(edgeAdds, LIMITS.edgeAdd)) items.push({ kind: "edit_edges", payload: { add: part, remove: [] } });
  for (const part of chunk(moves, LIMITS.moveItems)) items.push({ kind: "move_nodes", payload: { items: part } });
  for (const part of chunk(patches, LIMITS.patchItems)) items.push({ kind: "patch_nodes", payload: { items: part } });
  if (rename) items.push({ kind: "rename_canvas", payload: rename });
  if (!items.length) return { status: "empty", drafts: [], conflicts: [], editingPaused: false };
  const storageEpoch = options.storageEpoch ?? JSON_STORAGE_EPOCH;
  const baseRevision = options.baseRevision ?? (draft.base as LegacyCanvasDocV1).revision ?? 0;
  const drafts: CommandDraft[] = chunk(items, LIMITS.batchCommands).map(group => group.length === 1
    ? { kind: group[0]!.kind, payload: group[0]!.payload, storageEpoch, baseRevision }
    : { kind: "batch", payload: { commands: group }, storageEpoch, baseRevision });
  return { status: "ready", drafts, conflicts: [], editingPaused: false, skipped };
}

const geometryRange = (draftKey: string) => IDBKeyRange.bound(`${draftKey}:geometry:`, `${draftKey}:geometry:\uffff`);

/** 转换命令、迁移标记与清除旧草稿在同一事务内提交；已提交过的草稿键返回 already。 */
export async function commitLegacyRecovery(outbox: Outbox, draftKey: string, canvasId: string, drafts: CommandDraft[]): Promise<{ status: "committed"; records: OutboxRecord[] } | { status: "already" }> {
  return inTransaction(outbox.db, ["outbox", "client_state", "drafts"], "readwrite", async (tx) => {
    const state = tx.objectStore("client_state");
    const markerKey = `legacy:${draftKey}`;
    if (await new Promise(resolve => { const r = state.get(markerKey); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); })) return { status: "already" as const };
    const records: OutboxRecord[] = [];
    for (const draft of drafts) records.push(await enqueueWithin(tx, outbox.actorId, canvasId, draft, { ...outbox.enqueueOptions, merge: false }));
    state.put({ key: markerKey, canvasId, committedAt: outbox.enqueueOptions.now(), commands: records.map(record => record.command.commandId) });
    const store = tx.objectStore("drafts");
    store.delete(draftKey);
    store.delete(geometryRange(draftKey));
    return { status: "committed" as const, records };
  });
}

const SECRET_KEY = /oauth|token|auth|cookie|secret|password/i;

/** 导出该画布的全部本地未确认记录，供用户手动保存；不改变状态。 */
export async function exportRecoveryBundle(canvasId: string): Promise<string> {
  const db = await openCanvasDatabase();
  const data = await inTransaction(db, ["drafts", "outbox", "checkpoints", "client_state"], "readonly", async (tx) => {
    const all = <T>(store: string, query?: IDBKeyRange) => new Promise<T[]>((resolve, reject) => {
      const r = tx.objectStore(store).getAll(query);
      r.onsuccess = () => resolve(r.result as T[]);
      r.onerror = () => reject(r.error);
    });
    const range = IDBKeyRange.bound([canvasId], [canvasId, []]);
    const drafts = (await all<{ key: string; canvasId?: string }>("drafts")).filter(record => record.canvasId === canvasId && !record.key.includes(":geometry:"));
    const legacyCheckpoints = (await all<{ key: string; canvasId?: string }>("drafts")).filter(record => record.canvasId === canvasId && record.key.includes(":geometry:"));
    const outbox = await all("outbox", range);
    const checkpoints = await all("checkpoints", range);
    const clientState = (await all<{ key: string }>("client_state")).filter(record => record.key.includes(`:${canvasId}:`) || record.key.endsWith(`:${canvasId}`));
    return { drafts, legacyCheckpoints, outbox, checkpoints, clientState };
  });
  return JSON.stringify({ format: "grok-canvas-recovery", version: 1, exportedAt: new Date().toISOString(), canvasId, ...data }, (key, value) => SECRET_KEY.test(key) ? undefined : value, 2);
}
