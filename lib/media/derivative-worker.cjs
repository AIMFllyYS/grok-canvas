"use strict";
/**
 * 媒体派生 Worker（P4-02，contracts.md C7）：worker_threads 中运行，独占 sharp（native）。
 * 只接受固定 op：
 *   metadata  { source }                         → 尺寸/方向/格式/透明通道
 *   derive    { source, target, size }           → 长边 ≤size 的 WebP（保留透明、比例、EXIF 方向）
 *   poster    { source, target }                 → 校验客户端截帧并转存为 ≤1024 WebP
 *   selftest  {}                                 → 合成带透明的图做一次派生，用于三端 native smoke
 * 输入像素 ≤1 亿、文件 ≤64MiB；超限（含压缩炸弹）直接失败，不解码。输出写到 target（调用方给的临时路径）。
 */
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");

const MAX_PIXELS = 100_000_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
let sharp = null;
const load = () => {
  if (!sharp) {
    sharp = require("sharp");
    sharp.cache(false);
    sharp.concurrency(1);
  }
  return sharp;
};
const fail = (code, message) => Object.assign(new Error(message), { code });

function checkInput(source) {
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw fail("invalid_input", "源不是文件");
  if (stat.size > MAX_INPUT_BYTES) throw fail("too_large", `源文件 ${stat.size} 字节超过读取预算 ${MAX_INPUT_BYTES}`);
  return stat.size;
}

async function metadata(source) {
  checkInput(source);
  const meta = await load()(source, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata();
  if (!meta.width || !meta.height) throw fail("invalid_image", "无法读取图片尺寸");
  if (meta.width * meta.height > MAX_PIXELS) throw fail("too_many_pixels", `图片 ${meta.width}×${meta.height} 超过 ${MAX_PIXELS} 像素上限`);
  const rotated = (meta.orientation ?? 1) >= 5;
  return {
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
    storedWidth: meta.width, storedHeight: meta.height,
    orientation: meta.orientation ?? 1, format: meta.format, hasAlpha: !!meta.hasAlpha,
  };
}

async function derive({ source, target, size }) {
  if (!Number.isSafeInteger(size) || size < 16 || size > 4096) throw fail("invalid_input", "size 无效");
  await metadata(source);
  const info = await load()(source, { limitInputPixels: MAX_PIXELS, failOn: "error" })
    .rotate()
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 100, effort: 4 })
    .toFile(target);
  return { width: info.width, height: info.height, bytes: info.size, format: "webp" };
}

async function selftest() {
  const image = load()({ create: { width: 512, height: 256, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } });
  const png = await image.png().toBuffer();
  const out = await load()(png).resize({ width: 256, height: 256, fit: "inside" }).webp({ alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
  return { ok: out.info.width === 256 && out.info.height === 128 && out.info.channels === 4, width: out.info.width, height: out.info.height, channels: out.info.channels, sharpPath: require.resolve("sharp"), versions: { sharp: load().versions.sharp, vips: load().versions.vips } };
}

const OPS = {
  metadata: ({ source }) => metadata(source),
  derive,
  poster: ({ source, target }) => derive({ source, target, size: 1024 }),
  selftest,
};

parentPort.on("message", async (request) => {
  const { id, op, args } = request || {};
  const handler = OPS[op];
  if (!handler) { parentPort.postMessage({ id, ok: false, error: { code: "unknown_op", message: `不支持的派生操作 ${op}` } }); return; }
  try {
    parentPort.postMessage({ id, ok: true, result: await handler(args || {}) });
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : /pixel limit|exceeds pixel/i.test(String(error && error.message)) ? "too_many_pixels" : "invalid_image";
    parentPort.postMessage({ id, ok: false, error: { code, message: error && error.message ? error.message : String(error) } });
  }
});
