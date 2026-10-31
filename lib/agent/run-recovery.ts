/**
 * Agent 运行恢复（P5-04）：进程重启、流断开或页面刷新后，把停在中间阶段的工具调用收敛到明确状态。
 * - 仍在本进程执行的调用不动；
 * - 停在 executing 的调用：请求可能已到达（收费生成已提交、命令可能已提交）→ unknown，提示查询状态，绝不自动重发；
 * - 停在执行前（validating/queued/input-streaming）→ failed（尚未提交任何东西，可以安全重试）；
 * - 终态记录原样保留。
 * 服务端私有模块。
 */
import { TERMINAL_PHASES, transitionTool, type ToolRecord } from "./execution";
import { isLiveExecution, listToolRecords, saveToolRecord } from "./events";

export const STALE_MS = 15_000;

export function settleStale(records: readonly ToolRecord[], options: { isLive: (record: ToolRecord) => boolean; now?: number; staleMs?: number }): ToolRecord[] {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? STALE_MS;
  const changed: ToolRecord[] = [];
  for (const record of records) {
    if (TERMINAL_PHASES.has(record.phase) || options.isLive(record)) continue;
    if (now - Date.parse(record.updatedAt) < staleMs) continue;
    const identity = { runId: record.runId, toolCallId: record.toolCallId, canvasId: record.canvasId, tool: record.tool };
    const next = record.phase === "executing"
      ? transitionTool(record, identity, "unknown", { error: "执行过程中连接或进程中断，结果未知；已提交的生成不会自动重发，请先查询状态" }, new Date(now).toISOString())
      : transitionTool(record, identity, "failed", { error: "执行在提交前中断，没有产生任何修改，可以重试" }, new Date(now).toISOString());
    if (next) changed.push(next);
  }
  return changed;
}

/** 读取画布最近的工具记录并收敛过期的中间态（读即恢复，幂等）。 */
export async function recoverToolCalls(canvasId: string, now = Date.now()): Promise<ToolRecord[]> {
  const records = await listToolRecords(canvasId);
  const changed = settleStale(records, { isLive: record => isLiveExecution(record.canvasId, record.toolCallId), now });
  for (const record of changed) await saveToolRecord(record);
  if (!changed.length) return records;
  const byKey = new Map(changed.map(record => [`${record.runId}:${record.toolCallId}`, record]));
  return records.map(record => byKey.get(`${record.runId}:${record.toolCallId}`) ?? record);
}
