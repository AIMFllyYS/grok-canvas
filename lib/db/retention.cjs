"use strict";
/**
 * P3-10 保留与水位（contracts.md C6）：让长期运行的库有界，同时保证迟到重试不重复执行。
 *
 * - 事件：每画布至少保留最近 10000 条，且只删除 24 小时前的；被删窗口之前的增量请求得到 410 snapshot_required。
 * - 回执：只压缩「已被该 actor 确认（ack_seq）且超过 24 小时」或「超过 7 天」的详细回执。
 *   压缩保留 command_id/actor_seq/request_hash 与精简回执（修订号、变更 ID），重发同一命令仍返回该回执、不再执行；
 *   actor_watermarks.retired_before 记录已压缩的最高序号 + 1。
 * - ack：只接受不超过该 actor 已接受序号的水位，单调不减；未来序号拒绝。
 * - 墓碑与旧 operationId 不物理删除，只计数；媒体不做 GC。
 * - 每次调用是有界批次（默认 500 行），返回 more 供调度器继续。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = { keepEvents: 10000, maxAgeMs: DAY_MS, receiptMaxAgeMs: 7 * DAY_MS, batch: 500, pressureBytes: 64 * 1024 * 1024 };

const requestError = (code, message) => Object.assign(new Error(message), { code });
const iso = (ms) => new Date(ms).toISOString();

function minimalReceipt(receipt) {
  const delta = receipt && receipt.delta ? receipt.delta : {};
  return {
    commandId: receipt.commandId, revision: receipt.revision, eventSeq: receipt.eventSeq, storageEpoch: receipt.storageEpoch,
    changedNodeIds: Array.isArray(receipt.changedNodeIds) ? receipt.changedNodeIds : [],
    changedEdgeIds: Array.isArray(receipt.changedEdgeIds) ? receipt.changedEdgeIds : [],
    fieldVersions: [],
    delta: {
      canvasId: delta.canvasId, fromRevision: delta.fromRevision ?? receipt.revision, revision: delta.revision ?? receipt.revision,
      nodes: [], documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [],
    },
    replayed: false,
    compacted: true,
  };
}

/** 一个有界压缩批次。params: { now?, keepEvents?, maxAgeMs?, receiptMaxAgeMs?, batch? } */
function compact(db, params = {}) {
  const now = Number.isFinite(params.now) ? params.now : Date.now();
  const keepEvents = params.keepEvents ?? RETENTION.keepEvents;
  const batch = params.batch ?? RETENTION.batch;
  const eventCutoff = iso(now - (params.maxAgeMs ?? RETENTION.maxAgeMs));
  const ackedCutoff = iso(now - (params.maxAgeMs ?? RETENTION.maxAgeMs));
  const oldCutoff = iso(now - (params.receiptMaxAgeMs ?? RETENTION.receiptMaxAgeMs));
  const result = { eventsDeleted: 0, receiptsCompacted: 0, more: false };
  db.transaction(() => {
    let budget = batch;
    for (const canvas of db.prepare("select canvas_id, max(event_seq) as top from canvas_events group by canvas_id").all()) {
      if (budget <= 0) { result.more = true; break; }
      const limitSeq = canvas.top - keepEvents;
      if (limitSeq <= 0) continue;
      const rows = db.prepare("select event_seq from canvas_events where canvas_id = ? and event_seq <= ? and created_at < ? order by event_seq limit ?").all(canvas.canvas_id, limitSeq, eventCutoff, budget + 1);
      if (rows.length > budget) { result.more = true; rows.length = budget; }
      if (!rows.length) continue;
      const through = rows[rows.length - 1].event_seq;
      const info = db.prepare("delete from canvas_events where canvas_id = ? and event_seq <= ? and created_at < ?").run(canvas.canvas_id, through, eventCutoff);
      result.eventsDeleted += info.changes;
      budget -= info.changes;
    }
    const receiptBudget = batch;
    const receipts = db.prepare(`
      select r.command_id, r.canvas_id, r.actor_id, r.actor_seq, r.receipt_json
      from command_receipts r
      left join actor_watermarks w on w.canvas_id = r.canvas_id and w.actor_id = r.actor_id
      where json_extract(r.receipt_json, '$.compacted') is null
        and ((w.ack_seq is not null and r.actor_seq <= w.ack_seq and r.created_at < ?) or r.created_at < ?)
      order by r.canvas_id, r.actor_id, r.actor_seq limit ?`).all(ackedCutoff, oldCutoff, receiptBudget + 1);
    if (receipts.length > receiptBudget) { result.more = true; receipts.length = receiptBudget; }
    const update = db.prepare("update command_receipts set receipt_json = ? where command_id = ?");
    const retire = db.prepare("update actor_watermarks set retired_before = max(retired_before, ?) where canvas_id = ? and actor_id = ?");
    for (const row of receipts) {
      const stored = JSON.parse(row.receipt_json);
      const next = stored.error ? { error: stored.error, compacted: true } : { receipt: minimalReceipt(stored.receipt || {}), compacted: true };
      update.run(JSON.stringify(next), row.command_id);
      retire.run(row.actor_seq + 1, row.canvas_id, row.actor_id);
      result.receiptsCompacted++;
    }
  })();
  return result;
}

/** params: { canvasId, actorId, ackSeq, storageEpoch? } → { ackSeq, acceptedSeq } */
function ack(db, params = {}) {
  const canvasId = typeof params.canvasId === "string" ? params.canvasId : "";
  const actorId = typeof params.actorId === "string" ? params.actorId : "";
  const ackSeq = params.ackSeq;
  if (!canvasId || !actorId) throw requestError("invalid_request", "缺少 canvasId/actorId");
  if (!Number.isSafeInteger(ackSeq) || ackSeq < 0) throw requestError("invalid_request", "ackSeq 必须是非负整数");
  const row = db.prepare("select accepted_seq, ack_seq, storage_epoch from actor_watermarks where canvas_id = ? and actor_id = ?").get(canvasId, actorId);
  if (!row) throw requestError("not_found", "该 actor 在此画布没有已接受的命令");
  if (params.storageEpoch !== undefined && params.storageEpoch !== row.storage_epoch) throw requestError("stale_epoch", `存储纪元已变为 ${row.storage_epoch}`);
  if (ackSeq > row.accepted_seq) throw requestError("invalid_request", `ackSeq ${ackSeq} 超过已接受序号 ${row.accepted_seq}`);
  const next = Math.max(row.ack_seq, ackSeq);
  if (next !== row.ack_seq) db.prepare("update actor_watermarks set ack_seq = ? where canvas_id = ? and actor_id = ?").run(next, canvasId, actorId);
  return { ackSeq: next, acceptedSeq: row.accepted_seq };
}

/** 空间与水位报告；params.canvasId 省略时为全库。 */
function stats(db, params = {}) {
  const scoped = typeof params.canvasId === "string" && params.canvasId;
  const args = scoped ? [params.canvasId] : [];
  const one = (sql, condition) => {
    const clauses = [scoped ? "canvas_id = ?" : null, condition].filter(Boolean);
    return db.prepare(sql + (clauses.length ? ` where ${clauses.join(" and ")}` : "")).get(...args);
  };
  const events = one("select count(*) as n, coalesce(sum(length(cast(delta_json as blob))), 0) as bytes from canvas_events");
  const receipts = one("select count(*) as n, coalesce(sum(case when json_extract(receipt_json, '$.compacted') is not null then 1 else 0 end), 0) as compacted, coalesce(sum(length(cast(receipt_json as blob))), 0) as bytes from command_receipts");
  const tombNodes = one("select count(*) as n from nodes", "deleted_at is not null");
  const tombEdges = one("select count(*) as n from edges", "deleted_at is not null");
  const legacy = one("select count(*) as n from legacy_operation_ids");
  const where = scoped ? " where canvas_id = ?" : "";
  const watermarks = db.prepare(`select canvas_id, actor_id, accepted_seq, ack_seq, retired_before from actor_watermarks${where} order by canvas_id, actor_id`).all(...args)
    .map(w => ({ canvasId: w.canvas_id, actorId: w.actor_id, acceptedSeq: w.accepted_seq, ackSeq: w.ack_seq, retiredBefore: w.retired_before }));
  return {
    events: events.n, eventBytes: events.bytes,
    receipts: receipts.n, compactedReceipts: receipts.compacted, receiptBytes: receipts.bytes,
    tombstones: { nodes: tombNodes.n, edges: tombEdges.n },
    legacyOperationIds: legacy.n,
    watermarks,
    // 背压信号：未压缩事件超过 64MiB 时上报，由调用方提示；正式事件不会因此被丢弃。
    pressure: events.bytes > RETENTION.pressureBytes,
  };
}

module.exports = { compact, ack, stats, RETENTION, minimalReceipt };
