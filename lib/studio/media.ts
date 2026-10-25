import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  assetToDataUri,
  saveRemoteAsset,
  type GenerationSnapshot,
} from "../assets";
import { dataDir } from "../data-dir";
import { editImage, generateImages, XaiApiError } from "../xai/client";
import { StudioError } from "./store";

type ImageJob = {
  status: "submitting" | "download" | "completed" | "failed" | "expired";
  prompt: string;
  url?: string;
  snapshot?: GenerationSnapshot;
  result?: { assetName: string; localUrl: string };
  error?: string;
};
async function readJob(file: string): Promise<ImageJob | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeJob(file: string, job: ImageJob) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(job));
  await rename(temp, file);
}

/** Persist upstream URLs before downloading; retrying save never resubmits generation. */
export async function recoverImageJob(file: string, job: ImageJob) {
  if (!job.url || !job.snapshot)
    throw new StudioError(
      "图片生成结果尚未确认，禁止自动重复提交。请明确重新生成。",
      409,
    );
  try {
    const saved = await saveRemoteAsset(
      job.url,
      "jpeg",
      async (input, init) => {
        let last: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(input, {
              ...init,
              signal: AbortSignal.timeout(45000),
            });
            if (response.status >= 500 && attempt < 2) {
              await response.body?.cancel();
              continue;
            }
            return response;
          } catch (error) {
            last = error;
            if (attempt < 2)
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
        throw last;
      },
      job.snapshot,
    );
    const result = { assetName: saved.name, localUrl: saved.localUrl };
    await writeJob(file, {
      ...job,
      status: "completed",
      result,
      error: undefined,
    });
    return result;
  } catch (error) {
    const expired =
      error instanceof Error && /\((404|410)\)/.test(error.message);
    await writeJob(file, {
      ...job,
      status: expired ? "expired" : "download",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new StudioError(
      expired
        ? "上次图片结果链接已过期，请确认重新生成。"
        : "图片已生成，但保存尚未成功。再次点击将恢复下载，不会重复生成。",
      expired ? 410 : 502,
    );
  }
}

export async function generateStudioImage(
  prompt: string,
  aspect: string,
  refs: string[] = [],
  key: string,
  force = false,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new StudioError("无效图片任务ID");
  const file = path.join(dataDir(), "studio-image-jobs", `${key}.json`);
  const previous = await readJob(file);
  const sameRequest =
    previous?.prompt === prompt &&
    previous.snapshot?.parameters.aspectRatio === aspect &&
    JSON.stringify(previous.snapshot?.referenceAssets) === JSON.stringify(refs);
  if (previous?.status === "expired" && !force)
    throw new StudioError("上次图片结果链接已过期，请确认重新生成。", 410);
  if (previous?.status === "download") {
    if (sameRequest) return recoverImageJob(file, previous);
    if (!force)
      throw new StudioError(
        "有一份旧图片结果等待保存，当前提示词已改变。请确认重新生成，或恢复原来的提示词后下载。",
        409,
      );
    await writeJob(`${file}.previous-${crypto.randomUUID()}`, previous);
  }
  if (
    previous?.status === "completed" &&
    previous.prompt === prompt &&
    previous.snapshot?.parameters.aspectRatio === aspect &&
    JSON.stringify(previous.snapshot.referenceAssets) ===
      JSON.stringify(refs) &&
    !force &&
    previous.result
  )
    return previous.result;
  if (previous?.status === "submitting" && !force)
    throw new StudioError(
      "上次图片请求的结果尚未确认，不能自动重发。请使用明确的重新生成操作。",
      409,
    );
  const startedAt = new Date().toISOString();
  // The reference order is stable and explicitly described in the prompt.
  const images = await Promise.all(
    refs.slice(0, 5).map(async (name) => ({
      type: "image_url" as const,
      url: await assetToDataUri(name),
    })),
  );
  const model = "grok-imagine-image-2.0";
  await writeJob(file, { status: "submitting", prompt });
  let response;
  try {
    response = images.length
      ? await editImage({
          model,
          prompt,
          images,
          n: 1,
          aspect_ratio: aspect,
          resolution: "1k",
          quality: "low",
        })
      : await generateImages({
          model,
          prompt,
          n: 1,
          aspect_ratio: aspect,
          resolution: "1k",
          quality: "low",
        });
  } catch (error) {
    await writeJob(file, {
      status:
        error instanceof XaiApiError && error.status >= 400
          ? "failed"
          : "submitting",
      prompt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const url = response.data?.[0]?.url;
  if (!url) throw new StudioError("上游没有返回图片链接", 502);
  const job: ImageJob = {
    status: "download",
    prompt,
    url,
    snapshot: {
      originalPrompt: prompt,
      submittedPrompt: prompt,
      model,
      mode: images.length ? "i2i" : "t2i",
      parameters: { aspectRatio: aspect, resolution: "1k", quality: "low" },
      referenceAssets: refs,
      startedAt,
    },
  };
  await writeJob(file, job);
  return recoverImageJob(file, job);
}
