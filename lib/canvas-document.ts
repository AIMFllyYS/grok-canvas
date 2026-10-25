import type { CanvasDoc } from "./canvas-store";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets } from "./canvas-library";

/** 所有保存入口共用完整载荷，避免后台任务遗漏画布级字段。 */
export function canvasSaveBody(doc: CanvasDoc, patch: Partial<CanvasDoc> = {}): CanvasDoc {
  const next = { ...doc, ...patch };
  const library = normalizeLibraryAssets(next.libraryAssets);
  return { ...next, libraryAssets: mergeLibraryAssets(library, collectCanvasAssets(next.nodes, next.createdAt, library)) };
}
