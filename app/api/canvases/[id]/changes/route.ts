import { NextResponse } from "next/server";
import { ChangesError, listCanvasChanges } from "@/lib/canvas-runtime/command-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const INTEGER = /^(0|[1-9]\d{0,15})$/;

/**
 * 增量变化（contracts.md C6）：GET ?afterRevision=R&limit=N&storageEpoch=E →
 * { events, fromRevision, toRevision, hasMore, storageEpoch }；整条事务事件为单位。
 * 缺口/早于保留水位 410 snapshot_required；同源守卫由 proxy.ts 执行。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const after = url.searchParams.get("afterRevision");
  const limit = url.searchParams.get("limit");
  if (after === null || !INTEGER.test(after) || (limit !== null && !INTEGER.test(limit))) {
    return NextResponse.json({ error: { code: "invalid_request", message: "afterRevision/limit 必须是非负整数" } }, { status: 400, headers: NO_STORE });
  }
  try {
    const page = await listCanvasChanges({
      canvasId: id,
      afterRevision: Number(after),
      ...(limit !== null ? { limit: Number(limit) } : {}),
      ...(url.searchParams.has("storageEpoch") ? { storageEpoch: url.searchParams.get("storageEpoch")! } : {}),
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof ChangesError)) throw error;
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: NO_STORE });
  }
}
