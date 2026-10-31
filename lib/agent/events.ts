/**
 * Agent 工具事件（P5-01）：执行包装器、持久记录与 SDK 流桥接。
 *
 * - 每次工具调用在真实边界记录阶段：开始校验 → 开始执行 → 终态；committed 只在执行成功返回后写入；
 * - 阶段通过 SDK 的 preliminary 工具结果推给界面（async generator 先 yield 阶段，最后 yield 真正结果，
 *   模型只看到最后的结果），不改协议终止帧；
 * - 记录持久到 tool_calls（SQLite）或数据目录下的 JSON（JSON 模式），刷新/重启后界面据此恢复；
 * - 写记录失败只记日志，不回滚已提交的命令；进程内登记正在执行的调用，供恢复区分「仍在跑」和「进程已没了」。
 * 服务端私有模块。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../data-dir";
import { isSqliteMode } from "../db/storage-mode";
import { TERMINAL_PHASES, terminalFor, transitionTool, type ToolDetails, type ToolIdentity, type ToolPhase, type ToolRecord } from "./execution";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const KEEP = 300;
const sqlRepo = () => import("../db/sql-command-repository");

const KEY = "__grokCanvasToolCalls";
type Holder = { [KEY]?: { live: Set<string>; queues: Map<string, Promise<unknown>> } };
const state = () => ((globalThis as Holder)[KEY] ??= { live: new Set(), queues: new Map() });
const liveKey = (canvasId: string, toolCallId: string) => `${canvasId}:${toolCallId}`;
export const isLiveExecution = (canvasId: string, toolCallId: string) => state().live.has(liveKey(canvasId, toolCallId));

function jsonFile(canvasId: string) {
  if (!SAFE_ID.test(canvasId)) throw new Error("画布 ID 无效");
  return path.join(dataDir(), "agent-tool-calls", `${canvasId}.json`);
}
async function readJson(canvasId: string): Promise<ToolRecord[]> {
  try { return JSON.parse(await readFile(jsonFile(canvasId), "utf8")) as ToolRecord[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** 同一画布的记录写入串行，避免并发读改写丢记录。 */
function serial<T>(canvasId: string, work: () => Promise<T>): Promise<T> {
  const queues = state().queues;
  const previous = queues.get(canvasId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(canvasId, next);
  return next.finally(() => { if (queues.get(canvasId) === next) queues.delete(canvasId); });
}

export async function saveToolRecord(record: ToolRecord): Promise<void> {
  if (isSqliteMode()) {
    await (await sqlRepo()).sqlCommand("tasks.putToolCall", record);
    return;
  }
  await serial(record.canvasId, async () => {
    const records = (await readJson(record.canvasId)).filter(item => !(item.runId === record.runId && item.toolCallId === record.toolCallId));
    records.push(record);
    const kept = records.slice(-KEEP);
    const file = jsonFile(record.canvasId);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(kept), "utf8");
    await rename(tmp, file);
  });
}

export async function listToolRecords(canvasId: string, limit = 100): Promise<ToolRecord[]> {
  if (isSqliteMode()) return (await sqlRepo()).sqlQuery<ToolRecord[]>("tasks.listToolCalls", { canvasId, limit });
  return (await readJson(canvasId)).slice(-limit);
}

export type ToolProgress = { phase: ToolPhase; completed?: number; total?: number; summary?: string };
type ExecuteOptions = { toolCallId: string; abortSignal?: AbortSignal };
type Context = { canvasId: string; runId: string; tool: string; targets?: (input: never) => string[]; summarize?: (output: never) => string | undefined };

/**
 * 把一个 async execute 包成带阶段的工具执行（async generator）：
 * yield 阶段（preliminary，供界面显示）→ 最终 yield 真正结果（交给模型）。抛错时写终态后重新抛出。
 */
export function withExecution<I, O>(context: Context, run: (input: I, options: ExecuteOptions) => Promise<O>) {
  return async function* execute(input: I, options: ExecuteOptions): AsyncGenerator<O | ToolProgress, O> {
    const identity: ToolIdentity = { runId: context.runId, toolCallId: options.toolCallId, canvasId: context.canvasId, tool: context.tool };
    const targets = context.targets ? safe(() => (context.targets as (input: I) => string[])(input)) : undefined;
    let record: ToolRecord | null = null;
    const step = async (phase: ToolPhase, details: ToolDetails = {}) => {
      const next = transitionTool(record, identity, phase, { ...(targets?.length ? { targets } : {}), ...details });
      if (!next) return;
      record = next;
      try { await saveToolRecord(next); } catch (error) { console.warn("[agent] 工具状态记录写入失败（不影响已提交结果）：", error instanceof Error ? error.message : error); }
    };
    const key = liveKey(context.canvasId, options.toolCallId);
    state().live.add(key);
    try {
      await step("validating");
      yield { phase: "validating" } as ToolProgress;
      await step("executing");
      yield { phase: "executing" } as ToolProgress;
      const output = await run(input, options);
      const summary = context.summarize ? safe(() => (context.summarize as (output: O) => string | undefined)(output)) : undefined;
      await step("committed", summary ? { summary } : {});
      yield output;
      return output;
    } catch (error) {
      const phase = terminalFor(error, !!options.abortSignal?.aborted);
      await step(phase, { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
      throw error;
    } finally {
      state().live.delete(key);
    }
  };
}

function safe<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }

/** 把一个可能已提交的收费请求错误标为 unknown（执行包装器据此写 unknown，而不是 failed）。 */
export function markUnknown<E>(error: E): E {
  if (error && typeof error === "object") Object.assign(error, { toolOutcome: "unknown" });
  return error;
}

export { TERMINAL_PHASES };
