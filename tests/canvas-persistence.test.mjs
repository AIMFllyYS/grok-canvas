import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/canvas-persistence.ts"); after(loaded.dispose);
const { persistImageOutcome, persistVideoOutcome } = loaded.module;
const initial = () => ({ id: "a", name: "A", revision: 1, createdAt: "2026-10-25T00:00:00Z", viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [{ id: "n", type: "image", data: { generationId: "g" } }], libraryAssets: [{ assetName: "old.png", name: "old", sources: ["imported"], addedAt: "2026-10-25T00:00:00Z" }] });
const outcome = { kind: "result", generationId: "g", retrySlotId: null, prompt: "p", slots: [{ status: "success", asset: { name: "new.png" } }] };
function harness(doc = initial(), conflict = false) {
  const calls = [];
  let value = structuredClone(doc), puts = 0;
  return { calls, current: () => value, fetch: async (url, init) => {
    calls.push(url);
    assert.ok(String(url).startsWith("/api/canvases/a"));
    if (!init?.method) { assert.ok(String(url).includes("background=1")); return new Response(JSON.stringify(value)); }
    const body = JSON.parse(init.body); puts++;
    if (conflict && puts === 1) { value.name = "用户的新标题"; value.revision++; return new Response(null, { status: 409 }); }
    value = { ...body, revision: value.revision + 1 };
    return new Response(JSON.stringify(value));
  } };
}
test("后台图片回写保留旧目录并登记新候选，不访问B画布", async () => {
  const h = harness(); await persistImageOutcome("a", "n", outcome, h);
  assert.deepEqual(h.current().libraryAssets.map(a => a.assetName), ["old.png", "new.png"]);
  assert.equal(h.current().nodes[0].data.assetName, "new.png");
});
test("409重取后保留用户新标题和目录", async () => {
  const h = harness(initial(), true); await persistImageOutcome("a", "n", outcome, h);
  assert.equal(h.current().name, "用户的新标题");
  assert.equal(h.calls.length, 4);
});
test("节点已删仍登记图片并保留orphan，不复活节点", async () => {
  const doc = initial(); doc.nodes = [];
  let orphan = false;
  const h = harness(doc); await persistImageOutcome("a", "n", outcome, { ...h, orphan: () => { orphan = true; } });
  assert.equal(orphan, true); assert.equal(h.current().nodes.length, 0); assert.equal(h.current().libraryAssets.length, 2);
});
test("过期图片任务仍入库，但不能覆盖较新的任务状态", async () => {
  const doc = initial(); doc.nodes[0].data.generationId = "newer";
  const h = harness(doc); await persistImageOutcome("a", "n", outcome, h);
  assert.equal(h.current().nodes[0].data.generationId, "newer");
  assert.equal(h.current().nodes[0].data.assetName, undefined);
  assert.deepEqual(h.current().libraryAssets.map(a => a.assetName), ["old.png", "new.png"]);
});
test("回写磁盘失败明确抛错，不伪装保存成功", async () => {
  const h = harness();
  await assert.rejects(persistImageOutcome("a", "n", outcome, { fetch: (url, init) => init.method === "PUT" ? Promise.resolve(new Response(null, { status: 500 })) : h.fetch(url, init) }), /写回原画布失败/);
});
test("整张画布删除后不发送PUT", async () => {
  await persistImageOutcome("a", "n", outcome, { fetch: async (_url, init) => { assert.equal(init.method, undefined); return new Response(null, { status: 404 }); } });
});
test("后台视频回写保留图片目录，不将mp4放入库", async () => {
  const doc = initial(); doc.nodes = [{ id: "n", type: "video", data: { taskId: "task", status: "running" } }];
  const h = harness(doc);
  await persistVideoOutcome("a", "n", { taskId: "task", requestId: "request", canvasId: "a", nodeId: "n", status: "completed", waitedSeconds: 2, result: { assetName: "video.mp4", localUrl: "/api/assets/video.mp4", bytes: 42 }, error: null }, h);
  assert.deepEqual(h.current().libraryAssets.map(a => a.assetName), ["old.png"]);
  assert.equal(h.current().nodes[0].data.assetName, "video.mp4");
  assert.equal(h.current().nodes[0].data.status, "idle");
});
