import { z } from "zod";
import { access } from "node:fs/promises";
import { assetPath, isSafeAssetName } from "@/lib/assets";
import {
  acquireProduction,
  isProducing,
  loadProject,
  StudioError,
  updateProject,
} from "@/lib/studio/store";
import {
  bilingual,
  shotSchema,
  validatePlan,
  invalidateShotImage,
} from "@/lib/studio/schema";
import { syncProjectCanvas } from "@/lib/studio/canvas";
import { studioError } from "@/lib/studio/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, context: Context) {
  try {
    const { id } = await context.params;
    return Response.json(
      { ...(await loadProject(id)), producing: isProducing(id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return studioError(error);
  }
}
const sourceSchema = z.object({
  id: z.string().max(100),
  name: z.string().max(300),
  kind: z.enum(["text", "image", "video"]),
  text: z.string().max(120000),
  analyzed: z.boolean().optional(),
  assetName: z.string().refine(isSafeAssetName).optional(),
  frames: z
    .array(
      z.object({
        assetName: z.string().refine(isSafeAssetName),
        at: z.number().nonnegative(),
      }),
    )
    .max(3)
    .optional(),
});
const patchSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(160).optional(),
  brief: z.string().max(60000).optional(),
  aspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  targetDuration: z.number().int().min(6).max(600).optional(),
  style: bilingual.optional(),
  negative: bilingual.optional(),
  script: z.string().max(80000).optional(),
  source: sourceSchema.optional(),
  removeSource: z.string().max(100).optional(),
  shot: shotSchema.optional(),
  referenceApproval: z
    .object({ id: z.string(), approved: z.boolean() })
    .optional(),
});
export async function PATCH(request: Request, context: Context) {
  let release: (() => void) | undefined;
  try {
    const { id } = await context.params,
      body = patchSchema.parse(await request.json());
    release = acquireProduction(id);
    if (body.source?.assetName) await access(assetPath(body.source.assetName));
    const saved = await updateProject(
      id,
      (p) => {
        const visualChange =
          (body.style !== undefined &&
            JSON.stringify(body.style) !== JSON.stringify(p.style)) ||
          (body.negative !== undefined &&
            JSON.stringify(body.negative) !== JSON.stringify(p.negative)) ||
          (body.aspect !== undefined && body.aspect !== p.aspect);
        if (p.shots.some((s) => s.taskId) && (body.shot || visualChange))
          throw new StudioError(
            "视频正在生成，请等待完成后再修改画面规范",
            409,
          );
        if (visualChange && p.shots.some((s) => s.videoApproved))
          throw new StudioError("修改全片画面规范前，请先撤销已完成视频的验收");
        for (const key of [
          "title",
          "brief",
          "aspect",
          "targetDuration",
          "style",
          "negative",
          "script",
        ] as const) {
          if (body[key] !== undefined) Object.assign(p, { [key]: body[key] });
        }
        if (body.source) {
          if (p.sources.length >= 50)
            throw new StudioError("每个导演台最多50份素材");
          p.sources.push(body.source);
        }
        if (body.removeSource)
          p.sources = p.sources.filter((s) => s.id !== body.removeSource);
        if (body.referenceApproval) {
          const ref = p.references.find(
            (r) => r.id === body.referenceApproval!.id,
          );
          if (!ref) throw new StudioError("参考图不存在");
          if (body.referenceApproval.approved && !ref.assetName)
            throw new StudioError("请先生成参考图");
          ref.approved = body.referenceApproval.approved;
        }
        if (body.shot) {
          const index = p.shots.findIndex((s) => s.id === body.shot!.id);
          if (index < 0) throw new StudioError("分镜不存在");
          const old = p.shots[index]!;
          if (old.videoApproved)
            throw new StudioError("请先撤销视频验收再修改分镜");
          p.shots[index] = {
            ...old,
            ...body.shot,
            imageApproved: false,
            videoApproved: false,
          };
          invalidateShotImage(p.shots[index]!);
        }
        if (visualChange) {
          p.shots.forEach(invalidateShotImage);
          for (const ref of p.references) {
            if (ref.assetName)
              ref.history = [
                ...new Set([...(ref.history ?? []), ref.assetName]),
              ];
            ref.assetName = undefined;
            ref.approved = false;
          }
          p.exportSignature = undefined;
        }
        if (p.shots.length) {
          const errors = validatePlan(p);
          if (errors.length) throw new StudioError(errors.join("；"), 422);
        }
      },
      body.revision,
    );
    await syncProjectCanvas(saved);
    return Response.json(saved);
  } catch (error) {
    return studioError(error);
  } finally {
    release?.();
  }
}
