import { NextResponse } from "next/server";
import { isSafeCanvasId } from "@/lib/canvas-store";
import { recoverToolCalls } from "@/lib/agent/run-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Agent 工具调用的持久状态（P5-01/P5-04）：GET ?canvasId=…；读取时把进程已不在的中间态收敛为 unknown/failed。 */
export async function GET(request: Request) {
  const canvasId = new URL(request.url).searchParams.get("canvasId") ?? "";
  if (!isSafeCanvasId(canvasId)) return NextResponse.json({ error: { code: "invalid_request", message: "画布 ID 无效" } }, { status: 400 });
  const records = await recoverToolCalls(canvasId);
  return NextResponse.json({ records }, { headers: { "Cache-Control": "no-store" } });
}
