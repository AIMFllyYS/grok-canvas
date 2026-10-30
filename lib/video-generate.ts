import { isSafeAssetName, type VideoGenerationSnapshot } from "./assets";
import {
  createVideoTask,
  isTerminalVideoTask,
  readVideoTask,
  recoverableVideoTasks,
  updateVideoTask,
  type VideoTaskRecord,
  type VideoTaskResult,
  type VideoTaskStatus,
} from "./video-tasks";
import { buildVideoRequest, type VideoParameters, type VideoRequestPlan } from "./video-request";
import type { VideoInput, VideoInputRole } from "./video-references";

const FAILED_UPSTREAM = new Set(["failed", "expired", "error", "cancelled"]);
const GONE_DOWNLOAD = new Set([404, 410]);
const INPUT_ROLES = new Set<VideoInputRole>(["first", "last", "reference"]);

export class VideoRequestError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = "VideoRequestError";
    this.httpStatus = httpStatus;
  }
}

export type VideoUpstreamStatus = {
  status: string;
  video?: { url?: string };
};

export type VideoGenerateDeps = {
  createGeneration: (body: Record<string, unknown>) => Promise<{ request_id?: string }>;
  getGeneration: (requestId: string) => Promise<VideoUpstreamStatus>;
  toDataUri: (name: string) => Promise<string>;
  saveRemote: (url: string, snapshot: VideoGenerationSnapshot) => Promise<{ name: string; localUrl: string; bytes: number }>;
  verifyClaim?: (canvasId: string, nodeId: string, id: string) => Promise<void>;
  finishClaim?: (canvasId: string, nodeId: string, id: string, state: "completed" | "unknown") => Promise<void>;
  attachClaim?: (canvasId: string, nodeId: string, id: string, taskId: string) => Promise<void>;
};

/** 任务快照 → 视频生成记录：生成信息面板凭它解释「当时引用了谁」。 */
export function videoSnapshotFromPlan(plan: VideoRequestPlan, startedAt: string): VideoGenerationSnapshot {
  return {
    originalPrompt: plan.prompt,
    submittedPrompt: plan.compiledPrompt,
    model: plan.model,
    mode: plan.mode,
    parameters: {
      duration: plan.parameters.duration,
      aspectRatio: plan.parameters.aspectRatio,
      resolution: plan.parameters.resolution,
      audio: plan.parameters.audio,
    },
    referenceAssets: [...plan.references],
    firstFrame: plan.firstFrame,
    lastFrame: plan.lastFrame,
    startedAt,
  };
}

export type VideoTaskView = {
  taskId: string;
  requestId: string;
  canvasId: string;
  nodeId: string;
  generationId?: string;
  status: VideoTaskStatus;
  waitedSeconds: number;
  result: VideoTaskResult | null;
  error: string | null;
};

export async function submitVideoGeneration(
  body: unknown,
  deps: VideoGenerateDeps,
): Promise<{ taskId: string; requestId: string }> {
  const parsed = parseSubmitBody(body);
  let plan: VideoRequestPlan;
  try {
    plan = buildVideoRequest(parsed.prompt, parsed.inputs, parsed.parameters);
  } catch (error) {
    throw new VideoRequestError(error instanceof Error ? error.message : String(error));
  }

  const upstream = await upstreamBody(plan, deps);
  if (parsed.claim) {
    if (!deps.verifyClaim) throw new VideoRequestError("无法确认生成任务占用", 409);
    await deps.verifyClaim(parsed.canvasId, parsed.claim.nodeId, parsed.claim.id);
  }
  let created: { request_id?: string };
  try { created = await deps.createGeneration(upstream); }
  catch (error) {
    if (parsed.claim) await deps.finishClaim?.(parsed.canvasId, parsed.claim.nodeId, parsed.claim.id, "unknown");
    throw error;
  }
  const requestId = created?.request_id;
  if (typeof requestId !== "string" || !requestId) {
    throw new VideoRequestError("上游未返回 request_id", 502);
  }

  const record = await createVideoTask(requestId, parsed.canvasId, parsed.nodeId, plan, parsed.claim);
  if (parsed.claim) await deps.attachClaim?.(parsed.canvasId, parsed.claim.nodeId, parsed.claim.id, record.taskId);
  return { taskId: record.taskId, requestId: record.requestId };
}

export async function pollVideoTask(taskId: string, deps: VideoGenerateDeps): Promise<VideoTaskView> {
  let record: VideoTaskRecord | null;
  try {
    record = await readVideoTask(taskId);
  } catch (error) {
    if (error instanceof Error && error.message === "unsafe task id") {
      throw new VideoRequestError("视频任务不存在", 404);
    }
    throw error;
  }
  if (!record) throw new VideoRequestError("视频任务不存在", 404);
  return advanceVideoTask(record, deps);
}

export async function recoverVideoTasks(deps: VideoGenerateDeps): Promise<VideoTaskView[]> {
  const tasks = await recoverableVideoTasks();
  const views: VideoTaskView[] = [];
  for (const task of tasks) {
    try {
      views.push(await advanceVideoTask(task, deps));
    } catch (error) {
      views.push({
        ...toView(task),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return views;
}

async function advanceVideoTask(record: VideoTaskRecord, deps: VideoGenerateDeps): Promise<VideoTaskView> {
  const view = isTerminalVideoTask(record) ? toView(record)
    : record.status === "save_failed" ? await retryDownload(record, deps)
    : record.status === "pending" ? await pollPending(record, deps)
    : toView(record);
  if (record.claim && !record.claimReleased && deps.finishClaim && (view.status === "completed" || view.status === "failed" || view.status === "expired")) {
    await deps.finishClaim(record.canvasId, record.claim.nodeId, record.claim.id, "completed");
    await updateVideoTask(record.taskId, { claimReleased: true });
  }
  return view;
}

async function pollPending(record: VideoTaskRecord, deps: VideoGenerateDeps): Promise<VideoTaskView> {
  const upstream = await deps.getGeneration(record.requestId);
  if (FAILED_UPSTREAM.has(upstream.status)) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "failed",
        error: `上游生成失败（${upstream.status}）`,
      }),
    );
  }
  const remoteUrl = upstream.video?.url;
  if (upstream.status !== "done") return toView(record);
  if (typeof remoteUrl !== "string" || !remoteUrl) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "failed",
        error: "上游已完成但未返回视频地址",
      }),
    );
  }

  const saved = await persistVideo(remoteUrl, record, deps);
  if (saved.ok) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "completed",
        remoteUrl,
        result: saved.result,
        error: null,
      }),
    );
  }
  return toView(
    await updateVideoTask(record.taskId, {
      status: "save_failed",
      remoteUrl,
      error: saved.error,
    }),
  );
}

async function retryDownload(record: VideoTaskRecord, deps: VideoGenerateDeps): Promise<VideoTaskView> {
  const remoteUrl = record.remoteUrl;
  if (typeof remoteUrl !== "string" || !remoteUrl) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "expired",
        error: "临时链接已过期，无法恢复",
      }),
    );
  }

  const saved = await persistVideo(remoteUrl, record, deps);
  if (saved.ok) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "completed",
        remoteUrl,
        result: saved.result,
        error: null,
      }),
    );
  }
  if (saved.status !== null && GONE_DOWNLOAD.has(saved.status)) {
    return toView(
      await updateVideoTask(record.taskId, {
        status: "expired",
        remoteUrl,
        error: "临时链接已过期，无法恢复",
      }),
    );
  }
  return toView(
    await updateVideoTask(record.taskId, {
      status: "save_failed",
      remoteUrl,
      error: saved.error,
    }),
  );
}

async function persistVideo(
  url: string,
  record: VideoTaskRecord,
  deps: VideoGenerateDeps,
): Promise<{ ok: true; result: VideoTaskResult } | { ok: false; status: number | null; error: string }> {
  try {
    const saved = await deps.saveRemote(url, videoSnapshotFromPlan(record.snapshot, record.createdAt));
    return {
      ok: true,
      result: { assetName: saved.name, localUrl: saved.localUrl, bytes: saved.bytes },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: downloadStatus(message), error: `视频保存失败：${message}` };
  }
}

function downloadStatus(message: string): number | null {
  const match = message.match(/\((\d{3})\)/);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/** 任务记录 → 视图（服务端结果登记据此生成节点补丁，不信任浏览器传来的视图）。 */
export function videoTaskView(record: VideoTaskRecord): VideoTaskView {
  return toView(record);
}

function toView(record: VideoTaskRecord): VideoTaskView {
  return {
    taskId: record.taskId,
    requestId: record.requestId,
    canvasId: record.canvasId,
    nodeId: record.nodeId,
    ...(record.claim ? { generationId: record.claim.id } : {}),
    status: record.status,
    waitedSeconds: waitedSeconds(record.createdAt),
    result: record.result,
    error: record.error,
  };
}

function waitedSeconds(createdAt: string): number {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

async function upstreamBody(plan: VideoRequestPlan, deps: VideoGenerateDeps): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: plan.model,
    prompt: plan.compiledPrompt,
    duration: plan.parameters.duration,
    resolution: plan.parameters.resolution,
    generate_audio: plan.parameters.audio,
  };
  if (plan.parameters.aspectRatio !== null) {
    body.aspect_ratio = plan.parameters.aspectRatio;
  }
  if (plan.firstFrame) {
    body.image = { url: await dataUri(plan.firstFrame, deps) };
  }
  if (plan.lastFrame) {
    body.last_frame = { url: await dataUri(plan.lastFrame, deps) };
  }
  if (plan.references.length > 0) {
    body.reference_images = await Promise.all(
      plan.references.map(async (name) => ({ url: await dataUri(name, deps) })),
    );
  }
  return body;
}

async function dataUri(name: string, deps: VideoGenerateDeps): Promise<string> {
  if (!isSafeAssetName(name)) throw new VideoRequestError(`素材名不合法：${name}`);
  try {
    return await deps.toDataUri(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VideoRequestError(`素材不存在：${name}`);
    }
    throw error;
  }
}

function parseSubmitBody(body: unknown): {
  prompt: string;
  canvasId: string;
  nodeId: string;
  claim?: { nodeId: string; id: string };
  inputs: VideoInput[];
  parameters: VideoParameters;
} {
  if (!body || typeof body !== "object") throw new VideoRequestError("无效的请求体");
  const record = body as Record<string, unknown>;
  if (typeof record.prompt !== "string") throw new VideoRequestError("提示词不能为空");
  if (typeof record.canvasId !== "string" || !record.canvasId.trim()) {
    throw new VideoRequestError("缺少画布 ID");
  }
  if (typeof record.nodeId !== "string" || !record.nodeId.trim()) {
    throw new VideoRequestError("缺少节点 ID");
  }
  let claim: { nodeId: string; id: string } | undefined;
  if (record.claim !== undefined) {
    if (!record.claim || typeof record.claim !== "object") throw new VideoRequestError("生成占用无效");
    const value = record.claim as Record<string, unknown>;
    if (typeof value.nodeId !== "string" || !value.nodeId || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new VideoRequestError("生成占用无效");
    claim = { nodeId: value.nodeId, id: value.id };
  }
  return {
    prompt: record.prompt,
    canvasId: record.canvasId.trim(),
    nodeId: record.nodeId.trim(),
    ...(claim ? { claim } : {}),
    inputs: parseInputs(record.inputs),
    parameters: parseParameters(record.parameters),
  };
}

function parseInputs(value: unknown): VideoInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new VideoRequestError("inputs 必须是数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new VideoRequestError(`inputs[${index}] 无效`);
    const record = item as Record<string, unknown>;
    if (typeof record.assetName !== "string" || !record.assetName) {
      throw new VideoRequestError(`inputs[${index}] 缺少素材名`);
    }
    if (typeof record.role !== "string" || !INPUT_ROLES.has(record.role as VideoInputRole)) {
      throw new VideoRequestError("输入角色只支持 first / last / reference");
    }
    return { assetName: record.assetName, role: record.role as VideoInputRole };
  });
}

function parseParameters(value: unknown): VideoParameters {
  if (!value || typeof value !== "object") throw new VideoRequestError("缺少生成参数");
  const record = value as Record<string, unknown>;
  if (typeof record.duration !== "number") throw new VideoRequestError("缺少时长");
  if (record.aspectRatio !== null && typeof record.aspectRatio !== "string") {
    throw new VideoRequestError("缺少视频比例");
  }
  if (typeof record.resolution !== "string") throw new VideoRequestError("缺少分辨率");
  if (typeof record.audio !== "boolean") throw new VideoRequestError("缺少音频开关");
  return {
    duration: record.duration as VideoParameters["duration"],
    aspectRatio: record.aspectRatio as VideoParameters["aspectRatio"],
    resolution: record.resolution as VideoParameters["resolution"],
    audio: record.audio,
  };
}
