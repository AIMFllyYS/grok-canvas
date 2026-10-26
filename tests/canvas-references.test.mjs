import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/canvas-references.ts"); after(loaded.dispose);
const { resolveCanvasReferences, addFixedReferences, validateImageReferences } = loaded.module;
const image = (id, data = {}) => ({ id, type: "image", data: { uploadAttachments: [], ...data } });
const video = (id, data = {}) => ({ id, type: "video", data: { uploadInputs: [], ...data } });
const asset = assetName => ({ assetName, name: assetName });

test("同图的连线和固定参考只提交一次", () => {
  const target = image("t", { uploadAttachments: ["a.png"] });
  const result = resolveCanvasReferences(target, [image("s", { assetName: "a.png" }), target], [{ id: "e", source: "s", target: "t" }]);
  assert.deepEqual(result.assets, ["a.png"]);
  assert.equal(result.occupied, 1);
});
test("固定引用不随主图变化，能引用当前节点输出", () => {
  const target = image("t", { assetName: "self.png", uploadAttachments: ["old.png"] });
  const result = resolveCanvasReferences(target, [image("s", { assetName: "new.png" }), target], [{ id: "e", source: "s", target: "t" }]);
  assert.deepEqual(result.assets, ["new.png", "old.png"]);
  assert.deepEqual(addFixedReferences(target, [target], [], [asset("self.png")]).uploadAttachments, ["old.png", "self.png"]);
});
test("未就绪连线仍占名额，第六张被拒绝", () => {
  const target = image("t", { uploadAttachments: ["a.png", "b.png", "c.png", "d.png"] });
  assert.throws(() => addFixedReferences(target, [target, image("s")], [{ source: "s", target: "t" }], [asset("e.png")]), /5/);
});
test("视频同图跨角色冲突不能被去重掩盖", () => {
  const target = video("t", { uploadInputs: [{ assetName: "a.png", role: "reference" }] });
  assert.throws(() => resolveCanvasReferences(target, [target, image("s", { assetName: "a.png" })], [{ source: "s", target: "t", data: { role: "first" } }]), /兼任/);
});
test("视频 @ 固定引用默认是reference，七张上限", () => {
  const target = video("t");
  assert.deepEqual(addFixedReferences(target, [target], [], [asset("a.png")]).uploadInputs, [{ assetName: "a.png", role: "reference" }]);
  assert.throws(() => addFixedReferences(target, [target], [], Array.from({ length: 8 }, (_, i) => asset(`r${i}.png`))), /7/);
});
test("批量添加是原子验证，重复添加不重复占位", () => {
  const target = image("t", { uploadAttachments: ["a.png"] });
  assert.deepEqual(addFixedReferences(target, [target], [], [asset("a.png"), asset("a.png")]).uploadAttachments, ["a.png"]);
  assert.throws(() => addFixedReferences(target, [target], [], [asset("b.png"), asset("x.mp4")]));
  assert.deepEqual(target.data.uploadAttachments, ["a.png"]);
});
test("图片路由在非法、超限、失效token和缺失文件时均不调用生成", async () => {
  const prompt = await loadTypescript("lib/prompt-references.ts");
  const multiImage = await loadTypescript("lib/multi-image.ts");
  try {
    const source = await readFile(new URL("../app/api/generate/image/route.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {}, calls = [], snapshots = [];
    vm.runInNewContext(code, { exports, require(name) {
      if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
      if (name === "@/lib/canvas-references") return loaded.module;
      if (name === "@/lib/prompt-references") return prompt.module;
      if (name === "@/lib/multi-image") return multiImage.module;
      if (name === "@/lib/api-error") return { errorResponse: error => Response.json({ error: { message: error.message } }, { status: 500 }) };
      if (name === "@/lib/assets") return { assetToDataUri: async name => { if (name === "missing.png") throw new Error("文件不存在"); return `data:image/png;base64,${name}`; } };
      if (name === "@/lib/generation-batch") return { persistImageBatch: async (_images, _count, snapshot) => { snapshots.push(snapshot); return []; } };
      if (name === "@/lib/xai/client") return { editImage: async body => { calls.push(body); return { data: [] }; }, generateImages: async body => { calls.push(body); return { data: [] }; } };
      throw new Error(`未模拟依赖：${name}`);
    } });
    const request = body => new Request("http://127.0.0.1:3210/api/generate/image", { method: "POST", body: JSON.stringify(body) });
    for (const body of [
      { prompt: "p", referenceAssets: ["../secret.png"] },
      { prompt: "p", referenceAssets: ["video.mp4"] },
      { prompt: "p", referenceAssets: Array.from({ length: 6 }, (_, index) => `${index}.png`) },
      { prompt: "[[image:old.png]]", referenceAssets: ["new.png"] },
    ]) assert.equal((await exports.POST(request(body))).status, 400);
    assert.equal((await exports.POST(request({ prompt: "p", referenceAssets: ["missing.png"] }))).ok, false);
    assert.equal(calls.length, 0);
    const valid = await exports.POST(request({ prompt: "画 [[image:a.png]]", referenceAssets: ["a.png", "a.png"] }));
    assert.equal(valid.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].image.url, "data:image/png;base64,a.png");
    assert.deepEqual(Array.from(snapshots[0].referenceAssets), ["a.png"]);
    assert.equal(calls[0].prompt, prompt.module.compilePrompt("画 [[image:a.png]]", ["a.png"]));
  } finally { await prompt.dispose(); await multiImage.dispose(); }
});
test("后端图片引用显式拒绝非法和超限，不截断", () => {
  assert.deepEqual(validateImageReferences(["a.png", "a.png"]), ["a.png"]);
  assert.throws(() => validateImageReferences(["../a.png"]));
  assert.throws(() => validateImageReferences(["a.mp4"]));
  assert.throws(() => validateImageReferences(Array.from({ length: 6 }, (_, i) => `a${i}.png`)), /5/);
});
