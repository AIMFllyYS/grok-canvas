import { z } from "zod";
import { acquireProduction, loadProject } from "@/lib/studio/store";
import { produce } from "@/lib/studio/production";
import { studioError } from "@/lib/studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params;
    const body = z
      .object({
        action: z.enum([
          "script",
          "reference",
          "storyboard",
          "video",
          "poll",
          "review",
          "export",
        ]),
        targetId: z.string().max(100).optional(),
        force: z.boolean().optional(),
        approved: z.boolean().optional(),
        feedback: z.string().max(3000).optional(),
        kind: z.enum(["image", "video"]).optional(),
      })
      .parse(await request.json());
    release = acquireProduction(id);
    const result = await produce(id, body.action, body, request.signal);
    return Response.json({ project: await loadProject(id), result });
  } catch (error) {
    return studioError(error);
  } finally {
    release?.();
  }
}
