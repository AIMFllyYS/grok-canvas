import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const Database = require("better-sqlite3");
const { openDatabase } = require("../lib/db/driver.cjs");
const { migrate, loadMigrations } = require("../lib/db/migrate.cjs");
const canvasRepo = require("../lib/db/repositories/canvas.cjs");
const assetsRepo = require("../lib/db/repositories/assets.cjs");
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-db-core-"));
after(() => rm(dir, { recursive: true, force: true }));
let files = 0;
const fresh = () => { const db = openDatabase(path.join(dir, `core-${++files}.sqlite`), { busyTimeoutMs: 2000 }); migrate(db); return db; };
const traced = () => { const log = []; return { log, ctx: { trace: (sql, columns) => log.push({ sql, columns }) } }; };
const node = (canvasId, id, extra = {}) => ({ id, canvasId, type: "canvasText", schemaVersion: 1, geometry: { x: 0, y: 0, width: 360, height: 260 }, entityVersion: 0, geometryVersion: 0, documentId: `d-${id}`, data: { name: id }, ...extra });
const canvas = (id, extra = {}) => ({ id, name: `画布 ${id}`, revision: 0, nameVersion: 0, storageEpoch: "sql-v1", createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", ...extra });
const seed = (db, canvasId, nodes, edges = [], content = id => `正文 ${id}`) => canvasRepo.putCanvas(db, {
  canvas: canvas(canvasId),
  nodes,
  documents: nodes.filter(n => n.documentId).map(n => ({ id: n.documentId, nodeId: n.id, content: content(n.id), version: 0 })),
  edges,
  fieldVersions: {},
});
const code = (fn, expected) => assert.throws(fn, (error) => { assert.equal(error.code, expected, `${error.code}: ${error.message}`); return true; });

test("迁移：版本+checksum 记录；重复迁移无副作用；默认项目存在", () => {
  const db = fresh();
  const rows = db.prepare("select version, checksum from schema_migrations order by version").all();
  const files = loadMigrations();
  assert.deepEqual(rows.map(r => r.version), files.map(f => f.version));
  assert.equal(rows[0].checksum, files[0].checksum);
  assert.deepEqual(migrate(db).applied, [], "重复迁移不再执行");
  assert.equal(db.prepare("select count(*) as n from projects where id = 'default-project'").get().n, 1);
  db.close();
});

test("迁移：已应用文件内容变化拒绝；库里有未来版本拒绝；事务失败不留半张表也不留记录", async () => {
  const migrations = path.join(dir, "migrations-copy");
  await cp(path.join(root, "lib", "db", "migrations"), migrations, { recursive: true });
  const db = openDatabase(path.join(dir, "checksum.sqlite"), { busyTimeoutMs: 2000 });
  migrate(db, { dir: migrations });
  const first = (await readFile(path.join(migrations, "001-core.sql"), "utf8"));
  await writeFile(path.join(migrations, "001-core.sql"), `${first}\n-- 原地修改\n`);
  code(() => migrate(db, { dir: migrations }), "schema_checksum");
  await writeFile(path.join(migrations, "001-core.sql"), first);
  db.prepare("insert into schema_migrations (version, name, checksum, applied_at) values (999, '999-future.sql', 'x', 'now')").run();
  code(() => migrate(db, { dir: migrations }), "schema_future");
  db.prepare("delete from schema_migrations where version = 999").run();
  await writeFile(path.join(migrations, "900-broken.sql"), "create table half_done (id text primary key) strict;\ncreate table broken (id text primary key, nope NOT_A_TYPE) strict;\n");
  assert.throws(() => migrate(db, { dir: migrations }));
  assert.equal(db.prepare("select count(*) as n from sqlite_master where name = 'half_done'").get().n, 0, "失败迁移整体回滚");
  assert.equal(db.prepare("select count(*) as n from schema_migrations where version = 900").get().n, 0, "不留迁移记录");
  db.close();
});

test("约束：两个画布可有相同 nodeId；连线不能跨画布；同画布 ID 唯一；尺寸与 data_json 受 CHECK 约束", () => {
  const db = fresh();
  seed(db, "A", [node("A", "n1"), node("A", "n2")]);
  seed(db, "B", [node("B", "n1")]);
  assert.equal(db.prepare("select count(*) as n from nodes where id = 'n1'").get().n, 2, "legacy nodeId 跨画布可重复");
  code(() => db.prepare("insert into edges (canvas_id, id, source, target, role, version) values ('B', 'x', 'n1', 'n2', null, 0)").run(), "SQLITE_CONSTRAINT_FOREIGNKEY");
  code(() => db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, data_json) values ('A', 'n1', 'image', 1, 0, 0, 10, 10, '{}')").run(), "SQLITE_CONSTRAINT_PRIMARYKEY");
  code(() => db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, data_json) values ('A', 'bad', 'image', 1, 0, 0, 0, 10, '{}')").run(), "SQLITE_CONSTRAINT_CHECK");
  code(() => db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, data_json) values ('A', 'bad', 'image', 1, 0, 0, 10, 10, '{not json')").run(), "SQLITE_CONSTRAINT_CHECK");
  code(() => db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, data_json) values ('A', 'bad', 'unknown', 1, 0, 0, 10, 10, '{}')").run(), "SQLITE_CONSTRAINT_CHECK");
  db.close();
});

test("正文与几何分离：10000 节点 × 100KB 正文，几何查询不选正文，计划命中画布/端点索引", () => {
  const db = fresh();
  const nodes = Array.from({ length: 10_000 }, (_, i) => node("big", `n${i}`, { geometry: { x: i, y: 0, width: 360, height: 260 } }));
  const big = "长".repeat(100_000 / 3);
  seed(db, "big", nodes, [{ id: "e1", canvasId: "big", source: "n1", target: "n2", role: null, version: 0 }], () => big);
  const { log, ctx } = traced();
  const page = canvasRepo.listGeometry(db, { canvasId: "big", limit: 50 }, ctx);
  assert.equal(page.items.length, 50);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["geometry", "geometryVersion", "id", "type"]);
  assert.ok(log.length === 1 && !/content|data_json/.test(log[0].sql), log.map(l => l.sql).join("\n"));
  const summaries = canvasRepo.listNodeSummaries(db, { canvasId: "big", limit: 50 }, ctx);
  assert.equal(summaries.items.length, 50);
  assert.ok(!log.some(l => /\bcontent\b/.test(l.sql)), "摘要列表不读正文");
  const plan = (sql, ...args) => db.prepare(`explain query plan ${sql}`).all(...args).map(r => r.detail).join(" | ");
  assert.match(plan(canvasRepo.SQL.listGeometry, "big", "", 51), /USING (INDEX|PRIMARY KEY|COVERING INDEX)/);
  assert.match(plan(canvasRepo.SQL.edgesFrom, "big", "n1"), /edges_source/);
  assert.match(plan(canvasRepo.SQL.edgesTo, "big", "n2"), /edges_target/);
  db.close();
});

test("分页：稳定不重复；limit 上限 50 超出返回 invalid_request(400)；每页 JSON ≤256KiB；正文按 16000 字符分块", () => {
  const db = fresh();
  const nodes = Array.from({ length: 137 }, (_, i) => node("p", `n${String(i).padStart(3, "0")}`, { data: { name: "名".repeat(2000) } }));
  seed(db, "p", nodes, [], () => "字".repeat(40_000));
  const seen = new Set();
  let cursor = undefined, pages = 0;
  do {
    const page = canvasRepo.listNodeSummaries(db, { canvasId: "p", cursor, limit: 50 });
    assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 256 * 1024, "单页总 JSON 不超过 256KiB");
    for (const item of page.items) { assert.ok(!seen.has(item.id), `重复 ${item.id}`); seen.add(item.id); }
    cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 137);
  assert.ok(pages >= 3);
  code(() => canvasRepo.listNodeSummaries(db, { canvasId: "p", limit: 51 }), "invalid_request");
  code(() => canvasRepo.getNodes(db, { canvasId: "p", ids: nodes.slice(0, 51).map(n => n.id) }), "invalid_request");
  const chunk = canvasRepo.getDocumentChunk(db, { canvasId: "p", documentId: "d-n000", offset: 16_000, length: 99_999 });
  assert.equal(chunk.text.length, 16_000, "每块最多 16000 字符");
  assert.equal(chunk.total, 40_000);
  assert.equal(chunk.nextOffset, 32_000);
  code(() => canvasRepo.getDocumentChunk(db, { canvasId: "OTHER", documentId: "d-n000", offset: 0 }), "not_found");
  db.close();
});

test("按画布过滤是每个查询的必需条件；墓碑节点不在列表里但关联保留可恢复", () => {
  const db = fresh();
  seed(db, "A", [node("A", "a"), node("A", "b")], [{ id: "e", canvasId: "A", source: "a", target: "b", role: null, version: 0 }]);
  seed(db, "B", [node("B", "a")]);
  code(() => canvasRepo.listNodeSummaries(db, { limit: 10 }), "invalid_request");
  assert.deepEqual(canvasRepo.getNodes(db, { canvasId: "B", ids: ["a", "b"] }).map(n => n.id), ["a"], "不能读到别的画布同 ID 节点");
  canvasRepo.tombstoneNode(db, { canvasId: "A", nodeId: "a", deletedAt: "2026-10-31T00:00:00.000Z" });
  assert.deepEqual(canvasRepo.listNodeSummaries(db, { canvasId: "A", limit: 10 }).items.map(n => n.id), ["b"]);
  const restore = canvasRepo.getTombstone(db, { canvasId: "A", nodeId: "a" });
  assert.equal(restore.node.id, "a");
  assert.deepEqual(restore.edges.map(e => e.id), ["e"], "删除墓碑保留关联恢复信息");
  assert.equal(restore.document.content, "正文 a");
  db.close();
});

test("素材：assets 与 canvas_assets 分离；A 的素材不自动成为 B 的目录；物理去重不改变归属", () => {
  const db = fresh();
  seed(db, "A", []); seed(db, "B", []);
  assetsRepo.putAsset(db, { assetName: "cat.png", relativePath: "assets/cat.png", kind: "image", bytes: 10, sha256: "h1", status: "ready" });
  assetsRepo.putAsset(db, { assetName: "cat-copy.png", relativePath: "assets/cat.png", kind: "image", bytes: 10, sha256: "h1", status: "ready" });
  assetsRepo.linkCanvasAsset(db, { canvasId: "A", assetName: "cat.png", createdAt: "2026-10-30T00:00:00.000Z" });
  assetsRepo.linkCanvasAsset(db, { canvasId: "B", assetName: "cat-copy.png", createdAt: "2026-10-30T00:00:00.000Z" });
  assert.deepEqual(assetsRepo.listCanvasAssets(db, { canvasId: "A", limit: 50 }).items.map(a => a.assetName), ["cat.png"]);
  assert.deepEqual(assetsRepo.listCanvasAssets(db, { canvasId: "B", limit: 50 }).items.map(a => a.assetName), ["cat-copy.png"], "同一物理文件，归属各自独立");
  assert.equal(assetsRepo.canvasHasAsset(db, { canvasId: "B", assetName: "cat.png" }), false);
  code(() => assetsRepo.linkCanvasAsset(db, { canvasId: "A", assetName: "ghost.png", createdAt: "x" }), "SQLITE_CONSTRAINT_FOREIGNKEY");
  db.close();
});

test("Worker：migrate op 与固定 repository 派发可用；没有任意 SQL 入口", async () => {
  const { loadTypescript } = await import("./helpers/load-typescript.mjs");
  const loaded = await loadTypescript("lib/db/service.ts");
  try {
    const db = loaded.module.getDbService({ file: path.join(dir, "worker.sqlite"), workerPath: path.join(root, "lib", "db", "worker.cjs") });
    const migrated = await db.request("migrate", {});
    assert.ok(migrated.current >= 1);
    await db.request("command", { repository: "canvas.put", params: { canvas: canvas("W"), nodes: [node("W", "n")], documents: [{ id: "d-n", nodeId: "n", content: "x", version: 0 }], edges: [], fieldVersions: {} } });
    const page = await db.request("query", { repository: "canvas.listNodeSummaries", params: { canvasId: "W", limit: 10 } });
    assert.deepEqual(page.items.map(n => n.id), ["n"]);
    await assert.rejects(db.request("query", { repository: "select * from nodes", params: {} }), (error) => error.code === "unknown_repository");
    await db.close();
  } finally { await loaded.module.closeAllDbServices(); await loaded.dispose(); }
  const runtime = await readFile(path.join(root, "scripts", "db-runtime.mjs"), "utf8");
  assert.match(runtime, /migrate\.cjs/);
  assert.match(runtime, /repositories/);
});
