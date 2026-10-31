import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P4-05：细节层级滞回、完整组件预算与场景接线。
const lod = await loadTypescript("lib/canvas-runtime/lod.ts");
after(() => lod.dispose());
const { createLodState, allocateFull, needsRequery, LOD } = lod.module;

test("缩放阈值 0.29/0.30/0.38/0.39：进入远景与退出远景有滞回，不在阈值附近抖动", () => {
  const state = createLodState();
  assert.equal(state.update(0.30, 10), "detail");
  assert.equal(state.update(0.29, 10), "light");
  assert.equal(state.update(0.30, 10), "light", "回到 0.30 仍是远景");
  assert.equal(state.update(0.38, 10), "light");
  assert.equal(state.update(0.39, 10), "detail");
  assert.equal(state.update(0.31, 10), "detail", "未低于 0.30 不进入远景");
});

test("候选 349/350/500/501：超过 500 进入概览，低于 350 才退出", () => {
  const state = createLodState();
  assert.equal(state.update(1, 500), "detail");
  assert.equal(state.update(1, 501), "overview");
  assert.equal(state.update(1, 400), "overview");
  assert.equal(state.update(1, 350), "overview");
  assert.equal(state.update(1, 349), "detail");
  assert.equal(state.update(0.1, 501), "overview", "概览优先于远景");
});

test("完整组件最多 80：pin 全部保留，其余按距中心由近到远", () => {
  const candidates = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, rect: { x: i * 100, y: 0, width: 50, height: 50 } }));
  const pins = new Set(["n299", "n298"]);
  const full = allocateFull(candidates, pins, { x: 0, y: 0 });
  assert.equal(full.size, LOD.fullBudget);
  assert.ok(full.has("n299") && full.has("n298"), "离中心远的 pin 也保留");
  assert.ok(full.has("n0") && full.has("n77") && !full.has("n78"), "近的优先");
  const pinsOnly = allocateFull(candidates.slice(0, 10), new Set(Array.from({ length: 10 }, (_, i) => `n${i}`)), { x: 0, y: 0 }, 3);
  assert.equal(pinsOnly.size, 10, "pin 不受预算裁剪");
});

test("平移在预取带内不重新查询；走出预取带或缩放变化超过 8% 才重新查询", () => {
  const last = { rect: { x: -300, y: -300, width: 2040, height: 1500 }, zoom: 1 };
  assert.equal(needsRequery(last, { x: 0, y: 0, width: 1440, height: 900 }, 1), false);
  assert.equal(needsRequery(last, { x: 200, y: 0, width: 1440, height: 900 }, 1), false);
  assert.equal(needsRequery(last, { x: 400, y: 0, width: 1440, height: 900 }, 1), true);
  assert.equal(needsRequery(last, { x: 0, y: 0, width: 1440, height: 900 }, 1.1), true);
  assert.equal(needsRequery(null, { x: 0, y: 0, width: 1, height: 1 }, 1), true);
});

test("场景接线：离屏不挂载、轻量节点同尺寸同手柄、概览只保留 pin、适配视图基于完整文档", async () => {
  const scene = await readFile(new URL("../components/canvas/canvas-scene.tsx", import.meta.url), "utf8");
  assert.match(scene, /onlyRenderVisibleElements/);
  assert.match(scene, /type: `light-\$\{node\.type\}`, style: \{ \.\.\.node\.style, width: g\.width, height: g\.height \}/);
  assert.match(scene, /plan\.pins\.has\(node\.id\) \? node : hiddenOf\(node\)/);
  const light = await readFile(new URL("../components/canvas/light-node.tsx", import.meta.url), "utf8");
  assert.match(light, /<PlusHandle type="target" position=\{Position\.Left\} \/>/);
  assert.match(light, /<PlusHandle type="source" position=\{Position\.Right\} \/>/);
  assert.doesNotMatch(light, /AssetImage|<video|MessageResponse/, "轻量节点不加载媒体、不渲染 Markdown");
  const controls = await readFile(new URL("../components/canvas/canvas-controls.tsx", import.meta.url), "utf8");
  assert.match(controls, /fitDocument\(getNodes\(\)/);
});
