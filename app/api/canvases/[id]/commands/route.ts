import { NextResponse } from "next/server";
import { CommandError, executeCommand, readLimitedBody, toCommandError } from "@/lib/canvas-runtime/command-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 领域命令入口（contracts.md C2）：请求体为单条 CanvasCommand，成功返回 { receipt }。
 * 同源守卫由 proxy.ts 统一执行；apply_generation 等内部命令在 executeCommand 中拒绝。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const text = await readLimitedBody(request);
    let input: unknown;
    try { input = JSON.parse(text); }
    catch { throw new CommandError("invalid_command", "请求体不是有效 JSON"); }
    if (!input || typeof input !== "object" || (input as { canvasId?: unknown }).canvasId !== id) {
      throw new CommandError("invalid_command", "命令所属画布与请求路径不一致");
    }
    const receipt = await executeCommand(input, { origin: "client" });
    return NextResponse.json({ receipt }, { headers: NO_STORE });
  } catch (error) {
    const known = toCommandError(error);
    if (!known) throw error;
    return NextResponse.json(known.toBody(), { status: known.status, headers: NO_STORE });
  }
}
