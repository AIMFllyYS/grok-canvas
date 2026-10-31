import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 全部在临时目录演练：合成旧 JSON 数据 → 切换 → SQLite 权威下走真实业务模块（DB 经 Worker）。
const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-cutover-"));
const { runCutover, refuseRollback } = require("../lib/db/cutover.cjs");
const legacy = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
const catalog = await loadTypescript("lib/db/import-catalog.ts");
const convert = { fromCanvasDoc: legacy.module.fromCanvasDoc, classifySource: catalog.module.classifySource };
const ACTOR = "11111111-1111-4111-8111-111111111111";
const write = async (dir, rel, value) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), typeof value === "string" ? value : JSON.stringify(value)); };
async function walk(dir, base = dir, out = []) { for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f, base, out); else out.push(path.relative(base, f)); } return out; }
const hashes = async (dir, files) => Object.fromEntries(await Promise.all(files.map(async f => [f, createHash("sha256").update(await readFile(path.join(dir, f))).digest("hex")])));
const LEGACY_FILES = ["canvases/c1.json", "canvases/c2.json", "agent/c1.json", "app-state.json", "assets/a.png", "generations/a.png.json", "video-tasks/t-done.json"];

async function legacyData(name, mutate = () => {}) {
  const dir = path.join(root, name);
  const files = {
    "canvases/c1.json": {
      id: "c1", name: "画布一", schemaVersion: 1, revision: 4, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", viewport: { x: 10, y: 20, zoom: 0.5 },
      nodes: [
        { id: "n1", type: "image", position: { x: 0, y: 0 }, width: 320, height: 320, data: { name: "图", prompt: "猫", status: "idle", assetName: "a.png", aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
        { id: "t1", type: "canvasText", position: { x: 0, y: 400 }, width: 360, height: 260, data: { name: "文", content: "旧正文" } },
      ],
      edges: [],
      libraryAssets: [{ assetName: "a.png", name: "封面", sources: ["generated"], addedAt: "2026-01-01T01:00:00.000Z" }],
      appliedOperationIds: ["old-op-1"],
    },
    "canvases/c2.json": { id: "c2", name: "画布二", schemaVersion: 1, revision: 1, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    "agent/c1.json": { id: "c1", canvasId: "c1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", activeConversationId: "k1", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "你好" }] }], conversations: [{ id: "k1", title: "对话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", settings: {}, messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "你好" }] }] }] },
    "app-state.json": { lastCanvasId: "c1" },
    "assets/a.png": "PNG",
    "generations/a.png.json": { schemaVersion: 1, assetName: "a.png", savedAt: "2026-01-01T01:00:00.000Z", originalPrompt: "猫", submittedPrompt: "猫", model: "m", mode: "t2i", parameters: {}, referenceAssets: [], startedAt: "2026-01-01T00:59:00.000Z" },
    "video-tasks/t-done.json": { schemaVersion: 1, taskId: "t-done", requestId: "r1", status: "completed", canvasId: "c1", nodeId: "n1", snapshot: { prompt: "海" }, remoteUrl: null, result: null, error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
  mutate(files);
  for (const [rel, value] of Object.entries(files)) if (value !== undefined) await write(dir, rel, value);
  return dir;
}
const readMarker = async (dir) => existsSync(path.join(dir, "storage-state.json")) ? JSON.parse(await readFile(path.join(dir, "storage-state.json"), "utf8")) : null;

for (const failAt of ["before_prepare", "during_import", "after_validate", "before_marker"]) {
  test(`断点 ${failAt}：中断后仍只有 JSON 权威，源 JSON 不变；重跑完成切换后只有 SQLite 权威`, async () => {
    const dir = await legacyData(`break-${failAt}`);
    const before = await hashes(dir, LEGACY_FILES);
    await assert.rejects(runCutover({ dataDir: dir, convert, clientsDrained: true, failAt }), { code: failAt === "during_import" ? "interrupted" : "interrupted" });
    assert.equal(await readMarker(dir), null, "标记未发布 → JSON 仍是唯一权威");
    assert.deepEqual(await hashes(dir, LEGACY_FILES), before);
    const done = await runCutover({ dataDir: dir, convert, clientsDrained: true });
    assert.equal(done.status, "committed");
    const marker = await readMarker(dir);
    assert.equal(marker.backend, "sqlite");
    assert.ok(existsSync(path.join(dir, ...marker.dbFile.split("/"))));
    assert.equal(existsSync(path.join(dir, "maintenance.json")), false, "提交后退出维护");
    assert.deepEqual(await hashes(dir, LEGACY_FILES), before, "旧 JSON 只读保留");
  });
}

test("断点 after_marker：标记已发布即 SQLite 权威；重跑只收尾，不重新导入也不回 JSON", async () => {
  const dir = await legacyData("break-after-marker");
  await assert.rejects(runCutover({ dataDir: dir, convert, clientsDrained: true, failAt: "after_marker" }), { code: "interrupted" });
  const marker = await readMarker(dir);
  assert.equal(marker.backend, "sqlite");
  assert.ok(existsSync(path.join(dir, "maintenance.json")), "中断时仍在维护模式");
  const again = await runCutover({ dataDir: dir, convert, clientsDrained: true });
  assert.deepEqual([again.status, again.alreadySwitched, again.epoch], ["committed", true, marker.epoch]);
  assert.equal(existsSync(path.join(dir, "maintenance.json")), false);
  assert.throws(() => refuseRollback(dir), { code: "rollback_refused" });
});

test("阻断：未确认客户端 outbox、待定/未知生成、未完成视频任务、坏文件都不切换，并给出处理选项", async () => {
  const clients = await legacyData("block-clients");
  const r1 = await runCutover({ dataDir: clients, convert });
  assert.equal(r1.status, "blocked");
  assert.deepEqual(r1.blockers.map(b => b.kind), ["clients"]);
  const claims = await legacyData("block-claims", f => { f["canvases/c1.json"].generationClaims = { n1: { id: "g-1", state: "unknown" } }; f["video-tasks/t-run.json"] = { schemaVersion: 1, taskId: "t-run", requestId: "r2", status: "pending", canvasId: "c1", nodeId: "n1", snapshot: {}, remoteUrl: null, result: null, error: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }; });
  const r2 = await runCutover({ dataDir: claims, convert, clientsDrained: true });
  assert.deepEqual(r2.blockers.map(b => b.kind).sort(), ["generation_claim", "video_task"]);
  assert.match(r2.blockers.find(b => b.kind === "generation_claim").action, /不会自动重新收费/);
  const corrupt = await legacyData("block-corrupt", f => { f["canvases/c3.json"] = "{坏"; });
  const r3 = await runCutover({ dataDir: corrupt, convert, clientsDrained: true });
  assert.equal(r3.status, "blocked");
  assert.ok(r3.blockers.some(b => b.kind === "import" && b.code === "corrupt_json"));
  for (const dir of [clients, claims, corrupt]) {
    assert.equal(await readMarker(dir), null);
    assert.equal(existsSync(path.join(dir, "maintenance.json")), false, "阻断后退出维护");
  }
});

// ---------------------------------------------------------------- SQLite 权威下的业务入口
const live = await legacyData("live");
const liveBefore = await hashes(live, LEGACY_FILES);
const committed = await runCutover({ dataDir: live, convert, clientsDrained: true });
process.env.GROK_CANVAS_DATA_DIR = live;
const store = await loadTypescript("lib/canvas-store.ts", { packages: true });
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const agentStore = await loadTypescript("lib/agent/store.ts", { packages: true });
const claimsModule = await loadTypescript("lib/generation-claims.ts", { packages: true });
const videoTasks = await loadTypescript("lib/video-tasks.ts", { packages: true });
const assets = await loadTypescript("lib/assets.ts", { packages: true });
const mode = await loadTypescript("lib/db/storage-mode.ts");
const ops = await loadTypescript("lib/canvas-operations.ts", { packages: true });
const db = await loadTypescript("lib/db/service.ts");
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
after(async () => {
  await db.module.closeAllDbServices();
  for (const loaded of [legacy, catalog, store, service, agentStore, claimsModule, videoTasks, assets, mode, ops, db, repository]) await loaded.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(`${root}`.replace(/$/, ""), { recursive: true, force: true });
});
const { loadCanvas, saveCanvas, transformCanvas, listCanvases, createCanvas, deleteCanvas, loadLastCanvasId, saveLastCanvasId, commitCommandWrite } = store.module;
const { executeCommand, CommandError, listCanvasChanges } = service.module;
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const actorSeq = new Map();
const command = (canvasId, kind, payload, extra = {}) => {
  const actorId = extra.actorId ?? ACTOR;
  const key = `${canvasId}/${actorId}`;
  const s = extra.actorSeq ?? (actorSeq.get(key) ?? 0) + 1;
  if (extra.actorSeq === undefined) actorSeq.set(key, s);
  return { schemaVersion: 1, commandId: uuid(), actorId, actorSeq: s, canvasId, storageEpoch: committed.epoch, baseRevision: 0, kind, payload, ...extra };
};

test("切换后读取：画布、正文、视口、素材库（名称/来源）、旧 operation ID、最近画布与源 JSON 一致", async () => {
  assert.equal(committed.status, "committed");
  assert.equal(mode.module.readStorageState().backend, "sqlite");
  const doc = await loadCanvas("c1");
  assert.equal(doc.revision, 4);
  assert.deepEqual(doc.viewport, { x: 10, y: 20, zoom: 0.5 });
  assert.deepEqual(doc.libraryAssets, [{ assetName: "a.png", name: "封面", sources: ["generated"], addedAt: "2026-01-01T01:00:00.000Z" }]);
  assert.deepEqual(doc.appliedOperationIds, ["old-op-1"]);
  assert.equal(doc.nodes.find(n => n.id === "t1").data.content, "旧正文");
  assert.deepEqual(doc.nodes.find(n => n.id === "n1").position, { x: 0, y: 0 });
  assert.deepEqual((await listCanvases()).map(c => c.id).sort(), ["c1", "c2"]);
  assert.equal(await loadLastCanvasId(), "c1");
  // /entities 的快照（客户端取得 expectedVersion 与纪元）也必须来自 SQLite，而不是旧 JSON 的 commandState。
  const snapshot = await repository.module.loadEntitySnapshot("c1");
  assert.equal(snapshot.storageEpoch, committed.epoch);
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.documents.find(d => d.nodeId === "t1").content, "旧正文");
});

test("命令走 SQLite：新纪元成功、旧纪元 stale_epoch；旧 JSON 写入口调用计数为 0，强行调用被拒绝并计数；源 JSON hash 不变", async () => {
  const doc = await loadCanvas("c1");
  const moved = await executeCommand(command("c1", "move_nodes", { items: [{ nodeId: "n1", expectedVersion: 0, from: { x: 0, y: 0, width: 320, height: 320 }, to: { x: 50, y: 60, width: 320, height: 320 } }] }), { origin: "client" });
  assert.equal(moved.revision, doc.revision + 1);
  assert.equal(moved.storageEpoch, committed.epoch);
  assert.deepEqual((await loadCanvas("c1")).nodes.find(n => n.id === "n1").position, { x: 50, y: 60 });
  await assert.rejects(executeCommand(command("c1", "patch_nodes", { items: [{ nodeId: "n1", field: "name", expectedVersion: 0, value: "x" }] }, { storageEpoch: "json-v1", actorSeq: 99 }), { origin: "client" }), (e) => e.code === "stale_epoch");
  const replay = await executeCommand(command("c1", "patch_nodes", { items: [{ nodeId: "t1", field: "content", expectedVersion: 0, value: "新正文" }] }), { origin: "client" });
  assert.equal(replay.delta.documents[0].content, "新正文");
  assert.equal(mode.module.jsonWriteAttempts.size, 0, "所有业务写入都没有触碰旧 JSON 写函数");
  await assert.rejects(commitCommandWrite("c1", () => ({ next: null, bumpRevision: false, result: 1 })), { code: "json_readonly" });
  assert.equal(mode.module.jsonWriteAttempts.get("canvas-store.commitCommandWrite"), 1);
  assert.deepEqual(await hashes(live, LEGACY_FILES), liveBefore, "源 JSON 文件未被改写");
});

test("旧 PUT/operations 兼容：带 revision 前置条件转为条件命令；过期 revision 拒绝；服务字段被拒；画布字段写入素材库递增 revision", async () => {
  const current = await loadCanvas("c2");
  const added = await saveCanvas({ ...current, viewport: { x: 1, y: 2, zoom: 1 }, nodes: [{ id: "p1", type: "canvasText", position: { x: 5, y: 5 }, width: 300, height: 200, data: { name: "PUT 新增", content: "正文" } }] }, current.revision);
  assert.ok(added, "前置 revision 正确时接受");
  assert.deepEqual(added.viewport, { x: 1, y: 2, zoom: 1 });
  assert.equal(added.nodes[0].data.content, "正文");
  assert.equal(await saveCanvas({ ...current, nodes: [] }, current.revision), null, "过期 revision 不做整图覆盖");
  assert.equal((await loadCanvas("c2")).nodes.length, 1, "整图覆盖被拒后节点仍在");
  const base = await loadCanvas("c1");
  const op = (path, before, afterValue) => ({ id: crypto.randomUUID(), target: "canvas", path, before: before === undefined ? { exists: false } : { exists: true, value: before }, after: { exists: true, value: afterValue } });
  const library = [...base.libraryAssets, { assetName: "b.png", name: "新", sources: ["manual"], addedAt: "2026-02-01T00:00:00.000Z" }];
  const viaOps = await transformCanvas("c1", doc => ops.module.applyCanvasOperations(doc, [op(["libraryAssets"], base.libraryAssets, library)]), { access: "user" });
  assert.equal(viaOps.libraryAssets.length, 2);
  assert.equal(viaOps.revision, base.revision + 1, "素材库对其他客户端可见，revision 递增");
  const statusOp = { id: crypto.randomUUID(), target: "node", entityId: "n1", path: ["data", "status"], before: { exists: true, value: "idle" }, after: { exists: true, value: "running" } };
  await assert.rejects(transformCanvas("c1", doc => ops.module.applyCanvasOperations(doc, [statusOp]), { access: "user" }), /status|服务|不允许|只能/);
  const changes = await listCanvasChanges({ canvasId: "c1", afterRevision: base.revision });
  assert.equal(changes.events.at(-1).delta.canvasFields.libraryAssets.length, 2, "画布字段变化也有连续事件");
});

test("claims / Agent / 视频任务 / 生成来源 / 画布生命周期都只写 SQLite；维护模式阻止新生成与新命令", async () => {
  await claimsModule.module.claimGeneration("c1", "n1", "gen-x");
  assert.deepEqual((await loadCanvas("c1")).generationClaims, { n1: { id: "gen-x", state: "pending" } });
  await claimsModule.module.finishGeneration("c1", "n1", "gen-x", "unknown");
  assert.equal((await loadCanvas("c1")).generationClaims.n1.state, "unknown");
  await claimsModule.module.acknowledgeUnknownGeneration("c1", "n1", "gen-x");
  assert.equal((await loadCanvas("c1")).generationClaims, undefined);
  const state = await agentStore.module.updateAgent("c1", s => { s.conversations[0].messages.push({ id: "m2", role: "assistant", parts: [{ type: "text", text: "回复" }] }); });
  assert.equal(state.conversations[0].messages.length, 2);
  const reread = await agentStore.module.updateAgent("c1");
  assert.deepEqual(reread.conversations[0].messages.map(m => m.id), ["m1", "m2"]);
  assert.equal(reread.activeConversationId, "k1");
  const task = await videoTasks.module.createVideoTask("req-new", "c1", "n1", { prompt: "浪" }, { nodeId: "n1", id: "gen-v" });
  assert.equal((await videoTasks.module.readVideoTask(task.taskId)).requestId, "req-new");
  assert.ok((await videoTasks.module.recoverableVideoTasks()).some(t => t.taskId === task.taskId));
  await videoTasks.module.updateVideoTask(task.taskId, { status: "failed", error: "上游失败" });
  assert.equal((await videoTasks.module.readVideoTask(task.taskId)).status, "failed");
  assert.equal((await videoTasks.module.readVideoTask("t-done")).status, "completed", "导入的旧任务可读");
  await assets.module.saveGenerationRecord("z.png", { originalPrompt: "狗", submittedPrompt: "狗", model: "m", mode: "t2i", parameters: {}, referenceAssets: [], startedAt: "2026-03-01T00:00:00.000Z" });
  assert.equal((await assets.module.readGenerationRecord("z.png")).originalPrompt, "狗");
  assert.equal((await assets.module.readGenerationRecord("a.png")).originalPrompt, "猫");
  const created = await createCanvas();
  assert.ok((await listCanvases()).some(c => c.id === created.id));
  await saveLastCanvasId(created.id);
  assert.equal(await loadLastCanvasId(), created.id);
  assert.equal(await deleteCanvas(created.id), true);
  assert.equal(await loadCanvas(created.id), null);
  await assert.rejects(executeCommand(command(created.id, "rename_canvas", { expectedVersion: 0, name: "x" }), { origin: "client" }), (e) => e.code === "canvas_deleted", "删除后的画布不串库");
  assert.equal(mode.module.jsonWriteAttempts.get("canvas-store.writeCanvas") ?? 0, 0);
  assert.equal(mode.module.jsonWriteAttempts.get("agent-store.updateAgent") ?? 0, 0);
  assert.deepEqual(await hashes(live, LEGACY_FILES), liveBefore);
  assert.equal(existsSync(path.join(live, "video-tasks", `${task.taskId}.json`)), false, "新视频任务没有写进旧 JSON 目录");
  assert.equal(existsSync(path.join(live, "generations", "z.png.json")), false);
  await writeFile(path.join(live, "maintenance.json"), JSON.stringify({ reason: "测试维护", since: "now" }));
  try {
    await assert.rejects(claimsModule.module.claimGeneration("c1", "n1", "gen-y"), /维护/);
    await assert.rejects(executeCommand(command("c1", "rename_canvas", { expectedVersion: 0, name: "维护中" }), { origin: "client" }), (e) => e.code === "maintenance" && e.status === 423);
  } finally { await rm(path.join(live, "maintenance.json"), { force: true }); }
});

test("恢复：标记损坏或数据库缺失时进入恢复（503），绝不回退读旧 JSON；切换后拒绝直接回到 JSON", async () => {
  const marker = await readFile(path.join(live, "storage-state.json"), "utf8");
  try {
    await writeFile(path.join(live, "storage-state.json"), "{坏");
    await assert.rejects(loadCanvas("c1"), (e) => e.code === "storage_recovery" && e.status === 503);
    const parsed = JSON.parse(marker);
    await writeFile(path.join(live, "storage-state.json"), JSON.stringify({ ...parsed, dbFile: "db/missing.sqlite" }));
    await assert.rejects(loadCanvas("c1"), (e) => e.code === "storage_recovery");
  } finally { await writeFile(path.join(live, "storage-state.json"), marker); }
  assert.equal((await loadCanvas("c1")).id, "c1");
  assert.throws(() => refuseRollback(live), { code: "rollback_refused" });
  void CommandError; void cp;
});
