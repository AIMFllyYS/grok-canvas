"use strict";
/**
 * 任务、生成来源、占用与租约 repository（contracts.md C5/C6，P3-04）。
 * - 视频任务记录完整往返（requestId/snapshot/remoteUrl/result/claim/claimReleased），按画布做归属校验；
 * - 生成来源不可变：快照 sha256 相同才幂等，不同快照拒绝，不静默覆盖真实信息；
 * - claim 保留 unknown：unknown 与 pending 都不允许重新发起收费生成（需用户确认）。
 */
const crypto = require("node:crypto");
const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });
const canvasOf = (params) => { if (!params || typeof params.canvasId !== "string" || !params.canvasId) throw invalid("缺少 canvasId：每个查询都必须按画布过滤"); return params.canvasId; };
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));

/** 稳定序列化（键排序），用于不可变记录的内容 hash。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function putTaskRun(db, record) {
  if (!record || typeof record.taskId !== "string") throw invalid("缺少 taskId");
  db.prepare(`insert into task_runs (task_id, canvas_id, node_id, generation_id, claim_node_id, upstream_id, state, snapshot_json, remote_url, result_json, error, claim_released, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(task_id) do update set state = excluded.state, remote_url = excluded.remote_url, result_json = excluded.result_json, error = excluded.error, claim_released = excluded.claim_released, updated_at = excluded.updated_at`)
    .run(record.taskId, record.canvasId, record.nodeId, record.claim?.id ?? null, record.claim?.nodeId ?? null, record.requestId, record.status, JSON.stringify(record.snapshot ?? {}),
      record.remoteUrl ?? null, json(record.result), record.error ?? null, record.claimReleased === undefined ? null : record.claimReleased ? 1 : 0, record.createdAt, record.updatedAt);
  return { ok: true };
}

/** 还原为与 video-tasks/*.json 相同的形状（字段一致往返）。 */
function taskRow(row) {
  const record = {
    schemaVersion: 1, taskId: row.task_id, requestId: row.upstream_id, status: row.state, canvasId: row.canvas_id, nodeId: row.node_id,
    ...(row.generation_id ? { claim: { nodeId: row.claim_node_id ?? row.node_id, id: row.generation_id } } : {}),
    snapshot: parse(row.snapshot_json), remoteUrl: row.remote_url, result: parse(row.result_json), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.claim_released !== null) record.claimReleased = row.claim_released === 1;
  return record;
}

function getTaskRun(db, params) {
  const canvasId = canvasOf(params);
  const row = db.prepare("select * from task_runs where task_id = ? and canvas_id = ?").get(String(params.taskId ?? ""), canvasId);
  return row ? taskRow(row) : null;
}

/** 可恢复：pending、save_failed，以及已完成但 claim 未释放（结果需要补写/释放）。 */
function listRecoverable(db, params) {
  const canvasId = canvasOf(params);
  return db.prepare("select * from task_runs where canvas_id = ? and (state in ('pending', 'save_failed') or (state = 'completed' and coalesce(claim_released, 0) = 0)) order by created_at, task_id limit 500").all(canvasId).map(taskRow);
}

function putGenerationRecord(db, params) {
  const snapshotJson = JSON.stringify(params.snapshot);
  const hash = crypto.createHash("sha256").update(canonical(params.snapshot)).digest("hex");
  const existing = db.prepare("select snapshot_sha256 from generation_records where asset_name = ?").get(params.assetName);
  if (existing) {
    if (existing.snapshot_sha256 === hash) return { status: "unchanged" };
    throw Object.assign(new Error(`生成记录 ${params.assetName} 已存在且内容不同，拒绝覆盖`), { code: "generation_record_conflict" });
  }
  db.prepare("insert into generation_records (asset_name, schema_version, snapshot_json, snapshot_sha256, saved_at) values (?, ?, ?, ?, ?)").run(params.assetName, params.schemaVersion ?? 1, snapshotJson, hash, params.savedAt);
  return { status: "inserted" };
}

function getGenerationRecord(db, params) {
  const row = db.prepare("select * from generation_records where asset_name = ?").get(String(params.assetName ?? ""));
  return row ? { assetName: row.asset_name, schemaVersion: row.schema_version, snapshot: JSON.parse(row.snapshot_json), savedAt: row.saved_at } : null;
}

function putClaim(db, claim) {
  canvasOf(claim);
  db.prepare("insert into generation_claims (canvas_id, node_id, claim_id, state, task_id, expires_at) values (?, ?, ?, ?, ?, ?) on conflict(canvas_id, node_id) do update set claim_id = excluded.claim_id, state = excluded.state, task_id = excluded.task_id, expires_at = excluded.expires_at")
    .run(claim.canvasId, claim.nodeId, claim.claimId, claim.state, claim.taskId ?? null, claim.expiresAt ?? null);
  return { ok: true };
}

function getClaim(db, params) {
  const canvasId = canvasOf(params);
  const row = db.prepare("select * from generation_claims where canvas_id = ? and node_id = ?").get(canvasId, String(params.nodeId ?? ""));
  return row ? { canvasId: row.canvas_id, nodeId: row.node_id, claimId: row.claim_id, state: row.state, taskId: row.task_id, expiresAt: row.expires_at } : null;
}

/** 有任何占用（pending 或 unknown）都不能直接重新生成；unknown 需用户明确确认风险后清除。 */
function claimAllowsNewGeneration(db, params) {
  return getClaim(db, params) === null;
}

function putLease(db, lease) {
  canvasOf(lease);
  db.prepare("insert into edit_leases (canvas_id, node_id, field, owner, token, expires_at) values (?, ?, ?, ?, ?, ?) on conflict(canvas_id, node_id, field) do update set owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at")
    .run(lease.canvasId, lease.nodeId, lease.field, lease.owner, lease.token, lease.expiresAt);
  return { ok: true };
}

function getLease(db, params) {
  const canvasId = canvasOf(params);
  const row = db.prepare("select * from edit_leases where canvas_id = ? and node_id = ? and field = ?").get(canvasId, params.nodeId, params.field);
  return row ? { canvasId: row.canvas_id, nodeId: row.node_id, field: row.field, owner: row.owner, token: row.token, expiresAt: row.expires_at } : null;
}

/**
 * Agent 工具调用记录（P5-01）：(run_id, tool_call_id) 唯一；阶段与目标/摘要/计数放在 mapping_json。
 * event_seq 只单调前进：旧序号的迟到写入被忽略，不会把终态改回执行中。
 */
function putToolCall(db, record) {
  const canvasId = canvasOf(record);
  if (typeof record.runId !== "string" || typeof record.toolCallId !== "string" || typeof record.phase !== "string") throw invalid("缺少 runId/toolCallId/phase");
  const extra = { tool: record.tool, startedAt: record.startedAt, ...(record.summary ? { summary: record.summary } : {}), ...(record.targets ? { targets: record.targets } : {}), ...(record.completed !== undefined ? { completed: record.completed } : {}), ...(record.total !== undefined ? { total: record.total } : {}) };
  db.prepare(`insert into tool_calls (run_id, tool_call_id, canvas_id, phase, event_seq, command_id, mapping_json, error, updated_at) values (?, ?, ?, ?, ?, null, ?, ?, ?)
    on conflict(run_id, tool_call_id) do update set phase = excluded.phase, event_seq = excluded.event_seq, mapping_json = excluded.mapping_json, error = excluded.error, updated_at = excluded.updated_at
    where coalesce(tool_calls.event_seq, 0) < excluded.event_seq`)
    .run(record.runId, record.toolCallId, canvasId, record.phase, record.eventSeq ?? 0, JSON.stringify(extra), record.error ?? null, record.updatedAt);
  return { ok: true };
}

function listToolCalls(db, params) {
  const canvasId = canvasOf(params);
  const limit = Math.max(1, Math.min(300, Number(params.limit) || 100));
  return db.prepare("select run_id, tool_call_id, canvas_id, phase, event_seq, mapping_json, error, updated_at from tool_calls where canvas_id = ? order by updated_at desc limit ?").all(canvasId, limit).reverse().map(row => {
    const extra = parse(row.mapping_json) || {};
    return { runId: row.run_id, toolCallId: row.tool_call_id, canvasId: row.canvas_id, phase: row.phase, eventSeq: row.event_seq, updatedAt: row.updated_at, ...extra, ...(row.error ? { error: row.error } : {}) };
  });
}

module.exports = { putTaskRun, getTaskRun, listRecoverable, putGenerationRecord, getGenerationRecord, putClaim, getClaim, claimAllowsNewGeneration, putLease, getLease, canonical, putToolCall, listToolCalls };
