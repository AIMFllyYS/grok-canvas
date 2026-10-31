import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 真实临时 SQLite 与临时媒体目录：不碰用户主库或 ~/.grok-canvas。
const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-backup-"));
process.env.GROK_CANVAS_DATA_DIR = path.join(root, "assets-module-data");
const { openDatabase } = require("../lib/db/driver.cjs");
const { migrate } = require("../lib/db/migrate.cjs");
const canvasRepo = require("../lib/db/repositories/canvas.cjs");
const assetsRepo = require("../lib/db/repositories/assets.cjs");
const tasksRepo = require("../lib/db/repositories/tasks.cjs");
const { createBackup, listBackups, sha256File } = require("../lib/db/backup.cjs");
const { verifyBackup, restoreBackup } = require("../lib/db/restore.cjs");
const publication = await loadTypescript("lib/media/asset-publication.ts");
const assetsModule = await loadTypescript("lib/assets.ts");
const opened = [];
after(async () => {
  for (const db of opened) if (db.open) db.close();
  await publication.dispose(); await assetsModule.dispose();
  await rm(root, { recursive: true, force: true });
});
const { publishFile, publishAndRegister, orphanReport, AssetPublicationError } = publication.module;

let cases = 0;
async function workspace({ media = ["a.png", "b.mp4"] } = {}) {
  const base = path.join(root, `case-${++cases}`);
  const dataDir = path.join(base, "data");
  await mkdir(path.join(dataDir, "assets"), { recursive: true });
  const db = openDatabase(path.join(dataDir, "grok-canvas.sqlite"), { busyTimeoutMs: 2000 });
  opened.push(db);
  migrate(db);
  canvasRepo.putCanvas(db, { canvas: { id: "c1", name: "画布", revision: 0, nameVersion: 0, storageEpoch: "sql-v1", createdAt: "2026-10-30T00:00:00.000Z" }, nodes: [], documents: [], edges: [], fieldVersions: {} });
  for (const name of media) {
    const bytes = Buffer.from(`媒体 ${name} `.repeat(200));
    await writeFile(path.join(dataDir, "assets", name), bytes);
    const sha256 = (await sha256File(path.join(dataDir, "assets", name))).sha256;
    assetsRepo.putAsset(db, { assetName: name, relativePath: `assets/${name}`, kind: name.endsWith(".mp4") ? "video" : "image", bytes: bytes.length, sha256, status: "ready" });
    assetsRepo.linkCanvasAsset(db, { canvasId: "c1", assetName: name, createdAt: "2026-10-30T00:00:00.000Z" });
  }
  return { base, dataDir, db, backupRoot: path.join(base, "backups") };
}
const readonlyDb = (file) => { const Database = require("better-sqlite3"); const db = new Database(file, { readonly: true }); opened.push(db); return db; };
/** 一个写事务：画布 revision=k，同时插入节点 k 和指向上一节点的边——任何半事务都会让 nodes/edges/revision 对不上。 */
const writeStep = (db, k) => db.transaction(() => {
  db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, data_json) values ('c1', ?, 'image', 1, ?, 0, 100, 100, '{}')").run(`n${k}`, k);
  if (k > 1) db.prepare("insert into edges (canvas_id, id, source, target) values ('c1', ?, ?, ?)").run(`e${k}`, `n${k - 1}`, `n${k}`);
  db.prepare("update canvases set revision = ? where id = 'c1'").run(k);
})();

test("备份期间持续写入：还原内容是某个已提交状态，revision 与节点/边数量一致，无半节点半关系", async () => {
  const ws = await workspace();
  for (let k = 1; k <= 400; k++) writeStep(ws.db, k);
  let k = 400, writing = true;
  const writer = (async () => { while (writing) { writeStep(ws.db, ++k); await new Promise(resolve => setImmediate(resolve)); } })();
  const progress = [];
  const result = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot, onProgress: (p) => progress.push(p.phase) });
  writing = false;
  await writer;
  assert.equal(result.status, "complete");
  assert.ok(k > 400, "备份进行时写入未被阻塞");
  assert.ok(progress.includes("database") && progress.includes("media"), "维护任务报告进度");
  const target = path.join(ws.base, "restored");
  const restored = await restoreBackup({ backupDir: result.dir, targetDir: target, activeDataDir: ws.dataDir });
  const snap = readonlyDb(restored.dbFile);
  const revision = snap.prepare("select revision from canvases where id = 'c1'").get().revision;
  assert.equal(snap.prepare("select count(*) as n from nodes").get().n, revision);
  assert.equal(snap.prepare("select count(*) as n from edges").get().n, revision - 1);
  assert.deepEqual(snap.pragma("foreign_key_check"), []);
  const manifest = JSON.parse(await readFile(path.join(result.dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.canvases, [{ id: "c1", revision }], "manifest 记录每个画布的快照 revision");
  assert.equal(manifest.version, 1);
  assert.deepEqual((await readdir(path.join(target, "assets"))).sort(), ["a.png", "b.mp4"]);
  assert.equal(ws.db.prepare("select status from backup_manifests where id = ?").get(result.id).status, "complete");
});

test("媒体清单只来自快照；备份中缺媒体不误报完整成功，也不能用于还原", async () => {
  const ws = await workspace();
  await rm(path.join(ws.dataDir, "assets", "b.mp4"));
  const result = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot });
  assert.equal(result.status, "incomplete");
  const manifest = JSON.parse(await readFile(path.join(result.dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.media.map(m => [m.assetName, m.state]), [["a.png", "ok"], ["b.mp4", "missing"]]);
  assert.equal((await verifyBackup(result.dir)).ok, false);
  await assert.rejects(restoreBackup({ backupDir: result.dir, targetDir: path.join(ws.base, "r"), activeDataDir: ws.dataDir }), { code: "backup_invalid" });
  assert.equal(ws.db.prepare("select status from backup_manifests where id = ?").get(result.id).status, "failed");
  const listed = await listBackups(ws.backupRoot);
  assert.deepEqual([listed.valid.length, listed.invalid.map(i => i.reason)], [0, ["status=incomplete"]]);
  // 已登记为 missing 的素材是显式缺失，不伪造存在，也不让备份失败。
  assetsRepo.putAsset(ws.db, { assetName: "b.mp4", relativePath: "assets/b.mp4", kind: "video", status: "missing" });
  const again = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot });
  assert.equal(again.status, "complete");
  const second = JSON.parse(await readFile(path.join(again.dir, "manifest.json"), "utf8"));
  assert.deepEqual(second.media.map(m => [m.assetName, m.state]), [["a.png", "ok"], ["b.mp4", "missing_known"]]);
});

test("源媒体与登记 hash 不符、备份后篡改媒体或 DB、篡改 manifest：均阻止还原", async () => {
  const ws = await workspace();
  await writeFile(path.join(ws.dataDir, "assets", "a.png"), "被替换");
  const corrupt = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot });
  assert.equal(corrupt.status, "incomplete");
  assert.match((await verifyBackup(corrupt.dir)).problems.join("\n"), /a\.png 状态 hash_mismatch/);

  const fresh = await workspace();
  const good = await createBackup(fresh.db, { dataDir: fresh.dataDir, backupRoot: fresh.backupRoot });
  assert.equal((await verifyBackup(good.dir)).ok, true);
  await writeFile(path.join(good.dir, "media", "b.mp4"), "篡改", { flag: "a" });
  assert.match((await verifyBackup(good.dir)).problems.join("\n"), /b\.mp4 sha256 不一致/);

  const other = await workspace();
  const db = await createBackup(other.db, { dataDir: other.dataDir, backupRoot: other.backupRoot });
  await writeFile(path.join(db.dir, "db.sqlite"), "x", { flag: "a" });
  assert.match((await verifyBackup(db.dir)).problems.join("\n"), /db\.sqlite sha256/);

  const third = await workspace();
  const m = await createBackup(third.db, { dataDir: third.dataDir, backupRoot: third.backupRoot });
  const manifestFile = path.join(m.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.media[0].sha256 = "0".repeat(64);
  await writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal((await verifyBackup(m.dir)).ok, false);
  await assert.rejects(restoreBackup({ backupDir: m.dir, targetDir: path.join(third.base, "r"), activeDataDir: third.dataDir }), { code: "backup_invalid" });
  assert.equal(existsSync(path.join(third.base, "r")), false, "失败还原不留下目标目录");
});

test("未来 schema / 迁移 checksum 不符的备份拒绝还原；integrity 与外键检查参与验证", async () => {
  const ws = await workspace();
  const result = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot });
  // 用只含 001 的迁移目录模拟“旧程序读取新备份”：002 对它是未来版本。
  const oldDir = path.join(ws.base, "old-migrations");
  await mkdir(oldDir);
  await writeFile(path.join(oldDir, "001-core.sql"), await readFile(new URL("../lib/db/migrations/001-core.sql", import.meta.url)));
  const future = await verifyBackup(result.dir, { migrationsDir: oldDir });
  assert.match(future.problems.join("\n"), /schema_future/);
  await assert.rejects(restoreBackup({ backupDir: result.dir, targetDir: path.join(ws.base, "r1"), activeDataDir: ws.dataDir, migrationsDir: oldDir }), { code: "backup_invalid" });
  const changedDir = path.join(ws.base, "changed-migrations");
  await mkdir(changedDir);
  for (const name of ["001-core.sql", "002-runtime.sql"]) await writeFile(path.join(changedDir, name), await readFile(new URL(`../lib/db/migrations/${name}`, import.meta.url)));
  await writeFile(path.join(changedDir, "001-core.sql"), "\n-- 改动\n", { flag: "a" });
  assert.match((await verifyBackup(result.dir, { migrationsDir: changedDir })).problems.join("\n"), /schema_checksum/);
  assert.equal((await verifyBackup(result.dir)).ok, true, "当前程序可还原");
});

test("中断的备份（无 complete manifest）不被列为有效备份；还原只能到新空目录，失败时活动库可读", async () => {
  const ws = await workspace();
  const done = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot, id: "good-1" });
  // 模拟崩溃：媒体复制阶段抛错，manifest 从未写出。
  await assert.rejects(createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot, id: "crashed-1", onProgress: (p) => { if (p.phase === "media") throw new Error("模拟中断"); } }), /模拟中断/);
  assert.equal(ws.db.prepare("select status from backup_manifests where id = 'crashed-1'").get().status, "failed");
  const listed = await listBackups(ws.backupRoot);
  assert.deepEqual(listed.valid.map(b => b.id), ["good-1"]);
  assert.deepEqual(listed.invalid.map(b => [b.id, b.reason]), [["crashed-1", "manifest 缺失（备份未完成）"]]);
  assert.equal((await verifyBackup(path.join(ws.backupRoot, "crashed-1"))).ok, false);

  for (const targetDir of [ws.dataDir, path.join(ws.dataDir, "nested"), path.dirname(ws.dataDir)]) {
    await assert.rejects(restoreBackup({ backupDir: done.dir, targetDir, activeDataDir: ws.dataDir }), { code: "invalid_request" }, targetDir);
  }
  const occupied = path.join(ws.base, "occupied");
  await mkdir(occupied); await writeFile(path.join(occupied, "keep.txt"), "用户文件");
  await assert.rejects(restoreBackup({ backupDir: done.dir, targetDir: occupied, activeDataDir: ws.dataDir }), { code: "invalid_request" });
  assert.equal(await readFile(path.join(occupied, "keep.txt"), "utf8"), "用户文件");
  assert.equal(ws.db.prepare("select count(*) as n from assets").get().n, 2, "还原失败后活动库仍可读");
  const restored = await restoreBackup({ backupDir: done.dir, targetDir: path.join(ws.base, "fresh"), activeDataDir: ws.dataDir });
  assert.equal(restored.media, 2);
  assert.ok((await readdir(ws.base)).every(name => !name.includes(".staging-")), "staging 目录已清理");
});

test("旧生成记录在备份与还原后仍满足不可变与真实快照语义", async () => {
  const ws = await workspace();
  const snapshot = { prompt: "猫", model: "grok-imagine", aspectRatio: "1:1", nested: { b: 2, a: 1 } };
  tasksRepo.putGenerationRecord(ws.db, { assetName: "a.png", schemaVersion: 1, snapshot, savedAt: "2026-10-30T00:00:00.000Z" });
  const result = await createBackup(ws.db, { dataDir: ws.dataDir, backupRoot: ws.backupRoot });
  const restored = await restoreBackup({ backupDir: result.dir, targetDir: path.join(ws.base, "r"), activeDataDir: ws.dataDir });
  const db = openDatabase(restored.dbFile, { busyTimeoutMs: 2000 });
  opened.push(db);
  assert.deepEqual(tasksRepo.getGenerationRecord(db, { assetName: "a.png" }).snapshot, snapshot);
  assert.deepEqual(tasksRepo.putGenerationRecord(db, { assetName: "a.png", schemaVersion: 1, snapshot: { nested: { a: 1, b: 2 }, aspectRatio: "1:1", model: "grok-imagine", prompt: "猫" }, savedAt: "2026-10-31T00:00:00.000Z" }), { status: "unchanged" });
  assert.throws(() => tasksRepo.putGenerationRecord(db, { assetName: "a.png", schemaVersion: 1, snapshot: { ...snapshot, prompt: "狗" }, savedAt: "2026-10-31T00:00:00.000Z" }), { code: "generation_record_conflict" });
});

test("文件发布：临时写+flush+校验+无覆盖原子发布；登记失败文件保留进入恢复报告；孤儿只标记不删除", async () => {
  const dir = path.join(root, "publish");
  await mkdir(dir, { recursive: true });
  const bytes = new Uint8Array(Buffer.from("视频内容".repeat(1000)));
  const file = await publishFile(path.join(dir, "v1.mp4"), bytes);
  assert.equal(file.bytes, bytes.byteLength);
  assert.equal(file.sha256, (await sha256File(path.join(dir, "v1.mp4"))).sha256);
  await assert.rejects(publishFile(path.join(dir, "v1.mp4"), new Uint8Array([1])), { code: "EEXIST" }, "不覆盖已有文件");
  assert.equal((await stat(path.join(dir, "v1.mp4"))).size, bytes.byteLength);
  await assert.rejects(publishAndRegister(path.join(dir, "v2.mp4"), bytes, () => { throw new Error("DB 回滚"); }), (error) => {
    assert.ok(error instanceof AssetPublicationError);
    assert.equal(error.published.path, path.join(dir, "v2.mp4"));
    return true;
  });
  assert.ok(existsSync(path.join(dir, "v2.mp4")), "DB 回滚不会删除已发布文件");
  const registered = await publishAndRegister(path.join(dir, "v3.mp4"), bytes, (f) => ({ ok: true, sha256: f.sha256 }));
  assert.equal(registered.registered.ok, true);
  await writeFile(path.join(dir, ".publish-crashed-v4.mp4"), "半截");
  await writeFile(path.join(dir, "backup-ref.png"), "被备份引用");
  await writeFile(path.join(dir, "task-ref.mp4"), "未知任务引用");
  const report = await orphanReport(dir, new Set(["v1.mp4", "v3.mp4"]), new Set(["backup-ref.png", "task-ref.mp4"]));
  assert.deepEqual(report, { orphans: ["v2.mp4"], temporary: [".publish-crashed-v4.mp4"], protected: ["backup-ref.png", "task-ref.mp4"] });
  assert.deepEqual((await readdir(dir)).sort(), [".publish-crashed-v4.mp4", "backup-ref.png", "task-ref.mp4", "v1.mp4", "v2.mp4", "v3.mp4"], "报告不删除任何文件");
  assert.deepEqual(await orphanReport(path.join(dir, "absent"), new Set()), { orphans: [], temporary: [], protected: [] });
});

test("生成素材保存经由受控发布接点；Worker backup op 与打包登记已接线", async () => {
  const saved = await assetsModule.module.saveBufferAsset(new Uint8Array([1, 2, 3]), "image/png");
  assert.deepEqual([...await readFile(path.join(process.env.GROK_CANVAS_DATA_DIR, "assets", saved.name))], [1, 2, 3]);
  assert.ok((await readdir(path.join(process.env.GROK_CANVAS_DATA_DIR, "assets"))).every(name => !name.startsWith(".publish-")), "发布后无临时文件残留");
  const assetsSource = await readFile(new URL("../lib/assets.ts", import.meta.url), "utf8");
  assert.match(assetsSource, /publishFile\(assetPath\(name\), buffer\)/);
  const worker = await readFile(new URL("../lib/db/worker.cjs", import.meta.url), "utf8");
  assert.match(worker, /op === "backup"\) return backup\.createBackup/);
  const staging = await readFile(new URL("../scripts/db-runtime.mjs", import.meta.url), "utf8");
  assert.match(staging, /"backup\.cjs", "restore\.cjs"/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:db"], /db-backup\.test\.mjs/);
});

test("Worker 协议：backup op 异步执行，期间其他请求照常返回", async () => {
  const ws = await workspace();
  ws.db.close();
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("../lib/db/worker.cjs", import.meta.url), { workerData: { file: path.join(ws.dataDir, "grok-canvas.sqlite"), busyTimeoutMs: 2000 } });
  const pending = new Map();
  let id = 0;
  worker.on("message", (m) => { const p = pending.get(m.requestId); pending.delete(m.requestId); m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); });
  const request = (op, args) => new Promise((resolve, reject) => { const requestId = String(++id); pending.set(requestId, { resolve, reject }); worker.postMessage({ requestId, op, args }); });
  try {
    const order = [];
    const backup = request("backup", { params: { dataDir: ws.dataDir, backupRoot: ws.backupRoot, id: "via-worker" } }).then(r => { order.push("backup"); return r; });
    const health = request("health").then(r => { order.push("health"); return r; });
    const [result] = await Promise.all([backup, health]);
    assert.equal(result.status, "complete");
    assert.equal(order[0], "health", "备份未阻塞后续请求");
    await assert.rejects(request("backup", { params: { dataDir: "relative", backupRoot: ws.backupRoot } }), { code: "invalid_request" });
    assert.equal((await verifyBackup(path.join(ws.backupRoot, "via-worker"))).ok, true);
  } finally {
    await worker.terminate();
  }
});
