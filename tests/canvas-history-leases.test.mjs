import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-history-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
const historyModule = await loadTypescript("lib/canvas-runtime/history.ts", { packages: true });
const leaseModule = await loadTypescript("lib/canvas-runtime/lease-service.ts");
const legacyLeases = await loadTypescript("lib/canvas-edit-leases.ts");
after(async () => {
  for (const loaded of [store, service, repository, historyModule, leaseModule, legacyLeases]) await loaded.dispose();
  await rm(dataDir, { recursive: true, force: true });
});
const { saveCanvas, loadCanvas } = store.module;
const { executeCommand, CommandError, JSON_STORAGE_EPOCH } = service.module;
const { loadEntitySnapshot } = repository.module;
const { recordCommitted, createUndoCommand, createRedoCommand, historyReaderFromSnapshot } = historyModule.module;
const { createLeaseService, LEASE_TTL_MS, LEASE_RENEW_MS } = leaseModule.module;

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const seqs = new Map();
const nextSeq = (canvasId, actorId) => { const k = `${canvasId}/${actorId}`; const v = (seqs.get(k) ?? 0) + 1; seqs.set(k, v); return v; };
const envelope = (canvasId, actorId) => ({ schemaVersion: 1, commandId: uuid(), actorId, actorSeq: nextSeq(canvasId, actorId), canvasId, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0 });
const cmd = (canvasId, actorId, kind, payload) => ({ ...envelope(canvasId, actorId), kind, payload });
const ids = (canvasId, actorId) => { const e = envelope(canvasId, actorId); return { commandId: e.commandId, actorId, actorSeq: e.actorSeq, storageEpoch: e.storageEpoch, baseRevision: 0, createId: uuid }; };
const reader = async (canvasId) => historyReaderFromSnapshot(await loadEntitySnapshot(canvasId));

const image = (id, x = 0) => ({ id, type: "image", position: { x, y: 0 }, data: { name: id, prompt: "p", status: "idle", assetName: `${id}.png`, aspectRatio: "auto", resolution: "1k", quality: "low", uploadAttachments: [] } });
let canvases = 0;
const createCanvas = async (nodes = [image("x"), image("y", 400)], edges = []) => {
  const id = `hist-${++canvases}`;
  assert.ok(await saveCanvas({ id, name: "历史", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges }, -1));
  return id;
};
/** 执行命令并记录历史（与 UI 的使用方式一致：提交前取读取器，提交后用回执记录）。 */
const commit = async (canvasId, command, context = { origin: "client" }) => {
  const before = await reader(canvasId);
  const receipt = await executeCommand(command, context);
  return { receipt, entry: recordCommitted(command, before, receipt) };
};
const moveOf = async (canvasId, actorId, moves) => {
  const r = await reader(canvasId);
  return cmd(canvasId, actorId, "move_nodes", { items: moves.map(([nodeId, to]) => { const n = r.getNode(nodeId); return { nodeId, expectedVersion: n.geometryVersion, from: n.geometry, to: { ...n.geometry, ...to } }; }) });
};
const position = async (canvasId, nodeId) => (await loadCanvas(canvasId)).nodes.find(n => n.id === nodeId).position;

test("A 移动 x、B 改 prompt、A 撤销：x 复位，prompt 保留", async () => {
  const id = await createCanvas();
  const { entry } = await commit(id, await moveOf(id, A, [["x", { x: 100, y: 50 }]]));
  await commit(id, cmd(id, B, "patch_nodes", { items: [{ nodeId: "x", field: "prompt", expectedVersion: 0, value: "B 的提示词" }] }));
  const undo = createUndoCommand(entry, await reader(id), ids(id, A));
  assert.equal(undo.ok, true);
  await executeCommand(undo.command, { origin: "client" });
  assert.deepEqual(await position(id, "x"), { x: 0, y: 0 });
  assert.equal((await loadCanvas(id)).nodes.find(n => n.id === "x").data.prompt, "B 的提示词");
});

test("B 随后改了 x 的位置：A 的撤销整条拒绝并列出冲突；绕过客户端检查也被服务端整批拒绝", async () => {
  const id = await createCanvas();
  const { entry } = await commit(id, await moveOf(id, A, [["x", { x: 100 }], ["y", { x: 900 }]]));
  const stale = await reader(id);
  await commit(id, await moveOf(id, B, [["x", { x: 300 }]]));
  const undoIds = ids(id, A);
  const undo = createUndoCommand(entry, await reader(id), undoIds);
  assert.equal(undo.ok, false);
  assert.deepEqual(undo.conflicts, [{ target: "node", id: "x", field: "geometry" }]);
  const forced = createUndoCommand(entry, stale, undoIds);
  assert.equal(forced.ok, true);
  await assert.rejects(executeCommand(forced.command, { origin: "client" }), (error) => {
    assert.equal(error.code, "field_conflict");
    assert.deepEqual(error.fields.map(f => f.path), ["node/x/geometry"]);
    return true;
  });
  assert.equal((await position(id, "y")).x, 900, "y 没有被半撤销");
  assert.equal((await position(id, "x")).x, 300);
});

test("100 节点群组撤销中 1 个被他人改动：全部保持当前值，返回确切冲突 ID", async () => {
  const nodes = Array.from({ length: 100 }, (_, i) => image(`g${i}`, i * 300));
  const id = await createCanvas(nodes);
  const { entry } = await commit(id, await moveOf(id, A, nodes.map((n, i) => [n.id, { y: 1000 + i }])));
  const stale = await reader(id);
  await commit(id, await moveOf(id, B, [["g57", { y: -5 }]]));
  const undoIds = ids(id, A);
  const undo = createUndoCommand(entry, await reader(id), undoIds);
  assert.deepEqual(undo.conflicts, [{ target: "node", id: "g57", field: "geometry" }]);
  const forced = createUndoCommand(entry, stale, undoIds);
  await assert.rejects(executeCommand(forced.command, { origin: "client" }), (error) => {
    assert.deepEqual(error.fields.map(f => f.path), ["node/g57/geometry"]);
    return true;
  });
  const doc = await loadCanvas(id);
  assert.ok(doc.nodes.every((n, i) => n.id === "g57" ? n.position.y === -5 : n.position.y === 1000 + i));
});

test("redo 基于 undo 之后的新版本；undo 之后被他人修改则 redo 拒绝", async () => {
  const id = await createCanvas();
  const { entry } = await commit(id, await moveOf(id, A, [["x", { x: 10 }]]));
  const undo = createUndoCommand(entry, await reader(id), ids(id, A));
  const undone = await commit(id, undo.command);
  assert.equal((await position(id, "x")).x, 0);
  const redo = createRedoCommand(undone.entry, await reader(id), ids(id, A));
  assert.equal(redo.ok, true);
  const redone = await commit(id, redo.command);
  assert.equal((await position(id, "x")).x, 10);
  const undo2 = createUndoCommand(redone.entry, await reader(id), ids(id, A));
  const undone2 = await commit(id, undo2.command);
  await commit(id, await moveOf(id, B, [["x", { x: 77 }]]));
  const blocked = createRedoCommand(undone2.entry, await reader(id), ids(id, A));
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.conflicts, [{ target: "node", id: "x", field: "geometry" }]);
});

test("撤销新增节点不会删掉后来写入的生成结果", async () => {
  const id = await createCanvas([]);
  const node = { id: "fresh", canvasId: id, type: "image", schemaVersion: 1, geometry: { x: 0, y: 0, width: 280, height: 240 }, entityVersion: 0, geometryVersion: 0, documentId: null, data: { name: "新图", prompt: "", status: "running", generationId: "gen-1", assetName: null } };
  const { entry } = await commit(id, cmd(id, A, "add_nodes", { nodes: [node], documents: [] }));
  await executeCommand(cmd(id, "server", "apply_generation", { nodeId: "fresh", generationId: "gen-1", claimId: "gen-1", assets: [], patch: { status: "idle", assetName: "result.png" } }), { origin: "server" });
  const undo = createUndoCommand(entry, await reader(id), ids(id, A));
  assert.equal(undo.ok, false);
  assert.deepEqual(undo.conflicts, [{ target: "node", id: "fresh", field: "entity" }]);
  assert.equal((await loadCanvas(id)).nodes[0].data.assetName, "result.png");
});

test("撤销删除：用新 ID 重建节点、正文与连线，并返回 ID 映射；旧 ID 仍被墓碑阻断", async () => {
  const text = { id: "t1", type: "canvasText", position: { x: 0, y: 500 }, width: 360, height: 260, data: { name: "文", content: "正文内容" } };
  const id = await createCanvas([image("x"), text], [{ id: "e1", source: "t1", target: "x", type: "scissor", data: {} }]);
  const { entry } = await commit(id, cmd(id, A, "delete_nodes", { items: [{ nodeId: "t1", expectedEntityVersion: 0 }] }));
  assert.equal((await loadCanvas(id)).edges.length, 0);
  const undo = createUndoCommand(entry, await reader(id), ids(id, A));
  assert.equal(undo.ok, true);
  const newText = undo.idMap.get("t1"), newEdge = undo.idMap.get("e1");
  assert.ok(newText && newText !== "t1" && newEdge && newEdge !== "e1");
  await executeCommand(undo.command, { origin: "client" });
  const doc = await loadCanvas(id);
  const restored = doc.nodes.find(n => n.id === newText);
  assert.deepEqual([restored.data.content, restored.width, restored.position.y], ["正文内容", 360, 500]);
  assert.deepEqual(doc.edges.map(e => [e.id, e.source, e.target]), [[newEdge, newText, "x"]]);
  assert.equal(doc.nodes.some(n => n.id === "t1"), false);
});

test("撤销改名与正文；历史只保存受影响字段", async () => {
  const text = { id: "t1", type: "canvasText", position: { x: 0, y: 0 }, width: 360, height: 260, data: { name: "文", content: "原文" } };
  const id = await createCanvas([text, image("x", 600)]);
  const renamed = await commit(id, cmd(id, A, "rename_canvas", { expectedVersion: 0, name: "新名" }));
  const edited = await commit(id, cmd(id, A, "patch_nodes", { items: [{ nodeId: "t1", field: "content", expectedVersion: 0, value: "改后" }] }));
  assert.deepEqual(edited.entry.items.map(i => i.kind), ["content"]);
  assert.ok(JSON.stringify(edited.entry).length < 600, "历史条目不包含整张画布");
  await executeCommand(createUndoCommand(edited.entry, await reader(id), ids(id, A)).command, { origin: "client" });
  await executeCommand(createUndoCommand(renamed.entry, await reader(id), ids(id, A)).command, { origin: "client" });
  const doc = await loadCanvas(id);
  assert.equal(doc.name, "历史");
  assert.equal(doc.nodes[0].data.content, "原文");
});

// ---------------------------------------------------------------- 租约

const clock = () => { let now = 1_000_000; return { now: () => now, advance: (ms) => { now += ms; } }; };

test("租约：TTL 4s、续期 1s，owner+token 匹配才能续期或释放；旧 token 迟到无效，重复释放无副作用", () => {
  assert.equal(LEASE_TTL_MS, 4000);
  assert.equal(LEASE_RENEW_MS, 1000);
  const time = clock();
  const leases = createLeaseService({ now: time.now });
  const first = leases.acquire("c", "n", "geometry", A);
  assert.equal(first.ok, true);
  assert.equal(leases.acquire("c", "n", "geometry", B).ok, false);
  assert.equal(leases.acquire("c", "n", "prompt", B).ok, true, "geometry 锁不挡 prompt");
  const second = leases.acquire("c", "n", "geometry", A);
  assert.notEqual(second.token, first.token);
  assert.equal(leases.renew("c", "n", "geometry", A, first.token).ok, false, "旧 token 续期失败");
  assert.equal(leases.release("c", "n", "geometry", A, first.token), false, "旧 token 迟到释放无效");
  assert.equal(leases.holder("c", "n", "geometry").owner, A);
  assert.equal(leases.release("c", "n", "geometry", B), false, "缺 token 也不能释放他人租约");
  time.advance(3000);
  assert.equal(leases.renew("c", "n", "geometry", A, second.token).ok, true);
  time.advance(3500);
  assert.equal(leases.holder("c", "n", "geometry").owner, A, "续期后仍有效");
  assert.equal(leases.release("c", "n", "geometry", A, second.token), true);
  assert.equal(leases.release("c", "n", "geometry", A, second.token), false);
  assert.equal(leases.holder("c", "n", "geometry"), null);
  leases.acquire("c", "m", "content", A);
  time.advance(4000);
  assert.equal(leases.holder("c", "m", "content"), null, "4s 未续期即过期");
});

test("命令在事务内核验租约：他人持有 geometry 时移动 423，prompt 不受影响；过期后同一命令可提交且不占序号", async () => {
  const id = await createCanvas();
  const time = clock();
  const leases = createLeaseService({ now: time.now });
  leases.acquire(id, "x", "geometry", B);
  leases.acquire(id, "y", "content", B);
  const move = await moveOf(id, A, [["x", { x: 5 }]]);
  await assert.rejects(executeCommand(move, { origin: "client", leases }), (error) => {
    assert.equal(error.code, "lease_conflict");
    assert.equal(error.status, 423);
    assert.deepEqual(error.fields.map(f => f.path), ["node/x/geometry"]);
    return true;
  });
  const prompt = cmd(id, A, "patch_nodes", { items: [{ nodeId: "x", field: "prompt", expectedVersion: 0, value: "可以改" }] });
  prompt.actorSeq = move.actorSeq;
  await executeCommand(prompt, { origin: "client", leases });
  time.advance(LEASE_TTL_MS);
  const retry = await moveOf(id, A, [["x", { x: 5 }]]);
  retry.actorSeq = move.actorSeq + 1;
  const receipt = await executeCommand(retry, { origin: "client", leases });
  assert.deepEqual(receipt.changedNodeIds, ["x"]);
  const own = createLeaseService({ now: time.now });
  own.acquire(id, "x", "geometry", A);
  const mine = await moveOf(id, A, [["x", { x: 9 }]]);
  mine.actorSeq = retry.actorSeq + 1;
  assert.ok(await executeCommand(mine, { origin: "client", leases: own }), "自己持有的租约不阻挡自己");
  const deletion = cmd(id, A, "delete_nodes", { items: [{ nodeId: "y", expectedEntityVersion: 0 }] });
  deletion.actorSeq = mine.actorSeq + 1;
  assert.equal(leases.holder(id, "y", "content"), null, "未续期的租约已过期");
  leases.acquire(id, "y", "content", B);
  await assert.rejects(executeCommand(deletion, { origin: "client", leases }), (error) => error.code === "lease_conflict" && error.fields[0].path === "node/y/content");
});

test("旧 content/prompt 接口由同一租约服务提供：缺 token 的旧客户端不能释放他人租约", () => {
  const { claimEditLease, releaseEditLease, editLeaseActive, EDIT_LEASE_MS } = legacyLeases.module;
  assert.equal(EDIT_LEASE_MS, 4000);
  assert.equal(claimEditLease("legacy", "n", "content", "owner-1"), true);
  assert.equal(claimEditLease("legacy", "n", "content", "owner-1"), true, "同 owner 续期");
  assert.equal(claimEditLease("legacy", "n", "content", "owner-2"), false);
  releaseEditLease("legacy", "n", "content", "owner-2");
  assert.equal(editLeaseActive("legacy", "n", "content"), true);
  releaseEditLease("legacy", "n", "content", "owner-1");
  assert.equal(editLeaseActive("legacy", "n", "content"), false);
});

test("编辑租约 hook 每 1s 带 token 续期，路由支持 geometry 与 renew", async () => {
  const hook = await readFile(new URL("../components/canvas/use-edit-lease.ts", import.meta.url), "utf8");
  assert.match(hook, /LEASE_RENEW_MS|1000/);
  assert.match(hook, /token/);
  assert.match(hook, /"renew"/);
  const route = await readFile(new URL("../app/api/canvases/[id]/edit-lease/route.ts", import.meta.url), "utf8");
  assert.match(route, /"geometry"/);
  assert.match(route, /"renew"/);
  assert.match(route, /token/);
});

test("历史与租约测试已登记进 pnpm test", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:commands"], /tests\/canvas-history-leases\.test\.mjs/);
});
