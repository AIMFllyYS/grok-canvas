"use strict";
/**
 * SQLite 权威模式的 Worker 侧入口（P3-08，contracts.md C2/C4/C5）。全部同步执行，参数只是数据，不接收 SQL。
 * - commands.readSet：按命令触及的实体预取读集（节点/正文/连线/字段版本/claims/回执/actor 水位），不读全图；
 * - commands.commit：乐观提交——事务内复核 revision、actorSeq、commandId 与读集一致，再用 command-repository 的
 *   createSqlTxn 写实体、版本、回执与单一事件；不一致返回 retry，由调用方在 Next 进程内重跑 reducer。
 * - canvasDoc.*：旧 CanvasDoc 形状的读取/画布字段（视口、素材库、claims、旧 operation ID）/生命周期；
 * - agentState.* / videoTasks.list：Agent 会话与视频任务的整体读写。
 */
const { createSqlTxn, loadSnapshot } = require("./command-repository.cjs");
const canvasRepo = require("./repositories/canvas.cjs");
const conversationsRepo = require("./repositories/conversations.cjs");
const tasksRepo = require("./repositories/tasks.cjs");
const controlRepo = require("./repositories/control.cjs");

const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });
const canvasIdOf = (params) => { if (!params || typeof params.canvasId !== "string" || !params.canvasId) throw invalid("缺少 canvasId"); return params.canvasId; };
const list = (value) => (Array.isArray(value) ? value.map(String) : []);
const NODE_COLUMNS = "id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json, deleted_at";
const rowToNode = (canvasId, row) => ({
  id: row.id, canvasId, type: row.type, schemaVersion: row.schema_version,
  geometry: { x: row.x, y: row.y, width: row.width, height: row.height },
  entityVersion: row.entity_version, geometryVersion: row.geometry_version, documentId: row.document_id,
  data: JSON.parse(row.data_json),
});

function canvasMeta(db, canvasId) {
  const row = db.prepare("select name, revision, name_version, storage_epoch, created_at, updated_at, deleted_at from canvases where id = ?").get(canvasId);
  if (!row || row.deleted_at) return null;
  const eventSeq = db.prepare("select coalesce(max(event_seq), 0) as seq from canvas_events where canvas_id = ?").get(canvasId).seq;
  return { name: row.name, revision: row.revision, nameVersion: row.name_version, storageEpoch: row.storage_epoch, eventSeq, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** 读集：只取请求的实体；节点附带字段版本与相邻连线 ID，正文只在 documents=true 时读取。 */
function readSet(db, params) {
  const canvasId = canvasIdOf(params);
  const canvas = canvasMeta(db, canvasId);
  if (!canvas) return { canvas: null };
  const out = { canvas, nodes: {}, fields: {}, incoming: {}, outgoing: {}, documents: {}, edges: {}, claims: {}, results: {}, actors: {} };
  const nodeIds = new Set(list(params.nodeIds));
  for (const id of nodeIds) {
    const row = db.prepare(`select ${NODE_COLUMNS} from nodes where canvas_id = ? and id = ?`).get(canvasId, id);
    out.nodes[id] = row ? { node: rowToNode(canvasId, row), deleted: !!row.deleted_at } : null;
    out.fields[id] = Object.fromEntries(db.prepare("select field, version from node_fields where canvas_id = ? and node_id = ?").all(canvasId, id).map(r => [r.field, r.version]));
    out.incoming[id] = db.prepare("select id from edges where canvas_id = ? and target = ? and deleted_at is null order by id").all(canvasId, id).map(r => r.id);
    out.outgoing[id] = db.prepare("select id from edges where canvas_id = ? and source = ? and deleted_at is null order by id").all(canvasId, id).map(r => r.id);
    if (params.documents && row && row.document_id) out.documents[row.document_id] = null;
  }
  const documentIds = new Set([...list(params.documentIds), ...Object.keys(out.documents)]);
  for (const id of documentIds) {
    const row = db.prepare("select d.id, d.node_id, d.content, d.version from documents d join nodes n on n.canvas_id = d.canvas_id and n.id = d.node_id where d.canvas_id = ? and d.id = ? and n.deleted_at is null").get(canvasId, id);
    out.documents[id] = row ? { id: row.id, nodeId: row.node_id, content: row.content, version: row.version } : null;
  }
  const edgeIds = new Set([...list(params.edgeIds), ...Object.values(out.incoming).flat(), ...Object.values(out.outgoing).flat()]);
  for (const id of edgeIds) {
    const row = db.prepare("select id, source, target, role, version, deleted_at from edges where canvas_id = ? and id = ?").get(canvasId, id);
    out.edges[id] = row ? { edge: { id: row.id, canvasId, source: row.source, target: row.target, role: row.role, version: row.version }, deleted: !!row.deleted_at } : null;
  }
  for (const id of new Set([...list(params.claimNodeIds), ...nodeIds])) {
    const row = db.prepare("select claim_id, state from generation_claims where canvas_id = ? and node_id = ?").get(canvasId, id);
    out.claims[id] = row ? { id: row.claim_id, state: row.state } : null;
  }
  for (const id of list(params.commandIds)) {
    const row = db.prepare("select request_hash, receipt_json, actor_id, actor_seq from command_receipts where command_id = ?").get(id);
    if (!row) { out.results[id] = null; continue; }
    const stored = JSON.parse(row.receipt_json);
    out.results[id] = { hash: row.request_hash, actorId: row.actor_id, actorSeq: row.actor_seq, ...(stored.error ? { error: stored.error } : { receipt: stored.receipt }) };
  }
  for (const id of list(params.actorIds)) {
    out.actors[id] = db.prepare("select accepted_seq from actor_watermarks where canvas_id = ? and actor_id = ?").get(canvasId, id)?.accepted_seq ?? 0;
  }
  return out;
}

const toMap = (entries) => new Map(entries ?? []);
function writeSetFrom(serialized) {
  return {
    nodes: toMap(serialized.nodes), documents: toMap(serialized.documents), edges: toMap(serialized.edges),
    removedNodes: new Set(serialized.removedNodes ?? []), removedDocuments: new Set(serialized.removedDocuments ?? []), removedEdges: new Set(serialized.removedEdges ?? []),
    nodeFieldVersions: new Map((serialized.nodeFieldVersions ?? []).map(([id, fields]) => [id, new Map(fields)])),
    fieldVersions: toMap(serialized.fieldVersions), assets: toMap(serialized.assets),
    ...(serialized.name !== undefined ? { name: serialized.name, nameVersion: serialized.nameVersion } : {}),
  };
}

/**
 * 乐观提交：revision、actorSeq、commandId 与读集一致才写入；否则 { retry: true }。
 * params: { canvasId, base: { revision, actorId, acceptedSeq }, meta, writes?, error? }
 */
function commit(db, params) {
  const canvasId = canvasIdOf(params);
  return db.transaction(() => {
    const txn = createSqlTxn(db, canvasId);
    if (!txn) return { missing: true };
    const { base, meta } = params;
    if (txn.storedResult(meta.commandId)) return { retry: true, reason: "command_stored" };
    if (txn.acceptedSeq(meta.actorId) !== base.acceptedSeq) return { retry: true, reason: "actor_seq_changed" };
    if (params.error) { txn.reject(meta, params.error); return { rejected: true }; }
    if (txn.revision !== base.revision) return { retry: true, reason: "revision_changed" };
    return { receipt: txn.commit(writeSetFrom(params.writes), meta) };
  })();
}

/** 旧 CanvasDoc 所需的全部数据（加载时整图；命令路径不用它）。 */
function loadDoc(db, params) {
  const canvasId = canvasIdOf(params);
  const meta = canvasMeta(db, canvasId);
  if (!meta) return null;
  const snapshot = loadSnapshot(db, canvasId);
  const claims = Object.fromEntries(db.prepare("select node_id, claim_id, state, task_id from generation_claims where canvas_id = ?").all(canvasId)
    .map(r => [r.node_id, { id: r.claim_id, state: r.state, ...(r.task_id ? { taskId: r.task_id } : {}) }]));
  const operationIds = db.prepare("select operation_id from legacy_operation_ids where canvas_id = ?").all(canvasId).map(r => r.operation_id);
  return {
    ...meta, snapshot, claims, operationIds,
    viewport: controlRepo.getPreference(db, { key: `viewport:${canvasId}` }),
    libraryAssets: controlRepo.getPreference(db, { key: `library:${canvasId}` }),
  };
}

/** 画布字段写入：视口、素材库、claims（null 表示删除）、旧 operation ID；同一事务。 */
function writeSide(db, params) {
  const canvasId = canvasIdOf(params);
  return db.transaction(() => {
    if (!canvasMeta(db, canvasId)) return { missing: true };
    if (params.viewport !== undefined) controlRepo.setPreference(db, { key: `viewport:${canvasId}`, value: params.viewport });
    if (params.libraryAssets !== undefined) controlRepo.setPreference(db, { key: `library:${canvasId}`, value: params.libraryAssets });
    for (const [nodeId, claim] of Object.entries(params.claims ?? {})) {
      if (claim === null) db.prepare("delete from generation_claims where canvas_id = ? and node_id = ?").run(canvasId, nodeId);
      else tasksRepo.putClaim(db, { canvasId, nodeId, claimId: claim.id, state: claim.state, taskId: claim.taskId });
    }
    if (params.operationIds?.length) controlRepo.recordLegacyOperationIds(db, { canvasId, operationIds: params.operationIds });
    const at = new Date().toISOString();
    if (params.bump) {
      // 素材库/claims 对其他客户端可见：与旧 JSON 一致地递增 revision，并写一条只含画布字段的事件，保持事件按 revision 连续。
      const meta = canvasMeta(db, canvasId);
      const revision = meta.revision + 1, eventSeq = meta.eventSeq + 1;
      const delta = { canvasId, fromRevision: meta.revision, revision, nodes: [], documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [],
        canvasFields: { ...(params.libraryAssets !== undefined ? { libraryAssets: params.libraryAssets } : {}), ...(params.claims ? { claims: params.claims } : {}) } };
      db.prepare("update canvases set revision = ?, updated_at = ? where id = ?").run(revision, at, canvasId);
      db.prepare("insert into canvas_events (canvas_id, event_seq, revision, command_id, delta_json, created_at) values (?, ?, ?, null, ?, ?)").run(canvasId, eventSeq, revision, JSON.stringify(delta), at);
      return { ok: true, revision };
    }
    db.prepare("update canvases set updated_at = ? where id = ?").run(at, canvasId);
    return { ok: true };
  })();
}

function listDocs(db) {
  return db.prepare("select id, name, created_at, updated_at from canvases where deleted_at is null order by created_at desc").all()
    .map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at }));
}

function createDoc(db, params) {
  const canvasId = canvasIdOf(params);
  const existing = db.prepare("select deleted_at from canvases where id = ?").get(canvasId);
  if (existing) return { exists: true, deleted: !!existing.deleted_at };
  canvasRepo.putCanvas(db, { canvas: { id: canvasId, name: params.name, revision: 0, nameVersion: 0, storageEpoch: params.storageEpoch, createdAt: params.createdAt, updatedAt: params.createdAt }, nodes: [], documents: [], edges: [], fieldVersions: {} });
  if (params.viewport) controlRepo.setPreference(db, { key: `viewport:${canvasId}`, value: params.viewport });
  return { created: true };
}

/** 删除画布是墓碑：行与实体保留，供备份/恢复；列表与读取不再可见。 */
function deleteDoc(db, params) {
  const canvasId = canvasIdOf(params);
  return { deleted: db.prepare("update canvases set deleted_at = ? where id = ? and deleted_at is null").run(new Date().toISOString(), canvasId).changes === 1 };
}

/** Agent 状态：所有会话与消息（按 ordinal）+ 当前会话偏好；画布不存在返回 null。 */
function loadAgent(db, params) {
  const canvasId = canvasIdOf(params);
  const canvas = db.prepare("select created_at, updated_at from canvases where id = ? and deleted_at is null").get(canvasId);
  if (!canvas) return null;
  const conversations = db.prepare("select id, title, settings_json, created_at, updated_at from agent_conversations where canvas_id = ? order by created_at desc, id").all(canvasId).map(r => ({
    id: r.id, title: r.title, settings: JSON.parse(r.settings_json), createdAt: r.created_at, updatedAt: r.updated_at,
    messages: db.prepare("select id, role, parts_json, metadata_json, created_at from agent_messages where canvas_id = ? and conversation_id = ? order by ordinal").all(canvasId, r.id).map(m => ({
      id: m.id, role: m.role, parts: JSON.parse(m.parts_json), ...(m.metadata_json !== null ? { metadata: JSON.parse(m.metadata_json) } : {}), ...(m.created_at !== null ? { createdAt: m.created_at } : {}),
    })),
  }));
  return { conversations, activeConversationId: controlRepo.getPreference(db, { key: `activeConversation:${canvasId}` }), createdAt: canvas.created_at };
}

/** 保存一个会话（整段消息替换，单事务）；remove=true 删除该会话。 */
function saveConversation(db, params) {
  const canvasId = canvasIdOf(params);
  return db.transaction(() => {
    if (!db.prepare("select 1 from canvases where id = ? and deleted_at is null").get(canvasId)) return { missing: true };
    if (params.remove) {
      db.prepare("delete from agent_messages where canvas_id = ? and conversation_id = ?").run(canvasId, params.conversationId);
      db.prepare("delete from agent_conversations where canvas_id = ? and id = ?").run(canvasId, params.conversationId);
    } else conversationsRepo.putConversation(db, { canvasId, conversation: params.conversation, messages: params.conversation.messages ?? [] });
    if (params.activeConversationId !== undefined) controlRepo.setPreference(db, { key: `activeConversation:${canvasId}`, value: params.activeConversationId });
    return { ok: true };
  })();
}

function listTasks(db) {
  return db.prepare("select task_id, canvas_id from task_runs order by created_at").all().map(r => tasksRepo.getTaskRun(db, { taskId: r.task_id, canvasId: r.canvas_id }));
}

/** 按 taskId 读取（旧 readVideoTask 语义：调用方随后核对所属画布）。 */
function getTask(db, params) {
  const row = db.prepare("select canvas_id from task_runs where task_id = ?").get(String(params?.taskId ?? ""));
  return row ? tasksRepo.getTaskRun(db, { taskId: params.taskId, canvasId: row.canvas_id }) : null;
}

/** 带版本的实体快照（与 JSON loadEntitySnapshot 同形），供 /entities 与客户端初始化。 */
function snapshot(db, params) { return loadSnapshot(db, canvasIdOf(params)); }

module.exports = { snapshot, readSet, commit, loadDoc, writeSide, listDocs, createDoc, deleteDoc, loadAgent, saveConversation, listTasks, getTask, writeSetFrom };
