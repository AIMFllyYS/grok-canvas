/** 确定性的混合负载；仅包含媒体元数据，不联网、不触发生成。 */
export function canvasFixture(size, { dense = false, longText = false } = {}) {
  if (!Number.isInteger(size) || size < 20 || size % 20) throw new Error("规模须为至少 20 的 20 倍数");
  const textCount = size / 2;
  const videoCount = size / 20;
  const normalText = "## 场景 Scene\n\n人物沿着街道前行，镜头保持稳定。\n\n- Lighting: soft\n- Camera: tracking\n\n".repeat(16);
  const nodes = Array.from({ length: size }, (_, index) => {
    const type = index < textCount ? "canvasText" : index >= size - videoCount ? "video" : index % 2 ? "image" : "asset";
    const data = { name: `节点 ${index}`, status: "idle" };
    if (type === "canvasText") data.content = longText && index === 0 ? "长文压力测试。".repeat(4761) : normalText;
    else {
      data.assetName = type === "video" ? `fixture-${index}.mp4` : `fixture-${index}.png`;
      data.prompt = "固定合成样例";
      data.uploadAttachments = [];
      if (type === "video") Object.assign(data, { duration: 10, aspectRatio: "16:9", resolution: "720p", audio: true, uploadInputs: [] });
      if (type === "image") Object.assign(data, { aspectRatio: "auto", resolution: "1k", quality: "low" });
    }
    return { id: `node-${index}`, type, data, position: { x: index % 100 * 320, y: Math.floor(index / 100) * 360 }, width: type === "canvasText" ? 280 : 240, height: 280 };
  });
  // 文本关系不占媒体槽位，保证 2N 条关系仍满足现有引用校验规则。
  const edges = Array.from({ length: size * 2 }, (_, index) => {
    const source = dense ? index % Math.min(textCount, 100) : index % textCount;
    const target = dense
      ? textCount + Math.floor(index / Math.min(textCount, 100)) % textCount
      : textCount + (index % textCount + Math.floor(index / textCount)) % textCount;
    return { id: `edge-${index}`, source: `node-${source}`, target: `node-${target}`, type: "scissor", data: {} };
  });
  return { id: "performance-fixture", name: "性能基准", schemaVersion: 1, revision: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges, libraryAssets: [] };
}
