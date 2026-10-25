export type ToolbarLayout = "aggregated" | "scattered";
export type ToolbarPosition = { x: number; y: number };
export const TOOLBAR_LAYOUT_KEY = "grok-canvas:toolbar-layout";
export const toolbarPositionKey = (canvasId: string) => `grok-canvas:toolbar-position:${canvasId}`;
export const MINIMAP_SIZE_KEY = "grok-canvas:minimap-size";
export type MinimapSize = { width: number; height: number };
export const MINIMAP_MIN_SIZE: MinimapSize = { width: 120, height: 96 };
export const MINIMAP_DEFAULT_SIZE: MinimapSize = { width: 200, height: 140 };

export function parseToolbarLayout(value: unknown): ToolbarLayout {
  return value === "scattered" ? "scattered" : "aggregated";
}
export function parseToolbarPosition(raw: string | null): ToolbarPosition | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const { x, y } = value as ToolbarPosition;
    return typeof x === "number" && Number.isFinite(x) && x >= 0 && typeof y === "number" && Number.isFinite(y) && y >= 0 ? { x, y } : null;
  } catch { return null; }
}

/** 工具栏目标坐标：自定义位置优先，否则聚合居底、拆散居左下。容器尺寸为 0 时也给出可显示的数字。 */
export function toolbarTarget(
  layout: ToolbarLayout,
  custom: ToolbarPosition | null,
  container: { width: number; height: number },
  element: { width: number; height: number },
): ToolbarPosition {
  if (layout === "scattered") return { x: 12, y: Math.max(0, container.height - element.height - 12) };
  if (custom) return custom;
  return { x: Math.max(0, (container.width - element.width) / 2), y: Math.max(0, container.height - element.height - 16) };
}

export function parseMinimapSize(raw: string | null): MinimapSize | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return null;
    const { width, height } = value as MinimapSize;
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
}

/** 小地图贴右下角：尺寸不超过容器（预留边距），但不小于可用下限。 */
export function clampMinimapSize(size: MinimapSize, container: { width: number; height: number }): MinimapSize {
  return {
    width: Math.max(MINIMAP_MIN_SIZE.width, Math.min(Math.round(size.width), Math.round(container.width - 24))),
    height: Math.max(MINIMAP_MIN_SIZE.height, Math.min(Math.round(size.height), Math.round(container.height - 24))),
  };
}

