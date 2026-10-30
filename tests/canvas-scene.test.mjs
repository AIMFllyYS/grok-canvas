import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");

const gestureModule = await loadTypescript("lib/canvas-runtime/gesture-store.ts");
const sceneModule = await loadTypescript("lib/canvas-runtime/scene-adapter.ts", { packages: true });
const trackerModule = await loadTypescript("lib/canvas-runtime/change-tracker.ts");
const historyModule = await loadTypescript("lib/canvas-runtime/history.ts");
after(async () => { await gestureModule.dispose(); await sceneModule.dispose(); await trackerModule.dispose(); await historyModule.dispose(); });
const { createGestureStore } = gestureModule.module;
const { createSceneProjector, projectScene, routeNodeChanges, displayGeometry, withoutCommandGeometry, keepLocalGeometry, createConfirmedGeometry, buildMoveItems, applyFlowGeometry } = sceneModule.module;
const { createChangeTracker } = trackerModule.module;
const { createUndoCommand } = historyModule.module;

const CANVAS = "c1";
const flowNode = (id, x = 0, y = 0, extra = {}) => Object.freeze({ id, type: "canvasText", position: Object.freeze({ x, y }), width: 360, height: 260, data: Object.freeze({ name: id, content: `正文 ${id}` }), ...extra });
const summary = (id, x = 0, y = 0, version = 0, size = { width: 360, height: 260 }) => ({ id, canvasId: CANVAS, type: "canvasText", schemaVersion: 1, geometry: { x, y, ...size }, entityVersion: version, geometryVersion: version, documentId: `d-${id}`, data: { name: id } });
const snapshotOf = (nodes, revision = 1) => ({ canvasId: CANVAS, revision, name: "画布", nameVersion: 0, storageEpoch: "json-v1", eventSeq: revision, nodes, documents: nodes.map(n => ({ id: n.documentId, nodeId: n.id, content: "", version: 0 })), edges: [], actors: {}, fieldVersions: {} });
const lookupFrom = (nodes) => { const map = new Map(nodes.map(n => [n.id, n])); return id => map.has(id) ? displayGeometry(map.get(id)) : undefined; };
const dragFrame = (ids, dx) => ids.map((id) => ({ type: "position", id, position: { x: dx, y: dx / 2 }, dragging: true }));

// ---------------------------------------------------------------- gesture-store

test("gesture-store：只处理参与节点；移回起点不产生结果；drop/cancel 清锁", () => {
  const gesture = createGestureStore();
  let notified = 0;
  const unsubscribe = gesture.subscribe(() => notified++);
  gesture.begin("drag", [{ id: "a", geometry: { x: 0, y: 0, width: 10, height: 10 } }]);
  assert.equal(gesture.update([{ id: "a", x: 5, y: 5 }, { id: "stranger", x: 9, y: 9 }]), true);
  assert.equal(gesture.get("stranger"), undefined, "非参与节点不进入覆盖层");
  assert.deepEqual(gesture.get("a"), { x: 5, y: 5, width: 10, height: 10 });
  assert.equal(gesture.update([{ id: "a", x: 5, y: 5 }]), false, "坐标未变不通知");
  gesture.update([{ id: "a", x: 0, y: 0 }]);
  assert.equal(gesture.end(), null, "移回原点：无命令无历史");
  assert.equal(gesture.active(), false);
  gesture.begin("drag", [{ id: "a", geometry: { x: 0, y: 0, width: 10, height: 10 } }, { id: "b", geometry: { x: 1, y: 1, width: 10, height: 10 } }]);
  gesture.update([{ id: "a", x: 3, y: 3 }, { id: "b", x: 4, y: 4 }]);
  gesture.drop("b");
  assert.equal(gesture.has("b"), false, "删除节点清手势锁");
  assert.deepEqual(gesture.end(), { kind: "drag", items: [{ id: "a", from: { x: 0, y: 0, width: 10, height: 10 }, to: { x: 3, y: 3, width: 10, height: 10 } }] });
  gesture.begin("resize", [{ id: "r", geometry: { x: 0, y: 0, width: 200, height: 120 } }]);
  gesture.update([{ id: "r", width: 400, height: 300 }]);
  assert.deepEqual(gesture.cancel(), [{ id: "r", from: { x: 0, y: 0, width: 200, height: 120 }, to: { x: 0, y: 0, width: 200, height: 120 } }]);
  assert.equal(gesture.active(), false);
  const before = notified;
  unsubscribe();
  gesture.begin("drag", [{ id: "a", geometry: { x: 0, y: 0, width: 10, height: 10 } }]);
  gesture.update([{ id: "a", x: 1, y: 1 }]);
  assert.equal(notified, before, "取消订阅后不再通知");
});

// ---------------------------------------------------------------- 120 帧拖动

test("120 帧拖动 n1：正式文档不变、无素材扫描与保存、无关节点与正文引用不变，结束只产生 1 个移动", () => {
  const formal = Object.freeze(Array.from({ length: 2000 }, (_, i) => flowNode(`n${i}`, i * 10, 0)));
  const gesture = createGestureStore();
  const tracker = createChangeTracker();
  const projector = createSceneProjector();
  const lookup = lookupFrom(formal);
  const idle = projector.project(formal, gesture);
  assert.equal(projector.project(formal, gesture), idle, "无变化返回同一数组");
  for (let frame = 1; frame <= 120; frame++) {
    const routed = routeNodeChanges(dragFrame(["n1"], 10 + frame), gesture, lookup);
    assert.deepEqual(routed.formal, [], "拖动帧不写正式文档");
    tracker.nodes(routed.tracker);
    assert.equal(routed.finished, false);
    const scene = projector.project(formal, gesture);
    assert.equal(scene[0], formal[0], "无关节点保留同一对象");
    assert.equal(scene[1999], formal[1999]);
    assert.notEqual(scene[1], formal[1]);
    assert.equal(scene[1].data, formal[1].data, "参与节点正文 data 引用不变，节点内容不重解析");
    assert.deepEqual(scene[1].position, { x: 10 + frame, y: (10 + frame) / 2 });
    assert.equal(tracker.take(), null, "途中不触发保存/素材收集");
  }
  assert.equal(Object.isFrozen(formal) && formal[1].position.x, 10, "正式文档 120 帧后未改");
  const stats = projector.stats();
  assert.ok(stats.created <= 121 + 1, `每帧只为参与节点新建对象（实际 ${stats.created}）`);
  const end = routeNodeChanges([{ type: "position", id: "n1", position: { x: 130, y: 65 }, dragging: false }], gesture, lookup);
  tracker.nodes(end.tracker);
  assert.equal(end.finished, true);
  const result = gesture.end();
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].to, { x: 130, y: 65, width: 360, height: 260 });
  assert.equal(tracker.take(), null, "移动走命令，旧保存路径不因这次手势被标脏");
  assert.equal(tracker.active(), false);
});

test("onNodesChange 分流：选择与自然测量进正式文档；resize 走手势；键盘移动为离散移动；删除清锁", () => {
  const formal = [flowNode("a"), flowNode("b", 500)];
  const gesture = createGestureStore();
  const tracker = createChangeTracker();
  const lookup = lookupFrom(formal);
  const natural = routeNodeChanges([{ type: "select", id: "a", selected: true }, { type: "dimensions", id: "b", dimensions: { width: 280, height: 240 } }], gesture, lookup);
  assert.equal(natural.formal.length, 2);
  tracker.nodes(natural.tracker);
  assert.equal(tracker.take(), null, "自然尺寸不提交");
  const resize = routeNodeChanges([{ type: "dimensions", id: "a", dimensions: { width: 500, height: 300 }, resizing: true, setAttributes: true }, { type: "position", id: "a", position: { x: -40, y: -20 } }], gesture, lookup);
  assert.deepEqual(resize.formal, []);
  assert.equal(gesture.kind(), "resize");
  assert.deepEqual(gesture.get("a"), { x: -40, y: -20, width: 500, height: 300 }, "左上角 resize 的位置也进覆盖层");
  tracker.nodes(resize.tracker);
  assert.equal(tracker.active(), true);
  const done = routeNodeChanges([{ type: "dimensions", id: "a", resizing: false, setAttributes: true }], gesture, lookup);
  assert.equal(done.finished, true);
  tracker.nodes(done.tracker);
  assert.equal(tracker.take(), null, "resize 结束不走旧保存");
  assert.deepEqual(gesture.end().items[0].to, { x: -40, y: -20, width: 500, height: 300 });
  const key = routeNodeChanges([{ type: "position", id: "b", position: { x: 510, y: 0 } }], gesture, lookup);
  assert.deepEqual(key.discrete, [{ id: "b", from: displayGeometry(formal[1]), to: { ...displayGeometry(formal[1]), x: 510 } }], "键盘移动立即作为一次移动");
  routeNodeChanges(dragFrame(["a", "b"], 50), gesture, lookup);
  const removed = routeNodeChanges([{ type: "remove", id: "b" }], gesture, lookup);
  assert.equal(gesture.has("b"), false);
  assert.equal(removed.formal.length, 1);
});

test("失焦收尾后迟到的 dragging=true 重新接管手势并继续挡住保存", () => {
  const formal = [flowNode("n")];
  const gesture = createGestureStore();
  const tracker = createChangeTracker();
  const lookup = lookupFrom(formal);
  tracker.nodes(routeNodeChanges(dragFrame(["n"], 5), gesture, lookup).tracker);
  // 失焦：FlowCanvas 的 closeDragGesture 结束手势并复位保存闸门。
  gesture.end();
  tracker.reset();
  const late = routeNodeChanges(dragFrame(["n"], 9), gesture, lookup);
  tracker.nodes(late.tracker);
  assert.equal(gesture.active(), true, "迟到事件重建锚点");
  assert.equal(tracker.active(), true, "保存闸门重新关闭");
  assert.equal(tracker.take(), null);
});

// ---------------------------------------------------------------- 几何换算与旧保存

test("旧保存不再发送受命令管理节点的几何；新增、未登记节点与正文变化照常发送", () => {
  const op = (entityId, pathKeys, after = 1) => ({ id: `${entityId}-${pathKeys.join(".")}`, target: "node", entityId, path: pathKeys, before: { exists: true, value: 0 }, after: { exists: true, value: after } });
  const ops = [op("m", ["position", "x"]), op("m", ["position"]), op("m", ["width"]), op("m", ["height"]), op("m", ["data", "content"]), op("u", ["position", "x"]), { id: "add", target: "node", entityId: "m", path: [], before: { exists: false }, after: { exists: true, value: {} } }, { id: "v", target: "canvas", path: ["viewport", "x"], before: { exists: true, value: 0 }, after: { exists: true, value: 1 } }];
  const kept = withoutCommandGeometry(ops, id => id === "m").map(o => o.id);
  assert.deepEqual(kept, ["m-data.content", "u-position.x", "add", "v"]);
});

test("远端合并保留未确认的本地几何，正文等字段取远端；拖动中的正文修改两者都保留", () => {
  const local = [flowNode("a", 100, 100), flowNode("b", 0, 0)];
  const remote = [{ ...flowNode("a", 0, 0), data: { name: "a", content: "Agent 改的正文" } }, { ...flowNode("b", 7, 7) }];
  const merged = keepLocalGeometry(remote, local, id => id === "a");
  assert.deepEqual(merged[0].position, { x: 100, y: 100 }, "未确认的本地移动不回弹");
  assert.equal(merged[0].data.content, "Agent 改的正文", "远端正文保留");
  assert.equal(merged[1], remote[1], "无本地待确认的节点直接用远端对象");
  const resized = applyFlowGeometry(flowNode("t"), { x: 1, y: 2, width: 640, height: 480 }, { size: true });
  assert.deepEqual([resized.position, resized.width, resized.height], [{ x: 1, y: 2 }, 640, 480]);
  const moved = applyFlowGeometry({ id: "img", type: "image", position: { x: 0, y: 0 }, data: {} }, { x: 5, y: 6, width: 280, height: 240 }, { size: false });
  assert.equal("width" in moved, false, "拖动不给媒体节点写显式尺寸");
});

test("移动命令以服务端确认几何为起点：媒体节点尺寸用服务端值；待确认的上一次移动作为下一次的前置版本", () => {
  const confirmed = createConfirmedGeometry(snapshotOf([summary("img", 0, 0, 3, { width: 280, height: 240 }), summary("t", 10, 10, 1)]));
  const drag = { kind: "drag", items: [{ id: "img", from: { x: 0, y: 0, width: 512, height: 380 }, to: { x: 50, y: 60, width: 512, height: 380 } }, { id: "fresh", from: { x: 0, y: 0, width: 1, height: 1 }, to: { x: 9, y: 9, width: 1, height: 1 } }] };
  const first = buildMoveItems(drag, confirmed);
  assert.deepEqual(first.unmanaged, ["fresh"], "服务端尚未知道的节点留给旧路径");
  assert.deepEqual(first.items, [{ nodeId: "img", expectedVersion: 3, from: { x: 0, y: 0, width: 280, height: 240 }, to: { x: 50, y: 60, width: 280, height: 240 } }]);
  confirmed.predict(first.items);
  assert.equal(confirmed.pending("img"), true);
  const second = buildMoveItems({ kind: "drag", items: [{ id: "img", from: { x: 50, y: 60, width: 512, height: 380 }, to: { x: 70, y: 80, width: 512, height: 380 } }] }, confirmed);
  assert.deepEqual(second.items[0], { nodeId: "img", expectedVersion: 4, from: { x: 50, y: 60, width: 280, height: 240 }, to: { x: 70, y: 80, width: 280, height: 240 } });
  const resize = buildMoveItems({ kind: "resize", items: [{ id: "t", from: { x: 10, y: 10, width: 360, height: 260 }, to: { x: 10, y: 10, width: 700, height: 500 } }] }, confirmed);
  assert.deepEqual(resize.items[0].to, { x: 10, y: 10, width: 700, height: 500 });
  const noop = buildMoveItems({ kind: "drag", items: [{ id: "t", from: { x: 0, y: 0, width: 360, height: 260 }, to: { x: 10, y: 10, width: 360, height: 260 } }] }, confirmed);
  assert.deepEqual(noop.items, [], "落点等于确认几何不发命令");
});

test("确认版本缓存：回执更新几何与版本并清除对应预测；读取器可直接用于 P2-04 撤销", () => {
  const confirmed = createConfirmedGeometry(snapshotOf([summary("a", 0, 0, 0)]));
  const items = [{ nodeId: "a", expectedVersion: 0, from: { x: 0, y: 0, width: 360, height: 260 }, to: { x: 5, y: 5, width: 360, height: 260 } }];
  confirmed.predict(items);
  confirmed.applyReceipt({ commandId: "x", revision: 2, eventSeq: 2, storageEpoch: "json-v1", changedNodeIds: ["a"], changedEdgeIds: [], fieldVersions: [{ target: "node", id: "a", field: "geometry", version: 1 }], delta: { canvasId: CANVAS, fromRevision: 1, revision: 2, nodes: [summary("a", 5, 5, 1)], documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [] }, replayed: false });
  assert.equal(confirmed.pending("a"), false);
  assert.deepEqual(confirmed.get("a").geometry, { x: 5, y: 5, width: 360, height: 260 });
  const entry = { canvasId: CANVAS, commandId: "x", items: [{ kind: "geometry", nodeId: "a", before: { x: 0, y: 0, width: 360, height: 260 }, after: { x: 5, y: 5, width: 360, height: 260 }, version: 1 }] };
  const ids = { commandId: "u", actorId: "act", actorSeq: 1, storageEpoch: "json-v1", baseRevision: 2, createId: () => "n" };
  const undo = createUndoCommand(entry, confirmed.reader(), ids);
  assert.equal(undo.ok, true);
  assert.deepEqual(undo.command.payload.items[0], { nodeId: "a", expectedVersion: 1, from: { x: 5, y: 5, width: 360, height: 260 }, to: { x: 0, y: 0, width: 360, height: 260 } });
});

// ---------------------------------------------------------------- 几何命令通道（真实 outbox + fake-indexeddb）

async function withChannel(fn) {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
  const outboxModule = await loadTypescript("lib/canvas-runtime/outbox.ts", { packages: true });
  const channelModule = await loadTypescript("lib/canvas-runtime/geometry-channel.ts", { packages: true });
  const map = new Map();
  const session = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
  try {
    const outbox = await outboxModule.module.openOutbox({ session });
    return await fn({ outbox, createGeometryChannel: channelModule.module.createGeometryChannel });
  } finally {
    await outboxModule.dispose(); await channelModule.dispose();
    Object.assign(globalThis, previous);
  }
}

/** 最小服务端：按 expectedVersion/from 校验 move_nodes，与 command-reducer 规则一致。 */
function fakeServer(nodes) {
  const state = new Map(nodes.map(n => [n.id, structuredClone(n)]));
  let revision = 1;
  const posted = [];
  const sameG = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  return {
    posted, state,
    snapshot: async () => snapshotOf([...state.values()].map(n => structuredClone(n)), revision),
    move(id, geometry) { const n = state.get(id); n.geometry = { ...geometry }; n.geometryVersion++; n.entityVersion++; revision++; },
    bump(id) { const n = state.get(id); n.geometryVersion++; n.entityVersion++; revision++; },
    async post(command) {
      posted.push(structuredClone(command));
      assert.equal(command.kind, "move_nodes");
      for (const item of command.payload.items) {
        const node = state.get(item.nodeId);
        if (!node || node.geometryVersion !== item.expectedVersion || !sameG(node.geometry, item.from)) return { ok: false, status: 409, error: { code: "field_conflict", message: `节点 ${item.nodeId} 冲突` } };
      }
      const fromRevision = revision;
      const changed = [];
      for (const item of command.payload.items) {
        const node = state.get(item.nodeId);
        if (sameG(node.geometry, item.to)) continue;
        node.geometry = { ...item.to }; node.geometryVersion++; node.entityVersion++;
        changed.push(structuredClone(node));
      }
      if (changed.length) revision++;
      return { ok: true, receipt: { commandId: command.commandId, revision, eventSeq: revision, storageEpoch: "json-v1", changedNodeIds: changed.map(n => n.id), changedEdgeIds: [], fieldVersions: changed.map(n => ({ target: "node", id: n.id, field: "geometry", version: n.geometryVersion })), delta: { canvasId: CANVAS, fromRevision, revision, nodes: changed, documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [] }, replayed: false } };
    },
  };
}

function setup({ outbox, createGeometryChannel }, nodes, hooks = {}) {
  const server = fakeServer(nodes);
  const confirmed = createConfirmedGeometry(snapshotOf(nodes));
  const history = new Map();
  const conflicts = [];
  const remote = [];
  const channel = createGeometryChannel({
    canvasId: CANVAS, outbox, confirmed, post: c => server.post(c), fetchSnapshot: () => server.snapshot(),
    onHistory: (commandId, entry) => history.set(commandId, entry),
    onConflict: conflict => { conflicts.push(conflict); hooks.onConflict?.(conflict); },
    onRemote: geometries => remote.push(geometries),
    schedule: () => () => {},
  });
  return { server, confirmed, channel, history, conflicts, remote };
}

test("通道：一次 120 帧拖动结束只入队 1 条命令；回执更新确认版本并记录 1 条历史；撤销是条件命令", async () => {
  await withChannel(async (ctx) => {
    const { server, confirmed, channel, history } = setup(ctx, [summary("n1", 10, 0, 0), summary("n2", 20, 0, 0)]);
    const gesture = createGestureStore();
    const lookup = lookupFrom([flowNode("n1", 10, 0)]);
    for (let f = 1; f <= 120; f++) routeNodeChanges(dragFrame(["n1"], 10 + f), gesture, lookup);
    assert.equal((await ctx.outbox.loadPending(CANVAS)).length, 0, "拖动途中不写 outbox");
    routeNodeChanges([{ type: "position", id: "n1", dragging: false }], gesture, lookup);
    const { items } = buildMoveItems(gesture.end(), confirmed);
    const submitted = await channel.submit(items);
    assert.equal((await ctx.outbox.loadPending(CANVAS)).length, 1, "结束只新增 1 条命令");
    const sent = await channel.flush();
    assert.equal(sent.status, "idle");
    assert.equal(server.posted.length, 1);
    assert.equal(confirmed.get("n1").geometryVersion, 1);
    assert.equal(history.get(submitted.commandId).items.length, 1);
    const undo = await channel.undo(history.get(submitted.commandId));
    assert.equal(undo.ok, true);
    assert.deepEqual(undo.geometries.get("n1"), { x: 10, y: 0, width: 360, height: 260 });
    await channel.flush();
    assert.deepEqual(server.state.get("n1").geometry, { x: 10, y: 0, width: 360, height: 260 }, "撤销回到起点");
    assert.equal(server.state.get("n2").geometryVersion, 0, "无关节点不受影响");
  });
});

test("通道：群组 100 节点一次移动、一次撤销；撤销前有人改了其中一个则整条拒绝", async () => {
  await withChannel(async (ctx) => {
    const nodes = Array.from({ length: 100 }, (_, i) => summary(`g${i}`, i * 400, 0, 0));
    const { server, confirmed, channel, history } = setup(ctx, nodes);
    const result = { kind: "drag", items: nodes.map(n => ({ id: n.id, from: { ...n.geometry }, to: { ...n.geometry, y: 900 } })) };
    const { items } = buildMoveItems(result, confirmed);
    const first = await channel.submit(items);
    await channel.flush();
    assert.equal(server.posted.length, 1, "群组只发 1 条命令");
    assert.equal(server.posted[0].payload.items.length, 100);
    const undo = await channel.undo(history.get(first.commandId));
    assert.equal(undo.ok, true);
    await channel.flush();
    assert.ok([...server.state.values()].every(n => n.geometry.y === 0), "一次撤销恢复整组");
    const second = await channel.submit(buildMoveItems(result, confirmed).items);
    await channel.flush();
    server.move("g42", { x: 1, y: 1, width: 360, height: 260 });
    confirmed.load(await server.snapshot());
    const rejected = await channel.undo(history.get(second.commandId));
    assert.equal(rejected.ok, false, "所有权变化整条拒绝，不半撤销");
    assert.deepEqual(rejected.conflicts.map(c => c.id), ["g42"]);
  });
});

test("通道：只有版本号变化（几何未动）时静默改基重发；真实同几何冲突交给用户选择，不回弹、不静默选边", async () => {
  await withChannel(async (ctx) => {
    let resolve;
    const decided = new Promise(r => { resolve = r; });
    const { server, confirmed, channel, conflicts, remote } = setup(ctx, [summary("a", 0, 0, 0), summary("b", 500, 0, 0)], { onConflict: () => resolve() });
    server.bump("a");
    await channel.submit(buildMoveItems({ kind: "drag", items: [{ id: "a", from: { x: 0, y: 0, width: 360, height: 260 }, to: { x: 10, y: 10, width: 360, height: 260 } }] }, confirmed).items);
    const first = await channel.flush();
    assert.equal(first.status, "idle", "版本改基后成功");
    assert.deepEqual(server.state.get("a").geometry, { x: 10, y: 10, width: 360, height: 260 });
    assert.equal(conflicts.length, 0);
    assert.equal((await ctx.outbox.loadPending(CANVAS)).length, 0, "冲突记录已清理");

    server.move("b", { x: 777, y: 0, width: 360, height: 260 });
    await channel.submit(buildMoveItems({ kind: "drag", items: [{ id: "b", from: { x: 500, y: 0, width: 360, height: 260 }, to: { x: 520, y: 40, width: 360, height: 260 } }] }, confirmed).items);
    void channel.flush();
    await decided;
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].nodeIds, ["b"]);
    assert.deepEqual(conflicts[0].local.get("b"), { x: 520, y: 40, width: 360, height: 260 });
    assert.deepEqual(conflicts[0].remote.get("b"), { x: 777, y: 0, width: 360, height: 260 });
    assert.equal(remote.length, 0, "用户决定前不回弹");
    assert.equal(server.posted.at(-1).payload.items[0].nodeId, "b");
    await conflicts[0].keepMine();
    await channel.flush();
    assert.deepEqual(server.state.get("b").geometry, { x: 520, y: 40, width: 360, height: 260 }, "保留我的位置：以远端版本为前置重新提交");

    server.move("b", { x: 1, y: 1, width: 360, height: 260 });
    await channel.submit(buildMoveItems({ kind: "drag", items: [{ id: "b", from: { x: 520, y: 40, width: 360, height: 260 }, to: { x: 600, y: 40, width: 360, height: 260 } }] }, confirmed).items);
    await channel.flush();
    await conflicts[1].takeTheirs();
    assert.deepEqual(remote.at(-1).get("b"), { x: 1, y: 1, width: 360, height: 260 }, "采用对方位置时才应用远端几何");
    assert.equal(confirmed.pending("b"), false);
    assert.equal((await ctx.outbox.loadPending(CANVAS)).length, 0);
  });
});

test("通道恢复屏障：重开后先读出未确认移动作为预测，再发送；outbox.discard 只删除冲突记录", async () => {
  await withChannel(async (ctx) => {
    const draft = { kind: "move_nodes", payload: { items: [{ nodeId: "a", expectedVersion: 0, from: { x: 0, y: 0, width: 360, height: 260 }, to: { x: 3, y: 3, width: 360, height: 260 } }] }, storageEpoch: "json-v1", baseRevision: 1 };
    const record = await ctx.outbox.enqueue(CANVAS, draft);
    await assert.rejects(ctx.outbox.discard(CANVAS, record.actorSeq), /conflict/, "queued/sent 记录不能丢弃");
    const { server, confirmed, channel } = setup(ctx, [summary("a", 0, 0, 0)]);
    await channel.start();
    assert.equal(confirmed.pending("a"), true, "恢复后先登记未确认几何");
    assert.deepEqual(channel.pendingGeometry().get("a"), { x: 3, y: 3, width: 360, height: 260 });
    await channel.flush();
    assert.equal(server.posted.length, 1);
    assert.equal(channel.pendingGeometry().size, 0);
    const conflicted = await ctx.outbox.enqueue(CANVAS, draft);
    await ctx.outbox.markConflict(CANVAS, conflicted.actorSeq, { code: "field_conflict" });
    await ctx.outbox.discard(CANVAS, conflicted.actorSeq);
    assert.deepEqual(await ctx.outbox.loadPending(CANVAS), []);
  });
});

test("恢复时把本地检查点/草稿里的坐标转成移动命令；起点与远端不符的进入冲突仲裁", async () => {
  await withChannel(async (ctx) => {
    const { server, channel, conflicts } = setup(ctx, [summary("a", 0, 0, 0), summary("b", 100, 0, 0)]);
    server.move("b", { x: 999, y: 0, width: 360, height: 260 });
    await channel.start();
    const report = await channel.reconcile([
      { id: "a", from: { x: 0, y: 0 }, to: { x: 40, y: 40 } },
      { id: "b", from: { x: 100, y: 0 }, to: { x: 140, y: 0 } },
      { id: "gone", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    ], await server.snapshot());
    assert.deepEqual(report, { submitted: ["a"], conflicts: ["b"], skipped: ["gone"] });
    await channel.flush();
    assert.deepEqual(server.state.get("a").geometry, { x: 40, y: 40, width: 360, height: 260 });
    assert.equal(server.state.get("b").geometry.x, 999, "不静默覆盖远端移动");
    assert.equal(conflicts.at(-1).nodeIds[0], "b");
  });
});

// ---------------------------------------------------------------- 路由（vm 加载，依赖注入）

const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-scene-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const storeLib = await loadTypescript("lib/canvas-store.ts");
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
const leaseLib = await loadTypescript("lib/canvas-runtime/lease-service.ts");
after(async () => { await storeLib.dispose(); await repository.dispose(); await leaseLib.dispose(); await rm(dataDir, { recursive: true, force: true }); });
const zod = await import("zod");
async function loadRoute(relative, deps) {
  const source = await readFile(new URL(`../${relative}`, import.meta.url), "utf8").catch(() => "");
  const module = {};
  if (source) vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: module, Response, JSON, Promise, Array, Number, Object, String, Error, Map, Set, URL,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
      if (name === "zod") return zod;
      if (Object.hasOwn(deps, name)) return deps[name];
      throw new Error(`未模拟依赖：${name}`);
    },
  });
  return module;
}

test("entities 路由返回带版本的实体快照；不存在的画布 404；非法 ID 400", async () => {
  const leases = leaseLib.module.createLeaseService();
  const route = await loadRoute("app/api/canvases/[id]/entities/route.ts", {
    "@/lib/canvas-store": storeLib.module,
    "@/lib/canvas-runtime/json-repository": repository.module,
  });
  assert.ok(route.GET, "entities 路由存在");
  const doc = await storeLib.module.createCanvas();
  await storeLib.module.transformCanvas(doc.id, d => ({ ...d, nodes: [{ id: "n1", type: "canvasText", position: { x: 1, y: 2 }, width: 360, height: 260, data: { name: "文本", content: "x" } }] }));
  const ok = await route.GET(new Request("http://127.0.0.1:3210/x"), { params: Promise.resolve({ id: doc.id }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.equal(body.nodes[0].geometryVersion, 0);
  assert.deepEqual(body.nodes[0].geometry, { x: 1, y: 2, width: 360, height: 260 });
  assert.equal(body.storageEpoch, "json-v1");
  const missing = await route.GET(new Request("http://127.0.0.1:3210/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000999" }) });
  assert.equal(missing.status, 404);
  const bad = await route.GET(new Request("http://127.0.0.1:3210/x"), { params: Promise.resolve({ id: "../etc" }) });
  assert.equal(bad.status, 400);
  void leases;
});

test("edit-lease 路由：geometry 可一次锁多节点，任一失败整批回滚；续期/释放需逐节点 token", async () => {
  const leases = leaseLib.module.createLeaseService();
  const route = await loadRoute("app/api/canvases/[id]/edit-lease/route.ts", {
    "@/lib/canvas-store": storeLib.module,
    "@/lib/canvas-runtime/lease-service": { ...leaseLib.module, getLeaseService: () => leases },
  });
  const doc = await storeLib.module.createCanvas();
  await storeLib.module.transformCanvas(doc.id, d => ({ ...d, nodes: ["a", "b", "c"].map((id, i) => ({ id, type: "canvasText", position: { x: i * 400, y: 0 }, width: 360, height: 260, data: { name: id, content: "" } })) }));
  const call = body => route.POST(new Request("http://127.0.0.1:3210/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: doc.id }) });
  const claimed = await call({ nodeIds: ["a", "b"], field: "geometry", owner: "actor-1", action: "claim" });
  assert.equal(claimed.status, 200);
  const { tokens } = await claimed.json();
  assert.deepEqual(Object.keys(tokens).sort(), ["a", "b"]);
  const other = await call({ nodeIds: ["c", "b"], field: "geometry", owner: "actor-2", action: "claim" });
  assert.equal(other.status, 409);
  assert.equal(leases.conflicts(doc.id, [{ nodeId: "c", field: "geometry" }], "actor-1").length, 0, "失败的批次不遗留 c 的锁");
  assert.equal((await call({ nodeIds: ["a", "b"], field: "geometry", owner: "actor-1", action: "renew", tokens })).status, 200);
  assert.equal((await call({ nodeIds: ["a", "b"], field: "geometry", owner: "actor-1", action: "release", tokens })).status, 200);
  assert.equal(leases.conflicts(doc.id, [{ nodeId: "a", field: "geometry" }, { nodeId: "b", field: "geometry" }], "actor-2").length, 0, "释放后不遗留锁");
  assert.equal((await call({ nodeIds: ["a"], field: "content", owner: "actor-1", action: "claim" })).status, 400, "批量只用于 geometry");
  assert.equal((await call({ nodeId: "a", field: "content", owner: "actor-1", action: "claim" })).status, 200, "单节点旧格式不变");
});

// ---------------------------------------------------------------- FlowCanvas / CanvasScene 接线

test("FlowCanvas 接线：ReactFlow 只在 CanvasScene 中渲染并订阅手势；旧保存剥离命令几何；旧 move 撤销分支已删除", async () => {
  const flow = await readFile(new URL("../components/canvas/flow-canvas.tsx", import.meta.url), "utf8");
  const scene = await readFile(new URL("../components/canvas/canvas-scene.tsx", import.meta.url), "utf8").catch(() => "");
  assert.match(scene, /useSyncExternalStore\(/, "CanvasScene 订阅手势覆盖层");
  assert.match(scene, /projectScene\(/);
  assert.match(scene, /<ReactFlow\b/);
  assert.match(scene, /<CanvasZoomStyle \/>/, "CanvasZoomStyle 保持在 ReactFlow 内");
  assert.doesNotMatch(flow, /<ReactFlow\b/, "FlowCanvas 不再直接渲染 ReactFlow");
  assert.match(flow, /<CanvasScene\b/);
  assert.doesNotMatch(flow, /useSyncExternalStore\(gesture/, "FlowCanvas 本身不随手势重渲染");
  // P2-07 起：临时 legacyAdapter 删除，普通保存不再做整图差异；只剩显式命名的 service 字段兼容写入。
  assert.doesNotMatch(flow, /legacyAdapter/, "P2-06 临时 legacy adapter 已删除");
  assert.doesNotMatch(flow, /diffCanvasOperations\(/, "普通保存不再整图 diff");
  assert.match(flow, /translateUserWrites\(/, "用户写入翻译成命令");
  assert.equal((flow.match(/const legacyServiceWrites = /g) ?? []).length, 1, "兼容写入只有一个命名入口");
  assert.match(flow, /keepLocalGeometry\(/, "远端合并保留未确认几何");
  assert.match(flow, /routeNodeChanges\(/);
  assert.doesNotMatch(flow, /position: item\.from/, "旧的 setNodes 坐标撤销已删除");
  assert.doesNotMatch(flow, /position: item\.to/);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:workspace"] + pkg.scripts["test:commands"], /tests\/canvas-scene\.test\.mjs/);
});
