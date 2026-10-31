import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P5-02：partial 输入预显示、合并节流、原位接替与乱序终态。
const previews = await loadTypescript("lib/canvas-runtime/preview-store.ts");
const coordinator = await loadTypescript("lib/canvas-runtime/preview-coordinator.ts");
const input = await loadTypescript("lib/agent/preview-input.ts");
after(async () => { await previews.dispose(); await coordinator.dispose(); await input.dispose(); });
const { createPreviewStore, bridgeToolPart } = previews.module;
const { placePreviews } = coordinator.module;
const { addEntries, editEntries, createPartialGate } = input.module;
const part = (state, inputValue, extra = {}) => ({ type: "tool-add_canvas_nodes", toolCallId: "call-1", state, input: inputValue, ...extra });

test("partial 输入：只为已有 type 的条目画占位；名称不全用默认名；正文只取 512 字符；不猜后续条目", () => {
  const entries = addEntries("c", "call", { nodes: [{ type: "canvasText", name: "大", content: "字".repeat(2000) }, { name: "还没有类型" }, { type: "ima" }] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "大");
  assert.equal(entries[0].excerpt.length, 512);
  assert.equal(addEntries("c", "call", { nodes: [{ type: "video" }] })[0].label, "视频");
  assert.deepEqual(addEntries("c", "call", { nodes: "半个数组" }), []);
});

test("同一调用 100ms 内合并；条目数变化立即放行", () => {
  const gate = createPartialGate(100);
  assert.equal(gate.allow("k", 1, 0), true);
  assert.equal(gate.allow("k", 1, 50), false);
  assert.equal(gate.allow("k", 2, 60), true, "新条目出现立即更新");
  assert.equal(gate.allow("k", 2, 170), true);
});

test("1000 次 partial 更新：只改预显示层，容量有界；完整输入覆盖；结果到达后按 ID 原位接替", () => {
  const store = createPreviewStore();
  const nodes = [];
  for (let i = 0; i < 1000; i++) {
    nodes.length = Math.min(20, 1 + Math.floor(i / 50));
    for (let k = 0; k < nodes.length; k++) nodes[k] ??= { type: "image", name: `镜头${k}` };
    bridgeToolPart(store, "c", part("input-streaming", { nodes: nodes.map(n => ({ ...n })) }), undefined, i * 10);
  }
  assert.equal(store.get("c").length, 20);
  assert.ok(store.load().bytes < 64 * 1024);
  bridgeToolPart(store, "c", part("input-available", { nodes: nodes.map(n => ({ ...n })) }));
  bridgeToolPart(store, "c", part("output-available", nodes, { output: { nodes: nodes.map((_, i) => ({ id: `real-${i}` })) }, preliminary: true }));
  assert.ok(store.get("c").every(e => !e.nodeId), "preliminary 阶段结果不触发接替");
  bridgeToolPart(store, "c", part("output-available", nodes, { output: { nodes: nodes.map((_, i) => ({ id: `real-${i}` })) } }));
  assert.deepEqual(store.get("c").map(e => e.nodeId), nodes.map((_, i) => `real-${i}`));
  // 正式节点出现后由 CanvasPreview 移除；这里直接模拟移除。
  for (const e of store.get("c")) store.remove("c", e.toolCallId, e.itemIndex);
  bridgeToolPart(store, "c", part("output-available", nodes, { output: { nodes: [] } }));
  assert.equal(store.get("c").length, 0, "重复终态不留残影");
});

test("终态先于预显示、失败与跨画布：不留残影，不污染其他画布", () => {
  const store = createPreviewStore();
  bridgeToolPart(store, "a", part("output-error", { nodes: [{ type: "image" }] }));
  bridgeToolPart(store, "a", part("input-streaming", { nodes: [{ type: "image" }] }), undefined, 0);
  bridgeToolPart(store, "a", part("output-error", { nodes: [{ type: "image" }] }));
  assert.equal(store.get("a").length, 0);
  bridgeToolPart(store, "b", { ...part("input-available", { nodes: [{ type: "video" }] }), toolCallId: "other" });
  assert.equal(store.get("a").length, 0);
  assert.equal(store.get("b").length, 1);
});

test("修改/删除标记：叠在目标节点上，不改正式文档；结果到达后移除", () => {
  const store = createPreviewStore();
  const edit = { type: "tool-edit_canvas_nodes", toolCallId: "e1", state: "input-available", input: { updates: [{ id: "n1", content: "新" }], remove: ["n2"] } };
  bridgeToolPart(store, "c", edit);
  assert.deepEqual(store.get("c").map(e => [e.kind, e.targetId]), [["edit", "n1"], ["remove", "n2"]]);
  assert.equal(editEntries("c", "x", { updates: [{}], remove: [3] }).length, 0);
  const placed = placePreviews(store.get("c"), [{ id: "n1", type: "canvasText", position: { x: 10, y: 20 }, width: 300, height: 200 }], []);
  assert.deepEqual(placed.map(p => [p.kind, p.x, p.y, p.width]), [["edit", 10, 20, 300]], "目标不在画布中的标记不显示");
  bridgeToolPart(store, "c", { ...edit, state: "output-available", output: { updated: 1, nodes: [{ id: "n1" }] } });
  assert.equal(store.get("c").length, 0);
});

test("位置估算：没有坐标的新增按流程排在上游右侧，不再堆在原点；显式坐标照用", () => {
  const entries = addEntries("c", "call", { nodes: [{ type: "canvasText", name: "脚本", ref: "s", from: ["up"] }, { type: "image", name: "镜头", from: ["s"] }, { type: "image", name: "定点", x: 999, y: 888 }] });
  const placed = placePreviews(entries, [{ id: "up", type: "canvasText", position: { x: 0, y: 0 }, width: 360, height: 260 }], []);
  const byName = Object.fromEntries(placed.map(p => [p.label, p]));
  assert.ok(byName["脚本"].x > 360, "在上游右侧");
  assert.ok(byName["镜头"].x > byName["脚本"].x, "下游在更右侧");
  assert.deepEqual([byName["定点"].x, byName["定点"].y], [999, 888]);
});
