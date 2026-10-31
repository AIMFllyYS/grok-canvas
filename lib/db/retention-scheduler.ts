/**
 * P3-10 低优先级保留调度：SQLite 权威模式下每 10 分钟跑一轮有界压缩（最多 20 批），首次在启动 30 秒后。
 * 定时器 unref，不阻止进程退出；失败只记录，不影响读写。JSON 模式不启动（JSON 没有事件日志）。
 * 服务端私有模块。
 */
import { isSqliteMode } from "./storage-mode";
import { sqlCommand } from "./sql-command-repository";

const KEY = "__grokCanvasRetention";
type Holder = { [KEY]?: { timers: Array<ReturnType<typeof setTimeout>>; running: boolean } };
const INTERVAL_MS = 10 * 60_000;
const FIRST_MS = 30_000;
const MAX_ROUNDS = 20;

export async function runRetentionRound(): Promise<{ eventsDeleted: number; receiptsCompacted: number; rounds: number }> {
  const total = { eventsDeleted: 0, receiptsCompacted: 0, rounds: 0 };
  while (total.rounds < MAX_ROUNDS) {
    const result = await sqlCommand<{ eventsDeleted: number; receiptsCompacted: number; more: boolean }>("retention.compact", {});
    total.rounds++;
    total.eventsDeleted += result.eventsDeleted;
    total.receiptsCompacted += result.receiptsCompacted;
    if (!result.more) break;
  }
  return total;
}

export function ensureRetentionScheduler(): void {
  const holder = globalThis as Holder;
  if (holder[KEY] || !isSqliteMode()) return;
  const state = { timers: [] as Array<ReturnType<typeof setTimeout>>, running: false };
  holder[KEY] = state;
  const tick = async () => {
    if (state.running || !isSqliteMode()) return;
    state.running = true;
    try { await runRetentionRound(); }
    catch (error) { console.warn("[retention] 压缩失败，下轮重试：", error instanceof Error ? error.message : error); }
    finally { state.running = false; }
  };
  const first = setTimeout(() => { void tick(); }, FIRST_MS);
  const every = setInterval(() => { void tick(); }, INTERVAL_MS);
  first.unref?.();
  every.unref?.();
  state.timers.push(first, every);
}
