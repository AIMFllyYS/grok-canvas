/**
 * Agent 工具执行状态机（P5-01，contracts.md C8）。
 *
 *   input-streaming → validating → queued → executing → committed
 *                           ↘          ↘          ↘ blocked | failed | cancelled | unknown
 *
 * - committed 只能在命令（或生成/任务提交）真正成功后进入；
 * - unknown：请求可能已到达上游（收费生成已提交但结果不明），不能当作失败去重发；
 * - cancelled：只有确认尚未提交（或上游确认取消）才能进入；
 * - 终态不可再迁移；重复进入同一终态是无副作用的重复（不写新记录、不重复渲染）。
 */
export const TOOL_PHASES = ["input-streaming", "validating", "queued", "executing", "committed", "blocked", "failed", "cancelled", "unknown"] as const;
export type ToolPhase = (typeof TOOL_PHASES)[number];
export const TERMINAL_PHASES: ReadonlySet<ToolPhase> = new Set(["committed", "blocked", "failed", "cancelled", "unknown"]);

const NEXT: Record<ToolPhase, readonly ToolPhase[]> = {
  "input-streaming": ["validating", "failed", "cancelled"],
  validating: ["queued", "executing", "blocked", "failed", "cancelled"],
  queued: ["executing", "blocked", "failed", "cancelled"],
  executing: ["committed", "blocked", "failed", "cancelled", "unknown"],
  committed: [], blocked: [], failed: [], cancelled: [], unknown: [],
};

export type ToolIdentity = { runId: string; toolCallId: string; canvasId: string; tool: string };
export type ToolDetails = { completed?: number; total?: number; summary?: string; error?: string; targets?: string[] };
export type ToolRecord = ToolIdentity & ToolDetails & { phase: ToolPhase; eventSeq: number; startedAt: string; updatedAt: string };

export class ToolTransitionError extends Error {
  constructor(readonly from: ToolPhase, readonly to: ToolPhase) { super(`非法的工具状态迁移：${from} → ${to}`); this.name = "ToolTransitionError"; }
}

export function canTransition(from: ToolPhase, to: ToolPhase): boolean {
  return NEXT[from].includes(to);
}

/**
 * 迁移并返回新记录；重复终态返回 null（调用方据此跳过写入）。
 * completed/total 只接受实际处理数：completed 不超过 total，没有 total 时不出现百分比。
 */
export function transitionTool(record: ToolRecord | null, identity: ToolIdentity, next: ToolPhase, details: ToolDetails = {}, now = new Date().toISOString()): ToolRecord | null {
  if (record && record.phase === next && TERMINAL_PHASES.has(next)) return null;
  if (record && !canTransition(record.phase, next)) throw new ToolTransitionError(record.phase, next);
  if (details.total !== undefined && (!Number.isSafeInteger(details.total) || details.total < 0)) throw new Error("total 必须是非负整数");
  if (details.completed !== undefined) {
    if (!Number.isSafeInteger(details.completed) || details.completed < 0) throw new Error("completed 必须是非负整数");
    if (details.total !== undefined && details.completed > details.total) throw new Error("completed 不能超过 total");
  }
  const clean: ToolDetails = {};
  if (details.total !== undefined) clean.total = details.total;
  if (details.completed !== undefined) clean.completed = details.completed;
  if (details.summary) clean.summary = details.summary.slice(0, 200);
  if (details.error) clean.error = details.error.slice(0, 500);
  if (details.targets?.length) clean.targets = details.targets.slice(0, 50);
  return { ...identity, ...clean, phase: next, eventSeq: (record?.eventSeq ?? 0) + 1, startedAt: record?.startedAt ?? now, updatedAt: now };
}

/** 错误 → 终态：租约/字段冲突是 blocked；已提交的收费请求是 unknown；中止且未提交是 cancelled；其余 failed。 */
export function terminalFor(error: unknown, aborted: boolean): ToolPhase {
  const tagged = (error as { toolOutcome?: unknown } | null)?.toolOutcome;
  if (tagged === "unknown") return "unknown";
  if (aborted) return "cancelled";
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409 || status === 423) return "blocked";
  return "failed";
}
