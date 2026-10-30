"use strict";
/**
 * 媒体运行时探针（P4-02）：由被测运行时本身执行（系统 node / standalone node / Electron ELECTRON_RUN_AS_NODE），
 * 通过派生 Worker 跑 selftest（合成带透明 PNG → 长边 256 WebP），并真实派生一张 PNG 缩略图。
 * 用法：<runtime> scripts/media-runtime-probe.cjs <derivative-worker.cjs> <临时目录>；输出一行 `MEDIA_PROBE {json}`。
 */
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const [workerArg, dirArg] = process.argv.slice(2);
/** 最小 PNG 编码：raw 为已带每行过滤字节（0）的 RGBA 扫描线。 */
function encodePng(width, height, raw) {
  const zlib = require("node:zlib");
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function call(worker, op, args) {
  return new Promise((resolve, reject) => {
    const id = String(Math.random());
    const timer = setTimeout(() => reject(new Error(`${op} 超时`)), 30_000);
    const onMessage = (m) => { if (m.id !== id) return; clearTimeout(timer); worker.off("message", onMessage); m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error.message), { code: m.error.code })); };
    worker.on("message", onMessage);
    worker.postMessage({ id, op, args });
  });
}
async function main() {
  const workerPath = path.resolve(workerArg || "");
  if (!fs.existsSync(workerPath)) throw new Error(`缺少媒体 Worker：${workerPath}`);
  const dir = path.resolve(dirArg);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const worker = new Worker(workerPath);
  try {
    const selftest = await call(worker, "selftest", {});
    // 2×1 RGBA PNG 在探针内用 zlib 现场编码（含正确 CRC），不依赖 sharp 生成输入；派生后尺寸应仍为 2×1。
    const png = encodePng(2, 1, Buffer.from([0, 255, 0, 0, 128, 0, 0, 255, 255]));
    const source = path.join(dir, "probe.png");
    fs.writeFileSync(source, png);
    const derived = await call(worker, "derive", { source, target: path.join(dir, "probe.webp"), size: 256 });
    let rejected = null;
    fs.writeFileSync(path.join(dir, "bad.png"), "not an image");
    try { await call(worker, "derive", { source: path.join(dir, "bad.png"), target: path.join(dir, "bad.webp"), size: 256 }); } catch (error) { rejected = error.code; }
    const ok = selftest.ok === true && derived.width === 2 && derived.height === 1 && rejected === "invalid_image";
    return { ok, workerPath, runtime: { execPath: process.execPath, node: process.version, electron: process.versions.electron || null, modules: process.versions.modules }, selftest, derived, badImage: rejected };
  } finally {
    await worker.terminate();
  }
}
main().then(
  (report) => { process.stdout.write(`MEDIA_PROBE ${JSON.stringify(report)}\n`); process.exitCode = report.ok ? 0 : 1; },
  (error) => { process.stdout.write(`MEDIA_PROBE ${JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error), runtime: { execPath: process.execPath, electron: process.versions.electron || null } })}\n`); process.exitCode = 1; },
);
