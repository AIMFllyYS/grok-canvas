import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const data = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-store-"));
process.env.GROK_CANVAS_DATA_DIR = data;
const loaded = await loadTypescript("lib/canvas-store.ts");
after(async () => { await loaded.dispose(); await rm(data, { recursive: true, force: true }); });
const { emptyCanvas, saveCanvas, loadCanvas, deleteCanvas } = loaded.module;
const item = { assetName: "a.png", name: "A", sources: ["imported"], addedAt: "2026-10-25T00:00:00Z" };

test("新画布空库、旧客户端省略目录不能清空", async () => {
  assert.deepEqual(emptyCanvas("a").libraryAssets, []);
  const doc = await saveCanvas({ ...emptyCanvas("a"), libraryAssets: [item] }, -1);
  const { libraryAssets: _library, ...old } = doc;
  const saved = await saveCanvas(old, doc.revision);
  assert.deepEqual(saved.libraryAssets, [item]);
});
test("同一revision并发保存仅一个成功", async () => {
  const doc = await saveCanvas(emptyCanvas("race"), -1);
  const values = await Promise.all([saveCanvas({ ...doc, name: "first" }, doc.revision), saveCanvas({ ...doc, name: "second" }, doc.revision)]);
  assert.equal(values.filter(Boolean).length, 1);
});
test("删除后旧版本保存不能复活画布", async () => {
  const doc = await saveCanvas(emptyCanvas("deleted"), -1);
  await deleteCanvas(doc.id);
  assert.equal(await saveCanvas(doc, doc.revision), null);
  assert.equal(await loadCanvas(doc.id), null);
});
