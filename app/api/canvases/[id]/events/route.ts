import { NextResponse } from "next/server";
import { canvasRevision, isSafeCanvasId } from "@/lib/canvas-store";
import { subscribeCanvasChanged } from "@/lib/canvas-runtime/change-bus";
import { createCanvasEventStream } from "@/lib/db/event-stream";
import { ensureRetentionScheduler } from "@/lib/db/retention-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 活动画布的 SSE（P3-09）：event "revision" → { canvasId, revision, actors, initial? }；
 * 画布被删除时 event "gone" 并关闭。客户端只在别人写入时拉取，取代常态 2 秒整图轮询。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { code: "invalid_request", message: "画布 ID 无效" } }, { status: 400 });
  if (!await canvasRevision(id)) return NextResponse.json({ error: { code: "not_found", message: "画布不存在或已删除" } }, { status: 404 });
  ensureRetentionScheduler();
  const stream = createCanvasEventStream({
    canvasId: id,
    probe: () => canvasRevision(id),
    subscribe: listener => subscribeCanvasChanged(id, listener),
    signal: request.signal,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
