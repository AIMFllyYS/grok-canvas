// 复现（压力版）：两个视频节点，服务端连续写 running → taskId，任务同时完成回写；
// 期间用户在页面里选中/拖动节点（本地未确认改动）。观察页面是否卡在「生成中」。
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2], scenario = process.argv[3] ?? "drag";
const origin = new URL(base).origin;
const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
const api = async (method, url, body) => { const r = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const { createVideoTask, updateVideoTask } = await import(process.env.VIDEO_TASKS_MODULE);

const canvasId = (await api("POST", "/api/canvases")).body.id;
const ids = [randomUUID(), randomUUID()];
const ops = ids.map((id, i) => ({ id: randomUUID(), target: "node", entityId: id, path: [], before: { exists: false }, after: { exists: true, value: { id, type: "video", position: { x: i * 400, y: 0 }, data: { name: `视频${i + 1}`, prompt: "p", status: "idle", assetName: null, aspectRatio: "16:9", resolution: "720p", duration: 6, audio: false, uploadInputs: [] } } } }));
await api("POST", `/api/canvases/${canvasId}/operations`, { operations: ops });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pulls = [];
page.on("request", r => { const u = r.url().replace(origin, ""); if (u.startsWith(`/api/canvases/${canvasId}?background`)) pulls.push(Date.now() - t0); });
await page.goto(base, { waitUntil: "domcontentloaded" });
const el = id => page.locator(`.react-flow__node[data-id="${id}"]`);
await el(ids[0]).waitFor({ timeout: 30000 });
for (let i = 0; i < 100 && await page.evaluate(() => document.documentElement.dataset.canvasSync) !== "live"; i++) await sleep(100);
await sleep(800);
const view = async id => { const t = await el(id).innerText().catch(() => ""); return /生成中|已等待/.test(t) ? "生成中" : (await el(id).locator('[aria-label^="播放视频"], video').count()) ? "已显示视频" : "空"; };

const tasks = [];
for (const id of ids) {
  const gen = randomUUID();
  await api("POST", `/api/canvases/${canvasId}/generation-claim`, { nodeId: id, id: gen, action: "claim" });
  await api("POST", `/api/canvases/${canvasId}/service-write`, { action: "start", nodeId: id, generationId: gen, patch: { status: "running", generationId: gen, errorMessage: null } });
  const task = await createVideoTask(randomUUID(), canvasId, id, { prompt: "p" }, { nodeId: id, id: gen });
  await api("POST", `/api/canvases/${canvasId}/service-write`, { action: "task", nodeId: id, generationId: gen, taskId: task.taskId });
  tasks.push(task);
}
await sleep(2500);
log("提交后", await view(ids[0]), await view(ids[1]));

// 用户本地操作：选中并拖动第一个视频节点（产生未确认的移动命令），同时两个任务完成。
const box = await el(ids[0]).boundingBox();
if (scenario === "drag") { await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + 60, { steps: 8 }); }
for (const task of tasks) await updateVideoTask(task.taskId, { status: "completed", result: { assetName: process.env.VIDEO_ASSET, localUrl: `/api/assets/${process.env.VIDEO_ASSET}`, bytes: 1 }, error: null });
// 两条完成回写几乎同时到达（实测 02:48:33.460 / .477 / .555 / .585）
await Promise.all(tasks.map(task => api("POST", `/api/canvases/${canvasId}/service-write`, { action: "video", nodeId: task.nodeId, taskId: task.taskId })));
log("服务端已完成", JSON.stringify((await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.map(n => [n.data.name, n.data.status, !!n.data.assetName])));
if (scenario === "drag") { await sleep(300); await page.mouse.up(); }
for (let i = 0; i <= 30; i++) { await sleep(1000); const a = await view(ids[0]), b = await view(ids[1]); if (i % 5 === 0 || (a !== "生成中" && b !== "生成中")) log(`+${i}s`, a, b); if (a !== "生成中" && b !== "生成中") break; }
log("拉取时间点", JSON.stringify(pulls));
await page.screenshot({ path: `${process.env.OUT ?? "."}/video-stress-${scenario}.png` });
await browser.close();
