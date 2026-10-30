import { NextResponse } from "next/server";
import { isSafeCanvasId } from "@/lib/canvas-store";
import { loadEntitySnapshot } from "@/lib/canvas-runtime/json-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 带版本的实体快照（contracts.md C1）：客户端用它取得 move_nodes 的 expectedVersion 与服务端几何。
 * `?fields=geometry` 省略正文，只给几何命令与冲突仲裁使用，避免长文本画布加载两遍正文。
 * 同源守卫由 proxy.ts 统一执行。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) return NextResponse.json({ error: { message: "画布 ID 无效" } }, { status: 400, headers: NO_STORE });
  const snapshot = await loadEntitySnapshot(id);
  if (!snapshot) return NextResponse.json({ error: { message: "画布不存在" } }, { status: 404, headers: NO_STORE });
  const geometryOnly = new URL(request.url).searchParams.get("fields") === "geometry";
  const body = geometryOnly ? { ...snapshot, documents: snapshot.documents.map(document => ({ ...document, content: "" })), contentOmitted: true } : snapshot;
  return NextResponse.json(body, { headers: NO_STORE });
}
