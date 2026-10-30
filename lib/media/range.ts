/**
 * 单 Range 解析（P4-01，contracts.md C7）：纯函数，不碰文件。
 * - 无头 → full（200）；bytes=a-b / a- / -n 合法 → partial（206）；
 * - 多 range、非法语法、反向、越界、非安全整数 → unsatisfiable（416，Content-Range: bytes * /size）。
 */
export type RangeDecision =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE = /^bytes=(\d*)-(\d*)$/;
const toSafe = (text: string): number | null => {
  if (!text) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : NaN;
};

export function parseSingleRange(header: string | null | undefined, size: number): RangeDecision {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("文件大小无效");
  if (header === null || header === undefined || header.trim() === "") return { kind: "full" };
  const match = SINGLE.exec(header.trim());
  if (!match) return { kind: "unsatisfiable" };
  const start = toSafe(match[1]!), end = toSafe(match[2]!);
  if (Number.isNaN(start) || Number.isNaN(end)) return { kind: "unsatisfiable" };
  if (start === null && end === null) return { kind: "unsatisfiable" };
  if (size === 0) return { kind: "unsatisfiable" };
  if (start === null) {
    // 后缀：最后 n 字节
    if (end === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - end!), end: size - 1 };
  }
  if (start >= size) return { kind: "unsatisfiable" };
  if (end === null) return { kind: "partial", start, end: size - 1 };
  if (start > end) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

/** 资产文件不可变：ETag 只取决于文件大小与修改时间（不读用户可变的节点状态）。 */
export function assetEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/** If-Range 只接受强 ETag 精确匹配；不匹配（或是日期形式）时回退到完整 200，保证客户端不会拼接错版本。 */
export function ifRangeAllows(ifRange: string | null | undefined, etag: string): boolean {
  if (ifRange === null || ifRange === undefined || ifRange.trim() === "") return true;
  return ifRange.trim() === etag;
}
