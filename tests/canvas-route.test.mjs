import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 独立临时数据目录：绝不读写真实 ~/.grok-canvas 画布。
const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-route-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const store = await loadTypescript("lib/canvas-store.ts");
const library = await loadTypescript("lib/canvas-library.ts");
const operations = await loadTypescript("lib/canvas-operations.ts");
after(async () => {
  await store.dispose();
  await library.dispose();
  await operations.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

const operationsSource = await readFile(new URL("../app/api/canvases/[id]/operations/route.ts", import.meta.url), "utf8");
const operationsRoute = {};
vm.runInNewContext(ts.transpileModule(operationsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: operationsRoute, Response, JSON, Promise, Array, Number, Object, String, Date, Error,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "zod") return { z };
    if (name === "@/lib/canvas-store") return store.module;
    if (name === "@/lib/canvas-operations") return operations.module;
    throw new Error(`未模拟依赖：${name}`);
  },
});

const { saveCanvas, saveLastCanvasId, loadLastCanvasId } = store.module;

const source = await readFile(new URL("../app/api/canvases/[id]/route.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const route = {};
vm.runInNewContext(code, {
  exports: route, Request, Response, URL, JSON, Promise, Array, Number, Object, String, Date, Error,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@/lib/canvas-library") return library.module;
    if (name === "@/lib/canvas-store") return store.module;
    if (name === "@/lib/agent/store") return { agentBusy: () => false };
    if (name === "@/lib/generation-claims") return { recoverStaleGenerationClaims: store.module.loadCanvas };
    throw new Error(`未模拟依赖：${name}`);
  },
});

const call = (method, id, body, search = "") => route[method](
  new Request(`http://127.0.0.1:3210/api/canvases/${id}${search}`, body === undefined ? {} : { method, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

// 列表路由每次 GET 都会更新最近画布；并发请求曾因 app-state.json 的 rename 竞争返回 500。
const listSource = await readFile(new URL("../app/api/canvases/route.ts", import.meta.url), "utf8");
const listRoute = {};
vm.runInNewContext(ts.transpileModule(listSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: listRoute, Response, JSON, Promise, Array, Number, Object, String, Date, Error,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@/lib/canvas-store") return store.module;
    throw new Error(`未模拟依赖：${name}`);
  },
});
const draft = (overrides = {}) => ({
  name: "画布",
  createdAt: "2026-10-25T00:00:00.000Z",
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: "n1", type: "image", data: { name: "图", results: [{ status: "success", assetName: "gen.png" }] } }],
  edges: [],
  libraryAssets: [{ assetName: "keep.png", name: "保留", sources: ["imported"], addedAt: "2026-10-25T00:00:00.000Z" }],
  ...overrides,
});

test("操作接口并发保存不同字段并拒绝同字段冲突，重试去重", async () => {
  const doc = await store.module.saveCanvas({ id: "operation-route", ...draft({ nodes: [{ id: "n", type: "canvasText", position: { x: 0, y: 0 }, data: { content: "旧", name: "原名" } }] }) }, -1);
  const operation = (id, field, before, after) => ({ id, target: "node", entityId: "n", path: ["data", field], before: { exists: true, value: before }, after: { exists: true, value: after } });
  const a = operation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "content", "旧", "新"), b = operation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "name", "原名", "新名");
  const callOperation = ops => operationsRoute.POST(new Request("http://localhost/api/canvases/operation-route/operations", { method: "POST", body: JSON.stringify({ operations: ops }) }), { params: Promise.resolve({ id: doc.id }) });
  const replies = await Promise.all([callOperation([a]), callOperation([b])]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  assert.equal((await callOperation([a])).status, 200);
  assert.equal((await callOperation([operation("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "content", "旧", "冲突")])).status, 409);
  const saved = await store.module.loadCanvas(doc.id);
  assert.equal(saved.nodes[0].data.content, "新");
  assert.equal(saved.nodes[0].data.name, "新名");
});

test("保存后目录写入画布，节点结果也自动登记", async () => {
  const created = await saveCanvas({ id: "route-a", ...draft() }, -1);
  assert.ok(created);
  const saved = await call("PUT", "route-a", { ...draft(), revision: created.revision });
  assert.equal(saved.status, 200);
  const doc = await saved.json();
  const names = doc.libraryAssets.map(item => item.assetName).sort();
  assert.deepEqual(names, ["gen.png", "keep.png"]);
  assert.equal((await call("GET", "route-a")).status, 200);
});

test("旧客户端省略目录字段时保留已有素材", async () => {
  const current = (await (await call("GET", "route-a")).json());
  const body = draft({ libraryAssets: undefined });
  const saved = await call("PUT", "route-a", { ...body, revision: current.revision });
  assert.equal(saved.status, 200);
  const doc = await saved.json();
  assert.ok(doc.libraryAssets.some(item => item.assetName === "keep.png"));
});

test("显式非法目录返回400且不覆盖存档", async () => {
  const before = await readFile(path.join(dataDir, "canvases", "route-a.json"), "utf8");
  for (const libraryAssets of ["x", [{ assetName: "../evil.png" }], [{ assetName: "video.mp4", name: "v", sources: ["imported"], addedAt: "2026-10-25T00:00:00.000Z" }]]) {
    const response = await call("PUT", "route-a", { ...draft(), libraryAssets, revision: 0 });
    assert.equal(response.status, 400);
  }
  assert.equal(await readFile(path.join(dataDir, "canvases", "route-a.json"), "utf8"), before);
});

test("revision不匹配返回409，缺少revision返回400", async () => {
  const { revision } = await (await call("GET", "route-a")).json();
  assert.equal((await call("PUT", "route-a", draft({ revision: revision + 5 }))).status, 409);
  assert.equal((await call("PUT", "route-a", draft())).status, 400);
});

test("后台读取不改变最近打开的画布", async () => {
  await mkdir(path.join(dataDir, "canvases"), { recursive: true });
  await writeFile(path.join(dataDir, "canvases", "route-b.json"), `${JSON.stringify({ id: "route-b", name: "B", revision: 0, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], libraryAssets: [] })}\n`);
  await saveLastCanvasId("route-a");
  assert.equal((await call("GET", "route-b", undefined, "?background=1")).status, 200);
  assert.equal(await loadLastCanvasId(), "route-a");
  assert.equal((await call("GET", "route-b")).status, 200);
  assert.equal(await loadLastCanvasId(), "route-b");
});
test("后台按版本读取时仅在版本未变化时返回 304", async () => {
  const doc = await store.module.loadCanvas("route-a");
  assert.equal((await call("GET", "route-a", undefined, `?background=1&sinceRevision=${doc.revision}`)).status, 304);
  assert.equal((await call("GET", "route-a", undefined, `?background=1&sinceRevision=${doc.revision + 1}`)).status, 200);
  assert.equal((await call("GET", "route-a", undefined, "?background=1&sinceRevision=invalid")).status, 200);
});

test("删除画布后保存返回409，迟到的后台回写不复活文档", async () => {
  const doc = await (await call("GET", "route-b")).json();
  assert.equal((await call("DELETE", "route-b")).status, 200);
  assert.equal((await call("GET", "route-b", undefined, "?background=1")).status, 404);
  assert.equal((await call("PUT", "route-b", { ...doc, revision: doc.revision })).status, 409);
  assert.equal((await call("GET", "route-b")).status, 404);
});
test("并发读取画布列表不会因最近画布写入竞争而失败", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => listRoute.GET()));
  assert.deepEqual(responses.map(item => item.status), Array(8).fill(200));
  const payloads = await Promise.all(responses.map(item => item.json()));
  assert.equal(new Set(payloads.map(item => item.lastCanvasId)).size, 1);
  const leftovers = (await readdir(dataDir)).filter(name => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
