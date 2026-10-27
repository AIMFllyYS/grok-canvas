import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./data-dir";
import type { VideoRequestPlan } from "./video-request";

/**
 * 视频任务的服务端持久化。官方结果链接是临时的，任务状态必须落盘：
 * 刷新页面或服务重启后凭 request_id 恢复轮询，已完成但下载失败的任务
 * 凭 remoteUrl 重试下载，不重新提交生成。
 *
 * 每个任务一个 JSON 文件，tmp + rename 原子覆盖（与图片生成记录不同，
 * 任务记录要随状态推进多次更新）。
 */

export const VIDEO_TASKS_DIR = path.join(dataDir(), "video-tasks");

export type VideoTaskStatus =
  /** 已提交上游，轮询中 */
  | "pending"
  /** 视频已下载落盘 */
  | "completed"
  /** 上游报告生成失败 */
  | "failed"
  /** 上游已完成但下载/保存失败：凭 remoteUrl 重试下载，不重新生成 */
  | "save_failed"
  /** 重试下载时临时链接已失效，无法恢复 */
  | "expired";

export type VideoTaskResult = {
  assetName: string;
  localUrl: string;
  bytes: number;
};

export type VideoTaskRecord = {
  schemaVersion: 1;
  taskId: string;
  /** 上游 request_id，刷新后凭它恢复查询 */
  requestId: string;
  status: VideoTaskStatus;
  canvasId: string;
  nodeId: string;
  claim?: { nodeId: string; id: string };
  claimReleased?: boolean;
  /** 提交时的冻结快照：上游图片随后就绪只影响下一次提交 */
  snapshot: VideoRequestPlan;
  /** 上游返回结果后记录临时链接，供 save_failed 重试下载 */
  remoteUrl: string | null;
  result: VideoTaskResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const SAFE_TASK_ID = /^[a-zA-Z0-9-]+$/;

function taskPath(taskId: string): string {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("unsafe task id");
  return path.join(VIDEO_TASKS_DIR, `${taskId}.json`);
}

async function writeRecord(record: VideoTaskRecord): Promise<void> {
  await mkdir(VIDEO_TASKS_DIR, { recursive: true });
  const temporary = path.join(VIDEO_TASKS_DIR, `${record.taskId}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { flush: true });
  await rename(temporary, taskPath(record.taskId));
}

export async function createVideoTask(
  requestId: string,
  canvasId: string,
  nodeId: string,
  snapshot: VideoRequestPlan,
  claim?: { nodeId: string; id: string },
): Promise<VideoTaskRecord> {
  const now = new Date().toISOString();
  const record: VideoTaskRecord = {
    schemaVersion: 1,
    taskId: crypto.randomUUID(),
    requestId,
    status: "pending",
    canvasId,
    nodeId,
    ...(claim ? { claim } : {}),
    snapshot,
    remoteUrl: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(record);
  return record;
}

export async function readVideoTask(taskId: string): Promise<VideoTaskRecord | null> {
  try {
    return JSON.parse(await readFile(taskPath(taskId), "utf8")) as VideoTaskRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function updateVideoTask(
  taskId: string,
  patch: Partial<Pick<VideoTaskRecord, "status" | "remoteUrl" | "result" | "error" | "claimReleased">>,
): Promise<VideoTaskRecord> {
  const record = await readVideoTask(taskId);
  if (!record) throw new Error(`视频任务不存在：${taskId}`);
  const next: VideoTaskRecord = { ...record, ...patch, updatedAt: new Date().toISOString() };
  await writeRecord(next);
  return next;
}

/** 终态任务不再轮询也不再恢复。 */
export function isTerminalVideoTask(record: VideoTaskRecord): boolean {
  return record.status === "completed" || record.status === "failed" || record.status === "expired";
}

export async function listVideoTasks(): Promise<VideoTaskRecord[]> {
  let names: string[];
  try {
    names = await readdir(VIDEO_TASKS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: VideoTaskRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readVideoTask(name.slice(0, -".json".length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 服务重启后需要恢复的任务：轮询中，或已出片但下载失败。 */
export async function recoverableVideoTasks(): Promise<VideoTaskRecord[]> {
  return (await listVideoTasks()).filter((record) => record.status === "pending" || record.status === "save_failed" || (Boolean(record.claim) && !record.claimReleased && isTerminalVideoTask(record)));
}
