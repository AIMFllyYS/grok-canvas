import { NextResponse } from "next/server";
import { isLibraryAsset } from "@/lib/canvas-library";
import { deleteCanvas, isSafeCanvasId, saveCanvas, saveLastCanvasId, type CanvasDoc } from "@/lib/canvas-store";
import { agentBusy } from "@/lib/agent/store";
import { recoverStaleGenerationClaims } from "@/lib/generation-claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "bad canvas id" } }, { status: 400 });
  }
  const doc = await recoverStaleGenerationClaims(id);
  if (!doc) {
    return NextResponse.json({ error: { kind: "not_found", message: "canvas not found" } }, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  if (params.get("background") !== "1") await saveLastCanvasId(id);
  const revision = params.get("sinceRevision");
  if (revision !== null && /^\d+$/.test(revision) && Number(revision) === doc.revision) return new Response(null, { status: 304, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(doc, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request, context: Params) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "bad canvas id" } }, { status: 400 });
  }
  let body: { revision?: number } & Partial<CanvasDoc>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: { kind: "bad_request", message: "invalid JSON" } }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof body.revision !== "number" || !Number.isInteger(body.revision)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "revision is required" } }, { status: 400 });
  }
  if (body.libraryAssets !== undefined && (!Array.isArray(body.libraryAssets) || !body.libraryAssets.every(isLibraryAsset))) {
    return NextResponse.json({ error: { kind: "bad_request", message: "素材目录格式无效" } }, { status: 400 });
  }
  const saved = await saveCanvas(
    {
      id,
      name: typeof body.name === "string" && body.name.trim() ? body.name : "未命名画布",
      schemaVersion: 1,
      createdAt: body.createdAt ?? new Date().toISOString(),
      viewport: body.viewport ?? { x: 0, y: 0, zoom: 1 },
      nodes: Array.isArray(body.nodes) ? body.nodes : [],
      edges: Array.isArray(body.edges) ? body.edges : [],
      ...(body.libraryAssets !== undefined ? { libraryAssets: body.libraryAssets } : {}),
    },
    body.revision,
  );
  if (!saved) {
    return NextResponse.json(
      { error: { kind: "revision_conflict", message: "画布已被更新的版本占用，请刷新" } },
      { status: 409 },
    );
  }
  return NextResponse.json(saved);
}

export async function DELETE(_request: Request, context: Params) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "bad canvas id" } }, { status: 400 });
  }
  try {
    await deleteCanvas(id, () => !agentBusy(id));
  } catch (error) {
    if (error instanceof Error && error.message === "画布 Agent 正在运行，请先停止") return NextResponse.json({ error: { kind: "agent_busy", message: error.message } }, { status: 409 });
    throw error;
  }
  return NextResponse.json({ ok: true });
}
