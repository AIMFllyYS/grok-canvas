// P4-04/P4-05 浏览器验收：近景完整、远景轻量、概览 Canvas2D、概览点击放大、适配整张文档、离屏不挂载。
// 用法：PLAYWRIGHT_MODULE=<playwright 目录> node scripts/e2e/canvas-lod.e2e.mjs http://127.0.0.1:<port>/ <输出目录>
// 只指向临时数据目录：脚本会导入 1000 节点的合成 fixture。
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateFixture, importViaHttp } from "../performance/fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const origin = new URL(base).origin;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const canvasId = await importViaHttp(base, generateFixture({ size: 1000, topology: "2n" }));
const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.locator(".react-flow__node").first().waitFor({ timeout: 120000 });
await sleep(1500);

const lod = () => page.evaluate(() => ({ mode: document.documentElement.dataset.canvasLod ?? null, summary: globalThis.__grokCanvasLod ?? null }));
const dom = () => page.evaluate(() => ({
  nodes: document.querySelectorAll(".react-flow__node").length,
  light: document.querySelectorAll(".react-flow__node [data-lod=light]").length,
  edges: document.querySelectorAll(".react-flow__edge").length,
  overview: !!document.querySelector("canvas[data-lod=overview]"),
  zoom: Number(/scale\(([\d.]+)\)/.exec(document.querySelector(".react-flow__viewport")?.style.transform ?? "")?.[1] ?? NaN),
}));
const waitMode = async (mode, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await lod()).mode === mode) return true; await sleep(100); } return false; };
const counts = {};

// 1) 默认视口：近景，挂载数远小于 1000，完整组件 ≤ 80
{
  const state = await lod(), d = await dom();
  counts.detail = { ...d, ...state.summary };
  check("默认视口为近景", state.mode === "detail", JSON.stringify(state.summary));
  check("离屏节点不挂载（DOM 节点 < 1000）", d.nodes < 1000 && d.nodes > 0, `DOM ${d.nodes}`);
  check("完整组件 ≤ 80", state.summary && state.summary.full <= 80, `full ${state.summary?.full}`);
  await page.screenshot({ path: path.join(outDir, "lod-01-detail.png") });
}

// 2) 适配全部：基于完整文档，1000 个候选进入概览，React Flow 只保留 pin，Canvas2D 绘制轮廓
{
  await page.getByRole("button", { name: "适应全部节点" }).click();
  const entered = await waitMode("overview");
  await sleep(800);
  const d = await dom(), state = await lod();
  counts.overview = { ...d, ...state.summary };
  check("适配全部后进入概览", entered, JSON.stringify(state.summary));
  check("概览：Canvas2D 层存在且 React Flow 不挂普通节点", d.overview && d.nodes <= 2, `DOM ${d.nodes} overview=${d.overview}`);
  check("适配全部：按完整文档计算，候选超过 500 进入概览", (state.summary?.candidates ?? 0) > 500, `candidates ${state.summary?.candidates} zoom ${d.zoom}`);
  await page.screenshot({ path: path.join(outDir, "lod-02-overview.png") });
}

// 3) 概览点击节点：经空间索引定位并放大到该节点
{
  const all = (await (await fetch(`${origin}/api/canvases/${canvasId}/entities?fields=geometry`, { headers: { origin, "sec-fetch-site": "same-origin" } })).json()).nodes;
  const transform = await page.evaluate(() => document.querySelector(".react-flow__viewport").style.transform);
  const [, tx, ty, z] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform).map(Number);
  const pane = await page.locator(".react-flow").boundingBox();
  const screen = n => ({ id: n.id, x: pane.x + tx + (n.geometry.x + n.geometry.width / 2) * z, y: pane.y + ty + (n.geometry.y + n.geometry.height / 2) * z });
  const mid = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
  const target = all.map(screen).sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y))[0];
  await page.mouse.click(target.x, target.y);
  await sleep(800);
  const d = await dom(), state = await lod();
  check("概览点击放大到节点并回到近景", state.mode === "detail" && Math.abs(d.zoom - 1) < 0.01 && await page.locator(`.react-flow__node[data-id="${target.id}"]`).count() === 1, JSON.stringify({ target: target.id, mode: state.mode, zoom: d.zoom }));
}

// 4) 缩小到 < 0.30：远景轻量，不挂完整组件；0.30~0.38 之间回放大不抖回近景
{
  for (let i = 0; i < 7; i++) { await page.keyboard.press("Control+Minus"); await sleep(150); }
  await sleep(800);
  const d = await dom(), state = await lod();
  counts.light = { ...d, ...state.summary };
  check("缩小到 0.30 以下进入远景或概览", d.zoom < 0.30 && (state.mode === "light" || state.mode === "overview"), JSON.stringify({ zoom: d.zoom, mode: state.mode }));
  if (state.mode === "light") check("远景：挂载的都是轻量组件", d.light === d.nodes && d.nodes > 0, `DOM ${d.nodes} light ${d.light}`);
  await page.keyboard.press("Control+Equal");
  await sleep(600);
  const back = await dom(), after = await lod();
  check("放大一级（未到 0.39）不抖回近景", back.zoom < 0.39 ? after.mode !== "detail" : true, JSON.stringify({ zoom: back.zoom, mode: after.mode }));
  await page.screenshot({ path: path.join(outDir, "lod-03-light.png") });
}

check("全程无页面错误", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
writeFileSync(path.join(outDir, "lod-results.json"), JSON.stringify({ canvasId, counts, results }, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
