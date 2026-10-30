"use strict";
/**
 * 控制记录 repository（contracts.md C5/C6，P3-04）：回执、事件、水位、旧 operationId、工作站偏好、导入运行与备份清单。
 * 偏好不保存 OAuth/auth（键名在 SQL CHECK 与这里双重拒绝）。
 */
const LIST_LIMIT = 50;
const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });
const canvasOf = (params) => { if (!params || typeof params.canvasId !== "string" || !params.canvasId) throw invalid("缺少 canvasId"); return params.canvasId; };
const now = () => new Date().toISOString();

function putReceipt(db, r) {
  db.prepare("insert into command_receipts (command_id, canvas_id, actor_id, actor_seq, request_hash, receipt_json, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(r.commandId, canvasOf(r), r.actorId, r.actorSeq, r.requestHash, JSON.stringify(r.receipt), r.createdAt ?? now());
  return { ok: true };
}
function getReceipt(db, params) {
  const row = db.prepare("select * from command_receipts where command_id = ?").get(String(params.commandId ?? ""));
  return row ? { commandId: row.command_id, canvasId: row.canvas_id, actorId: row.actor_id, actorSeq: row.actor_seq, requestHash: row.request_hash, receipt: JSON.parse(row.receipt_json) } : null;
}

function appendEvent(db, e) {
  db.prepare("insert into canvas_events (canvas_id, event_seq, revision, command_id, delta_json, created_at) values (?, ?, ?, ?, ?, ?)").run(canvasOf(e), e.eventSeq, e.revision, e.commandId ?? null, JSON.stringify(e.delta), e.createdAt ?? now());
  return { ok: true };
}
function listEvents(db, params) {
  const canvasId = canvasOf(params);
  const limit = params.limit ?? LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw invalid(`limit 必须在 1..${LIST_LIMIT}`);
  const rows = db.prepare("select event_seq, revision, command_id, delta_json, created_at from canvas_events where canvas_id = ? and event_seq > ? order by event_seq limit ?").all(canvasId, Number(params.afterSeq) || 0, limit + 1);
  return { items: rows.slice(0, limit).map(r => ({ eventSeq: r.event_seq, revision: r.revision, commandId: r.command_id, delta: JSON.parse(r.delta_json), createdAt: r.created_at })), hasMore: rows.length > limit };
}

function putWatermark(db, w) {
  db.prepare("insert into actor_watermarks (canvas_id, actor_id, accepted_seq, ack_seq, retired_before, storage_epoch) values (?, ?, ?, ?, ?, ?) on conflict(canvas_id, actor_id) do update set accepted_seq = excluded.accepted_seq, ack_seq = excluded.ack_seq, retired_before = excluded.retired_before, storage_epoch = excluded.storage_epoch")
    .run(canvasOf(w), w.actorId, w.acceptedSeq ?? 0, w.ackSeq ?? 0, w.retiredBefore ?? 0, w.storageEpoch);
  return { ok: true };
}
function getWatermark(db, params) {
  const row = db.prepare("select * from actor_watermarks where canvas_id = ? and actor_id = ?").get(canvasOf(params), params.actorId);
  return row ? { canvasId: row.canvas_id, actorId: row.actor_id, acceptedSeq: row.accepted_seq, ackSeq: row.ack_seq, retiredBefore: row.retired_before, storageEpoch: row.storage_epoch } : null;
}

/** 旧 appliedOperationIds 全量保存；返回新写入条数（重复记录幂等）。 */
function recordLegacyOperationIds(db, params) {
  const canvasId = canvasOf(params);
  if (!Array.isArray(params.operationIds)) throw invalid("operationIds 必须是数组");
  const insert = db.prepare("insert or ignore into legacy_operation_ids (canvas_id, operation_id) values (?, ?)");
  let added = 0;
  db.transaction(() => { for (const id of params.operationIds) added += insert.run(canvasId, String(id)).changes; })();
  return added;
}
function hasLegacyOperationId(db, params) {
  return !!db.prepare("select 1 from legacy_operation_ids where canvas_id = ? and operation_id = ?").get(canvasOf(params), String(params.operationId ?? ""));
}

const FORBIDDEN_KEY = /^(auth|oauth)/i;
function setPreference(db, params) {
  if (typeof params?.key !== "string" || !params.key || params.key.length > 200) throw invalid("偏好键无效");
  if (FORBIDDEN_KEY.test(params.key)) throw invalid("OAuth/auth 不进入工作站数据库");
  db.prepare("insert into workspace_preferences (key, value_json) values (?, ?) on conflict(key) do update set value_json = excluded.value_json").run(params.key, JSON.stringify(params.value ?? null));
  return { ok: true };
}
function getPreference(db, params) {
  const row = db.prepare("select value_json from workspace_preferences where key = ?").get(String(params?.key ?? ""));
  return row ? JSON.parse(row.value_json) : null;
}

function startImportRun(db, params) {
  const time = now();
  db.prepare("insert into import_runs (id, source_digest, status, cursor, report_json, created_at, updated_at) values (?, ?, 'started', null, null, ?, ?)").run(params.id, params.sourceDigest, time, time);
  return { ok: true };
}
function updateImportRun(db, params) {
  db.prepare("update import_runs set status = coalesce(?, status), cursor = coalesce(?, cursor), report_json = coalesce(?, report_json), updated_at = ? where id = ?")
    .run(params.status ?? null, params.cursor ?? null, params.report === undefined ? null : JSON.stringify(params.report), now(), params.id);
  return { ok: true };
}
function getImportRun(db, params) {
  const row = db.prepare("select * from import_runs where id = ?").get(String(params.id ?? ""));
  return row ? { id: row.id, sourceDigest: row.source_digest, status: row.status, cursor: row.cursor, report: row.report_json ? JSON.parse(row.report_json) : null, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function putBackupManifest(db, params) {
  db.prepare("insert into backup_manifests (id, revision_manifest_json, media_manifest_json, status, created_at) values (?, ?, ?, ?, ?) on conflict(id) do update set revision_manifest_json = excluded.revision_manifest_json, media_manifest_json = excluded.media_manifest_json, status = excluded.status")
    .run(params.id, JSON.stringify(params.revisionManifest ?? {}), JSON.stringify(params.mediaManifest ?? []), params.status, params.createdAt ?? now());
  return { ok: true };
}
function getBackupManifest(db, params) {
  const row = db.prepare("select * from backup_manifests where id = ?").get(String(params.id ?? ""));
  return row ? { id: row.id, revisionManifest: JSON.parse(row.revision_manifest_json), mediaManifest: JSON.parse(row.media_manifest_json), status: row.status, createdAt: row.created_at } : null;
}

module.exports = {
  putReceipt, getReceipt, appendEvent, listEvents, putWatermark, getWatermark,
  recordLegacyOperationIds, hasLegacyOperationId, setPreference, getPreference,
  startImportRun, updateImportRun, getImportRun, putBackupManifest, getBackupManifest,
};
