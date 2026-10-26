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
