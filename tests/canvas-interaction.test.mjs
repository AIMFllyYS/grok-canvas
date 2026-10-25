import test from "node:test";
import assert from "node:assert/strict";
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
