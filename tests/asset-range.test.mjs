import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-range-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const range = await loadTypescript("lib/media/range.ts");
const stream = await loadTypescript("lib/media/asset-stream.ts");
after(async () => { await range.dispose(); await stream.dispose(); await rm(dataDir, { recursive: true, force: true }); });
const { parseSingleRange, assetEtag, ifRangeAllows } = range.module;
const { assetResponse } = stream.module;
const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
await mkdir(path.join(dataDir, "assets"), { recursive: true });
await writeFile(path.join(dataDir, "assets", "clip.mp4"), bytes);
const get = (headers = {}, name = "clip.mp4", head = false) => assetResponse(new Request(`http://127.0.0.1:3210/api/assets/${name}`, { headers, method: head ? "HEAD" : "GET" }), name, { head });

test("Range 矩阵（1000 字节）：纯解析，不碰文件", () => {
  const cases = [
    [undefined, { kind: "full" }],
    ["", { kind: "full" }],
    ["bytes=0-0", { kind: "partial", start: 0, end: 0 }],
    ["bytes=100-", { kind: "partial", start: 100, end: 999 }],
    ["bytes=-100", { kind: "partial", start: 900, end: 999 }],
    ["bytes=999-999", { kind: "partial", start: 999, end: 999 }],
    ["bytes=0-99999", { kind: "partial", start: 0, end: 999 }],
    ["bytes=-5000", { kind: "partial", start: 0, end: 999 }],
    ["bytes=1000-", { kind: "unsatisfiable" }],
    ["bytes=100-50", { kind: "unsatisfiable" }],
    ["bytes=0-1,5-9", { kind: "unsatisfiable" }],
    ["bytes=abc-", { kind: "unsatisfiable" }],
    ["bytes=-", { kind: "unsatisfiable" }],
    ["bytes=-0", { kind: "unsatisfiable" }],
    ["items=0-1", { kind: "unsatisfiable" }],
    ["bytes=99999999999999999999-", { kind: "unsatisfiable" }],
  ];
  for (const [header, expected] of cases) assert.deepEqual(parseSingleRange(header, 1000), expected, String(header));
  assert.deepEqual(parseSingleRange("bytes=0-0", 0), { kind: "unsatisfiable" });
  assert.throws(() => parseSingleRange("bytes=0-0", Number.MAX_SAFE_INTEGER + 2));
});

test("GET：完整 200 带准确长度；0-0 返回 1 字节与 Content-Range；-100 返回最后 100 字节", async () => {
  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), "1000");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  const first = await get({ range: "bytes=0-0" });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-0/1000");
  assert.equal(first.headers.get("content-length"), "1");
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [0]);
  const tail = await get({ range: "bytes=-100" });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), "bytes 900-999/1000");
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.slice(900));
});

test("越界/反向/多 range 明确 416 且带 bytes */size；HEAD body 为空但长度正确", async () => {
  for (const header of ["bytes=1000-", "bytes=100-50", "bytes=0-1,2-3"]) {
    const response = await get({ range: header });
    assert.equal(response.status, 416, header);
    assert.equal(response.headers.get("content-range"), "bytes */1000");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const head = await get({}, "clip.mp4", true);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "1000");
  assert.equal(head.body, null, "HEAD 不创建 body 流");
  const headPartial = await get({ range: "bytes=10-19" }, "clip.mp4", true);
  assert.equal(headPartial.status, 206);
  assert.equal(headPartial.headers.get("content-length"), "10");
  assert.equal(headPartial.body, null);
});

test("ETag 依据不可变文件；If-Range 不匹配返回完整 200；If-None-Match 命中 304", async () => {
  const full = await get();
  const etag = full.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  await full.arrayBuffer();
  assert.equal(ifRangeAllows(undefined, etag), true);
  assert.equal(ifRangeAllows('"other"', etag), false);
  const stale = await get({ range: "bytes=0-9", "if-range": '"other"' });
  assert.equal(stale.status, 200, "If-Range 不匹配回退完整内容");
  assert.equal((await stale.arrayBuffer()).byteLength, 1000);
  const fresh = await get({ range: "bytes=0-9", "if-range": etag });
  assert.equal(fresh.status, 206);
  await fresh.arrayBuffer();
  const cached = await get({ "if-none-match": etag });
  assert.equal(cached.status, 304);
  assert.equal(assetEtag(1000, 5), '"3e8-5"');
});

test("大文件不整读：中途取消读取后文件句柄释放，Windows 下可立即重命名", async () => {
  const big = path.join(dataDir, "assets", "big.mp4");
  await writeFile(big, new Uint8Array(8 * 1024 * 1024));
  let handle = null;
  const response = await assetResponse(new Request("http://127.0.0.1:3210/api/assets/big.mp4"), "big.mp4", { onStream: h => { handle = h; } });
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  assert.ok(firstChunk.value.byteLength > 0 && firstChunk.value.byteLength < 8 * 1024 * 1024, "按块读取");
  await reader.cancel();
  await handle.closed;
  await rename(big, `${big}.moved`);
  await rename(`${big}.moved`, big);
  const controller = new AbortController();
  let second = null;
  const aborted = await assetResponse(new Request("http://127.0.0.1:3210/api/assets/big.mp4", { signal: controller.signal }), "big.mp4", { onStream: h => { second = h; } });
  const reader2 = aborted.body.getReader();
  await reader2.read();
  controller.abort();
  await second.closed;
  await rename(big, `${big}.moved2`);
});

test("名称校验保留：路径穿越与伪造名 404；不存在 404；源码不再 readFile", async () => {
  for (const name of ["../secret.txt", "..%2Fsecret", "a/b.png", "C:\\x.png", "missing.png"]) assert.equal((await get({}, name)).status, 404, name);
  const route = await readFile(new URL("../app/api/assets/[name]/route.ts", import.meta.url), "utf8");
  const module = await readFile(new URL("../lib/media/asset-stream.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route + module, /readFile/);
  assert.match(module, /isSafeAssetName/);
});
