import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../data-dir";
import { buildVideoRequest, type VideoRequestPlan } from "../video-request";
import {
  submitVideoGeneration,
  type VideoGenerateDeps,
} from "../video-generate";
import { createVideoTask, readVideoTask } from "../video-tasks";
import { videoUpstream } from "../video-upstream";
import { XaiApiError } from "../xai/client";
import { firstFrameVideoPrompt, type Shot, type StudioProject } from "./schema";
import { StudioError } from "./store";
type Intent = {
  signature: string;
  status: "submitting" | "accepted" | "failed";
  requestId?: string;
  taskId?: string;
  plan?: VideoRequestPlan;
};

/** Journal submission before the paid call, then persist request_id before task linkage. */
export async function submitStudioVideo(
  p: StudioProject,
  shot: Shot,
  force = false,
  deps: VideoGenerateDeps = videoUpstream,
) {
  const file = path.join(
    dataDir(),
    "studio-video-submissions",
    `${p.id}-${shot.id}.json`,
  );
  if (!/^[a-zA-Z0-9_-]+$/.test(p.id) || !/^P\d{2,3}$/.test(shot.id))
    throw new StudioError("无效视频任务标识");
  const inputs = [{ role: "first" as const, assetName: shot.imageAsset! }];
  const parameters = {
    duration: shot.duration,
    aspectRatio: null,
    resolution: "720p" as const,
    audio: false,
  };
  const prompt = firstFrameVideoPrompt(p, shot),
    plan = buildVideoRequest(prompt, inputs, parameters);
  const signature = JSON.stringify({ prompt, inputs, parameters });
  let previous: Intent | undefined;
  try {
    previous = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const write = async (intent: Intent) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(intent));
    await rename(temp, file);
  };
  if (previous?.requestId) {
    const task = previous.taskId ? await readVideoTask(previous.taskId) : null;
    const active = task && ["pending", "save_failed"].includes(task.status);
    if (
      active ||
      (previous.signature === signature && !force) ||
      !previous.taskId
    ) {
      if (task && ["failed", "expired"].includes(task.status))
        throw new StudioError("上次视频任务已失败或过期，请确认重新发起生成");
      const recovered =
        task ??
        (await createVideoTask(
          previous.requestId,
          p.canvasId,
          `studio-${p.id}-video-${shot.id}`,
          previous.plan ?? plan,
        ));
      await write({
        ...previous,
        status: "accepted",
        taskId: recovered.taskId,
      });
      return {
        taskId: recovered.taskId,
        requestId: recovered.requestId,
        recovered: true,
      };
    }
  } else if (previous?.status === "submitting" && !force) {
    throw new StudioError(
      "上次视频提交结果尚未确认，禁止自动重发。请确认后重新发起生成。",
      409,
    );
  }
  let intent: Intent = { signature, status: "submitting", plan };
  await write(intent);
  try {
    const result = await submitVideoGeneration(
      {
        prompt,
        canvasId: p.canvasId,
        nodeId: `studio-${p.id}-video-${shot.id}`,
        inputs,
        parameters,
      },
      {
        ...deps,
        createGeneration: async (body) => {
          const result = await deps.createGeneration(body);
          if (result.request_id) {
            intent = { ...intent, requestId: result.request_id };
            await write(intent);
          }
          return result;
        },
      },
    );
    await write({ ...intent, status: "accepted", taskId: result.taskId });
    return { ...result, recovered: false };
  } catch (error) {
    if (error instanceof XaiApiError && error.status >= 400)
      await write({ ...intent, status: "failed" });
    throw error;
  }
}
