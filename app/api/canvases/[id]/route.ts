import { NextResponse } from "next/server";
import { isLibraryAsset } from "@/lib/canvas-library";
import { deleteCanvas, isSafeCanvasId, loadCanvas, saveCanvas, saveLastCanvasId, type CanvasDoc } from "@/lib/canvas-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params) {
  const { id } = await context.params;
  if (!isSafeCanvasId(id)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "bad canvas id" } }, { status: 400 });
  }
  const doc = await loadCanvas(id);
  if (!doc) {
    return NextResponse.json({ error: { kind: "not_found", message: "canvas not found" } }, { status: 404 });
  }
  if (new URL(request.url).searchParams.get("background") !== "1") await saveLastCanvasId(id);
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
  await deleteCanvas(id);
  return NextResponse.json({ ok: true });
}
