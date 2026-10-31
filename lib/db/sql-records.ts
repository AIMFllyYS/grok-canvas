/**
 * SQLite 权威模式下各持久入口的实现（P3-08）：画布文档（旧 CanvasDoc 形状）、Agent 会话、视频任务、生成来源记录。
 * 只在 storage-state 标记为 SQLite 时被各模块按需动态加载；所有读写都经 DB Worker。
 * 旧整图写入（PUT/operations/服务端 updateCanvas）通过兼容适配：实体差异转换为带前置版本的领域命令，
 * 版本取自本次读取的快照——期间若有其他写入，命令以 field_conflict 失败，绝不做无条件整图覆盖。
 * 服务端私有模块。
 */
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets, type CanvasLibraryAsset } from "../canvas-library";
import type { CanvasDoc, CanvasSummary } from "../canvas-store";
import { CommandError, executeServerCommand } from "../canvas-runtime/command-service";
import { convertLegacyNode, exportLegacyNode } from "../canvas-runtime/legacy-document";
import { checkNodePatch, formatIssue } from "../canvas-runtime/node-registry";
import type { DocumentRecord, EdgeRecord, NodeSummary } from "../canvas-runtime/types";
import type { AgentConversation, AgentState } from "../agent/schema";
import type { GenerationRecord, GenerationSnapshotAny } from "../assets";
import type { VideoTaskRecord } from "../video-tasks";
import { sqlCommand, sqlQuery } from "./sql-command-repository";
import { readStorageState } from "./storage-mode";

/** 旧协议写入（PUT/operations/服务端字段编辑）在命令日志里的固定 actor。 */
export const LEGACY_ACTOR = "00000000-0000-4000-8000-00000000c0de";

/** SSE 修订探测（P3-09）。 */
export async function canvasRevisionSql(id: string): Promise<{ revision: number } | null> {
  return sqlQuery<{ revision: number } | null>("canvasDoc.revision", { canvasId: id });
}

type Snapshot = {
  canvasId: string; revision: number; name: string; nameVersion: number; storageEpoch: string; eventSeq: number;
  nodes: NodeSummary[]; documents: DocumentRecord[]; edges: EdgeRecord[];
  fieldVersions: Record<string, Record<string, number>>;
};
type LoadedDoc = {
  name: string; revision: number; createdAt: string; updatedAt: string; storageEpoch: string;
  snapshot: Snapshot; claims: NonNullable<CanvasDoc["generationClaims"]>; operationIds: string[];
  viewport: CanvasDoc["viewport"] | null; libraryAssets: CanvasLibraryAsset[] | null;
};
type DocWithSnapshot = { doc: CanvasDoc; snapshot: Snapshot };

const epoch = () => { const state = readStorageState(); if (state.backend !== "sqlite") throw new Error("不是 SQLite 模式"); return state.epoch; };

function toDoc(id: string, data: LoadedDoc): CanvasDoc {
  const content = new Map(data.snapshot.documents.map(d => [d.id, d.content]));
  return {
    id, name: data.name, schemaVersion: 1, revision: data.revision, createdAt: data.createdAt, updatedAt: data.updatedAt,
    viewport: data.viewport ?? { x: 0, y: 0, zoom: 1 },
    // SQL 里每个节点都有真实几何：导出时总是带尺寸。
    nodes: data.snapshot.nodes.map(node => exportLegacyNode(node, { explicitSize: true, content: node.documentId ? content.get(node.documentId) ?? "" : null })),
    edges: data.snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: "scissor", data: edge.role ? { role: edge.role } : {} })),
    libraryAssets: data.libraryAssets ?? [],
    ...(data.operationIds.length ? { appliedOperationIds: data.operationIds } : {}),
    ...(Object.keys(data.claims).length ? { generationClaims: data.claims } : {}),
  };
}

export async function loadCanvasWithSnapshot(id: string): Promise<DocWithSnapshot | null> {
  let data = await sqlQuery<LoadedDoc | null>("canvasDoc.loadDoc", { canvasId: id });
  if (!data && id === "default") {
    // 与 JSON 模式一致：默认画布首次访问时存在（这里落库，命令才能写入）。
    await createCanvasSql(id, "未命名画布");
    data = await sqlQuery<LoadedDoc | null>("canvasDoc.loadDoc", { canvasId: id });
  }
  return data ? { doc: toDoc(id, data), snapshot: data.snapshot } : null;
}

export async function loadCanvasSql(id: string): Promise<CanvasDoc | null> {
  return (await loadCanvasWithSnapshot(id))?.doc ?? null;
}

export async function listCanvasesSql(): Promise<CanvasSummary[]> {
  return sqlQuery<CanvasSummary[]>("canvasDoc.listDocs", {});
}

export async function createCanvasSql(id: string, name: string, viewport = { x: 0, y: 0, zoom: 1 }): Promise<void> {
  await sqlCommand("canvasDoc.createDoc", { canvasId: id, name, createdAt: new Date().toISOString(), storageEpoch: epoch(), viewport });
}

export async function deleteCanvasSql(id: string): Promise<boolean> {
  return (await sqlCommand<{ deleted: boolean }>("canvasDoc.deleteDoc", { canvasId: id })).deleted;
}

export async function loadLastCanvasIdSql(): Promise<string | null> {
  const value = await sqlQuery<unknown>("control.getPreference", { key: "lastCanvas" });
  return typeof value === "string" ? value : null;
}
export async function saveLastCanvasIdSql(id: string): Promise<void> {
  await sqlCommand("control.setPreference", { key: "lastCanvas", value: id });
}

export class LegacyWriteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "LegacyWriteError"; }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 实体差异 → 带前置版本的命令（版本取自快照，而不是提交时的最新值）。
 * access="user" 时只允许用户字段（旧客户端 operations/PUT），服务字段改动直接拒绝。
 */
export function legacyDiffCommands(before: CanvasDoc, after: CanvasDoc, snapshot: Snapshot, access: "user" | "service") {
  const canvasId = before.id;
  const commands: Array<{ kind: string; payload: unknown }> = [];
  const nodesBefore = new Map((before.nodes as Array<Record<string, unknown>>).filter(isRecord).map(n => [String(n.id), n]));
  const nodesAfter = new Map((after.nodes as Array<Record<string, unknown>>).filter(isRecord).map(n => [String(n.id), n]));
  const summaries = new Map(snapshot.nodes.map(n => [n.id, n]));
  const documents = new Map(snapshot.documents.map(d => [d.nodeId, d]));
  const adds: NodeSummary[] = [], addDocs: DocumentRecord[] = [];
  const deletes: Array<{ nodeId: string; expectedEntityVersion: number }> = [];
  const moves: Array<{ nodeId: string; expectedVersion: number; from: NodeSummary["geometry"]; to: NodeSummary["geometry"] }> = [];
  const patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
  for (const [id, raw] of nodesAfter) {
    const previous = nodesBefore.get(id);
    if (previous && same(previous, raw)) continue;
    const converted = convertLegacyNode(raw, canvasId, summaries.get(id)?.documentId ?? undefined);
    if (!converted.summary) throw new LegacyWriteError(`节点 ${id} 无效：${converted.issues.map(i => i.detail).join("；")}`);
    const next = converted.summary;
    const current = summaries.get(id);
    if (!previous || !current) {
      adds.push(next);
      if (next.documentId) addDocs.push({ id: next.documentId, nodeId: id, content: "content" in converted ? converted.content ?? "" : "", version: 0 });
      continue;
    }
    if (next.type !== current.type) throw new LegacyWriteError(`节点 ${id} 不能更改类型`);
    if (!same(next.geometry, current.geometry)) moves.push({ nodeId: id, expectedVersion: current.geometryVersion, from: current.geometry, to: next.geometry });
    const fields = new Set([...Object.keys(current.data), ...Object.keys(next.data)]);
    for (const field of fields) {
      if (same(current.data[field], next.data[field])) continue;
      const value = next.data[field];
      if (access === "user") {
        const issues = checkNodePatch(current.type, { [field]: value }, "user");
        if (issues.length) throw new LegacyWriteError(issues.map(formatIssue).join("；"));
      }
      patches.push({ nodeId: id, field, expectedVersion: snapshot.fieldVersions[id]?.[field] ?? 0, value });
    }
    const document = documents.get(id);
    const nextContent = "content" in converted ? converted.content : null;
    if (document && nextContent !== null && nextContent !== document.content) patches.push({ nodeId: id, field: "content", expectedVersion: document.version, value: nextContent });
  }
  for (const id of nodesBefore.keys()) if (!nodesAfter.has(id) && summaries.has(id)) deletes.push({ nodeId: id, expectedEntityVersion: summaries.get(id)!.entityVersion });
  const edgeVersions = new Map(snapshot.edges.map(e => [e.id, e]));
  const edgesAfter = new Map((after.edges as Array<Record<string, unknown>>).filter(isRecord).map(e => [String(e.id), e]));
  const deleted = new Set(deletes.map(d => d.nodeId));
  const addEdges: EdgeRecord[] = [], removeEdges: Array<{ edgeId: string; expectedVersion: number }> = [];
  for (const [id, raw] of edgesAfter) {
    const current = edgeVersions.get(id);
    const role = isRecord(raw.data) && typeof raw.data.role === "string" ? raw.data.role as EdgeRecord["role"] : null;
    if (current) {
      if (current.source !== raw.source || current.target !== raw.target || current.role !== role) throw new LegacyWriteError(`连线 ${id} 不能原地修改，请删除后新建`);
      continue;
    }
    addEdges.push({ id, canvasId, source: String(raw.source), target: String(raw.target), role, version: 0 });
  }
  for (const [id, edge] of edgeVersions) {
    if (edgesAfter.has(id) || deleted.has(edge.source) || deleted.has(edge.target)) continue;
    removeEdges.push({ edgeId: id, expectedVersion: edge.version });
  }
  if (adds.length) commands.push({ kind: "add_nodes", payload: { nodes: adds, documents: addDocs } });
  if (moves.length) commands.push({ kind: "move_nodes", payload: { items: moves } });
  if (patches.length) commands.push({ kind: "patch_nodes", payload: { items: patches } });
  if (addEdges.length || removeEdges.length) commands.push({ kind: "edit_edges", payload: { add: addEdges, remove: removeEdges } });
  if (deletes.length) commands.push({ kind: "delete_nodes", payload: { items: deletes } });
  if (after.name !== before.name) commands.push({ kind: "rename_canvas", payload: { expectedVersion: snapshot.nameVersion, name: after.name } });
  if (!commands.length) return null;
  return commands.length === 1 ? commands[0]! : { kind: "batch", payload: { commands } };
}

/**
 * 旧整图编辑在 SQLite 模式下的执行：读取（含版本快照）→ edit → 实体差异转命令 → 画布字段写入 → 重新读取。
 * expectedRevision 给出时必须与当前 revision 相同（旧 PUT 的乐观并发）。
 */
export async function transformCanvasSql(id: string, edit: (doc: CanvasDoc) => CanvasDoc, options: { access?: "user" | "service"; expectedRevision?: number } = {}): Promise<CanvasDoc | null> {
  const loaded = await loadCanvasWithSnapshot(id);
  if (!loaded) return null;
  const { doc: current, snapshot } = loaded;
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) return null;
  const next = edit(current);
  if (next === current) return current;
  if (next.id !== id) throw new Error("命令不能更改画布 ID");
  const body = legacyDiffCommands(current, next, snapshot, options.access ?? "service");
  if (body) await executeServerCommand(id, LEGACY_ACTOR, () => body as never, { origin: "server" });
  // 画布字段：素材库与旧 JSON 写入一致地合并节点引用；claims 按节点比较；operation ID 只追加。
  let library = mergeLibraryAssets(normalizeLibraryAssets(current.libraryAssets), normalizeLibraryAssets(next.libraryAssets));
  library = mergeLibraryAssets(library, collectCanvasAssets(next.nodes, next.createdAt, library));
  const claims: Record<string, unknown> = {};
  const beforeClaims = current.generationClaims ?? {}, afterClaims = next.generationClaims ?? {};
  for (const nodeId of new Set([...Object.keys(beforeClaims), ...Object.keys(afterClaims)])) {
    if (!same(beforeClaims[nodeId], afterClaims[nodeId])) claims[nodeId] = afterClaims[nodeId] ?? null;
  }
  const known = new Set(current.appliedOperationIds ?? []);
  const operationIds = (next.appliedOperationIds ?? []).filter(op => !known.has(op));
  const side = {
    ...(!same(next.viewport, current.viewport) ? { viewport: next.viewport } : {}),
    ...(!same(library, current.libraryAssets ?? []) ? { libraryAssets: library } : {}),
    ...(Object.keys(claims).length ? { claims } : {}),
    ...(operationIds.length ? { operationIds } : {}),
  };
  if (Object.keys(side).length) await sqlCommand("canvasDoc.writeSide", { canvasId: id, ...side, bump: "libraryAssets" in side || "claims" in side });
  return loadCanvasSql(id);
}

/** 命令冲突转为旧协议可理解的结果：调用方据此返回 409。 */
export const isConflict = (error: unknown) => error instanceof CommandError && (error.code === "field_conflict" || error.code === "lease_conflict");

// ---------------------------------------------------------------- Agent

type AgentRow = { conversations: AgentConversation[]; activeConversationId: string | null; createdAt: string };
export async function loadAgentSql(id: string): Promise<{ state: AgentState; loaded: Map<string, string> } | null> {
  const row = await sqlQuery<AgentRow | null>("agentState.loadAgent", { canvasId: id });
  if (!row) return null;
  const now = new Date().toISOString();
  const state: AgentState = { id, canvasId: id, messages: [], conversations: row.conversations, activeConversationId: row.activeConversationId ?? "", createdAt: row.createdAt ?? now, updatedAt: now };
  return { state, loaded: new Map(row.conversations.map(c => [c.id, JSON.stringify(c)])) };
}

/** 只写变化的会话（每个会话一个事务，消息整体替换）；删除的会话移除；当前会话 ID 随最后一次写入。 */
export async function saveAgentSql(id: string, state: AgentState, loaded: Map<string, string>, loadedActive: string): Promise<void> {
  const ids = new Set(state.conversations.map(c => c.id));
  const writes: Array<Record<string, unknown>> = [];
  for (const conversation of state.conversations) if (loaded.get(conversation.id) !== JSON.stringify(conversation)) writes.push({ conversation });
  for (const old of loaded.keys()) if (!ids.has(old)) writes.push({ conversationId: old, remove: true });
  if (state.activeConversationId !== loadedActive) {
    if (writes.length) writes[writes.length - 1]!.activeConversationId = state.activeConversationId;
    else await sqlCommand("control.setPreference", { key: `activeConversation:${id}`, value: state.activeConversationId });
  }
  for (const write of writes) await sqlCommand("agentState.saveConversation", { canvasId: id, ...write });
}

// ---------------------------------------------------------------- 视频任务与生成来源

export const readVideoTaskSql = (taskId: string) => sqlQuery<VideoTaskRecord | null>("videoTasks.getTask", { taskId });
export const listVideoTasksSql = () => sqlQuery<VideoTaskRecord[]>("videoTasks.listTasks", {});
export const writeVideoTaskSql = (record: VideoTaskRecord) => sqlCommand("tasks.putTaskRun", record);

export async function saveGenerationRecordSql(assetName: string, snapshot: GenerationSnapshotAny, savedAt: string): Promise<void> {
  await sqlCommand("tasks.putGenerationRecord", { assetName, schemaVersion: 1, snapshot, savedAt });
}
export async function readGenerationRecordSql(assetName: string): Promise<GenerationRecord | null> {
  const row = await sqlQuery<{ assetName: string; schemaVersion: 1; snapshot: GenerationSnapshotAny; savedAt: string } | null>("tasks.getGenerationRecord", { assetName });
  return row ? { ...row.snapshot, schemaVersion: 1, assetName: row.assetName, savedAt: row.savedAt } as GenerationRecord : null;
}
