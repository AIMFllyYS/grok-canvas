import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const data = await mkdtemp(path.join(os.tmpdir(), "canvas-agent-"));
const previous = process.env.GROK_CANVAS_DATA_DIR;
process.env.GROK_CANVAS_DATA_DIR = data;
const store = await loadTypescript("lib/agent/store.ts", { packages: true });
const canvas = await loadTypescript("lib/agent/canvas.ts", { packages: true });
const cleanup = await loadTypescript("lib/canvas-cleanup.ts", {
  packages: true,
});
const conversations = await loadTypescript("lib/agent/conversations.ts", {
  packages: true,
});
const generation = await loadTypescript("lib/agent/generation.ts", {
  packages: true,
});
after(async () => {
  if (previous === undefined) delete process.env.GROK_CANVAS_DATA_DIR;
  else process.env.GROK_CANVAS_DATA_DIR = previous;
  await Promise.all([
    store.dispose(),
    canvas.dispose(),
    cleanup.dispose(),
    conversations.dispose(),
    generation.dispose(),
  ]);
  await rm(data, { recursive: true, force: true });
});
test("Agent first-frame requests follow the source ratio while text-to-video retains the chosen ratio", () => {
  const source = { id: "i", type: "image", data: { assetName: "source.png" } },
    node = {
      id: "v",
      type: "video",
      data: {
        prompt: "still cup",
        aspectRatio: "16:9",
        duration: 6,
        resolution: "720p",
        audio: false,
      },
    };
  const linked = generation.module.canvasVideoBody("test", node, {
    nodes: [source, node],
    edges: [{ source: "i", target: "v", data: { role: "first" } }],
  });
  assert.equal(linked.parameters.aspectRatio, null);
  assert.equal(linked.inputs[0].role, "first");
  const plain = generation.module.canvasVideoBody("test", node, {
    nodes: [node],
    edges: [],
  });
  assert.equal(plain.parameters.aspectRatio, "16:9");
  assert.deepEqual(plain.inputs, []);
});
test("Agent stores conversations directly by canvas and serializes concurrent updates", async () => {
  const first = await store.module.updateAgent("default");
  assert.equal(first.canvasId, "default");
  assert.equal(first.conversations.length, 1);
  assert.equal("script" in first, false);
  await Promise.all(
    Array.from({ length: 5 }, () =>
      store.module.updateAgent("default", (p) => {
        conversations.module.newConversation(p);
      }),
    ),
  );
  const next = await store.module.updateAgent("default");
  assert.equal(next.conversations.length, 6);
  assert.equal(new Set(next.conversations.map((c) => c.id)).size, 6);
  const unlock = store.module.acquireAgent("default");
  assert.throws(() => store.module.acquireAgent("default"), /正在执行/);
  unlock();
  assert.equal(store.module.agentBusy("default"), false);
});
test("Canvas edits preserve the document on invalid links and add only image/video nodes", () => {
  const c = { nodes: [], edges: [] };
  canvas.module.addNodes(c, [
    { type: "image", name: "参考", prompt: "paper" },
    { type: "video", name: "视频", prompt: "slow pan" },
  ]);
  assert.deepEqual(
    c.nodes.map((n) => n.type),
    ["image", "video"],
  );
  assert.notDeepEqual(c.nodes[0].position, c.nodes[1].position);
  const before = structuredClone(c);
  assert.throws(
    () =>
      canvas.module.editNodes(c, {
        updates: [{ id: c.nodes[0].id, name: "changed" }],
        remove: [],
        connect: [{ source: c.nodes[1].id, target: c.nodes[0].id }],
        disconnect: [],
      }),
    /连线端点/,
  );
  assert.deepEqual(c, before);
  canvas.module.editNodes(c, {
    updates: [],
    remove: [],
    connect: [{ source: c.nodes[0].id, target: c.nodes[1].id, role: "first" }],
    disconnect: [],
  });
  assert.equal(c.edges.length, 1);
});
test("Retired canvas records disappear without losing media nodes or unrelated image links", () => {
  const c = {
    nodes: [
      {
        id: "i",
        type: "image",
        data: { assetName: "a.png", studioProjectId: "old" },
      },
      { id: "v", type: "video", data: { assetName: "v.mp4" } },
      { id: "t", type: "text" },
      { id: "w", type: "workflow" },
    ],
    edges: [
      { source: "i", target: "v" },
      { source: "t", target: "i" },
    ],
  };
  const result = cleanup.module.cleanCanvas(c);
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    ["i", "v"],
  );
  assert.equal(result.nodes[0].data.assetName, "a.png");
  assert.equal("studioProjectId" in result.nodes[0].data, false);
  assert.equal(result.edges.length, 1);
  assert.equal(c.nodes.length, 4);
});

test("Text nodes retain content and dimensions, avoid occupied space, and connect without becoming media references", () => {
  const c = { nodes: [{ id: "large", type: "image", position: { x: 0, y: 0 }, width: 900, height: 600, data: { name: "image" } },
    { id: "video", type: "video", position: { x: 1500, y: 0 }, data: { name: "video" } },
    { id: "asset", type: "asset", position: { x: 2000, y: 0 }, data: { name: "asset", assetName: "a.png" } }], edges: [] };
  const [text, second] = canvas.module.addNodes(c, [
    { type: "canvasText", name: "脚本一", prompt: "", content: "# 第一幕\n内容", width: 500, height: 400 },
    { type: "canvasText", name: "脚本二", prompt: "", content: "第二幕", width: 400, height: 300 },
  ]);
  assert.ok(text.position.x >= 924 || text.position.y >= 624 || text.position.x + 524 <= 0 || text.position.y + 424 <= 0);
  assert.notDeepEqual(text.position, second.position);
  const pairs = [[text.id, "large"], ["large", text.id], [text.id, "video"], ["video", text.id], [text.id, "asset"], ["asset", text.id], [text.id, second.id]];
  canvas.module.editNodes(c, { updates: [{ id: text.id, content: "## 更新", width: 640, height: 420 }], remove: [], connect: pairs.map(([source, target]) => ({ source, target })), disconnect: [] });
  assert.equal(text.id, c.nodes.find(n => n.id === text.id).id);
  const updated = c.nodes.find(n => n.id === text.id);
  assert.deepEqual([updated.data.content, updated.width, updated.height], ["## 更新", 560, 420]);
  assert.equal(c.edges.length, pairs.length);
  assert.deepEqual(generation.module.canvasVideoBody("test", c.nodes.find(n => n.id === "video"), c).inputs, []);
  const cleaned = cleanup.module.cleanCanvas(c);
  assert.equal(cleaned.nodes.find(n => n.id === text.id).data.content, "## 更新");
  assert.equal(cleaned.edges.length, pairs.length);
});

test("Agent text sizing is bounded without changing user-sized dimensions on content edits", () => {
  const c = { nodes: [], edges: [] };
  const [node] = canvas.module.addNodes(c, [{ type: "canvasText", prompt: "", content: "原文", width: 900, height: 2000 }]);
  assert.deepEqual([node.data.name, node.width, node.height], ["文稿", 560, 1120]);
  node.width = 900;
  node.height = 1500;
  const edit = updates => canvas.module.editNodes(c, { updates, remove: [], connect: [], disconnect: [] });
  edit([{ id: node.id, content: "更新", x: 100 }]);
  assert.deepEqual([c.nodes[0].width, c.nodes[0].height, c.nodes[0].data.content], [900, 1500, "更新"]);
  edit([{ id: node.id, width: 800 }]);
  assert.deepEqual([c.nodes[0].width, c.nodes[0].height], [560, 1500]);
  edit([{ id: node.id, height: 2000 }]);
  assert.deepEqual([c.nodes[0].width, c.nodes[0].height], [560, 1120]);
  edit([{ id: node.id, width: 480, height: 800 }]);
  assert.deepEqual([c.nodes[0].width, c.nodes[0].height], [480, 800]);
});
