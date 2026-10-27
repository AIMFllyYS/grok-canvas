import type { VideoInput } from "./video-references";
import type { VideoAspectRatio, VideoDuration, VideoResolution } from "./video-request";

export const VIDEO_POLL_INTERVAL_MS = 2000;

export type VideoErrorKind = "server" | "save_failed" | "expired" | "network";

export type VideoTaskView = {
  taskId: string;
  requestId: string;
  canvasId: string;
  nodeId: string;
  generationId?: string;
  status: "pending" | "completed" | "failed" | "save_failed" | "expired";
  waitedSeconds: number;
  result: { assetName: string; localUrl: string; bytes: number } | null;
  error: string | null;
};

export type VideoGenerationRequest = {
  prompt: string;
  duration: VideoDuration;
  aspectRatio: VideoAspectRatio | null;
  resolution: VideoResolution;
  audio: boolean;
  inputs: VideoInput[];
};

export type VideoSubmitBody = {
  prompt: string;
  canvasId: string;
  nodeId: string;
  claim?: { nodeId: string; id: string };
  inputs?: VideoInput[];
  parameters: Omit<VideoGenerationRequest, "inputs">;
};

export function isVideoWatchStopStatus(status: VideoTaskView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "save_failed" || status === "expired";
}

export function videoNodePatchFromView(view: VideoTaskView): Record<string, unknown> {
  if (view.status === "completed" && view.result) {
    return {
      status: "idle",
      assetName: view.result.assetName,
      taskId: view.taskId,
      waitedSeconds: view.waitedSeconds,
      errorMessage: null,
      errorKind: null,
    };
  }
  if (view.status === "save_failed") {
    return {
      status: "failed",
      taskId: view.taskId,
      waitedSeconds: view.waitedSeconds,
      errorMessage: view.error ?? "视频保存失败",
      errorKind: "save_failed",
    };
  }
  if (view.status === "expired") {
    return {
      status: "failed",
      taskId: view.taskId,
      waitedSeconds: view.waitedSeconds,
      errorMessage: view.error ?? "临时链接已过期，无法恢复",
      errorKind: "expired",
    };
  }
  if (view.status === "failed") {
    return {
      status: "failed",
      taskId: view.taskId,
      waitedSeconds: view.waitedSeconds,
      errorMessage: view.error ?? "生成失败",
      errorKind: "server",
    };
  }
  return {
    status: "running",
    taskId: view.taskId,
    waitedSeconds: view.waitedSeconds,
    errorMessage: null,
    errorKind: null,
  };
}

export async function submitVideoJob(
  body: VideoSubmitBody,
  fetchImpl: typeof fetch = fetch,
): Promise<{ taskId: string; requestId: string }> {
  const response = await fetchImpl("/api/generate/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, inputs: body.inputs ?? [] }),
  });
  const payload = (await response.json()) as {
    taskId?: string;
    requestId?: string;
    error?: { kind?: string; message?: string };
  };
  if (!response.ok || typeof payload.taskId !== "string" || typeof payload.requestId !== "string") {
    const error = new Error(payload.error?.message ?? `请求失败 (${response.status})`);
    (error as Error & { kind?: string }).kind = payload.error?.kind;
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return { taskId: payload.taskId, requestId: payload.requestId };
}

export async function fetchVideoTask(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<VideoTaskView> {
  const response = await fetchImpl(`/api/generate/video/${encodeURIComponent(taskId)}`, {
    cache: "no-store",
    signal,
  });
  const payload = (await response.json()) as VideoTaskView & { error?: { kind?: string; message?: string } };
  if (!response.ok || typeof payload.status !== "string") {
    const error = new Error(payload.error?.message ?? `查询失败 (${response.status})`);
    (error as Error & { kind?: string }).kind = payload.error?.kind;
    throw error;
  }
  return payload;
}

export async function recoverVideoJobs(
  fetchImpl: typeof fetch = fetch,
): Promise<VideoTaskView[]> {
  const response = await fetchImpl("/api/generate/video/recover", { method: "POST" });
  const payload = (await response.json()) as { tasks?: VideoTaskView[]; error?: { message?: string } };
  if (!response.ok || !Array.isArray(payload.tasks)) {
    throw new Error(payload.error?.message ?? `恢复失败 (${response.status})`);
  }
  return payload.tasks;
}

type VideoCanvasHandlers = {
  applyVideoView: (nodeId: string, view: VideoTaskView) => void;
};

const liveCanvases = new Map<string, VideoCanvasHandlers>();
const videoOrphans = new Map<string, VideoTaskView>();
const submittedTasks = new Map<string, string>();
const watches = new Map<string, AbortController>();

const orphanKey = (canvasId: string, nodeId: string) => `${canvasId}:${nodeId}`;

export function registerVideoCanvas(canvasId: string, handlers: VideoCanvasHandlers): void {
  liveCanvases.set(canvasId, handlers);
}

export function unregisterVideoCanvas(canvasId: string, handlers: VideoCanvasHandlers): void {
  if (liveCanvases.get(canvasId) === handlers) liveCanvases.delete(canvasId);
}

export function dispatchVideoView(canvasId: string, nodeId: string, view: VideoTaskView): boolean {
  const handlers = liveCanvases.get(canvasId);
  if (!handlers) return false;
  handlers.applyVideoView(nodeId, view);
  return true;
}

export function stashVideoOrphan(canvasId: string, nodeId: string, view: VideoTaskView): void {
  videoOrphans.set(orphanKey(canvasId, nodeId), view);
}

export function takeVideoOrphan(canvasId: string, nodeId: string): VideoTaskView | undefined {
  const key = orphanKey(canvasId, nodeId);
  const view = videoOrphans.get(key);
  if (view) videoOrphans.delete(key);
  return view;
}

export function rememberSubmittedVideoTask(canvasId: string, nodeId: string, taskId: string): void {
  submittedTasks.set(orphanKey(canvasId, nodeId), taskId);
}

export function submittedVideoTask(canvasId: string, nodeId: string): string | undefined {
  return submittedTasks.get(orphanKey(canvasId, nodeId));
}

function watchKey(canvasId: string, nodeId: string): string {
  return `${canvasId}:${nodeId}`;
}

export function isWatchingVideo(canvasId: string, nodeId: string): boolean {
  return watches.has(watchKey(canvasId, nodeId));
}

export function stopWatchingVideo(canvasId: string, nodeId: string): void {
  const key = watchKey(canvasId, nodeId);
  const controller = watches.get(key);
  if (!controller) return;
  controller.abort();
  watches.delete(key);
}

export function watchVideoTask(
  canvasId: string,
  nodeId: string,
  taskId: string,
  onView: (view: VideoTaskView) => void,
  fetchImpl: typeof fetch = fetch,
): void {
  const key = watchKey(canvasId, nodeId);
  if (watches.has(key)) return;
  const controller = new AbortController();
  watches.set(key, controller);
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          const view = await fetchVideoTask(taskId, fetchImpl, controller.signal);
          if (controller.signal.aborted) return;
          onView(view);
          if (isVideoWatchStopStatus(view.status)) return;
        } catch (error) {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          const kind = (error as { kind?: string }).kind;
          if (kind === "not_logged_in" || kind === "not_found") {
            onView({
              taskId,
              requestId: "",
              canvasId,
              nodeId,
              status: "failed",
              waitedSeconds: 0,
              result: null,
              error: kind === "not_logged_in" ? "请先登录" : error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
        await sleep(VIDEO_POLL_INTERVAL_MS, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    } finally {
      if (watches.get(key) === controller) watches.delete(key);
    }
  })();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
