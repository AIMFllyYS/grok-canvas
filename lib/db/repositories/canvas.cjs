"use strict";
/**
 * 画布实体 repository（contracts.md C1/C5，P3-03）。可直接随包运行的 CommonJS，由 DB Worker 固定派发。
 * - 每个查询都必须带 canvas_id；缺失直接 invalid_request。
 * - 几何/摘要列表不选 documents.content；正文只按指定文档分块读取（每块 ≤16000 字符）。
 * - 列表 limit 上限 50，超出返回 invalid_request（HTTP 400）；一页总 JSON ≤256KiB，超出提前截断并给出游标。
 * - ctx.trace(sql, columns) 记录实际执行的 SQL 与选取列，供测试诊断，防止退回“读整图再过滤”。
 * 不提供任意 SQL 接口。
 */
const LIST_LIMIT = 50;
const PAGE_BYTES = 256 * 1024;
const CHUNK_CHARS = 16_000;

const SQL = Object.freeze({
  listCanvases: "select id, project_id, name, revision, name_version, storage_epoch, created_at, updated_at from canvases where project_id = ? and deleted_at is null and (updated_at < ? or (updated_at = ? and id > ?)) order by updated_at desc, id limit ?",
  listGeometry: "select id, type, x, y, width, height, geometry_version from nodes where canvas_id = ? and deleted_at is null and id > ? order by id limit ?",
  listSummaries: "select id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json from nodes where canvas_id = ? and deleted_at is null and id > ? order by id limit ?",
  getNodes: "select id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json from nodes where canvas_id = ? and deleted_at is null and id in (select value from json_each(?)) order by id",
  documentChunk: "select length(content) as total, substr(content, ? + 1, ?) as text, version from documents where canvas_id = ? and id = ?",
  listEdges: "select id, source, target, role, version from edges where canvas_id = ? and deleted_at is null and id > ? order by id limit ?",
  edgesFrom: "select id, source, target, role, version from edges where canvas_id = ? and source = ? and deleted_at is null",
  edgesTo: "select id, source, target, role, version from edges where canvas_id = ? and target = ? and deleted_at is null",
  fieldVersions: "select node_id, field, version from node_fields where canvas_id = ? and node_id in (select value from json_each(?))",
});

const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });
const notFound = (message) => Object.assign(new Error(message), { code: "not_found" });
const canvasOf = (params) => {
  if (!params || typeof params.canvasId !== "string" || !params.canvasId) throw invalid("缺少 canvasId：每个查询都必须按画布过滤");
  return params.canvasId;
};
const limitOf = (params, fallback = LIST_LIMIT) => {
  const limit = params.limit ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw invalid("limit 必须是正整数");
  if (limit > LIST_LIMIT) throw invalid(`limit 上限为 ${LIST_LIMIT}`);
  return limit;
};
const columnsOf = (sql) => sql.slice(7, sql.indexOf(" from ")).split(",").map(c => c.trim());
function run(db, ctx, sql, method, ...args) {
  if (ctx && typeof ctx.trace === "function") ctx.trace(sql, columnsOf(sql));
  return db.prepare(sql)[method](...args);
}

const summaryRow = (row) => ({
  id: row.id, type: row.type, schemaVersion: row.schema_version,
  geometry: { x: row.x, y: row.y, width: row.width, height: row.height },
  entityVersion: row.entity_version, geometryVersion: row.geometry_version,
  documentId: row.document_id, data: JSON.parse(row.data_json),
});

/** 按字节上限截断一页（至少保留 1 条，避免单条超大时死循环）。 */
function page(items, limit, size, cursorOf) {
  const out = [];
  let bytes = 2;
  for (const item of items.slice(0, limit)) {
    const length = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (out.length && bytes + length > PAGE_BYTES) break;
    out.push(item);
    bytes += length;
  }
  const more = out.length < items.length || items.length > limit;
  return { items: out, nextCursor: more && out.length ? cursorOf(out[out.length - 1]) : null, bytes: size ? bytes : undefined };
}

function listCanvases(db, params = {}, ctx) {
  const limit = limitOf(params);
  const projectId = typeof params.projectId === "string" ? params.projectId : "default-project";
  const [updatedAt, id] = typeof params.cursor === "string" && params.cursor.includes("|") ? params.cursor.split("|") : ["\uffff", ""];
  const rows = run(db, ctx, SQL.listCanvases, "all", projectId, updatedAt, updatedAt, id, limit + 1);
  const items = rows.map(r => ({ id: r.id, projectId: r.project_id, name: r.name, revision: r.revision, nameVersion: r.name_version, storageEpoch: r.storage_epoch, createdAt: r.created_at, updatedAt: r.updated_at }));
  return page(items, limit, false, item => `${item.updatedAt}|${item.id}`);
}

function listGeometry(db, params, ctx) {
  const canvasId = canvasOf(params), limit = limitOf(params);
  const rows = run(db, ctx, SQL.listGeometry, "all", canvasId, typeof params.cursor === "string" ? params.cursor : "", limit + 1);
  const items = rows.map(r => ({ id: r.id, type: r.type, geometry: { x: r.x, y: r.y, width: r.width, height: r.height }, geometryVersion: r.geometry_version }));
  return page(items, limit, false, item => item.id);
}

function listNodeSummaries(db, params, ctx) {
  const canvasId = canvasOf(params), limit = limitOf(params);
  const rows = run(db, ctx, SQL.listSummaries, "all", canvasId, typeof params.cursor === "string" ? params.cursor : "", limit + 1);
  return page(rows.map(summaryRow), limit, false, item => item.id);
}

function getNodes(db, params, ctx) {
  const canvasId = canvasOf(params);
  if (!Array.isArray(params.ids) || params.ids.some(id => typeof id !== "string")) throw invalid("ids 必须是字符串数组");
  if (params.ids.length > LIST_LIMIT) throw invalid(`一次最多读取 ${LIST_LIMIT} 个节点`);
  return run(db, ctx, SQL.getNodes, "all", canvasId, JSON.stringify(params.ids)).map(summaryRow);
}

function getDocumentChunk(db, params, ctx) {
  const canvasId = canvasOf(params);
  const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
  const length = Math.min(Number.isSafeInteger(params.length) && params.length > 0 ? params.length : CHUNK_CHARS, CHUNK_CHARS);
  const row = run(db, ctx, SQL.documentChunk, "get", offset, length, canvasId, String(params.documentId ?? ""));
  if (!row) throw notFound("文档不存在");
  const end = offset + row.text.length;
  return { text: row.text, total: row.total, version: row.version, offset, nextOffset: end < row.total ? end : null };
}

function listEdges(db, params, ctx) {
  const canvasId = canvasOf(params), limit = limitOf(params);
  const rows = run(db, ctx, SQL.listEdges, "all", canvasId, typeof params.cursor === "string" ? params.cursor : "", limit + 1);
  return page(rows.map(r => ({ id: r.id, source: r.source, target: r.target, role: r.role, version: r.version })), limit, false, item => item.id);
}

function edgesOf(db, params, ctx) {
  const canvasId = canvasOf(params);
  const nodeId = String(params.nodeId ?? "");
  const map = r => ({ id: r.id, source: r.source, target: r.target, role: r.role, version: r.version });
  return { outgoing: run(db, ctx, SQL.edgesFrom, "all", canvasId, nodeId).map(map), incoming: run(db, ctx, SQL.edgesTo, "all", canvasId, nodeId).map(map) };
}

/** 合成数据/导入写入：一个事务写画布、节点、正文、字段版本与连线。普通命令写入在 P3-05。 */
function putCanvas(db, params) {
  const { canvas, nodes = [], documents = [], edges = [], fieldVersions = {} } = params || {};
  if (!canvas || typeof canvas.id !== "string") throw invalid("缺少 canvas");
  db.transaction(() => {
    db.prepare("insert into canvases (id, project_id, name, revision, name_version, storage_epoch, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set name = excluded.name, revision = excluded.revision, name_version = excluded.name_version, storage_epoch = excluded.storage_epoch, updated_at = excluded.updated_at")
      .run(canvas.id, canvas.projectId ?? "default-project", canvas.name ?? "", canvas.revision ?? 0, canvas.nameVersion ?? 0, canvas.storageEpoch ?? "sql-v1", canvas.createdAt, canvas.updatedAt ?? canvas.createdAt);
    const insertNode = db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const node of nodes) {
      if (node.canvasId !== canvas.id) throw invalid(`节点 ${node.id} 不属于画布 ${canvas.id}`);
      insertNode.run(canvas.id, node.id, node.type, node.schemaVersion, node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height, node.entityVersion, node.geometryVersion, node.documentId, JSON.stringify(node.data));
    }
    const insertDocument = db.prepare("insert into documents (canvas_id, id, node_id, content, version) values (?, ?, ?, ?, ?)");
    for (const document of documents) insertDocument.run(canvas.id, document.id, document.nodeId, document.content, document.version);
    const insertField = db.prepare("insert into node_fields (canvas_id, node_id, field, version) values (?, ?, ?, ?)");
    for (const [nodeId, fields] of Object.entries(fieldVersions)) for (const [field, version] of Object.entries(fields)) insertField.run(canvas.id, nodeId, field, version);
    const insertEdge = db.prepare("insert into edges (canvas_id, id, source, target, role, version) values (?, ?, ?, ?, ?, ?)");
    for (const edge of edges) insertEdge.run(canvas.id, edge.id, edge.source, edge.target, edge.role ?? null, edge.version ?? 0);
  })();
  return { ok: true };
}

/** 删除墓碑：节点与相关边标记 deleted_at，行与正文保留，供撤销/恢复查询。 */
function tombstoneNode(db, params) {
  const canvasId = canvasOf(params);
  db.transaction(() => {
    db.prepare("update nodes set deleted_at = ? where canvas_id = ? and id = ? and deleted_at is null").run(params.deletedAt, canvasId, params.nodeId);
    db.prepare("update edges set deleted_at = ? where canvas_id = ? and (source = ? or target = ?) and deleted_at is null").run(params.deletedAt, canvasId, params.nodeId, params.nodeId);
  })();
  return { ok: true };
}

function getTombstone(db, params, ctx) {
  const canvasId = canvasOf(params);
  const row = run(db, ctx, "select id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json, deleted_at from nodes where canvas_id = ? and id = ? and deleted_at is not null", "get", canvasId, params.nodeId);
  if (!row) throw notFound("没有该节点的墓碑");
  const edges = run(db, ctx, "select id, source, target, role, version from edges where canvas_id = ? and (source = ? or target = ?)", "all", canvasId, params.nodeId, params.nodeId);
  const document = row.document_id ? run(db, ctx, "select id, content, version from documents where canvas_id = ? and id = ?", "get", canvasId, row.document_id) : null;
  return { node: { ...summaryRow(row), deletedAt: row.deleted_at }, edges, document: document ?? null };
}

module.exports = {
  SQL, LIST_LIMIT, PAGE_BYTES, CHUNK_CHARS,
  listCanvases, listGeometry, listNodeSummaries, getNodes, getDocumentChunk, listEdges, edgesOf,
  putCanvas, tombstoneNode, getTombstone,
};
