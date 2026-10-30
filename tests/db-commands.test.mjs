import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 真实临时 SQLite + 独立 JSON 数据目录：不碰用户主库。
const require = createRequire(import.meta.url);
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-db-commands-"));
process.env.GROK_CANVAS_DATA_DIR = path.join(dir, "json");
const { openDatabase } = require("../lib/db/driver.cjs");
const { migrate } = require("../lib/db/migrate.cjs");
const canvasRepo = require("../lib/db/repositories/canvas.cjs");
const sqlModule = require("../lib/db/command-repository.cjs");
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
const adapter = await loadTypescript("lib/db/command-adapter.ts");
const opened = [];
after(async () => {
  for (const db of opened) if (db.open) db.close();
  await store.dispose(); await service.dispose(); await repository.dispose(); await adapter.dispose();
  await rm(dir, { recursive: true, force: true });
});
const { saveCanvas } = store.module;
const { executeCommand, executeServerCommand, CommandError, JSON_STORAGE_EPOCH, selectCommandStore, listCanvasChanges, ChangesError } = service.module;
const { loadEntitySnapshot } = repository.module;
const { createSqlCommandStore } = adapter.module;

let files = 0;
const open = (file, options = {}) => { const db = openDatabase(file, { busyTimeoutMs: 2000, ...options }); opened.push(db); return db; };
const freshDb = () => { const file = path.join(dir, `cmd-${++files}.sqlite`); const db = open(file); migrate(db); return { db, file }; };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const command = (canvasId, kind, payload, actorId, actorSeq, extra = {}) => ({ schemaVersion: 1, commandId: uuid(), actorId, actorSeq, canvasId, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0, kind, payload, ...extra });
const legacyDoc = (id) => ({
  id, name: "命令画布", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: "n1", type: "image", position: { x: 0, y: 0 }, data: { name: "图1", prompt: "猫", status: "idle", assetName: "a1.png", aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
    { id: "n2", type: "image", position: { x: 400, y: 0 }, data: { name: "图2", prompt: "狗", status: "running", generationId: "g-new", assetName: null, aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
    { id: "t1", type: "canvasText", position: { x: 0, y: 400 }, width: 360, height: 260, data: { name: "文本", content: "旧正文" } },
    { id: "s1", type: "asset", position: { x: -400, y: 0 }, data: { name: "素材", assetName: "s1.png" } },
    { id: "v1", type: "video", position: { x: 800, y: 0 }, data: { name: "视频", prompt: "", duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true, status: "idle", uploadInputs: [] } },
  ],
  edges: [{ id: "e1", source: "s1", target: "v1", type: "scissor", data: { role: "first" } }],
});
/** 同一旧文档同时建 JSON 画布与 SQL 画布：SQL 种子取自 JSON 实体快照，确保两边起点逐字段一致。 */
let canvases = 0;
async function twinCanvas(db) {
  const id = `twin-${++canvases}`;
  assert.ok(await saveCanvas(legacyDoc(id), -1));
  const snap = await loadEntitySnapshot(id);
  canvasRepo.putCanvas(db, {
    canvas: { id, name: snap.name, revision: snap.revision, nameVersion: snap.nameVersion, storageEpoch: snap.storageEpoch, createdAt: "2026-01-01T00:00:00.000Z" },
    nodes: snap.nodes, documents: snap.documents, edges: snap.edges, fieldVersions: snap.fieldVersions,
  });
  return { id, snap };
}
const outcome = (promise) => promise.then(receipt => ({ ok: true, receipt }), error => { if (!(error instanceof CommandError) && error?.name !== "CommandValidationError") throw error; return { ok: false, code: error.code, status: error.status }; });
const count = (db, table, canvasId) => db.prepare(`select count(*) as n from ${table} where canvas_id = ?`).get(canvasId).n;
const normalized = (snap) => ({
  revision: snap.revision, name: snap.name, nameVersion: snap.nameVersion, eventSeq: snap.eventSeq,
  nodes: [...snap.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  documents: [...snap.documents].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...snap.edges].sort((a, b) => a.id.localeCompare(b.id)),
  actors: snap.actors,
  // JSON 会保留只剩正文版本的空对象；语义相同，比较时去掉空项。
  fieldVersions: Object.fromEntries(Object.entries(snap.fieldVersions).filter(([, fields]) => Object.keys(fields).length)),
});

/** 领域契约步骤：同一组命令依次作用于两个仓库，逐步比较结果。 */
function contractSteps(id, snap) {
  const node = (nid) => snap.nodes.find(n => n.id === nid);
  const move = (nid, to, actor, s) => command(id, "move_nodes", { items: [{ nodeId: nid, expectedVersion: 0, from: node(nid).geometry, to: { ...node(nid).geometry, ...to } }] }, actor, s);
  const patch = (nid, field, version, value, actor, s, extra) => command(id, "patch_nodes", { items: [{ nodeId: nid, field, expectedVersion: version, value }] }, actor, s, extra);
  const first = move("n1", { x: 50, y: 60 }, A, 1);
  const prompt = patch("n1", "prompt", 0, "第一版", A, 2);
  const server = { origin: "server", assetExists: () => true };
  const client = { origin: "client", assetExists: (name) => name !== "zz-missing.png" };
  return [
    ["两 actor 异字段：位置", first, client],
    ["两 actor 异字段：正文", patch("t1", "content", 0, "新正文", B, 1), client],
    ["prompt 第一版", prompt, client],
    ["同字段旧版本冲突", patch("n1", "prompt", 0, "过期写入", B, 2), client],
    ["不同字段不阻塞", patch("n1", "name", 0, "新名字", B, 3), client],
    ["batch 原子失败", command(id, "batch", { commands: [
      { kind: "move_nodes", payload: { items: [{ nodeId: "n2", expectedVersion: 0, from: node("n2").geometry, to: { ...node("n2").geometry, x: 999 } }] } },
      { kind: "edit_edges", payload: { add: [{ id: "e-new", canvasId: id, source: "n1", target: "n2", role: null, version: 0 }], remove: [] } },
      { kind: "patch_nodes", payload: { items: [{ nodeId: "n2", field: "prompt", expectedVersion: 7, value: "x" }] } },
    ] }, A, 3), client],
    ["响应丢失后重试", structuredClone(first), client],
    ["同 ID 不同载荷", { ...prompt, payload: { items: [{ ...prompt.payload.items[0], value: "篡改" }] } }, client],
    ["序号跳号", patch("n2", "name", 0, "x", A, 9), client],
    ["旧存储纪元", patch("n2", "name", 0, "x", A, 4, { storageEpoch: "sqlite-x" }), client],
    ["删除节点级联边", command(id, "delete_nodes", { items: [{ nodeId: "s1", expectedEntityVersion: 0 }] }, A, 4), client],
    ["墓碑不可复活", patch("s1", "name", 0, "复活", A, 5), client],
    ["加引用边", command(id, "edit_edges", { add: [{ id: "e-ref", canvasId: id, source: "n1", target: "v1", role: "reference", version: 0 }], remove: [] }, A, 6), client],
    ["改名", command(id, "rename_canvas", { expectedVersion: 0, name: "改名后" }, A, 7), client],
    ["登记缺失素材", command(id, "register_assets", { assets: [{ assetName: "zz-missing.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z" }] }, A, 8), client],
    ["客户端不能 apply_generation", command(id, "apply_generation", { nodeId: "n2", generationId: "g-new", claimId: "g-new", assets: [], patch: { status: "idle" } }, A, 9), client],
    ["过期 generationId 只登记素材", command(id, "apply_generation", { nodeId: "n2", generationId: "g-old", claimId: "g-old", assets: [{ assetName: "late.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z" }], patch: { status: "idle", assetName: "late.png" } }, C, 1), server],
    ["当前 generationId 写结果", command(id, "apply_generation", { nodeId: "n2", generationId: "g-new", claimId: "g-new", assets: [{ assetName: "done.png", kind: "image", createdAt: "2026-01-02T00:00:00.000Z" }], patch: { status: "idle", assetName: "done.png" } }, C, 2), server],
    ["新增文本节点", command(id, "add_nodes", {
      nodes: [{ id: "t9", canvasId: id, type: "canvasText", schemaVersion: 1, geometry: { x: 10, y: 10, width: 300, height: 200 }, entityVersion: 0, geometryVersion: 0, documentId: "doc_t9", data: { name: "新文本" } }],
      documents: [{ id: "doc_t9", nodeId: "t9", content: "hello", version: 0 }],
    }, A, 9), client],
  ];
}

test("JSON 与 SQL 两个仓库跑同一领域契约：逐步回执/错误码一致，最终实体快照一致", async () => {
  const { db } = freshDb();
  const sql = createSqlCommandStore(db, sqlModule);
  const { id, snap } = await twinCanvas(db);
  const report = [];
  for (const [label, input, context] of contractSteps(id, snap)) {
    const json = await outcome(executeCommand(structuredClone(input), context));
    const viaSql = await outcome(executeCommand(structuredClone(input), { ...context, repository: sql.repository }));
    assert.deepEqual(viaSql, json, label);
    report.push(json.ok ? `${label}: r${json.receipt.revision}${json.receipt.replayed ? " replayed" : ""}` : `${label}: ${json.code}`);
  }
  assert.deepEqual(report.filter(line => !/: r\d+/.test(line)).map(line => line.split(": ")[1]), [
    "field_conflict", "field_conflict", "command_id_reused", "actor_sequence_gap", "stale_epoch", "field_conflict", "invalid_command",
  ]);
  assert.deepEqual(normalized(sqlModule.loadSnapshot(db, id)), normalized(await loadEntitySnapshot(id)));
  const finalSql = sqlModule.loadSnapshot(db, id);
  assert.equal(finalSql.revision, 11);
  assert.equal(finalSql.eventSeq, 11);
  assert.equal(count(db, "canvas_events", id), 11, "每次有变化的提交恰好一条事件");
  assert.equal(db.prepare("select deleted_at is not null as gone from nodes where canvas_id = ? and id = 's1'").get(id).gone, 1, "删除是墓碑，行保留");
  assert.equal(db.prepare("select deleted_at is not null as gone from edges where canvas_id = ? and id = 'e1'").get(id).gone, 1);
  assert.equal(db.prepare("select missing from canvas_assets where canvas_id = ? and asset_name = 'zz-missing.png'").get(id).missing, 1);
});

for (const failAt of ["after_node", "before_receipt", "after_event"]) {
  test(`事务故障点 ${failAt}：抛错后重开数据库无部分提交，同一命令随后可正常执行`, async () => {
    const { db, file } = freshDb();
    const { id, snap } = await twinCanvas(db);
    const n1 = snap.nodes.find(n => n.id === "n1");
    const input = command(id, "batch", { commands: [
      { kind: "move_nodes", payload: { items: [{ nodeId: "n1", expectedVersion: 0, from: n1.geometry, to: { ...n1.geometry, x: 77 } }] } },
      { kind: "patch_nodes", payload: { items: [{ nodeId: "t1", field: "content", expectedVersion: 0, value: "半途" }] } },
    ] }, A, 1);
    const faulty = createSqlCommandStore(db, sqlModule, { failAt });
    await assert.rejects(executeCommand(structuredClone(input), { origin: "client", repository: faulty.repository }), new RegExp(`故障注入：${failAt}`));
    db.close();
    const reopened = open(file);
    const state = sqlModule.loadSnapshot(reopened, id);
    assert.equal(state.revision, 0);
    assert.deepEqual(state.nodes.find(n => n.id === "n1").geometry, n1.geometry);
    assert.equal(state.documents.find(d => d.nodeId === "t1").content, "旧正文");
    for (const table of ["canvas_events", "command_receipts", "actor_watermarks", "node_fields"]) assert.equal(count(reopened, table, id), 0, table);
    const receipt = await executeCommand(structuredClone(input), { origin: "client", repository: createSqlCommandStore(reopened, sqlModule).repository });
    assert.equal(receipt.revision, 1, "故障未占用 actorSeq/commandId");
  });
}

test("提交成功后丢 HTTP 再重试：同回执/revision/event，不重复执行；新连接上仍然幂等", async () => {
  const { db, file } = freshDb();
  const { id, snap } = await twinCanvas(db);
  const n2 = snap.nodes.find(n => n.id === "n2");
  const input = command(id, "move_nodes", { items: [{ nodeId: "n2", expectedVersion: 0, from: n2.geometry, to: { ...n2.geometry, x: 1, y: 2 } }] }, A, 1);
  const first = await executeCommand(structuredClone(input), { origin: "client", repository: createSqlCommandStore(db, sqlModule).repository });
  db.close();
  const again = open(file);
  const second = await executeCommand(structuredClone(input), { origin: "client", repository: createSqlCommandStore(again, sqlModule).repository });
  assert.equal(second.replayed, true);
  assert.deepEqual({ ...second, replayed: false }, first);
  assert.equal(count(again, "canvas_events", id), 1);
  assert.equal(again.prepare("select revision from canvases where id = ?").get(id).revision, 1);
});

test("SQL 追踪：move 不 SELECT 正文、不 UPDATE data_json，语句数不随节点数增长", async () => {
  const traceMove = async (n) => {
    const { db } = freshDb();
    const id = `big-${n}`;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, canvasId: id, type: "canvasText", schemaVersion: 1, geometry: { x: i, y: 0, width: 360, height: 260 }, entityVersion: 0, geometryVersion: 0, documentId: `doc_t${i}`, data: { name: `t${i}` } }));
    const big = "字".repeat(100 * 1024);
    canvasRepo.putCanvas(db, { canvas: { id, name: "大画布", revision: 0, nameVersion: 0, storageEpoch: JSON_STORAGE_EPOCH, createdAt: "2026-01-01T00:00:00.000Z" }, nodes, documents: nodes.map(node => ({ id: node.documentId, nodeId: node.id, content: node.id === "t0" ? big : "短", version: 0 })), edges: [], fieldVersions: {} });
    const log = [];
    const traced = createSqlCommandStore(db, sqlModule, { trace: (sql) => log.push(sql) });
    const receipt = await executeCommand(command(id, "move_nodes", { items: [{ nodeId: "t0", expectedVersion: 0, from: nodes[0].geometry, to: { ...nodes[0].geometry, x: 500 } }] }, A, 1), { origin: "client", repository: traced.repository });
    assert.deepEqual(receipt.changedNodeIds, ["t0"]);
    assert.deepEqual(receipt.delta.documents, []);
    assert.ok(!JSON.stringify(receipt).includes("字字字"), "回执不含正文");
    return log;
  };
  const small = await traceMove(10);
  const large = await traceMove(3000);
  assert.equal(large.length, small.length, `语句数与节点数无关：${small.length} vs ${large.length}`);
  assert.ok(!large.some(sql => /from documents|join documents/i.test(sql)), "move 不读取正文");
  assert.ok(!large.some(sql => /^update nodes/i.test(sql) && /data_json/.test(sql)), "move 不写 data_json");
  assert.ok(large.some(sql => /^update nodes set x = \?, y = \?, width = \?, height = \?, entity_version = \?, geometry_version = \?/.test(sql)));
});

test("changes 按 revision 分页：页间无重复/跳过，整条事件；错误纪元 409；早于保留水位 410；超大事件单独返回", async () => {
  const { db } = freshDb();
  const sql = createSqlCommandStore(db, sqlModule);
  const { id, snap } = await twinCanvas(db);
  const n1 = snap.nodes.find(n => n.id === "n1");
  let geometry = n1.geometry;
  for (let i = 1; i <= 120; i++) {
    const to = { ...geometry, x: geometry.x + 1 };
    await executeCommand(command(id, "move_nodes", { items: [{ nodeId: "n1", expectedVersion: i - 1, from: geometry, to }] }, A, i), { origin: "client", repository: sql.repository });
    geometry = to;
  }
  const seen = [];
  let after = 0, pages = 0;
  for (;;) {
    const page = await sql.listChanges({ canvasId: id, afterRevision: after, limit: 50, storageEpoch: JSON_STORAGE_EPOCH });
    assert.equal(page.fromRevision, after);
    for (const event of page.events) { assert.equal(event.delta.fromRevision, seen.length ? seen.at(-1).revision : 0); seen.push(event); }
    pages++;
    after = page.toRevision;
    if (!page.hasMore) break;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen.map(e => e.eventSeq), Array.from({ length: 120 }, (_, i) => i + 1));
  assert.deepEqual(seen.at(-1).delta.nodes[0].geometry, geometry);
  const empty = await sql.listChanges({ canvasId: id, afterRevision: 120 });
  assert.deepEqual([empty.events.length, empty.hasMore, empty.toRevision], [0, false, 120]);
  const code = async (params, expected, status) => assert.rejects(sql.listChanges({ canvasId: id, ...params }), (error) => { assert.equal(error.code, expected); assert.equal(error.status, status); return true; });
  await code({ afterRevision: 0, storageEpoch: "sqlite-other" }, "stale_epoch", 409);
  await code({ afterRevision: 0, limit: 101 }, "invalid_request", 400);
  await code({ afterRevision: 121 }, "invalid_request", 400);
  // 模拟保留裁剪：删掉前 10 条事件。
  db.prepare("delete from canvas_events where canvas_id = ? and revision <= 10").run(id);
  await code({ afterRevision: 3 }, "snapshot_required", 410);
  assert.equal((await sql.listChanges({ canvasId: id, afterRevision: 10, limit: 5 })).events[0].eventSeq, 11);
  // 超大事件（>1MiB）独占一页并标 oversized；>4MiB 要求快照。
  const pad = (bytes, from, to, eventSeq) => db.prepare("insert into canvas_events (canvas_id, event_seq, revision, command_id, delta_json, created_at) values (?, ?, ?, null, ?, '2026-01-01T00:00:00.000Z')")
    .run(id, eventSeq, to, JSON.stringify({ canvasId: id, fromRevision: from, revision: to, pad: "x".repeat(bytes) }));
  pad(1536 * 1024, 120, 121, 121);
  pad(10, 121, 122, 122);
  db.prepare("update canvases set revision = 122 where id = ?").run(id);
  const oversized = await sql.listChanges({ canvasId: id, afterRevision: 119 });
  assert.deepEqual(oversized.events.map(e => [e.eventSeq, !!e.oversized]), [[120, false]], "大事件不与前一条拼页");
  const alone = await sql.listChanges({ canvasId: id, afterRevision: 120 });
  assert.deepEqual([alone.events.map(e => [e.eventSeq, !!e.oversized]), alone.hasMore], [[[121, true]], true]);
  assert.deepEqual((await sql.listChanges({ canvasId: id, afterRevision: 121 })).events.map(e => e.eventSeq), [122]);
  pad(5 * 1024 * 1024, 122, 123, 123);
  db.prepare("update canvases set revision = 123 where id = ?").run(id);
  await code({ afterRevision: 122 }, "snapshot_required", 410);
});

test("SQLite busy：明确 503 storage_unavailable 且可重试；事务回滚，释放后原命令成功", async () => {
  const { db, file } = freshDb();
  const { id, snap } = await twinCanvas(db);
  db.close();
  const writer = open(file, { busyTimeoutMs: 50 });
  const blocker = open(file, { busyTimeoutMs: 50 });
  blocker.prepare("begin immediate").run();
  const n1 = snap.nodes.find(n => n.id === "n1");
  const input = command(id, "move_nodes", { items: [{ nodeId: "n1", expectedVersion: 0, from: n1.geometry, to: { ...n1.geometry, x: 5 } }] }, A, 1);
  const store = createSqlCommandStore(writer, sqlModule);
  await assert.rejects(executeCommand(structuredClone(input), { origin: "client", repository: store.repository }), (error) => {
    assert.equal(error.code, "storage_unavailable"); assert.equal(error.status, 503); assert.ok(error.retryAfterMs > 0); return true;
  });
  blocker.prepare("rollback").run();
  assert.equal((await executeCommand(structuredClone(input), { origin: "client", repository: store.repository })).revision, 1);
});

test("服务端 executeServerCommand 也走所选 SQL 仓库；selectCommandStore 只在显式选择时生效", async () => {
  const { db } = freshDb();
  const sql = createSqlCommandStore(db, sqlModule);
  const { id } = await twinCanvas(db);
  selectCommandStore(sql);
  try {
    const receipt = await executeServerCommand(id, C, (reader) => ({ kind: "patch_nodes", payload: { items: [{ nodeId: "n1", field: "name", expectedVersion: reader.fieldVersion("n1", "name"), value: "服务端" }] } }), { origin: "agent" });
    assert.equal(receipt.revision, 1);
    assert.equal(sqlModule.loadSnapshot(db, id).nodes.find(n => n.id === "n1").data.name, "服务端");
    assert.equal((await loadEntitySnapshot(id)).revision, 0, "JSON 画布未被写入");
  } finally { selectCommandStore(null); }
  const viaJson = await executeServerCommand(id, C, (reader) => ({ kind: "patch_nodes", payload: { items: [{ nodeId: "n1", field: "name", expectedVersion: reader.fieldVersion("n1", "name"), value: "JSON" }] } }), { origin: "agent" });
  assert.equal(viaJson.revision, 1);
  assert.equal(sqlModule.loadSnapshot(db, id).revision, 1, "取消选择后不再写 SQL");
});

const routeSource = await readFile(new URL("../app/api/canvases/[id]/changes/route.ts", import.meta.url), "utf8").catch(() => "");
const routeModule = {};
if (routeSource) vm.runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: routeModule, Response, JSON, Promise, Number, Object, String, Error, URL,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@/lib/canvas-runtime/command-service") return service.module;
    throw new Error(`未模拟依赖：${name}`);
  },
});
const getChanges = (canvasId, query) => routeModule.GET(new Request(`http://127.0.0.1:3210/api/canvases/${canvasId}/changes?${query}`), { params: Promise.resolve({ id: canvasId }) });

test("changes 路由：C6 响应形状；参数非法 400；JSON 默认仓库缺事件 410；选择 SQL 后返回事件", async () => {
  assert.ok(routeModule.GET, "changes 路由存在");
  const { db } = freshDb();
  const { id, snap } = await twinCanvas(db);
  assert.equal((await getChanges(id, "afterRevision=-1")).status, 400);
  assert.equal((await getChanges(id, "limit=5")).status, 400);
  const jsonEmpty = await getChanges(id, "afterRevision=0");
  assert.equal(jsonEmpty.status, 200);
  assert.deepEqual(Object.keys(await jsonEmpty.json()).sort(), ["events", "fromRevision", "hasMore", "storageEpoch", "toRevision"]);
  await executeCommand(command(id, "patch_nodes", { items: [{ nodeId: "n1", field: "name", expectedVersion: 0, value: "改" }] }, A, 1), { origin: "client" });
  const gone = await getChanges(id, "afterRevision=0");
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, "snapshot_required");
  assert.equal((await getChanges("missing-canvas", "afterRevision=0")).status, 404);
  const sql = createSqlCommandStore(db, sqlModule);
  await executeCommand(command(id, "patch_nodes", { items: [{ nodeId: "n1", field: "name", expectedVersion: 0, value: "改" }] }, B, 1), { origin: "client", repository: sql.repository });
  selectCommandStore(sql);
  try {
    const page = await (await getChanges(id, `afterRevision=0&limit=10&storageEpoch=${snap.storageEpoch}`)).json();
    assert.deepEqual([page.events.length, page.events[0].revision, page.toRevision, page.hasMore], [1, 1, 1, false]);
    assert.equal((await getChanges(id, "afterRevision=0&storageEpoch=other")).status, 409);
  } finally { selectCommandStore(null); }
  assert.ok(listCanvasChanges && ChangesError);
});

test("命令路由未默认切到 SQL；db-commands 已登记进 pnpm test", async () => {
  const route = await readFile(new URL("../app/api/canvases/[id]/commands/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /command-adapter|better-sqlite3/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:db"], /db-commands\.test\.mjs/);
});
