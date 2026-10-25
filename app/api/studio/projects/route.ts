import { z } from "zod";
import { createProject, listProjects } from "@/lib/studio/store";
import { studioError } from "@/lib/studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      { projects: await listProjects() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return studioError(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = z
      .object({ title: z.string().trim().min(1).max(160).optional() })
      .parse(await request.json());
    return Response.json(await createProject(body.title), { status: 201 });
  } catch (error) {
    return studioError(error);
  }
}
