import { NextResponse } from "next/server";
import { isSqliteMode } from "@/lib/db/storage-mode";
import { sqlCommand } from "@/lib/db/sql-command-repository";
import { ensureRetentionScheduler } from "@/lib/db/retention-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = { invalid_request: 400, not_found: 404, stale_epoch: 409 };

/**
 * 客户端确认水位（P3-10）：POST { actorId, ackSeq, storageEpoch? } → { ackSeq, acceptedSeq }。
 * 只接受不超过已接受序号的单调水位；JSON 模式没有可压缩的事件日志，直接返回 ignored。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { actorId?: unknown; ackSeq?: unknown; storageEpoch?: unknown } | null;
  if (!body || typeof body.actorId !== "string" || !UUID.test(body.actorId) || !Number.isSafeInteger(body.ackSeq) || (body.ackSeq as number) < 0
    || (body.storageEpoch !== undefined && typeof body.storageEpoch !== "string")) {
    return NextResponse.json({ error: { code: "invalid_request", message: "需要 actorId(UUID) 与非负整数 ackSeq" } }, { status: 400, headers: NO_STORE });
  }
  if (!isSqliteMode()) return NextResponse.json({ ignored: true }, { headers: NO_STORE });
  ensureRetentionScheduler();
  try {
    const result = await sqlCommand("retention.ack", { canvasId: id, actorId: body.actorId, ackSeq: body.ackSeq, ...(body.storageEpoch !== undefined ? { storageEpoch: body.storageEpoch } : {}) });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string" && STATUS[code]) return NextResponse.json({ error: { code, message: (error as Error).message } }, { status: STATUS[code], headers: NO_STORE });
    throw error;
  }
}
