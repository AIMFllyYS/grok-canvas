import { loadCanvas, updateCanvas } from "./canvas-store";
import { dataDir } from "./data-dir";

const globals = globalThis as typeof globalThis & { __grokGenerationLive?: Map<string, { id: string; expiresAt: number }> };
const live = globals.__grokGenerationLive ??= new Map();
const liveKey = (canvasId: string, nodeId: string) => JSON.stringify([dataDir(), canvasId, nodeId]);
const LIVE_MS = 5 * 60_000;

export class GenerationClaimError extends Error {
  constructor(message: string) { super(message); }
}

/** Claims are persisted with the canvas under the same lock used by every writer. */
export async function claimGeneration(canvasId: string, nodeId: string, id: string): Promise<void> {
  const key = liveKey(canvasId, nodeId);
  let saved;
  let registered = false;
  try { saved = await updateCanvas(canvasId, doc => {
    if (!doc.nodes.some(node => typeof node === "object" && node !== null && "id" in node && node.id === nodeId)) throw new GenerationClaimError("节点不存在，请先保存画布");
    const active = doc.generationClaims?.[nodeId];
    if (active) throw new GenerationClaimError(active.state === "unknown" ? "上次生成的状态未确认，请先检查结果" : "该节点已有生成任务正在进行");
    doc.generationClaims = { ...doc.generationClaims, [nodeId]: { id, state: "pending" } };
    live.set(key, { id, expiresAt: Date.now() + LIVE_MS });
    registered = true;
  }); } catch (error) {
    if (registered && live.get(key)?.id === id) live.delete(key);
    throw error;
  }
  if (!saved) throw new GenerationClaimError("画布不存在");
}

export async function finishGeneration(canvasId: string, nodeId: string, id: string, state: "completed" | "unknown", taskId?: string): Promise<void> {
  await updateCanvas(canvasId, doc => {
    const current = doc.generationClaims?.[nodeId];
    if (!current || current.id !== id) return false;
    const claims = { ...doc.generationClaims };
    if (state === "completed") delete claims[nodeId];
    else claims[nodeId] = { ...current, state, ...(taskId ? { taskId } : {}) };
    doc.generationClaims = claims;
  });
  const key = liveKey(canvasId, nodeId);
  if (live.get(key)?.id === id) live.delete(key);
}

export async function attachGenerationTask(canvasId: string, nodeId: string, id: string, taskId: string): Promise<void> {
  const saved = await updateCanvas(canvasId, doc => {
    const claim = doc.generationClaims?.[nodeId];
    if (!claim || claim.id !== id) throw new GenerationClaimError("生成任务占用已失效");
    doc.generationClaims = { ...doc.generationClaims, [nodeId]: { ...claim, taskId } };
  });
  if (!saved) throw new GenerationClaimError("画布不存在");
}

/** A process restart loses in-flight image requests; never silently resubmit them. */
export async function recoverStaleGenerationClaims(canvasId: string) {
  return updateCanvas(canvasId, doc => {
    let changed = false;
    const claims = { ...doc.generationClaims };
    for (const [nodeId, claim] of Object.entries(claims)) {
      const running = live.get(liveKey(canvasId, nodeId));
      if (claim.state === "pending" && !claim.taskId && (!running || running.id !== claim.id || running.expiresAt <= Date.now())) {
        claims[nodeId] = { ...claim, state: "unknown" };
        changed = true;
      }
    }
    if (!changed) return false;
    doc.generationClaims = claims;
  });
}

export async function verifyGenerationClaim(canvasId: string, nodeId: string, id: string): Promise<void> {
  const doc = await loadCanvas(canvasId);
  const claim = doc?.generationClaims?.[nodeId];
  if (!claim || claim.id !== id || claim.state !== "pending") throw new GenerationClaimError("生成任务占用已失效");
}

/** The user has explicitly acknowledged the risk of retrying an unknown request. */
export async function acknowledgeUnknownGeneration(canvasId: string, nodeId: string, id: string): Promise<void> {
  const saved = await updateCanvas(canvasId, doc => {
    const current = doc.generationClaims?.[nodeId];
    if (!current || current.id !== id || current.state !== "unknown") throw new GenerationClaimError("生成任务状态已变化，请重新检查");
    const claims = { ...doc.generationClaims };
    delete claims[nodeId];
    doc.generationClaims = claims;
  });
  if (!saved) throw new GenerationClaimError("画布不存在");
  const key = liveKey(canvasId, nodeId);
  if (live.get(key)?.id === id) live.delete(key);
}
