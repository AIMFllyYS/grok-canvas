import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P4-04：可见性索引、边包围盒与完整图操作语义（10000 节点 fixture）。
const visibility = await loadTypescript("lib/canvas-runtime/visibility.ts");
const selection = await loadTypescript("lib/canvas-runtime/selection.ts");
const edgesMod = await loadTypescript("lib/canvas-runtime/edge-index.ts");
after(async () => { await visibility.dispose(); await selection.dispose(); await edgesMod.dispose(); });
const { createVisibilityIndex, syncIndex, viewportRect, PREFETCH_PX } = visibility.module;
const { selectRegion, selectAll, fitDocument } = selection.module;
const { edgeBounds, intersects } = edgesMod.module;

function grid(n = 10000, cols = 100) {
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: `n${i}`, rect: { x: (i % cols) * 400 - 20000, y: Math.floor(i / cols) * 300 - 15000, width: 280, height: 240 } });
  const edges = [];
  for (let i = 0; i + 1 < n; i += 7) edges.push({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` });
  return { nodes, edges };
}
const brute = (nodes, rect) => new Set(nodes.filter(n => intersects(n.rect, rect)).map(n => n.id));

test("屏幕→画布换算：负坐标、缩放与 300px 预取带", () => {
  const rect = viewportRect({ x: 100, y: -50, zoom: 0.5 }, { width: 1000, height: 800 });
  assert.equal(PREFETCH_PX, 300);
  assert.deepEqual(rect, { x: (-100 - 300) / 0.5, y: (50 - 300) / 0.5, width: 1600 / 0.5, height: 1400 / 0.5 });
});

test("10000 节点：视口查询与暴力扫描一致（可见 0、部分、全图、超大节点）", () => {
  const { nodes, edges } = grid();
  const index = createVisibilityIndex();
  syncIndex(index, nodes, edges);
  for (const rect of [
    { x: 900000, y: 900000, width: 10, height: 10 },
    { x: -1000, y: -1000, width: 1500, height: 900 },
    { x: -30000, y: -20000, width: 80000, height: 60000 },
  ]) assert.deepEqual(index.query(rect).nodeIds, brute(nodes, rect));
  index.setNode("huge", { x: -50000, y: -50000, width: 100000, height: 100000 });
  assert.ok(index.query({ x: 12345, y: 6789, width: 1, height: 1 }).nodeIds.has("huge"), "超大节点在任意位置都能查到");
});

test("两端都离屏但曲线穿过视口的边能查到；包围盒覆盖控制点", () => {
  const index = createVisibilityIndex();
  syncIndex(index, [
    { id: "left", rect: { x: -5000, y: 0, width: 280, height: 240 } },
    { id: "right", rect: { x: 5000, y: 0, width: 280, height: 240 } },
  ], [{ id: "e", source: "left", target: "right" }]);
  const view = { x: -100, y: 0, width: 200, height: 240 };
  const result = index.query(view);
  assert.equal(result.nodeIds.size, 0);
  assert.ok(result.edgeIds.has("e"));
  // 目标在源左侧：贝塞尔向两侧外凸，包围盒必须包含控制点。
  const back = edgeBounds({ x: 0, y: 0, width: 100, height: 100 }, { x: -400, y: 300, width: 100, height: 100 });
  assert.ok(back.x + back.width > 116, "包含源手柄右侧的控制点");
  assert.ok(back.x < -416, "包含目标手柄左侧的控制点");
});

test("移动只更新该节点与它的入/出边；删除清理空桶", () => {
  const { nodes, edges } = grid(2000, 50);
  const index = createVisibilityIndex();
  syncIndex(index, nodes, edges);
  const before = index.stats().updates;
  index.setNode("n0", { x: 100000, y: 100000, width: 280, height: 240 });
  assert.equal(index.stats().updates - before, 2, "1 个节点 + 1 条相关边");
  assert.ok(index.query({ x: 100000, y: 100000, width: 10, height: 10 }).edgeIds.has("e0"), "边索引随端点移动");
  const cells = index.stats().nodeCells;
  index.removeNode("n0");
  assert.ok(index.stats().nodeCells < cells, "空桶被清理");
  assert.equal(index.query({ x: 100000, y: 100000, width: 10, height: 10 }).nodeIds.size, 0);
});

test("pin 离屏也在结果里；全选只存 ID；框选与挂载无关；fitDocument 覆盖完整图", () => {
  const { nodes, edges } = grid();
  const index = createVisibilityIndex();
  syncIndex(index, nodes, edges);
  const q = index.queryViewport({ x: 0, y: 0, zoom: 1 }, { width: 1440, height: 900 }, ["n9999", "missing"]);
  assert.ok(q.nodeIds.has("n9999") && q.pins.has("n9999") && !q.pins.has("missing"));
  const all = selectAll(nodes.map(n => n.id));
  assert.equal(all.size, 10000);
  const region = { x: -20000, y: -15000, width: 790, height: 250 };
  assert.deepEqual([...selectRegion(index, region)].sort(), ["n0", "n1"]);
  assert.equal(selectRegion(index, { x: -20000, y: -15000, width: 100, height: 100 }, "partial").size, 1);
  const vp = fitDocument(nodes.map(n => n.rect), { width: 1440, height: 900 }, { minZoom: 0.01 });
  const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, width: 1440 / vp.zoom, height: 900 / vp.zoom };
  for (const id of ["n0", "n99", "n9900", "n9999"]) {
    const r = nodes.find(n => n.id === id).rect;
    assert.ok(r.x >= view.x && r.y >= view.y && r.x + r.width <= view.x + view.width && r.y + r.height <= view.y + view.height, `${id} 在适配视图内`);
  }
  assert.equal(fitDocument([], { width: 100, height: 100 }), null);
});
