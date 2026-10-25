import type { CanvasDoc } from "./canvas-store";
import { canvasSaveBody } from "./canvas-document";
import { assetsFromOutcome, mergeLibraryAssets, normalizeLibraryAssets } from "./canvas-library";
import { applyGenerationOutcome, type GenerationOutcome } from "./multi-image";
import { videoNodePatchFromView, type VideoTaskView } from "./video-runtime";

type PersistOptions = { fetch?: typeof fetch; orphan?: () => void };
type StoredNode = { id: string; data: Record<string, unknown> };
async function persistPatch(canvasId: string, patch: (doc: CanvasDoc) => CanvasDoc | null, options: PersistOptions): Promise<void> {
  const request = options.fetch ?? fetch;
  const url = `/api/canvases/${encodeURIComponent(canvasId)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(`${url}?background=1`, { cache: "no-store" });
    if (response.status === 404) return;
    if (!response.ok) throw new Error("读取原画布失败");
    const doc = await response.json() as CanvasDoc;
    const next = patch(doc);
    if (!next) return;
    const saved = await request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(canvasSaveBody(next)) });
    if (saved.ok || saved.status === 404) return;
    if (saved.status !== 409) break;
  }
  throw new Error("生成完成，但写回原画布失败，请刷新对应画布检查");
}

export async function persistImageOutcome(canvasId: string, nodeId: string, outcome: GenerationOutcome, options: PersistOptions = {}): Promise<void> {
  const additions = assetsFromOutcome(outcome, new Date().toISOString());
  return persistPatch(canvasId, doc => {
    const libraryAssets = mergeLibraryAssets(normalizeLibraryAssets(doc.libraryAssets), additions);
    const source = (doc.nodes as StoredNode[]).find(node => node.id === nodeId);
    if (!source) {
      options.orphan?.();
      return additions.length ? { ...doc, libraryAssets } : null;
    }
    const patch = applyGenerationOutcome(source.data, outcome, () => crypto.randomUUID());
    return { ...doc, libraryAssets, nodes: patch ? (doc.nodes as StoredNode[]).map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node) : doc.nodes };
  }, options);
}

export async function persistVideoOutcome(canvasId: string, nodeId: string, view: VideoTaskView, options: PersistOptions = {}): Promise<void> {
  return persistPatch(canvasId, doc => {
    const source = (doc.nodes as StoredNode[]).find(node => node.id === nodeId);
    if (!source) { options.orphan?.(); return null; }
    return { ...doc, nodes: (doc.nodes as StoredNode[]).map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...videoNodePatchFromView(view) } } : node) };
  }, options);
}
