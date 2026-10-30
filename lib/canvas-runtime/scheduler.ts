/**
 * 有界后台调度（P2-09，contracts.md C7）。
 * - 每片最多 backgroundSliceMs，片间通过注入的 yield 让出主线程；不把大批同步任务塞进 rAF。
 * - 优先级 gesture > terminal > visible > preview > prefetch/maintenance；同优先级先进先出。
 * - 只有尚未执行的 preview/prefetch/maintenance 同 key 任务可合并为最新一次；terminal/receipt 与正式命令不合并、不丢弃。
 * - preview 队列有条数与字节上限；超限拒绝新的预显示并标记“已简化”，不影响正式提交。
 * - flushTerminals() 立即同步执行所有终态任务，避免被低优先级任务饿死。
 */
import { PRIORITY, RUNTIME_BUDGET, type Priority } from "./runtime-budget";

export type ScheduledTask = {
  key: string;
  priority: Priority;
  run: () => void;
  cancel?: () => void;
  /** 预显示占用的字节（用于容量限制）。 */
  bytes?: number;
};
export type ScheduleResult = { accepted: true; merged: boolean } | { accepted: false; reason: "preview_capacity" };

type Entry = ScheduledTask & { seq: number; bytes: number };
const MERGEABLE = new Set<number>([PRIORITY.preview, PRIORITY.prefetch, PRIORITY.maintenance]);

export function createScheduler(options: {
  now?: () => number;
  /** 让出主线程并在之后继续执行 pump；返回取消函数。默认 setTimeout(0)。 */
  yieldTo?: (resume: () => void) => () => void;
  sliceMs?: number;
  previewItems?: number;
  previewBytes?: number;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const yieldTo = options.yieldTo ?? ((resume) => { const timer = setTimeout(resume, 0); return () => clearTimeout(timer); });
  const sliceMs = options.sliceMs ?? RUNTIME_BUDGET.backgroundSliceMs;
  const previewItems = options.previewItems ?? RUNTIME_BUDGET.previewQueueItems;
  const previewBytes = options.previewBytes ?? RUNTIME_BUDGET.previewQueueBytes;
  const queues = new Map<number, Entry[]>();
  const byKey = new Map<string, Entry>();
  let seq = 0;
  let previewCount = 0, previewByteCount = 0;
  let pending: (() => void) | null = null;
  let simplified = false;
  const stats = { slices: 0, ran: 0, merged: 0, rejected: 0, cancelled: 0, maxSliceMs: 0 };

  const queue = (priority: number) => { let list = queues.get(priority); if (!list) { list = []; queues.set(priority, list); } return list; };
  const unlink = (entry: Entry) => {
    const list = queues.get(entry.priority);
    if (list) { const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1); }
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key);
    if (entry.priority === PRIORITY.preview) { previewCount--; previewByteCount -= entry.bytes; }
  };
  const next = (): Entry | undefined => {
    for (const priority of [...queues.keys()].sort((a, b) => a - b)) {
      const list = queues.get(priority)!;
      if (list.length) return list[0];
    }
    return undefined;
  };
  const size = () => { let total = 0; for (const list of queues.values()) total += list.length; return total; };
  const run = (entry: Entry) => {
    unlink(entry);
    stats.ran++;
    entry.run();
  };
  const arm = () => {
    if (pending || !size()) return;
    pending = yieldTo(() => { pending = null; pump(); });
  };

  /** 执行一片：至少执行一个任务；超过 sliceMs 后让出。 */
  function pump() {
    const started = now();
    stats.slices++;
    let entry = next();
    while (entry) {
      run(entry);
      if (now() - started >= sliceMs) break;
      entry = next();
    }
    stats.maxSliceMs = Math.max(stats.maxSliceMs, now() - started);
    arm();
  }

  return {
    schedule(task: ScheduledTask): ScheduleResult {
      const bytes = Math.max(0, task.bytes ?? 0);
      const existing = byKey.get(task.key);
      if (existing && MERGEABLE.has(existing.priority) && existing.priority === task.priority) {
        // 合并尚未执行的同 key 低优先级任务：保留队列位置，替换为最新内容。
        if (task.priority === PRIORITY.preview) previewByteCount += bytes - existing.bytes;
        existing.run = task.run;
        existing.cancel = task.cancel;
        existing.bytes = bytes;
        stats.merged++;
        return { accepted: true, merged: true };
      }
      if (task.priority === PRIORITY.preview && (previewCount + 1 > previewItems || previewByteCount + bytes > previewBytes)) {
        simplified = true;
        stats.rejected++;
        return { accepted: false, reason: "preview_capacity" };
      }
      const entry: Entry = { ...task, bytes, seq: ++seq };
      queue(task.priority).push(entry);
      // 非合并类任务同 key 可并存（如两条终态）；byKey 只记录最新一条用于取消。
      byKey.set(task.key, entry);
      if (task.priority === PRIORITY.preview) { previewCount++; previewByteCount += bytes; }
      arm();
      return { accepted: true, merged: false };
    },
    /** 取消尚未执行的任务（只影响该 key）。 */
    cancel(key: string): boolean {
      let removed = false;
      for (const list of queues.values()) {
        for (const entry of [...list]) if (entry.key === key) { unlink(entry); entry.cancel?.(); removed = true; stats.cancelled++; }
      }
      return removed;
    },
    /** 取消某个前缀（如一个画布）的全部未执行任务。 */
    cancelPrefix(prefix: string): number {
      let count = 0;
      for (const list of queues.values()) for (const entry of [...list]) if (entry.key.startsWith(prefix)) { unlink(entry); entry.cancel?.(); count++; }
      stats.cancelled += count;
      return count;
    },
    /** 终态/回执立即执行，不等下一片。 */
    flushTerminals(): number {
      const list = queues.get(PRIORITY.terminal) ?? [];
      let count = 0;
      while (list.length) { run(list[0]!); count++; }
      return count;
    },
    pump,
    size,
    previewLoad: () => ({ items: previewCount, bytes: previewByteCount }),
    /** 曾因容量拒绝过预显示（UI 显示“预览已简化”）；队列降到一半以下后复位。 */
    simplified(): boolean {
      if (simplified && previewCount < previewItems / 2 && previewByteCount < previewBytes / 2) simplified = false;
      return simplified;
    },
    stats: () => ({ ...stats, queued: size() }),
    dispose() { pending?.(); pending = null; for (const list of queues.values()) for (const entry of list) entry.cancel?.(); queues.clear(); byKey.clear(); previewCount = previewByteCount = 0; },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
