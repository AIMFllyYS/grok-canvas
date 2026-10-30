import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const loaded = await loadTypescript("lib/canvas-runtime/command-schema.ts", { packages: true });
after(loaded.dispose);
const { parseCommand, canonicalCommand, canonicalJson, assertClientCommand, CommandValidationError, LIMITS } = loaded.module;
const registryModule = await loadTypescript("lib/canvas-runtime/node-registry.ts", { packages: true });
after(registryModule.dispose);
const { NODE_REGISTRY, getNodeType, validateNodeData, validateNodePatch, validateNodeGeometry, clampAgentTextSize, TEXT_GEOMETRY, fieldAccess } = registryModule.module;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const geometry = (x = 0, y = 0, width = 280, height = 240) => ({ x, y, width, height });
const envelope = (kind, payload, extra = {}) => ({
  schemaVersion: 1, commandId: uuid(1), actorId: uuid(2), actorSeq: 1,
  canvasId: "default", storageEpoch: "epoch-1", baseRevision: 0, kind, payload, ...extra,
});
const move = (count, id = (i) => `n${i}`) => envelope("move_nodes", {
  items: Array.from({ length: count }, (_, i) => ({ nodeId: id(i), expectedVersion: 0, from: geometry(), to: geometry(i, i) })),
});
const rejects = (input, pattern, status = 400) => {
  assert.throws(() => parseCommand(input), (error) => {
    assert.ok(error instanceof CommandValidationError, `expected CommandValidationError, got ${error}`);
    assert.equal(error.code, "invalid_command");
    assert.equal(error.status, status);
    if (pattern) assert.match(`${error.message} ${JSON.stringify(error.fields ?? [])}`, pattern);
    return true;
  });
};
const textNode = (id, extra = {}) => ({
  id, canvasId: "default", type: "canvasText", schemaVersion: 1, geometry: geometry(0, 0, 360, 260),
  entityVersion: 0, geometryVersion: 0, documentId: `doc-${id}`, data: { name: "文本" }, ...extra,
});
const textDoc = (id, content = "") => ({ id: `doc-${id}`, nodeId: id, content, version: 0 });

test("move_nodes 需要 1..10000 项，且组内 nodeId 唯一", () => {
  rejects({ kind: "move_nodes", payload: { items: [] } });
  rejects(move(0));
  const one = parseCommand(move(1));
  assert.equal(one.kind, "move_nodes");
  assert.equal(one.payload.items.length, 1);
  assert.equal(parseCommand(move(LIMITS.moveItems)).payload.items.length, 10000);
  rejects(move(10001));
  rejects(move(2, () => "same"), /重复/);
});

test("几何必须是有限数字并在边界内", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const input = move(1);
    input.payload.items[0].to.x = bad;
    rejects(input);
    const from = move(1);
    from.payload.items[0].from.height = bad;
    rejects(from);
  }
  const far = move(1);
  far.payload.items[0].to.x = 1e9;
  assert.equal(parseCommand(far).payload.items[0].to.x, 1e9);
  far.payload.items[0].to.x = 1e9 + 1;
  rejects(far);
  for (const [w, h] of [[0, 10], [10, -1], [1e6 + 1, 10]]) {
    const sized = move(1);
    sized.payload.items[0].to.width = w;
    sized.payload.items[0].to.height = h;
    rejects(sized);
  }
});

test("信封：schemaVersion 只允许 1，版本和序号必须是整数", () => {
  rejects({ ...move(1), schemaVersion: 2 }, /schemaVersion/);
  rejects({ ...move(1), actorSeq: 0 });
  rejects({ ...move(1), actorSeq: 1.5 });
  rejects({ ...move(1), baseRevision: -1 });
  rejects({ ...move(1), commandId: "not-a-uuid" });
  rejects({ ...move(1), extra: true });
  const version = move(1);
  version.payload.items[0].expectedVersion = 0.5;
  rejects(version);
  rejects({ ...move(1), kind: "unknown_kind" });
  rejects("not an object");
  rejects(null);
});

test("通用 JSON 预检拒绝原型污染、undefined、函数和循环", () => {
  const polluted = JSON.parse(`{"schemaVersion":1,"commandId":"${uuid(1)}","actorId":"${uuid(2)}","actorSeq":1,"canvasId":"default","storageEpoch":"e","baseRevision":0,"kind":"rename_canvas","payload":{"expectedVersion":0,"name":"x","__proto__":{"admin":true}}}`);
  rejects(polluted, /__proto__/);
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: "x", constructor: 1 }), /constructor/);
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: undefined }));
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: () => "x" }));
  const cyclic = envelope("rename_canvas", { expectedVersion: 0, name: "x" });
  cyclic.payload.self = cyclic;
  rejects(cyclic, /循环/);
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: "x", when: new Date() }));
});

test("patch_nodes 只接受注册表里的用户字段", () => {
  const patch = (field, value, nodeId = "n1") => envelope("patch_nodes", { items: [{ nodeId, field, expectedVersion: 0, value }] });
  assert.equal(parseCommand(patch("prompt", "一只猫")).payload.items[0].value, "一只猫");
  assert.equal(parseCommand(patch("content", "# 正文")).payload.items[0].field, "content");
  assert.equal(parseCommand(patch("pinned", true)).payload.items[0].value, true);
  rejects(patch("generationClaims", {}), /generationClaims/);
  rejects(patch("status", "running"), /status/);
  rejects(patch("results", []), /results/);
  rejects(patch("__proto__", {}));
  rejects(patch("data.prompt", "x"));
  rejects(patch("prompt", 42));
  const twice = patch("prompt", "a");
  twice.payload.items.push({ ...twice.payload.items[0], value: "b" });
  rejects(twice, /重复/);
  const twoFields = patch("prompt", "a");
  twoFields.payload.items.push({ nodeId: "n1", field: "name", expectedVersion: 0, value: "b" });
  assert.equal(parseCommand(twoFields).payload.items.length, 2);
  const many = envelope("patch_nodes", { items: Array.from({ length: 1001 }, (_, i) => ({ nodeId: `n${i}`, field: "name", expectedVersion: 0, value: "x" })) });
  rejects(many);
});

test("正文 100000 字符接受、100001 报 413；prompt 上限 12000", () => {
  const patch = (field, value) => envelope("patch_nodes", { items: [{ nodeId: "n1", field, expectedVersion: 0, value }] });
  assert.equal(parseCommand(patch("content", "a".repeat(100000))).payload.items[0].value.length, 100000);
  rejects(patch("content", "a".repeat(100001)), /100000/, 413);
  assert.equal(parseCommand(patch("prompt", "p".repeat(12000))).payload.items[0].value.length, 12000);
  rejects(patch("prompt", "p".repeat(12001)), /12000/, 413);
  const add = envelope("add_nodes", { nodes: [textNode("t1")], documents: [textDoc("t1", "b".repeat(100001))] });
  rejects(add, /100000/, 413);
});

test("add_nodes 校验类型、几何、文档归属和初始版本", () => {
  const ok = parseCommand(envelope("add_nodes", { nodes: [textNode("t1")], documents: [textDoc("t1", "hi")] }));
  assert.equal(ok.payload.nodes[0].type, "canvasText");
  const image = { id: "i1", canvasId: "default", type: "image", schemaVersion: 1, geometry: geometry(), entityVersion: 0, geometryVersion: 0, documentId: null, data: { name: "图片", prompt: "", status: "idle", aspectRatio: "auto", resolution: "1k", quality: "low", generationCount: 1, uploadAttachments: [] } };
  assert.equal(parseCommand(envelope("add_nodes", { nodes: [image], documents: [] })).payload.nodes[0].id, "i1");
  rejects(envelope("add_nodes", { nodes: [{ ...image, type: "mystery" }], documents: [] }), /mystery|类型/);
  rejects(envelope("add_nodes", { nodes: [{ ...image, data: { ...image.data, studioProjectId: "x" } }], documents: [] }), /studioProjectId/);
  rejects(envelope("add_nodes", { nodes: [{ ...image, entityVersion: 3 }], documents: [] }));
  rejects(envelope("add_nodes", { nodes: [{ ...image, schemaVersion: 2 }], documents: [] }));
  rejects(envelope("add_nodes", { nodes: [image, image], documents: [] }), /重复/);
  rejects(envelope("add_nodes", { nodes: [textNode("t1")], documents: [] }), /文档|document/);
  rejects(envelope("add_nodes", { nodes: [textNode("t1")], documents: [{ ...textDoc("t1"), nodeId: "other" }] }), /文档|document/);
  rejects(envelope("add_nodes", { nodes: [{ ...image, documentId: "doc-x" }], documents: [] }), /文档|document/);
  rejects(envelope("add_nodes", { nodes: [], documents: [] }));
  rejects(envelope("add_nodes", { nodes: [textNode("t1", { geometry: geometry(0, 0, 3001, 200) })], documents: [textDoc("t1")] }), /3000|文本/);
  rejects(envelope("add_nodes", { nodes: [{ ...image, id: "__proto__" }], documents: [] }));
});

test("其余命令类型的精确形状", () => {
  assert.equal(parseCommand(envelope("delete_nodes", { items: [{ nodeId: "n1", expectedEntityVersion: 2 }] })).kind, "delete_nodes");
  rejects(envelope("delete_nodes", { items: [{ nodeId: "n1", expectedEntityVersion: 2 }, { nodeId: "n1", expectedEntityVersion: 2 }] }), /重复/);
  const edge = { id: "e1", canvasId: "default", source: "a", target: "b", role: "reference", version: 0 };
  assert.equal(parseCommand(envelope("edit_edges", { add: [edge], remove: [{ edgeId: "e2", expectedVersion: 1 }] })).payload.add[0].role, "reference");
  rejects(envelope("edit_edges", { add: [], remove: [] }));
  rejects(envelope("edit_edges", { add: [{ ...edge, target: "a" }], remove: [] }), /自身|端点/);
  rejects(envelope("edit_edges", { add: [{ ...edge, role: "middle" }], remove: [] }));
  rejects(envelope("edit_edges", { add: [edge], remove: [{ edgeId: "e1", expectedVersion: 0 }] }), /重复/);
  assert.equal(parseCommand(envelope("register_assets", { assets: [{ assetName: "a1.png", kind: "image", createdAt: "2026-10-30T00:00:00.000Z" }] })).kind, "register_assets");
  rejects(envelope("register_assets", { assets: [{ assetName: "../etc/passwd", kind: "image", createdAt: "2026-10-30T00:00:00.000Z" }] }));
  rejects(envelope("register_assets", { assets: [{ assetName: "a1.png", kind: "image", createdAt: "yesterday" }] }));
  assert.equal(parseCommand(envelope("rename_canvas", { expectedVersion: 0, name: "名".repeat(160) })).payload.name.length, 160);
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: "名".repeat(161) }));
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: "" }));
  rejects(envelope("rename_canvas", { expectedVersion: 0, name: "x", viewport: { x: 0, y: 0, zoom: 1 } }));
  const generation = envelope("apply_generation", { nodeId: "n1", generationId: "g1", claimId: "c1", assets: [{ assetName: "a1.png", kind: "image", createdAt: "2026-10-30T00:00:00.000Z" }], patch: { status: "idle", results: [] } });
  assert.equal(parseCommand(generation).kind, "apply_generation");
  rejects({ ...generation, payload: { ...generation.payload, patch: { generationClaims: {} } } }, /generationClaims/);
});

test("batch 1..100，不允许嵌套，内部命令同样严格", () => {
  const inner = { kind: "rename_canvas", payload: { expectedVersion: 0, name: "x" } };
  assert.equal(parseCommand(envelope("batch", { commands: [inner, move(1)].map(c => ({ kind: c.kind, payload: c.payload })) })).payload.commands.length, 2);
  rejects(envelope("batch", { commands: [] }));
  rejects(envelope("batch", { commands: Array.from({ length: 101 }, () => inner) }));
  rejects(envelope("batch", { commands: [{ kind: "batch", payload: { commands: [inner] } }] }), /嵌套|batch/);
  rejects(envelope("batch", { commands: [{ kind: "move_nodes", payload: { items: [] } }] }));
  rejects(envelope("batch", { commands: [{ ...inner, commandId: uuid(9) }] }));
});

test("通用客户端不能提交内部命令", () => {
  const generation = parseCommand(envelope("apply_generation", { nodeId: "n1", generationId: "g1", claimId: "c1", assets: [], patch: { status: "idle" } }));
  assert.throws(() => assertClientCommand(generation), CommandValidationError);
  const hidden = parseCommand(envelope("batch", { commands: [{ kind: "apply_generation", payload: generation.payload }] }));
  assert.throws(() => assertClientCommand(hidden), CommandValidationError);
  assert.doesNotThrow(() => assertClientCommand(parseCommand(move(1))));
});

test("规范化 JSON：对象键排序、数组保序，可区分顺序", () => {
  const a = parseCommand(move(2));
  const reordered = JSON.parse(JSON.stringify(a));
  const b = Object.fromEntries(Object.entries(reordered).reverse());
  b.payload.items = b.payload.items.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal(canonicalCommand(parseCommand(b)), canonicalCommand(a));
  const swapped = parseCommand({ ...a, payload: { items: [...a.payload.items].reverse() } });
  assert.notEqual(canonicalCommand(swapped), canonicalCommand(a));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  assert.equal(JSON.parse(canonicalCommand(a)).payload.items.length, 2);
});

test("解析结果与输入解耦，不保留调用方引用", () => {
  const input = move(1);
  const parsed = parseCommand(input);
  input.payload.items[0].to.x = 999;
  assert.equal(parsed.payload.items[0].to.x, 0);
});

test("节点注册表固定四类，未知类型不会被当成 image", () => {
  assert.deepEqual(Object.keys(NODE_REGISTRY).sort(), ["asset", "canvasText", "image", "video"]);
  for (const entry of Object.values(NODE_REGISTRY)) {
    assert.equal(entry.schemaVersion, 1);
    assert.equal(typeof entry.validate, "function");
    assert.equal(typeof entry.migrate, "function");
  }
  assert.equal(getNodeType("mystery"), null);
  assert.throws(() => validateNodeData("mystery", { name: "x" }), /未知节点类型/);
  assert.equal(fieldAccess("image", "prompt"), "user");
  assert.equal(fieldAccess("image", "status"), "service");
  assert.equal(fieldAccess("image", "duration"), "legacy");
  assert.equal(fieldAccess("video", "quality"), "legacy");
  assert.equal(fieldAccess("canvasText", "prompt"), null);
  assert.equal(fieldAccess("asset", "assetName"), "service");
});

test("注册表按节点类型精确校验字段值", () => {
  assert.doesNotThrow(() => validateNodeData("image", { name: "图片", aspectRatio: "2:1", resolution: "2k", results: [{ id: "r", assetName: "a.png", status: "success" }] }));
  assert.throws(() => validateNodeData("image", { name: "图片", resolution: "720p" }));
  assert.doesNotThrow(() => validateNodeData("video", { name: "视频", resolution: "720p", duration: 10, aspectRatio: null }));
  assert.throws(() => validateNodeData("video", { name: "视频", duration: 7 }));
  assert.throws(() => validateNodeData("asset", { name: "素材" }), /assetName/);
  assert.throws(() => validateNodeData("canvasText", { name: "文本", content: "正文属于 DocumentRecord" }), /content/);
  assert.doesNotThrow(() => validateNodePatch("video", { prompt: "x", aspectRatio: "9:16" }, "user"));
  assert.throws(() => validateNodePatch("video", { status: "idle" }, "user"), /status/);
  assert.doesNotThrow(() => validateNodePatch("video", { status: "idle", taskId: "t" }, "service"));
  assert.throws(() => validateNodePatch("image", { duration: 6 }, "user"), /duration/);
  assert.throws(() => validateNodePatch("asset", { prompt: "x" }, "user"), /prompt/);
});

test("Agent addNodes 历史写入的跨类型默认字段仍被接受", () => {
  const legacyImage = { name: "图片", prompt: "p", status: "idle", assetName: null, aspectRatio: "16:9", resolution: "1k", quality: "low", generationCount: 1, duration: 6, audio: false, uploadAttachments: [], uploadInputs: [] };
  assert.doesNotThrow(() => validateNodeData("image", legacyImage));
  assert.doesNotThrow(() => validateNodeData("video", { ...legacyImage, resolution: "720p" }));
});

test("粘贴副本写入文本/素材节点的生成状态字段作为旧数据接受，但不可 patch", () => {
  const pasted = { status: "idle", generationId: null, appliedGenerationId: null, errorMessage: null };
  assert.doesNotThrow(() => validateNodeData("canvasText", { name: "文本", ...pasted }));
  assert.doesNotThrow(() => validateNodeData("asset", { name: "素材", assetName: "a.png", ...pasted }));
  assert.equal(fieldAccess("canvasText", "status"), "legacy");
  assert.throws(() => validateNodePatch("canvasText", { status: "idle" }, "service"), /status/);
  assert.throws(() => validateNodeData("canvasText", { name: "文本", status: "running?" }));
});

test("文本几何与旧行为一致：用户 200x120..3000x3000，Agent 上限 560x1120", async () => {
  assert.deepEqual(TEXT_GEOMETRY, { minWidth: 200, minHeight: 120, maxWidth: 3000, maxHeight: 3000, agentMaxWidth: 560, agentMaxHeight: 1120 });
  const agentSource = await readFile(new URL("../lib/agent/canvas.ts", import.meta.url), "utf8");
  assert.match(agentSource, /AGENT_TEXT_MAX_WIDTH = 560;/);
  assert.match(agentSource, /AGENT_TEXT_MAX_HEIGHT = 1120;/);
  const textSource = await readFile(new URL("../components/canvas/text-node.tsx", import.meta.url), "utf8");
  assert.match(textSource, /minWidth=\{200\} minHeight=\{120\} maxWidth=\{3000\} maxHeight=\{3000\}/);
  assert.deepEqual(clampAgentTextSize({ width: 900, height: 2000 }), { width: 560, height: 1120 });
  assert.deepEqual(clampAgentTextSize({ width: 480, height: 800 }), { width: 480, height: 800 });
  assert.deepEqual(clampAgentTextSize({}, { width: 900, height: 1500 }), { width: 900, height: 1500 });
  assert.deepEqual(clampAgentTextSize({ width: 800 }, { width: 900, height: 1500 }), { width: 560, height: 1500 });
  assert.doesNotThrow(() => validateNodeGeometry("canvasText", geometry(0, 0, 3000, 3000)));
  assert.throws(() => validateNodeGeometry("canvasText", geometry(0, 0, 3001, 300)), /3000/);
  assert.doesNotThrow(() => validateNodeGeometry("image", geometry(0, 0, 5000, 5000)));
});

test("新增测试已登记进 pnpm test", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:commands"], /tests\/command-schema\.test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:commands/);
});


test("契约模块可在浏览器使用：不在运行时导入 node: 内置模块或服务端存储", async () => {
  for (const file of ["types.ts", "node-registry.ts", "command-schema.ts"]) {
    const source = await readFile(new URL(`../lib/canvas-runtime/${file}`, import.meta.url), "utf8");
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]);
    for (const specifier of runtimeImports) {
      assert.ok(!specifier.startsWith("node:"), `${file} 运行时导入了 ${specifier}`);
      assert.ok(!/canvas-store|data-dir/.test(specifier), `${file} 运行时导入了服务端模块 ${specifier}`);
    }
  }
});
