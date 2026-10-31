import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P6-02：跨模块故障注入（存储 / 同步 / Agent / 保留）。注入只经显式依赖参数，不改生产行为。
// 每个用例在故障前后核对正式实体、修订、事件、工具状态与上游 POST 次数，不只看错误文案。
const require = createRequire(import.meta.url);
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-faults-"));
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
const agent = await loadTypescript("lib/agent/agent.ts", { packages: true });
const events = await loadTypescript("lib/agent/events.ts", { packages: true });
const leases = await loadTypescript("lib/canvas-runtime/lease-service.ts");
const bus = await loadTypescript("lib/canvas-runtime/change-bus.ts");
const opened = [];
after(async () => {
  service.module.selectCommandStore(null);
  for (const db of opened) if (db.open) db.close();
  for (const l of [store, service, repository, adapter, agent, events, leases, bus]) await l.dispose();
  await rm(dir, { recursive: true, force: true });
});
const { executeCommand, CommandError, JSON_STORAGE_EPOCH, selectCommandStore } = service.module;
const A = "11111111-1111-4111-8111-111111111111";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const doc = (id) => ({ id, name: "故障", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: "t1", type: "canvasText", position: { x: 0, y: 0 }, width: 300, height: 200, data: { name: "一", content: "原正文" } }], edges: [] });
const rename = (canvasId, actorSeq, version, value = `名${actorSeq}`) => ({ schemaVersion: 1, commandId: uuid(), actorId: A, actorSeq, canvasId, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0,
  kind: "patch_nodes", payload: { items: [{ nodeId: "t1", field: "name", expectedVersion: version, value }] } });
async function drain(iterable) { let last; for await (const value of iterable) last = value; return last; }

async function sqlCanvas(id) {
  const db = openDatabase(path.join(dir, `${id}.sqlite`), { busyTimeoutMs: 2000 });
  opened.push(db);
  migrate(db);
  assert.ok(await store.module.saveCanvas(doc(id), -1));
  const snap = await repository.module.loadEntitySnapshot(id);
  canvasRepo.putCanvas(db, { canvas: { id, name: snap.name, revision: snap.revision, nameVersion: snap.nameVersion, storageEpoch: snap.storageEpoch, createdAt: "2026-01-01T00:00:00.000Z" }, nodes: snap.nodes, documents: snap.documents, edges: snap.edges, fieldVersions: snap.fieldVersions });
  const state = () => ({ revision: db.prepare("select revision from canvases where id = ?").get(id).revision, events: db.prepare("select count(*) as n from canvas_events where canvas_id = ?").get(id).n, receipts: db.prepare("select count(*) as n from command_receipts where canvas_id = ?").get(id).n });
  return { db, state };
}

test("提交成功但回执丢失：原命令重试只执行一次（修订、事件、回执各 +1），变更通知不重复", async () => {
  const { db, state } = await sqlCanvas("f-receipt");
  selectCommandStore(adapter.module.createSqlCommandStore(db, sqlModule));
  const seen = [];
  const unsubscribe = bus.module.subscribeCanvasChanged("f-receipt", change => seen.push(change));
  const before = state();
  const cmd = rename("f-receipt", 1, 0);
  await executeCommand(cmd, { origin: "client" }); // 假设这次响应在网络上丢失
  for (let i = 0; i < 5; i++) assert.equal((await executeCommand(structuredClone(cmd), { origin: "client" })).replayed, true);
  const after = state();
  assert.deepEqual({ revision: after.revision - before.revision, events: after.events - before.events, receipts: after.receipts - before.receipts }, { revision: 1, events: 1, receipts: 1 });
  assert.equal(seen.length, 1, "重放不产生新的同步通知");
  unsubscribe();
  selectCommandStore(null);
});

test("SQLITE_BUSY：整体回滚为可重试的 storage_unavailable，没有任何写入；随后重试成功", async () => {
  const { db, state } = await sqlCanvas("f-busy");
  const real = adapter.module.createSqlCommandStore(db, sqlModule);
  let fail = true;
  selectCommandStore({ ...real, repository: { transact: (...args) => { if (fail) { fail = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } return real.repository.transact(...args); } } });
  const before = state();
  const cmd = rename("f-busy", 1, 0);
  const error = await executeCommand(cmd, { origin: "client" }).then(() => null, e => e);
  assert.ok(error instanceof CommandError);
  assert.equal(error.code, "storage_unavailable");
  assert.ok(error.retryAfterMs > 0, "客户端 outbox 保留并稍后重发");
  assert.deepEqual(state(), before, "失败时没有部分写入");
  const receipt = await executeCommand(structuredClone(cmd), { origin: "client" });
  assert.equal(receipt.replayed, false, "同一命令重试被正常执行一次");
  assert.equal(state().revision, before.revision + 1);
  selectCommandStore(null);
});

test("压缩回执后再次重放旧命令：不重新执行、不复活、修订不变", async () => {
  const { db, state } = await sqlCanvas("f-compact");
  selectCommandStore(adapter.module.createSqlCommandStore(db, sqlModule));
  const cmd = rename("f-compact", 1, 0);
  await executeCommand(cmd, { origin: "client" });
  retention.ack(db, { canvasId: "f-compact", actorId: A, ackSeq: 1 });
  assert.equal(retention.compact(db, { now: Date.now() + 2 * 86400_000 }).receiptsCompacted, 1);
  const before = state();
  assert.equal((await executeCommand(structuredClone(cmd), { origin: "client" })).replayed, true);
  assert.deepEqual(state(), before);
  assert.equal(db.prepare("pragma integrity_check").get().integrity_check, "ok");
  selectCommandStore(null);
});

test("用户正在编辑正文时 Agent 改同一字段：工具记为 blocked，正文不变；租约释放后可以成功", async () => {
  const created = await store.module.createCanvas();
  assert.ok(await store.module.saveCanvas({ ...doc(created.id), name: created.name, createdAt: created.createdAt }, created.revision));
  const lease = leases.module.getLeaseService();
  const held = lease.acquire(created.id, "t1", "content", A);
  assert.ok(held.ok);
  const tools = agent.module.createCanvasTools(created.id, "http://127.0.0.1:9", "conv-f");
  await assert.rejects(drain(tools.edit_canvas_nodes.execute({ updates: [{ id: "t1", content: "Agent 正文" }], remove: [], connect: [], disconnect: [] }, { toolCallId: "lease-1", messages: [] })));
  assert.equal((await store.module.loadCanvas(created.id)).nodes[0].data.content, "原正文");
  const record = (await events.module.listToolRecords(created.id)).find(r => r.toolCallId === "lease-1");
  assert.equal(record.phase, "blocked");
  lease.release(created.id, "t1", "content", A, held.token);
  await drain(tools.edit_canvas_nodes.execute({ updates: [{ id: "t1", content: "Agent 正文" }], remove: [], connect: [], disconnect: [] }, { toolCallId: "lease-2", messages: [] }));
  assert.equal((await store.module.loadCanvas(created.id)).nodes[0].data.content, "Agent 正文");
});

test("删除节点后迟到的 Agent 修改：拒绝，不复活节点", async () => {
  const created = await store.module.createCanvas();
  assert.ok(await store.module.saveCanvas({ ...doc(created.id), name: created.name, createdAt: created.createdAt }, created.revision));
  const tools = agent.module.createCanvasTools(created.id, "http://127.0.0.1:9", "conv-g");
  await drain(tools.edit_canvas_nodes.execute({ updates: [], remove: ["t1"], connect: [], disconnect: [] }, { toolCallId: "rm-1", messages: [] }));
  await assert.rejects(drain(tools.edit_canvas_nodes.execute({ updates: [{ id: "t1", name: "迟到" }], remove: [], connect: [], disconnect: [] }, { toolCallId: "late-1", messages: [] })));
  assert.equal((await store.module.loadCanvas(created.id)).nodes.length, 0);
});
