import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const { openDatabase } = require("../lib/db/driver.cjs");
const { migrate } = require("../lib/db/migrate.cjs");
const canvasRepo = require("../lib/db/repositories/canvas.cjs");
const tasks = require("../lib/db/repositories/tasks.cjs");
const conversations = require("../lib/db/repositories/conversations.cjs");
const control = require("../lib/db/repositories/control.cjs");
const catalogModule = await loadTypescript("lib/db/import-catalog.ts");
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-db-runtime-"));
after(async () => { await catalogModule.dispose(); await rm(dir, { recursive: true, force: true }); });
const { IMPORT_CATALOG, classifySource, sourceOutcome } = catalogModule.module;
let files = 0;
const fresh = () => {
  const db = openDatabase(path.join(dir, `r-${++files}.sqlite`), { busyTimeoutMs: 2000 });
  migrate(db);
  for (const id of ["A", "B"]) canvasRepo.putCanvas(db, { canvas: { id, name: id, createdAt: "2026-10-30T00:00:00.000Z" }, nodes: [], documents: [], edges: [], fieldVersions: {} });
  return db;
};
const code = (fn, expected) => assert.throws(fn, (error) => { assert.equal(error.code, expected, `${error.code}: ${error.message}`); return true; });
const task = (taskId, status, extra = {}) => ({ schemaVersion: 1, taskId, requestId: `req-${taskId}`, status, canvasId: "A", nodeId: "v", claim: { nodeId: "v", id: "11111111-1111-4111-8111-111111111111" }, snapshot: { prompt: "p", inputs: [{ role: "first", assetName: "a.png" }], parameters: { duration: 6 } }, remoteUrl: status === "save_failed" ? "https://upstream.example/x.mp4" : null, result: status === "completed" ? { assetName: "out.mp4", localUrl: "/api/assets/out.mp4", bytes: 9 } : null, error: null, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:01:00.000Z", ...extra });

test("迁移 002：C5 剩余表全部存在", () => {
  const db = fresh();
  const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(r => r.name));
  for (const name of ["generation_records", "agent_conversations", "agent_messages", "task_runs", "tool_calls", "generation_claims", "edit_leases", "canvas_events", "command_receipts", "actor_watermarks", "legacy_operation_ids", "workspace_preferences", "import_runs", "backup_manifests"]) assert.ok(tables.has(name), name);
  db.close();
});

test("视频任务：pending / save_failed / 已完成但 claim 未释放 三类可恢复；requestId/snapshot/remoteUrl 完整往返；错画布查不到", () => {
  const db = fresh();
  const records = [task("t1", "pending"), task("t2", "save_failed"), task("t3", "completed", { claimReleased: false }), task("t4", "completed", { claimReleased: true }), task("t5", "failed")];
  for (const record of records) tasks.putTaskRun(db, record);
  assert.deepEqual(tasks.listRecoverable(db, { canvasId: "A" }).map(r => r.taskId).sort(), ["t1", "t2", "t3"]);
  for (const record of records) assert.deepEqual(tasks.getTaskRun(db, { canvasId: "A", taskId: record.taskId }), record, `${record.taskId} 往返一致`);
  assert.equal(tasks.getTaskRun(db, { canvasId: "B", taskId: "t1" }), null, "不能用全局 taskId 绕过画布归属");
  code(() => tasks.getTaskRun(db, { taskId: "t1" }), "invalid_request");
  db.close();
});

test("生成记录不可变：相同快照幂等；不同快照拒绝且保留原记录", () => {
  const db = fresh();
  const snapshot = { originalPrompt: "猫", submittedPrompt: "猫", model: "m", mode: "t2i", parameters: { aspectRatio: null, resolution: "1k", quality: "low" }, referenceAssets: [], startedAt: "2026-10-30T00:00:00.000Z" };
  assert.equal(tasks.putGenerationRecord(db, { assetName: "g.png", schemaVersion: 1, snapshot, savedAt: "2026-10-30T00:00:01.000Z" }).status, "inserted");
  assert.equal(tasks.putGenerationRecord(db, { assetName: "g.png", schemaVersion: 1, snapshot: { ...snapshot }, savedAt: "2026-10-30T00:00:02.000Z" }).status, "unchanged");
  code(() => tasks.putGenerationRecord(db, { assetName: "g.png", schemaVersion: 1, snapshot: { ...snapshot, originalPrompt: "狗" }, savedAt: "x" }), "generation_record_conflict");
  assert.equal(tasks.getGenerationRecord(db, { assetName: "g.png" }).snapshot.originalPrompt, "猫");
  db.close();
});

test("claims/leases：token、过期与 unknown 状态保留；unknown 不允许重新收费生成", () => {
  const db = fresh();
  tasks.putClaim(db, { canvasId: "A", nodeId: "n", claimId: "c1", state: "unknown", taskId: null, expiresAt: null });
  tasks.putClaim(db, { canvasId: "A", nodeId: "m", claimId: "c2", state: "pending", taskId: "t1", expiresAt: "2026-10-30T00:05:00.000Z" });
  assert.deepEqual(tasks.getClaim(db, { canvasId: "A", nodeId: "n" }), { canvasId: "A", nodeId: "n", claimId: "c1", state: "unknown", taskId: null, expiresAt: null });
  assert.equal(tasks.claimAllowsNewGeneration(db, { canvasId: "A", nodeId: "n" }), false, "unknown 需用户确认后才能重新生成");
  assert.equal(tasks.claimAllowsNewGeneration(db, { canvasId: "A", nodeId: "m" }), false);
  assert.equal(tasks.claimAllowsNewGeneration(db, { canvasId: "A", nodeId: "free" }), true);
  assert.equal(tasks.getClaim(db, { canvasId: "B", nodeId: "n" }), null);
  tasks.putLease(db, { canvasId: "A", nodeId: "n", field: "content", owner: "actor", token: "tok", expiresAt: "2026-10-30T00:00:04.000Z" });
  assert.equal(tasks.getLease(db, { canvasId: "A", nodeId: "n", field: "content" }).token, "tok");
  db.close();
});

test("会话：按稳定 ordinal 每页 50 条；parts 原样保存工具调用/结果；旧 AgentState 顶层消息与会话去重", () => {
  const db = fresh();
  const toolPart = { type: "tool-add_canvas_nodes", toolCallId: "call-1", state: "output-available", input: { nodes: [{ type: "image" }] }, output: { nodes: [{ id: "n1" }] } };
  const messages = Array.from({ length: 123 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", parts: i % 2 ? [{ type: "text", text: `回答 ${i}` }, toolPart] : [{ type: "text", text: `问题 ${i}` }] }));
  conversations.putConversation(db, { canvasId: "A", conversation: { id: "c1", title: "会话", settings: { model: "grok" }, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T01:00:00.000Z" }, messages });
  const seen = [];
  let after = undefined;
  do {
    const page = conversations.listMessages(db, { canvasId: "A", conversationId: "c1", afterOrdinal: after, limit: 50 });
    assert.ok(page.items.length <= 50);
    seen.push(...page.items);
    after = page.nextOrdinal;
  } while (after !== null);
  assert.deepEqual(seen.map(m => m.id), messages.map(m => m.id), "消息 ID 与顺序保持");
  assert.deepEqual(seen[1].parts, messages[1].parts, "工具调用与结果在同一消息中原样保存，分页不拆分");
  code(() => conversations.listMessages(db, { canvasId: "A", conversationId: "c1", limit: 51 }), "invalid_request");
  assert.deepEqual(conversations.listMessages(db, { canvasId: "B", conversationId: "c1", limit: 10 }).items, [], "错画布访问为空");
  const legacy = { id: "A", canvasId: "A", messages: messages.slice(0, 4), conversations: [{ id: "c2", title: "旧", createdAt: "x", updatedAt: "y", settings: {}, messages: messages.slice(0, 4) }], activeConversationId: "c2", createdAt: "x", updatedAt: "y" };
  assert.deepEqual(conversations.conversationsFromAgentState(legacy).map(c => [c.conversation.id, c.messages.length]), [["c2", 4]], "顶层消息与活动会话相同只导入一份");
  const divergent = { ...legacy, messages: messages.slice(0, 2), conversations: [] };
  assert.deepEqual(conversations.conversationsFromAgentState(divergent).map(c => [c.conversation.id, c.messages.length]), [["legacy-A", 2]], "只有顶层消息时生成一个确定 ID 的旧会话");
  db.close();
});

test("控制记录：回执、事件分页、水位、旧 operationId 全量保存、偏好拒绝 auth 键、导入运行与备份清单", () => {
  const db = fresh();
  control.putReceipt(db, { commandId: "cmd-1", canvasId: "A", actorId: "u", actorSeq: 1, requestHash: "h", receipt: { revision: 1 } });
  code(() => control.putReceipt(db, { commandId: "cmd-2", canvasId: "A", actorId: "u", actorSeq: 1, requestHash: "h2", receipt: {} }), "SQLITE_CONSTRAINT_UNIQUE");
  assert.deepEqual(control.getReceipt(db, { commandId: "cmd-1" }).receipt, { revision: 1 });
  for (let i = 1; i <= 7; i++) control.appendEvent(db, { canvasId: "A", eventSeq: i, revision: i, commandId: `cmd-${i}`, delta: { i } });
  assert.deepEqual(control.listEvents(db, { canvasId: "A", afterSeq: 2, limit: 3 }).items.map(e => e.eventSeq), [3, 4, 5]);
  control.putWatermark(db, { canvasId: "A", actorId: "u", acceptedSeq: 3, ackSeq: 2, retiredBefore: 0, storageEpoch: "sql-v1" });
  assert.equal(control.getWatermark(db, { canvasId: "A", actorId: "u" }).acceptedSeq, 3);
  const ids = Array.from({ length: 2500 }, (_, i) => `op-${i}`);
  assert.equal(control.recordLegacyOperationIds(db, { canvasId: "A", operationIds: ids }), 2500);
  assert.equal(control.recordLegacyOperationIds(db, { canvasId: "A", operationIds: ids.slice(0, 10) }), 0, "重复记录幂等");
  assert.equal(control.hasLegacyOperationId(db, { canvasId: "A", operationId: "op-2499" }), true);
  assert.equal(control.hasLegacyOperationId(db, { canvasId: "B", operationId: "op-1" }), false);
  control.setPreference(db, { key: "lastCanvas", value: "A" });
  control.setPreference(db, { key: "camera:A", value: { x: 1, y: 2, zoom: 0.5 } });
  assert.deepEqual(control.getPreference(db, { key: "camera:A" }), { x: 1, y: 2, zoom: 0.5 });
  for (const key of ["auth", "oauth:token", "authToken"]) code(() => control.setPreference(db, { key, value: "x" }), "invalid_request");
  control.startImportRun(db, { id: "run-1", sourceDigest: "d" });
  control.updateImportRun(db, { id: "run-1", status: "running", cursor: "canvases/A.json", report: { ok: 1 } });
  assert.equal(control.getImportRun(db, { id: "run-1" }).cursor, "canvases/A.json");
  control.putBackupManifest(db, { id: "b1", revisionManifest: { A: 3 }, mediaManifest: [], status: "complete" });
  assert.equal(control.getBackupManifest(db, { id: "b1" }).status, "complete");
  db.close();
});

test("导入目录：源路径 → 表 → 校验，canvases/agent/studio/video-tasks/generations/app-state/assets 一个不漏；auth 排除；缺失与损坏是两种结果", () => {
  const kinds = new Set(IMPORT_CATALOG.map(entry => entry.kind));
  for (const kind of ["canvas", "agent", "studio", "video-task", "generation", "app-state", "asset", "auth"]) assert.ok(kinds.has(kind), kind);
  for (const entry of IMPORT_CATALOG.filter(e => !e.excluded)) {
    assert.ok(entry.tables.length && entry.idTransform && entry.checksum && entry.onMissing && entry.onCorrupt, entry.kind);
    assert.notEqual(entry.onMissing, entry.onCorrupt, `${entry.kind} 缺失与损坏不可混淆`);
  }
  assert.equal(classifySource("canvases/abc.json").kind, "canvas");
  assert.equal(classifySource("agent/abc.json").kind, "agent");
  assert.equal(classifySource("video-tasks/t-1.json").kind, "video-task");
  assert.equal(classifySource("generations/x.png.json").kind, "generation");
  assert.equal(classifySource("assets/x.png").kind, "asset");
  assert.equal(classifySource("app-state.json").kind, "app-state");
  assert.equal(classifySource("auth.json").excluded, true, "OAuth/auth 不迁移");
  assert.equal(classifySource("random/thing.bin").kind, "unknown", "未登记路径报告 unknown，不静默跳过");
  assert.equal(sourceOutcome({ exists: false }), "missing");
  assert.equal(sourceOutcome({ exists: true, parse: () => { throw new SyntaxError("bad"); } }), "corrupt");
  assert.equal(sourceOutcome({ exists: true, parse: () => ({ schemaVersion: 99 }), supportedVersions: [1] }), "unsupported_version");
  assert.equal(sourceOutcome({ exists: true, parse: () => ({ schemaVersion: 1 }), supportedVersions: [1] }), "ok");
});

test("Worker 派发 tasks.* / conversations.* / control.*", async () => {
  const loaded = await loadTypescript("lib/db/service.ts");
  try {
    const db = loaded.module.getDbService({ file: path.join(dir, "worker-runtime.sqlite"), workerPath: path.join(root, "lib", "db", "worker.cjs") });
    await db.request("migrate", {});
    await db.request("command", { repository: "canvas.put", params: { canvas: { id: "A", name: "A", createdAt: "x" }, nodes: [], documents: [], edges: [], fieldVersions: {} } });
    await db.request("command", { repository: "tasks.putTaskRun", params: task("t1", "pending") });
    assert.equal((await db.request("query", { repository: "tasks.getTaskRun", params: { canvasId: "A", taskId: "t1" } })).requestId, "req-t1");
    await db.request("command", { repository: "control.setPreference", params: { key: "lastCanvas", value: "A" } });
    assert.equal(await db.request("query", { repository: "control.getPreference", params: { key: "lastCanvas" } }), "A");
    await db.close();
  } finally { await loaded.module.closeAllDbServices(); await loaded.dispose(); }
});
