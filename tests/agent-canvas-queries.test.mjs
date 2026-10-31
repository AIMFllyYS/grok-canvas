import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P5-03：有界画布查询（10000 节点 / 20000 边 / 100KB 正文 fixture）。
const queries = await loadTypescript("lib/agent/canvas-queries.ts");
after(() => queries.dispose());
const { summarizeCanvas, getCanvasNodes, searchCanvasNodes, readNeighborhood, readDocumentChunk, QUERY_LIMITS } = queries.module;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function fixture() {
  const nodes = [], edges = [];
  for (let i = 0; i < 10000; i++) {
    const type = i % 4 === 0 ? "canvasText" : i % 4 === 1 ? "image" : i % 4 === 2 ? "video" : "asset";
    nodes.push({ id: `n${i}`, type, position: { x: (i % 100) * 400, y: Math.floor(i / 100) * 300 }, width: 300, height: 200, data: { name: i === 42 ? "分镜三" : i === 43 ? "图" : `节点 ${i}`, prompt: i === 77 ? "'; DROP TABLE nodes; --" : `提示 ${i}`, ...(type === "canvasText" ? { content: i === 0 ? "长文".repeat(51200) : `正文 ${i}` } : {}) } });
  }
  for (let i = 0; i < 20000; i++) edges.push({ id: `e${i}`, source: `n${i % 10000}`, target: `n${(i * 7 + 1) % 10000}` });
  for (let i = 1; i <= 300; i++) edges.push({ id: `fan${i}`, source: "n5", target: `n${5 + i}` });
  return { id: "c-big", name: "大图", revision: 9, nodes, edges };
}
const canvas = fixture();

test("read_canvas 摘要：万级画布响应 ≤64KiB，最多 50 个节点，无正文全文，带类型计数与翻页", () => {
  const first = summarizeCanvas(canvas);
  assert.ok(bytes(first) <= QUERY_LIMITS.bytes, `${bytes(first)} bytes`);
  assert.equal(first.nodes.length, 50);
  assert.deepEqual(first.counts, { canvasText: 2500, image: 2500, video: 2500, asset: 2500 });
  assert.equal(first.totalEdges, 20300);
  assert.ok(first.nodes.every(n => !("content" in n)), "不含正文全文");
  assert.ok(first.nodes[0].contentPreview.length <= 81, "只有正文开头预览");
  // 固定修订下翻页无遗漏/重复。
  const seen = new Set(first.nodes.map(n => n.id));
  let cursor = first.nextCursor, pages = 1;
  while (cursor && pages < 4) { const page = summarizeCanvas(canvas, { cursor }); for (const n of page.nodes) { assert.ok(!seen.has(n.id)); seen.add(n.id); } cursor = page.nextCursor; pages++; }
  assert.equal(seen.size, 200);
});

test("游标：伪造、跨画布、换查询条件拒绝；修订变化明确要求重新查询", () => {
  const { nextCursor } = summarizeCanvas(canvas);
  assert.throws(() => summarizeCanvas(canvas, { cursor: "not-a-cursor" }), { code: "invalid_cursor" });
  assert.throws(() => summarizeCanvas({ ...canvas, id: "other" }, { cursor: nextCursor }), { code: "invalid_cursor" });
  assert.throws(() => searchCanvasNodes(canvas, { query: "节点", cursor: nextCursor }), { code: "invalid_cursor" });
  assert.throws(() => summarizeCanvas({ ...canvas, revision: 10 }, { cursor: nextCursor }), { code: "cursor_stale", message: /重新查询/ });
});

test("get_canvas_nodes：最多 50 个，正文合计 ≤32000 字符，超出给续读游标；缺失 ID 单独列出", () => {
  const result = getCanvasNodes(canvas, ["n0", "n4", "missing"]);
  const total = result.nodes.reduce((sum, n) => sum + (n.content?.length ?? 0), 0);
  assert.ok(total <= QUERY_LIMITS.detailChars);
  assert.equal(result.nodes[0].contentTruncated, true);
  assert.ok(result.nodes[0].contentCursor);
  assert.deepEqual(result.notReturned, ["missing"]);
  assert.ok(bytes(result) <= QUERY_LIMITS.bytes);
  assert.throws(() => getCanvasNodes(canvas, Array.from({ length: 51 }, (_, i) => `n${i}`)), { code: "invalid_request" });
});

test("read_document_chunk：100KB 正文每段 ≤16000 字符，按游标读完与原文一致", () => {
  const full = canvas.nodes[0].data.content;
  let cursor = getCanvasNodes(canvas, ["n0"]).nodes[0].contentCursor, text = getCanvasNodes(canvas, ["n0"]).nodes[0].content, chunks = 0;
  while (cursor) { const chunk = readDocumentChunk(canvas, { nodeId: "n0", cursor }); assert.ok(chunk.text.length <= QUERY_LIMITS.chunkChars); text += chunk.text; cursor = chunk.nextCursor; chunks++; }
  assert.equal(text, full);
  assert.ok(chunks >= 5);
  assert.equal(readDocumentChunk(canvas, { nodeId: "n0" }).documentVersion, 9);
});

test("search：中文单字与词语可检索；注入文本按字面比较；按类型过滤；结果有界", () => {
  assert.ok(searchCanvasNodes(canvas, { query: "分镜" }).nodes.some(n => n.id === "n42"));
  assert.ok(searchCanvasNodes(canvas, { query: "图" }).nodes.some(n => n.id === "n43"));
  assert.deepEqual(searchCanvasNodes(canvas, { query: "DROP TABLE" }).nodes.map(n => n.id), ["n77"]);
  const typed = searchCanvasNodes(canvas, { query: "节点", types: ["video"], limit: 20 });
  assert.equal(typed.nodes.length, 20);
  assert.ok(typed.nodes.every(n => n.type === "video"));
  assert.ok(typed.total > 2000 && typed.nextCursor);
  const region = searchCanvasNodes(canvas, { region: { x: 0, y: 0, width: 800, height: 300 } });
  assert.deepEqual(region.nodes.map(n => n.id).sort(), ["n0", "n1"]);
});

test("neighborhood：方向明确；高出度节点分页有界", () => {
  const down = readNeighborhood(canvas, { nodeId: "n5", direction: "downstream" });
  assert.equal(down.neighbors.length, 50);
  assert.ok(down.total >= 300 && down.nextCursor);
  assert.ok(down.neighbors.every(n => n.direction === "downstream"));
  assert.ok(bytes(down) <= QUERY_LIMITS.bytes);
  const up = readNeighborhood(canvas, { nodeId: "n1", direction: "upstream" });
  assert.ok(up.neighbors.every(n => n.direction === "upstream"));
  assert.throws(() => readNeighborhood(canvas, { nodeId: "nope" }), { code: "not_found" });
});
