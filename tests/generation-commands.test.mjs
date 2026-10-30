import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 独立临时数据目录：绝不读写真实 ~/.grok-canvas。
const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-generation-commands-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const store = await loadTypescript("lib/canvas-store.ts");
const commands = await loadTypescript("lib/canvas-runtime/generation-commands.ts", { packages: true });
const claims = await loadTypescript("lib/generation-claims.ts");
const leases = await loadTypescript("lib/canvas-runtime/lease-service.ts");
after(async () => {
  for (const m of [store, commands, claims, leases]) await m.dispose();
  await rm(dataDir, { recursive: true, force: true });
});
const { createCanvas, loadCanvas, transformCanvas, deleteCanvas } = store.module;
const { applyServiceWrite, agentEditNodes, AGENT_ACTOR_ID, ServiceWriteError } = commands.module;
const { claimGeneration } = claims.module;
const { getLeaseService } = leases.module;

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
async function asset(name, withRecord = true) {
  await mkdir(path.join(dataDir, "assets"), { recursive: true });
  await writeFile(path.join(dataDir, "assets", name), "x");
  if (withRecord) {
    await mkdir(path.join(dataDir, "generations"), { recursive: true });
    await writeFile(path.join(dataDir, "generations", `${name}.json`), JSON.stringify({ schemaVersion: 1, assetName: name, savedAt: new Date().toISOString(), originalPrompt: "p", submittedPrompt: "p", model: "m", mode: "t2i", parameters: { aspectRatio: null, resolution: null, quality: "low" }, referenceAssets: [], startedAt: new Date().toISOString() }));
  }
}
const imageNode = (id, generationId) => ({ id, type: "image", position: { x: 0, y: 0 }, data: { name: "图片", prompt: "p", aspectRatio: "auto", resolution: "1k", quality: "low", generationCount: 1, uploadAttachments: [], status: "running", generationId, assetName: null, sourceNodeId: null } });
async function canvasWith(nodes) {
  const doc = await createCanvas();
  await transformCanvas(doc.id, d => ({ ...d, nodes }));
  return doc.id;
}
const outcome = (generationId, name) => ({ kind: "result", generationId, retrySlotId: null, prompt: "p", slots: [{ status: "success", asset: { name } }] });

test("A 发起生成后切到 B，结果只写 A；素材登记到 A 的素材库", async () => {
  await asset("a1.png");
  const a = await canvasWith([imageNode("n", G1)]);
  const b = await canvasWith([imageNode("n", G1)]);
  const result = await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "a1.png") });
  assert.equal(result.status, "applied");
  const savedA = await loadCanvas(a), savedB = await loadCanvas(b);
  assert.equal(savedA.nodes[0].data.assetName, "a1.png");
  assert.equal(savedA.nodes[0].data.status, "idle");
  assert.ok(savedA.libraryAssets.some(item => item.assetName === "a1.png"));
  assert.equal(savedB.nodes[0].data.assetName, null, "B 不受影响");
});

test("A 的节点已删：素材登记保留、节点不复活，返回 orphan", async () => {
  await asset("a2.png");
  const a = await canvasWith([imageNode("n", G1)]);
  await transformCanvas(a, d => ({ ...d, nodes: [] }));
  const result = await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "a2.png") });
  assert.equal(result.status, "orphan");
  const saved = await loadCanvas(a);
  assert.equal(saved.nodes.length, 0, "不复活节点");
  assert.ok(saved.commandState.assets["a2.png"], "素材在命令状态中登记");
  assert.ok(saved.libraryAssets.some(item => item.assetName === "a2.png"), "画布素材库保留可追溯结果");
});

test("G1 结果晚于 G2：不覆盖 G2 的状态与结果，但 G1 素材仍可追溯", async () => {
  await asset("late.png");
  const a = await canvasWith([imageNode("n", G2)]);
  const result = await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "late.png") });
  assert.equal(result.status, "unchanged");
  const saved = await loadCanvas(a);
  assert.equal(saved.nodes[0].data.generationId, G2);
  assert.equal(saved.nodes[0].data.status, "running");
  assert.equal(saved.nodes[0].data.assetName, null);
  assert.ok(saved.commandState.assets["late.png"]);
});

test("同一结果重复登记：第二次不改节点，修订号不再增长", async () => {
  await asset("twice.png");
  const a = await canvasWith([imageNode("n", G1)]);
  await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "twice.png") });
  const revision = (await loadCanvas(a)).revision;
  const again = await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "twice.png") });
  assert.notEqual(again.status, "applied");
  assert.equal((await loadCanvas(a)).revision, revision);
});

test("A 画布已删：返回 canvas_deleted，不重建画布", async () => {
  await asset("gone.png");
  const a = await canvasWith([imageNode("n", G1)]);
  assert.equal(await deleteCanvas(a), true);
  const result = await applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "gone.png") });
  assert.equal(result.status, "canvas_deleted");
  assert.equal(await loadCanvas(a), null);
});

test("伪造成功：素材没有服务端生成记录或文件不存在时拒绝，不写节点", async () => {
  await asset("forged.png", false);
  const a = await canvasWith([imageNode("n", G1)]);
  await assert.rejects(applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "forged.png") }), (error) => error instanceof ServiceWriteError && /生成记录/.test(error.message));
  await assert.rejects(applyServiceWrite(a, { action: "image", nodeId: "n", outcome: outcome(G1, "missing.png") }), /素材不存在/);
  assert.equal((await loadCanvas(a)).nodes[0].data.assetName, null);
});

test("视频结果由服务端读取任务记录生成；mp4 不进图片素材库；旧任务不覆盖新任务", async () => {
  const a = await canvasWith([{ id: "v", type: "video", position: { x: 0, y: 0 }, data: { name: "视频", prompt: "p", duration: 6, aspectRatio: "16:9", resolution: "720p", audio: false, uploadInputs: [], status: "running", generationId: G1, assetName: null, sourceNodeId: null } }]);
  await mkdir(path.join(dataDir, "video-tasks"), { recursive: true });
  const task = (taskId, generationId, assetName) => ({ schemaVersion: 1, taskId, requestId: "r", status: "completed", canvasId: a, nodeId: "v", claim: { nodeId: "v", id: generationId }, snapshot: {}, remoteUrl: null, result: { assetName, localUrl: `/api/assets/${assetName}`, bytes: 10 }, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(path.join(dataDir, "video-tasks", "t-new.json"), JSON.stringify(task("t-new", G1, "clip.mp4")));
  await writeFile(path.join(dataDir, "video-tasks", "t-old.json"), JSON.stringify(task("t-old", G2, "old.mp4")));
  const applied = await applyServiceWrite(a, { action: "video", nodeId: "v", taskId: "t-new" });
  assert.equal(applied.status, "applied");
  let saved = await loadCanvas(a);
  assert.equal(saved.nodes[0].data.assetName, "clip.mp4");
  assert.ok(!(saved.libraryAssets ?? []).some(item => item.assetName.endsWith(".mp4")));
  const stale = await applyServiceWrite(a, { action: "video", nodeId: "v", taskId: "t-old" });
  assert.equal(stale.status, "unchanged");
  saved = await loadCanvas(a);
  assert.equal(saved.nodes[0].data.assetName, "clip.mp4", "旧任务不覆盖新任务");
});

test("生成开始需要同 ID 的待定占用；只允许状态与请求快照字段", async () => {
  const a = await canvasWith([{ ...imageNode("n", null), data: { ...imageNode("n", null).data, status: "idle" } }]);
  const start = { action: "start", nodeId: "n", generationId: G1, patch: { status: "running", generationId: G1, errorMessage: null } };
  assert.equal((await applyServiceWrite(a, start)).status, "unchanged", "没有占用不能开始");
  await claimGeneration(a, "n", G1);
  assert.equal((await applyServiceWrite(a, start)).status, "applied");
  assert.equal((await loadCanvas(a)).nodes[0].data.status, "running");
  await assert.rejects(applyServiceWrite(a, { ...start, patch: { ...start.patch, assetName: "x.png" } }), /只能写状态/);
});

test("Agent 编辑：用户持有正文租约时拒绝改正文，不同字段照常合并", async () => {
  const a = await canvasWith([{ id: "t", type: "canvasText", position: { x: 0, y: 0 }, width: 360, height: 260, data: { name: "文本", content: "用户写的" } }]);
  getLeaseService().acquire(a, "t", "content", "user-actor");
  await assert.rejects(agentEditNodes(a, { updates: [{ id: "t", content: "Agent 改的" }], remove: [], connect: [], disconnect: [] }, { maxTextWidth: 560, maxTextHeight: 1120 }), (error) => error.status === 409 && /正在编辑/.test(error.message));
  await agentEditNodes(a, { updates: [{ id: "t", name: "Agent 改名", x: 40 }], remove: [], connect: [], disconnect: [] }, { maxTextWidth: 560, maxTextHeight: 1120 });
  const saved = await loadCanvas(a);
  assert.equal(saved.nodes[0].data.content, "用户写的");
  assert.equal(saved.nodes[0].data.name, "Agent 改名");
  assert.equal(saved.nodes[0].position.x, 40);
  assert.ok(saved.commandState.actors[AGENT_ACTOR_ID].acceptedSeq >= 1, "Agent 写入有独立 actor 序号");
});

test("后台写入路径不再整图 GET/diff：canvas-persistence 与 Agent 工具不引用 diffCanvasOperations / mutateCanvas", async () => {
  const persistence = await readFile(new URL("../lib/canvas-persistence.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../lib/agent/agent.ts", import.meta.url), "utf8");
  const flow = await readFile(new URL("../components/canvas/flow-canvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(persistence, /diffCanvasOperations|\/operations/);
  assert.doesNotMatch(agent, /mutateCanvas/);
  assert.doesNotMatch(flow, /legacyServiceWrites/, "客户端不再写 service 字段");
  assert.match(flow, /serviceWrite\(\{ action: "image"/);
});
