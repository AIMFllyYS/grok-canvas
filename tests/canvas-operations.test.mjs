import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/canvas-operations.ts");
after(loaded.dispose);
const { applyCanvasOperations, diffCanvasOperations } = loaded.module;
const doc = () => ({ id: "a", name: "a", schemaVersion: 1, revision: 1, createdAt: "", updatedAt: "", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "n", data: { content: "old", name: "one" } }, { id: "m", data: {} }], edges: [] });
const op = (id, path, before, after) => ({ id, target: "node", entityId: "n", path: ["data", path], before: { exists: true, value: before }, after: { exists: true, value: after } });
test("不同字段可以在最新文档上合并，重复操作不会再次执行", () => {
  const one = op("one", "content", "old", "new"), two = op("two", "name", "one", "two");
  const result = applyCanvasOperations(applyCanvasOperations(doc(), [one]), [two, one]);
  assert.deepEqual(result.nodes[0].data, { content: "new", name: "two" });
  assert.deepEqual(result.appliedOperationIds, ["one", "two"]);
});
test("同一字段冲突不修改原文档", () => {
  const current = applyCanvasOperations(doc(), [op("one", "content", "old", "new")]);
  assert.throws(() => applyCanvasOperations(current, [op("two", "content", "old", "other")]), /已被修改/);
  assert.equal(current.nodes[0].data.content, "new");
});
test("禁止悬空连线和原型污染", () => {
  const bad = { id: "edge", target: "edge", entityId: "e", path: [], before: { exists: false }, after: { exists: true, value: { id: "e", source: "n", target: "missing" } } };
  assert.throws(() => applyCanvasOperations(doc(), [bad]), /连线/);
  assert.throws(() => applyCanvasOperations(doc(), [{ ...op("x", "name", "one", "x"), path: ["__proto__", "x"] }]), /无效/);
});
test("差异操作按连线删除、节点删除、节点新增、连线新增排序", () => {
  const before = doc();
  before.edges = [{ id: "old", source: "n", target: "m" }];
  before.nodes[0].type = "canvasText";
  before.nodes[1].type = "canvasText";
  const after = structuredClone(before);
  after.nodes = [after.nodes[0], { id: "new", type: "canvasText", data: {} }];
  after.edges = [{ id: "new-edge", source: "n", target: "new" }];
  const operations = diffCanvasOperations(before, after);
  const result = applyCanvasOperations(before, operations);
  assert.deepEqual(result.nodes, after.nodes);
  assert.deepEqual(result.edges, after.edges.map(edge => ({ ...edge, type: "scissor" })));
});
test("选中和测量状态不会影响删除条件或被新节点持久化", () => {
  const before = doc();
  before.nodes[0].selected = true;
  before.nodes[0].measured = { width: 300, height: 200 };
  const local = structuredClone(before);
  local.nodes[0].selected = false;
  const target = structuredClone(local);
  target.nodes = target.nodes.slice(1);
  const result = applyCanvasOperations(before, diffCanvasOperations(local, target));
  assert.equal(result.nodes.length, 1);
  const added = structuredClone(target);
  added.nodes.push({ id: "new", data: {}, selected: true, measured: { width: 3 } });
  const saved = applyCanvasOperations(target, diffCanvasOperations(target, added));
  assert.equal("selected" in saved.nodes.at(-1), false);
  assert.equal("measured" in saved.nodes.at(-1), false);
});
