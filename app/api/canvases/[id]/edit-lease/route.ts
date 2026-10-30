import { NextResponse } from "next/server";
import { z } from "zod";
import { isSafeCanvasId, withExistingCanvas } from "@/lib/canvas-store";
import { getLeaseService, LEASE_RENEW_MS, LEASE_TTL_MS } from "@/lib/canvas-runtime/lease-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({
  nodeId: z.string().min(1).max(256),
  field: z.enum(["geometry", "content", "prompt"]),
  owner: z.string().min(1).max(128),
  action: z.enum(["claim", "renew", "release"]),
  token: z.string().uuid().optional(),
});

/**
 * 字段租约（contracts.md C3）：claim 返回 token；renew/release 必须带 owner+token。
 * 旧客户端不带 token 的 claim 会续期自己持有的租约，release 只能释放自己 owner 的租约。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400 });
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); }
  catch { return NextResponse.json({ error: { message: "编辑占用参数无效" } }, { status: 400 }); }
  const leases = getLeaseService();
  const rejected = { ok: false as const };
  const result = await withExistingCanvas(id, doc => {
    if (body.action === "release") return { ok: true as const, released: leases.release(id, body.nodeId, body.field, body.owner, body.token) };
    if (!doc.nodes.some(node => typeof node === "object" && node !== null && "id" in node && node.id === body.nodeId)) return rejected;
    if (body.action === "renew") {
      if (!body.token) return rejected;
      const renewed = leases.renew(id, body.nodeId, body.field, body.owner, body.token);
      return renewed.ok ? { ok: true as const, token: body.token } : rejected;
    }
    const acquired = leases.acquire(id, body.nodeId, body.field, body.owner);
    return acquired.ok ? { ok: true as const, token: acquired.token } : rejected;
  });
  if (result === null) return NextResponse.json({ error: { message: "画布不存在" } }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: { message: "节点正在其他位置编辑或已删除" } }, { status: 409 });
  return NextResponse.json({ ...result, expiresInMs: LEASE_TTL_MS, renewEveryMs: LEASE_RENEW_MS });
}
