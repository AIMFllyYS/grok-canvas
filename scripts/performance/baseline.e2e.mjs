#!/usr/bin/env node
/**
 * P2 版本基线（P6-01）：在隔离的 standalone 服务上，经公开 HTTP 接口导入 fixture，用 Playwright 拖动 120 帧，
 * 分别在测量器开/关下记录：页面侧独立的 rAF 帧间隔（两次都测，用于对照测量器开销）与测量器 snapshot（仅开启时）。
 * 用法：PLAYWRIGHT_MODULE=<playwright 目录> node scripts/performance/baseline.e2e.mjs <baseUrl> <outDir> [size...]
 * 只用合成数据；结果是“该机器 headless Chromium”数据，不是指定硬件达标证据。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFixture, importViaHttp } from "./fixture.mjs";
import { percentile } from "./stats.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base, outDir, ...sizeArgs] = process.argv.slice(2);
if (!base || !outDir) { console.error("用法：baseline.e2e.mjs <baseUrl> <outDir> [size...]"); process.exit(2); }
const sizes = sizeArgs.length ? sizeArgs.map(Number) : [1000];
mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(size, metricsOn) {
  await importViaHttp(base, generateFixture({ size, topology: "2n", longText: true }));
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--force_high_performance_gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(on => { try { localStorage.setItem("grok-canvas:metrics", on ? "1" : "0"); } catch { /* ignore */ } }, metricsOn);
  const loadStart = Date.now();
  const entities = page.waitForResponse(r => r.url().includes("/entities"), { timeout: 120000 });
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  await entities;
  await page.locator(".react-flow__node").first().waitFor({ timeout: 120000 });
  const firstInteractiveMs = Date.now() - loadStart;
  await sleep(1500);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  const target = page.locator('.react-flow__node[data-id="node-0"] [aria-label="文本节点内容"]');
  const b = await target.boundingBox();
  // 页面侧独立帧间隔：与测量器无关，开/关两次都测。
  await page.evaluate(() => { window.__frames = []; let last = 0; const loop = t => { if (last) window.__frames.push(t - last); last = t; if (window.__framing) requestAnimationFrame(loop); }; window.__framing = true; requestAnimationFrame(loop); });
  const start = { x: b.x + b.width / 2, y: b.y + 40 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (let i = 1; i <= 120; i++) await page.mouse.move(start.x + i * 2, start.y + i);
  await page.mouse.up();
  await sleep(500);
  const frames = await page.evaluate(() => { window.__framing = false; return window.__frames; });
  const snapshot = metricsOn ? await page.evaluate(env => globalThis.__grokCanvasMetrics.snapshot(env), { media: "none", build: "production-standalone", hardware: `${os.cpus()[0]?.model ?? "unknown"} / headless-chromium`, version: "p2-baseline", renderer: "unknown", nodes: size }) : null;
  await browser.close();
  const sorted = Float64Array.from(frames).sort();
  return {
    size, metricsOn, firstInteractiveMs, renderer,
    harnessFrames: sorted.length ? { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] } : { count: 0, status: "unmeasured" },
    snapshot: snapshot ? { ...snapshot, environment: { ...snapshot.environment, renderer } } : null,
  };
}

const results = [];
for (const size of sizes) {
  for (const on of [false, true]) {
    const result = await run(size, on);
    results.push(result);
    console.log(`size=${size} metrics=${on ? "on" : "off"} firstInteractive=${result.firstInteractiveMs}ms frames p50/p95/p99=${result.harnessFrames.p50?.toFixed(1)}/${result.harnessFrames.p95?.toFixed(1)}/${result.harnessFrames.p99?.toFixed(1)} renderer=${result.renderer}`);
    if (result.snapshot) writeFileSync(path.join(outDir, `samples-${size}.json`), `${JSON.stringify(result.snapshot, null, 2)}\n`);
  }
}
writeFileSync(path.join(outDir, "baseline.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), host: { platform: process.platform, cpus: os.cpus().length }, results }, null, 2)}\n`);
