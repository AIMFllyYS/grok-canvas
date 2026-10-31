"use strict";
/**
 * 导入校验（P3-06）：对照导入时记录的期望（每源文件的实体数量与规范化 hash）检查 staging 库，
 * 并跑 integrity_check 与 foreign_key_check。输出每个目标表的期望/实际对照与问题清单。
 */
const crypto = require("node:crypto");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** 节点规范化 hash：按 ID 排序后的类型/几何/数据/版本/正文 ID。源与库各算一次比较。 */
function nodesHash(nodes) {
  return sha256(canonicalJson([...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(n => ({ id: n.id, type: n.type, schemaVersion: n.schemaVersion, geometry: n.geometry, data: n.data, documentId: n.documentId, entityVersion: n.entityVersion, geometryVersion: n.geometryVersion }))));
}
const messagesHash = (messages) => sha256(messages.map(m => m.id).join("\n"));

function validateImport(db, expectations) {
  const problems = [];
  const tables = [];
  const integrity = db.pragma("integrity_check").map(row => row.integrity_check);
  if (integrity.length !== 1 || integrity[0] !== "ok") problems.push(`integrity_check: ${integrity.slice(0, 3).join("; ")}`);
  const foreign = db.pragma("foreign_key_check");
  if (foreign.length) problems.push(`foreign_key_check: ${foreign.length} 条违规（首个表 ${foreign[0].table}）`);

  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  for (const [canvasId, expected] of Object.entries(expectations.canvases)) {
    const canvas = db.prepare("select revision from canvases where id = ?").get(canvasId);
    const rows = db.prepare("select id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json from nodes where canvas_id = ? and deleted_at is null").all(canvasId)
      .map(r => ({ id: r.id, type: r.type, schemaVersion: r.schema_version, geometry: { x: r.x, y: r.y, width: r.width, height: r.height }, data: JSON.parse(r.data_json), documentId: r.document_id, entityVersion: r.entity_version, geometryVersion: r.geometry_version }));
    const actual = {
      revision: canvas ? canvas.revision : null,
      nodes: rows.length,
      documents: count("select count(*) as n from documents where canvas_id = ?", canvasId),
      edges: count("select count(*) as n from edges where canvas_id = ? and deleted_at is null", canvasId),
      nodesHash: nodesHash(rows),
      operationIds: count("select count(*) as n from legacy_operation_ids where canvas_id = ?", canvasId),
      claims: count("select count(*) as n from generation_claims where canvas_id = ?", canvasId),
      receipts: count("select count(*) as n from command_receipts where canvas_id = ?", canvasId),
      actors: count("select count(*) as n from actor_watermarks where canvas_id = ?", canvasId),
    };
    for (const key of Object.keys(expected)) if (expected[key] !== actual[key]) problems.push(`画布 ${canvasId} 的 ${key}：期望 ${expected[key]}，实际 ${actual[key]}`);
    tables.push({ source: `canvases/${canvasId}.json`, expected, actual });
  }
  for (const [key, expected] of Object.entries(expectations.conversations)) {
    const [canvasId, conversationId] = key.split("/");
    const ids = db.prepare("select id from agent_messages where canvas_id = ? and conversation_id = ? order by ordinal").all(canvasId, conversationId);
    const actual = { messages: ids.length, idsHash: messagesHash(ids) };
    if (actual.messages !== expected.messages || actual.idsHash !== expected.idsHash) problems.push(`会话 ${key} 消息数量或顺序不一致`);
    tables.push({ source: `agent/${canvasId}.json#${conversationId}`, expected, actual });
  }
  const taskCount = expectations.tasks.length ? count(`select count(*) as n from task_runs where task_id in (${expectations.tasks.map(() => "?").join(",")})`, ...expectations.tasks) : 0;
  if (taskCount !== expectations.tasks.length) problems.push(`视频任务：期望 ${expectations.tasks.length}，实际 ${taskCount}`);
  tables.push({ source: "video-tasks/*.json", expected: { task_runs: expectations.tasks.length }, actual: { task_runs: taskCount } });
  for (const [assetName, hash] of Object.entries(expectations.generations)) {
    const row = db.prepare("select snapshot_json from generation_records where asset_name = ?").get(assetName);
    const actual = row ? sha256(canonicalJson(JSON.parse(row.snapshot_json))) : null;
    if (actual !== hash) problems.push(`生成记录 ${assetName} 快照 hash 不一致`);
  }
  tables.push({ source: "generations/*.json", expected: { generation_records: Object.keys(expectations.generations).length }, actual: { generation_records: count("select count(*) as n from generation_records") } });
  return { ok: problems.length === 0, problems, tables };
}

module.exports = { validateImport, canonicalJson, nodesHash, messagesHash };
