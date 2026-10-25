export type CanvasLibrarySource = "generated" | "imported" | "manual";
export type CanvasLibraryAsset = { assetName: string; name: string; sources: CanvasLibrarySource[]; addedAt: string };
export const LIBRARY_SOURCE_LABELS: Record<CanvasLibrarySource, string> = { generated: "已生成", imported: "导入", manual: "手动参考" };
const SOURCES: CanvasLibrarySource[] = ["generated", "imported", "manual"];
export const isImageAssetName = (name: unknown): name is string => typeof name === "string" && /^[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/i.test(name);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function isLibraryAsset(value: unknown): value is CanvasLibraryAsset {
  const item = object(value);
  return isImageAssetName(item.assetName) && typeof item.name === "string" && item.name.length <= 512
    && typeof item.addedAt === "string" && Number.isFinite(Date.parse(item.addedAt))
    && Array.isArray(item.sources) && item.sources.length > 0 && item.sources.every(source => SOURCES.includes(source));
}
export function normalizeLibraryAssets(value: unknown): CanvasLibraryAsset[] {
  return mergeLibraryAssets([], list(value).filter(isLibraryAsset));
}
export function mergeLibraryAssets(existing: CanvasLibraryAsset[], incoming: CanvasLibraryAsset[]): CanvasLibraryAsset[] {
  const map = new Map(existing.map(item => [item.assetName, item]));
  let changed = false;
  for (const item of incoming) {
    if (!isImageAssetName(item.assetName)) continue;
    const previous = map.get(item.assetName);
    if (!previous) { map.set(item.assetName, item); changed = true; }
    else {
      const sources = [...new Set([...previous.sources, ...item.sources])];
      if (sources.length !== previous.sources.length) { map.set(item.assetName, { ...previous, sources }); changed = true; }
    }
  }
  return changed ? [...map.values()] : existing;
}

/** 只从当前画布恢复目录；已有目录的来源不被节点展示方式改写。 */
export function collectCanvasAssets(nodes: unknown[], addedAt: string, known: CanvasLibraryAsset[] = []): CanvasLibraryAsset[] {
  const found = new Map<string, CanvasLibraryAsset>();
  const knownNames = new Set(known.map(item => item.assetName));
  const at = Number.isFinite(Date.parse(addedAt)) ? addedAt : new Date().toISOString();
  const add = (assetName: unknown, name: unknown, source: CanvasLibrarySource) => {
    if (!isImageAssetName(assetName) || knownNames.has(assetName) || found.has(assetName)) return;
    found.set(assetName, { assetName, name: typeof name === "string" && name.trim() ? name.slice(0, 512) : "图片", sources: [source], addedAt: at });
  };
  for (const value of nodes) {
    const node = object(value), data = object(node.data);
    if (node.type !== "image") continue;
    const results = list(data.results);
    if (results.length) results.forEach((value, i) => {
      const slot = object(value);
      if (slot.status === "success") add(slot.assetName, `${data.name || "图片"}${results.length > 1 ? ` · ${i + 1}` : ""}`, "generated");
    });
    else add(data.assetName, data.name, "generated");
  }
  for (const value of nodes) {
    const node = object(value), data = object(node.data);
    if (node.type === "asset") add(data.assetName, data.name, "imported");
    const names = object(data.attachmentNames), request = object(data.generationRequest);
    const references = [...list(data.uploadAttachments), ...list(data.uploadInputs).map(value => object(value).assetName), ...list(request.referenceAssets), ...list(request.inputs).map(value => object(value).assetName)];
    for (const assetName of references) add(assetName, typeof assetName === "string" ? names[assetName] : undefined, "manual");
  }
  return [...found.values()];
}

export function assetsFromOutcome(outcome: { kind: string; slots?: Array<{ status: string; asset?: { name: string } }> }, addedAt: string): CanvasLibraryAsset[] {
  if (outcome.kind !== "result") return [];
  return (outcome.slots ?? []).flatMap((slot, index) => slot.status === "success" && isImageAssetName(slot.asset?.name)
    ? [{ assetName: slot.asset.name, name: `生成图片 · ${index + 1}`, sources: ["generated" as const], addedAt }] : []);
}
