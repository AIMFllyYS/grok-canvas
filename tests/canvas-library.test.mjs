import test from "node:test";
import assert from "node:assert/strict";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets, isImageAssetName } from "../lib/canvas-library.ts";
const entry = (assetName, source = "imported") => ({ assetName, name: assetName, sources: [source], addedAt: "2026-10-25T00:00:00Z" });

test("素材名只允许本地图片，拒绝视频和路径", () => {
  assert.equal(isImageAssetName("abc-1.jpeg"), true);
  for (const value of ["../a.png", "a.mp4", "https://x/a.png", "a.png/x", "a.svg", null]) assert.equal(isImageAssetName(value), false);
});
test("目录去重并合并来源，不按文件显示名合并", () => {
  const a = entry("a.png");
  const merged = mergeLibraryAssets([a], [entry("a.png", "generated"), { ...entry("b.png"), name: "a.png" }]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sources, ["imported", "generated"]);
  const stable = [a]; assert.equal(mergeLibraryAssets(stable, [a]), stable);
});
test("旧画布所有成功候选与参考图可恢复，失败槽和视频排除", () => {
  const nodes = [
    { type: "image", data: { name: "角色", assetName: "a.png", results: [{ assetName: "a.png", status: "success" }, { assetName: "b.png", status: "success" }, { assetName: null, status: "failed" }], uploadAttachments: ["ref.webp"], attachmentNames: { "ref.webp": "服装" } } },
    { type: "video", data: { assetName: "movie.mp4", uploadInputs: [{ assetName: "pose.jpeg", role: "reference" }] } },
  ];
  const library = collectCanvasAssets(nodes, "2026-10-25T00:00:00Z");
  assert.deepEqual(library.map(item => item.assetName), ["a.png", "b.png", "ref.webp", "pose.jpeg"]);
  assert.equal(library[2].name, "服装");
});
test("删除节点不丢目录，另一画布不继承目录", () => {
  const a = [entry("a.png", "generated")];
  assert.equal(mergeLibraryAssets(a, collectCanvasAssets([], "now")), a);
  assert.deepEqual(collectCanvasAssets([], "now"), []);
});
test("坏目录条目被过滤，已有来源不因放到画布被重标记", () => {
  assert.deepEqual(normalizeLibraryAssets([entry("bad.mp4"), {}, null]), []);
  const known = [entry("a.png", "generated")];
  assert.deepEqual(collectCanvasAssets([{ type: "asset", data: { assetName: "a.png" } }], "now", known), []);
});
