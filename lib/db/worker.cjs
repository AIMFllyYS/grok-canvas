"use strict";
/**
 * 单例 DB Worker 入口（contracts.md C4），worker_threads 中运行，可直接随包加载。
 * 只接受固定 op；query/command 映射到固定 repository 名称，不执行调用方提供的 SQL。
 * 所有写事务同步完成（better-sqlite3 transaction），不允许 async 回调。
 */
const { parentPort, workerData, threadId } = require("node:worker_threads");
const driver = require("./driver.cjs");

const OPS = new Set(["health", "query", "command", "migrate", "backup", "maintenance"]);
const file = workerData.file;
const busyTimeoutMs = workerData.busyTimeoutMs;
let db = driver.openDatabase(file, { busyTimeoutMs });

/** 业务 repository 由 P3-03 起登记；测试 repository 只有显式开启时可用。 */
const queries = Object.create(null);
const commands = Object.create(null);
const maintenance = Object.create(null);

if (workerData.enableTestRepository === true) {
  const TABLES = new Set(["t_parent", "t_child"]);
  const table = (name) => { if (!TABLES.has(name)) throw Object.assign(new Error(`测试表 ${name} 不存在`), { code: "invalid_request" }); return name; };
  commands["test.createSchema"] = () => {
    db.exec("create table if not exists t_parent (id text primary key) strict; create table if not exists t_child (id text primary key, parent text not null references t_parent(id)) strict;");
    return { ok: true };
  };
  commands["test.insert"] = ({ table: name, id, parent }) => {
    if (table(name) === "t_parent") db.prepare("insert into t_parent (id) values (?)").run(String(id));
    else db.prepare("insert into t_child (id, parent) values (?, ?)").run(String(id), String(parent));
    return { ok: true };
  };
  /** 事务中先插入再抛错：验证整体回滚。 */
  commands["test.insertThenFail"] = ({ id }) => {
    db.transaction(() => {
      db.prepare("insert into t_parent (id) values (?)").run(String(id));
      throw Object.assign(new Error("模拟事务中途失败"), { code: "invalid_request" });
    })();
  };
  queries["test.count"] = ({ table: name }) => db.prepare(`select count(*) as n from ${table(name)}`).get().n;
  /** 同步占用 worker，用于验证超时与队列上限；主线程不受阻塞。 */
  queries["test.block"] = ({ ms }) => { const end = Date.now() + Math.min(Number(ms) || 0, 10_000); while (Date.now() < end) { /* busy */ } return { threadId }; };
  maintenance["test.crash"] = () => { process.exit(3); };
  /** 打包 smoke 用的同步备份能力验证；正式 backup op 归 P3-07。目标只能在数据库同目录。 */
  maintenance["test.backup"] = ({ target }) => {
    const path = require("node:path");
    const resolved = path.resolve(String(target || ""));
    if (path.dirname(resolved) !== path.dirname(path.resolve(file)) || !resolved.endsWith(".sqlite") || resolved === path.resolve(file)) {
      throw Object.assign(new Error("备份目标必须是数据库同目录下的另一个 .sqlite 文件"), { code: "invalid_request" });
    }
    db.prepare("vacuum into ?").run(resolved);
    return { target: resolved };
  };
}

maintenance.checkpoint = () => db.pragma("wal_checkpoint(TRUNCATE)")[0];

// P3-03：固定的业务 repository（名称 → 函数），参数只是数据，不接收 SQL。
const { migrate } = require("./migrate.cjs");
const canvasRepo = require("./repositories/canvas.cjs");
const assetsRepo = require("./repositories/assets.cjs");
for (const name of ["listCanvases", "listGeometry", "listNodeSummaries", "getNodes", "getDocumentChunk", "listEdges", "edgesOf", "getTombstone"]) {
  queries[`canvas.${name}`] = (params) => canvasRepo[name](db, params);
}
queries["assets.listCanvasAssets"] = (params) => assetsRepo.listCanvasAssets(db, params);
queries["assets.canvasHasAsset"] = (params) => assetsRepo.canvasHasAsset(db, params);
commands["canvas.put"] = (params) => canvasRepo.putCanvas(db, params);
commands["canvas.tombstoneNode"] = (params) => canvasRepo.tombstoneNode(db, params);
commands["assets.put"] = (params) => assetsRepo.putAsset(db, params);
commands["assets.link"] = (params) => assetsRepo.linkCanvasAsset(db, params);
maintenance.close = () => {
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)")[0];
  db.close();
  db = null;
  return { closed: true, checkpoint };
};

function errorCode(error) {
  if (error && typeof error.code === "string") {
    if (error.code.startsWith("SQLITE_CONSTRAINT")) return "constraint";
    if (error.code.startsWith("SQLITE_")) return "storage_unavailable";
    if (["invalid_request", "unknown_repository", "unknown_op", "not_found"].includes(error.code)) return error.code;
    if (error.code === "schema_checksum" || error.code === "schema_future" || error.code === "schema_invalid") return "storage_unavailable";
  }
  return "invalid_request";
}

function dispatch(op, args) {
  if (!db) throw Object.assign(new Error("数据库已关闭"), { code: "invalid_request" });
  if (op === "health") return { ...driver.readHealth(db, file, { busyTimeoutMs }), workerThreadId: threadId };
  if (op === "migrate") return migrate(db);
  const registry = op === "query" ? queries : op === "command" ? commands : op === "maintenance" ? maintenance : null;
  if (!registry) throw Object.assign(new Error(`${op} 尚未实现`), { code: "unknown_op" });
  const name = args && typeof args.repository === "string" ? args.repository : args && typeof args.action === "string" ? args.action : "";
  const handler = registry[name];
  if (typeof handler !== "function") throw Object.assign(new Error(`未登记的 ${op}：${name}`), { code: "unknown_repository" });
  return handler((args && args.params) || {});
}

parentPort.on("message", (request) => {
  const requestId = request && request.requestId;
  if (typeof requestId !== "string" || !OPS.has(request.op)) {
    parentPort.postMessage({ requestId: String(requestId), ok: false, error: { code: "unknown_op", message: "不支持的 DB 操作" } });
    return;
  }
  try {
    const result = dispatch(request.op, request.args);
    parentPort.postMessage({ requestId, ok: true, result: result === undefined ? null : result });
    if (request.op === "maintenance" && request.args && request.args.action === "close") parentPort.close();
  } catch (error) {
    parentPort.postMessage({ requestId, ok: false, error: { code: errorCode(error), message: error && error.message ? error.message : String(error) } });
  }
});
