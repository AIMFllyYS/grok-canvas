import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const workerPath = path.join(root, "lib", "db", "worker.cjs");
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-db-"));
const first = await loadTypescript("lib/db/service.ts");
const second = await loadTypescript("lib/db/service.ts");
after(async () => {
  await first.module.closeAllDbServices?.();
  await first.dispose(); await second.dispose();
  await rm(dir, { recursive: true, force: true });
});
const { getDbService, DbError } = first.module;
let files = 0;
const open = (extra = {}) => getDbService({ file: path.join(dir, `t${++files}.sqlite`), workerPath, enableTestRepository: true, ...extra });
const command = (db, repository, params) => db.request("command", { repository, params });
const query = (db, repository, params) => db.request("query", { repository, params });
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, `${error.code}: ${error.message}`); return true; });

test("健康检查：真实 better-sqlite3、SQLite ≥3.51.3、PRAGMA 实际为 WAL/FULL/foreign_keys=1，运行在独立 worker 线程", async () => {
  const db = open();
  const health = await db.health();
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.equal(health.driver, "better-sqlite3");
  assert.equal(health.driverVersion, "13.0.3");
  assert.ok(health.sqliteVersionOk, health.sqliteVersion);
  assert.deepEqual(health.pragmas, { journal_mode: "wal", synchronous: 2, foreign_keys: 1, busy_timeout: 2000 });
  assert.notEqual(health.workerThreadId, threadId, "查询不在主线程执行");
  assert.ok(health.runtime.modules && health.runtime.node === process.version);
  assert.ok(health.nativeBinding?.endsWith(".node"), "记录实际 native 路径");
  console.log(`DB_HEALTH ${JSON.stringify({ driver: health.driverVersion, sqlite: health.sqliteVersion, node: health.runtime.node, modules: health.runtime.modules, napi: health.runtime.napi, platform: health.runtime.platform, arch: health.runtime.arch, native: path.basename(health.nativeBinding) })}`);
  await db.close();
});

test("建表、事务中途失败无残留、外键违例抛错、关闭重开数据仍在", async () => {
  const file = path.join(dir, "persist.sqlite");
  const db = getDbService({ file, workerPath, enableTestRepository: true });
  await command(db, "test.createSchema");
  await command(db, "test.insert", { table: "t_parent", id: "p1" });
  await rejectsCode(command(db, "test.insertThenFail", { id: "p2" }), "invalid_request");
  assert.equal(await query(db, "test.count", { table: "t_parent" }), 1, "回滚后没有 p2");
  await rejectsCode(command(db, "test.insert", { table: "t_child", id: "c1", parent: "ghost" }), "constraint");
  assert.equal(await query(db, "test.count", { table: "t_child" }), 0);
  await db.close();
  assert.equal(db.state(), "closed");
  const reopened = getDbService({ file, workerPath, enableTestRepository: true });
  assert.notEqual(reopened, db, "关闭后重新打开得到新实例");
  assert.equal(await query(reopened, "test.count", { table: "t_parent" }), 1);
  await reopened.close();
});

test("固定 op 白名单：未知 op 与未登记 repository 被拒，不接受任意 SQL；测试 repository 默认关闭", async () => {
  const db = open();
  await rejectsCode(db.request("exec", { sql: "drop table x" }), "unknown_op");
  await rejectsCode(query(db, "select * from sqlite_master"), "unknown_repository");
  await db.close();
  const plain = open({ enableTestRepository: false });
  await rejectsCode(command(plain, "test.createSchema"), "unknown_repository");
  await plain.close();
});

test("两个路由模块实例同时调用只启动一个 Worker", async () => {
  const file = path.join(dir, "shared.sqlite");
  const a = first.module.getDbService({ file, workerPath, enableTestRepository: true });
  const b = second.module.getDbService({ file, workerPath, enableTestRepository: true });
  assert.equal(a, b);
  const [h1, h2] = await Promise.all([a.health(), b.health()]);
  assert.equal(h1.workerThreadId, h2.workerThreadId);
  assert.equal(first.module.activeDbServiceCount(), second.module.activeDbServiceCount());
  await a.close();
});

test("容量：超过队列条数返回 queue_full，单请求超过 4MiB 被拒，超时请求被清理", async () => {
  const db = open({ limits: { queueItems: 3, interactiveTimeoutMs: 1500 } });
  await command(db, "test.createSchema");
  const blocking = query(db, "test.block", { ms: 3000 });
  const queued = [query(db, "test.count", { table: "t_parent" }), query(db, "test.count", { table: "t_parent" })];
  await rejectsCode(query(db, "test.count", { table: "t_parent" }), "queue_full");
  await rejectsCode(blocking, "timeout");
  await Promise.allSettled(queued);
  await rejectsCode(command(db, "test.insert", { table: "t_parent", id: "x".repeat(4 * 1024 * 1024 + 10) }), "request_too_large");
  assert.equal(db.pendingCount(), 0, "超时与拒绝后不残留回调");
  await db.close();
});

test("Worker 退出：在途请求立即 reject，进入 crashed；显式 restart 后恢复且数据仍在", async () => {
  const db = open();
  await command(db, "test.createSchema");
  await command(db, "test.insert", { table: "t_parent", id: "before" });
  const started = Date.now();
  const crash = db.request("maintenance", { action: "test.crash" });
  const behind = query(db, "test.count", { table: "t_parent" });
  await rejectsCode(crash, "worker_exited");
  await rejectsCode(behind, "worker_exited");
  assert.ok(Date.now() - started < 2000, "不等到超时才拒绝");
  assert.equal(db.state(), "crashed");
  await rejectsCode(db.health(), "worker_exited");
  await db.restart();
  assert.equal(db.state(), "ready");
  assert.equal(await query(db, "test.count", { table: "t_parent" }), 1);
  await db.close();
});

test("关闭后拒绝新请求并释放单例", async () => {
  const db = open();
  await db.health();
  const before = first.module.activeDbServiceCount();
  await db.close();
  assert.equal(first.module.activeDbServiceCount(), before - 1);
  await rejectsCode(db.health(), "closed");
  assert.ok(DbError);
});

test("DB 测试已登记进 pnpm test，依赖锁定为精确版本", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:db"], /tests\/db-worker\.test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:db/);
  assert.equal(pkg.dependencies["better-sqlite3"], "13.0.3");
});
