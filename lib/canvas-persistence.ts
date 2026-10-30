import type { GenerationOutcome } from "./multi-image";
import type { VideoTaskView } from "./video-runtime";

type PersistOptions = { fetch?: typeof fetch; orphan?: () => void };
export type ServiceWriteBody =
  | { action: "start"; nodeId: string; generationId: string; patch: Record<string, unknown> }
  | { action: "image"; nodeId: string; outcome: GenerationOutcome }
  | { action: "video"; nodeId: string; taskId: string }
  | { action: "fail"; nodeId: string; generationId: string; patch: Record<string, unknown> }
  | { action: "select"; nodeId: string; slotId: string }
  | { action: "task"; nodeId: string; generationId: string; taskId: string };

/**
 * 生成回写（P2-08）：交给服务端在画布锁内构造 apply_generation，不再 GET 整图再 diff 写回。
 * 节点已删时服务端只登记素材并返回 orphan；画布已删返回 404（只保留独立恢复记录，不重建画布）。
 */
export async function postServiceWrite(canvasId: string, body: ServiceWriteBody, options: PersistOptions = {}): Promise<"applied" | "unchanged" | "orphan" | "canvas_deleted"> {
  const request = options.fetch ?? fetch;
  const url = `/api/canvases/${encodeURIComponent(canvasId)}/service-write`;
  let lastError = "生成完成，但写回原画布失败，请刷新对应画布检查";
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404) return "canvas_deleted";
    const payload = await response.json().catch(() => ({})) as { status?: "applied" | "unchanged" | "orphan"; error?: { code?: string; message?: string; retryAfterMs?: number } };
    if (response.ok && payload.status) {
      if (payload.status === "orphan") options.orphan?.();
      return payload.status;
    }
    lastError = payload.error?.message ?? lastError;
    // 租约/队列等暂时性冲突稍后重试；确定性拒绝直接报告。
    if (![423, 429, 503].includes(response.status) && response.status < 500) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(4000, payload.error?.retryAfterMs ?? 500 * (attempt + 1))));
  }
  throw new Error(lastError);
}

export async function persistImageOutcome(canvasId: string, nodeId: string, outcome: GenerationOutcome, options: PersistOptions = {}): Promise<void> {
  await postServiceWrite(canvasId, { action: "image", nodeId, outcome }, options);
}

export async function persistVideoOutcome(canvasId: string, nodeId: string, view: VideoTaskView, options: PersistOptions = {}): Promise<void> {
  await postServiceWrite(canvasId, { action: "video", nodeId, taskId: view.taskId }, options);
}
