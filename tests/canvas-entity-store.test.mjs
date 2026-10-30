import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";
import { canvasFixture } from "./helpers/canvas-fixture.mjs";

const storeModule = await loadTypescript("lib/canvas-runtime/store.ts", { packages: true });
after(storeModule.dispose);
const legacyModule = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
after(legacyModule.dispose);
const { createCanvasStore, StoreDeltaError } = storeModule.module;
const { fromCanvasDoc, toCanvasDoc } = legacyModule.module;

const g = (x = 0, y = 0, width = 280, height = 240) => ({ x, y, width, height });
const node = (id, extra = {}) => ({ id, canvasId: "c1", type: "image", schemaVersion: 1, geometry: g(), entityVersion: 0, geometryVersion: 0, documentId: null, data: { name: id, assetName: `${id}.png` }, ...extra });
const textNode = (id, extra = {}) => node(id, { type: "canvasText", documentId: `doc_${id}`, data: { name: id }, ...extra });
const doc = (nodeId, content = "正文") => ({ id: `doc_${nodeId}`, nodeId, content, version: 0 });
const edge = (id, source, target, extra = {}) => ({ id, canvasId: "c1", source, target, role: null, version: 0, ...extra });
const seed = () => ({
  canvasId: "c1", revision: 5, name: "画布",
  nodes: [node("n1"), node("n2"), textNode("t1"), node("v1", { type: "video", data: { name: "v1" } })],
  documents: [doc("t1")],
  edges: [edge("e1", "n1", "v1", { role: "first" }), edge("e2", "n2", "v1", { role: "reference" }), edge("e3", "t1", "n1")],
});
const delta = (store, extra = {}) => ({
  canvasId: store.canvasId, fromRevision: store.getRevision(), revision: store.getRevision() + 1,
  nodes: [], documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [], ...extra,
});
const moved = (current, x, y) => ({ ...current, geometry: { ...current.geometry, x, y }, geometryVersion: current.geometryVersion + 1, entityVersion: current.entityVersion + 1 });

test("单节点移动只通知该节点，其余对象与正文引用不变", () => {
  const store = createCanvasStore(seed());
  const before = { n1: store.getNode("n1"), n2: store.getNode("n2"), t1: store.getNode("t1"), docT1: store.getDocument("doc_t1"), ids: store.getNodeIds(), edgeIds: store.getEdgeIds(), snapshot: store.snapshot() };
  const calls = { n1: 0, n2: 0, doc: 0, structure: 0 };
  store.subscribeNode("n1", () => calls.n1++);
  store.subscribeNode("n2", () => calls.n2++);
  store.subscribeDocument("doc_t1", () => calls.doc++);
  store.subscribeStructure(() => calls.structure++);
  const result = store.applyDelta(delta(store, { nodes: [moved(before.n1, 50, 60)] }));
  assert.deepEqual(calls, { n1: 1, n2: 0, doc: 0, structure: 0 });
  const n1 = store.getNode("n1");
  assert.notEqual(n1, before.n1);
  assert.deepEqual(n1.geometry, g(50, 60));
  assert.equal(n1.data, before.n1.data, "data 引用应复用");
  assert.equal(store.getNode("n2"), before.n2);
  assert.equal(store.getNode("t1"), before.t1);
  assert.equal(store.getDocument("doc_t1"), before.docT1);
  assert.equal(store.getDocument("doc_t1").content, before.docT1.content);
  assert.equal(store.getNodeIds(), before.ids);
  assert.equal(store.getEdgeIds(), before.edgeIds);
  assert.notEqual(store.snapshot(), before.snapshot);
  assert.equal(store.getRevision(), 6);
  assert.deepEqual(result.changedNodeIds, ["n1"]);
  assert.deepEqual(result.dependentNodeIds, []);
});

test("无变化时 getSnapshot 返回同一引用；暴露的对象只读", () => {
  const store = createCanvasStore(seed());
  assert.equal(store.getNode("n1"), store.getNode("n1"));
  assert.equal(store.snapshot(), store.snapshot());
  assert.equal(store.getNode("missing"), undefined);
  assert.ok(Object.isFrozen(store.getNode("n1")));
  assert.ok(Object.isFrozen(store.getNode("n1").data));
  assert.ok(Object.isFrozen(store.getNode("n1").geometry));
  assert.ok(Object.isFrozen(store.getNodeIds()));
  assert.throws(() => { store.getNodeIds().push("x"); });
  assert.equal(typeof store.nodes, "undefined", "不暴露可修改 Map");
});

test("改来源主图只标记实际下游；纯移动不重算素材目录", () => {
  const store = createCanvasStore(seed());
  store.resetStats();
  store.applyDelta(delta(store, { nodes: [moved(store.getNode("n2"), 10, 10)] }));
  assert.equal(store.stats().assetVisits, 0);
  const n1 = store.getNode("n1");
  const result = store.applyDelta(delta(store, { nodes: [{ ...n1, entityVersion: n1.entityVersion + 1, data: { ...n1.data, assetName: "n1-new.png" } }] }));
  assert.deepEqual(result.dependentNodeIds, ["v1"]);
  assert.deepEqual(store.getNodesUsingAsset("n1-new.png"), ["n1"]);
  assert.deepEqual(store.getNodesUsingAsset("n1.png"), []);
  const renamed = store.getNode("n2");
  const nameOnly = store.applyDelta(delta(store, { nodes: [{ ...renamed, entityVersion: renamed.entityVersion + 1, data: { ...renamed.data, name: "改名" } }] }));
  assert.deepEqual(nameOnly.dependentNodeIds, []);
});

test("删节点同步移除正文、入/出边和全部索引", () => {
  const store = createCanvasStore(seed());
  let structure = 0;
  store.subscribeStructure(() => structure++);
  store.applyDelta(delta(store, { removedNodeIds: ["n1", "t1"] }));
  assert.equal(structure, 1);
  assert.deepEqual([...store.getNodeIds()], ["n2", "v1"]);
  assert.deepEqual([...store.getEdgeIds()], ["e2"]);
  assert.equal(store.getDocument("doc_t1"), undefined);
  assert.deepEqual(store.getIncoming("v1"), ["e2"]);
  assert.deepEqual(store.getOutgoing("t1"), []);
  assert.deepEqual(store.getNodesUsingAsset("n1.png"), []);
  assert.deepEqual(store.queryRect(g(-10, -10, 1000, 1000)).sort(), ["n2", "v1"]);
});

test("增量整批校验：任一项无效则 Store 保持旧状态且不通知", () => {
  const store = createCanvasStore(seed());
  const snapshot = store.snapshot();
  let calls = 0;
  store.subscribeNode("n1", () => calls++);
  store.subscribeStructure(() => calls++);
  const bad = [
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], edges: [edge("ex", "n1", "v1", { canvasId: "other" })] }),
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], edges: [edge("ex", "n1", "ghost")] }),
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], removedNodeIds: ["v1"], edges: [edge("ex", "n2", "v1")] }),
    delta(store, { nodes: [{ ...store.getNode("n1"), canvasId: "other" }] }),
    { ...delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)] }), canvasId: "other" },
    { ...delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)] }), fromRevision: 3 },
    { ...delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)] }), revision: 4 },
    delta(store, { nodes: [{ ...store.getNode("n1"), entityVersion: -1 }] }),
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], documents: [{ ...doc("t1"), nodeId: "ghost" }] }),
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], documents: [{ id: "doc_other", nodeId: "t1", content: "x", version: 0 }] }),
    delta(store, { nodes: [{ ...moved(store.getNode("n1"), 1, 1), geometry: g(NaN, 0) }] }),
    delta(store, { nodes: [moved(store.getNode("n1"), 1, 1)], edges: [edge("self", "n1", "n1")] }),
  ];
  for (const item of bad) assert.throws(() => store.applyDelta(item), StoreDeltaError);
  assert.equal(store.snapshot(), snapshot);
  assert.equal(calls, 0);
  assert.equal(store.getRevision(), 5);
});

test("版本不回退：旧增量被拒绝，同版本重放是幂等的", () => {
  const store = createCanvasStore(seed());
  const n1 = store.getNode("n1");
  store.applyDelta(delta(store, { nodes: [moved(n1, 5, 5)] }));
  assert.throws(() => store.applyDelta(delta(store, { nodes: [n1] })), /版本/);
  const current = store.getNode("n1");
  let calls = 0;
  store.subscribeNode("n1", () => calls++);
  store.applyDelta(delta(store, { nodes: [{ ...current, geometry: { ...current.geometry }, data: { ...current.data } }] }));
  assert.equal(store.getNode("n1"), current, "等价重放不替换引用");
  assert.equal(calls, 0);
});

test("新增与改名：结构订阅只在增删时触发，画布订阅在改名时触发", () => {
  const store = createCanvasStore(seed());
  let structure = 0, canvas = 0;
  store.subscribeStructure(() => structure++);
  store.subscribeCanvas(() => canvas++);
  store.applyDelta(delta(store, { nodes: [textNode("t2")], documents: [doc("t2", "新正文")], edges: [edge("e9", "t2", "n2")] }));
  assert.equal(structure, 1);
  assert.deepEqual([...store.getNodeIds()], ["n1", "n2", "t1", "v1", "t2"]);
  assert.equal(store.getDocument("doc_t2").content, "新正文");
  assert.deepEqual(store.getOutgoing("t2"), ["e9"]);
  store.applyDelta(delta(store, { name: "新名字" }));
  assert.equal(store.getCanvas().name, "新名字");
  assert.equal(canvas, 2, "每次修订号变化都通知画布订阅");
  assert.equal(structure, 1);
});

test("正文更新只通知对应文档订阅", () => {
  const store = createCanvasStore(seed());
  const before = store.getNode("t1");
  const calls = { doc: 0, node: 0 };
  store.subscribeDocument("doc_t1", () => calls.doc++);
  store.subscribeNode("t1", () => calls.node++);
  store.applyDelta(delta(store, { documents: [{ ...doc("t1", "改过"), version: 1 }] }));
  assert.deepEqual(calls, { doc: 1, node: 0 });
  assert.equal(store.getNode("t1"), before);
  assert.equal(store.getDocument("doc_t1").content, "改过");
});

test("订阅可清理；同一回调重复订阅互不影响；dispose 后拒绝使用", () => {
  const store = createCanvasStore(seed());
  let calls = 0;
  const fn = () => calls++;
  const off1 = store.subscribeNode("n1", fn);
  const off2 = store.subscribeNode("n1", fn);
  assert.equal(store.stats().subscriptions, 2);
  off1();
  off1();
  assert.equal(store.stats().subscriptions, 1);
  store.applyDelta(delta(store, { nodes: [moved(store.getNode("n1"), 1, 2)] }));
  assert.equal(calls, 1);
  off2();
  assert.equal(store.stats().subscriptions, 0);
  store.subscribeStructure(fn);
  store.dispose();
  assert.equal(store.stats().subscriptions, 0);
  assert.throws(() => store.applyDelta(delta(store, {})), /dispose/);
  assert.throws(() => store.subscribeNode("n1", fn), /dispose/);
});

test("通知异常不破坏已发布状态，也不阻断其他订阅者", () => {
  const store = createCanvasStore(seed());
  let other = 0;
  store.subscribeNode("n1", () => { throw new Error("boom"); });
  store.subscribeNode("n1", () => other++);
  assert.throws(() => store.applyDelta(delta(store, { nodes: [moved(store.getNode("n1"), 3, 3)] })), /boom/);
  assert.equal(other, 1);
  assert.deepEqual(store.getNode("n1").geometry, g(3, 3));
  assert.equal(store.getRevision(), 6);
});

test("万级混合图：初始化 O(N+E)，单节点移动不遍历全图或全边", () => {
  const legacy = canvasFixture(10000);
  const converted = fromCanvasDoc(legacy);
  const store = createCanvasStore(converted.seed);
  const init = store.stats();
  assert.equal(init.nodes, 10000);
  assert.equal(init.edges, 20000);
  assert.ok(init.nodeVisits <= 10000 && init.edgeVisits <= 20000, JSON.stringify(init));
  const ids = store.getNodeIds();
  store.resetStats();
  const target = store.getNode("node-6000");
  store.applyDelta(delta(store, { nodes: [moved(target, 99, 77)] }));
  const after = store.stats();
  assert.deepEqual({ nodeVisits: after.nodeVisits, edgeVisits: after.edgeVisits, assetVisits: after.assetVisits, listRebuilds: after.listRebuilds, spatialUpserts: after.spatialUpserts }, { nodeVisits: 1, edgeVisits: 0, assetVisits: 0, listRebuilds: 0, spatialUpserts: 1 });
  assert.equal(store.getNodeIds(), ids);
  assert.ok(store.queryRect(g(90, 70, 20, 20)).includes("node-6000"));
  store.resetStats();
  store.applyDelta(delta(store, { removedNodeIds: ["node-6000"] }));
  const removal = store.stats();
  assert.ok(removal.edgeVisits <= 4 * 10, `删除只访问相关边：${removal.edgeVisits}`);
  assert.equal(removal.listRebuilds, 2);
});

test("legacy → store → legacy 往返保留业务字段、修订号与素材归属", () => {
  const legacy = {
    id: "c1", name: "画布", schemaVersion: 1, revision: 42, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    viewport: { x: 1, y: 2, zoom: 0.5 },
    nodes: [
      { id: "a1", type: "asset", position: { x: 1, y: 2 }, measured: { width: 220, height: 200 }, selected: true, draggable: false, data: { name: "素材", assetName: "a1.png" } },
      { id: "i1", type: "image", position: { x: 300, y: 0 }, dragging: true, data: { name: "图片", prompt: "猫", status: "idle", assetName: "r1.png", results: [{ id: "r1", assetName: "r1.png", status: "success" }], primaryResultId: "r1", uploadAttachments: ["a1.png"] } },
      { id: "t1", type: "canvasText", position: { x: 0, y: 400 }, width: 560, height: 1120, resizing: false, data: { name: "文稿", content: "# 标题\n正文" } },
      { id: "v1", type: "video", position: { x: 700, y: 0 }, data: { name: "视频", prompt: "", duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true, status: "idle", uploadInputs: [] } },
    ],
    edges: [
      { id: "e1", source: "a1", target: "v1", type: "scissor", data: { role: "first" } },
      { id: "e2", source: "t1", target: "i1", type: "scissor", data: {}, selected: true },
    ],
    libraryAssets: [{ assetName: "r1.png", name: "图片", sources: ["generated"], addedAt: "2026-01-01T00:00:00.000Z" }],
    appliedOperationIds: ["op-1"],
    generationClaims: { i1: { id: "g1", state: "unknown" } },
  };
  const converted = fromCanvasDoc(structuredClone(legacy));
  assert.deepEqual(converted.issues, []);
  const t1 = converted.seed.nodes.find(n => n.id === "t1");
  assert.equal(t1.documentId, "doc_t1");
  assert.equal("content" in t1.data, false);
  assert.equal(converted.seed.documents[0].content, "# 标题\n正文");
  assert.deepEqual(converted.seed.nodes.find(n => n.id === "a1").geometry, { x: 1, y: 2, width: 220, height: 200 });
  assert.equal(converted.seed.nodes.find(n => n.id === "a1").data.pinned, true);
  assert.deepEqual(converted.seed.nodes.find(n => n.id === "v1").geometry, { x: 700, y: 0, width: 280, height: 240 });
  assert.deepEqual(converted.seed.edges.map(e => e.role), ["first", null]);
  const store = createCanvasStore(converted.seed);
  const exported = toCanvasDoc(store.snapshot(), converted.meta);
  const strip = ({ selected, dragging, resizing, measured, ...rest }) => rest;
  const expected = { ...legacy, nodes: legacy.nodes.map(strip), edges: legacy.edges.map(strip) };
  assert.deepEqual(exported, expected);
});

test("正文 document ID 稳定：重复转换得到相同 ID，并优先沿用已有映射", () => {
  const legacy = canvasFixture(20);
  const one = fromCanvasDoc(structuredClone(legacy));
  const two = fromCanvasDoc(structuredClone(legacy));
  assert.deepEqual(one.seed.documents.map(d => d.id), two.seed.documents.map(d => d.id));
  assert.equal(one.documentIds.get("node-0"), "doc_node-0");
  const remembered = fromCanvasDoc(structuredClone(legacy), { documentIds: new Map([["node-0", "doc-remembered"]]) });
  assert.equal(remembered.seed.nodes.find(n => n.id === "node-0").documentId, "doc-remembered");
  assert.equal(remembered.seed.documents.find(d => d.nodeId === "node-0").id, "doc-remembered");
});

test("转换报告未知类型、未登记字段、悬空边与重复 ID，但不静默丢弃节点数据", () => {
  const legacy = {
    ...canvasFixture(20), id: "c2",
    nodes: [
      { id: "x1", type: "mystery", position: { x: 0, y: 0 }, data: { name: "?" } },
      { id: "i1", type: "image", position: { x: 0, y: 0 }, data: { name: "图片", futureField: 1 } },
      { id: "i1", type: "image", position: { x: 9, y: 9 }, data: { name: "重复" } },
    ],
    edges: [{ id: "e1", source: "i1", target: "ghost", type: "scissor", data: {} }],
  };
  const converted = fromCanvasDoc(legacy);
  const codes = converted.issues.map(issue => `${issue.code}:${issue.id}`).sort();
  assert.deepEqual(codes, ["dangling_edge:e1", "duplicate_id:i1", "unknown_field:i1", "unknown_type:x1"]);
  assert.equal(converted.seed.nodes.find(n => n.id === "x1").type, "mystery");
  assert.equal(converted.seed.nodes.find(n => n.id === "i1").data.futureField, 1);
  assert.equal(converted.seed.nodes.filter(n => n.id === "i1").length, 1);
  assert.equal(converted.seed.edges.length, 0);
});

test("实体订阅判定不使用 JSON.stringify 或深比较", async () => {
  for (const file of ["store.ts", "indexes.ts"]) {
    const source = (await readFile(new URL(`../lib/canvas-runtime/${file}`, import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /JSON\.stringify|isDeepStrictEqual|deepEqual/);
  }
});

test("实体 Store 测试已登记进 pnpm test", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:commands"], /tests\/canvas-entity-store\.test\.mjs/);
});
