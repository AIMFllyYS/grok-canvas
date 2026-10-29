import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { interactionConfig, interactionShortcut } from "../lib/canvas-interaction.ts";

test("选择模式保留框选和中右键平移", () => {
  assert.deepEqual(interactionConfig("select"), { selectionOnDrag: true, panOnDrag: [1, 2], nodesDraggable: true, nodesConnectable: true, elementsSelectable: true });
});
test("手型只把空白处左键改成平移，节点交互与选择模式完全一致", () => {
  const select = interactionConfig("select");
  const hand = interactionConfig("hand");
  assert.equal(hand.nodesDraggable, true, "手型下拖节点就是移动节点");
  assert.equal(hand.elementsSelectable, true, "手型下点节点同样会选中并弹出面板");
  assert.equal(hand.nodesConnectable, true, "手型下连线手柄同样可用");
  assert.equal(hand.selectionOnDrag, false, "手型下空白处左键是平移而不是框选");
  assert.deepEqual(hand.panOnDrag, [0, 1, 2]);
  assert.deepEqual(select.panOnDrag, [1, 2]);
});
test("两种模式除空白处左键手势外没有任何差异", () => {
  const select = interactionConfig("select");
  const hand = interactionConfig("hand");
  const rest = ({ panOnDrag: _pan, selectionOnDrag: _selection, ...remaining }) => remaining;
  assert.deepEqual(rest(hand), rest(select));
  assert.notDeepEqual(select.panOnDrag, hand.panOnDrag);
  assert.notEqual(select.selectionOnDrag, hand.selectionOnDrag);
});
test("模式快捷键不会抢占编辑和系统快捷键", () => {
  assert.equal(interactionShortcut({ key: "h" }), "hand");
  assert.equal(interactionShortcut({ key: "V" }), "select");
  assert.equal(interactionShortcut({ key: "h", ctrlKey: true }), null);
  assert.equal(interactionShortcut({ key: "h", isComposing: true }), null);
  assert.equal(interactionShortcut({ key: "h" }, true), null);
});

// ---- 节点族拖动契约 ----
// React Flow 起手前用 !hasSelector(target, ".nodrag", node) 过滤，按下点落在 .nodrag 里这次拖动就被丢弃。
// 所以「铺满内容面」的层不能标 nodrag，标了整张卡片就只剩内边距和标题条能拖（视频、文本节点都踩过）。
// 宽度铺满不算问题（底部控制条本来就可以通栏），整高或铺满四边才是致命的。
const NODE_COMPONENTS = ["image-node", "asset-node", "video-node", "text-node"];
const FULL_BLEED = ["h-full", "inset-0"];

// className 可能是字符串字面量、无插值模板，或带插值的模板（只取静态片段）。
const staticFragments = (initializer) => {
  if (!initializer) return [];
  const expression = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  if (!expression) return [];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.map(span => span.literal.text)];
  return [];
};

const classNameValues = (source) => {
  const file = ts.createSourceFile("node.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const values = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "className") values.push(...staticFragments(node.initializer));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
};

for (const name of NODE_COMPONENTS) {
  test(`节点族拖动契约：${name} 的 nodrag 不铺满内容面`, async () => {
    const values = classNameValues(await readFile(new URL(`../components/canvas/${name}.tsx`, import.meta.url), "utf8"));
    const offenders = values.filter((value) => /\bnodrag\b/.test(value) && FULL_BLEED.some((token) => value.includes(token)));
    assert.deepEqual(offenders, [], "整高或铺满的层标了 nodrag，节点就拖不动了");
  });
}

test("文本节点正文靠 nowheel 保住滚动，不被画布抢走滚轮", async () => {
  const values = classNameValues(await readFile(new URL("../components/canvas/text-node.tsx", import.meta.url), "utf8"));
  assert.ok(values.some((value) => value.includes("nowheel") && value.includes("overflow-auto")), "正文容器既要能滚动，也不能把滚轮交给画布缩放");
});
