import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile like tests/generation-batch.test.mjs: strip-only mode cannot
// resolve extensionless imports.
const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-video-references-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
for (const name of ["prompt-references", "video-references"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(path.join(temporary, `${name}.js`), output.replace(/from "(\.\/[^".]+)"/g, 'from "$1.js"'));
}

const {
  VIDEO_REFERENCE_MAX,
  compileVideoPrompt,
  defaultNewVideoRole,
  moveVideoSlot,
  referenceTokenMap,
  setVideoSlotRole,
  staleVideoReferences,
  videoInputsFromSlots,
} = await import(
  pathToFileURL(path.join(temporary, "video-references.js")).href
);

test("同一图片的不同角色不能在槽位去重时被掩盖", () => {
  assert.throws(() => videoInputsFromSlots([
    { key: "a", assetName: "same.png", role: "first", name: "A" },
    { key: "b", assetName: "same.png", role: "reference", name: "B" },
  ]), /不能兼任/);
  assert.deepEqual(videoInputsFromSlots([
    { key: "a", assetName: "same.png", role: "reference", name: "A" },
    { key: "b", assetName: "same.png", role: "reference", name: "B" },
  ]), [{ assetName: "same.png", role: "reference" }]);
});

const ref = (assetName) => ({ assetName, role: "reference" });
const at = (assetName) => `[[image:${assetName}]]`;

test("without a first frame, references are numbered from 0", () => {
  const map = referenceTokenMap([ref("a.png"), ref("b.png"), ref("c.png")]);
  assert.equal(map.get("a.png"), "<IMAGE_0>");
  assert.equal(map.get("b.png"), "<IMAGE_1>");
  assert.equal(map.get("c.png"), "<IMAGE_2>");
});

test("a first frame takes index 0 and references start at 1", () => {
  const map = referenceTokenMap([{ assetName: "city.png", role: "first" }, ref("fox.png"), ref("dog.png")]);
  assert.equal(map.get("fox.png"), "<IMAGE_1>");
  assert.equal(map.get("dog.png"), "<IMAGE_2>");
  assert.equal(map.has("city.png"), false);
});

test("a last frame alone does not shift the reference start", () => {
  const map = referenceTokenMap([{ assetName: "city.png", role: "last" }, ref("fox.png")]);
  assert.equal(map.get("fox.png"), "<IMAGE_0>");
});

test("first and last frames together still start references at 1", () => {
  const map = referenceTokenMap([
    { assetName: "city.png", role: "first" },
    { assetName: "end.png", role: "last" },
    ref("fox.png"),
  ]);
  assert.equal(map.get("fox.png"), "<IMAGE_1>");
});

test("reordering rebuilds numbers while @ keeps pointing at the same asset", () => {
  const prompt = `${at("fox.png")} meets ${at("dog.png")}`;
  const before = compileVideoPrompt(prompt, [ref("fox.png"), ref("dog.png")]);
  const after_ = compileVideoPrompt(prompt, [ref("dog.png"), ref("fox.png")]);
  assert.equal(before, "<IMAGE_0> meets <IMAGE_1>");
  assert.equal(after_, "<IMAGE_1> meets <IMAGE_0>");
});

test("adding a first frame shifts existing references but keeps their identity", () => {
  const prompt = `${at("fox.png")} walks`;
  assert.equal(compileVideoPrompt(prompt, [ref("fox.png")]), "<IMAGE_0> walks");
  assert.equal(
    compileVideoPrompt(prompt, [{ assetName: "city.png", role: "first" }, ref("fox.png")]),
    "<IMAGE_1> walks",
  );
});

test("a reference promoted to first frame makes its @ stale and blocks compile", () => {
  const inputs = [{ assetName: "fox.png", role: "first" }];
  const prompt = `${at("fox.png")} walks`;
  assert.deepEqual(staleVideoReferences(prompt, inputs), ["fox.png"]);
  assert.throws(() => compileVideoPrompt(prompt, inputs), /已不在参考区/);
});

test("a removed reference is reported stale, not silently retargeted", () => {
  const prompt = `${at("fox.png")} meets ${at("dog.png")}`;
  assert.deepEqual(staleVideoReferences(prompt, [ref("dog.png")]), ["fox.png"]);
  assert.throws(() => compileVideoPrompt(prompt, [ref("dog.png")]), /已不在参考区/);
});

test("new connections default to first frame, then reference; last is never auto-assigned", () => {
  assert.equal(defaultNewVideoRole([]), "first");
  assert.equal(defaultNewVideoRole([ref("r0.png")]), "first");
  assert.equal(defaultNewVideoRole([{ assetName: "a.png", role: "first" }]), "reference");
  const sevenRefs = Array.from({ length: VIDEO_REFERENCE_MAX }, (_, index) => ref(`r${index}.png`));
  // 参考满员但首帧空：仍补首帧
  assert.equal(defaultNewVideoRole(sevenRefs), "first");
  // 首帧已占且参考满员：只剩尾帧空位也不自动分配，连线被拒绝
  assert.equal(defaultNewVideoRole([...sevenRefs, { assetName: "a.png", role: "first" }]), null);
  assert.equal(defaultNewVideoRole([
    ...sevenRefs,
    { assetName: "a.png", role: "first" },
    { assetName: "b.png", role: "last" },
  ]), null);
});

test("setVideoSlotRole swaps unique roles and blocks a full reference row", () => {
  const slots = [
    { key: "first", role: "first", assetName: "a.png", name: "A" },
    { key: "ref", role: "reference", assetName: "b.png", name: "B" },
  ];
  const promoted = setVideoSlotRole(slots, "ref", "first");
  assert.equal(promoted[0]?.role, "reference");
  assert.equal(promoted[1]?.role, "first");
  assert.deepEqual(videoInputsFromSlots(promoted), [
    { assetName: "a.png", role: "reference" },
    { assetName: "b.png", role: "first" },
  ]);

  const swapped = setVideoSlotRole(
    [
      { key: "first", role: "first", assetName: "a.png", name: "A" },
      { key: "last", role: "last", assetName: "b.png", name: "B" },
    ],
    "last",
    "first",
  );
  assert.equal(swapped[0]?.role, "last");
  assert.equal(swapped[1]?.role, "first");

  const fullRefs = Array.from({ length: VIDEO_REFERENCE_MAX }, (_, index) => ({
    key: `r${index}`,
    role: "reference",
    assetName: `r${index}.png`,
    name: `R${index}`,
  }));
  const first = { key: "first", role: "first", assetName: "a.png", name: "A" };
  assert.equal(setVideoSlotRole([first, ...fullRefs], "first", "reference")[0]?.role, "first");
});

test("moveVideoSlot swaps roles across roles and inserts within the reference row", () => {
  const slots = [
    { key: "first", role: "first", assetName: "a.png", name: "A" },
    { key: "r1", role: "reference", assetName: "b.png", name: "B" },
    { key: "r2", role: "reference", assetName: "c.png", name: "C" },
    { key: "r3", role: "reference", assetName: "d.png", name: "D" },
  ];
  // 跨角色：对调角色，位置不动
  const swapped = moveVideoSlot(slots, "r2", "first");
  assert.equal(swapped[0]?.role, "reference");
  assert.equal(swapped[2]?.role, "first");
  assert.deepEqual(swapped.map((slot) => slot.key), ["first", "r1", "r2", "r3"]);

  // 同角色：拖到目标前/后插入，其余顺移
  const before = moveVideoSlot(slots, "r3", "r1", "before");
  assert.deepEqual(before.map((slot) => slot.key), ["first", "r3", "r1", "r2"]);
  const after = moveVideoSlot(slots, "r1", "r3", "after");
  assert.deepEqual(after.map((slot) => slot.key), ["first", "r2", "r3", "r1"]);

  // 拖到自身或未知 key：不变
  assert.equal(moveVideoSlot(slots, "r1", "r1"), slots);
  assert.equal(moveVideoSlot(slots, "nope", "r1"), slots);
});

test("reordering references renumbers <IMAGE_n> while @ keeps its identity", () => {
  const prompt = `${at("b.png")} 与 ${at("d.png")}`;
  const ordered = moveVideoSlot(
    [{ key: "r1", role: "reference", assetName: "b.png", name: "B" },
     { key: "r2", role: "reference", assetName: "c.png", name: "C" },
     { key: "r3", role: "reference", assetName: "d.png", name: "D" }],
    "r3", "r1", "before",
  );
  const inputs = videoInputsFromSlots(ordered);
  assert.deepEqual(inputs.map((input) => input.assetName), ["d.png", "b.png", "c.png"]);
  assert.equal(compileVideoPrompt(prompt, inputs), "<IMAGE_1> 与 <IMAGE_0>");
});

test("reference count is capped and roles are exclusive", () => {
  const eight = Array.from({ length: VIDEO_REFERENCE_MAX + 1 }, (_, index) => ref(`r${index}.png`));
  assert.throws(() => referenceTokenMap(eight), /参考图最多 7 张/);
  assert.throws(() => referenceTokenMap([{ assetName: "a.png", role: "first" }, ref("a.png")]), /不能兼任/);
  assert.throws(
    () => referenceTokenMap([{ assetName: "a.png", role: "first" }, { assetName: "b.png", role: "first" }]),
    /首帧最多一张/,
  );
});
