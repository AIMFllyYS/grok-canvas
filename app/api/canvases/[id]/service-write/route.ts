import { NextResponse } from "next/server";
import { z } from "zod";
import { isSafeCanvasId } from "@/lib/canvas-store";
import { CommandError } from "@/lib/canvas-runtime/command-service";
import { applyServiceWrite, ServiceWriteError, type ServiceWrite } from "@/lib/canvas-runtime/generation-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const id = z.string().min(1).max(256);
const patch = z.record(z.string().min(1).max(64), z.unknown());
const slot = z.union([
  z.object({ status: z.literal("success"), asset: z.object({ name: z.string().min(1).max(256), localUrl: z.string().max(2048).optional(), bytes: z.number().optional() }) }),
  z.object({ status: z.literal("failed"), error: z.string().max(4000) }),
]);
const outcome = z.union([
  z.object({ kind: z.literal("result"), generationId: id, slots: z.array(slot).max(16), retrySlotId: z.union([z.string().max(128), z.null()]), prompt: z.string().max(20000) }),
  z.object({ kind: z.literal("failure"), generationId: id, failureKind: z.enum(["server", "network"]), message: z.string().max(4000).optional() }),
]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), nodeId: id, generationId: id, patch }),
  z.object({ action: z.literal("image"), nodeId: id, outcome }),
  z.object({ action: z.literal("video"), nodeId: id, taskId: z.string().min(1).max(128) }),
  z.object({ action: z.literal("fail"), nodeId: id, generationId: id, patch }),
  z.object({ action: z.literal("select"), nodeId: id, slotId: z.string().min(1).max(128) }),
  z.object({ action: z.literal("task"), nodeId: id, generationId: id, taskId: z.string().min(1).max(128) }),
]);

/**
 * 浏览器的生成回写入口（P2-08）：服务端在锁内构造 apply_generation。成功结果必须能在服务端核验，
 * 浏览器不能用它写任意 service 字段，也不能伪造收费成功。同源守卫由 proxy.ts 统一执行。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: canvasId } = await context.params;
  if (!isSafeCanvasId(canvasId)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400, headers: NO_STORE });
  let body: ServiceWrite;
  try { body = schema.parse(await request.json()) as ServiceWrite; }
  catch { return NextResponse.json({ error: { message: "生成回写参数无效" } }, { status: 400, headers: NO_STORE }); }
  try {
    const result = await applyServiceWrite(canvasId, body);
    if (result.status === "canvas_deleted") return NextResponse.json({ status: result.status }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ status: result.status, revision: result.receipt?.revision ?? null }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ServiceWriteError) return NextResponse.json({ error: { message: error.message } }, { status: error.status, headers: NO_STORE });
    if (error instanceof CommandError) return NextResponse.json(error.toBody(), { status: error.status, headers: NO_STORE });
    throw error;
  }
}
