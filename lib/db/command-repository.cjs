"use strict";
/**
 * SQL 命令仓库（P3-05，contracts.md C2/C5/C6）：在一个 SQLite 事务里提供 reducer 所需的按实体读取，
 * 并把写集、版本、回执与单一事件一起写入。与 JSON 仓库实现同一 CommandTxn 接口，由 command-adapter.ts 包装。
 * - 读取按实体/字段：move 只读节点行，不 SELECT documents.content；
 * - 写入按差异：只改几何/版本的节点只 UPDATE x/y/width/height/版本，不 UPDATE data_json；
 * - 删除是墓碑（deleted_at），正文与边行保留供恢复；墓碑 ID 不能复活；
 * - options.trace(sql) 记录每次语句执行；options.failAt 仅用于故障注入测试（after_node/before_receipt/after_event）。
 * 当前只由测试显式选择；用户主库切换在 P3-08。
 */
const nowIso = () => new Date().toISOString();
const NODE_COLUMNS = "id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json, deleted_at";
const PAGE_EVENTS = 100;
const PAGE_BYTES = 1024 * 1024;
const OVERSIZED_BYTES = 4 * 1024 * 1024;

function rowToNode(canvasId, row) {
  return {
    id: row.id, canvasId, type: row.type, schemaVersion: row.schema_version,
    geometry: { x: row.x, y: row.y, width: row.width, height: row.height },
    entityVersion: row.entity_version, geometryVersion: row.geometry_version, documentId: row.document_id,
    data: JSON.parse(row.data_json),
  };
}

/** 预编译缓存 + 每次执行回调 trace，SQL 访问计数测试据此证明不读正文、不写 data_json。 */
function statements(db, trace) {
  const cache = new Map();
  return (sql) => {
    let entry = cache.get(sql);
    if (!entry) {
      const prepared = db.prepare(sql);
      const wrap = (method) => (...args) => { trace?.(sql); return prepared[method](...args); };
      entry = { get: wrap("get"), all: wrap("all"), run: wrap("run") };
      cache.set(sql, entry);
    }
    return entry;
  };
}

const fail = (options, point) => { if (options.failAt === point) throw new Error(`故障注入：${point}`); };

/** 在已开启的事务中创建命令事务视图；画布不存在或已删除返回 null。 */
function createSqlTxn(db, canvasId, options = {}) {
  const q = statements(db, options.trace);
  const canvas = q("select name, revision, name_version, storage_epoch, deleted_at from canvases where id = ?").get(canvasId);
  if (!canvas || canvas.deleted_at) return null;
  const eventSeq = q("select coalesce(max(event_seq), 0) as seq from canvas_events where canvas_id = ?").get(canvasId).seq;
  const nodeRow = (id) => q(`select ${NODE_COLUMNS} from nodes where canvas_id = ? and id = ?`).get(canvasId, id);
  const edgeRow = (id) => q("select id, source, target, role, version, deleted_at from edges where canvas_id = ? and id = ?").get(canvasId, id);

  const reader = {
    canvasId,
    canvasName: () => canvas.name,
    nameVersion: () => canvas.name_version,
    getNode(id) { const row = nodeRow(id); return row && !row.deleted_at ? rowToNode(canvasId, row) : undefined; },
    getDocument(id) {
      const row = q("select d.id, d.node_id, d.content, d.version from documents d join nodes n on n.canvas_id = d.canvas_id and n.id = d.node_id where d.canvas_id = ? and d.id = ? and n.deleted_at is null").get(canvasId, id);
      return row ? { id: row.id, nodeId: row.node_id, content: row.content, version: row.version } : undefined;
    },
    getEdge(id) { const row = edgeRow(id); return row && !row.deleted_at ? { id: row.id, canvasId, source: row.source, target: row.target, role: row.role, version: row.version } : undefined; },
    incomingEdgeIds: (nodeId) => q("select id from edges where canvas_id = ? and target = ? and deleted_at is null order by id").all(canvasId, nodeId).map(r => r.id),
    outgoingEdgeIds: (nodeId) => q("select id from edges where canvas_id = ? and source = ? and deleted_at is null order by id").all(canvasId, nodeId).map(r => r.id),
    fieldVersion: (nodeId, field) => q("select version from node_fields where canvas_id = ? and node_id = ? and field = ?").get(canvasId, nodeId, field)?.version ?? 0,
    isNodeTombstoned: (id) => !!nodeRow(id)?.deleted_at,
    isEdgeTombstoned: (id) => !!edgeRow(id)?.deleted_at,
    generationClaim(nodeId) { const row = q("select claim_id, state from generation_claims where canvas_id = ? and node_id = ?").get(canvasId, nodeId); return row ? { id: row.claim_id, state: row.state } : undefined; },
  };

  const storedResult = (commandId) => {
    const row = q("select canvas_id, request_hash, receipt_json, actor_id, actor_seq from command_receipts where command_id = ?").get(commandId);
    if (!row) return undefined;
    const stored = JSON.parse(row.receipt_json);
    return { hash: row.request_hash, actorId: row.actor_id, actorSeq: row.actor_seq, ...(stored.error ? { error: stored.error } : { receipt: stored.receipt }) };
  };
  const acceptedSeq = (actorId) => q("select accepted_seq from actor_watermarks where canvas_id = ? and actor_id = ?").get(canvasId, actorId)?.accepted_seq ?? 0;
  const record = (meta, payload) => {
    q("insert into command_receipts (command_id, canvas_id, actor_id, actor_seq, request_hash, receipt_json, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(meta.commandId, canvasId, meta.actorId, meta.actorSeq, meta.hash, JSON.stringify(payload), nowIso());
    q("insert into actor_watermarks (canvas_id, actor_id, accepted_seq, ack_seq, retired_before, storage_epoch) values (?, ?, ?, 0, 0, ?) on conflict(canvas_id, actor_id) do update set accepted_seq = excluded.accepted_seq")
      .run(canvasId, meta.actorId, meta.actorSeq, canvas.storage_epoch);
  };

  function writeNode(node) {
    const existing = nodeRow(node.id);
    if (existing?.deleted_at) throw new Error(`节点 ${node.id} 已删除，不能复活`);
    if (!existing) {
      q("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(canvasId, node.id, node.type, node.schemaVersion, node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height, node.entityVersion, node.geometryVersion, node.documentId, JSON.stringify(node.data));
      return;
    }
    const dataJson = JSON.stringify(node.data);
    if (dataJson === existing.data_json && node.type === existing.type && node.documentId === existing.document_id && node.schemaVersion === existing.schema_version) {
      q("update nodes set x = ?, y = ?, width = ?, height = ?, entity_version = ?, geometry_version = ? where canvas_id = ? and id = ?")
        .run(node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height, node.entityVersion, node.geometryVersion, canvasId, node.id);
      return;
    }
    q("update nodes set type = ?, schema_version = ?, x = ?, y = ?, width = ?, height = ?, entity_version = ?, geometry_version = ?, document_id = ?, data_json = ? where canvas_id = ? and id = ?")
      .run(node.type, node.schemaVersion, node.geometry.x, node.geometry.y, node.geometry.width, node.geometry.height, node.entityVersion, node.geometryVersion, node.documentId, dataJson, canvasId, node.id);
  }

  function commit(writes, meta) {
    // 与 JSON 仓库一致：已登记且相同的素材不算变化。
    for (const [name, asset] of writes.assets) {
      const existing = q("select ca.created_at, ca.missing, a.kind from canvas_assets ca join assets a on a.asset_name = ca.asset_name where ca.canvas_id = ? and ca.asset_name = ?").get(canvasId, name);
      if (existing && existing.kind === asset.kind && existing.created_at === asset.createdAt && !!existing.missing === asset.missing) writes.assets.delete(name);
    }
    const changed = writes.nodes.size || writes.documents.size || writes.edges.size || writes.removedNodes.size || writes.removedDocuments.size || writes.removedEdges.size || writes.name !== undefined || writes.assets.size;
    const revision = changed ? canvas.revision + 1 : canvas.revision;
    const nextEventSeq = changed ? eventSeq + 1 : eventSeq;
    const at = nowIso();
    if (changed) {
      for (const id of writes.removedEdges) q("update edges set deleted_at = ? where canvas_id = ? and id = ? and deleted_at is null").run(at, canvasId, id);
      for (const id of writes.removedNodes) q("update nodes set deleted_at = ? where canvas_id = ? and id = ? and deleted_at is null").run(at, canvasId, id);
      for (const node of writes.nodes.values()) if (!writes.removedNodes.has(node.id)) writeNode(node);
      fail(options, "after_node");
      for (const document of writes.documents.values()) {
        q("insert into documents (canvas_id, id, node_id, content, version) values (?, ?, ?, ?, ?) on conflict(canvas_id, id) do update set content = excluded.content, version = excluded.version")
          .run(canvasId, document.id, document.nodeId, document.content, document.version);
      }
      for (const edge of writes.edges.values()) {
        if (edgeRow(edge.id)?.deleted_at) throw new Error(`连线 ${edge.id} 已删除，不能复活`);
        q("insert into edges (canvas_id, id, source, target, role, version) values (?, ?, ?, ?, ?, ?) on conflict(canvas_id, id) do update set source = excluded.source, target = excluded.target, role = excluded.role, version = excluded.version")
          .run(canvasId, edge.id, edge.source, edge.target, edge.role, edge.version);
      }
      for (const [nodeId, fields] of writes.nodeFieldVersions) {
        if (writes.removedNodes.has(nodeId)) continue;
        for (const [field, version] of fields) {
          q("insert into node_fields (canvas_id, node_id, field, version) values (?, ?, ?, ?) on conflict(canvas_id, node_id, field) do update set version = excluded.version").run(canvasId, nodeId, field, version);
        }
      }
      for (const asset of writes.assets.values()) {
        q("insert into assets (asset_name, relative_path, kind, status) values (?, ?, ?, ?) on conflict(asset_name) do nothing").run(asset.assetName, `assets/${asset.assetName}`, asset.kind, asset.missing ? "missing" : "ready");
        q("insert into canvas_assets (canvas_id, asset_name, created_at, missing) values (?, ?, ?, ?) on conflict(canvas_id, asset_name) do update set created_at = excluded.created_at, missing = excluded.missing").run(canvasId, asset.assetName, asset.createdAt, asset.missing ? 1 : 0);
      }
      if (writes.name !== undefined) q("update canvases set name = ?, name_version = ? where id = ?").run(writes.name, writes.nameVersion ?? canvas.name_version + 1, canvasId);
      q("update canvases set revision = ?, updated_at = ? where id = ?").run(revision, at, canvasId);
    }
    const delta = {
      canvasId, fromRevision: canvas.revision, revision,
      nodes: [...writes.nodes.values()].filter(node => !writes.removedNodes.has(node.id)).map(node => structuredClone(node)),
      documents: [...writes.documents.values()].map(doc => ({ ...doc })),
      edges: [...writes.edges.values()].map(edge => ({ ...edge })),
      removedNodeIds: [...writes.removedNodes], removedDocumentIds: [...writes.removedDocuments], removedEdgeIds: [...writes.removedEdges],
      assets: [...writes.assets.values()].map(asset => ({ ...asset })),
      ...(writes.name !== undefined ? { name: writes.name } : {}),
    };
    const receipt = {
      commandId: meta.commandId, revision, eventSeq: nextEventSeq, storageEpoch: canvas.storage_epoch,
      changedNodeIds: [...writes.nodes.keys()].filter(id => !writes.removedNodes.has(id)),
      changedEdgeIds: [...writes.edges.keys()],
      fieldVersions: [...writes.fieldVersions.values()],
      delta, replayed: false,
    };
    fail(options, "before_receipt");
    if (changed) q("insert into canvas_events (canvas_id, event_seq, revision, command_id, delta_json, created_at) values (?, ?, ?, ?, ?, ?)").run(canvasId, nextEventSeq, revision, meta.commandId, JSON.stringify(delta), at);
    fail(options, "after_event");
    record(meta, { receipt });
    return receipt;
  }

  return {
    reader, revision: canvas.revision, eventSeq, storageEpoch: canvas.storage_epoch,
    acceptedSeq, storedResult, commit,
    reject(meta, error) { record(meta, { error }); },
  };
}

const requestError = (code, message, status) => Object.assign(new Error(message), { code, status });

/**
 * C6 增量查询：afterRevision 之后的完整事件，每页 ≤100 条且 ≤1MiB；单个事件超过 1MiB 时单独返回（≤4MiB，标 oversized）。
 * 事件按 eventSeq 连续；首个事件的 fromRevision 必须等于 afterRevision，否则 410 snapshot_required。
 */
function listChanges(db, params = {}) {
  const canvasId = typeof params.canvasId === "string" ? params.canvasId : "";
  if (!canvasId) throw requestError("invalid_request", "缺少 canvasId", 400);
  const limit = params.limit ?? PAGE_EVENTS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_EVENTS) throw requestError("invalid_request", `limit 必须在 1..${PAGE_EVENTS}`, 400);
  const after = params.afterRevision;
  if (!Number.isSafeInteger(after) || after < 0) throw requestError("invalid_request", "afterRevision 必须是非负整数", 400);
  const canvas = db.prepare("select revision, storage_epoch, deleted_at from canvases where id = ?").get(canvasId);
  if (!canvas || canvas.deleted_at) throw requestError("not_found", "画布不存在或已删除", 404);
  if (params.storageEpoch !== undefined && params.storageEpoch !== canvas.storage_epoch) throw requestError("stale_epoch", `存储纪元已变为 ${canvas.storage_epoch}`, 409);
  if (after > canvas.revision) throw requestError("invalid_request", `afterRevision 超过当前修订 ${canvas.revision}`, 400);
  const page = { events: [], fromRevision: after, toRevision: after, hasMore: false, storageEpoch: canvas.storage_epoch };
  if (after === canvas.revision) return page;
  const rows = db.prepare("select event_seq, revision, command_id, delta_json, length(cast(delta_json as blob)) as bytes from canvas_events where canvas_id = ? and revision > ? order by event_seq limit ?").all(canvasId, after, limit + 1);
  if (!rows.length || JSON.parse(rows[0].delta_json).fromRevision !== after) throw requestError("snapshot_required", "请求修订之后的事件已不完整，需要重新获取快照", 410);
  let bytes = 0;
  for (const row of rows) {
    if (page.events.length === limit) { page.hasMore = true; break; }
    if (page.events.length && bytes + row.bytes > PAGE_BYTES) { page.hasMore = true; break; }
    if (row.bytes > OVERSIZED_BYTES) throw requestError("snapshot_required", `事件 ${row.event_seq} 超过 4MiB，需要重新获取快照`, 410);
    const oversized = row.bytes > PAGE_BYTES;
    page.events.push({ eventSeq: row.event_seq, revision: row.revision, commandId: row.command_id, delta: JSON.parse(row.delta_json), ...(oversized ? { oversized: true } : {}) });
    bytes += row.bytes;
    page.toRevision = row.revision;
    if (oversized) { page.hasMore = rows.length > page.events.length; break; }
  }
  if (!page.hasMore) page.hasMore = page.toRevision < canvas.revision;
  return page;
}

/** 与 JSON loadEntitySnapshot 同形的快照，供客户端初始化与 JSON/SQL 等价测试。 */
function loadSnapshot(db, canvasId) {
  const canvas = db.prepare("select id, name, revision, name_version, storage_epoch, deleted_at from canvases where id = ?").get(canvasId);
  if (!canvas || canvas.deleted_at) return null;
  const nodes = db.prepare(`select ${NODE_COLUMNS} from nodes where canvas_id = ? and deleted_at is null order by rowid`).all(canvasId).map(row => rowToNode(canvasId, row));
  const documents = db.prepare("select d.id, d.node_id, d.content, d.version from documents d join nodes n on n.canvas_id = d.canvas_id and n.id = d.node_id where d.canvas_id = ? and n.deleted_at is null order by d.rowid").all(canvasId)
    .map(row => ({ id: row.id, nodeId: row.node_id, content: row.content, version: row.version }));
  const edges = db.prepare("select id, source, target, role, version from edges where canvas_id = ? and deleted_at is null order by rowid").all(canvasId)
    .map(row => ({ id: row.id, canvasId, source: row.source, target: row.target, role: row.role, version: row.version }));
  const actors = Object.fromEntries(db.prepare("select actor_id, accepted_seq from actor_watermarks where canvas_id = ?").all(canvasId).map(r => [r.actor_id, { acceptedSeq: r.accepted_seq }]));
  const fieldVersions = {};
  for (const row of db.prepare("select f.node_id, f.field, f.version from node_fields f join nodes n on n.canvas_id = f.canvas_id and n.id = f.node_id where f.canvas_id = ? and n.deleted_at is null and f.field <> 'content'").all(canvasId)) {
    (fieldVersions[row.node_id] ??= {})[row.field] = row.version;
  }
  const eventSeq = db.prepare("select coalesce(max(event_seq), 0) as seq from canvas_events where canvas_id = ?").get(canvasId).seq;
  return { canvasId, revision: canvas.revision, name: canvas.name, nameVersion: canvas.name_version, storageEpoch: canvas.storage_epoch, eventSeq, nodes, documents, edges, actors, fieldVersions };
}

module.exports = { createSqlTxn, listChanges, loadSnapshot, PAGE_EVENTS, PAGE_BYTES, OVERSIZED_BYTES };
