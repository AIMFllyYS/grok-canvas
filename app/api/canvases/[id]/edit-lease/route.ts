import { NextResponse } from "next/server";
import { z } from "zod";
import { isSafeCanvasId, withExistingCanvas } from "@/lib/canvas-store";
import { getLeaseService, LEASE_RENEW_MS, LEASE_TTL_MS } from "@/lib/canvas-runtime/lease-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const owner = z.string().min(1).max(128);
const action = z.enum(["claim", "renew", "release"]);
const single = z.object({
  nodeId: z.string().min(1).max(256),
  field: z.enum(["geometry", "content", "prompt"]),
  owner,
  action,
  token: z.string().uuid().optional(),
});
/** 拖动群组：一次给多个节点加 geometry 租约（P2-06），整批成功或整批回滚。 */
const batch = z.object({
  nodeIds: z.array(z.string().min(1).max(256)).min(1).max(500),
  field: z.literal("geometry"),
  owner,
  action,
  tokens: z.record(z.string(), z.string().uuid()).optional(),
});

/**
 * 字段租约（contracts.md C3）：claim 返回 token；renew/release 必须带 owner+token。
 * 旧客户端不带 token 的 claim 会续期自己持有的租约，release 只能释放自己 owner 的租约。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400 });
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return NextResponse.json({ error: { message: "编辑占用参数无效" } }, { status: 400 }); }
  const isBatch = !!raw && typeof raw === "object" && "nodeIds" in raw;
  const parsed = isBatch ? batch.safeParse(raw) : single.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: { message: "编辑占用参数无效" } }, { status: 400 });
  const leases = getLeaseService();
  const rejected = { ok: false as const };
  const result = await withExistingCanvas(id, doc => {
    const exists = (nodeId: string) => doc.nodes.some(node => typeof node === "object" && node !== null && "id" in node && node.id === nodeId);
    if (isBatch) {
      const body = parsed.data as z.infer<typeof batch>;
      const nodeIds = [...new Set(body.nodeIds)];
      if (body.action === "release") {
        for (const nodeId of nodeIds) leases.release(id, nodeId, "geometry", body.owner, body.tokens?.[nodeId]);
        return { ok: true as const };
      }
      if (body.action === "renew") {
        if (!body.tokens || nodeIds.some(nodeId => !body.tokens![nodeId])) return rejected;
        const failed = nodeIds.filter(nodeId => !leases.renew(id, nodeId, "geometry", body.owner, body.tokens![nodeId]!).ok);
        return failed.length ? rejected : { ok: true as const, tokens: body.tokens };
      }
      if (nodeIds.some(nodeId => !exists(nodeId))) return rejected;
      const tokens: Record<string, string> = {};
      for (const nodeId of nodeIds) {
        const acquired = leases.acquire(id, nodeId, "geometry", body.owner);
        if (!acquired.ok) {
          for (const [held, token] of Object.entries(tokens)) leases.release(id, held, "geometry", body.owner, token);
          return rejected;
        }
        tokens[nodeId] = acquired.token;
      }
      return { ok: true as const, tokens };
    }
    const body = parsed.data as z.infer<typeof single>;
    if (body.action === "release") return { ok: true as const, released: leases.release(id, body.nodeId, body.field, body.owner, body.token) };
    if (!exists(body.nodeId)) return rejected;
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
