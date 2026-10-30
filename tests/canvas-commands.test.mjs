import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { loadTypescript } from "./helpers/load-typescript.mjs";
import { canvasFixture } from "./helpers/canvas-fixture.mjs";

// 独立临时数据目录：绝不读写真实 ~/.grok-canvas 画布。
const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-commands-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
after(async () => {
  await store.dispose();
  await service.dispose();
  await repository.dispose();
  await rm(dataDir, { recursive: true, force: true });
});
const { saveCanvas, loadCanvas, transformCanvas, deleteCanvas, publicCanvas } = store.module;
const { executeCommand, CommandError, JSON_STORAGE_EPOCH } = service.module;
const { loadEntitySnapshot } = repository.module;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "22222222-2222-4222-8222-222222222222";
const actorSeqs = new Map();
const nextSeq = (canvasId, actorId) => {
  const key = `${canvasId}/${actorId}`;
  const value = (actorSeqs.get(key) ?? 0) + 1;
  actorSeqs.set(key, value);
  return value;
};
const command = (canvasId, kind, payload, extra = {}) => {
  const actorId = extra.actorId ?? ACTOR_A;
  return { schemaVersion: 1, commandId: uuid(), actorId, actorSeq: extra.actorSeq ?? nextSeq(canvasId, actorId), canvasId, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0, kind, payload, ...extra };
};
const run = (input, context = { origin: "client" }) => executeCommand(input, context);
const rejectsWith = async (promise, code, status) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CommandError || error?.name === "CommandValidationError", `unexpected ${error}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
};

const baseDoc = (id) => ({
  id, name: "命令画布", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: "n1", type: "image", position: { x: 0, y: 0 }, data: { name: "图1", prompt: "猫", status: "idle", assetName: "a1.png", aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
    { id: "n2", type: "image", position: { x: 400, y: 0 }, data: { name: "图2", prompt: "狗", status: "idle", assetName: null, aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } },
    { id: "t1", type: "canvasText", position: { x: 0, y: 400 }, width: 360, height: 260, data: { name: "文本", content: "旧正文" } },
    { id: "s1", type: "asset", position: { x: -400, y: 0 }, data: { name: "素材", assetName: "s1.png" } },
    { id: "v1", type: "video", position: { x: 800, y: 0 }, data: { name: "视频", prompt: "", duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true, status: "idle", uploadInputs: [] } },
  ],
  edges: [{ id: "e1", source: "s1", target: "v1", type: "scissor", data: { role: "first" } }],
});
let canvasCount = 0;
const createCanvas = async (doc) => {
  const id = `cmd-${++canvasCount}`;
  const saved = await saveCanvas({ ...(doc ? doc(id) : baseDoc(id)) }, -1);
  assert.ok(saved);
  return id;
};
const entities = async (canvasId) => {
  const snapshot = await loadEntitySnapshot(canvasId);
  return { ...snapshot, node: (id) => snapshot.nodes.find(n => n.id === id), edge: (id) => snapshot.edges.find(e => e.id === id), doc: (nodeId) => snapshot.documents.find(d => d.nodeId === nodeId) };
};
const moveCmd = (canvasId, node, to, extra) => command(canvasId, "move_nodes", { items: [{ nodeId: node.id, expectedVersion: node.geometryVersion, from: node.geometry, to: { ...node.geometry, ...to } }] }, extra);
const patchCmd = (canvasId, nodeId, field, expectedVersion, value, extra) => command(canvasId, "patch_nodes", { items: [{ nodeId, field, expectedVersion, value }] }, extra);

test("两个 actor 并发改位置和正文可以共存，revision 各 +1", async () => {
  const id = await createCanvas();
  const state = await entities(id);
  const [moved, patched] = await Promise.all([
    run(moveCmd(id, state.node("n1"), { x: 50, y: 60 })),
    run(patchCmd(id, "t1", "content", state.doc("t1").version, "新正文", { actorId: ACTOR_B })),
  ]);
  assert.deepEqual([moved.revision, patched.revision].sort(), [1, 2]);
  assert.equal(moved.replayed, false);
  assert.deepEqual(moved.changedNodeIds, ["n1"]);
  assert.deepEqual(moved.delta.documents, []);
  assert.deepEqual(patched.delta.documents.map(d => d.content), ["新正文"]);
  const doc = await loadCanvas(id);
  assert.equal(doc.revision, 2);
  assert.deepEqual(doc.nodes.find(n => n.id === "n1").position, { x: 50, y: 60 });
  assert.equal(doc.nodes.find(n => n.id === "t1").data.content, "新正文");
  const after = await entities(id);
  assert.equal(after.node("n1").geometryVersion, 1);
  assert.equal(after.doc("t1").version, 1);
  assert.equal(after.node("n2").entityVersion, 0, "无关节点版本不变");
});

test("同字段旧版本失败，失败不改内容；不同字段互不阻塞", async () => {
  const id = await createCanvas();
  const first = await run(patchCmd(id, "n1", "prompt", 0, "第一版"));
  assert.ok(first.fieldVersions.some(f => f.target === "node" && f.id === "n1" && f.field === "prompt" && f.version === 1));
  await rejectsWith(run(patchCmd(id, "n1", "prompt", 0, "过期写入", { actorId: ACTOR_B })), "field_conflict", 409);
  await run(patchCmd(id, "n1", "name", 0, "新名字", { actorId: ACTOR_B }));
  const doc = await loadCanvas(id);
  const n1 = doc.nodes.find(n => n.id === "n1");
  assert.equal(n1.data.prompt, "第一版");
  assert.equal(n1.data.name, "新名字");
});

test("batch 后一项失败时前一项不生效，也不留半条边", async () => {
  const id = await createCanvas();
  const state = await entities(id);
  const before = await loadCanvas(id);
  const n1 = state.node("n1");
  const batch = command(id, "batch", { commands: [
    { kind: "move_nodes", payload: { items: [{ nodeId: "n1", expectedVersion: 0, from: n1.geometry, to: { ...n1.geometry, x: 999 } }] } },
    { kind: "edit_edges", payload: { add: [{ id: "e-new", canvasId: id, source: "n1", target: "n2", role: null, version: 0 }], remove: [] } },
    { kind: "patch_nodes", payload: { items: [{ nodeId: "n2", field: "prompt", expectedVersion: 7, value: "x" }] } },
  ] });
  await rejectsWith(run(batch), "field_conflict", 409);
  const doc = await loadCanvas(id);
  assert.equal(doc.revision, before.revision);
  assert.deepEqual(doc.nodes.find(n => n.id === "n1").position, { x: 0, y: 0 });
  assert.equal(doc.edges.length, 1);
  const retry = await run({ ...batch }).catch(e => e);
  assert.equal(retry.code, "field_conflict", "同一命令重试得到同样的拒绝结果");
});

test("响应丢失后同 ID 重试返回原回执，revision 只 +1，事件只 1 条；模块重载后仍然幂等", async () => {
  const id = await createCanvas();
  const state = await entities(id);
  const input = moveCmd(id, state.node("n2"), { x: 1, y: 2 });
  const first = await run(input);
  const second = await run(structuredClone(input));
  assert.equal(second.replayed, true);
  assert.equal(second.revision, first.revision);
  assert.equal(second.eventSeq, first.eventSeq);
  assert.deepEqual({ ...second, replayed: false }, first);
  assert.equal((await loadCanvas(id)).revision, 1);
  assert.equal((await entities(id)).eventSeq, 1);
  const reloaded = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
  try {
    const third = await reloaded.module.executeCommand(structuredClone(input), { origin: "client" });
    assert.equal(third.replayed, true);
    assert.equal(third.revision, first.revision);
  } finally { await reloaded.dispose(); }
  assert.equal((await loadCanvas(id)).revision, 1);
});

test("同 commandId 不同载荷返回 409 command_id_reused，内容不变", async () => {
  const id = await createCanvas();
  const input = patchCmd(id, "n1", "prompt", 0, "原值");
  await run(input);
  const tampered = { ...input, payload: { items: [{ ...input.payload.items[0], value: "篡改" }] } };
  await rejectsWith(run(tampered), "command_id_reused", 409);
  assert.equal((await loadCanvas(id)).nodes.find(n => n.id === "n1").data.prompt, "原值");
});

test("actorSeq 只接受 accepted+1；不同 actor 互不阻塞", async () => {
  const id = await createCanvas();
  await run(patchCmd(id, "n1", "name", 0, "a", { actorSeq: 1 }));
  await rejectsWith(run(patchCmd(id, "n2", "name", 0, "b", { actorSeq: 3 })), "actor_sequence_gap", 409);
  await rejectsWith(run(patchCmd(id, "n2", "name", 0, "b", { actorSeq: 1 })), "actor_sequence_gap", 409);
  await run(patchCmd(id, "n2", "name", 0, "b", { actorSeq: 2 }));
  await run(patchCmd(id, "t1", "name", 0, "c", { actorId: ACTOR_B, actorSeq: 1 }));
  assert.equal((await entities(id)).actors[ACTOR_A].acceptedSeq, 2);
});

test("已删除画布返回 canvas_deleted；旧存储纪元返回 stale_epoch，均不占用序号", async () => {
  const id = await createCanvas();
  await rejectsWith(run(patchCmd(id, "n1", "name", 0, "x", { storageEpoch: "sqlite-1", actorSeq: 1 })), "stale_epoch", 409);
  await run(patchCmd(id, "n1", "name", 0, "x", { actorSeq: 1 }));
  await deleteCanvas(id);
  await rejectsWith(run(patchCmd(id, "n1", "name", 1, "y", { actorSeq: 2 })), "canvas_deleted", 404);
  await rejectsWith(run(patchCmd("never-existed", "n1", "name", 0, "y", { actorSeq: 1 })), "canvas_deleted", 404);
});

test("空变更记录幂等回执，但不增加 revision/eventSeq", async () => {
  const id = await createCanvas();
  const state = await entities(id);
  const noop = moveCmd(id, state.node("n1"), {});
  const receipt = await run(noop);
  assert.equal(receipt.revision, 0);
  assert.equal(receipt.eventSeq, 0);
  assert.deepEqual(receipt.changedNodeIds, []);
  assert.equal((await loadCanvas(id)).revision, 0);
  const replay = await run(structuredClone(noop));
  assert.equal(replay.replayed, true);
  const same = await run(patchCmd(id, "n1", "prompt", 0, "猫"));
  assert.equal(same.revision, 0, "值未变化的 patch 也是空变更");
});

test("删除节点级联删边与正文、留下墓碑；旧命令不能复活", async () => {
  const id = await createCanvas();
  const state = await entities(id);
  const removal = await run(command(id, "delete_nodes", { items: [{ nodeId: "s1", expectedEntityVersion: 0 }, { nodeId: "t1", expectedEntityVersion: 0 }] }));
  assert.deepEqual(removal.delta.removedNodeIds.sort(), ["s1", "t1"]);
  assert.deepEqual(removal.delta.removedEdgeIds, ["e1"]);
  assert.deepEqual(removal.delta.removedDocumentIds, ["doc_t1"]);
  const doc = await loadCanvas(id);
  assert.deepEqual(doc.nodes.map(n => n.id), ["n1", "n2", "v1"]);
  assert.deepEqual(doc.edges, []);
  const revived = state.node("s1");
  await rejectsWith(run(command(id, "add_nodes", { nodes: [{ ...revived, entityVersion: 0, geometryVersion: 0 }], documents: [] })), "field_conflict", 409);
  await rejectsWith(run(patchCmd(id, "s1", "name", 0, "复活")), "field_conflict", 409);
  await rejectsWith(run(command(id, "delete_nodes", { items: [{ nodeId: "n1", expectedEntityVersion: 5 }] })), "field_conflict", 409);
});

test("连线：端点规则与引用槽位按现有规则校验，只校验受影响节点", async () => {
  const id = await createCanvas();
  const bad = command(id, "edit_edges", { add: [{ id: "e-bad", canvasId: id, source: "v1", target: "n1", role: null, version: 0 }], remove: [] });
  await rejectsWith(run(bad), "invalid_command", 400);
  const secondFirst = command(id, "edit_edges", { add: [{ id: "e-first2", canvasId: id, source: "n1", target: "v1", role: "first", version: 0 }], remove: [] });
  await rejectsWith(run(secondFirst), "invalid_command", 400);
  const ok = await run(command(id, "edit_edges", { add: [{ id: "e-ref", canvasId: id, source: "n1", target: "v1", role: "reference", version: 0 }], remove: [{ edgeId: "e1", expectedVersion: 0 }] }));
  assert.deepEqual(ok.changedEdgeIds, ["e-ref"]);
  assert.deepEqual(ok.delta.removedEdgeIds, ["e1"]);
  const doc = await loadCanvas(id);
  assert.deepEqual(doc.edges, [{ id: "e-ref", source: "n1", target: "v1", type: "scissor", data: { role: "reference" } }]);
  await rejectsWith(run(command(id, "edit_edges", { add: [], remove: [{ edgeId: "e-ref", expectedVersion: 3 }] })), "field_conflict", 409);
});

test("新增节点、改名与素材登记；apply_generation 不向客户端开放", async () => {
  const id = await createCanvas();
  const added = await run(command(id, "add_nodes", {
    nodes: [{ id: "t9", canvasId: id, type: "canvasText", schemaVersion: 1, geometry: { x: 10, y: 10, width: 300, height: 200 }, entityVersion: 0, geometryVersion: 0, documentId: "doc_t9", data: { name: "新文本" } }],
    documents: [{ id: "doc_t9", nodeId: "t9", content: "hello", version: 0 }],
  }));
  assert.deepEqual(added.changedNodeIds, ["t9"]);
  const renamed = await run(command(id, "rename_canvas", { expectedVersion: 0, name: "改名后" }));
  assert.equal(renamed.delta.name, "改名后");
  await rejectsWith(run(command(id, "rename_canvas", { expectedVersion: 0, name: "过期" })), "field_conflict", 409);
  const registered = await run(command(id, "register_assets", { assets: [{ assetName: "zz-missing.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z", missing: false }] }), { origin: "client", assetExists: () => false });
  assert.deepEqual(registered.delta.assets, [{ assetName: "zz-missing.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z", missing: true }]);
  const doc = await loadCanvas(id);
  assert.equal(doc.name, "改名后");
  const t9 = doc.nodes.find(n => n.id === "t9");
  assert.deepEqual([t9.width, t9.height, t9.data.content], [300, 200, "hello"]);
  const generation = command(id, "apply_generation", { nodeId: "n2", generationId: "g1", claimId: "g1", assets: [], patch: { status: "idle" } });
  await rejectsWith(run(generation), "invalid_command", 400);
  const again = await run(command(id, "register_assets", { assets: [{ assetName: "zz-missing.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z" }] }, { actorSeq: generation.actorSeq }), { origin: "client", assetExists: () => false });
  assert.equal(again.revision, registered.revision, "重复登记相同素材是空变更；解析/权限阶段被拒的命令不占用序号");
  assert.deepEqual(again.delta.assets, []);
});

test("apply_generation 由服务端执行；过期 generationId 只登记素材不覆盖新任务", async () => {
  const id = await createCanvas((cid) => {
    const doc = baseDoc(cid);
    doc.nodes[1].data = { ...doc.nodes[1].data, status: "running", generationId: "g-new" };
    return doc;
  });
  const stale = await run(command(id, "apply_generation", { nodeId: "n2", generationId: "g-old", claimId: "g-old", assets: [{ assetName: "late.png", kind: "image", createdAt: "2026-01-01T00:00:00.000Z" }], patch: { status: "idle", assetName: "late.png" } }), { origin: "server" });
  assert.deepEqual(stale.changedNodeIds, []);
  assert.equal(stale.delta.assets.length, 1);
  assert.equal((await loadCanvas(id)).nodes.find(n => n.id === "n2").data.status, "running");
  const fresh = await run(command(id, "apply_generation", { nodeId: "n2", generationId: "g-new", claimId: "g-new", assets: [], patch: { status: "idle", assetName: "done.png", appliedGenerationId: "g-new" } }), { origin: "server" });
  assert.deepEqual(fresh.changedNodeIds, ["n2"]);
  assert.equal((await loadCanvas(id)).nodes.find(n => n.id === "n2").data.assetName, "done.png");
});

test("万级画布只移动带 100KB 正文的节点：回执只含该节点且不含正文", async () => {
  const id = await createCanvas((cid) => ({ ...canvasFixture(10000, { longText: true }), id: cid }));
  const state = await entities(id);
  const n0 = state.node("node-0");
  const receipt = await run(moveCmd(id, n0, { x: 12345 }));
  const bytes = Buffer.byteLength(JSON.stringify(receipt));
  assert.deepEqual(receipt.changedNodeIds, ["node-0"]);
  assert.deepEqual(receipt.delta.documents, []);
  assert.equal(receipt.delta.nodes.length, 1);
  assert.ok(!JSON.stringify(receipt).includes("长文压力测试"), "回执不得包含正文");
  assert.ok(bytes < 4096, `回执过大：${bytes}`);
  const doc = await loadCanvas(id);
  assert.equal(doc.nodes[0].position.x, 12345);
  assert.equal(doc.nodes[0].data.content.length, "长文压力测试。".length * 4761);
});

test("旧路径写入会递增字段版本；客户端整份保存带来的 commandState 被忽略", async () => {
  const id = await createCanvas();
  await run(patchCmd(id, "n1", "name", 0, "命令写入"));
  await transformCanvas(id, (doc) => ({ ...doc, nodes: doc.nodes.map(n => n.id === "n2" ? { ...n, data: { ...n.data, prompt: "旧路径改的" } } : n) }));
  await rejectsWith(run(patchCmd(id, "n2", "prompt", 0, "拿旧版本覆盖")), "field_conflict", 409);
  const state = await entities(id);
  assert.equal(state.node("n2").data.prompt, "旧路径改的");
  const current = await loadCanvas(id);
  const forged = { ...current, commandState: { ...current.commandState, receipts: {}, actors: {} } };
  const saved = await saveCanvas(forged, current.revision);
  assert.ok(saved);
  assert.equal(Object.keys((await loadCanvas(id)).commandState.receipts).length, Object.keys(current.commandState.receipts).length);
  assert.equal("commandState" in publicCanvas(await loadCanvas(id)), false);
});

// ---------------------------------------------------------------- HTTP 路由

const routeSource = await readFile(new URL("../app/api/canvases/[id]/commands/route.ts", import.meta.url), "utf8").catch(() => "");
const routeModule = {};
if (routeSource) vm.runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: routeModule, Response, JSON, Promise, Array, Number, Object, String, Error,
  require(name) {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@/lib/canvas-runtime/command-service") return service.module;
    throw new Error(`未模拟依赖：${name}`);
  },
});
const post = (canvasId, body) => routeModule.POST(new Request(`http://127.0.0.1:3210/api/canvases/${canvasId}/commands`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: canvasId }) });

test("commands 路由：成功返回小型回执，错误按 C2 状态码与结构返回", async () => {
  assert.ok(routeModule.POST, "commands 路由存在");
  const id = await createCanvas();
  const ok = await post(id, patchCmd(id, "n1", "prompt", 0, "路由写入"));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.receipt.revision, 1);
  const conflict = await post(id, patchCmd(id, "n1", "prompt", 0, "过期"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "field_conflict");
  const invalid = await post(id, "{not json");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_command");
  const mismatch = await post(id, patchCmd("other-canvas", "n1", "prompt", 1, "x"));
  assert.equal(mismatch.status, 400);
  const internal = await post(id, command(id, "apply_generation", { nodeId: "n1", generationId: "g", claimId: "g", assets: [], patch: { status: "idle" } }));
  assert.equal(internal.status, 400);
  const huge = await post(id, JSON.stringify({ pad: "x".repeat(4 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
  const tooLong = await post(id, patchCmd(id, "t1", "content", 0, "字".repeat(100001)));
  assert.equal(tooLong.status, 413);
  const gone = await post("never-existed", patchCmd("never-existed", "n1", "prompt", 0, "x", { actorSeq: 1 }));
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, "canvas_deleted");
});

test("流式读取请求体：超过上限立即 413，不依赖 Content-Length", async () => {
  const { readLimitedBody } = service.module;
  const chunks = [new TextEncoder().encode("a".repeat(10)), new TextEncoder().encode("b".repeat(10))];
  const stream = new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } });
  const request = new Request("http://127.0.0.1:3210/x", { method: "POST", body: stream, duplex: "half", headers: { "content-length": "1" } });
  await assert.rejects(readLimitedBody(request, 15), (error) => error.status === 413);
  assert.equal(await readLimitedBody(new Request("http://127.0.0.1:3210/x", { method: "POST", body: "{\"a\":1}" }), 15), "{\"a\":1}");
});

test("命令测试已登记进 pnpm test", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:commands"], /tests\/canvas-commands\.test\.mjs/);
});
