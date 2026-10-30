"use strict";
/**
 * DB 运行时探针（P3-02）：由被测运行时本身执行（系统 node、standalone 的 node、或 Electron 的
 * ELECTRON_RUN_AS_NODE 服务模式），只通过 Worker 协议（contracts.md C4）访问数据库：
 * health → 建表写入 → 事务回滚 → 关闭后重启读取 → VACUUM INTO 备份并读取备份。
 * 用法：<runtime> scripts/db-runtime-probe.cjs <worker.cjs> <临时数据目录>
 * 输出一行 `DB_PROBE {json}`；任一步失败退出码 1。
 */
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const [workerArg, dataArg] = process.argv.slice(2);
const TIMEOUT_MS = 20_000;

function open(workerPath, file) {
  const worker = new Worker(workerPath, { workerData: { file, busyTimeoutMs: 2000, enableTestRepository: true } });
  const pending = new Map();
  let failure = null;
  const failAll = (error) => {
    failure = failure || error;
    for (const [id, entry] of pending) { pending.delete(id); clearTimeout(entry.timer); entry.reject(failure); }
  };
  worker.on("message", (response) => {
    const entry = pending.get(response.requestId);
    if (!entry) return;
    pending.delete(response.requestId);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
  });
  worker.on("error", (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", (code) => failAll(new Error(`DB Worker 已退出（code ${code}）`)));
  const request = (op, args = {}) => {
    if (failure) return Promise.reject(failure);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${op} 超过 ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      worker.postMessage({ requestId, op, args });
    });
  };
  const close = async () => {
    await request("maintenance", { action: "close" });
    await new Promise((resolve) => { if (worker.threadId === -1) resolve(); else worker.once("exit", resolve); });
  };
  return { request, close, terminate: () => worker.terminate() };
}

async function main() {
  if (!workerArg || !dataArg) throw new Error("用法：db-runtime-probe.cjs <worker.cjs> <数据目录>");
  const workerPath = path.resolve(workerArg);
  if (!fs.existsSync(workerPath)) throw new Error(`缺少 DB Worker：${workerPath}`);
  const dataDir = path.resolve(dataArg);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "probe.sqlite");
  const backup = path.join(dataDir, "probe-backup.sqlite");
  const command = (db, repository, params) => db.request("command", { repository, params });
  const count = (db) => db.request("query", { repository: "test.count", params: { table: "t_parent" } });
  const steps = {};

  let db = open(workerPath, file);
  let health;
  try {
    health = await db.request("health");
    if (!health.ok) throw new Error(`health.ok=false：${JSON.stringify({ sqlite: health.sqliteVersion, pragmas: health.pragmas })}`);
    await command(db, "test.createSchema", {});
    await command(db, "test.insert", { table: "t_parent", id: "p1" });
    steps.schema = true;
    steps.write = await count(db);
    let rejected = false;
    try { await command(db, "test.insertThenFail", { id: "p2" }); } catch { rejected = true; }
    steps.rollback = { rejected, count: await count(db) };
    await db.close();
  } catch (error) {
    await db.terminate();
    throw error;
  }

  db = open(workerPath, file);
  try {
    steps.restartRead = await count(db);
    await db.request("maintenance", { action: "test.backup", params: { target: backup } });
    await db.close();
  } catch (error) {
    await db.terminate();
    throw error;
  }

  db = open(workerPath, backup);
  try {
    const backupHealth = await db.request("health");
    steps.backup = { count: await count(db), sqliteVersion: backupHealth.sqliteVersion };
    await db.close();
  } catch (error) {
    await db.terminate();
    throw error;
  }

  const ok = health.ok && steps.write === 1 && steps.rollback.rejected && steps.rollback.count === 1 && steps.restartRead === 1 && steps.backup.count === 1;
  return { ok, workerPath, health, steps };
}

main().then(
  (report) => {
    process.stdout.write(`DB_PROBE ${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  },
  (error) => {
    process.stdout.write(`DB_PROBE ${JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error), runtime: { execPath: process.execPath, modules: process.versions.modules, electron: process.versions.electron || null } })}\n`);
    process.exitCode = 1;
  },
);
