import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P3-10：确认水位、事件保留、回执压缩与压缩后重试；真实临时 SQLite，不碰用户主库。
const require = createRequire(import.meta.url);
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-retention-"));
process.env.GROK_CANVAS_DATA_DIR = path.join(dir, "json");
const { openDatabase } = require("../lib/db/driver.cjs");
const { migrate } = require("../lib/db/migrate.cjs");
const canvasRepo = require("../lib/db/repositories/canvas.cjs");
const sqlModule = require("../lib/db/command-repository.cjs");
const retention = require("../lib/db/retention.cjs");
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
const adapter = await loadTypescript("lib/db/command-adapter.ts");
const opened = [];
after(async () => {
  service.module.selectCommandStore(null);
  for (const db of opened) if (db.open) db.close();
  for (const loaded of [store, service, repository, adapter]) await loaded.dispose();
  await rm(dir, { recursive: true, force: true });
});
const { executeCommand, CommandError, JSON_STORAGE_EPOCH, selectCommandStore } = service.module;
const DAY = 24 * 60 * 60 * 1000;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let seq = 0, files = 0, canvases = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function setup() {
  const db = openDatabase(path.join(dir, `r-${++files}.sqlite`), { busyTimeoutMs: 2000 });
  opened.push(db);
  migrate(db);
  const id = `ret-${++canvases}`;
  assert.ok(await store.module.saveCanvas({ id, name: "保留", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "t1", type: "canvasText", position: { x: 0, y: 0 }, width: 300, height: 200, data: { name: "一", content: "a" } },
      { id: "t2", type: "canvasText", position: { x: 400, y: 0 }, width: 300, height: 200, data: { name: "二", content: "b" } },
    ], edges: [] }, -1));
  const snap = await repository.module.loadEntitySnapshot(id);
  canvasRepo.putCanvas(db, {
    canvas: { id, name: snap.name, revision: snap.revision, nameVersion: snap.nameVersion, storageEpoch: snap.storageEpoch, createdAt: "2026-01-01T00:00:00.000Z" },
    nodes: snap.nodes, documents: snap.documents, edges: snap.edges, fieldVersions: snap.fieldVersions,
  });
  selectCommandStore(adapter.module.createSqlCommandStore(db, sqlModule));
  const versions = { t1: 0, t2: 0 };
  const rename = (actorId, actorSeq, nodeId) => ({ schemaVersion: 1, commandId: uuid(), actorId, actorSeq, canvasId: id, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0,
    kind: "patch_nodes", payload: { items: [{ nodeId, field: "name", expectedVersion: versions[nodeId]++, value: `名${seq}` }] } });
  const revision = () => db.prepare("select revision from canvases where id = ?").get(id).revision;
  const events = () => db.prepare("select count(*) as n from canvas_events where canvas_id = ?").get(id).n;
  return { db, id, rename, revision, events };
}
const outcome = (promise) => promise.then(receipt => ({ ok: true, receipt }), error => { if (!(error instanceof CommandError)) throw error; return { ok: false, code: error.code }; });

test("ack：只接受已接受范围内的单调水位；未来序号/未知 actor/旧纪元拒绝；A 的确认不影响 B", async () => {
  const { db, id, rename } = await setup();
  for (let s = 1; s <= 3; s++) await executeCommand(rename(A, s, "t1"), { origin: "client" });
  await executeCommand(rename(B, 1, "t2"), { origin: "client" });
  assert.throws(() => retention.ack(db, { canvasId: id, actorId: A, ackSeq: 4 }), { code: "invalid_request" });
  assert.deepEqual(retention.ack(db, { canvasId: id, actorId: A, ackSeq: 2 }), { ackSeq: 2, acceptedSeq: 3 });
  assert.deepEqual(retention.ack(db, { canvasId: id, actorId: A, ackSeq: 1 }), { ackSeq: 2, acceptedSeq: 3 }, "水位不回退");
  assert.throws(() => retention.ack(db, { canvasId: id, actorId: "33333333-3333-4333-8333-333333333333", ackSeq: 1 }), { code: "not_found" });
  assert.throws(() => retention.ack(db, { canvasId: id, actorId: A, ackSeq: 2, storageEpoch: "sqlite-other" }), { code: "stale_epoch" });
  const b = retention.stats(db, { canvasId: id }).watermarks.find(w => w.actorId === B);
  assert.equal(b.ackSeq, 0);
});

test("回执压缩：只压缩已确认且超过 24h 的；重发已压缩命令不再执行、不增修订；同序号换 ID 拒绝；7 天后未确认的也压缩", async () => {
  const { db, id, rename, revision, events } = await setup();
  const sent = [];
  for (let s = 1; s <= 3; s++) { const cmd = rename(A, s, "t1"); sent.push(cmd); await executeCommand(cmd, { origin: "client" }); }
  const bCmd = rename(B, 1, "t2");
  await executeCommand(bCmd, { origin: "client" });
  retention.ack(db, { canvasId: id, actorId: A, ackSeq: 2 });
  assert.equal(retention.compact(db, { now: Date.now() }).receiptsCompacted, 0, "24 小时内不压缩");
  const result = retention.compact(db, { now: Date.now() + 2 * DAY });
  assert.equal(result.receiptsCompacted, 2, "A 的 1、2 已确认，3 未确认；B 未确认");
  const stats = retention.stats(db, { canvasId: id });
  assert.equal(stats.compactedReceipts, 2);
  assert.equal(stats.watermarks.find(w => w.actorId === A).retiredBefore, 3);

  const before = { revision: revision(), events: events() };
  const replay = await executeCommand(structuredClone(sent[0]), { origin: "client" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.compacted, true, "返回精简回执");
  assert.equal(replay.commandId, sent[0].commandId);
  assert.deepEqual({ revision: revision(), events: events() }, before, "已压缩的旧命令不重复执行");
  const reused = await outcome(executeCommand({ ...structuredClone(sent[0]), commandId: uuid() }, { origin: "client" }));
  assert.deepEqual(reused, { ok: false, code: "actor_sequence_gap" }, "相同 actorSeq 不同 ID 拒绝");
  const tampered = await outcome(executeCommand({ ...structuredClone(sent[1]), payload: { items: [{ ...sent[1].payload.items[0], value: "篡改" }] } }, { origin: "client" }));
  assert.deepEqual(tampered, { ok: false, code: "command_id_reused" }, "压缩后仍保留请求 hash");

  assert.equal(retention.compact(db, { now: Date.now() + 8 * DAY }).receiptsCompacted, 2, "超过 7 天：A 的 3 与 B 的 1 也压缩");
  assert.equal((await executeCommand(structuredClone(bCmd), { origin: "client" })).replayed, true);
  assert.equal(retention.compact(db, { now: Date.now() + 8 * DAY }).receiptsCompacted, 0, "已压缩的不重复处理");
});

test("事件保留：至少保留最近 N 条且只删超时的；被删窗口之前的增量返回 snapshot_required，之后的照常；批次有界", async () => {
  const { db, id, rename, revision, events } = await setup();
  const base = events();
  for (let s = 1; s <= 5; s++) await executeCommand(rename(A, s, s % 2 ? "t1" : "t2"), { origin: "client" });
  assert.equal(events(), base + 5);
  assert.equal(retention.compact(db, { now: Date.now(), keepEvents: 1 }).eventsDeleted, 0, "未超时不删");
  const partial = retention.compact(db, { now: Date.now() + 2 * DAY, keepEvents: 1, batch: 2 });
  assert.equal(partial.eventsDeleted, 2);
  assert.equal(partial.more, true, "批次用尽时报告 more");
  retention.compact(db, { now: Date.now() + 2 * DAY, keepEvents: 1 });
  assert.equal(events(), 1, "保留最近 1 条");
  assert.throws(() => sqlModule.listChanges(db, { canvasId: id, afterRevision: 0 }), { code: "snapshot_required" });
  const page = sqlModule.listChanges(db, { canvasId: id, afterRevision: revision() - 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.toRevision, revision());
  const stats = retention.stats(db);
  assert.equal(stats.pressure, false);
  assert.ok(stats.events >= 1 && stats.eventBytes > 0);
});

test("压缩是单个事务：中途失败时事件、回执与水位都不变", async () => {
  const { db, id, rename, events } = await setup();
  for (let s = 1; s <= 2; s++) await executeCommand(rename(A, s, "t1"), { origin: "client" });
  retention.ack(db, { canvasId: id, actorId: A, ackSeq: 2 });
  const receiptsBefore = db.prepare("select receipt_json from command_receipts order by command_id").all();
  const eventsBefore = events();
  // 包一层：在 retired_before 更新时抛错，模拟压缩到一半崩溃。
  const failing = { transaction: fn => db.transaction(fn), prepare: sql => {
    const statement = db.prepare(sql);
    if (!sql.includes("retired_before = max")) return statement;
    return { run: () => { throw new Error("模拟崩溃"); } };
  } };
  assert.throws(() => retention.compact(failing, { now: Date.now() + 2 * DAY, keepEvents: 0 }), /模拟崩溃/);
  assert.deepEqual(db.prepare("select receipt_json from command_receipts order by command_id").all(), receiptsBefore);
  assert.equal(events(), eventsBefore);
  assert.equal(retention.stats(db, { canvasId: id }).watermarks[0].retiredBefore, 0);
});
