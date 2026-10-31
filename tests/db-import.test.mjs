import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 全部在临时目录：合成旧数据目录 + 独立 staging；绝不读写 ~/.grok-canvas。
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-import-"));
const importer = require("../lib/db/importer.cjs");
const { openDatabase } = require("../lib/db/driver.cjs");
const conversationsRepo = require("../lib/db/repositories/conversations.cjs");
const tasksRepo = require("../lib/db/repositories/tasks.cjs");
const controlRepo = require("../lib/db/repositories/control.cjs");
const legacy = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
const catalog = await loadTypescript("lib/db/import-catalog.ts");
const opened = [];
after(async () => {
  for (const db of opened) if (db.open) db.close();
  await legacy.dispose(); await catalog.dispose();
  await rm(root, { recursive: true, force: true });
});
const convert = { fromCanvasDoc: legacy.module.fromCanvasDoc, classifySource: catalog.module.classifySource };
const open = (dir) => { const db = openDatabase(path.join(dir, importer.DB_FILE), { busyTimeoutMs: 2000 }); opened.push(db); return db; };
const write = async (dir, rel, value) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value)); };
const hashTree = async (dir, files) => Object.fromEntries(await Promise.all(files.map(async rel => [rel, createHash("sha256").update(await readFile(path.join(dir, rel))).digest("hex")])));
const LONG = "长正文".repeat(40000);
const ACTOR = "11111111-1111-4111-8111-111111111111";
const message = (id, role = "user", text = id) => ({ id, role, parts: [{ type: "text", text }] });
const CONV1 = [...Array.from({ length: 3 }, (_, i) => message(`m${i}`)), { id: "m3", role: "assistant", parts: [{ type: "tool-add_canvas_nodes", toolCallId: "t1", state: "output-available", input: { a: 1 }, output: { ok: true } }] }];

/** 合成旧目录：2 个画布、共享物理媒体但不同归属、长正文、旧会话格式、待恢复视频、unknown claim、旧 operation IDs、auth 文件。 */
async function legacyDir(name, mutate = () => {}) {
  const dir = path.join(root, name, "source");
  const canvasA = {
    id: "canvas-a", name: "画布 A", schemaVersion: 1, revision: 7, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "img1", type: "image", position: { x: 0, y: 0 }, data: { name: "图1", prompt: "猫", status: "idle", assetName: "shared.png", aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
      { id: "txt1", type: "canvasText", position: { x: 0, y: 400 }, width: 360, height: 260, data: { name: "长文", content: LONG } },
      { id: "vid1", type: "video", position: { x: 800, y: 0 }, data: { name: "视频", prompt: "海浪", duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true, status: "running", generationId: "gen-v1", uploadInputs: [] } },
      { id: "gone1", type: "asset", position: { x: -400, y: 0 }, data: { name: "缺图", assetName: "missing.png" } },
    ],
    edges: [{ id: "e1", source: "img1", target: "vid1", type: "scissor", data: { role: "first" } }],
    libraryAssets: [{ assetName: "shared.png", name: "共享", sources: ["generated"], addedAt: "2026-01-01T01:00:00.000Z" }, { assetName: "missing.png", name: "缺", sources: ["imported"], addedAt: "2026-01-01T02:00:00.000Z" }],
    appliedOperationIds: Array.from({ length: 30 }, (_, i) => `op-a-${i}`),
    generationClaims: { vid1: { id: "gen-v1", state: "pending", taskId: "task-1" }, img1: { id: "gen-i9", state: "unknown" } },
    commandState: {
      v: 1, storageEpoch: "json-v1", eventSeq: 3, nameVersion: 2,
      nodes: { img1: { entity: 3, geometry: 2, fields: { prompt: 4 } }, txt1: { entity: 1, geometry: 0, fields: { content: 5 } } },
      edges: { e1: 1 }, tombstones: { nodes: { old9: { entity: 1, geometry: 1 } }, edges: {} },
      actors: { [ACTOR]: { acceptedSeq: 3 } },
      receipts: { "00000000-0000-4000-8000-000000000001": { hash: "h1", actorId: ACTOR, actorSeq: 3, receipt: { commandId: "00000000-0000-4000-8000-000000000001", revision: 7 } } },
      assets: { "shared.png": { kind: "image", createdAt: "2026-01-01T01:00:00.000Z", missing: false } }, documentIds: {},
    },
  };
  const canvasB = {
    id: "canvas-b", name: "画布 B", schemaVersion: 1, revision: 2, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
    // 同一 legacy nodeId（img1）出现在两个画布，按画布复合主键各自保留。
    nodes: [{ id: "img1", type: "asset", position: { x: 10, y: 10 }, data: { name: "共享素材", assetName: "shared.png" } }],
    edges: [], libraryAssets: [{ assetName: "shared.png", name: "共享", sources: ["manual"], addedAt: "2026-01-03T01:00:00.000Z" }],
  };
  const files = {
    "canvases/canvas-a.json": canvasA,
    "canvases/canvas-b.json": canvasB,
    "assets/shared.png": "PNG-共享物理文件",
    "assets/v-result.mp4": "MP4",
    "generations/shared.png.json": { schemaVersion: 1, assetName: "shared.png", savedAt: "2026-01-01T01:00:00.000Z", originalPrompt: "猫", submittedPrompt: "猫", model: "m", mode: "t2i", parameters: { aspectRatio: "1:1" }, referenceAssets: [], startedAt: "2026-01-01T00:59:00.000Z" },
    "agent/canvas-a.json": {
      id: "canvas-a", canvasId: "canvas-a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", activeConversationId: "conv-1",
      // 与 ensureConversations 一致：顶层 messages 是当前会话消息的镜像，导入时去重。
      messages: CONV1,
      conversations: [{ id: "conv-1", title: "对话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", settings: { model: "x" }, messages: CONV1 }],
    },
    // 只有顶层 messages 的旧会话格式。
    "agent/canvas-b.json": { id: "canvas-b", canvasId: "canvas-b", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", messages: Array.from({ length: 120 }, (_, i) => message(`b${i}`)) },
    "video-tasks/task-1.json": { schemaVersion: 1, taskId: "task-1", requestId: "req-upstream-1", status: "pending", canvasId: "canvas-a", nodeId: "vid1", claim: { nodeId: "vid1", id: "gen-v1" }, snapshot: { prompt: "海浪", duration: 10 }, remoteUrl: null, result: null, error: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    "app-state.json": { lastCanvasId: "canvas-b" },
    "auth.json": "{\"token\":\"不得打开\"}",
  };
  mutate(files);
  for (const [rel, value] of Object.entries(files)) if (value !== undefined) await write(dir, rel, value);
  return { dir, staging: path.join(root, name, "staging"), files: Object.keys(files).filter(k => files[k] !== undefined) };
}

test("完整导入：保留 ID/revision/版本/requestId/claims/legacy IDs/lastCanvas；正文单独 documents；缺媒体显式 missing；ready_to_switch", async () => {
  const src = await legacyDir("full");
  const before = await hashTree(src.dir, src.files);
  const opened = [];
  const report = await importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert, options: { onOpen: (rel) => opened.push(rel) } });
  assert.equal(report.status, "ready_to_switch", JSON.stringify({ blocking: report.blocking, problems: report.validation.problems }));
  assert.ok(!opened.includes("auth.json"), "auth 文件从未打开");
  assert.deepEqual(report.excluded, ["auth.json"]);
  assert.deepEqual(await hashTree(src.dir, src.files), before, "源目录文件 hash 导入前后相同");
  assert.equal(existsSync(path.join(src.staging, "storage-state.json")), false, "不写 storage-state");
  const db = open(src.staging);
  const canvas = db.prepare("select * from canvases where id = 'canvas-a'").get();
  assert.deepEqual([canvas.revision, canvas.name_version, canvas.created_at], [7, 2, "2026-01-01T00:00:00.000Z"]);
  assert.match(canvas.storage_epoch, /^sqlite-[0-9a-f]{12}$/);
  const img = db.prepare("select * from nodes where canvas_id = 'canvas-a' and id = 'img1'").get();
  assert.deepEqual([img.entity_version, img.geometry_version], [3, 2]);
  assert.equal(db.prepare("select version from node_fields where canvas_id = 'canvas-a' and node_id = 'img1' and field = 'prompt'").get().version, 4);
  const text = db.prepare("select d.content, d.version, n.data_json from documents d join nodes n on n.canvas_id = d.canvas_id and n.id = d.node_id where d.canvas_id = 'canvas-a'").get();
  assert.equal(text.content, LONG);
  assert.equal(text.version, 5);
  assert.ok(!text.data_json.includes("长正文"), "正文不在节点 data_json 中");
  assert.equal(db.prepare("select count(*) as n from nodes where id = 'img1'").get().n, 2, "同一 legacy nodeId 在两个画布各自保留");
  assert.deepEqual(db.prepare("select canvas_id, created_at from canvas_assets where asset_name = 'shared.png' order by canvas_id").all().map(r => [r.canvas_id, r.created_at]), [["canvas-a", "2026-01-01T01:00:00.000Z"], ["canvas-b", "2026-01-03T01:00:00.000Z"]], "共享物理媒体，不同画布归属");
  assert.equal(db.prepare("select count(*) as n from assets where asset_name = 'shared.png'").get().n, 1);
  assert.deepEqual(db.prepare("select status from assets where asset_name = 'missing.png'").get(), { status: "missing" });
  assert.equal(db.prepare("select missing from canvas_assets where canvas_id = 'canvas-a' and asset_name = 'missing.png'").get().missing, 1);
  assert.ok(report.missingMedia.some(m => m.assetName === "missing.png" && m.referencedBy === "canvas-a/gone1"), "缺媒体列出 assetName 与引用节点");
  assert.equal(JSON.parse(db.prepare("select data_json from nodes where canvas_id = 'canvas-a' and id = 'gone1'").get().data_json).assetName, "missing.png", "缺媒体节点保留元数据");
  assert.equal(db.prepare("select count(*) as n from legacy_operation_ids where canvas_id = 'canvas-a'").get().n, 30);
  assert.deepEqual(db.prepare("select node_id, claim_id, state, task_id from generation_claims where canvas_id = 'canvas-a' order by node_id").all(), [
    { node_id: "img1", claim_id: "gen-i9", state: "unknown", task_id: null },
    { node_id: "vid1", claim_id: "gen-v1", state: "pending", task_id: "task-1" },
  ]);
  assert.equal(tasksRepo.claimAllowsNewGeneration(db, { canvasId: "canvas-a", nodeId: "img1" }), false, "unknown claim 保留，不允许重新收费生成");
  const task = tasksRepo.getTaskRun(db, { taskId: "task-1", canvasId: "canvas-a" });
  assert.deepEqual([task.requestId, task.status, task.snapshot, task.claim], ["req-upstream-1", "pending", { prompt: "海浪", duration: 10 }, { nodeId: "vid1", id: "gen-v1" }]);
  assert.deepEqual(tasksRepo.listRecoverable(db, { canvasId: "canvas-a" }).map(t => t.taskId), ["task-1"], "待恢复视频仍可恢复");
  assert.equal(tasksRepo.getGenerationRecord(db, { assetName: "shared.png" }).snapshot.originalPrompt, "猫");
  assert.equal(controlRepo.getPreference(db, { key: "lastCanvas" }), "canvas-b");
  assert.equal(controlRepo.getPreference(db, { key: "activeConversation:canvas-a" }), "conv-1");
  assert.equal(controlRepo.getWatermark(db, { canvasId: "canvas-a", actorId: ACTOR }).acceptedSeq, 3);
  assert.equal(db.prepare("select count(*) as n from command_receipts where canvas_id = 'canvas-a'").get().n, 1);
  // 会话：新格式与顶层 messages 去重；只有顶层时生成 legacy-<canvas>；工具调用 parts 原样。
  assert.deepEqual(conversationsRepo.listConversations(db, { canvasId: "canvas-a" }).items.map(c => c.id), ["conv-1"]);
  const parts = conversationsRepo.listMessages(db, { canvasId: "canvas-a", conversationId: "conv-1" }).items[3].parts;
  assert.equal(parts[0].toolCallId, "t1");
  let ids = [], after;
  for (;;) { const page = conversationsRepo.listMessages(db, { canvasId: "canvas-b", conversationId: "legacy-canvas-b", afterOrdinal: after }); ids.push(...page.items.map(m => m.id)); if (page.nextOrdinal === null) break; after = page.nextOrdinal; }
  assert.deepEqual(ids, Array.from({ length: 120 }, (_, i) => `b${i}`));
  assert.equal(report.files["canvases/canvas-a.json"].nodeTombstones, 1, "节点墓碑以占位行导入并计数");
  const tomb = db.prepare("select deleted_at, entity_version from nodes where canvas_id = 'canvas-a' and id = 'old9'").get();
  assert.ok(tomb?.deleted_at, "墓碑占位行带 deleted_at，旧 ID 不能复活");
  assert.equal(tomb.entity_version, 1);
  assert.ok(report.validation.tables.some(t => t.source === "canvases/canvas-a.json" && t.actual.nodes === 4 && t.expected.nodesHash === t.actual.nodesHash));
  assert.deepEqual(JSON.parse(await readFile(path.join(src.staging, importer.REPORT_FILE), "utf8")).status, "ready_to_switch");
});

test("坏结构阻断且有报告：非法 JSON、断边、重复 ID、未来 schema；一个坏画布不让整体标为成功，其它画布照常导入", async () => {
  const src = await legacyDir("broken", (files) => {
    files["canvases/canvas-c.json"] = "{ 不是 json";
    files["canvases/canvas-d.json"] = { id: "canvas-d", name: "断边", schemaVersion: 1, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "n1", type: "asset", position: { x: 0, y: 0 }, data: { name: "a", assetName: "shared.png" } }], edges: [{ id: "bad", source: "n1", target: "ghost", type: "scissor", data: {} }] };
    files["canvases/canvas-e.json"] = { id: "canvas-e", name: "重复", schemaVersion: 1, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "x", type: "asset", position: { x: 0, y: 0 }, data: { name: "1" } }, { id: "x", type: "asset", position: { x: 1, y: 1 }, data: { name: "2" } }], edges: [] };
    files["canvases/canvas-f.json"] = { id: "canvas-f", name: "未来", schemaVersion: 9, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [] };
    files["video-tasks/task-bad.json"] = "{";
    files["random/notes.txt"] = "未登记";
  });
  const report = await importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert });
  assert.equal(report.status, "blocked");
  const byFile = Object.fromEntries(report.blocking.map(b => [b.file, b.code]));
  assert.deepEqual(byFile, {
    "canvases/canvas-c.json": "corrupt_json",
    "canvases/canvas-d.json": "invalid_structure",
    "canvases/canvas-e.json": "invalid_structure",
    "canvases/canvas-f.json": "unsupported_version",
    "video-tasks/task-bad.json": "corrupt_json",
    "random/notes.txt": "unknown_source",
  });
  const db = open(src.staging);
  assert.deepEqual(db.prepare("select id from canvases order by id").all().map(r => r.id), ["canvas-a", "canvas-b"], "坏画布不写任何部分实体");
  assert.equal(db.prepare("select count(*) as n from nodes where canvas_id in ('canvas-d', 'canvas-e')").get().n, 0);
  assert.equal(db.prepare("select status from import_runs").get().status, "failed");
  assert.match(report.blocking.find(b => b.file === "canvases/canvas-d.json").detail, /dangling_edge/);
});

test("中间批次中断再跑：数量/hash 与一次完成相同，节点/消息不重复；源文件变化导致续跑拒绝，reset 后重新准备", async () => {
  const reference = await legacyDir("reference");
  const once = await importer.runImport({ sourceDir: reference.dir, stagingDir: reference.staging, convert });
  const src = await legacyDir("resume");
  await assert.rejects(importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert, options: { failAfterUnits: 3 } }), { code: "interrupted" });
  const mid = open(src.staging);
  const run = mid.prepare("select status, cursor from import_runs").get();
  assert.deepEqual([run.status, run.cursor], ["running", "2"], "cursor 与已提交单元一致");
  mid.close();
  await assert.rejects(importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert, options: { failAfterUnits: 2 } }), { code: "interrupted" });
  const resumed = await importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert });
  assert.equal(resumed.status, "ready_to_switch");
  const strip = (r) => r.validation.tables.map(t => ({ source: t.source, actual: t.actual }));
  assert.deepEqual(strip(resumed), strip(once), "续跑结果与一次导入的数量/hash 完全一致");
  const db = open(src.staging);
  assert.equal(db.prepare("select count(*) as n from agent_messages").get().n, 124);
  assert.equal(db.prepare("select count(*) as n from nodes where deleted_at is null").get().n, 5);
  assert.equal(db.prepare("select count(*) as n from nodes where deleted_at is not null").get().n, 1, "墓碑占位行续跑不重复");
  db.close();
  assert.equal((await importer.runImport({ sourceDir: src.dir, stagingDir: src.staging, convert })).status, "ready_to_switch", "已完成的运行再跑直接返回报告");

  const changing = await legacyDir("changed");
  await assert.rejects(importer.runImport({ sourceDir: changing.dir, stagingDir: changing.staging, convert, options: { failAfterUnits: 2 } }), { code: "interrupted" });
  await write(changing.dir, "canvases/canvas-b.json", { id: "canvas-b", name: "改过", schemaVersion: 1, revision: 3, createdAt: "2026-01-03T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] });
  await assert.rejects(importer.runImport({ sourceDir: changing.dir, stagingDir: changing.staging, convert }), { code: "source_changed" });
  const fresh = await importer.runImport({ sourceDir: changing.dir, stagingDir: changing.staging, convert, reset: true });
  assert.equal(fresh.status, "ready_to_switch");
  const after = open(changing.staging);
  assert.equal(after.prepare("select name from canvases where id = 'canvas-b'").get().name, "改过");
  assert.equal(after.prepare("select count(*) as n from import_runs").get().n, 1, "reset 后只有新运行");
});

test("路径保护：拒绝 staging 等于/包含/位于源目录、未指定目录、已切换的目标；dry-run 不写文件", async () => {
  const src = await legacyDir("paths");
  for (const stagingDir of [src.dir, path.join(src.dir, "staging"), path.dirname(src.dir)]) {
    await assert.rejects(importer.runImport({ sourceDir: src.dir, stagingDir, convert }), { code: "invalid_request" }, stagingDir);
  }
  await assert.rejects(importer.runImport({ sourceDir: src.dir, stagingDir: undefined, convert }), { code: "invalid_request" });
  await assert.rejects(importer.runImport({ sourceDir: "relative/dir", stagingDir: src.staging, convert }), { code: "invalid_request" });
  const switched = path.join(root, "paths", "switched");
  await write(switched, "storage-state.json", { version: 1, backend: "sqlite" });
  await assert.rejects(importer.runImport({ sourceDir: src.dir, stagingDir: switched, convert }), { code: "invalid_request" });
  const dry = await importer.dryRun({ sourceDir: src.dir, convert });
  assert.equal(dry.mode, "dry-run");
  assert.deepEqual(dry.excluded, ["auth.json"]);
  assert.equal(dry.counts.canvas, 2);
  assert.equal(existsSync(src.staging), false, "dry-run 不创建 staging");
});

test("CLI：默认 dry-run；显式 --staging 才导入；Worker import.status 读取进度；test:db 已登记", async () => {
  const src = await legacyDir("cli");
  const cli = (args) => spawnSync(process.execPath, [path.join(repoRoot, "scripts", "workstation-migrate.mjs"), ...args], { encoding: "utf8", cwd: repoRoot, timeout: 60_000 });
  const dry = cli([`--source=${src.dir}`]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).mode, "dry-run");
  assert.equal(existsSync(src.staging), false);
  const usage = cli([]);
  assert.equal(usage.status, 2);
  const real = cli([`--source=${src.dir}`, `--staging=${src.staging}`]);
  assert.equal(real.status, 0, real.stderr + real.stdout);
  assert.equal(JSON.parse(real.stdout).status, "ready_to_switch");
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(path.join(repoRoot, "lib", "db", "worker.cjs"), { workerData: { file: path.join(src.staging, importer.DB_FILE), busyTimeoutMs: 2000 } });
  try {
    const status = await new Promise((resolve, reject) => { worker.once("message", m => m.ok ? resolve(m.result) : reject(new Error(m.error.message))); worker.postMessage({ requestId: "1", op: "maintenance", args: { action: "import.status" } }); });
    assert.equal(status.status, "verified");
    assert.equal(status.unitsDone, status.unitsTotal);
  } finally { await worker.terminate(); }
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:db"], /db-import\.test\.mjs/);
});
