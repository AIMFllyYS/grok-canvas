import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const data = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-store-"));
process.env.GROK_CANVAS_DATA_DIR = data;
const loaded = await loadTypescript("lib/canvas-store.ts");
const operations = await loadTypescript("lib/canvas-operations.ts");
after(async () => { await loaded.dispose(); await operations.dispose(); await rm(data, { recursive: true, force: true }); });
const { emptyCanvas, saveCanvas, loadCanvas, deleteCanvas, updateCanvas } = loaded.module;
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
test("并发原子修改基于最新画布且失败不写入", async () => {
  await saveCanvas(emptyCanvas("atomic"), -1);
  await Promise.all(Array.from({ length: 20 }, (_, index) => updateCanvas("atomic", doc => {
    doc.nodes.push({ id: `node-${index}` });
  })));
  const before = await loadCanvas("atomic");
  assert.equal(before.nodes.length, 20);
  assert.equal(new Set(before.nodes.map(node => node.id)).size, 20);
  await assert.rejects(updateCanvas("atomic", doc => {
    doc.nodes.length = 0;
    throw new Error("invalid edit");
  }), /invalid edit/);
  assert.deepEqual(await loadCanvas("atomic"), before);
});
test("删除后旧版本保存不能复活画布", async () => {
  const doc = await saveCanvas(emptyCanvas("deleted"), -1);
  await deleteCanvas(doc.id);
  assert.equal(await saveCanvas(doc, doc.revision), null);
  assert.equal(await loadCanvas(doc.id), null);
});
test("受保护画布拒绝删除且保留原数据", async () => {
  const doc = await saveCanvas(emptyCanvas("busy-delete"), -1);
  await assert.rejects(deleteCanvas(doc.id, () => false), /Agent 正在运行/);
  assert.deepEqual(await loadCanvas(doc.id), doc);
  assert.equal(await deleteCanvas(doc.id, () => true), true);
});
test("操作重试去重记录随画布持久化，旧客户端保存不清除记录", async () => {
  await saveCanvas(emptyCanvas("operations"), -1);
  const change = { id: "op-a", target: "canvas", path: ["name"], before: { exists: true, value: "未命名画布" }, after: { exists: true, value: "新画布" } };
  const first = await updateCanvas("operations", doc => Object.assign(doc, operations.module.applyCanvasOperations(doc, [change])));
  const { appliedOperationIds: ignored, ...oldClient } = first;
  await saveCanvas(oldClient, first.revision);
  const retried = await updateCanvas("operations", doc => Object.assign(doc, operations.module.applyCanvasOperations(doc, [change])));
  assert.equal(retried.name, "新画布");
  assert.deepEqual(retried.appliedOperationIds, ["op-a"]);
});
