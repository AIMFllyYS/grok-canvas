import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { DerivativeError, getDerivativeService, isVariant } from "@/lib/media/derivatives";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const errorBody = (error: DerivativeError) => NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: NO_STORE });

/**
 * 派生读取（P4-02，contracts.md C7）：GET /api/assets/:name/derivative/:variant
 * - ready：200 image/webp，ETag 为源 hash（源变化即新内容，旧引用不会误读）
 * - pending：202 {status:"pending"}，调用方保持固定几何占位，稍后再取
 * - failed：422 {status:"failed", error, retry}，不自动重试；POST 同一 URL 显式重试
 * - poster 未生成：404 {status:"absent"}；只在首次主动播放后由客户端 POST 截帧生成
 */
export async function GET(request: Request, context: { params: Promise<{ name: string; variant: string }> }) {
  const { name, variant } = await context.params;
  if (!isVariant(variant)) return NextResponse.json({ error: { code: "invalid_variant", message: "未知派生类型" } }, { status: 400, headers: NO_STORE });
  try {
    const service = getDerivativeService();
    const status = await service.requestDerivative(name, variant);
    if (status.status === "pending") return NextResponse.json(status, { status: 202, headers: { ...NO_STORE, "Retry-After": "1" } });
    if (status.status === "failed") return NextResponse.json(status, { status: 422, headers: NO_STORE });
    if (status.status === "absent") return NextResponse.json(status, { status: 404, headers: NO_STORE });
    const etag = `"${status.sourceHash}-${variant}"`;
    const headers = { "Content-Type": "image/webp", "Cache-Control": "no-cache", ETag: etag, "X-Media-Width": String(status.width), "X-Media-Height": String(status.height) };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const file = await service.readyFile(name, variant);
    if (!file) return NextResponse.json({ status: "pending", url: status.url }, { status: 202, headers: NO_STORE });
    const stream = createReadStream(file);
    request.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status: 200, headers });
  } catch (error) {
    if (error instanceof DerivativeError) return errorBody(error);
    throw error;
  }
}

/** POST：poster 提交截帧（请求体为图片字节，≤8MiB）；其它变体为显式重试。 */
export async function POST(request: Request, context: { params: Promise<{ name: string; variant: string }> }) {
  const { name, variant } = await context.params;
  if (!isVariant(variant)) return NextResponse.json({ error: { code: "invalid_variant", message: "未知派生类型" } }, { status: 400, headers: NO_STORE });
  try {
    const service = getDerivativeService();
    if (variant === "poster") {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > 8 * 1024 * 1024) throw new DerivativeError("invalid_input", "截帧超过 8MiB", 413);
      const frame = new Uint8Array(await request.arrayBuffer());
      const status = await service.submitPoster(name, frame);
      return NextResponse.json(status, { status: status.status === "ready" ? 200 : 422, headers: NO_STORE });
    }
    const status = await service.retry(name, variant);
    return NextResponse.json(status, { status: status.status === "ready" ? 200 : 202, headers: NO_STORE });
  } catch (error) {
    if (error instanceof DerivativeError) return errorBody(error);
    throw error;
  }
}
