// P3-08 切换演练（浏览器）：只针对隔离的临时数据目录。
//   阶段 json：JSON 权威下种子画布 → 浏览器拖动节点 → 记录状态
//   （外部：停止服务 → node scripts/workstation-cutover.mjs --data=<目录> --execute --clients-drained → 以同一目录重启）
//   阶段 sqlite：SQLite 权威下同一画布加载 → 位置/正文一致 → 再拖动并刷新仍保留 → 旧纪元命令 stale_epoch → 无 5xx/页面错误
// 用法：PLAYWRIGHT_MODULE=<playwright> node scripts/e2e/cutover-drill.e2e.mjs <json|sqlite> http://127.0.0.1:<port>/ <输出目录>
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const [phase, base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const origin = new URL(base).origin;
const headers = { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" };
const stateFile = path.join(outDir, "drill-state.json");
const results = [];
const check = (name, ok, detail = "") => { results.push({ phase, name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} [${phase}] ${name}${detail ? ` — ${detail}` : ""}`); };
const api = async (method, url, body) => {
  const response = await fetch(`${origin}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
if (phase === "json") {
  const created = await api("POST", "/api/canvases");
  state.canvasId = created.body.id;
  const text = (id, x, y, content) => ({ id, type: "canvasText", position: { x, y }, width: 360, height: 260, data: { name: `文本 ${id}`, content } });
  const seed = [text("d1", 0, 0, "演练正文一"), text("d2", 450, 0, "演练正文二"), text("d3", 0, 400, "演练正文三")];
  const seeded = await api("POST", `/api/canvases/${state.canvasId}/operations`, { operations: seed.map(node => ({ id: randomUUID(), target: "node", entityId: node.id, path: [], before: { exists: false }, after: { exists: true, value: node } })) });
  check("JSON 模式种子画布写入", seeded.status === 200, `status ${seeded.status}`);
}
const canvasId = state.canvasId;
const entities = async () => (await api("GET", `/api/canvases/${canvasId}/entities?fields=geometry`)).body;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [], badResponses = [];
page.on("response", r => { if (r.status() >= 500) badResponses.push({ status: r.status(), url: r.url().replace(origin, "") }); });
page.on("console", msg => { if (msg.type() === "error" && !/status of 409/.test(msg.text())) consoleErrors.push(msg.text()); });
page.on("pageerror", error => consoleErrors.push(String(error)));
const node = id => page.locator(`.react-flow__node[data-id="${id}"]`);
async function open() {
  const loaded = page.waitForResponse(r => r.url().includes("/entities"), { timeout: 30000 });
  await page.goto(`${base}?canvas=${canvasId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await loaded;
  await node("d1").waitFor({ timeout: 30000 });
  await sleep(1200);
}
async function drag(id, dx, dy) {
  const target = node(id).locator('[aria-label="文本节点内容"]');
  const b = await target.boundingBox();
  const start = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(start.x + (dx * i) / 40, start.y + (dy * i) / 40);
  await page.mouse.up();
}
async function waitGeometry(id, predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const n = (await entities()).nodes.find(x => x.id === id); if (n && predicate(n)) return n; await sleep(200); }
  return (await entities()).nodes.find(x => x.id === id);
}
const shot = async name => page.screenshot({ path: path.join(outDir, `${phase}-${name}.png`) });

await open();
check("画布在浏览器中加载", (await page.locator(".react-flow__node").count()) === 3, `节点 ${await page.locator(".react-flow__node").count()}`);
await shot("01-loaded");
if (phase === "json") {
  const before = (await entities()).nodes.find(n => n.id === "d1");
  await drag("d1", 160, 90);
  const after = await waitGeometry("d1", n => n.geometryVersion > before.geometryVersion);
  check("JSON 模式拖动经命令保存", after.geometryVersion === before.geometryVersion + 1, `geometryVersion ${before.geometryVersion}→${after.geometryVersion}`);
  state.d1 = after.geometry;
  state.jsonEpoch = (await entities()).storageEpoch;
  state.jsonRevision = (await entities()).revision;
  await shot("02-dragged");
} else {
  const snap = await entities();
  check("切换后存储纪元变为 SQLite", /^sqlite-/.test(snap.storageEpoch) && snap.storageEpoch !== state.jsonEpoch, `${state.jsonEpoch} → ${snap.storageEpoch}`);
  const d1 = snap.nodes.find(n => n.id === "d1");
  check("JSON 时期的拖动位置在 SQLite 中保留", JSON.stringify(d1.geometry) === JSON.stringify(state.d1), JSON.stringify(d1.geometry));
  check("revision 延续", snap.revision === state.jsonRevision, `${state.jsonRevision} → ${snap.revision}`);
  const full = await api("GET", `/api/canvases/${canvasId}`);
  check("正文从 documents 还原", full.body.nodes.find(n => n.id === "d2")?.data.content === "演练正文二");
  const before = snap.nodes.find(n => n.id === "d2");
  await drag("d2", -120, 220);
  const after = await waitGeometry("d2", n => n.geometryVersion > before.geometryVersion);
  check("SQLite 模式拖动经命令保存", after.geometryVersion === before.geometryVersion + 1, `geometryVersion ${before.geometryVersion}→${after.geometryVersion}`);
  await shot("02-dragged");
  await open();
  const reloaded = (await entities()).nodes.find(n => n.id === "d2");
  const domBox = await node("d2").boundingBox();
  check("刷新后位置仍是 SQLite 中的新位置（且确实移动过）", JSON.stringify(reloaded.geometry) === JSON.stringify(after.geometry) && JSON.stringify(after.geometry) !== JSON.stringify(before.geometry) && !!domBox, `${JSON.stringify(before.geometry)} → ${JSON.stringify(reloaded.geometry)}`);
  await shot("03-reloaded");
  const stale = await api("POST", `/api/canvases/${canvasId}/commands`, { schemaVersion: 1, commandId: randomUUID(), actorId: randomUUID(), actorSeq: 1, canvasId, storageEpoch: state.jsonEpoch, baseRevision: 0, kind: "patch_nodes", payload: { items: [{ nodeId: "d3", field: "name", expectedVersion: 0, value: "旧纪元" }] } });
  check("旧纪元客户端命令被 stale_epoch 拒绝（不写入新库）", stale.status === 409 && stale.body?.error?.code === "stale_epoch", `status ${stale.status} ${stale.body?.error?.code}`);
  const list = await api("GET", "/api/canvases");
  check("画布列表来自 SQLite", Array.isArray(list.body?.canvases ?? list.body) || list.status === 200, `status ${list.status}`);
}
check("无 5xx 响应", badResponses.length === 0, JSON.stringify(badResponses.slice(0, 3)));
check("无页面错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
await browser.close();
writeFileSync(stateFile, JSON.stringify(state, null, 2));
const resultFile = path.join(outDir, `${phase}-results.json`);
writeFileSync(resultFile, JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`${phase}: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
