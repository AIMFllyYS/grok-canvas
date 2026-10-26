// Runs the packaged application itself; never attaches to a user's browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(root, "release", "win-unpacked", "Grok Canvas.exe");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, "artifacts", `release-${manifest.version}`);
const origin = "http://127.0.0.1:3210";
const debugging = "http://127.0.0.1:9327";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reachable(url) { try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }
async function until(check, name, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(200); }
  throw new Error(`Timed out: ${name}`);
}
await access(executable);
assert.equal(await reachable(origin), false, "Close the project's server before testing the bundled server");
assert.equal(await reachable(`${debugging}/json/list`), false, "Debug port is already occupied");
await mkdir(output, { recursive: true });
const child = spawn(executable, ["--remote-debugging-port=9327", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${path.join(output, `profile-${Date.now()}`)}`], { windowsHide: true, env: { ...process.env, GROK_CANVAS_DATA_DIR: path.join(output, "data") }, stdio: ["ignore", "pipe", "pipe"] });
let log = "", socket, closedNormally = false;
child.stdout.on("data", data => { log = (log + data).slice(-12000); });
child.stderr.on("data", data => { log = (log + data).slice(-12000); });
try {
  const target = await until(async () => {
    try { const list = await (await fetch(`${debugging}/json/list`)).json(); return list.find(item => item.type === "page" && item.url.startsWith(origin)); } catch { return null; }
  }, "Electron page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let serial = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const result = JSON.parse(event.data);
    if (pending.has(result.id)) { const { resolve, reject, timer } = pending.get(result.id); clearTimeout(timer); pending.delete(result.id); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await until(() => evaluate("!!document.querySelector('.studio-agent-panel')"), "Agent ready");
  const initial = await evaluate("({theme:document.querySelector('.studio-app').dataset.appearance,savedTheme:localStorage.getItem('theme'),mode:document.querySelector('.studio-app').dataset.mode,desktopBridge:typeof window.grokDesktop?.openExternal==='function',oldNavigation:document.querySelectorAll('.studio-desk-tabs,.studio-desk-footer,.studio-desk-heading').length})");
  assert.equal(initial.theme, "paper"); assert.equal(initial.mode, "canvas"); assert.equal(initial.desktopBridge, true); assert.equal(initial.oldNavigation, 0);
  for (const route of ["/pre", "/playbook"]) assert.equal((await fetch(`${origin}${route}`)).status, 200, `Packaged route ${route}`);
  // Loading the chat route also checks the packaged SDK/provider dependencies without generating anything.
  assert.equal((await fetch(`${origin}/api/studio/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{}" })).status, 400);
  await evaluate("document.querySelector('button[aria-label=\"展开创作 Agent\"]').click();true");
  await until(() => evaluate("!!document.querySelector('.pre-floating:not([hidden]) textarea')"), "Floating Agent ready");
  const agent = await evaluate("(()=>{const r=document.querySelector('.pre-floating').getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth&&r.top>=52&&r.bottom<=innerHeight,newConversation:!!document.querySelector('button[aria-label=\"新建对话\"]'),history:!!document.querySelector('button[aria-label=\"历史对话\"]')};})()");
  assert.equal(agent.inside, true); assert.equal(agent.newConversation, true); assert.equal(agent.history, true);
  await evaluate("document.querySelector('button[aria-label=\"历史对话\"]').click();true");
  await until(() => evaluate("!!document.querySelector('.pre-chat-history button')"), "Conversation history");
  await evaluate("document.querySelector('button[aria-label=\"收起 Agent\"]').click();true");
  await evaluate("[...document.querySelectorAll('.studio-mode-switch button')].find(b=>b.textContent.trim()==='导演台').click();true");
  await until(() => evaluate("!!document.querySelector('select[aria-label=\"导演台视图\"]')"), "Director ready");
  const director = await evaluate("({view:document.querySelector('select[aria-label=\"导演台视图\"]').value,scrollbars:[...document.querySelectorAll('.studio-shot-center,.studio-shot-console')].map(e=>getComputedStyle(e).scrollbarWidth),topBars:document.querySelectorAll('.studio-topbar').length})");
  assert.equal(director.topBars, 1); assert.ok(director.scrollbars.every(value => value === "thin"));
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(output, "electron-desktop.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate("setTimeout(()=>window.close(),50);true");
  await until(() => child.exitCode !== null, "Electron exit", 15000);
  await until(async () => !(await reachable(origin)), "Bundled server cleanup", 10000);
  closedNormally = true;
  const result = { version: manifest.version, initial, agent, director, componentRoutes: ["/pre", "/playbook"], chatRouteValidation: 400, isolatedData: true, appExitCode: child.exitCode, serverStoppedWithApp: true };
  await writeFile(path.join(output, "electron-smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  if (!closedNormally && child.exitCode === null) { const cleanup = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); await once(cleanup, "exit"); }
  await writeFile(path.join(output, "electron-smoke.log"), log);
}
