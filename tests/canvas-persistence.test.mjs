import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const loaded = await loadTypescript("lib/canvas-persistence.ts"); after(loaded.dispose);
const { persistImageOutcome, persistVideoOutcome, postServiceWrite } = loaded.module;
const outcome = { kind: "result", generationId: "g", retrySlotId: null, prompt: "p", slots: [{ status: "success", asset: { name: "new.png" } }] };

function harness(responses) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift() ?? { status: 200, body: { status: "applied" } };
    return new Response(next.body === null ? null : JSON.stringify(next.body), { status: next.status });
  } };
}

test("后台图片回写只 POST 一次服务端结果登记，不再 GET 整图再 diff", async () => {
  const h = harness([]);
  await persistImageOutcome("a", "n", outcome, h);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { url: "/api/canvases/a/service-write", method: "POST", body: { action: "image", nodeId: "n", outcome } });
});

test("视频回写只提交 taskId，结果由服务端读取任务记录生成", async () => {
  const h = harness([]);
  await persistVideoOutcome("a", "v", { taskId: "t1", requestId: "r", canvasId: "a", nodeId: "v", status: "completed", waitedSeconds: 3, result: { assetName: "fake.mp4", localUrl: "", bytes: 1 }, error: null }, h);
  assert.deepEqual(h.calls[0].body, { action: "video", nodeId: "v", taskId: "t1" }, "浏览器传来的结果视图不被信任");
});

test("节点已删：服务端返回 orphan 时回调暂存；画布已删 404 不抛错也不重建", async () => {
  let orphaned = 0;
  const h = harness([{ status: 200, body: { status: "orphan" } }, { status: 404, body: { status: "canvas_deleted" } }]);
  await persistImageOutcome("a", "n", outcome, { ...h, orphan: () => orphaned++ });
  assert.equal(orphaned, 1);
  assert.equal(await postServiceWrite("a", { action: "image", nodeId: "n", outcome }, h), "canvas_deleted");
});

test("租约等暂时性冲突重试同一请求；确定性拒绝直接报错", async () => {
  const h = harness([{ status: 423, body: { error: { code: "lease_conflict", message: "占用", retryAfterMs: 1 } } }, { status: 200, body: { status: "applied" } }]);
  assert.equal(await postServiceWrite("a", { action: "image", nodeId: "n", outcome }, h), "applied");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].body, h.calls[1].body);
  const rejected = harness([{ status: 400, body: { error: { message: "生成结果没有服务端生成记录，拒绝登记" } } }]);
  await assert.rejects(postServiceWrite("a", { action: "image", nodeId: "n", outcome }, rejected), /生成记录/);
  assert.equal(rejected.calls.length, 1);
});
