import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P5-04：中断后的工具状态收敛、收费请求不重发、删除的画布不复活。
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-run-recovery-"));
process.env.GROK_CANVAS_DATA_DIR = dir;
const recovery = await loadTypescript("lib/agent/run-recovery.ts", { packages: true });
const execution = await loadTypescript("lib/agent/execution.ts");
const agent = await loadTypescript("lib/agent/agent.ts", { packages: true });
const store = await loadTypescript("lib/canvas-store.ts");
const events = await loadTypescript("lib/agent/events.ts", { packages: true });
after(async () => { for (const l of [recovery, execution, agent, store, events]) await l.dispose(); await rm(dir, { recursive: true, force: true }); });
const { settleStale, recoverToolCalls } = recovery.module;
const { transitionTool } = execution.module;
const { saveToolRecord, listToolRecords } = events.module;
async function drain(iterable) { let last; for await (const value of iterable) last = value; return last; }

test("过期中间态：executing → unknown（不重发）；执行前 → failed；正在本进程执行的与终态不动", () => {
  const at = (phase, toolCallId, minutesAgo) => ({ ...transitionTool(null, { runId: "r", toolCallId, canvasId: "c", tool: "generate_video" }, "validating"), phase, updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
  const records = [at("executing", "a", 5), at("validating", "b", 5), at("executing", "live", 5), at("committed", "done", 5), at("executing", "fresh", 0)];
  const changed = settleStale(records, { isLive: r => r.toolCallId === "live" });
  assert.deepEqual(changed.map(r => [r.toolCallId, r.phase]), [["a", "unknown"], ["b", "failed"]]);
  assert.match(changed[0].error, /不会自动重发/);
});

test("读取即恢复且幂等：第二次读取不再改写", async () => {
  const stale = { ...transitionTool(null, { runId: "r", toolCallId: "s1", canvasId: "rc", tool: "generate_image" }, "validating"), updatedAt: new Date(Date.now() - 600_000).toISOString() };
  await saveToolRecord({ ...transitionTool(stale, stale, "executing"), updatedAt: stale.updatedAt });
  const first = await recoverToolCalls("rc");
  assert.equal(first.find(r => r.toolCallId === "s1").phase, "unknown");
  const before = JSON.stringify(await listToolRecords("rc"));
  await recoverToolCalls("rc");
  assert.equal(JSON.stringify(await listToolRecords("rc")), before);
});

test("视频提交后断网：工具记为 unknown，之后反复重试 10 次收费 POST 仍只有 1 次", async () => {
  const doc = await store.module.createCanvas();
  const tools = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:9", "conv-v");
  const added = await drain(tools.add_canvas_nodes.execute({ nodes: [{ type: "video", name: "成片", prompt: "海边日落" }] }, { toolCallId: "v-add", messages: [] }));
  const nodeId = added.nodes[0].id;
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/generate/video") && init?.method === "POST") { posts++; throw new TypeError("fetch failed: socket hang up"); }
    throw new Error(`unexpected ${url}`);
  };
  try {
    await assert.rejects(drain(tools.generate_video.execute({ nodeId }, { toolCallId: "v-gen", messages: [] })), /socket hang up/);
    for (let i = 0; i < 10; i++) await drain(tools.generate_video.execute({ nodeId }, { toolCallId: `v-retry-${i}`, messages: [] })).catch(() => {});
  } finally { globalThis.fetch = realFetch; }
  assert.equal(posts, 1, "已提交但结果不明的任务不会被重新提交");
  const records = await listToolRecords(doc.id);
  assert.equal(records.find(r => r.toolCallId === "v-gen").phase, "unknown");
  assert.ok(records.filter(r => r.toolCallId.startsWith("v-retry-")).every(r => r.phase !== "committed"));
  const saved = await store.module.loadCanvas(doc.id);
  assert.equal(saved.generationClaims?.[nodeId]?.state, "unknown", "占用保持 unknown，需要用户确认");
});

test("画布删除后迟到的工具写入不重建画布", async () => {
  const doc = await store.module.createCanvas();
  const tools = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:9", "conv-d");
  await store.module.deleteCanvas(doc.id);
  await assert.rejects(drain(tools.add_canvas_nodes.execute({ nodes: [{ type: "canvasText", name: "迟到", prompt: "" }] }, { toolCallId: "late", messages: [] })));
  assert.equal(await store.module.loadCanvas(doc.id), null);
});
