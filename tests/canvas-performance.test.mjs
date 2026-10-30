import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";
import { canvasFixture } from "./helpers/canvas-fixture.mjs";

const changes = await loadTypescript("lib/canvas-runtime/change-tracker.ts");
const queueModule = await loadTypescript("lib/canvas-runtime/latest-queue.ts");
after(async () => { await changes.dispose(); await queueModule.dispose(); });
const { createChangeTracker } = changes.module;
const { createLatestQueue } = queueModule.module;

for (const size of [100, 1000, 5000, 10000]) {
  test(`${size} 节点拖动 120 帧只在结束后产生保存意图，不扫描正文`, () => {
    const tracker = createChangeTracker();
    const fixture = canvasFixture(size);
    assert.equal(fixture.nodes.length, size);
    assert.equal(fixture.edges.length, size * 2);
    for (const item of fixture.nodes) Object.defineProperty(item, "data", { get() { throw new Error("热路径不能读取正文"); } });
    const node = fixture.nodes.at(-1);
    tracker.begin("node");
    for (let frame = 0; frame < 120; frame++) {
      tracker.nodes([{ id: node.id, type: "position", position: { x: frame, y: 0 }, dragging: true }]);
      assert.equal(tracker.take(), null);
    }
    tracker.nodes([{ id: node.id, type: "position", dragging: false }]);
    tracker.end("node");
    assert.deepEqual(tracker.take(), { persist: true, assets: false });
    assert.equal(tracker.take(), null);
  });
}

test("万级混合 fixture 包含长文本、图片和视频元数据以及局部密集关系", () => {
  const fixture = canvasFixture(10000, { dense: true, longText: true });
  const counts = {};
  for (const node of fixture.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  assert.equal(counts.canvasText, 5000);
  assert.equal(counts.image + counts.asset, 4500);
  assert.equal(counts.video, 500);
  assert.ok(Buffer.byteLength(fixture.nodes[1].data.content) >= 1500);
  assert.ok(Buffer.byteLength(fixture.nodes[0].data.content) >= 90000);
  assert.equal(new Set(fixture.edges.map(edge => `${edge.source}:${edge.target}`)).size, 20000);
});

test("引用校验复用索引，万级图只遍历一次节点和边", async () => {
  const loaded = await loadTypescript("lib/canvas-references.ts");
  try {
    const { createReferenceIndex, resolveCanvasReferences } = loaded.module;
    assert.equal(typeof createReferenceIndex, "function", "需要共享引用索引");
    const fixture = canvasFixture(10000);
    const index = createReferenceIndex(fixture.nodes, fixture.edges);
    const forbidden = new Proxy([], { get() { throw new Error("不能重新遍历全图"); } });
    let visited = 0;
    const incoming = { get(id) { const edges = index.incomingByNode.get(id); visited += edges?.length ?? 0; return edges; } };
    for (const node of fixture.nodes) {
      const result = resolveCanvasReferences(node, forbidden, forbidden, { ...index, incomingByNode: incoming });
      assert.equal(result.occupied, 0, "文本关系不占媒体名额");
    }
    assert.equal(visited, fixture.edges.length);
  } finally { await loaded.dispose(); }
});

test("索引引用解析保留首尾帧冲突、未就绪槽位和来源更新语义", async () => {
  const loaded = await loadTypescript("lib/canvas-references.ts");
  try {
    const { createReferenceIndex, resolveCanvasReferences } = loaded.module;
    assert.equal(typeof createReferenceIndex, "function");
    const source = { id: "s", type: "image", data: { assetName: "a.png", name: "来源" } };
    const target = { id: "v", type: "video", data: { uploadInputs: [{ assetName: "a.png", role: "last" }] } };
    const edge = { id: "e", source: "s", target: "v", data: { role: "first" } };
    const nodes = [source, target], edges = [edge];
    const index = createReferenceIndex(nodes, edges);
    assert.throws(() => resolveCanvasReferences(target, nodes, edges, index), /不能兼任/);
    target.data.uploadInputs = [];
    assert.deepEqual(resolveCanvasReferences(target, nodes, edges, index).inputs, [{ assetName: "a.png", role: "first" }]);
    source.data.assetName = null;
    assert.equal(resolveCanvasReferences(target, nodes, edges, index).pending, 1);
  } finally { await loaded.dispose(); }
});

test("选中与自然测量不保存，手动 resize 保存但不收集素材", () => {
  const tracker = createChangeTracker();
  tracker.nodes([{ type: "select" }, { type: "dimensions", dimensions: { width: 300, height: 200 } }]);
  tracker.edges([{ type: "select" }]);
  assert.equal(tracker.take(), null);
  tracker.nodes([{ type: "dimensions", resizing: true, setAttributes: true }]);
  assert.equal(tracker.active(), true);
  assert.equal(tracker.take(), null);
  tracker.nodes([{ type: "dimensions", resizing: false, setAttributes: true }]);
  assert.deepEqual(tracker.take(), { persist: true, assets: false });
});

test("失焦后仍到达的拖动增量继续保护保存，终止标记清除逐节点手势", () => {
  const tracker = createChangeTracker();
  tracker.nodes([{ type: "position", id: "n", position: { x: 1, y: 2 }, dragging: true }]);
  assert.equal(tracker.take(), null);
  tracker.reset();
  tracker.nodes([{ type: "position", id: "n", position: { x: 2, y: 3 }, dragging: true }]);
  assert.equal(tracker.take(), null);
  tracker.nodes([{ type: "position", id: "n", dragging: false }]);
  assert.deepEqual(tracker.take(), { persist: true, assets: false });
  tracker.nodes([{ type: "dimensions", id: "removed", resizing: true }, { type: "remove", id: "removed" }]);
  assert.equal(tracker.active(), false, "移除节点不能遗留手势锁");
});

test("拖动期间的生成结果不会丢失，结束后补收素材", () => {
  const tracker = createChangeTracker();
  tracker.begin("node");
  tracker.nodes([{ type: "replace", id: "result" }]);
  assert.equal(tracker.take(), null);
  tracker.reset();
  assert.deepEqual(tracker.take(), { persist: true, assets: true });
});

test("嵌套手势只有全部结束才允许持久化", () => {
  const tracker = createChangeTracker();
  tracker.begin("node"); tracker.begin("viewport"); tracker.mutate();
  tracker.end("viewport"); assert.equal(tracker.take(), null);
  tracker.end("node"); assert.deepEqual(tracker.take(), { persist: true, assets: true });
});

test("异步保存边界等待新手势结束，卸载后不再合并响应", async () => {
  assert.equal(typeof changes.module.waitForGestureIdle, "function");
  const tracker = createChangeTracker(); tracker.begin("node");
  let polls = 0;
  const ready = await changes.module.waitForGestureIdle(tracker, () => true, async () => {
    polls++;
    if (polls === 1) { tracker.end("node"); tracker.begin("viewport"); }
    else tracker.end("viewport");
  });
  assert.equal(ready, true); assert.equal(polls, 2);
  tracker.begin("node"); let mounted = true;
  assert.equal(await changes.module.waitForGestureIdle(tracker, () => mounted, async () => { mounted = false; }), false);
});

test("提交回执不能清除尚未被 effect 计数的本地变更", () => {
  assert.equal(typeof changes.module.versionAfterCommit, "function");
  assert.equal(changes.module.versionAfterCommit(3, 3, true), 4);
  assert.equal(changes.module.versionAfterCommit(3, 5, true), 5);
  assert.equal(changes.module.versionAfterCommit(3, 3, false), 3);
});

test("坐标检查点以 250ms 采样，结束立即收敛，完全不读取正文", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/geometry-journal.ts");
  try {
    let now = 1000;
    const journal = loaded.module.createGeometryJournal(() => now);
    const node = { id: "n", position: { x: 0, y: 0 }, get data() { throw new Error("不能读取正文"); } };
    journal.begin([node]);
    for (let frame = 1; frame <= 120; frame++) {
      now = 1000 + frame * 10;
      journal.update([{ id: "n", position: { x: frame, y: 0 } }]);
      const point = journal.sample();
      if (point) { assert.equal(frame % 25, 0); assert.equal(point.moves[0].to.x, frame); }
    }
    const end = journal.finish();
    assert.deepEqual(end.moves, [{ id: "n", from: { x: 0, y: 0 }, to: { x: 120, y: 0 } }]);
    assert.equal(journal.sample(), null);
    assert.equal(journal.through(), end.sequence);
    journal.begin([node]);
    journal.update([{ id: "n", position: { x: 5, y: 5 } }]);
    now += 250; assert.ok(journal.sample());
    journal.update([node]);
    assert.deepEqual(journal.finish().moves[0].to, node.position, "移回起点仍须覆盖途中检查点");
  } finally { await loaded.dispose(); }
});

test("检查点恢复保留同时修改的正文，不复活删除节点，不覆盖冲突坐标", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/geometry-journal.ts");
  try {
    const doc = canvasFixture(100);
    const node = doc.nodes[0]; node.data.content = "Agent 新正文";
    const point = { sequence: 1, moves: [{ id: node.id, from: node.position, to: { x: 50, y: 50 } }] };
    const restored = loaded.module.restoreGeometry(doc, [point]);
    assert.deepEqual(restored.document.nodes[0].position, point.moves[0].to);
    assert.equal(restored.document.nodes[0].data, node.data);
    assert.equal(restored.document.nodes[1], doc.nodes[1]);
    assert.equal(loaded.module.restoreGeometry(restored.document, [point]).document, restored.document);
    const conflictDoc = { ...doc, nodes: [{ ...node, position: { x: 99, y: 99 } }] };
    const conflict = loaded.module.restoreGeometry(conflictDoc, [point]);
    assert.equal(conflict.document, conflictDoc);
    assert.deepEqual(conflict.conflicts, [node.id]);
    const missing = loaded.module.restoreGeometry({ ...doc, nodes: [] }, [point]);
    assert.equal(missing.document.nodes.length, 0);
    const second = { sequence: 2, moves: [{ id: node.id, from: point.moves[0].to, to: { x: 70, y: 70 } }] };
    assert.equal(loaded.module.restoreGeometry(doc, [second, point]).document.nodes[0].position.x, 70);
  } finally { await loaded.dispose(); }
});

test("群组检查点同字段冲突时整组不回放；坏坐标拒绝，序号跨恢复单调", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/geometry-journal.ts");
  try {
    const doc = canvasFixture(100);
    const moves = doc.nodes.slice(0, 2).map(node => ({ id: node.id, from: node.position, to: { x: 1, y: 2 } }));
    moves[1].from = { x: -1, y: -1 };
    const result = loaded.module.restoreGeometry(doc, [{ sequence: 1, moves }]);
    assert.equal(result.document, doc);
    assert.throws(() => loaded.module.restoreGeometry(doc, [{ sequence: 2, moves: [{ ...moves[0], to: { x: NaN, y: 0 } }] }]), /检查点/);
    const journal = loaded.module.createGeometryJournal(() => 100);
    journal.advance(500); journal.begin(doc.nodes.slice(0, 1));
    journal.update([{ id: doc.nodes[0].id, position: { x: 1, y: 2 } }]);
    assert.equal(journal.finish().sequence, 501);
    journal.begin(doc.nodes.slice(0, 1));
    assert.equal(journal.finish(), null, "没有移动不写检查点");
  } finally { await loaded.dispose(); }
});

test("IndexedDB 检查点与草稿同事务收敛，只清理已覆盖序号，失败时原记录保留", async () => {
  const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
  const loaded = await loadTypescript("lib/canvas-drafts.ts");
  try {
    const api = loaded.module;
    assert.equal(typeof api.saveGeometryCheckpoint, "function");
    const point = sequence => ({ sequence, moves: [{ id: "n", from: { x: 0, y: 0 }, to: { x: sequence, y: 0 } }] });
    await api.saveGeometryCheckpoint("a:tab", "a", point(10));
    await api.saveGeometryCheckpoint("a:tab", "a", point(11));
    await api.saveGeometryCheckpoint("b:tab", "b", point(10));
    assert.equal((await api.loadGeometryCheckpoints("a:tab", "a")).length, 2);
    const doc = { ...canvasFixture(100), id: "a" };
    const draft = { key: "a:tab", canvasId: "a", base: doc, working: doc, checkpointThrough: 10 };
    await api.saveCanvasDraft(draft);
    assert.deepEqual((await api.loadGeometryCheckpoints("a:tab", "a")).map(item => item.sequence), [11]);
    assert.equal((await api.loadGeometryCheckpoints("b:tab", "b")).length, 1);
    const invalid = { ...draft, working: { ...doc, uncloneable: () => {} }, checkpointThrough: 11 };
    await assert.rejects(api.saveCanvasDraft(invalid));
    assert.equal((await api.loadGeometryCheckpoints("a:tab", "a")).length, 1);
    assert.equal((await api.loadCanvasDraft("a:tab")).checkpointThrough, 10);
    await assert.rejects(api.saveCanvasDraft({ ...draft, checkpointThrough: -1 }));
    assert.equal((await api.loadCanvasDraft("a:tab")).checkpointThrough, 10, "put 后发生异常也必须回滚整个事务");
    await api.clearCanvasDraft("a:tab", 10);
    assert.equal(await api.loadCanvasDraft("a:tab"), undefined);
    assert.equal((await api.loadGeometryCheckpoints("a:tab", "a")).length, 1);
    await api.clearCanvasDraft("a:tab", 11);
    assert.equal((await api.loadGeometryCheckpoints("a:tab", "a")).length, 0);
  } finally { await loaded.dispose(); Object.assign(globalThis, previous); }
});

test("空间索引局部查询不扫描万级图，连续移动不残留旧桶", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/spatial-index.ts");
  try {
    const index = loaded.module.createSpatialIndex();
    for (const node of canvasFixture(10000).nodes) index.upsert(node.id, { ...node.position, width: node.width, height: node.height });
    assert.ok(index.query({ x: 0, y: 0, width: 300, height: 300 }).includes("node-0"));
    assert.ok(index.stats().lastQueryVisited < 50);
    for (let frame = 0; frame < 200; frame++) index.upsert("node-0", { x: -10000 - frame * 1000, y: -10000, width: 280, height: 280 });
    assert.equal(index.size(), 10000);
    assert.equal(index.query({ x: 0, y: 0, width: 300, height: 300 }).includes("node-0"), false);
    index.remove("node-0");
    assert.equal(index.size(), 9999);
    assert.equal(index.query({ x: -210000, y: -10100, width: 2000, height: 1000 }).length, 0);
    assert.ok(index.stats().lastQueryVisited < 5);
  } finally { await loaded.dispose(); }
});

test("空间索引覆盖负坐标、超大节点与跨视口包围盒，非法几何不会破坏旧条目", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/spatial-index.ts");
  try {
    const index = loaded.module.createSpatialIndex();
    index.upsert("huge", { x: -1e8, y: -1e8, width: 2e8, height: 2e8 });
    index.upsert("line-bounds", { x: -1000, y: 0, width: 2000, height: 1 });
    assert.deepEqual(new Set(index.query({ x: -1, y: 0, width: 2, height: 10 })), new Set(["huge", "line-bounds"]));
    assert.ok(index.stats().cells < 10, "超大对象进入溢出集合，不能展开海量桶");
    assert.throws(() => index.upsert("huge", { x: NaN, y: 0, width: 2, height: 2 }), /几何/);
    assert.equal(index.size(), 2);
    assert.equal(index.query({ x: -1e9, y: -1e9, width: 2e9, height: 2e9 }).length, 2);
    index.remove("huge"); index.remove("line-bounds");
    assert.equal(index.stats().cells, 0);
  } finally { await loaded.dispose(); }
});

test("批量自动放置复用空间索引，保留原有间距与搜索次序", async () => {
  const loaded = await loadTypescript("lib/node-placement.ts");
  try {
    const { createPlacementIndex, placeNewNode } = loaded.module;
    assert.equal(typeof createPlacementIndex, "function");
    const nodes = canvasFixture(1000).nodes;
    const index = createPlacementIndex(nodes);
    for (let i = 0; i < 20; i++) {
      const at = { x: i * 10, y: i * -10 };
      const expected = placeNewNode(at, nodes);
      const actual = placeNewNode(at, nodes, undefined, index);
      assert.deepEqual(actual, expected);
      const added = { position: actual, width: 304, height: 264 };
      nodes.push(added); index.add(added);
    }
  } finally { await loaded.dispose(); }
});

test("草稿队列只写最新待写快照，所有调用者等待同一批次", async () => {
  const queue = createLatestQueue();
  const writes = [];
  const calls = Array.from({ length: 120 }, (_, version) => queue.latest("a", version, async value => { writes.push(value); }));
  await Promise.all(calls);
  assert.deepEqual(writes, [119]);
});

test("clear/read 是顺序屏障，不能被之后的写入越过", async () => {
  const queue = createLatestQueue(); const seen = [];
  const write = value => { seen.push(value); };
  const first = queue.latest("a", 1, write);
  const clear = queue.barrier(() => { seen.push("clear"); });
  const second = queue.latest("a", 2, write);
  await Promise.all([first, clear, second]);
  assert.deepEqual(seen, [1, "clear", 2]);
});

test("在途写入不会被改写，另一画布独立合并，失败不阻塞后续", async () => {
  const queue = createLatestQueue(); const seen = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = queue.latest("a", 1, async value => { seen.push(value); await gate; throw new Error("disk"); });
  const rejected = assert.rejects(first, /disk/);
  await Promise.resolve();
  const second = queue.latest("a", 2, value => { seen.push(value); });
  const other = queue.latest("b", 3, value => { seen.push(value); });
  release();
  await Promise.all([rejected, second, other]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("节点重内容由浅比较隔离，节点和连线不再订阅连续 zoom", async () => {
  for (const name of ["image-node", "asset-node", "video-node", "text-node"]) {
    const source = await readFile(new URL(`../components/canvas/${name}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /useStore\b/, `${name} 不应订阅缩放`);
    assert.match(source, /sameNodeView/);
    assert.match(source, /memo\(function/);
  }
  const edge = await readFile(new URL("../components/canvas/scissor-edge.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(edge, /useStore\b/);
  assert.match(edge, /var\(--canvas-inverse-zoom, 1\)/);
});

test("面板引用通过关联边及来源 data 订阅，不依赖全图数组", async () => {
  const source = await readFile(new URL("../components/canvas/prompt-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /state\.(nodes|edges)\b/);
  assert.match(source, /useNodeConnections/);
  assert.match(source, /useNodesData/);
  assert.match(source, /memo\(function TextPanelBody/);
});

test("节点视图比较只读四个呈现属性，不扫描正文或位置", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/node-view.ts");
  try {
    const { sameNodeView } = loaded.module;
    const data = new Proxy({}, { ownKeys() { throw new Error("不能扫描正文"); } });
    const first = { id: "a", data, selected: true, draggable: true, positionAbsoluteX: 0 };
    assert.equal(sameNodeView(first, { ...first, positionAbsoluteX: 300, dragging: true }), true);
    for (const patch of [{ id: "b" }, { data: {} }, { selected: false }, { draggable: false }]) {
      assert.equal(sameNodeView(first, { ...first, ...patch }), false);
    }
  } finally { await loaded.dispose(); }
});

test("集中缩放样式只在 zoom 变化时更新，卸载取消订阅并清理样式", async () => {
  const loaded = await loadTypescript("lib/canvas-runtime/node-view.ts");
  try {
    const values = new Map(); let writes = 0; let listener; let removed = false;
    const style = { setProperty(key, value) { writes++; values.set(key, value); }, removeProperty(key) { values.delete(key); } };
    const store = { getState: () => ({ transform: [0, 0, 0.5] }), subscribe(fn) { listener = fn; return () => { removed = true; }; } };
    const dispose = loaded.module.bindCanvasZoom(store, style);
    assert.equal(values.get("--selection-width"), "4px");
    assert.equal(values.get("--canvas-inverse-zoom"), "2");
    listener({ transform: [100, 20, 0.5] });
    assert.equal(writes, 2, "平移不写样式");
    listener({ transform: [100, 20, 2] });
    assert.equal(values.get("--selection-width"), "1px");
    dispose(); assert.equal(removed, true); assert.equal(values.size, 0);
  } finally { await loaded.dispose(); }
});
