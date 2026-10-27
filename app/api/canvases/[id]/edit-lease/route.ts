import { NextResponse } from "next/server";
import { z } from "zod";
import { isSafeCanvasId, withExistingCanvas } from "@/lib/canvas-store";
import { claimEditLease, releaseEditLease, EDIT_LEASE_MS } from "@/lib/canvas-edit-leases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ nodeId: z.string().min(1).max(256), field: z.enum(["content", "prompt"]), owner: z.string().uuid(), action: z.enum(["claim", "release"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400 });
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); }
  catch { return NextResponse.json({ error: { message: "编辑占用参数无效" } }, { status: 400 }); }
  const result = await withExistingCanvas(id, doc => {
    if (!doc.nodes.some(node => typeof node === "object" && node !== null && "id" in node && node.id === body.nodeId)) return false;
    if (body.action === "release") { releaseEditLease(id, body.nodeId, body.field, body.owner); return true; }
    return claimEditLease(id, body.nodeId, body.field, body.owner);
  });
  if (result === null) return NextResponse.json({ error: { message: "画布不存在" } }, { status: 404 });
  if (!result) return NextResponse.json({ error: { message: "节点正在其他位置编辑或已删除" } }, { status: 409 });
  return NextResponse.json({ ok: true, expiresInMs: EDIT_LEASE_MS });
}
