"use strict";
/**
 * 唯一权威切换（P3-08，contracts.md C6）：JSON → SQLite。
 * 阶段：preflight（维护模式 + 阻断检查）→ import（P3-06 staging，可续跑）→ validate → backup（P3-07）
 *      → publish（复制 DB 到 <data>/db/<epoch>.sqlite 并校验）→ marker（原子写 storage-state.json）→ 退出维护。
 * - storage-state.json 是唯一切换点：写入前任何中断都仍是 JSON 权威；写入后只认 SQLite，失败进入恢复，不回退 JSON。
 * - 旧 JSON 全程只读；staging 在数据目录之外（<data>.cutover），不在源目录里写任何业务文件。
 * - 未确认的客户端 outbox 无法由服务端证明：必须由操作者确认（clientsDrained），否则 blocked。
 * - 待定/未知生成或未完成视频任务 blocked，人工处理前不自动重新收费。
 * failAt 只用于断点测试：before_prepare | during_import | after_validate | before_marker | after_marker。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { runImport, DB_FILE } = require("./importer.cjs");
const { createBackup } = require("./backup.cjs");
const { openDatabase } = require("./driver.cjs");

const STATE_FILE = "storage-state.json";
const MAINTENANCE_FILE = "maintenance.json";
const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

async function writeAtomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temporary, file);
  // 目录 fsync：Windows 不支持打开目录，忽略。
  try { const dir = await fsp.open(path.dirname(file), "r"); try { await dir.sync(); } finally { await dir.close(); } } catch { /* Windows */ }
}

function readMarker(dataDir) {
  const file = path.join(dataDir, STATE_FILE);
  if (!fs.existsSync(file)) return null;
  const marker = JSON.parse(fs.readFileSync(file, "utf8"));
  if (marker.version !== 1 || marker.backend !== "sqlite") throw fail("storage_recovery", "storage-state.json 无效");
  return marker;
}

/** 阻断检查：待定/未知生成 claim、未完成或未释放 claim 的视频任务。只读源 JSON。 */
async function preflight(dataDir, clientsDrained) {
  const blockers = [];
  const canvases = path.join(dataDir, "canvases");
  for (const name of await fsp.readdir(canvases).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    let doc;
    try { doc = JSON.parse(await fsp.readFile(path.join(canvases, name), "utf8")); } catch { continue; /* 损坏文件由导入报告阻断 */ }
    for (const [nodeId, claim] of Object.entries(doc.generationClaims || {})) {
      blockers.push({ kind: "generation_claim", canvasId: doc.id, nodeId, state: claim.state, action: claim.state === "unknown" ? "在画布中检查该节点的生成结果并确认，再重新切换；不会自动重新收费" : "等待生成完成后再切换" });
    }
  }
  const tasks = path.join(dataDir, "video-tasks");
  for (const name of await fsp.readdir(tasks).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    let task;
    try { task = JSON.parse(await fsp.readFile(path.join(tasks, name), "utf8")); } catch { continue; }
    const terminal = ["completed", "failed", "expired"].includes(task.status);
    if (!terminal || (task.claim && !task.claimReleased)) blockers.push({ kind: "video_task", taskId: task.taskId, status: task.status, action: "打开对应画布让视频任务恢复完成（不会重新提交），再切换" });
  }
  if (!clientsDrained) blockers.push({ kind: "clients", action: "服务端无法证明所有浏览器标签页的未确认修改已保存：关闭其它标签页、确认保存状态后以 --clients-drained 重试" });
  return blockers;
}

async function runCutover(params) {
  const { dataDir, convert, clientsDrained = false, failAt, backup = true } = params || {};
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw fail("invalid_request", "必须显式指定数据目录（绝对路径）");
  const inject = (point) => { if (failAt === point) throw fail("interrupted", `故障注入：${point}`); };
  const maintenanceFile = path.join(dataDir, MAINTENANCE_FILE);
  const existing = readMarker(dataDir);
  if (existing) {
    // 标记已发布：只完成收尾（退出维护），绝不重新导入或回到 JSON。
    await fsp.rm(maintenanceFile, { force: true });
    return { status: "committed", alreadySwitched: true, epoch: existing.epoch, dbFile: existing.dbFile, importRunId: existing.importRunId };
  }
  inject("before_prepare");
  await writeAtomic(maintenanceFile, { reason: "存储切换", since: new Date().toISOString() });
  const blockers = await preflight(dataDir, clientsDrained);
  if (blockers.length) {
    await fsp.rm(maintenanceFile, { force: true });
    return { status: "blocked", blockers };
  }
  const staging = `${path.resolve(dataDir)}.cutover`;
  const report = await runImport({ sourceDir: dataDir, stagingDir: staging, convert, reset: true, options: failAt === "during_import" ? { failAfterUnits: 2 } : {} });
  if (report.status !== "ready_to_switch") {
    await fsp.rm(maintenanceFile, { force: true });
    return { status: "blocked", blockers: report.blocking.map(b => ({ kind: "import", ...b })), validation: report.validation };
  }
  inject("after_validate");
  let backupResult = null;
  if (backup) {
    const db = openDatabase(path.join(staging, DB_FILE), { busyTimeoutMs: 5000 });
    try { backupResult = await createBackup(db, { dataDir, backupRoot: path.join(staging, "backups") }); }
    finally { db.close(); }
    if (backupResult.status !== "complete") {
      await fsp.rm(maintenanceFile, { force: true });
      return { status: "blocked", blockers: [{ kind: "backup", detail: `切换前备份状态为 ${backupResult.status}（${backupResult.problems} 个媒体问题）` }] };
    }
  }
  inject("before_marker");
  const epoch = report.storageEpoch;
  const dbFile = `db/${epoch}.sqlite`;
  const target = path.join(dataDir, ...dbFile.split("/"));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsp.copyFile(path.join(staging, DB_FILE), temporary, fs.constants.COPYFILE_EXCL);
    const handle = await fsp.open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temporary, target);
  }
  const check = openDatabase(target, { busyTimeoutMs: 5000 });
  try {
    const integrity = check.pragma("integrity_check").map(r => r.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw fail("storage_recovery", `发布的数据库校验失败：${integrity[0]}`);
  } finally { check.close(); }
  await writeAtomic(path.join(dataDir, STATE_FILE), { version: 1, backend: "sqlite", epoch, dbFile, importRunId: report.runId });
  inject("after_marker");
  await fsp.rm(maintenanceFile, { force: true });
  return { status: "committed", epoch, dbFile, importRunId: report.runId, staging, backup: backupResult && { id: backupResult.id, status: backupResult.status } };
}

/** 切换后不允许直接改回旧 JSON：旧目录不含切换后的新数据。 */
function refuseRollback(dataDir) {
  const marker = readMarker(dataDir);
  if (!marker) return { backend: "json" };
  throw fail("rollback_refused", "已切换到 SQLite：旧 JSON 不含切换后的修改，不能直接回退。需要回退时先导出当前 SQLite 到新的兼容目录并核验。");
}

module.exports = { runCutover, refuseRollback, preflight, STATE_FILE, MAINTENANCE_FILE };
