import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const references = await loadTypescript("lib/prompt-references.ts");
const assetDrag = await loadTypescript("lib/asset-drag.ts");
after(() => { references.dispose(); assetDrag.dispose(); });
const source = await readFile(new URL("../components/canvas/prompt-editor.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

// 只测试组件的键盘、拖入处理和 ARIA 输出；不模拟浏览器排版、Range 或输入法。
function renderEditor({ query = "", active = 0, readOnly = false, suggestions = [] } = {}) {
  class Element { dataset = {}; childNodes = [{ nodeType: 3, nodeName: "#text", textContent: "当前输入" }]; textContent = "当前输入"; }
  const root = new Element();
  const states = [query, active, false, { left: 0, top: 0 }, new Set(), false];
  const refValues = [root, false, null, null];
  let stateIndex = 0, refIndex = 0;
  const committed = [], submitted = [], browsed = [], selected = [];
  const exports = {};
  vm.runInNewContext(code, {
    exports, HTMLElement: Element, Node: { TEXT_NODE: 3 }, document: { body: {}, caretRangeFromPoint: () => null },
    requestAnimationFrame: () => 0,
    require(name) {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react-dom") return { createPortal: child => child };
      if (name === "react") return {
        useState: () => { const index = stateIndex++; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
        useRef: () => ({ current: refValues[refIndex++] }),
        useEffect() {}, useLayoutEffect() {},
      };
      if (name === "@/lib/prompt-references") return references.module;
      if (name === "@/lib/asset-drag") return assetDrag.module;
      if (name === "@/lib/floating-placement") return {};
      if (name === "./use-edit-lease") return { useEditLease: () => ({ onFocus() {}, onBlur() {} }) };
      throw new Error(`未模拟的依赖：${name}`);
    },
  });
  const tree = exports.PromptEditor({ nodeId: "n", value: "旧输入", references: [], suggestions, readOnly,
    onSelectReference: (item, nextPrompt) => { selected.push([item, nextPrompt]); return true; },
    onBrowse: (...args) => browsed.push(args), onCommit: value => committed.push(value), onSubmit: value => submitted.push(value) });
  const children = tree.props.children;
  return { textbox: children.find(child => child?.props?.role === "textbox"), popup: children.find(child => child?.props?.role === "listbox"), committed, submitted, browsed, selected };
}
const drag = (assetName, types = ["application/x-grok-canvas-asset"]) => ({ preventDefault() {}, dataTransfer: { types, dropEffect: "none", getData: type => (type === "application/x-grok-canvas-asset" ? assetName : "") } });
const key = (value, modifiers = {}) => ({ key: value, nativeEvent: {}, preventDefault() {}, stopPropagation() {}, ...modifiers });

test("空图库的高级浏览项仍有活动选项ARIA关联", () => {
  const { textbox, popup } = renderEditor();
  assert.equal(textbox.props["aria-activedescendant"], "reference-n-0");
  assert.equal(popup.props.children[1].props.id, "reference-n-0");
});
test("候选打开时Ctrl或Cmd+Enter提交当前文本，不误进素材选择器", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const rendered = renderEditor();
    rendered.textbox.props.onKeyDown(key("Enter", { [modifier]: true }));
    assert.deepEqual(rendered.submitted, ["当前输入"]);
    assert.deepEqual(rendered.browsed, []);
  }
});
test("输入法合成期间不提交或选择素材", () => {
  const rendered = renderEditor();
  rendered.textbox.props.onKeyDown(key("Enter", { ctrlKey: true, nativeEvent: { isComposing: true } }));
  assert.deepEqual(rendered.submitted, []);
  assert.deepEqual(rendered.browsed, []);
});
test("生成锁定时隐藏残留候选且拒绝快捷提交", () => {
  const rendered = renderEditor({ readOnly: true });
  assert.equal(rendered.textbox.props["aria-expanded"], false);
  assert.equal(rendered.popup, undefined);
  rendered.textbox.props.onKeyDown(key("Enter", { ctrlKey: true }));
  assert.deepEqual(rendered.submitted, []);
});
test("拖入素材与 @ 选择等价：插入引用并绑定参考图", () => {
  const rendered = renderEditor({ suggestions: [{ assetName: "a.png", name: "A" }] });
  rendered.textbox.props.onDrop(drag("a.png"));
  assert.deepEqual(rendered.selected, [[{ assetName: "a.png", name: "A" }, "当前输入[[image:a.png]] "]]);
  // 和 @ 选择一样只回写节点数据，不额外提交一次提示词
  assert.deepEqual(rendered.committed, []);
});
test("拖入不在当前素材库的图片不会产生引用", () => {
  const rendered = renderEditor({ suggestions: [{ assetName: "a.png", name: "A" }] });
  rendered.textbox.props.onDrop(drag("ghost.png"));
  assert.deepEqual(rendered.selected, []);
  assert.deepEqual(rendered.committed, []);
});
test("不是素材库的拖拽（例如桌面文件）不接管", () => {
  const rendered = renderEditor({ suggestions: [{ assetName: "a.png", name: "A" }] });
  const foreign = drag("a.png", ["Files"]);
  let prevented = 0;
  rendered.textbox.props.onDragOver({ ...foreign, preventDefault: () => { prevented += 1; }, dataTransfer: { types: ["Files"], dropEffect: "none" } });
  assert.equal(prevented, 0);
  rendered.textbox.props.onDrop(foreign);
  assert.deepEqual(rendered.selected, []);
});
test("拖拽经过时放行并提示可放下", () => {
  const rendered = renderEditor({ suggestions: [{ assetName: "a.png", name: "A" }] });
  const dataTransfer = { types: ["application/x-grok-canvas-asset"], dropEffect: "none" };
  let prevented = 0;
  rendered.textbox.props.onDragOver({ preventDefault: () => { prevented += 1; }, dataTransfer });
  assert.equal(prevented, 1);
  assert.equal(dataTransfer.dropEffect, "copy");
});
test("生成锁定时拒绝拖入素材", () => {
  const rendered = renderEditor({ readOnly: true, suggestions: [{ assetName: "a.png", name: "A" }] });
  rendered.textbox.props.onDrop(drag("a.png"));
  assert.deepEqual(rendered.selected, []);
});
