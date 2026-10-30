import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 临时数据目录 + 合成小图片：不读真实用户媒体，CI 不下载任何媒体。
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-derivatives-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const assetsDir = path.join(dataDir, "assets");
await mkdir(assetsDir, { recursive: true });
const derivatives = await loadTypescript("lib/media/derivatives.ts");
const metadata = await loadTypescript("lib/media/metadata.ts");
const workerPath = path.join(repoRoot, "lib", "media", "derivative-worker.cjs");
const services = [];
const service = (options = {}) => { const s = derivatives.module.createDerivativeService({ workerPath, ...options }); services.push(s); return s; };
after(async () => {
  for (const s of services) await s.close();
  await derivatives.dispose(); await metadata.dispose();
  await rm(dataDir, { recursive: true, force: true });
});
const { DerivativeError, derivativeUrl } = derivatives.module;
const put = async (name, bytes) => { await writeFile(path.join(assetsDir, name), bytes); return name; };
const png = (width, height, alpha = true) => sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 128, b: 255, alpha: 0.4 } : { r: 10, g: 20, b: 30 } } }).png().toBuffer();
const outMeta = async (status, assetName, variant) => sharp(await readFile(path.join(dataDir, "derivatives", `${assetName}.${variant}.${status.sourceHash}.webp`))).metadata();

/** 只写 IHDR 的 PNG：声明 20000×20000，像素数超限；不需要真的分配大图。 */
function bombPng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))), chunk("IEND", Buffer.alloc(0))]);
}

test("长边 256/1024、比例不变、透明保留、EXIF 方向校正；不放大小图", async () => {
  const s = service();
  await put("wide.png", await png(800, 400));
  await put("tall.webp", await sharp({ create: { width: 300, height: 900, channels: 3, background: "#336699" } }).webp().toBuffer());
  // 存储 400×200、EXIF 方向 6（顺时针 90°）→ 显示 200×400。
  await put("rotated.jpeg", await sharp({ create: { width: 400, height: 200, channels: 3, background: "#aa3300" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const wide256 = await s.requestDerivative("wide.png", "thumb256", { wait: true });
  assert.deepEqual([wide256.status, wide256.width, wide256.height], ["ready", 256, 128]);
  assert.equal((await outMeta(wide256, "wide.png", "thumb256")).hasAlpha, true, "透明通道保留");
  const wide1024 = await s.requestDerivative("wide.png", "thumb1024", { wait: true });
  assert.deepEqual([wide1024.width, wide1024.height], [800, 400], "不放大");
  const tall = await s.requestDerivative("tall.webp", "thumb256", { wait: true });
  assert.deepEqual([tall.width, tall.height], [85, 256]);
  const rotated = await s.requestDerivative("rotated.jpeg", "thumb256", { wait: true });
  assert.deepEqual([rotated.width, rotated.height], [128, 256], "按 EXIF 方向旋转后再缩放");
  const meta = await s.metadata("rotated.jpeg");
  assert.deepEqual([meta.width, meta.height, meta.orientation], [200, 400, 6]);
  assert.equal(wide256.url, "/api/assets/wide.png/derivative/thumb256", "稳定 URL");
  const { fitLongEdge, orientedSize, placeholderBox, variantForDisplay } = metadata.module;
  assert.deepEqual(fitLongEdge({ width: 800, height: 400 }, 256), { width: 256, height: 128 });
  assert.deepEqual(orientedSize({ width: 400, height: 200 }, 6), { width: 200, height: 400 });
  assert.deepEqual(placeholderBox({ width: 320, height: 320 }, { width: 800, height: 400 }), { width: 320, height: 160 }, "pending 时按已知比例的固定几何占位");
  assert.equal(variantForDisplay(200, 1), "thumb256");
  assert.equal(variantForDisplay(200, 2), "thumb1024");
});

test("同 key 100 个并发请求只处理 1 次；已 ready 的不再排队", async () => {
  const s = service();
  await put("dedupe.png", await png(640, 480, false));
  const pending = await s.requestDerivative("dedupe.png", "thumb256");
  assert.equal(pending.status, "pending");
  const results = await Promise.all(Array.from({ length: 100 }, () => s.requestDerivative("dedupe.png", "thumb256", { wait: true })));
  assert.ok(results.every(r => r.status === "ready" && r.width === 256 && r.height === 192));
  assert.equal(s.stats().processed, 1);
  await s.requestDerivative("dedupe.png", "thumb256", { wait: true });
  assert.equal(s.stats().processed, 1, "已 ready 直接返回");
  const files = (await readdir(path.join(dataDir, "derivatives"))).filter(f => f.startsWith("dedupe.png.thumb256."));
  assert.deepEqual(files.map(f => f.endsWith(".webp") || f.endsWith(".json")), [true, true], "同 key 只有一个产物与一份元数据，无临时文件残留");
});

test("源 hash 改变使用新派生；旧引用的产物不被新内容覆盖", async () => {
  const s = service();
  await put("changing.png", await png(512, 512, false));
  const first = await s.requestDerivative("changing.png", "thumb256", { wait: true });
  const oldFile = path.join(dataDir, "derivatives", `changing.png.thumb256.${first.sourceHash}.webp`);
  const oldBytes = await readFile(oldFile);
  await new Promise(resolve => setTimeout(resolve, 20));
  await put("changing.png", await png(1000, 250, false));
  const second = await s.requestDerivative("changing.png", "thumb256", { wait: true });
  assert.notEqual(second.sourceHash, first.sourceHash);
  assert.deepEqual([second.width, second.height], [256, 64]);
  assert.deepEqual(await readFile(oldFile), oldBytes, "旧 key 的文件内容不变");
});

test("坏图片 failed 不伪 ready，持久化且不自动重试；显式 retry 重新排队；压缩炸弹按像素上限拒绝；源素材不受影响", async () => {
  const s = service();
  await put("broken.png", "这不是图片");
  const failed = await s.requestDerivative("broken.png", "thumb256", { wait: true });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "invalid_image");
  assert.equal(failed.retry, derivativeUrl("broken.png", "thumb256"));
  const processed = s.stats().processed;
  const again = await s.requestDerivative("broken.png", "thumb256", { wait: true });
  assert.equal(again.status, "failed", "失败被记住，不自动无限重试");
  assert.equal(s.stats().queued, 0);
  const retried = await s.retry("broken.png", "thumb256");
  assert.equal(retried.status, "pending", "显式重试清除失败后重新排队");
  await put("bomb.png", bombPng(20000, 20000));
  const bomb = await s.requestDerivative("bomb.png", "thumb256", { wait: true });
  assert.equal(bomb.status, "failed");
  assert.equal(bomb.error.code, "too_many_pixels");
  assert.equal(await readFile(path.join(assetsDir, "broken.png"), "utf8"), "这不是图片", "派生失败不改动源素材");
  assert.equal(s.stats().processed, processed, "失败不计为成功产物");
  await assert.rejects(s.requestDerivative("../x.png", "thumb256"), (e) => e instanceof DerivativeError && e.status === 404);
  await assert.rejects(s.requestDerivative("missing.png", "thumb256"), (e) => e.code === "not_found");
  await assert.rejects(s.requestDerivative("clip.mp4", "thumb256"), (e) => e.code === "invalid_variant");
});

test("队列上限：满时返回 503 queue_full 且不写失败记录；Worker 退出后 pending 可恢复", async () => {
  const small = service({ queueLimit: 2 });
  for (let i = 0; i < 4; i++) await put(`q${i}.png`, await png(300 + i, 200, false));
  const accepted = [];
  let rejected = null;
  for (let i = 0; i < 4; i++) {
    try { accepted.push(await small.requestDerivative(`q${i}.png`, "thumb256")); } catch (error) { rejected = error; }
  }
  assert.equal(rejected?.code, "queue_full");
  assert.equal(rejected?.status, 503);
  const files = await readdir(path.join(dataDir, "derivatives"));
  assert.ok(!files.some(f => f.startsWith("q3.png") && f.endsWith(".failed.json")), "队列满不是永久失败");
  const crashy = service();
  await put("crash.png", await png(2000, 2000, true));
  const inflight = crashy.requestDerivative("crash.png", "thumb1024", { wait: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  await crashy.crashForTest();
  const outcome = await inflight.then(r => r, e => e);
  if (outcome instanceof Error) assert.equal(outcome.code, "worker_exited");
  assert.ok(!existsSync(path.join(dataDir, "derivatives", `crash.png.thumb1024.${(await crashy.requestDerivative("crash.png", "thumb1024").catch(() => ({}))).sourceHash}.failed.json`)), "Worker 退出不写 failed");
  const recovered = await crashy.requestDerivative("crash.png", "thumb1024", { wait: true });
  assert.equal(recovered.status, "ready", "重启后同 key 重新处理完成");
});

test("视频 poster 惰性：未主动播放前 absent，不批量提取；客户端截帧提交后缓存为 ready", async () => {
  const s = service();
  await put("clip.mp4", "MP4-合成占位");
  const absent = await s.requestDerivative("clip.mp4", "poster");
  assert.equal(absent.status, "absent");
  assert.equal(s.stats().queued, 0, "不为视频自动排队");
  const frame = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#123456" } }).png().toBuffer();
  const poster = await s.submitPoster("clip.mp4", new Uint8Array(frame));
  assert.deepEqual([poster.status, poster.width, poster.height], ["ready", 1024, 576]);
  assert.equal((await s.requestDerivative("clip.mp4", "poster")).status, "ready", "缓存后直接 ready");
  await assert.rejects(s.submitPoster("wide.png", new Uint8Array(frame)), (e) => e.code === "invalid_variant");
  await assert.rejects(s.submitPoster("clip.mp4", new Uint8Array(0)), (e) => e.status === 413);
  const badFrame = await s.submitPoster("clip.mp4", new Uint8Array(Buffer.from("x"))).catch(e => e);
  assert.equal(badFrame.status, "ready", "已有 poster 时不重复处理");
});

const routeSource = await readFile(new URL("../app/api/assets/[name]/derivative/[variant]/route.ts", import.meta.url), "utf8").catch(() => "");
const routeModule = {};
const routeService = service();
if (routeSource) vm.runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: routeModule, Response, JSON, Promise, Number, Object, String, Error, Uint8Array, URL,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@/lib/media/derivatives") return { ...derivatives.module, getDerivativeService: () => routeService };
    if (name === "node:fs" || name === "node:stream") return require(name);
    throw new Error(`未模拟依赖：${name}`);
  },
});
const call = (method, name, variant, init = {}) => routeModule[method](new Request(`http://127.0.0.1:3210/api/assets/${name}/derivative/${variant}`, { method, ...init }), { params: Promise.resolve({ name, variant }) });

test("派生路由：202 pending → 200 image/webp（ETag=源 hash，304）；422 failed + POST 重试；poster 404 absent → POST 截帧 200；未知变体 400", async () => {
  assert.ok(routeModule.GET && routeModule.POST, "派生路由存在");
  await put("route.png", await png(600, 300, true));
  const first = await call("GET", "route.png", "thumb256");
  assert.equal(first.status, 202);
  assert.equal((await first.json()).status, "pending");
  await routeService.requestDerivative("route.png", "thumb256", { wait: true });
  const ready = await call("GET", "route.png", "thumb256");
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("content-type"), "image/webp");
  assert.equal(ready.headers.get("x-media-width"), "256");
  const etag = ready.headers.get("etag");
  assert.deepEqual([(await sharp(Buffer.from(await ready.arrayBuffer())).metadata()).width], [256]);
  assert.equal((await call("GET", "route.png", "thumb256", { headers: { "if-none-match": etag } })).status, 304);
  await put("route-bad.png", "坏");
  await routeService.requestDerivative("route-bad.png", "thumb256", { wait: true });
  const failed = await call("GET", "route-bad.png", "thumb256");
  assert.equal(failed.status, 422);
  assert.equal((await failed.json()).retry, "/api/assets/route-bad.png/derivative/thumb256");
  assert.equal((await call("POST", "route-bad.png", "thumb256")).status, 202, "POST 显式重试");
  await put("route.mp4", "MP4");
  assert.equal((await call("GET", "route.mp4", "poster")).status, 404);
  const frame = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#000" } }).jpeg().toBuffer();
  const posted = await call("POST", "route.mp4", "poster", { body: frame, headers: { "content-type": "image/jpeg" } });
  assert.equal(posted.status, 200);
  assert.equal((await call("GET", "route.mp4", "poster")).status, 200);
  assert.equal((await call("GET", "route.png", "huge")).status, 400);
  assert.equal((await call("GET", "..%2Fx.png", "thumb256")).status, 404);
});

test("接线：上传/生成落盘后排队；sharp 精确锁定 0.35.4；媒体运行资源 staging 可复核且篡改被拒；三端 smoke 含媒体 probe", async () => {
  const upload = await readFile(new URL("../app/api/assets/upload/route.ts", import.meta.url), "utf8");
  const image = await readFile(new URL("../app/api/generate/image/route.ts", import.meta.url), "utf8");
  assert.match(upload, /scheduleDerivatives\(saved\[saved\.length - 1\]!\.name\)/);
  assert.match(image, /if \(slot\.status === "success"\) scheduleDerivatives\(slot\.asset\.name\)/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies.sharp, "0.35.4");
  assert.match(pkg.scripts["test:media"], /media-derivatives\.test\.mjs/);
  const { stageMediaRuntime, verifyMediaRuntime } = await import(new URL("../scripts/media-runtime.mjs", import.meta.url).href);
  const destination = path.join(dataDir, "media-runtime");
  const manifest = await stageMediaRuntime({ projectRoot: repoRoot, destination });
  assert.equal(manifest.version, "0.35.4");
  assert.ok(manifest.native.endsWith(".node") && manifest.native.includes(`@img/sharp-${manifest.target}`));
  await verifyMediaRuntime(destination);
  await writeFile(path.join(destination, manifest.worker), "// tampered\n", { flag: "a" });
  await assert.rejects(verifyMediaRuntime(destination), /哈希不符/);
  const smoke = await readFile(new URL("../scripts/db-runtime-smoke.mjs", import.meta.url), "utf8");
  for (const label of ['"node-staged"', '"standalone", mediaDir', '"electron", mediaDir']) assert.ok(smoke.includes(label), label);
  for (const script of ["stage-standalone.mjs", "prepare-desktop.mjs"]) assert.match(await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8"), /stageMediaRuntime/);
  assert.match(await readFile(new URL("../scripts/finish-desktop.mjs", import.meta.url), "utf8"), /verifyMediaRuntime/);
});
