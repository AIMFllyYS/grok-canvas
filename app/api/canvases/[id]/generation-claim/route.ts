import { NextResponse } from "next/server";
import { z } from "zod";
import { isSafeCanvasId } from "@/lib/canvas-store";
import { acknowledgeUnknownGeneration, claimGeneration, finishGeneration, GenerationClaimError } from "@/lib/generation-claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ nodeId: z.string().min(1).max(256), id: z.string().uuid(), action: z.enum(["claim", "complete", "unknown", "acknowledge"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400 });
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); }
  catch { return NextResponse.json({ error: { message: "生成占用参数无效" } }, { status: 400 }); }
  try {
    if (body.action === "claim") await claimGeneration(id, body.nodeId, body.id);
    else if (body.action === "acknowledge") await acknowledgeUnknownGeneration(id, body.nodeId, body.id);
    else await finishGeneration(id, body.nodeId, body.id, body.action === "complete" ? "completed" : "unknown");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GenerationClaimError) return NextResponse.json({ error: { kind: "generation_conflict", message: error.message } }, { status: 409 });
    throw error;
  }
}
