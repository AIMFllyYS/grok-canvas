// 复现：画布开着时，服务端（等同 Agent generate_video）把视频节点改成 running+taskId，随后任务完成。
// 观察页面是否从「生成中」变成已生成，以及期间的 SSE、拉取与视频任务轮询。
// 用法：PLAYWRIGHT_MODULE=<playwright> GROK_CANVAS_DATA_DIR=<与服务相同的临时目录> node --experimental-strip-types scripts/e2e/video-agent-sync.repro.mjs http://127.0.0.1:<port>/
// 只对临时数据目录启动的独立服务运行。
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2];
const origin = new URL(base).origin;
const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
const api = async (method, url, body) => {
  const response = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);

const canvasId = (await api("POST", "/api/canvases")).body.id;
const nodeId = randomUUID();
const video = { id: nodeId, type: "video", position: { x: 0, y: 0 }, data: { name: "视频·复现", prompt: "p", status: "idle", assetName: null, aspectRatio: "16:9", resolution: "720p", duration: 6, audio: false, uploadInputs: [] } };
await api("POST", `/api/canvases/${canvasId}/operations`, { operations: [{ id: randomUUID(), target: "node", entityId: nodeId, path: [], before: { exists: false }, after: { exists: true, value: video } }] });
log("画布", canvasId, "视频节点", nodeId);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const traffic = [];
page.on("request", request => {
  const url = request.url().replace(origin, "");
  if (url.includes("/events")) return;
  if (url.startsWith(`/api/canvases/${canvasId}`) || url.startsWith("/api/generate/video")) traffic.push({ at: Date.now() - t0, method: request.method(), url: url.slice(0, 110) });
});
page.on("console", message => { if (message.type() === "error" || message.type() === "warning") log("console", message.type(), message.text().slice(0, 160)); });
await page.goto(`${base}?canvas=${canvasId}`, { waitUntil: "domcontentloaded" });
// 切到该画布：首页打开的是最近画布，测试画布是刚建的，即最近的。
const nodeEl = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
await nodeEl.waitFor({ timeout: 30000 });
const waitLive = async () => { for (let i = 0; i < 100; i++) { if (await page.evaluate(() => document.documentElement.dataset.canvasSync) === "live") return true; await sleep(100); } return false; };
log("SSE live:", await waitLive());
await sleep(1000);

// 服务端模块：与 Agent generate_video 相同的写入（同一进程外调用，经 HTTP 接口）。
const state = async () => {
  const text = await nodeEl.innerText().catch(() => "");
  const hasVideoUi = await nodeEl.locator('[aria-label^="播放视频"], video').count();
  return { running: /生成中|已等待/.test(text), hasVideoUi: hasVideoUi > 0 };
};
const generationId = randomUUID();
// 1) claim + start（Agent: claimGeneration + patchClaimed running）
await api("POST", `/api/canvases/${canvasId}/generation-claim`, { nodeId, id: generationId, action: "claim" });
const start = await api("POST", `/api/canvases/${canvasId}/service-write`, { action: "start", nodeId, generationId, patch: { status: "running", generationId, errorMessage: null } });
log("start 写入", start.status, JSON.stringify(start.body));
await sleep(2500);
log("start 后页面", JSON.stringify(await state()));

// 2) 创建一个已完成的视频任务记录（等同上游已完成并下载），再写 taskId（Agent: patchClaimed { taskId }）
const { createVideoTask, updateVideoTask } = await import(process.env.VIDEO_TASKS_MODULE);
const task = await createVideoTask(randomUUID(), canvasId, nodeId, { prompt: "p" }, { nodeId, id: generationId });
const taskWrite = await api("POST", `/api/canvases/${canvasId}/service-write`, { action: "task", nodeId, generationId, taskId: task.taskId });
log("taskId 写入", taskWrite.status, JSON.stringify(taskWrite.body));
await sleep(3000);
log("taskId 后页面", JSON.stringify(await state()), "期间视频任务轮询次数", traffic.filter(r => r.url.startsWith("/api/generate/video/")).length);

// 3) 任务完成：服务端写 completed，再由服务端回写节点（等同 check_video_task / 生成回写）
await updateVideoTask(task.taskId, { status: "completed", result: { assetName: process.env.VIDEO_ASSET, localUrl: `/api/assets/${process.env.VIDEO_ASSET}`, bytes: 1 }, error: null });
const done = await api("POST", `/api/canvases/${canvasId}/service-write`, { action: "video", nodeId, taskId: task.taskId });
log("完成写入", done.status, JSON.stringify(done.body));
const server = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === nodeId).data;
log("服务端节点", server.status, server.assetName);
let shown = false;
for (let i = 0; i < 20; i++) { await sleep(500); const s = await state(); if (!s.running && s.hasVideoUi) { shown = true; log("页面已显示视频", JSON.stringify(s)); break; } }
if (!shown) log("10 秒后页面仍未显示", JSON.stringify(await state()));
log("请求记录", JSON.stringify(traffic, null, 0));
await page.screenshot({ path: `${process.env.OUT ?? "."}/video-repro.png` });
await browser.close();
