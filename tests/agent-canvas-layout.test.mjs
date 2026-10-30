import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-agent-layout-"));
process.env.GROK_CANVAS_DATA_DIR = dataDir;

const placement = await loadTypescript("lib/node-placement.ts");
const canvas = await loadTypescript("lib/agent/canvas.ts", { packages: true });
const summary = await loadTypescript("components/ai-elements/tool-summary.ts");
const agent = await loadTypescript("lib/agent/agent.ts", { packages: true });
const store = await loadTypescript("lib/canvas-store.ts");
after(async () => { for (const loaded of [placement, canvas, summary, agent, store]) await loaded.dispose(); await rm(dataDir, { recursive: true, force: true }); });
const { layoutFlowNodes, flowNodeSize, FLOW_TITLE_SPACE } = placement.module;

const text = (id, height = 260, extra = {}) => ({ id, type: "canvasText", position: { x: 0, y: 0 }, width: 360, height, data: { name: id, content: "" }, ...extra });
const image = (id, extra = {}) => ({ id, type: "image", position: { x: 0, y: 0 }, data: { name: id, aspectRatio: "16:9", assetName: null }, ...extra });
const video = (id, extra = {}) => ({ id, type: "video", position: { x: 0, y: 0 }, data: { name: id, aspectRatio: "16:9", assetName: null }, ...extra });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const rect = (node, at) => ({ ...(at ?? node.position), ...flowNodeSize(node) });
const center = r => r.y + r.height / 2;
/** 含标题条的占地，两两不相交。 */
function assertNoOverlap(rects) {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y - FLOW_TITLE_SPACE < b.y + b.height && a.y + a.height > b.y - FLOW_TITLE_SPACE;
      assert.equal(overlap, false, `重叠：${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
}
/** 相邻列间的直线段两两不交叉（贝塞尔曲线在同一对列之间的顺序与直线一致）。 */
function crossings(edges, rects) {
  let count = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [a1, a2, b1, b2] = [rects[edges[i].source], rects[edges[i].target], rects[edges[j].source], rects[edges[j].target]];
      if (a1.x !== b1.x || a2.x !== b2.x) continue;
      if ((center(a1) - center(b1)) * (center(a2) - center(b2)) < 0) count++;
    }
  return count;
}

test("流程布局：大纲 → 脚本 → 三个镜头 → 成片 排成从左到右的整齐列，下游居中对齐上游", () => {
  const nodes = [text("outline", 300), text("script", 420), image("s1"), image("s2"), image("s3"), video("final")];
  const edges = [edge("outline", "script"), edge("script", "s1"), edge("script", "s2"), edge("script", "s3"), edge("s1", "final"), edge("s2", "final"), edge("s3", "final")];
  const placed = layoutFlowNodes({ nodes, edges }, nodes, { mode: "append" });
  const r = Object.fromEntries(nodes.map(n => [n.id, rect(n, placed.get(n.id))]));
  // 每条连线都从左列指向右列，且留有连线空间。
  for (const e of edges) assert.ok(r[e.source].x + r[e.source].width + 150 <= r[e.target].x, `${e.source}→${e.target} 未向右`);
  // 同列左对齐、竖向等距。
  assert.equal(new Set(["s1", "s2", "s3"].map(id => r[id].x)).size, 1);
  const gaps = [r.s2.y - (r.s1.y + r.s1.height), r.s3.y - (r.s2.y + r.s2.height)];
  assert.equal(gaps[0], gaps[1]);
  assert.ok(gaps[0] >= FLOW_TITLE_SPACE + 40);
  // 居中：脚本对齐大纲；三镜头整体对齐脚本；成片对齐中间镜头。
  assert.ok(Math.abs(center(r.script) - center(r.outline)) <= 1);
  assert.ok(Math.abs((center(r.s1) + center(r.s3)) / 2 - center(r.script)) <= 1);
  assert.ok(Math.abs(center(r.final) - center(r.s2)) <= 1);
  assertNoOverlap(Object.values(r));
  assert.equal(crossings(edges, r), 0);
});

test("分叉后汇合时同列按上游顺序排列，连线不交叉", () => {
  const nodes = [text("a"), text("b"), image("a1"), image("a2"), image("b1"), image("b2"), video("v")];
  const edges = [edge("a", "a1"), edge("a", "a2"), edge("b", "b1"), edge("b", "b2"), edge("a2", "v"), edge("b1", "v")];
  // 故意打乱输入顺序：b 的下游排在前面。
  const order = [nodes[0], nodes[1], nodes[4], nodes[5], nodes[2], nodes[3], nodes[6]];
  const placed = layoutFlowNodes({ nodes: order, edges }, order, { mode: "append" });
  const r = Object.fromEntries(order.map(n => [n.id, rect(n, placed.get(n.id))]));
  assert.ok(r.a1.y < r.a2.y && r.a2.y < r.b1.y && r.b1.y < r.b2.y);
  assertNoOverlap(Object.values(r));
  assert.equal(crossings(edges, r), 0);
});

test("接在已有节点后：放在上游右侧并避让挡路的用户节点，不移动已有节点", () => {
  const script = text("script", 400, { position: { x: 100, y: 200 } });
  const blocker = image("user-photo", { position: { x: 700, y: 250 }, data: { name: "用户照片", aspectRatio: "1:1", assetName: "p.png" } });
  const nodes = [script, blocker];
  const fresh = [image("s1"), image("s2")];
  const placed = layoutFlowNodes({ nodes: [...nodes, ...fresh], edges: [edge("script", "s1"), edge("script", "s2")] }, fresh, { mode: "append" });
  const r = fresh.map(n => rect(n, placed.get(n.id)));
  for (const item of r) assert.ok(item.x >= script.position.x + 360 + 150);
  assertNoOverlap([rect(script), rect(blocker), ...r]);
  assert.deepEqual(blocker.position, { x: 700, y: 250 });
  assert.equal(placed.has("script"), false);
});

test("没有上游的新流程放在已有内容下方左对齐；比例决定媒体卡片尺寸", () => {
  const existing = [text("old", 300, { position: { x: -200, y: 50 } }), image("old-image", { position: { x: 400, y: 600 } })];
  const fresh = [text("idea")];
  const placed = layoutFlowNodes({ nodes: [...existing, ...fresh], edges: [] }, fresh, { mode: "append" });
  const at = placed.get("idea");
  assert.equal(at.x, -200);
  assert.ok(at.y > 600 + flowNodeSize(existing[1]).height + FLOW_TITLE_SPACE);
  assert.deepEqual(flowNodeSize(image("w")), { width: 280, height: 158 });
  assert.deepEqual(flowNodeSize(image("p", { data: { aspectRatio: "9:16" } })), { width: 158, height: 280 });
  assert.deepEqual(flowNodeSize(image("auto", { data: { aspectRatio: "auto" } })), { width: 240, height: 240 });
  assert.deepEqual(flowNodeSize(video("v", { data: { aspectRatio: null } })), { width: 280, height: 158 });
});

test("Agent 新增节点：ref/from 同时建线并按流程排版；非法连线与未知上游在写入前拒绝", () => {
  const c = { nodes: [text("brief", 260, { position: { x: 0, y: 0 } })], edges: [] };
  const plan = canvas.module.planAgentNodes(c, [
    { type: "canvasText", name: "分镜脚本", prompt: "", content: "## 分镜", ref: "script", from: ["brief"] },
    { type: "image", name: "镜头一", prompt: "a", ref: "s1", from: ["script"] },
    { type: "image", name: "镜头二", prompt: "b", ref: "s2", from: ["script"] },
    { type: "video", name: "成片", prompt: "c", from: ["s1", "s2"] },
  ]);
  const [script, s1, s2, final] = plan.nodes;
  assert.deepEqual(plan.links.map(l => [l.source, l.target]), [["brief", script.id], [script.id, s1.id], [script.id, s2.id], [s1.id, final.id], [s2.id, final.id]]);
  assert.ok(script.position.x > 360 && s1.position.x > script.position.x + 360 && final.position.x > s1.position.x + 280);
  assert.equal(s1.position.x, s2.position.x);
  assert.equal(c.nodes.length, 1, "plan 不修改原画布");
  assert.throws(() => canvas.module.planAgentNodes(c, [{ type: "video", prompt: "", ref: "v" }, { type: "image", prompt: "", from: ["v"] }]), /连线端点无效/);
  assert.throws(() => canvas.module.planAgentNodes(c, [{ type: "image", prompt: "", from: ["missing"] }]), /上游节点不存在/);
  assert.throws(() => canvas.module.planAgentNodes(c, [{ type: "image", prompt: "", ref: "x" }, { type: "image", prompt: "", ref: "x" }]), /ref 重复/);
  // 显式坐标且没有上游：按坐标就近避让（用户指定位置时）。
  const [pinned] = canvas.module.planAgentNodes(c, [{ type: "image", prompt: "", x: 2000, y: 900 }]).nodes;
  assert.deepEqual(pinned.position, { x: 2000, y: 900 });
  // addNodes（本地副本）同时写入节点与连线。
  const local = { nodes: [], edges: [] };
  canvas.module.addNodes(local, [{ type: "canvasText", prompt: "", ref: "t" }, { type: "image", prompt: "", from: ["t"] }]);
  assert.equal(local.nodes.length, 2);
  assert.equal(local.edges.length, 1);
});

test("整理布局只移动指定节点，以起点列为锚；生成中的节点不动", () => {
  const nodes = [
    text("outline", 300, { position: { x: 0, y: 0 } }),
    text("script", 420, { position: { x: 640, y: 0 } }),
    image("s1", { position: { x: 0, y: 560 } }),
    image("s2", { position: { x: -640, y: 0 } }),
    image("s3", { position: { x: 0, y: -560 } }),
    video("final", { position: { x: 640, y: 560 } }),
    image("running", { position: { x: 5000, y: 5000 }, data: { name: "生成中", aspectRatio: "16:9", status: "running" } }),
    image("user", { position: { x: 3000, y: -3000 } }),
  ];
  const edges = [edge("outline", "script"), edge("script", "s1"), edge("script", "s2"), edge("script", "s3"), edge("s1", "final"), edge("s2", "final"), edge("s3", "final")];
  const c = { nodes, edges };
  const moves = canvas.module.planArrangement(c, ["outline", "script", "s1", "s2", "s3", "final", "running"]);
  const moved = new Map(moves.map(m => [m.id, m]));
  assert.equal(moved.has("running"), false);
  assert.equal(moved.has("user"), false);
  const at = id => moved.get(id) ?? nodes.find(n => n.id === id).position;
  assert.deepEqual(at("outline"), { x: 0, y: 0 });
  const r = Object.fromEntries(nodes.map(n => [n.id, rect(n, at(n.id))]));
  for (const e of edges) assert.ok(r[e.source].x + r[e.source].width < r[e.target].x);
  assertNoOverlap(Object.values(r));
  assert.equal(crossings(edges, r), 0);
  assert.throws(() => canvas.module.planArrangement(c, ["nope"]), /节点不存在/);
});

test("工具行摘要显示节点名而非 ID，展开详情截断长正文", () => {
  const { collectNodeNames, summarizeTool, compactValue } = summary.module;
  const messages = [{ parts: [
    { type: "tool-read_canvas", output: { nodes: [{ id: "a", data: { name: "剧情大纲" } }], edges: [] } },
    { type: "tool-add_canvas_nodes", output: { nodes: [{ id: "b", name: "镜头一" }], connected: 1 } },
    { type: "text", text: "x" },
  ] }];
  const names = collectNodeNames(messages);
  assert.equal(names.get("a"), "剧情大纲");
  assert.equal(names.get("b"), "镜头一");
  assert.equal(summarizeTool("generate_image", { nodeId: "b" }, undefined, names), "镜头一");
  assert.equal(summarizeTool("read_canvas", {}, { nodes: [1, 2], edges: [1] }, names), "2 个节点、1 条连线");
  assert.equal(summarizeTool("add_canvas_nodes", { nodes: [{ name: "甲" }, { name: "乙" }, { type: "video" }, { name: "丁" }] }, { connected: 3 }, names), "甲、乙、视频 等 4 个，连线 3 条");
  assert.equal(summarizeTool("edit_canvas_nodes", { updates: [{ id: "a" }], connect: [{}, {}], remove: [], disconnect: [] }, undefined, names), "修改 剧情大纲，连线 2 条");
  assert.equal(summarizeTool("arrange_canvas_nodes", { nodeIds: ["a", "b"] }, { moved: 2 }, names), "移动 2 个节点");
  const compact = compactValue({ nodes: [{ content: "字".repeat(1000) }] });
  assert.ok(compact.nodes[0].content.length < 320);
  assert.match(compact.nodes[0].content, /共 1000 字/);
});

test("Markdown 排版：段落之间有间距，单换行按换行显示；Agent 指令包含空间与排版规则", async () => {
  const css = await readFile(new URL("../app/agent.css", import.meta.url), "utf8");
  // 旧规则 `.agent-markdown p { margin: 0 }` 的优先级高于 `> * + *`，会把段距清零。
  assert.doesNotMatch(css, /\.agent-markdown p\s*\{\s*margin:\s*0;?\s*\}/);
  assert.match(css, /\.agent-markdown > \* \+ \* \{\s*margin-top: 0\.75em;/);
  assert.match(css, /\.agent-markdown :is\(p, li, td, th\) \{\s*white-space: pre-line;/);
  const instructions = agent.module.AGENT_INSTRUCTIONS("c1");
  for (const rule of ["从左到右", "from", "不要自己给 x/y", "arrange_canvas_nodes", "段落之间空一行"]) assert.ok(instructions.includes(rule), rule);
  assert.ok(instructions.endsWith("当前画布ID：c1"));
});

test("工具执行：add_canvas_nodes 用 from 一次提交节点与连线并排成流程；arrange_canvas_nodes 只移动指定节点", async () => {
  const doc = await store.module.createCanvas();
  const tools = agent.module.createCanvasTools(doc.id, "http://127.0.0.1:1");
  const result = await tools.add_canvas_nodes.execute({ nodes: [
    { type: "canvasText", name: "大纲", prompt: "", content: "一句话", ref: "o" },
    { type: "canvasText", name: "分镜", prompt: "", content: "## 分镜", ref: "s", from: ["o"] },
    { type: "image", name: "镜头一", prompt: "a", ref: "i1", from: ["s"] },
    { type: "image", name: "镜头二", prompt: "b", ref: "i2", from: ["s"] },
    { type: "video", name: "成片", prompt: "c", from: ["i1", "i2"] },
  ] }, { toolCallId: "t1", messages: [] });
  assert.equal(result.connected, 5);
  assert.deepEqual(result.nodes.slice(0, 4).map(n => n.ref), ["o", "s", "i1", "i2"]);
  const saved = await store.module.loadCanvas(doc.id);
  assert.equal(saved.nodes.length, 5);
  assert.equal(saved.edges.length, 5);
  const byName = Object.fromEntries(saved.nodes.map(n => [n.data.name, n]));
  assert.ok(byName["大纲"].position.x < byName["分镜"].position.x && byName["分镜"].position.x < byName["镜头一"].position.x && byName["镜头一"].position.x < byName["成片"].position.x);
  assert.equal(saved.edges.find(e => e.target === byName["成片"].id).data.role, "reference");
  // 打乱一个节点后整理：只动指定节点，结果回到对齐位置。
  const shot = byName["镜头二"];
  const expected = { ...shot.position };
  await tools.edit_canvas_nodes.execute({ updates: [{ id: shot.id, x: -3000, y: 4000 }], remove: [], connect: [], disconnect: [] }, { toolCallId: "t2", messages: [] });
  const arranged = await tools.arrange_canvas_nodes.execute({ nodeIds: saved.nodes.map(n => n.id) }, { toolCallId: "t3", messages: [] });
  assert.ok(arranged.moved >= 1);
  const after = await store.module.loadCanvas(doc.id);
  const again = Object.fromEntries(after.nodes.map(n => [n.data.name, n]));
  assert.equal(again["镜头二"].position.x, again["镜头一"].position.x);
  assert.ok(again["镜头二"].position.y > again["镜头一"].position.y);
  // 起点列（大纲）是锚点，被拖乱的镜头回到原来的对齐位置。
  assert.deepEqual(again["大纲"].position, byName["大纲"].position);
  assert.deepEqual(again["镜头二"].position, expected);
});