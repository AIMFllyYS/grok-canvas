import { compilePrompt } from "@/lib/prompt-references";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-error";
import { assetToDataUri } from "@/lib/assets";
import { validateImageReferences } from "@/lib/canvas-references";
import { persistImageBatch } from "@/lib/generation-batch";
import { isGenerationCount, parseGenerationCount } from "@/lib/multi-image";
import { editImage, generateImages } from "@/lib/xai/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MODEL = "grok-imagine-image-2.0";

type Body = {
  prompt?: string;
  aspect_ratio?: string;
  resolution?: string;
  quality?: string;
  count?: unknown;
  /** stored asset names used as edit references (max 5) */
  referenceAssets?: string[];
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: { kind: "bad_request", message: "invalid JSON" } }, { status: 400 });
  }
  if (!body || typeof body !== "object" || typeof body.prompt !== "string"
    || (body.referenceAssets !== undefined && (!Array.isArray(body.referenceAssets) || body.referenceAssets.some(name => typeof name !== "string")))
    || [body.aspect_ratio, body.resolution, body.quality].some(value => value !== undefined && typeof value !== "string")) {
    return NextResponse.json({ error: { kind: "bad_request", message: "invalid generation parameters" } }, { status: 400 });
  }
  if (body.count !== undefined && !isGenerationCount(body.count)) {
    return NextResponse.json({ error: { kind: "bad_request", message: "count must be 1, 2 or 4" } }, { status: 400 });
  }
  const count = parseGenerationCount(body.count);
  const originalPrompt = body.prompt;
  const prompt = originalPrompt.trim();
  if (!prompt) {
    return NextResponse.json({ error: { kind: "bad_request", message: "prompt is required" } }, { status: 400 });
  }

  let refs: string[];
  let compiledPrompt: string;
  try {
    refs = validateImageReferences(body.referenceAssets ?? []);
    compiledPrompt = compilePrompt(prompt, refs);
  } catch (error) {
    return NextResponse.json({ error: { kind: "bad_request", message: (error as Error).message } }, { status: 400 });
  }
  const extras = {
    ...(body.aspect_ratio && body.aspect_ratio !== "auto" ? { aspect_ratio: body.aspect_ratio } : {}),
    ...(body.resolution ? { resolution: body.resolution } : {}),
    quality: body.quality === "medium" ? "medium" : "low",
  };

  try {
    const response = refs.length > 0
      ? await editImage({
          model: MODEL,
          prompt: compiledPrompt,
          ...(refs.length === 1
            ? { image: { type: "image_url" as const, url: await assetToDataUri(refs[0]!) } }
            : {
                images: await Promise.all(
                  refs.map(async (name) => ({ type: "image_url" as const, url: await assetToDataUri(name) })),
                ),
              }),
          n: count,
          ...extras,
        })
      : await generateImages({ model: MODEL, prompt, n: count, ...extras });

    const images = (response.data ?? [])
      .map((item) => item?.url)
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => ({ url }));
    const slots = await persistImageBatch(images, count, {
      originalPrompt,
      submittedPrompt: refs.length > 0 ? compiledPrompt : prompt,
      model: MODEL,
      mode: refs.length > 0 ? "i2i" : "t2i",
      parameters: {
        aspectRatio: extras.aspect_ratio ?? null,
        resolution: extras.resolution ?? null,
        quality: extras.quality,
      },
      referenceAssets: [...refs],
      startedAt: new Date(startedAt).toISOString(),
    });
    return NextResponse.json({
      requested: count,
      mode: refs.length > 0 ? "i2i" : "t2i",
      usage: response.usage ?? null,
      durationMs: Date.now() - startedAt,
      slots,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
