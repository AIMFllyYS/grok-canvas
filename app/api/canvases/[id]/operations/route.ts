import { NextResponse } from "next/server";
import { z } from "zod";
import { applyCanvasOperations, CanvasOperationConflict, type CanvasOperation } from "@/lib/canvas-operations";
import { isSafeCanvasId, publicCanvas, transformCanvas } from "@/lib/canvas-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const value = z.discriminatedUnion("exists", [z.object({ exists: z.literal(false) }), z.object({ exists: z.literal(true), value: z.unknown() })]);
const operation = z.object({
  id: z.string().uuid(),
  target: z.enum(["canvas", "node", "edge"]),
  entityId: z.string().min(1).max(256).optional(),
  path: z.array(z.string().min(1).max(256)).max(8),
  before: value,
  after: value,
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { kind: "bad_request", message: "bad canvas id" } }, { status: 400 });
  let operations: CanvasOperation[];
  try {
    operations = z.object({ operations: z.array(operation).min(1).max(1000) }).parse(await request.json()).operations as CanvasOperation[];
  } catch {
    return NextResponse.json({ error: { kind: "bad_request", message: "画布操作格式无效" } }, { status: 400 });
  }
  try {
    // SQLite 模式下实体修改转为带前置版本的命令，且只允许用户字段（P3-08 兼容适配）。
    const saved = await transformCanvas(id, doc => applyCanvasOperations(doc, operations), { access: "user" });
    if (!saved) return NextResponse.json({ error: { kind: "not_found", message: "画布不存在" } }, { status: 404 });
    return NextResponse.json(publicCanvas(saved));
  } catch (error) {
    if (error instanceof CanvasOperationConflict) {
      const conflict = operations.find(op => op.id === error.operationId);
      return NextResponse.json({ error: { kind: "operation_conflict", message: conflict ? `${error.message}（${conflict.path.join(".") || conflict.target}）` : error.message, operationId: error.operationId } }, { status: 409 });
    }
    // SQLite 模式的兼容适配错误按 code/name 识别（路由不静态引入数据库模块）。
    const failure = error as { code?: unknown; name?: unknown; message?: string; status?: unknown };
    if (failure?.code === "field_conflict" || failure?.code === "lease_conflict") return NextResponse.json({ error: { kind: "operation_conflict", message: failure.message } }, { status: 409 });
    if (failure?.name === "LegacyWriteError") return NextResponse.json({ error: { kind: "bad_request", message: failure.message } }, { status: typeof failure.status === "number" ? failure.status : 400 });
    throw error;
  }
}
