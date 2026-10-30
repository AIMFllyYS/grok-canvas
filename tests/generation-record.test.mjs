import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile like tests/oauth.test.mjs: assets imports ./data-dir,
// which strip-only mode cannot resolve without an extension.
const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-generation-record-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
await mkdir(path.join(temporary, "media"), { recursive: true });
for (const name of ["assets", "data-dir", "media/asset-publication"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(path.join(temporary, `${name}.js`), output.replace(/from "(\.\/[^".]+)"/g, 'from "$1.js"'));
}

// The store resolves data paths at import time. Tests never touch the user's data.
process.env.GROK_CANVAS_DATA_DIR = temporary;
const { ASSETS_DIR, GENERATIONS_DIR, saveRemoteAsset, saveBufferAsset, saveGenerationRecord, readGenerationRecord } = await import(pathToFileURL(path.join(temporary, "assets.js")).href);

const snapshot = () => ({
  originalPrompt: "参考 @素材 的服装",
  submittedPrompt: "参考 image 1 的服装",
  model: "test-model",
  mode: "i2i",
  parameters: { aspectRatio: "3:4", resolution: "2k", quality: "medium" },
  referenceAssets: ["reference-b.png", "reference-a.jpeg"],
  startedAt: "2026-09-13T00:00:00.000Z",
});
const download = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });

test("generated image retains its exact independent request snapshot", async () => {
  const request = snapshot();
  const asset = await saveRemoteAsset("https://unused.invalid/image", "jpeg", download, request);
  assert.match(asset.name, /\.png$/);
  assert.deepEqual([...await readFile(path.join(ASSETS_DIR, asset.name))], [1, 2, 3]);
  request.originalPrompt = "deleted draft";
  request.referenceAssets.reverse();
  const record = await readGenerationRecord(asset.name);
  assert.deepEqual(record, { ...snapshot(), schemaVersion: 1, assetName: asset.name, savedAt: record.savedAt });
  assert.ok(Number.isFinite(Date.parse(record.savedAt)));
  await assert.rejects(saveGenerationRecord(asset.name, request), { code: "EEXIST" });
  assert.deepEqual(await readGenerationRecord(asset.name), record);
});

test("uploads and old images do not receive invented generation history", async () => {
  const asset = await saveBufferAsset(new Uint8Array([4]), "image/jpeg");
  assert.equal(await readGenerationRecord(asset.name), null);
  assert.equal(await readGenerationRecord("old-image.png"), null);
});

test("one of two competing record writes wins without overwriting or partial JSON", async () => {
  const results = await Promise.allSettled([
    saveGenerationRecord("same-image.png", snapshot()),
    saveGenerationRecord("same-image.png", { ...snapshot(), originalPrompt: "second" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.ok(await readGenerationRecord("same-image.png"));
  assert.equal((await readdir(GENERATIONS_DIR)).some(name => name.endsWith(".tmp")), false);
});

test("download failures create neither image nor record", async () => {
  const before = await readdir(GENERATIONS_DIR);
  const images = await readdir(ASSETS_DIR);
  await assert.rejects(saveRemoteAsset("https://unused.invalid/image", "jpeg", async () => new Response(null, { status: 502 }), snapshot()));
  assert.deepEqual(await readdir(GENERATIONS_DIR), before);
  assert.deepEqual(await readdir(ASSETS_DIR), images);
});

test("record storage failure prevents publishing an image without its prompt", async () => {
  const backup = `${GENERATIONS_DIR}-backup`;
  const before = await readdir(ASSETS_DIR);
  await rename(GENERATIONS_DIR, backup);
  try {
    await writeFile(GENERATIONS_DIR, "not a directory");
    await assert.rejects(saveRemoteAsset("https://unused.invalid/image", "jpeg", download, snapshot()));
    assert.deepEqual(await readdir(ASSETS_DIR), before);
  } finally {
    await rm(GENERATIONS_DIR, { force: true });
    await rename(backup, GENERATIONS_DIR);
  }
});

test("unsafe names cannot read or write outside the record directory", async () => {
  await assert.rejects(readGenerationRecord("../private.json"), /unsafe/);
  await assert.rejects(saveGenerationRecord("../private.json", snapshot()), /unsafe/);
});

const videoSnapshot = () => ({
  originalPrompt: "[[image:fox.png]] 跑向湖边",
  submittedPrompt: "<IMAGE_0> 跑向湖边",
  model: "grok-imagine-video-1.5",
  mode: "i2v",
  parameters: { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true },
  referenceAssets: ["fox.png"],
  firstFrame: null,
  lastFrame: null,
  startedAt: "2026-09-15T00:00:00.000Z",
});

test("a completed video keeps its exact snapshot: roles, order, both prompts", async () => {
  const request = videoSnapshot();
  const videoDownload = async () => new Response(new Uint8Array([7, 7, 7]), { headers: { "content-type": "video/mp4" } });
  const asset = await saveRemoteAsset("https://unused.invalid/clip", "mp4", videoDownload, request);
  assert.match(asset.name, /\.mp4$/);
  request.referenceAssets.length = 0;
  const record = await readGenerationRecord(asset.name);
  assert.deepEqual(record, { ...videoSnapshot(), schemaVersion: 1, assetName: asset.name, savedAt: record.savedAt });
  assert.equal(record.submittedPrompt, "<IMAGE_0> 跑向湖边");
});
