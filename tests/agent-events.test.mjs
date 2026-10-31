import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P5-01：工具状态机、执行包装器（preliminary 阶段 + 持久记录）与稳定节点 ID。
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-agent-events-"));
process.env.GROK_CANVAS_DATA_DIR = dir;
const execution = await loadTypescript("lib/agent/execution.ts");
const events = await loadTypescript("lib/agent/events.ts", { packages: true });
const agent = await loadTypescript("lib/agent/agent.ts", { packages: true });
const store = await loadTypescript("lib/canvas-store.ts");
after(async () => { for (const l of [execution, events, agent, store]) await l.dispose(); await rm(dir, { recursive: true, force: true }); });
const { transitionTool, canTransition, terminalFor, ToolTransitionError, TERMINAL_PHASES } = execution.module;
const { withExecution, listToolRecords, markUnknown } = events.module;

const id = { runId: "run-1", toolCallId: "call-1", canvasId: "c1", tool: "add_canvas_nodes" };
async function drain(iterable) { const seen = []; for await (const value of iterable) seen.push(value); return seen; }

test("状态机：正常链路与终态分支；非法回退拒绝；重复终态是无副作用重复", () => {
  let r = transitionTool(null, id, "input-streaming");
  for (const phase of ["validating", "queued", "executing", "committed"]) r = transitionTool(r, id, phase);
  assert.equal(r.phase, "committed");
  assert.equal(r.eventSeq, 5);
  assert.throws(() => transitionTool(r, id, "executing"), ToolTransitionError, "committed → executing 拒绝");
  assert.equal(transitionTool(r, id, "committed"), null, "重复终态不产生新记录");
  for (const terminal of ["blocked", "failed", "cancelled", "unknown"]) assert.ok(canTransition("executing", terminal));
  assert.equal(canTransition("validating", "unknown"), false, "未执行不可能 unknown");
  assert.equal(canTransition("validating", "committed"), false, "committed 只能来自执行");
  assert.equal(TERMINAL_PHASES.size, 5);
});

test("计数只来自实际处理数：没有 total 就没有百分比字段；completed 不超过 total", () => {
  const r = transitionTool(null, id, "validating", { completed: 3 });
  assert.equal(r.completed, 3);
  assert.equal("total" in r, false);
  assert.equal(Object.keys(r).some(k => /percent/i.test(k)), false);
  assert.throws(() => transitionTool(null, id, "validating", { completed: 5, total: 4 }));
});

test("错误归类：租约/冲突 blocked；已提交的收费请求 unknown；中止且未提交 cancelled；其余 failed", () => {
  assert.equal(terminalFor(Object.assign(new Error("x"), { status: 423 }), false), "blocked");
  assert.equal(terminalFor(markUnknown(new Error("断网")), true), "unknown", "已提交的优先于中止");
  assert.equal(terminalFor(new Error("x"), true), "cancelled");
  assert.equal(terminalFor(new Error("x"), false), "failed");
});

test("执行包装器：先 yield 阶段再 yield 结果；持久记录只在成功后为 committed；失败不出现 committed", async () => {
  const ok = withExecution({ canvasId: "c1", runId: "r", tool: "demo", summarize: () => "完成 1 项" }, async () => ({ done: 1 }));
  const seen = await drain(ok({}, { toolCallId: "ok-1" }));
  assert.deepEqual(seen, [{ phase: "validating" }, { phase: "executing" }, { done: 1 }], "最后一次 yield 是交给模型的结果");
  const bad = withExecution({ canvasId: "c1", runId: "r", tool: "demo" }, async () => { throw Object.assign(new Error("字段冲突"), { status: 409 }); });
  await assert.rejects(drain(bad({}, { toolCallId: "bad-1" })), /字段冲突/);
  const records = await listToolRecords("c1");
  const okRecord = records.find(r => r.toolCallId === "ok-1"), badRecord = records.find(r => r.toolCallId === "bad-1");
  assert.equal(okRecord.phase, "committed");
  assert.equal(okRecord.summary, "完成 1 项");
  assert.equal(okRecord.eventSeq, 3);
  assert.equal(badRecord.phase, "blocked");
  assert.match(badRecord.error, /字段冲突/);
  assert.equal(records.filter(r => r.toolCallId === "ok-1").length, 1, "同一调用只有一条记录");
});

test("记录写入失败不回滚已提交的结果", async () => {
  const original = process.env.GROK_CANVAS_DATA_DIR;
  const wrapped = withExecution({ canvasId: "bad/id", runId: "r", tool: "demo" }, async () => "已提交");
  const warn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a.join(" "));
  try { assert.equal((await drain(wrapped({}, { toolCallId: "x" }))).at(-1), "已提交"); }
  finally { console.warn = warn; process.env.GROK_CANVAS_DATA_DIR = original; }
  assert.ok(warnings.length >= 1);
});

test("add_canvas_nodes：同一 toolCallId 重放只建一次节点，ID 稳定；结果经执行记录为 committed", async () => {
  const doc = await store.module.createCanvas();
  const tools = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1", "conv-1");
  const input = { nodes: [{ type: "canvasText", name: "大纲", prompt: "", content: "x", ref: "o" }, { type: "image", name: "图", prompt: "a", from: ["o"] }] };
  const first = (await drain(tools.add_canvas_nodes.execute(input, { toolCallId: "add-1", messages: [] }))).at(-1);
  const second = (await drain(tools.add_canvas_nodes.execute(input, { toolCallId: "add-1", messages: [] }))).at(-1);
  assert.deepEqual(second.nodes.map(n => n.id), first.nodes.map(n => n.id));
  assert.equal(second.replayed, true);
  assert.equal(first.nodes[0].id, agent.module.stableNodeId("add-1", 0));
  const saved = await store.module.loadCanvas(doc.id);
  assert.equal(saved.nodes.length, 2, "实体只存在一次");
  const record = (await listToolRecords(doc.id)).find(r => r.toolCallId === "add-1");
  assert.equal(record.phase, "committed");
  assert.equal(record.runId, "conv-1");
});
