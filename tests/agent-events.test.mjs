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

// write_document：正文在工具内部流式撰写，草稿经 preliminary 推给界面，写完一次性落库。
async function* chunks(parts, { gate } = {}) { for (const part of parts) { if (gate) await gate(); yield part; } }

test("write_document：撰写中逐段推送草稿（preliminary，不进模型）；写完一次性新建文本节点并连上游；重放不重写", async () => {
  const doc = await store.module.createCanvas();
  const outline = "大纲节点正文";
  let seenRequest = null;
  const writer = (request) => { seenRequest = request; return chunks(["# 导演阐述\n\n", "字".repeat(300), "\n\n结尾。"]); };
  const tools = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1", "conv-w", { writer });
  const setup = (await drain(tools.add_canvas_nodes.execute({ nodes: [{ type: "canvasText", name: "大纲", prompt: "", content: outline }] }, { toolCallId: "add-w", messages: [] }))).at(-1);
  const upstream = setup.nodes[0].id;
  const input = { title: "导演阐述", brief: "写 300 字导演阐述", context: [upstream], from: [upstream] };
  const seen = await drain(tools.write_document.execute(input, { toolCallId: "write-1", messages: [] }));
  const drafts = seen.filter(v => v.draft).map(v => v.draft.content);
  assert.ok(drafts.length >= 2, "开始 + 至少一次进度");
  assert.equal(drafts[0], "");
  assert.ok(drafts.at(-1).startsWith("# 导演阐述") && drafts.at(-1).endsWith("结尾。"), "最后一条草稿是完整正文");
  assert.ok(drafts.every((d, i) => i === 0 || d.length >= drafts[i - 1].length), "草稿只增不减");
  const output = seen.at(-1);
  assert.equal(output.draft, undefined, "交给模型的结果不含正文");
  assert.equal(output.chars, drafts.at(-1).length);
  assert.equal(output.id, agent.module.stableNodeId("write-1", 0));
  assert.match(seenRequest.context, /大纲节点正文/, "上游正文作为参考资料");
  const saved = await store.module.loadCanvas(doc.id);
  const node = saved.nodes.find(n => n.id === output.id);
  assert.deepEqual([node.type, node.data.name, node.data.content], ["canvasText", "导演阐述", drafts.at(-1)]);
  assert.ok(node.height < 800, `高度按正文适配：${node.height}`);
  assert.deepEqual(saved.edges.map(e => [e.source, e.target]), [[upstream, output.id]]);
  const replay = (await drain(tools.write_document.execute(input, { toolCallId: "write-1", messages: [] }))).at(-1);
  assert.deepEqual([replay.id, replay.replayed], [output.id, true]);
  assert.equal((await store.module.loadCanvas(doc.id)).nodes.length, 2, "重放不新建、不重写");
  const record = (await listToolRecords(doc.id)).find(r => r.toolCallId === "write-1");
  assert.equal(record.phase, "committed");
});

test("write_document：重写已有文本节点；撰写中途失败不留半篇正文；空结果不写入", async () => {
  const doc = await store.module.createCanvas();
  const base = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1", "conv-r", { writer: () => chunks(["新正文第一段。"]) });
  const target = (await drain(base.add_canvas_nodes.execute({ nodes: [{ type: "canvasText", name: "剧本", prompt: "", content: "旧正文" }] }, { toolCallId: "add-r", messages: [] }))).at(-1).nodes[0].id;
  const rewritten = (await drain(base.write_document.execute({ title: "剧本 v2", brief: "重写", nodeId: target }, { toolCallId: "write-r", messages: [] }))).at(-1);
  assert.equal(rewritten.id, target);
  let node = (await store.module.loadCanvas(doc.id)).nodes.find(n => n.id === target);
  assert.deepEqual([node.data.name, node.data.content], ["剧本 v2", "新正文第一段。"]);
  async function* broken() { yield "写到一半"; throw new Error("上游断开"); }
  const failing = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1", "conv-r", { writer: () => broken() });
  await assert.rejects(drain(failing.write_document.execute({ title: "剧本 v3", brief: "再写", nodeId: target }, { toolCallId: "write-f", messages: [] })), /上游断开/);
  node = (await store.module.loadCanvas(doc.id)).nodes.find(n => n.id === target);
  assert.equal(node.data.content, "新正文第一段。", "失败时正文保持原样");
  assert.equal((await listToolRecords(doc.id)).find(r => r.toolCallId === "write-f").phase, "failed");
  const empty = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1", "conv-r", { writer: () => chunks(["  \n"]) });
  await assert.rejects(drain(empty.write_document.execute({ title: "空", brief: "x" }, { toolCallId: "write-e", messages: [] })), /为空/);
  assert.equal((await store.module.loadCanvas(doc.id)).nodes.length, 1);
});

test("执行包装器：run 期间的 progress 只保留最新一条，按顺序作为 preliminary 交出，结果最后", async () => {
  const wrapped = withExecution({ canvasId: "c-p", runId: "r", tool: "t" }, async (_input, { progress }) => {
    progress({ summary: "1" }); progress({ summary: "2" });
    await new Promise(r => setTimeout(r, 5));
    progress({ summary: "3" });
    await new Promise(r => setTimeout(r, 5));
    return "完成";
  });
  const seen = await drain(wrapped({}, { toolCallId: "p" }));
  assert.deepEqual(seen.map(v => typeof v === "string" ? v : v.summary ?? v.phase), ["validating", "executing", "2", "3", "完成"]);
});
