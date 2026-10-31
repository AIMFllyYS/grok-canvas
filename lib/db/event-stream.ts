/**
 * 活动画布的 SSE 事件流（P3-09）。每个打开的画布一条连接，只推送「修订已前进到 R，由哪些 actor 写入」，
 * 不推送实体数据：客户端据此决定是否拉取（只有别人写入才拉），替代原来每 2 秒整图轮询。
 *
 * - 连接建立先发一次当前修订，客户端据此补齐断线期间的变化；
 * - 写入方经 change-bus 通知，50ms 内合并后推送；
 * - 漏通知（其他进程/旧路径）由 probeMs 的低频修订探测兜底，探测只读一行/文件 mtime；
 * - 心跳注释保持代理与浏览器连接；连接关闭时注销订阅与所有定时器。
 */
import type { CanvasChange } from "../canvas-runtime/change-bus";

export type RevisionProbe = () => Promise<{ revision: number } | null>;

export type EventStreamOptions = {
  canvasId: string;
  probe: RevisionProbe;
  subscribe: (listener: (change: CanvasChange) => void) => () => void;
  signal?: AbortSignal;
  coalesceMs?: number;
  probeMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
};

export const EVENT_STREAM_DEFAULTS = { coalesceMs: 50, probeMs: 4000, heartbeatMs: 15_000, retryMs: 3000 };

const encoder = new TextEncoder();

export function createCanvasEventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const coalesceMs = options.coalesceMs ?? EVENT_STREAM_DEFAULTS.coalesceMs;
  const probeMs = options.probeMs ?? EVENT_STREAM_DEFAULTS.probeMs;
  const heartbeatMs = options.heartbeatMs ?? EVENT_STREAM_DEFAULTS.heartbeatMs;
  const retryMs = options.retryMs ?? EVENT_STREAM_DEFAULTS.retryMs;
  let closed = false;
  let lastRevision = -1;
  let id = 0;
  const actors = new Set<string>();
  let unknownWriter = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let flushing: Promise<void> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const write = (text: string) => {
    if (closed || !controllerRef) return;
    try { controllerRef.enqueue(encoder.encode(text)); } catch { close(); }
  };
  const send = (event: string, data: unknown) => write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function close() {
    if (closed) return;
    closed = true;
    if (flushTimer) clearTimeout(flushTimer);
    if (probeTimer) clearInterval(probeTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe?.();
    unsubscribe = null;
    options.signal?.removeEventListener("abort", close);
    try { controllerRef?.close(); } catch { /* 已关闭 */ }
  }

  /** 读当前修订，前进了才推送；同一时刻只跑一次，期间的新通知并入下一次。 */
  async function flush(): Promise<void> {
    if (closed) return;
    if (flushing) { await flushing; return flush(); }
    flushing = (async () => {
      const current = await options.probe().catch(() => undefined);
      if (closed || current === undefined) return;
      if (current === null) { send("gone", { canvasId: options.canvasId }); close(); return; }
      if (current.revision <= lastRevision) return;
      lastRevision = current.revision;
      const writers: Array<string | null> = [...actors];
      if (unknownWriter || !writers.length) writers.push(null);
      actors.clear();
      unknownWriter = false;
      send("revision", { canvasId: options.canvasId, revision: current.revision, actors: writers });
    })();
    try { await flushing; } finally { flushing = null; }
  }

  const schedule = () => {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, coalesceMs);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (options.signal?.aborted) { close(); return; }
      options.signal?.addEventListener("abort", close);
      write(`retry: ${retryMs}\n\n`);
      unsubscribe = options.subscribe(change => {
        if (change.actorId) actors.add(change.actorId); else unknownWriter = true;
        schedule();
      });
      // 首次推送：客户端以此为基线，并补拉断线期间的变化。
      const initial = await options.probe().catch(() => null);
      if (closed) return;
      if (!initial) { send("gone", { canvasId: options.canvasId }); close(); return; }
      lastRevision = initial.revision;
      send("revision", { canvasId: options.canvasId, revision: initial.revision, actors: [], initial: true });
      probeTimer = setInterval(() => { void flush(); }, probeMs);
      heartbeatTimer = setInterval(() => write(": ping\n\n"), heartbeatMs);
    },
    cancel() { close(); },
  });
}
