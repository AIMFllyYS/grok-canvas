import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-user-actions-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;
const actions = await loadTypescript("lib/canvas-runtime/user-actions.ts", { packages: true });
const scene = await loadTypescript("lib/canvas-runtime/scene-adapter.ts", { packages: true });
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
const repository = await loadTypescript("lib/canvas-runtime/json-repository.ts", { packages: true });
after(async () => {
  for (const m of [actions, scene, store, service, repository]) await m.dispose();
  await rm(dataDir, { recursive: true, force: true });
});
const { translateUserWrites, cloneSelection, toDraftBody } = actions.module;
const { createConfirmedGeometry } = scene.module;

const CANVAS = "c1";
const text = (id, content = `正文 ${id}`, extra = {}) => ({ id, type: "canvasText", position: { x: 0, y: 0 }, width: 360, height: 260, data: { name: id, content }, ...extra });
const image = (id, data = {}) => ({ id, type: "image", position: { x: 0, y: 0 }, data: { name: id, assetName: null, uploadAttachments: [], prompt: "", aspectRatio: "auto", resolution: "1k", quality: "low", status: "idle", generationCount: 1, sourceNodeId: null, ...data } });
const summary = (id, type = "canvasText", extra = {}) => ({ id, canvasId: CANVAS, type, schemaVersion: 1, geometry: { x: 0, y: 0, width: 360, height: 260 }, entityVersion: 3, geometryVersion: 0, documentId: type === "canvasText" ? `doc-${id}` : null, data: { name: id }, ...extra });
const confirmedOf = (nodes, edges = [], fieldVersions = {}) => createConfirmedGeometry({ canvasId: CANVAS, revision: 5, name: "画布", nameVersion: 0, storageEpoch: "json-v1", nodes, documents: nodes.filter(n => n.documentId).map(n => ({ id: n.documentId, nodeId: n.id, content: "", version: 7 })), edges, fieldVersions });
const mapOf = (items) => new Map(items.map(item => [item.id, item]));
const run = (committedNodes, committedEdges, nodes, edges, versions) => translateUserWrites({ canvasId: CANVAS, committedNodes: mapOf(committedNodes), committedEdges: mapOf(committedEdges), nodes, edges, versions });

test("未被替换引用的节点/连线不比较：普通保存没有整图 diff，也不产生命令", () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => text(`n${i}`));
  const versions = confirmedOf(nodes.map(n => summary(n.id)));
  const writes = run(nodes, [], nodes, [], versions);
  assert.deepEqual(writes, { commands: [], legacy: [], issues: [] });
});

test("正文用文档版本、提示词等 user 字段用字段版本；service 字段只进兼容写入；固定映射为 pinned", () => {
  const a = text("a"), img = image("img");
  const versions = confirmedOf([summary("a"), summary("img", "image")], [], { img: { prompt: 2 } });
  const nextA = { ...a, data: { ...a.data, content: "新的正文" } };
  const nextImg = { ...img, draggable: false, data: { ...img.data, prompt: "一只猫", status: "running", generationId: "g-1" } };
  const writes = run([a, img], [], [nextA, nextImg], [], versions);
  assert.equal(writes.commands.length, 1);
  assert.equal(writes.commands[0].kind, "patch_nodes");
  const items = writes.commands[0].payload.items;
  assert.deepEqual(items.find(i => i.field === "content"), { nodeId: "a", field: "content", expectedVersion: 7, value: "新的正文" });
  assert.deepEqual(items.find(i => i.field === "prompt"), { nodeId: "img", field: "prompt", expectedVersion: 2, value: "一只猫" });
  assert.deepEqual(items.find(i => i.field === "pinned"), { nodeId: "img", field: "pinned", expectedVersion: 0, value: true });
  assert.deepEqual(writes.legacy.map(op => op.path.join(".")).sort(), ["data.generationId", "data.status"], "生成状态只作兼容写入，且只含被触碰的字段");
  assert.ok(writes.legacy.every(op => op.target === "node" && op.entityId === "img"));
});

test("新增 + 连线组合成一条 batch；ID 预分配；正文进 DocumentRecord", () => {
  const src = image("src"), versions = confirmedOf([summary("src", "image")]);
  const fresh = text("fresh", "新文本");
  const edge = { id: "e1", source: "src", target: "fresh", type: "scissor" };
  const writes = run([src], [], [src, fresh], [edge], versions);
  const body = toDraftBody(writes.commands);
  assert.equal(body.kind, "batch");
  const kinds = body.payload.commands.map(c => c.kind);
  assert.deepEqual(kinds, ["add_nodes", "edit_edges"]);
  const add = body.payload.commands[0].payload;
  assert.equal(add.nodes[0].id, "fresh");
  assert.equal(add.documents[0].content, "新文本");
  assert.equal(add.nodes[0].documentId, add.documents[0].id);
  assert.deepEqual(body.payload.commands[1].payload.add[0], { id: "e1", canvasId: CANVAS, source: "src", target: "fresh", role: null, version: 0 });
});

test("删除节点带 expectedEntityVersion；相关边由服务端级联，不重复发 remove；单独删边带边版本", () => {
  const a = text("a"), b = text("b"), c = text("c");
  const e1 = { id: "e1", source: "a", target: "b" }, e2 = { id: "e2", source: "b", target: "c" };
  const versions = confirmedOf([summary("a"), summary("b"), summary("c")], [{ id: "e1", canvasId: CANVAS, source: "a", target: "b", role: null, version: 4 }, { id: "e2", canvasId: CANVAS, source: "b", target: "c", role: null, version: 9 }]);
  const writes = run([a, b, c], [e1, e2], [b, c], [], versions);
  assert.deepEqual(writes.commands.map(c => c.kind), ["edit_edges", "delete_nodes"]);
  assert.deepEqual(writes.commands[0].payload.remove, [{ edgeId: "e2", expectedVersion: 9 }], "e1 随 a 级联删除");
  assert.deepEqual(writes.commands[1].payload.items, [{ nodeId: "a", expectedEntityVersion: 3 }]);
});

test("已入队但未确认的新增被视为已知：后续修改是 patch，不重复 add", () => {
  const versions = confirmedOf([]);
  const fresh = text("fresh");
  const first = run([], [], [fresh], [], versions);
  versions.predictCommand(first.commands[0].kind, first.commands[0].payload);
  const edited = { ...fresh, data: { ...fresh.data, content: "改过" } };
  const second = run([fresh], [], [edited], [], versions);
  assert.equal(second.commands[0].kind, "patch_nodes");
  assert.equal(second.commands[0].payload.items[0].expectedVersion, 0);
});

test("复制：ID 全部新分配，只复制内部边并重映射，外部边不复制", () => {
  const nodes = [text("a"), text("b"), text("outside")];
  const edges = [{ id: "in", source: "a", target: "b" }, { id: "out", source: "outside", target: "a" }];
  const copy = cloneSelection(nodes, edges, new Set(["a", "b"]));
  assert.equal(copy.nodes.length, 2);
  assert.ok(copy.nodes.every(n => !["a", "b"].includes(n.id)));
  assert.equal(new Set(copy.nodes.map(n => n.id)).size, 2);
  assert.equal(copy.edges.length, 1);
  assert.deepEqual([copy.edges[0].source, copy.edges[0].target], [copy.idMap.get("a"), copy.idMap.get("b")]);
  assert.notEqual(copy.edges[0].id, "in");
  assert.notEqual(copy.nodes[0].data, nodes[0].data, "data 深拷贝");
});

test("服务端：新增+连线 batch 中任一条无效则整批回滚，不留下部分节点", async () => {
  const { createCanvas, loadCanvas } = store.module;
  const { executeCommand, JSON_STORAGE_EPOCH } = service.module;
  const doc = await createCanvas();
  const actor = "11111111-1111-4111-8111-111111111111";
  const fresh = { id: "fresh", canvasId: doc.id, type: "canvasText", schemaVersion: 1, geometry: { x: 0, y: 0, width: 360, height: 260 }, entityVersion: 0, geometryVersion: 0, documentId: "doc-fresh", data: { name: "新" } };
  const command = {
    schemaVersion: 1, commandId: "00000000-0000-4000-8000-000000000001", actorId: actor, actorSeq: 1, canvasId: doc.id, storageEpoch: JSON_STORAGE_EPOCH, baseRevision: 0, kind: "batch",
    payload: { commands: [
      { kind: "add_nodes", payload: { nodes: [fresh], documents: [{ id: "doc-fresh", nodeId: "fresh", content: "x", version: 0 }] } },
      { kind: "edit_edges", payload: { add: [{ id: "e-bad", canvasId: doc.id, source: "fresh", target: "missing", role: null, version: 0 }], remove: [] } },
    ] },
  };
  await assert.rejects(executeCommand(command, { origin: "client" }));
  const saved = await loadCanvas(doc.id);
  assert.equal(saved.nodes.length, 0, "整批失败不插入部分节点");
});

test("FlowCanvas 接线：普通保存走命令；生成回写只走显式命名的兼容写入；撤销删除用新 ID 重建；正文 composition 结束才提交", async () => {
  const flow = await readFile(new URL("../components/canvas/flow-canvas.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/canvas/prompt-panel.tsx", import.meta.url), "utf8");
  assert.match(flow, /translateUserWrites\(/);
  assert.match(flow, /channel\.submitCommand\(/);
  assert.doesNotMatch(flow, /saveCanvasDraft\(/, "不再每 200ms 写完整草稿");
  assert.doesNotMatch(flow, /canvasSaveBody\(/);
  assert.match(flow, /rebuildWithNewIds\(restored/, "撤销删除用新 ID");
  assert.match(flow, /rebuildWithNewIds\(entry\.nodes/, "重做新增用新 ID");
  assert.match(panel, /onCompositionEnd=/);
  assert.match(panel, /if \(!composing\.current\) updateNodeData/);
});
