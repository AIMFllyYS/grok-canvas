import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile like tests/oauth.test.mjs: the batch module imports ./assets,
// which strip-only mode cannot resolve without an extension.
const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-generation-batch-"));
after(() => rm(temporary, { recursive: true, force: true }));
await writeFile(path.join(temporary, "package.json"), '{"type":"module"}');
await mkdir(path.join(temporary, "media"), { recursive: true });
for (const name of ["assets", "data-dir", "generation-batch", "media/asset-publication"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  await writeFile(path.join(temporary, `${name}.js`), output.replace(/from "(\.\/[^".]+)"/g, 'from "$1.js"'));
}

// The store resolves data paths at import time. Tests never touch the user's data.
process.env.GROK_CANVAS_DATA_DIR = temporary;
const { GENERATIONS_DIR, readGenerationRecord } = await import(pathToFileURL(path.join(temporary, "assets.js")).href);
const { BatchProtocolError, persistImageBatch } = await import(pathToFileURL(path.join(temporary, "generation-batch.js")).href);

const snapshot = () => ({
  originalPrompt: "画四只猫",
  submittedPrompt: "画四只猫",
  model: "test-model",
  mode: "t2i",
  parameters: { aspectRatio: "1:1", resolution: "1k", quality: "low" },
  referenceAssets: [],
  startedAt: "2026-09-14T00:00:00.000Z",
});

const download = async (url) => {
  if (String(url).includes("broken")) return new Response(null, { status: 502 });
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
};

const images = (count) => Array.from({ length: count }, (_, index) => ({ url: `https://unused.invalid/${crypto.randomUUID()}/${index}` }));

test("four images persist independently with the batch count in each record", async () => {
  const request = snapshot();
  const slots = await persistImageBatch(images(4), 4, request, download);
  assert.equal(slots.length, 4);
  const names = new Set();
  for (const slot of slots) {
    assert.equal(slot.status, "success");
    assert.match(slot.asset.name, /\.png$/);
    names.add(slot.asset.name);
    const record = await readGenerationRecord(slot.asset.name);
    assert.equal(record.parameters.count, 4);
    assert.equal(record.originalPrompt, "画四只猫");
    assert.deepEqual(record.parameters.aspectRatio, "1:1");
  }
  assert.equal(names.size, 4);
  request.parameters.quality = "mutated after save";
  const record = await readGenerationRecord(slots[0].asset.name);
  assert.equal(record.parameters.quality, "low");
});

test("one failed download only marks its own slot", async () => {
  const slots = await persistImageBatch(
    [{ url: "https://unused.invalid/ok-1" }, { url: "https://unused.invalid/broken" }, { url: "https://unused.invalid/ok-2" }],
    4,
    snapshot(),
    download,
  );
  assert.deepEqual(slots.map(slot => slot.status), ["success", "failed", "success", "failed"]);
  assert.match(slots[1].error, /图片保存失败/);
  assert.match(slots[3].error, /上游未返回第 4 张图片/);
  for (const slot of [slots[0], slots[2]]) {
    assert.ok(await readGenerationRecord(slot.asset.name));
  }
});

test("missing upstream images become failed slots without blocking saved ones", async () => {
  const slots = await persistImageBatch(images(2), 4, snapshot(), download);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map(slot => slot.status), ["success", "success", "failed", "failed"]);
  assert.equal(slots[2].error, "上游未返回第 3 张图片");
  assert.equal(slots[3].error, "上游未返回第 4 张图片");
});

test("an empty upstream response fails the whole batch", async () => {
  const before = await readdir(GENERATIONS_DIR).catch(() => []);
  await assert.rejects(persistImageBatch([], 2, snapshot(), download), BatchProtocolError);
  await assert.rejects(persistImageBatch([], 2, snapshot(), download), /上游未返回任何图片/);
  assert.deepEqual(await readdir(GENERATIONS_DIR).catch(() => []), before);
});

test("more images than requested is a protocol error and nothing is saved", async () => {
  const before = await readdir(GENERATIONS_DIR).catch(() => []);
  await assert.rejects(persistImageBatch(images(5), 4, snapshot(), download), BatchProtocolError);
  await assert.rejects(persistImageBatch(images(5), 4, snapshot(), download), /上游返回 5 张图片，超过请求的 4 张/);
  assert.deepEqual(await readdir(GENERATIONS_DIR).catch(() => []), before);
});
