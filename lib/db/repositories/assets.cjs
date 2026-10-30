"use strict";
/**
 * 素材 repository（contracts.md C5，P3-03）：assets 是物理文件元数据，canvas_assets 是画布归属。
 * 两者分离：A 能看到的素材不会自动成为 B 的目录；同一物理文件（相同 sha256/路径）各自归属独立。
 */
const LIST_LIMIT = 50;
const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });

function putAsset(db, asset) {
  if (!asset || typeof asset.assetName !== "string") throw invalid("缺少 assetName");
  db.prepare("insert into assets (asset_name, relative_path, kind, bytes, sha256, width, height, duration, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(asset_name) do update set relative_path = excluded.relative_path, bytes = excluded.bytes, sha256 = excluded.sha256, width = excluded.width, height = excluded.height, duration = excluded.duration, status = excluded.status")
    .run(asset.assetName, asset.relativePath, asset.kind, asset.bytes ?? null, asset.sha256 ?? null, asset.width ?? null, asset.height ?? null, asset.duration ?? null, asset.status ?? "ready");
  return { ok: true };
}

function linkCanvasAsset(db, params) {
  if (!params || typeof params.canvasId !== "string") throw invalid("缺少 canvasId");
  db.prepare("insert into canvas_assets (canvas_id, asset_name, created_at, missing) values (?, ?, ?, ?) on conflict(canvas_id, asset_name) do update set missing = excluded.missing")
    .run(params.canvasId, params.assetName, params.createdAt, params.missing ? 1 : 0);
  return { ok: true };
}

function listCanvasAssets(db, params, ctx) {
  if (!params || typeof params.canvasId !== "string") throw invalid("缺少 canvasId：每个查询都必须按画布过滤");
  const limit = params.limit ?? LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw invalid(`limit 必须在 1..${LIST_LIMIT}`);
  const sql = "select ca.asset_name, ca.created_at, ca.missing, a.kind, a.bytes, a.width, a.height, a.status from canvas_assets ca join assets a on a.asset_name = ca.asset_name where ca.canvas_id = ? and ca.asset_name > ? order by ca.asset_name limit ?";
  if (ctx && typeof ctx.trace === "function") ctx.trace(sql, []);
  const rows = db.prepare(sql).all(params.canvasId, typeof params.cursor === "string" ? params.cursor : "", limit + 1);
  const items = rows.slice(0, limit).map(r => ({ assetName: r.asset_name, createdAt: r.created_at, missing: r.missing === 1, kind: r.kind, bytes: r.bytes, width: r.width, height: r.height, status: r.status }));
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].assetName : null };
}

function canvasHasAsset(db, params) {
  return !!db.prepare("select 1 from canvas_assets where canvas_id = ? and asset_name = ?").get(params.canvasId, params.assetName);
}

module.exports = { putAsset, linkCanvasAsset, listCanvasAssets, canvasHasAsset };
