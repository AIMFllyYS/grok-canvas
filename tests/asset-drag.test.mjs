import test, { after } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const promptReferences = await loadTypescript("lib/prompt-references.ts");
const assetDrag = await loadTypescript("lib/asset-drag.ts");
after(() => { promptReferences.dispose(); assetDrag.dispose(); });

const { ASSET_DRAG_TYPE, isAssetDrag, readAssetDrag, writeAssetDrag } = assetDrag.module;
const { insertReferenceToken, compilePrompt } = promptReferences.module;

const transfer = (types, data) => ({
  types,
  getData: type => data[type] ?? "",
});

test("拖拽数据只认素材库自己的 MIME，其余一律忽略", () => {
  assert.equal(ASSET_DRAG_TYPE, "application/x-grok-canvas-asset");
  assert.equal(isAssetDrag(transfer([ASSET_DRAG_TYPE, "text/plain"], {})), true);
  assert.equal(isAssetDrag(transfer(["text/plain"], {})), false);
  assert.equal(isAssetDrag(null), false);
  assert.equal(isAssetDrag({}), false);
  // 从桌面拖入的文件也带类型，但不应被当成素材引用
  assert.equal(readAssetDrag(transfer(["Files"], { [ASSET_DRAG_TYPE]: "a.png" })), null);
});

test("从拖拽数据里取出的素材名会去掉空白，空值视为无效", () => {
  assert.equal(readAssetDrag(transfer([ASSET_DRAG_TYPE], { [ASSET_DRAG_TYPE]: " a.png " })), "a.png");
  assert.equal(readAssetDrag(transfer([ASSET_DRAG_TYPE], { [ASSET_DRAG_TYPE]: "   " })), null);
  assert.equal(readAssetDrag(transfer([ASSET_DRAG_TYPE], {})), null);
});

test("写入拖拽数据的素材名与读出的一致", () => {
  const store = {};
  const dataTransfer = {
    types: [ASSET_DRAG_TYPE],
    effectAllowed: "",
    setData: (type, value) => { store[type] = value; },
    getData: type => store[type] ?? "",
  };
  writeAssetDrag(dataTransfer, "画布 01.png");
  assert.equal(dataTransfer.effectAllowed, "copy");
  assert.equal(store[ASSET_DRAG_TYPE], "画布 01.png");
  assert.equal(readAssetDrag(dataTransfer), "画布 01.png");
});

test("插入引用与 @ 选择产出的提示词格式一致", () => {
  assert.equal(insertReferenceToken("前面后面", "a.png", 2), "前面[[image:a.png]] 后面");
  // 起点越界时收敛到末尾，负值收敛到开头
  assert.equal(insertReferenceToken("abc", "a.png", 99), "abc[[image:a.png]] ");
  assert.equal(insertReferenceToken("abc", "a.png", -5), "[[image:a.png]] abc");
  assert.equal(insertReferenceToken("", "a.png", 0), "[[image:a.png]] ");
});

test("插入后的提示词能按参考图顺序编译成图片序号", () => {
  const prompt = insertReferenceToken(insertReferenceToken("", "a.png", 0), "b.png", 20);
  assert.equal(compilePrompt(prompt, ["a.png", "b.png"]), "输入图片 1 输入图片 2 ");
});
