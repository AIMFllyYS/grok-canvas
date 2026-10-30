"use strict";
/**
 * 隔离还原（P3-07）：先验证再还原，且只还原到新的空目录，绝不覆盖当前活动数据目录。
 * verifyBackup 检查：manifest version/status、DB 文件 sha256、integrity_check、foreign_key_check、
 * schema 版本不超前且迁移 checksum 与当前代码一致、每个媒体文件 sha256。
 * 还原产物：<targetDir>/grok-canvas.sqlite 与 <targetDir>/assets/*；先写 staging 目录，验证通过后原子改名。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { loadMigrations } = require("./migrate.cjs");
const { sha256File, FORMAT_VERSION } = require("./backup.cjs");

const fail = (code, message, problems) => Object.assign(new Error(message), { code, ...(problems ? { problems } : {}) });
const SAFE_ASSET = /^[A-Za-z0-9._-]+$/;

function checkDatabase(file, migrationsDir) {
  const Database = require("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const problems = [];
    const integrity = db.pragma("integrity_check").map(row => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== "ok") problems.push(`integrity_check: ${integrity.slice(0, 3).join("; ")}`);
    const foreign = db.pragma("foreign_key_check");
    if (foreign.length) problems.push(`foreign_key_check: ${foreign.length} 条违规`);
    const known = new Map(loadMigrations(migrationsDir).map(m => [m.version, m]));
    const applied = db.prepare("select version, name, checksum from schema_migrations order by version").all();
    for (const row of applied) {
      const migration = known.get(row.version);
      if (!migration) problems.push(`schema_future: 备份包含未知 schema 版本 ${row.version}（${row.name}）`);
      else if (migration.checksum !== row.checksum) problems.push(`schema_checksum: 迁移 ${row.name} 与当前程序不一致`);
    }
    return { problems, schemaVersion: applied.length ? applied[applied.length - 1].version : 0 };
  } finally { db.close(); }
}

/** 验证备份目录；返回 { ok, problems, manifest }，不修改任何文件。 */
async function verifyBackup(dir, options = {}) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")); }
  catch (error) { return { ok: false, problems: [error && error.code === "ENOENT" ? "manifest 缺失：备份未完成" : "manifest 无法解析"], manifest: null }; }
  if (manifest.version !== FORMAT_VERSION) problems.push(`不支持的备份格式 ${manifest.version}`);
  if (manifest.status !== "complete") problems.push(`备份状态为 ${manifest.status}，不能用于还原`);
  const dbFile = path.join(dir, "db.sqlite");
  const dbHash = await sha256File(dbFile).catch(() => null);
  if (!dbHash) problems.push("db.sqlite 缺失");
  else if (dbHash.sha256 !== manifest.database?.sha256) problems.push("db.sqlite sha256 与 manifest 不一致");
  else {
    const checked = checkDatabase(dbFile, options.migrationsDir);
    problems.push(...checked.problems);
    if (checked.schemaVersion !== manifest.schemaVersion) problems.push(`manifest schemaVersion ${manifest.schemaVersion} 与数据库 ${checked.schemaVersion} 不一致`);
  }
  for (const entry of Array.isArray(manifest.media) ? manifest.media : []) {
    if (entry.state === "missing_known") continue;
    if (!SAFE_ASSET.test(String(entry.assetName)) || String(entry.assetName).startsWith(".")) { problems.push(`媒体名不安全：${entry.assetName}`); continue; }
    if (entry.state !== "ok") { problems.push(`媒体 ${entry.assetName} 状态 ${entry.state}`); continue; }
    const hash = await sha256File(path.join(dir, "media", entry.assetName)).catch(() => null);
    if (!hash) problems.push(`媒体 ${entry.assetName} 缺失`);
    else if (hash.sha256 !== entry.sha256) problems.push(`媒体 ${entry.assetName} sha256 不一致`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

/**
 * 还原到新目录。params: { backupDir, targetDir, activeDataDir }。
 * targetDir 必须不存在（或为空目录），且不能是活动数据目录或其父/子目录。
 */
async function restoreBackup(params) {
  const { backupDir, targetDir, activeDataDir } = params || {};
  for (const [name, value] of Object.entries({ backupDir, targetDir, activeDataDir })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw fail("invalid_request", `${name} 必须是绝对路径`);
  }
  const target = path.resolve(targetDir), active = path.resolve(activeDataDir);
  if (inside(target, active) || inside(active, target)) throw fail("invalid_request", "还原目标不能是活动数据目录或与其互相包含");
  const existing = await fsp.readdir(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && existing.length) throw fail("invalid_request", "还原目标目录必须为空");
  const verified = await verifyBackup(backupDir, params);
  if (!verified.ok) throw fail("backup_invalid", `备份校验失败：${verified.problems[0]}`, verified.problems);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.staging-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fsp.mkdir(path.join(staging, "assets"), { recursive: true });
    const dbFile = path.join(staging, "grok-canvas.sqlite");
    await fsp.copyFile(path.join(backupDir, "db.sqlite"), dbFile, fs.constants.COPYFILE_EXCL);
    let media = 0;
    for (const entry of verified.manifest.media) {
      if (entry.state !== "ok") continue;
      const copied = path.join(staging, "assets", entry.assetName);
      await fsp.copyFile(path.join(backupDir, "media", entry.assetName), copied, fs.constants.COPYFILE_EXCL);
      if ((await sha256File(copied)).sha256 !== entry.sha256) throw fail("backup_invalid", `复制后媒体 ${entry.assetName} 校验失败`);
      media++;
    }
    const again = checkDatabase(dbFile, params.migrationsDir);
    if (again.problems.length) throw fail("backup_invalid", `还原后的数据库校验失败：${again.problems[0]}`, again.problems);
    if (existing) await fsp.rmdir(target);
    await fsp.rename(staging, target);
    return { dataDir: target, dbFile: path.join(target, "grok-canvas.sqlite"), media, canvases: verified.manifest.canvases.length, backupId: verified.manifest.id };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { verifyBackup, restoreBackup };
