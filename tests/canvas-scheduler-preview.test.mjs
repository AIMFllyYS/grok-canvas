import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const schedulerModule = await loadTypescript("lib/canvas-runtime/scheduler.ts");
const previewModule = await loadTypescript("lib/canvas-runtime/preview-store.ts");
const budgetModule = await loadTypescript("lib/canvas-runtime/runtime-budget.ts");
after(async () => { await schedulerModule.dispose(); await previewModule.dispose(); await budgetModule.dispose(); });
const { createScheduler } = schedulerModule.module;
const { createPreviewStore, bridgeToolPart } = previewModule.module;
const { RUNTIME_BUDGET, PRIORITY } = budgetModule.module;

/** 假时钟 + 手动让出：每个任务“耗时” cost ms。 */
function harness(options = {}) {
  let clock = 0;
  const yields = [];
  const scheduler = createScheduler({ now: () => clock, yieldTo: resume => { yields.push(resume); return () => {}; }, ...options });
  const task = (key, priority, log, cost = 1) => ({ key, priority, run: () => { clock += cost; log.push(key); } });
  const step = () => { const resume = yields.shift(); if (resume) resume(); return !!resume; };
  return { scheduler, task, step, yields, advance: ms => { clock += ms; } };
}

test("预算常量唯一来源（C7）", () => {
  assert.equal(RUNTIME_BUDGET.backgroundSliceMs, 4);
  assert.equal(RUNTIME_BUDGET.previewQueueItems, 500);
  assert.equal(RUNTIME_BUDGET.previewQueueBytes, 2 * 1024 * 1024);
  assert.deepEqual([RUNTIME_BUDGET.overviewEnterZoom, RUNTIME_BUDGET.overviewExitZoom, RUNTIME_BUDGET.fullComponents, RUNTIME_BUDGET.lightComponents], [0.3, 0.38, 80, 400]);
  assert.ok(Object.isFrozen(RUNTIME_BUDGET));
});

test("4ms 切片：超时后让出；优先级 gesture > terminal > visible > preview > prefetch；同级先进先出", () => {
  const { scheduler, task, step, yields } = harness();
  const log = [];
  scheduler.schedule(task("p1", PRIORITY.prefetch, log));
  scheduler.schedule(task("v1", PRIORITY.preview, log));
  scheduler.schedule(task("v2", PRIORITY.preview, log));
  scheduler.schedule(task("t1", PRIORITY.terminal, log));
  scheduler.schedule(task("g1", PRIORITY.gesture, log));
  scheduler.schedule(task("s1", PRIORITY.visible, log));
  assert.equal(yields.length, 1, "调度只排一次让出，不在 schedule 中同步执行");
  assert.equal(log.length, 0);
  step();
  assert.deepEqual(log, ["g1", "t1", "s1", "v1"], "一片 4ms 内按优先级执行 4 个 1ms 任务后让出");
  step();
  assert.deepEqual(log, ["g1", "t1", "s1", "v1", "v2", "p1"]);
  assert.ok(scheduler.stats().maxSliceMs <= 4);
});

test("长任务也只占一片：一个 10ms 任务之后立即让出，后续任务不饿死", () => {
  const { scheduler, task, step } = harness();
  const log = [];
  scheduler.schedule(task("slow", PRIORITY.preview, log, 10));
  scheduler.schedule(task("next", PRIORITY.preview, log));
  step();
  assert.deepEqual(log, ["slow"]);
  step();
  assert.deepEqual(log, ["slow", "next"]);
});

test("合并只针对未执行的同 key 预显示/预取；终态与正式任务不合并、不丢", () => {
  const { scheduler, task, step } = harness();
  const log = [];
  for (let i = 0; i < 1000; i++) scheduler.schedule({ key: "tool:0", priority: PRIORITY.preview, run: () => log.push(`preview-${i}`), bytes: 100 });
  scheduler.schedule(task("terminal", PRIORITY.terminal, log));
  scheduler.schedule(task("terminal", PRIORITY.terminal, log));
  assert.equal(scheduler.previewLoad().items, 1, "1000 次更新合并为 1 条");
  assert.equal(scheduler.stats().merged, 999);
  step();
  assert.deepEqual(log, ["terminal", "terminal", "preview-999"], "终态两条都执行，预显示只执行最新一次");
});

test("预显示容量 500 项/2MiB：超限拒绝新预览并标记已简化，正式/终态任务不受影响；回落后复位", () => {
  const { scheduler, task, step } = harness({ previewItems: 3, previewBytes: 1000 });
  const log = [];
  for (let i = 0; i < 3; i++) assert.equal(scheduler.schedule({ key: `p${i}`, priority: PRIORITY.preview, run: () => log.push(`p${i}`) }).accepted, true);
  assert.deepEqual(scheduler.schedule({ key: "p3", priority: PRIORITY.preview, run: () => {} }), { accepted: false, reason: "preview_capacity" });
  assert.deepEqual(scheduler.schedule({ key: "big", priority: PRIORITY.preview, run: () => {}, bytes: 5000 }).accepted, false);
  assert.equal(scheduler.schedule(task("commit", PRIORITY.terminal, log)).accepted, true, "终态不受预览容量限制");
  assert.equal(scheduler.simplified(), true);
  step();
  assert.equal(scheduler.simplified(), false, "队列清空后复位");
  assert.ok(log.includes("commit"));
});

test("flushTerminals 立即执行终态，不等下一片；取消 A 不影响 B", () => {
  const { scheduler, task } = harness();
  const log = [];
  scheduler.schedule(task("A:1", PRIORITY.preview, log));
  scheduler.schedule(task("B:1", PRIORITY.preview, log));
  scheduler.schedule(task("A:done", PRIORITY.terminal, log));
  assert.equal(scheduler.flushTerminals(), 1);
  assert.deepEqual(log, ["A:done"]);
  assert.equal(scheduler.cancelPrefix("A:"), 1);
  scheduler.pump();
  assert.deepEqual(log, ["A:done", "B:1"]);
});

test("PreviewStore：按 toolCallId:itemIndex 存轻量条目；按画布隔离；取消 A 不清 B；稳定快照", () => {
  const store = createPreviewStore();
  const entry = (canvasId, toolCallId, itemIndex) => ({ canvasId, toolCallId, itemIndex, kind: "add", label: "图片", x: 0, y: 0, width: 304, height: 264, status: "pending" });
  store.upsert(entry("c1", "A", 0));
  store.upsert(entry("c1", "A", 1));
  store.upsert(entry("c1", "B", 0));
  store.upsert(entry("c2", "A", 0));
  const snapshot = store.get("c1");
  assert.equal(snapshot.length, 3);
  assert.equal(store.get("c1"), snapshot, "无变化返回同一引用");
  assert.equal(store.remove("c1", "A"), 2);
  assert.deepEqual(store.get("c1").map(e => e.toolCallId), ["B"], "取消 A 不清 B");
  assert.equal(store.get("c2").length, 1, "另一画布不受影响");
  store.clearCanvas("c2");
  assert.equal(store.get("c2").length, 0);
});

test("PreviewStore 容量：超限停止新增并标记已简化", () => {
  const store = createPreviewStore({ items: 2 });
  const add = (i) => store.upsert({ canvasId: "c", toolCallId: `t${i}`, itemIndex: 0, kind: "add", label: "x", x: 0, y: 0, width: 1, height: 1, status: "pending" });
  assert.equal(add(0), true); assert.equal(add(1), true); assert.equal(add(2), false);
  assert.equal(store.simplified(), true);
});

test("Agent 工具桥接：完整输入出虚线预显示；成功把返回 ID 交给条目；失败立即移除无残影；预显示不改变正式计数", () => {
  const store = createPreviewStore();
  const { scheduler, step } = harness();
  const formal = { nodes: [{ id: "n1" }], edges: [], history: [], assets: [] };
  const before = JSON.stringify(formal);
  const input = { nodes: [{ type: "image", name: "猫", x: 10, y: 20 }, { type: "canvasText", name: "说明" }] };
  bridgeToolPart(store, "c1", { type: "tool-add_canvas_nodes", toolCallId: "call-1", state: "input-available", input }, scheduler);
  assert.equal(store.get("c1").length, 0, "预显示更新经调度器，不在桥接中同步写");
  step();
  assert.deepEqual(store.get("c1").map(e => [e.label, e.x, e.y, e.width, e.height]), [["猫", 10, 20, 304, 264], ["说明", 0, 0, 360, 260]]);
  bridgeToolPart(store, "c1", { type: "tool-add_canvas_nodes", toolCallId: "call-1", state: "output-available", input, output: { nodes: [{ id: "real-1" }, { id: "real-2" }] } }, scheduler);
  assert.deepEqual(store.get("c1").map(e => e.nodeId), ["real-1", "real-2"], "终态立即执行，交接正式节点 ID");
  bridgeToolPart(store, "c1", { type: "tool-add_canvas_nodes", toolCallId: "call-2", state: "input-available", input }, scheduler);
  bridgeToolPart(store, "c1", { type: "tool-add_canvas_nodes", toolCallId: "call-2", state: "output-error", input }, scheduler);
  step();
  assert.equal(store.get("c1").filter(e => e.toolCallId === "call-2").length, 0, "失败的调用无残影");
  assert.equal(JSON.stringify(formal), before, "正式 nodes/edges/history/assets 不变");
});

test("接线：CanvasPreview 只读层不拦截指针、不进正式数组；面板只桥接已确认的工具状态", async () => {
  const preview = await readFile(new URL("../components/canvas/canvas-preview.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/agent/panel.tsx", import.meta.url), "utf8");
  const flow = await readFile(new URL("../components/canvas/flow-canvas.tsx", import.meta.url), "utf8");
  assert.match(preview, /pointerEvents: "none"/);
  assert.match(preview, /ViewportPortal/);
  assert.doesNotMatch(preview, /setNodes|setViewport|fitView/, "不改正式节点、不抢相机");
  assert.match(panel, /bridgeToolPart\(previewStore, canvasId/);
  assert.match(flow, /<CanvasPreview canvasId=\{doc\.id\} \/>/);
});
