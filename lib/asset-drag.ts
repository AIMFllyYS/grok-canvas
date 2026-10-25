/**
 * 素材库拖拽到提示词时使用的私有 MIME。
 * 只认这一种类型，避免把桌面文件、网页链接和普通文本误当成画布素材。
 */
export const ASSET_DRAG_TYPE = "application/x-grok-canvas-asset";

type DragSource = { types?: ArrayLike<string> | null };
type DragPayload = DragSource & { getData: (type: string) => string };
type DragSink = { setData: (type: string, value: string) => void; effectAllowed: string };

export function isAssetDrag(source: DragSource | null | undefined): boolean {
  if (!source?.types) return false;
  return Array.from(source.types).includes(ASSET_DRAG_TYPE);
}

/** 读出被拖动的素材名；不是素材库拖拽、或内容为空都返回 null。 */
export function readAssetDrag(source: DragPayload | null | undefined): string | null {
  if (!source || !isAssetDrag(source)) return null;
  const assetName = source.getData(ASSET_DRAG_TYPE).trim();
  return assetName || null;
}

export function writeAssetDrag(target: DragSink, assetName: string): void {
  target.effectAllowed = "copy";
  target.setData(ASSET_DRAG_TYPE, assetName);
}
