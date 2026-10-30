/**
 * 媒体尺寸元数据（P4-02）：纯函数部分（方向校正、比例与固定几何占位）浏览器与服务端共用；
 * 实际解码只在派生 Worker 里做（derivatives.ts 的 metadata）。
 */
export type MediaSize = { width: number; height: number };

/** EXIF 方向 5..8 表示旋转 90°：显示尺寸宽高互换。 */
export function orientedSize(stored: MediaSize, orientation = 1): MediaSize {
  return orientation >= 5 && orientation <= 8 ? { width: stored.height, height: stored.width } : { ...stored };
}

/** 长边缩放到 limit（不放大），比例取整后保持；与 sharp fit:inside + withoutEnlargement 一致。 */
export function fitLongEdge(size: MediaSize, limit: number): MediaSize {
  if (!(size.width > 0 && size.height > 0)) throw new Error("尺寸无效");
  const scale = Math.min(1, limit / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** pending/failed 时的固定几何占位：按已知比例或节点几何，不随派生状态跳动。 */
export function placeholderBox(nodeSize: MediaSize, media?: MediaSize | null): MediaSize {
  if (!media || !(media.width > 0 && media.height > 0)) return { ...nodeSize };
  return fitLongEdge(media, Math.max(nodeSize.width, nodeSize.height));
}

/** 选择变体：显示像素 ≤256 用 thumb256，否则 thumb1024；原图只用于详情/导出。 */
export function variantForDisplay(displayLongEdge: number, devicePixelRatio = 1): "thumb256" | "thumb1024" {
  return displayLongEdge * devicePixelRatio <= 256 ? "thumb256" : "thumb1024";
}
