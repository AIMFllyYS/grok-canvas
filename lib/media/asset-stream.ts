/**
 * 资产流式响应（P4-01，contracts.md C7）：createReadStream → Web 流；合法 Range 返回 206，完整 200，
 * 非法/越界/多 range 416；HEAD 复用同一决策但不创建 body 流。客户端取消或请求中断时关闭文件句柄。
 * 文件名仍经 isSafeAssetName/assetPath 校验，同源守卫由 proxy.ts 统一执行。服务端私有模块。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { assetPath, isSafeAssetName, mimeForAsset } from "../assets";
import { assetEtag, ifRangeAllows, parseSingleRange } from "./range";

const IMMUTABLE = "public, max-age=31536000, immutable";

export type StreamHandle = { body: ReadableStream<Uint8Array>; closed: Promise<void> };

/** 打开一段文件为 Web 流；取消（reader.cancel / 请求 abort）立即销毁 Node 流并释放 fd。 */
export function streamAsset(filePath: string, range: { start: number; end: number } | null, signal?: AbortSignal): StreamHandle {
  const node = createReadStream(filePath, range ? { start: range.start, end: range.end } : {});
  const closed = new Promise<void>((resolve) => node.once("close", () => resolve()));
  const abort = () => node.destroy();
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void closed.then(() => signal.removeEventListener("abort", abort));
  }
  return { body: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>, closed };
}

export async function assetResponse(request: Request, name: string, options: { head?: boolean; onStream?: (handle: StreamHandle) => void } = {}): Promise<Response> {
  if (!isSafeAssetName(name)) return new Response(options.head ? null : "not found", { status: 404 });
  const filePath = assetPath(name);
  let info;
  try { info = await stat(filePath); } catch { return new Response(options.head ? null : "not found", { status: 404 }); }
  if (!info.isFile() || !Number.isSafeInteger(info.size)) return new Response(options.head ? null : "not found", { status: 404 });
  const size = info.size;
  const etag = assetEtag(size, info.mtimeMs);
  const base: Record<string, string> = {
    "Content-Type": mimeForAsset(name),
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
  const rangeHeader = ifRangeAllows(request.headers.get("if-range"), etag) ? request.headers.get("range") : null;
  const decision = parseSingleRange(rangeHeader, size);
  if (decision.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
  }
  const partial = decision.kind === "partial" ? { start: decision.start, end: decision.end } : null;
  const length = partial ? partial.end - partial.start + 1 : size;
  const headers = { ...base, "Content-Length": String(length), ...(partial ? { "Content-Range": `bytes ${partial.start}-${partial.end}/${size}` } : {}) };
  const status = partial ? 206 : 200;
  if (options.head) return new Response(null, { status, headers });
  if (length === 0) return new Response(new Uint8Array(0), { status, headers });
  const handle = streamAsset(filePath, partial, request.signal);
  options.onStream?.(handle);
  return new Response(handle.body, { status, headers });
}
