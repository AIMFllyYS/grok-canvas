import test from "node:test";
import assert from "node:assert/strict";
import { clampMinimapSize, parseMinimapSize, parseToolbarLayout, parseToolbarPosition, toolbarPositionKey, toolbarTarget } from "../lib/workspace-preferences.ts";

test("工具栏默认聚合，非法偏好回退", () => {
  assert.equal(parseToolbarLayout(null), "aggregated");
  assert.equal(parseToolbarLayout("scattered"), "scattered");
  assert.equal(parseToolbarLayout("bad"), "aggregated");
});
test("托盘位置只接受有限非负坐标", () => {
  assert.deepEqual(parseToolbarPosition('{"x":12,"y":20}'), { x: 12, y: 20 });
  for (const value of [null, "bad", '{"x":-1,"y":20}', '{"x":null,"y":1}']) assert.equal(parseToolbarPosition(value), null);
});
test("不同画布有独立的位置键", () => {
  assert.notEqual(toolbarPositionKey("a"), toolbarPositionKey("b"));
});
test("工具栏默认居底居中，自定义位置优先，拆散固定居左下", () => {
  const container = { width: 1600, height: 918 }, element = { width: 438, height: 44 };
  assert.deepEqual(toolbarTarget("aggregated", null, container, element), { x: 581, y: 858 });
  assert.deepEqual(toolbarTarget("aggregated", { x: 300, y: 200 }, container, element), { x: 300, y: 200 });
  assert.deepEqual(toolbarTarget("scattered", { x: 300, y: 200 }, container, element), { x: 12, y: 862 });
});
test("容器尺寸未就绪时坐标仍是可显示的数字", () => {
  const target = toolbarTarget("aggregated", null, { width: 0, height: 0 }, { width: 438, height: 44 });
  assert.equal(Number.isFinite(target.x) && Number.isFinite(target.y), true);
  assert.equal(target.x >= 0 && target.y >= 0, true);
});
test("小地图尺寸只接受有限正数", () => {
  assert.deepEqual(parseMinimapSize('{"width":200,"height":140}'), { width: 200, height: 140 });
  for (const value of [null, "bad", '{"width":0,"height":10}', '{"width":"200","height":140}']) assert.equal(parseMinimapSize(value), null);
});
test("小地图尺寸不小于下限也不超出容器，取整避免亚像素抖动", () => {
  assert.deepEqual(clampMinimapSize({ width: 40, height: 30 }, { width: 1600, height: 918 }), { width: 120, height: 96 });
  assert.deepEqual(clampMinimapSize({ width: 9999, height: 9999 }, { width: 640, height: 500 }), { width: 616, height: 476 });
  assert.deepEqual(clampMinimapSize({ width: 200.4, height: 140.6 }, { width: 1600, height: 918 }), { width: 200, height: 141 });
});
