import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P4-06：长 Markdown 分块、阅读缓存与 Agent 消息窗口/隐藏面板冻结。
const blocksMod = await loadTypescript("lib/canvas-runtime/document-blocks.ts");
const controller = await loadTypescript("lib/agent/conversation-controller.ts");
after(async () => { await blocksMod.dispose(); await controller.dispose(); });
const { splitMarkdownBlocks, summarize, createBlockCache } = blocksMod.module;
const { windowMessages, createFreezer, MESSAGE_PAGE } = controller.module;

function longDoc() {
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push(`## 第 ${i} 节\n\n这是中文段落，包含一些说明文字。`.repeat(1));
    parts.push("```ts\nconst a = 1;\n\nconst b = 2; // 围栏内的空行不能切\n```");
    parts.push("| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    parts.push("1. 第一项\n\n2. 第二项（松散列表）\n\n   缩进续行\n\n3. 第三项");
    parts.push("> 引用第一行\n>\n> 引用第二行");
    parts.push("普通段落 ".repeat(40));
  }
  return parts.join("\n\n") + "\n";
}

test("100KB 级文档：分块拼回与原文逐字节一致；不在围栏、表格、列表、引用中间切开", () => {
  const text = longDoc();
  let big = text;
  while (big.length <= 100_000) big += text;
  assert.ok(big.length > 100_000);
  const blocks = splitMarkdownBlocks(big);
  assert.ok(blocks.length > 10, `分成 ${blocks.length} 块`);
  assert.equal(blocks.join(""), big);
  for (const block of blocks) {
    const fences = (block.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, "代码围栏成对");
    assert.doesNotMatch(block, /^\s*\| 3 \| 4 \|/, "表格不从中间行开始");
    assert.doesNotMatch(block, /^\s*2\. 第二项/, "列表不从中间项开始");
    assert.doesNotMatch(block, /^\s*> 引用第二行/, "引用不从中间行开始");
    assert.doesNotMatch(block, /^ {3}缩进续行/, "缩进续行不单独成块");
  }
  assert.deepEqual(splitMarkdownBlocks("短文\n\n第二段"), ["短文\n\n第二段"], "短文只有一块");
  assert.deepEqual(splitMarkdownBlocks(""), [""]);
  const broken = "```\n未闭合围栏\n\n".repeat(500);
  assert.equal(splitMarkdownBlocks(broken).join(""), broken, "无效 Markdown 也原样保留");
});

test("阅读缓存：同版本不重复解析；版本变化只刷新该文档；LRU 有上限", () => {
  const cache = createBlockCache({ documents: 3, chars: 1e9 });
  const text = longDoc();
  const first = cache.get("doc-a", text);
  assert.equal(cache.get("doc-a", text), first, "同一版本命中缓存");
  assert.equal(cache.stats().parses, 1);
  cache.get("doc-b", "b");
  const edited = text.replace("第 5 节", "第五节");
  const next = cache.get("doc-a", edited);
  assert.equal(cache.stats().parses, 3);
  assert.equal(cache.stats().documents, 2, "旧版本失效，不累积");
  const changed = next.filter((block, i) => block !== first[i]).length;
  assert.equal(changed, 1, "只改了一处，只有一块内容不同（其余块 memo 命中）");
  for (const id of ["c", "d", "e"]) cache.get(id, id);
  assert.ok(cache.stats().documents <= 3);
});

test("摘要按字符截断到 512，不切开代理对", () => {
  const s = summarize("😀".repeat(600));
  assert.equal(Array.from(s).length, 513);
  assert.equal(summarize("  短  文 "), "短 文");
});

test("消息窗口：默认最后 50 条，加载更早每次 50；按整条消息切，不拆工具输入与结果", () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, parts: [{ type: "tool-x", state: "output-available", input: {}, output: {} }] }));
  const first = windowMessages(messages, MESSAGE_PAGE);
  assert.equal(first.items.length, 50);
  assert.equal(first.hidden, 70);
  assert.equal(first.items[0].id, "m70");
  assert.ok(first.items.every(m => m.parts[0].output), "工具结果随消息一起");
  const second = windowMessages(messages, MESSAGE_PAGE * 2);
  assert.equal(second.items[0].id, "m20");
  const all = windowMessages(messages, 1000);
  assert.equal(all.items, messages, "全部可见时不复制数组");
  assert.equal(all.hidden, 0);
});

test("隐藏面板冻结显示快照：隐藏期间新消息不引起列表变化，重新可见立即同步", () => {
  const freeze = createFreezer();
  const v1 = [1], v2 = [1, 2], v3 = [1, 2, 3];
  assert.equal(freeze(v1, true), v1);
  assert.equal(freeze(v2, false), v1);
  assert.equal(freeze(v3, false), v1, "隐藏期间保持同一个对象（memo 不重绘）");
  assert.equal(freeze(v3, true), v3);
});

test("接线：文本节点用分块阅读视图；Agent 面板窗口化、单条消息 memo、隐藏时冻结", async () => {
  const textNode = await readFile(new URL("../components/canvas/text-node.tsx", import.meta.url), "utf8");
  assert.match(textNode, /<DocumentReader documentKey=\{id\} content=\{data\.content \|\| ""\} \/>/);
  const panel = await readFile(new URL("../components/agent/panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const ChatMessage = memo\(/);
  assert.match(panel, /freeze\(messages, visible\)/);
  assert.match(panel, /windowMessages\(displayed, shownCount\)/);
  assert.match(panel, /visible=\{active && open\}/);
  assert.match(panel, /bridgeToolPart\(previewStore, canvasId, part as ToolUIPart, previewScheduler\)/, "后台预显示仍按最新消息运行");
});
