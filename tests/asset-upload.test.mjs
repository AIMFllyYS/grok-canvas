import test from "node:test";
import assert from "node:assert/strict";
import { validateUpload, uploadAssets, MAX_IMAGE_BYTES } from "../lib/asset-upload.ts";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test("上传验证检查空文件、大小、类型和签名", () => {
  assert.equal(validateUpload({ type: "image/png", size: png.length }, png), null);
  assert.match(validateUpload({ type: "image/png", size: 0 }, new Uint8Array()), /空/);
  assert.match(validateUpload({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }, png), /20/);
  assert.match(validateUpload({ type: "image/jpeg", size: png.length }, png), /匹配/);
});
test("批量上传并发最多2个，部分失败不丢成功项", async () => {
  let running = 0, maximum = 0, calls = 0;
  const files = Array.from({ length: 5 }, (_, i) => new File([png], `${i}.png`, { type: "image/png" }));
  const results = await uploadAssets(files, { fetch: async (_url, init) => {
    running++; maximum = Math.max(maximum, running); calls++;
    const file = init.body.get("files");
    await new Promise(resolve => setTimeout(resolve, 5)); running--;
    if (file.name === "2.png") return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ assets: [{ name: `asset-${file.name}`, originalName: file.name }], rejected: [] }));
  } });
  assert.equal(maximum, 2); assert.equal(calls, 5);
  assert.equal(results.filter(item => item.state === "success").length, 4);
  assert.equal(results[2].state, "failed");
});
test("非法响应和HTTP错误明确失败", async () => {
  for (const response of [new Response("bad"), new Response("large", { status: 413 }), new Response(JSON.stringify({ assets: [], rejected: [{ reason: "不支持" }] }))]) {
    const results = await uploadAssets([new File([png], "a.png", { type: "image/png" })], { fetch: async () => response });
    assert.equal(results[0].state, "failed"); assert.ok(results[0].error);
  }
});
