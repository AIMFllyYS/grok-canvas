// P2-06 端到端：独立端口 + 临时数据目录启动的 standalone 产物，用脚本化 Playwright 走手测矩阵。
// 用法：先用独立端口、GROK_CANVAS_PORT 与临时 GROK_CANVAS_DATA_DIR 启动 standalone 产物，再运行
//   PLAYWRIGHT_MODULE=<playwright 目录> node scripts/e2e/canvas-gesture.e2e.mjs http://127.0.0.1:<port>/ <输出目录>
// 不要指向真实数据目录：脚本会新建画布并写入合成节点。
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Playwright 不是项目依赖：PLAYWRIGHT_MODULE 指向已安装的 playwright 包目录。
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
const longText = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：用于验证 nowheel 滚动的长文本。`).join("\n\n");

// ---------------------------------------------------------------- 种子画布
const created = await api("POST", "/api/canvases");
const canvasId = created.body.id;
const text = (id, x, y, content = `正文 ${id}`) => ({ id, type: "canvasText", position: { x, y }, width: 360, height: 260, data: { name: `文本 ${id}`, content } });
const seed = [text("n1", 0, 0), text("n2", 450, 0), text("n3", 900, 0, longText), text("n4", 0, 400), { id: "img", type: "image", position: { x: 450, y: 400 }, data: { name: "图片", assetName: null, uploadAttachments: [], prompt: "", aspectRatio: "auto", resolution: "1k", quality: "low", status: "idle", generationCount: 1, sourceNodeId: null } }];
const seeded = await api("POST", `/api/canvases/${canvasId}/operations`, { operations: seed.map(node => ({ id: randomUUID(), target: "node", entityId: node.id, path: [], before: { exists: false }, after: { exists: true, value: node } })) });
check("种子画布写入", seeded.status === 200, `status ${seeded.status}`);
const entities = async () => (await api("GET", `/api/canvases/${canvasId}/entities?fields=geometry`)).body;
const nodeOf = async id => (await entities()).nodes.find(n => n.id === id);

// ---------------------------------------------------------------- 浏览器
const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const requests = [];
page.on("request", request => {
  const url = request.url();
  if (!url.includes("/api/canvases/")) return;
  if (request.method() !== "POST") return;
  let body = null; try { body = request.postDataJSON(); } catch { /* ignore */ }
  requests.push({ at: Date.now(), url: url.replace(origin, ""), kind: body?.kind ?? null, commandId: body?.commandId ?? null, items: body?.payload?.items?.length ?? null, moves: body?.payload?.items?.map(i => ({ id: i.nodeId, from: i.from && [i.from.x, i.from.y], to: i.to && [i.to.x, i.to.y] })) ?? null, ops: Array.isArray(body?.operations) ? body.operations.map(op => op.path.join(".")) : null, action: body?.action ?? null });
});
const consoleErrors = [];
const badResponses = [];
page.on("response", response => {
  if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url().replace(origin, "") });
  if (response.url().endsWith("/commands")) void response.text().then(text => commandResponses.push({ status: response.status(), body: text.slice(0, 300) })).catch(() => {});
});
const commandResponses = [];
page.on("console", msg => { if (msg.type() === "error" && !/status of 409/.test(msg.text())) consoleErrors.push(msg.text()); });
page.on("pageerror", error => consoleErrors.push(String(error)));
const commands = () => requests.filter(r => r.url.endsWith("/commands"));
const geometryOps = () => requests.filter(r => r.url.endsWith("/operations") && r.ops?.some(p => /^(position|width|height)/.test(p)));
const shot = async name => { const file = path.join(outDir, `${name}.png`); await page.screenshot({ path: file }); return file; };
const node = id => page.locator(`.react-flow__node[data-id="${id}"]`);
const box = async id => node(id).boundingBox();
const center = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const entitiesLoaded = page.waitForResponse(r => r.url().includes("/entities"), { timeout: 30000 });
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await entitiesLoaded;
await page.locator(".react-flow__node").first().waitFor({ timeout: 30000 });
await sleep(1500);
check("画布加载并完成恢复屏障", (await page.locator(".react-flow__node").count()) === 5, `节点 ${await page.locator(".react-flow__node").count()}`);
await shot("01-loaded");

async function drag(id, dx, dy, { steps = 120, from = "content", during } = {}) {
  const target = from === "content" ? node(id).locator('[aria-label="文本节点内容"]') : node(id);
  const b = await target.boundingBox();
  const start = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(start.x + (dx * i) / steps, start.y + (dy * i) / steps);
    if (during && i === Math.floor(steps / 2)) await during();
  }
  await page.mouse.up();
}

// 1) 120 帧拖动 n1：途中 0 个写请求，结束 1 条 move_nodes，不走 operations 几何
{
  const before = await box("n1");
  const mark = requests.length;
  let duringWrites = -1;
  await drag("n1", 200, 120, { during: async () => { duringWrites = requests.slice(mark).filter(r => !r.url.endsWith("/edit-lease")).length; } });
  await sleep(1500);
  const after = await box("n1");
  const mine = requests.slice(mark);
  const cmds = mine.filter(r => r.url.endsWith("/commands"));
  check("拖动途中没有保存/命令请求（只有租约）", duringWrites === 0, `途中写请求 ${duringWrites}`);
  check("拖动结束恰好 1 条 move_nodes", cmds.length === 1 && cmds[0].kind === "move_nodes" && cmds[0].items === 1, JSON.stringify(cmds));
  check("旧 operations 不再发送这次移动", !mine.some(r => r.url.endsWith("/operations") && r.ops?.some(p => /^(position|width|height)/.test(p))));
  check("拖动期间拿了 geometry 租约并在结束后释放", mine.some(r => r.action === "claim") && mine.some(r => r.action === "release"), mine.filter(r => r.action).map(r => r.action).join(","));
  const server = await nodeOf("n1");
  check("服务端位置与版本更新", server.geometryVersion === 1 && Math.abs(server.geometry.x - 200) < 3 && Math.abs(server.geometry.y - 120) < 3, JSON.stringify(server.geometry));
  check("画面上节点停在落点（不回弹）", Math.abs(after.x - before.x - 200) < 3 && Math.abs(after.y - before.y - 120) < 3);
  await shot("02-after-drag");
}

// 2) 移回原点：按画面上节点的实际位置把它拖回起点（React Flow 越过拖动阈值才开始跟随），不产生命令
{
  const mark = commands().length;
  const origin2 = await box("n2");
  const b = await node("n2").locator('[aria-label="文本节点内容"]').boundingBox();
  const s = { x: b.x + b.width / 2, y: b.y + 60 };
  await page.mouse.move(s.x, s.y); await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(s.x + i * 4, s.y + i * 2);
  let pointer = { x: s.x + 120, y: s.y + 60 };
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = await box("n2");
    const dx = now.x - origin2.x, dy = now.y - origin2.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) break;
    pointer = { x: pointer.x - dx, y: pointer.y - dy };
    await page.mouse.move(pointer.x, pointer.y, { steps: 10 });
  }
  const back = await box("n2");
  await page.mouse.up();
  await sleep(1200);
  const atOrigin = Math.abs(back.x - origin2.x) < 0.01 && Math.abs(back.y - origin2.y) < 0.01;
  check("移回原点不产生命令", atOrigin && commands().length === mark, `回到原点 ${atOrigin}，新增 ${commands().length - mark} ${JSON.stringify(commands().slice(mark).map(c => c.moves))}`);
}

// 3) 群组移动 + 撤销 + 重做
{
  await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 850 } });
  await node("n1").click({ position: { x: 20, y: 20 } });
  await node("n4").click({ position: { x: 20, y: 20 }, modifiers: ["Control"] });
  await sleep(300);
  const mark = commands().length;
  const p1 = await nodeOf("n1"), p4 = await nodeOf("n4");
  await drag("n1", 120, 40, { steps: 60 });
  await sleep(1500);
  const group = commands().slice(mark);
  check("群组拖动只发 1 条命令且包含 2 个节点", group.length === 1 && group[0].items === 2, JSON.stringify(group));
  await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 850 } });
  await page.keyboard.press("Control+z");
  await sleep(1500);
  const u1 = await nodeOf("n1"), u4 = await nodeOf("n4");
  check("一次撤销恢复整组", u1.geometry.x === p1.geometry.x && u1.geometry.y === p1.geometry.y && u4.geometry.x === p4.geometry.x && u4.geometry.y === p4.geometry.y, JSON.stringify([u1.geometry, u4.geometry]));
  check("撤销是 1 条条件命令", commands().slice(mark).length === 2 && commands().at(-1).items === 2);
  await page.keyboard.press("Control+Shift+z");
  await sleep(1500);
  const r1 = await nodeOf("n1");
  check("重做回到移动后的位置", Math.abs(r1.geometry.x - (p1.geometry.x + 120)) < 3, JSON.stringify(r1.geometry));
  await shot("03-group-redo");
}

// 4) 拖动途中 Agent 改正文（旧路径写入）：结束后两者都保留
{
  const agentText = "Agent 在拖动途中写入的正文";
  const startBox = await box("n2");
  const startY = (await nodeOf("n2")).geometry.y;
  await drag("n2", 0, 160, { steps: 60, during: async () => {
    const current = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === "n2");
    const r = await api("POST", `/api/canvases/${canvasId}/operations`, { operations: [{ id: randomUUID(), target: "node", entityId: "n2", path: ["data", "content"], before: { exists: true, value: current.data.content }, after: { exists: true, value: agentText } }] });
    if (r.status !== 200) console.log("agent write failed", r.status, JSON.stringify(r.body));
  } });
  await sleep(4500);
  const server = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === "n2");
  const movedBy = server.position.y - startY;
  check("同时修改正文：服务端两者都保留", server.data.content === agentText && movedBy > 140, JSON.stringify({ movedBy, content: server.data.content }));
  const shown = await node("n2").locator('[aria-label="文本节点内容"]').innerText();
  const endBox = await box("n2");
  check("同时修改正文：画面显示 Agent 正文且位置不回弹", shown.includes(agentText) && endBox.y - startBox.y > 140, JSON.stringify({ shown: shown.slice(0, 40), dy: endBox.y - startBox.y }));
}

// 5) 拖动途中 Agent 移动同一节点：可见冲突，不回弹；选择“保留我的位置”后以远端版本重新提交
{
  const startBox = await box("n4");
  const startServer = await nodeOf("n4");
  await drag("n4", 0, 220, { steps: 60, during: async () => {
    const current = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === "n4");
    await api("POST", `/api/canvases/${canvasId}/operations`, { operations: [{ id: randomUUID(), target: "node", entityId: "n4", path: ["position"], before: { exists: true, value: current.position }, after: { exists: true, value: { x: current.position.x + 700, y: current.position.y } } }] });
  } });
  const toast = page.getByText(/个节点的位置已被其他修改改变/);
  const visible = await toast.waitFor({ timeout: 8000 }).then(() => true, () => false);
  check("同几何冲突可见", visible);
  const now = await box("n4");
  check("冲突待决时画面不回弹", Math.abs(now.y - startBox.y - 220) < 4, `dy=${now.y - startBox.y}`);
  await sleep(1200);
  await shot("04-geometry-conflict");
  const toastEl = page.locator("[data-sonner-toast]").filter({ hasText: "个节点的位置已被其他修改改变" }).first();
  if (await toastEl.count()) {
    await toastEl.screenshot({ path: path.join(outDir, "04b-conflict-toast.png") });
    const tb = await toastEl.boundingBox();
    check("冲突提示完整显示在视口内", tb && tb.y >= 0 && tb.x >= 0 && tb.x + tb.width <= 1440, JSON.stringify(tb));
  }
  if (visible) {
    await page.getByRole("button", { name: "保留我的位置" }).click();
    await sleep(2000);
    const server = await nodeOf("n4");
    check("保留我的位置：服务端采用用户落点", server.geometry.y - startServer.geometry.y > 200 && server.geometry.x === startServer.geometry.x, JSON.stringify({ start: startServer.geometry, now: server.geometry }));
  }
}

// 6) resize：用户 resize 提交 geometry 命令（含尺寸）
{
  await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 850 } });
  await node("n3").click({ position: { x: 20, y: 20 } });
  await sleep(300);
  const handle = node("n3").locator(".react-flow__resize-control.handle.bottom.right");
  const hb = await handle.boundingBox();
  const mark = commands().length;
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(hb.x + i * 3, hb.y + i * 2);
    await page.mouse.up();
    await sleep(1500);
  }
  const server = await nodeOf("n3");
  const resized = commands().slice(mark);
  check("resize 只发 1 条几何命令并写入新尺寸", !!hb && resized.length === 1 && server.geometry.width > 450 && server.geometry.height > 320, JSON.stringify({ found: !!hb, cmds: resized.length, g: server.geometry }));
}

// 7) nowheel：正文内滚轮只滚正文，不平移画布
{
  const content = node("n3").locator('[aria-label="文本节点内容"]');
  const vp = () => page.locator(".react-flow__viewport").getAttribute("style");
  const beforeVp = await vp();
  const beforeScroll = await content.evaluate(el => el.scrollTop);
  const cb = await content.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.wheel(0, 400);
  await sleep(400);
  check("正文 nowheel 滚动且画布不动", (await content.evaluate(el => el.scrollTop)) > beforeScroll && (await vp()) === beforeVp);
}

// 8) Space 平移：视口移动，不产生几何命令
{
  const vp = () => page.locator(".react-flow__viewport").getAttribute("style");
  const beforeVp = await vp();
  const mark = commands().length;
  await page.mouse.move(1200, 700);
  await page.keyboard.down("Space");
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(1200 - i * 8, 700 - i * 4);
  await page.mouse.up();
  await page.keyboard.up("Space");
  await sleep(800);
  check("Space 平移移动视口且不产生几何命令", (await vp()) !== beforeVp && commands().length === mark);
}

// 9) 局部按钮/标题不触发拖动（nodrag 保留）
{
  const title = node("n1").locator("button, input, [contenteditable], .nodrag").first();
  const count = await title.count();
  const before = await box("n1");
  const mark = commands().length;
  if (count) {
    const tb = await title.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2); await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(tb.x + tb.width / 2 + i * 6, tb.y + tb.height / 2 + i * 3);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await sleep(800);
  }
  const after = await box("n1");
  check("局部控件按下拖动不移动节点", count > 0 && Math.abs(after.x - before.x) < 2 && commands().length === mark, `控件 ${count}`);
}

// 10) 中文输入：选中图片节点，在提示词里输入中文后拖动其他节点，输入不丢
{
  await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 850 } });
  await sleep(300);
  const imgBox = await box("img");
  const imgPoint = { x: imgBox.x + imgBox.width / 2, y: imgBox.y + imgBox.height - 20 };
  await page.mouse.click(imgPoint.x, imgPoint.y);
  await sleep(600);
  const editor = page.locator(".ui-prompt-panel [contenteditable='true'], .ui-prompt-panel textarea").first();
  const hasEditor = await editor.count();
  if (hasEditor) {
    await editor.click();
    await page.keyboard.insertText("拖动不影响中文输入");
    await sleep(300);
    await drag("n1", 30, 30, { steps: 30 });
    await sleep(800);
    await page.mouse.click(imgPoint.x, imgPoint.y);
    await sleep(600);
  }
  const value = hasEditor ? await page.locator(".ui-prompt-panel").innerText() : "";
  check("中文输入在拖动其他节点后保留", hasEditor > 0 && value.includes("拖动不影响中文输入"), `editor ${hasEditor}`);
  await shot("05-ime");
}

// 11) 拖动途中失焦：只提交 1 条命令，保存闸门不被提前打开
{
  await page.keyboard.press("Escape");
  const mark = requests.length;
  await drag("n2", 60, 0, { steps: 40, during: async () => { await page.evaluate(() => window.dispatchEvent(new Event("blur"))); } });
  await sleep(1500);
  const mine = requests.slice(mark);
  check("失焦后继续拖动只产生 1 条移动命令", new Set(mine.filter(r => r.kind === "move_nodes").map(r => r.commandId)).size === 1 && !mine.some(r => r.url.endsWith("/operations") && r.ops?.some(p => /^(position|width|height)/.test(p))), JSON.stringify(mine.map(r => r.kind ?? r.url.split("/").pop())));
}

// 12) 刷新后位置来自服务端；离开前不应还有未保存/未确认的修改
{
  await sleep(2500);
  const expected = await nodeOf("n1");
  const dialogs = [];
  page.on("dialog", dialog => { dialogs.push(dialog.type()); void dialog.accept(); });
  const pendingBefore = await page.evaluate(async () => {
    const open = indexedDB.open("grok-canvas-drafts");
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const read = name => new Promise(resolve => { try { const r = db.transaction(name, "readonly").objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve([]); } catch { resolve([]); } });
    const outbox = await read("outbox"), drafts = await read("drafts");
    return { outbox: outbox.map(r => ({ state: r.state, kind: r.command?.kind })), drafts: drafts.length };
  });
  const ready = page.waitForResponse(r => r.url().includes("/entities"), { timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready;
  await node("n1").waitFor();
  await sleep(1200);
  check("离开页面前没有未保存修改（无 beforeunload 拦截，outbox 已清空）", dialogs.length === 0 && pendingBefore.outbox.length === 0, JSON.stringify({ dialogs, pendingBefore }));
  const doc = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body;
  const n1 = doc.nodes.find(n => n.id === "n1");
  check("刷新后位置持久", n1.position.x === expected.geometry.x && n1.position.y === expected.geometry.y);
  await shot("06-reloaded");
}

// 13) P2-07 用户离散动作：正文编辑 / 删除 / 撤销删除 / 复制粘贴 都是领域命令
{
  await page.keyboard.press("Escape");
  const selectNode = async id => {
    await page.locator(".react-flow__pane").click({ position: { x: 1300, y: 850 }, force: true });
    const b = await box(id);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height - 30);
    await sleep(400);
    let selected = await node(id).evaluate(el => el.classList.contains("selected"));
    if (!selected) {
      // 被其他节点遮住时用 React Flow 的键盘选择（聚焦节点 + Enter）。
      await node(id).focus();
      await page.keyboard.press("Enter");
      await sleep(400);
      selected = await node(id).evaluate(el => el.classList.contains("selected"));
    }
    if (!selected) console.log(`select ${id} failed at`, JSON.stringify(b));
  };
  // 前面的 Space 平移把部分节点移出视口：先适应全部节点。
  await page.getByLabel("适应全部节点").click();
  await sleep(800);
  await selectNode("n1");
  const area = page.getByLabel("编辑文本节点");
  const mark = commands().length;
  const areaCount = await area.count();
  if (areaCount) {
    await area.fill("用户在面板里改的正文");
    await sleep(1800);
  }
  const edits = commands().slice(mark);
  const server = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body.nodes.find(n => n.id === "n1");
  check("正文编辑走 patch_nodes 并写入服务端", edits.some(c => c.kind === "patch_nodes") && server.data.content === "用户在面板里改的正文", JSON.stringify({ areaCount, kinds: edits.map(c => c.kind), content: server.data.content, responses: commandResponses.slice(-2) }));

  await selectNode("n4");
  const delMark = commands().length;
  await page.keyboard.press("Delete");
  await sleep(1800);
  const afterDelete = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body;
  check("删除走 delete_nodes，服务端节点移除", commands().slice(delMark).some(c => c.kind === "delete_nodes") && !afterDelete.nodes.some(n => n.id === "n4"));
  await page.keyboard.press("Control+z");
  await sleep(1800);
  const afterUndo = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body;
  const restoredText = afterUndo.nodes.find(n => n.data?.content === "正文 n4");
  check("撤销删除用新 ID 重建（墓碑不复活）", !!restoredText && restoredText.id !== "n4" && commands().slice(delMark).some(c => c.kind === "add_nodes"), JSON.stringify(restoredText?.id));

  await selectNode("n2");
  const before = afterUndo.nodes.length;
  const pasteMark = commands().length;
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await sleep(1800);
  const afterPaste = (await api("GET", `/api/canvases/${canvasId}?background=1`)).body;
  check("复制粘贴走 add_nodes，ID 新分配", afterPaste.nodes.length === before + 1 && commands().slice(pasteMark).some(c => c.kind === "add_nodes") && new Set(afterPaste.nodes.map(n => n.id)).size === afterPaste.nodes.length);
  const leaking = requests.filter(r => r.url.endsWith("/operations") && r.ops?.some(p => /^(data\.(content|prompt|draftPrompt|name)|position|width|height)/.test(p)));
  check("operations 只剩兼容字段（无正文/提示词/名称/几何）", leaking.length === 0, JSON.stringify(leaking.slice(0, 2)));
}

check("无页面错误", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
check("唯一的非 2xx 响应是冲突场景里 /commands 的 409", badResponses.length >= 1 && badResponses.every(r => r.status === 409 && r.url.endsWith("/commands")), JSON.stringify(badResponses));
check("全程旧 operations 未发送几何", geometryOps().length === 0, JSON.stringify(geometryOps().slice(0, 3)));
await browser.close();
writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ base, canvasId, results, commands: commands().length, consoleErrors }, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`E2E ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
