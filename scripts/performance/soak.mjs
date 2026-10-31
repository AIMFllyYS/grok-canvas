#!/usr/bin/env node
/**
 * 稳定性 soak（P6-03）：在隔离的 standalone 服务上，模拟 Agent 每秒 2 批、每批 20 个节点的滚动写入
 * （新增 / 更新正文 / 删除，实体数有上限），同时浏览器打开画布并周期性平移；每 sampleMs 采样
 * JS 堆、DOM 节点、事件监听器、挂载层级与同步状态，结束后等待回落再采一次。
 *
 * 用法：PLAYWRIGHT_MODULE=<playwright 目录> node scripts/performance/soak.mjs <baseUrl> <outDir> [minutes=5] [seed=1]
 * 只用合成数据；结果是“该机器 headless Chromium”数据。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** 确定性伪随机（mulberry32）。 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * 写入计划：每批 nodesPerBatch 个操作。实体数未到 maxEntities 时以新增为主；到上限后删除最旧的，
 * 其余是正文更新。返回按批次的操作描述，不依赖时钟，可重复。
 */
export function createSoakSchedule({ seed = 1, nodesPerBatch = 20, maxEntities = 400 } = {}) {
  const random = rng(seed);
  const live = [];
  let next = 0, batches = 0;
  const counts = { add: 0, update: 0, remove: 0 };
  return {
    nextBatch() {
      const ops = [];
      const used = new Set();
      // 每批正好 nodesPerBatch 个操作，同一批内每个节点最多出现一次。
      for (let guard = 0; ops.length < nodesPerBatch && guard < nodesPerBatch * 10; guard++) {
        const roll = random();
        const free = live.filter(id => !used.has(id));
        if (free.length && (live.length >= maxEntities || roll < 0.15)) {
          const id = free[0];
          live.splice(live.indexOf(id), 1);
          used.add(id);
          ops.push({ kind: "remove", id }); counts.remove++;
        } else if (free.length && roll < 0.55) {
          const id = free[Math.floor(random() * free.length)];
          used.add(id);
          ops.push({ kind: "update", id, content: `更新 ${batches}-${ops.length} ${"文".repeat(Math.floor(random() * 200))}` }); counts.update++;
        } else if (live.length < maxEntities) {
          const id = `soak-${seed}-${next++}`;
          live.push(id);
          used.add(id);
          ops.push({ kind: "add", id, x: (next % 40) * 400, y: Math.floor(next / 40) % 20 * 320, content: `新增 ${next}` }); counts.add++;
        }
      }
      batches++;
      return ops;
    },
    live: () => [...live],
    stats: () => ({ batches, liveEntities: live.length, ...counts }),
  };
}

/** 按 batchesPerSecond 驱动 send，直到 durationMs 或 stop()；send 未完成时跳过本拍（背压），并计数。 */
export function runSchedule(schedule, send, { batchesPerSecond = 2, durationMs = 60_000, now = Date.now, setTimer = setTimeout } = {}) {
  const interval = 1000 / batchesPerSecond;
  const start = now();
  let stopped = false, inFlight = false, skipped = 0, sent = 0, failed = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const tick = () => {
    if (stopped || now() - start >= durationMs) { stopped = true; resolveDone({ sent, skipped, failed }); return; }
    if (inFlight) skipped++;
    else {
      inFlight = true;
      Promise.resolve(send(schedule.nextBatch())).then(() => { sent++; }, () => { failed++; }).finally(() => { inFlight = false; });
    }
    setTimer(tick, interval);
  };
  tick();
  return { done, stop() { stopped = true; }, counters: () => ({ sent, skipped, failed }) };
}

async function main() {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  const [base, outDir, minutesArg = "5", seedArg = "1"] = process.argv.slice(2);
  if (!base || !outDir) { console.error("用法：soak.mjs <baseUrl> <outDir> [minutes] [seed]"); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  const origin = new URL(base).origin;
  const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
  const created = await (await fetch(`${origin}/api/canvases`, { method: "POST", headers })).json();
  const canvasId = created.id;
  const op = (target, entityId, pathParts, before, after) => ({ id: randomUUID(), target, entityId, path: pathParts, before, after });
  const contents = new Map();
  const send = async (ops) => {
    const operations = ops.map(item => {
      if (item.kind === "add") { const value = { id: item.id, type: "canvasText", position: { x: item.x, y: item.y }, width: 360, height: 260, data: { name: item.id, content: item.content } }; contents.set(item.id, item.content); return op("node", item.id, [], { exists: false }, { exists: true, value }); }
      if (item.kind === "update") { const before = contents.get(item.id); contents.set(item.id, item.content); return op("node", item.id, ["data", "content"], { exists: true, value: before }, { exists: true, value: item.content }); }
      contents.delete(item.id); return null;
    }).filter(Boolean);
    const removals = ops.filter(item => item.kind === "remove");
    if (operations.length) { const r = await fetch(`${origin}/api/canvases/${canvasId}/operations`, { method: "POST", headers, body: JSON.stringify({ operations }) }); if (!r.ok) throw new Error(`operations ${r.status}`); }
    if (removals.length) {
      const current = await (await fetch(`${origin}/api/canvases/${canvasId}?background=1`, { headers })).json();
      const ids = new Set(removals.map(item => item.id));
      const removeOps = current.nodes.filter(n => ids.has(n.id)).map(n => op("node", n.id, [], { exists: true, value: n }, { exists: false }));
      if (removeOps.length) { const r = await fetch(`${origin}/api/canvases/${canvasId}/operations`, { method: "POST", headers, body: JSON.stringify({ operations: removeOps }) }); if (!r.ok) throw new Error(`remove ${r.status}`); }
    }
  };

  const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(3000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async (label) => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
    const view = await page.evaluate(() => ({ rfNodes: document.querySelectorAll(".react-flow__node").length, sync: document.documentElement.dataset.canvasSync ?? null, lod: globalThis.__grokCanvasLod ?? null }));
    return { label, at: new Date().toISOString(), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), domNodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, ...view };
  };
  const minutes = Math.max(1, Number(minutesArg) || 5);
  const schedule = createSoakSchedule({ seed: Number(seedArg) || 1 });
  const samples = [await sample("start")];
  const run = runSchedule(schedule, send, { batchesPerSecond: 2, durationMs: minutes * 60_000 });
  const timer = setInterval(() => { void sample("running").then(s => samples.push(s)).catch(() => {}); }, 30_000);
  const panner = setInterval(() => { void page.mouse.wheel(0, 200).catch(() => {}); }, 10_000);
  const counters = await run.done;
  clearInterval(timer); clearInterval(panner);
  await page.waitForTimeout(10_000);
  samples.push(await sample("settled"));
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await page.waitForTimeout(2000);
  samples.push(await sample("after-forced-gc"));
  await browser.close();
  const running = samples.filter(s => s.label === "running");
  const warm = running.slice(Math.min(running.length - 1, 2));
  const trend = warm.length >= 2 ? +((warm.at(-1).heapMB - warm[0].heapMB) / Math.max(1, warm.length - 1)).toFixed(2) : null;
  const report = {
    schemaVersion: 1, kind: "soak", minutes, seed: Number(seedArg) || 1, batchesPerSecond: 2, nodesPerBatch: 20,
    environment: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 1073741824), node: process.version },
    schedule: schedule.stats(), counters, heapTrendMBPerSample: trend, samples, pageErrors: errors.slice(0, 5),
  };
  writeFileSync(path.join(outDir, "soak-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ minutes, counters, schedule: schedule.stats(), heapTrendMBPerSample: trend, first: samples[0], settled: samples.at(-2), gc: samples.at(-1), errors: errors.length }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exit(1); });
}
