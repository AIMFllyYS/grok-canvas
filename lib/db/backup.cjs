"use strict";
/**
 * 一致性备份（P3-07，contracts.md C6）。备份格式 version 1：
 *   <backupRoot>/<id>/manifest.json   最后写入；status=complete 才可用于还原
 *   <backupRoot>/<id>/db.sqlite       better-sqlite3 Backup API 得到的一致性快照（不复制活跃主文件）
 *   <backupRoot>/<id>/media/<asset>   从快照枚举的媒体，复制后逐个 sha256
 * - DB 快照在复制媒体之前完成；复制媒体时不持有任何事务，交互写入照常进行。
 * - 媒体清单只从快照读，备份期间新增的媒体不会混入；文件系统不在 SQL 事务内，缺失文件记为 missing，备份为 incomplete。
 * - 中断（异常/崩溃）留下的目录没有 complete manifest，listBackups 不会把它列为有效备份。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const FORMAT_VERSION = 1;
const SAFE_ASSET = /^[A-Za-z0-9._-]+$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  await pipeline(fs.createReadStream(file), async function* (source) { for await (const chunk of source) { hash.update(chunk); bytes += chunk.length; } });
  return { sha256: hash.digest("hex"), bytes };
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, file);
}

/** 资产相对路径只能落在数据目录内（assets/<安全名>）。 */
function mediaSource(dataDir, row) {
  if (!SAFE_ASSET.test(row.asset_name) || row.asset_name.startsWith(".")) throw fail("invalid_request", `素材名不安全：${row.asset_name}`);
  const resolved = path.resolve(dataDir, row.relative_path || path.join("assets", row.asset_name));
  const root = path.resolve(dataDir) + path.sep;
  if (!resolved.startsWith(root)) throw fail("invalid_request", `素材路径越界：${row.relative_path}`);
  return resolved;
}

function schemaVersionOf(snapshot) {
  return snapshot.prepare("select coalesce(max(version), 0) as v from schema_migrations").get().v;
}

/**
 * 创建备份。params: { dataDir, backupRoot, id?, onProgress?, openReadonly? }。
 * onProgress({ phase: "database"|"media", done, total }) 用于维护任务报告进度。
 */
async function createBackup(db, params) {
  const { dataDir, backupRoot } = params || {};
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw fail("invalid_request", "dataDir 必须是绝对路径");
  if (typeof backupRoot !== "string" || !path.isAbsolute(backupRoot)) throw fail("invalid_request", "backupRoot 必须是绝对路径");
  const id = params.id ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw fail("invalid_request", "备份 ID 只能包含字母、数字和连字符");
  const dir = path.join(backupRoot, id);
  await fsp.mkdir(path.join(dir, "media"), { recursive: true });
  const startedAt = new Date().toISOString();
  const progress = typeof params.onProgress === "function" ? params.onProgress : () => {};
  const record = (status, canvases, media) => db.prepare("insert into backup_manifests (id, revision_manifest_json, media_manifest_json, status, created_at) values (?, ?, ?, ?, ?) on conflict(id) do update set revision_manifest_json = excluded.revision_manifest_json, media_manifest_json = excluded.media_manifest_json, status = excluded.status")
    .run(id, JSON.stringify(canvases), JSON.stringify(media), status, startedAt);
  record("running", [], []);
  try {
    const dbFile = path.join(dir, "db.sqlite");
    // 一致性快照：SQLite 在线备份；源被修改时按页重做，结果总是某个已提交事务后的完整状态。
    await db.backup(dbFile, { progress: ({ totalPages, remainingPages }) => { progress({ phase: "database", done: totalPages - remainingPages, total: totalPages }); return 256; } });
    const Database = require("better-sqlite3");
    const snapshot = new Database(dbFile, { readonly: true, fileMustExist: true });
    let canvases, assets, schemaVersion;
    try {
      schemaVersion = schemaVersionOf(snapshot);
      canvases = snapshot.prepare("select id, revision from canvases where deleted_at is null order by id").all();
      assets = snapshot.prepare("select asset_name, relative_path, kind, sha256, status from assets order by asset_name").all();
    } finally { snapshot.close(); }
    const dbHash = await sha256File(dbFile);
    const media = [];
    let done = 0;
    for (const row of assets) {
      const entry = { assetName: row.asset_name, relativePath: row.relative_path, kind: row.kind };
      if (row.status === "missing") { media.push({ ...entry, state: "missing_known" }); progress({ phase: "media", done: ++done, total: assets.length }); continue; }
      const source = mediaSource(dataDir, row);
      const target = path.join(dir, "media", row.asset_name);
      try {
        await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error && error.code === "ENOENT") { media.push({ ...entry, state: "missing" }); progress({ phase: "media", done: ++done, total: assets.length }); continue; }
        throw error;
      }
      const copied = await sha256File(target);
      // 登记过 sha256 的素材必须与登记值一致；不一致说明源文件已损坏或被替换。
      const state = row.sha256 && row.sha256 !== copied.sha256 ? "hash_mismatch" : "ok";
      media.push({ ...entry, state, sha256: copied.sha256, bytes: copied.bytes, ...(row.sha256 ? { registeredSha256: row.sha256 } : {}) });
      progress({ phase: "media", done: ++done, total: assets.length });
    }
    const problems = media.filter(m => m.state === "missing" || m.state === "hash_mismatch").length;
    const status = problems ? "incomplete" : "complete";
    const manifest = {
      version: FORMAT_VERSION, id, status, startedAt, completedAt: new Date().toISOString(), schemaVersion,
      database: { file: "db.sqlite", sha256: dbHash.sha256, bytes: dbHash.bytes },
      canvases, media,
    };
    await writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
    record(status === "complete" ? "complete" : "failed", canvases, media);
    return { id, dir, status, problems, canvases: canvases.length, media: media.length };
  } catch (error) {
    try { record("failed", [], []); } catch { /* 源库不可写时保留原始错误 */ }
    throw error;
  }
}

/** 只列出 manifest 完整且 status=complete 的备份；中断/不完整的单独报告，不作为可用备份。 */
async function listBackups(backupRoot) {
  const entries = await fsp.readdir(backupRoot, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const valid = [], invalid = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupRoot, entry.name);
    try {
      const manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
      if (manifest.version === FORMAT_VERSION && manifest.status === "complete") valid.push({ id: manifest.id, dir, completedAt: manifest.completedAt });
      else invalid.push({ id: entry.name, dir, reason: `status=${manifest.status}` });
    } catch (error) {
      invalid.push({ id: entry.name, dir, reason: error && error.code === "ENOENT" ? "manifest 缺失（备份未完成）" : "manifest 无法解析" });
    }
  }
  return { valid: valid.sort((a, b) => a.completedAt.localeCompare(b.completedAt)), invalid };
}

module.exports = { createBackup, listBackups, sha256File, writeJsonAtomic, FORMAT_VERSION };
