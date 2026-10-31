// P3-09/P3-10 浏览器验收：空闲无整图轮询、外部写入经 SSE 到达、确认水位上报、后台页断开与恢复。
// 用法：PLAYWRIGHT_MODULE=<playwright 目录> node scripts/e2e/canvas-sync.e2e.mjs http://127.0.0.1:<port>/ <输出目录>
// 只指向临时数据目录启动的服务：脚本会新建画布并写入合成节点。
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const origin = new URL(base).origin;
const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const api = async (method, url, body) => {
  const response = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const created = await api("POST", "/api/canvases");
const canvasId = created.body.id;
const text = (id, x, y, content = `正文 ${id}`) => ({ id, type: "canvasText", position: { x, y }, width: 360, height: 260, data: { name: `文本 ${id}`, content } });
const addOps = nodes => nodes.map(node => ({ id: randomUUID(), target: "node", entityId: node.id, path: [], before: { exists: false }, after: { exists: true, value: node } }));
const seeded = await api("POST", `/api/canvases/${canvasId}/operations`, { operations: addOps([text("n1", 0, 0), text("n2", 450, 0)]) });
check("种子画布写入", seeded.status === 200, `status ${seeded.status}`);

const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const requests = [];
page.on("request", request => {
  const url = request.url().replace(origin, "");
  if (!url.startsWith("/api/canvases/")) return;
  let body = null; try { body = request.postDataJSON(); } catch { /* GET */ }
  requests.push({ at: Date.now(), method: request.method(), url, body });
});
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
const fullGets = (since) => requests.filter(r => r.at >= since && r.method === "GET" && new RegExp(`^/api/canvases/${canvasId}(\\?|$)`).test(r.url));
const syncState = () => page.evaluate(() => document.documentElement.dataset.canvasSync ?? null);
const waitSync = async (state, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await syncState() === state) return true; await sleep(100); } return false; };
const node = id => page.locator(`.react-flow__node[data-id="${id}"]`);

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await node("n1").waitFor({ timeout: 30000 });
check("SSE 连接建立", await waitSync("live"), `state=${await syncState()}`);
await sleep(2000);

// 1) 空闲 8 秒：不再有整图拉取（旧实现每 2 秒一次，约 4 次）
{
  const since = Date.now();
  await sleep(8000);
  const gets = fullGets(since);
  check("空闲 8 秒整图 GET 为 0", gets.length === 0, `GET ${gets.length}`);
  const streams = requests.filter(r => r.url.startsWith(`/api/canvases/${canvasId}/events`));
  check("每个打开的画布只有一条事件流", streams.length === 1, `events 请求 ${streams.length}`);
}

// 2) 外部写入（旧协议，等同 Agent/生成回写）经 SSE 到达画面
{
  const at = Date.now();
  const r = await api("POST", `/api/canvases/${canvasId}/operations`, { operations: addOps([text("ext1", 0, 400, "外部新增")]) });
  const shown = await node("ext1").waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("外部新增节点 5 秒内出现", r.status === 200 && shown, `status ${r.status} 用时 ${Date.now() - at}ms`);
  const current = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === "n2");
  await api("POST", `/api/canvases/${canvasId}/operations`, { operations: [{ id: randomUUID(), target: "node", entityId: "n2", path: ["data", "content"], before: { exists: true, value: current.data.content }, after: { exists: true, value: "外部改写的正文" } }] });
  const updated = await page.getByText("外部改写的正文").waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("外部改写正文 5 秒内显示", updated);
  await page.screenshot({ path: path.join(outDir, "sync-01-external.png") });
}

// 3) 本地拖动：只发命令，自己的修订不触发整图拉取；随后上报确认水位
{
  const b = await node("n1").boundingBox();
  const since = Date.now();
  await page.mouse.move(b.x + b.width / 2, b.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(b.x + b.width / 2 + i * 5, b.y + 40 + i * 3);
  await page.mouse.up();
  await sleep(7500);
  const cmds = requests.filter(r => r.at >= since && r.url.endsWith("/commands"));
  const gets = fullGets(since);
  const acks = requests.filter(r => r.at >= since && r.url.endsWith("/ack"));
  check("本地拖动发 1 条命令", cmds.length === 1, `commands ${cmds.length}`);
  check("自己的修订不触发整图拉取", gets.length === 0, `GET ${gets.length}`);
  check("确认水位已上报", acks.length >= 1 && acks.every(a => Number.isSafeInteger(a.body?.ackSeq) && a.body.ackSeq >= 1), JSON.stringify(acks.map(a => a.body)));
}

// 4) 后台页断开连接；期间的外部写入在回到前台后补齐
{
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  check("后台页断开事件流", await waitSync("paused", 3000), `state=${await syncState()}`);
  await api("POST", `/api/canvases/${canvasId}/operations`, { operations: addOps([text("ext2", 450, 400, "后台期间新增")]) });
  await sleep(1500);
  const hiddenShown = await node("ext2").count();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const caught = await node("ext2").waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("回到前台后补齐后台期间的写入", hiddenShown === 0 && caught && await waitSync("live", 5000), `后台时节点数 ${hiddenShown}`);
}

// 5) 刷新后位置与外部节点都在
{
  await page.reload({ waitUntil: "domcontentloaded" });
  await node("ext2").waitFor({ timeout: 30000 });
  check("刷新后外部节点仍在", (await node("ext1").count()) === 1 && (await node("ext2").count()) === 1);
  await page.screenshot({ path: path.join(outDir, "sync-02-reloaded.png") });
}

check("全程无页面错误", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
writeFileSync(path.join(outDir, "sync-results.json"), JSON.stringify({ canvasId, results }, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
