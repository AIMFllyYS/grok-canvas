import { NextResponse } from "next/server";
import { z } from "zod";
import { applyCanvasOperations, CanvasOperationConflict, type CanvasOperation } from "@/lib/canvas-operations";
import { isSafeCanvasId, transformCanvas } from "@/lib/canvas-store";

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
    const saved = await transformCanvas(id, doc => applyCanvasOperations(doc, operations));
    if (!saved) return NextResponse.json({ error: { kind: "not_found", message: "画布不存在" } }, { status: 404 });
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof CanvasOperationConflict) {
      const conflict = operations.find(op => op.id === error.operationId);
      return NextResponse.json({ error: { kind: "operation_conflict", message: conflict ? `${error.message}（${conflict.path.join(".") || conflict.target}）` : error.message, operationId: error.operationId } }, { status: 409 });
    }
    throw error;
  }
}
