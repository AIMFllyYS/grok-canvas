/**
 * 浏览器侧画布同步（P3-09/P3-10）。
 *
 * createCanvasSync：每个打开的画布一条 EventSource（/api/canvases/:id/events）。
 * - 修订不前进（重复/乱序）的事件丢弃；
 * - 只有别的 actor（Agent、生成回写、其他标签页、未知写入）写入时才调用 onRemoteChange 拉取，自己的命令由回执确认；
 * - 连接建立/重连后的第一条事件一律拉取一次，补齐断线期间的变化；
 * - 页面隐藏时断开、显示时重连；dispose 关闭连接并注销所有监听与定时器。
 * 网络异常时由 EventSource 自动重连，不会退回常态整图轮询。
 *
 * createAckReporter：outbox 确认后把本 actor 的最高连续序号节流上报，供服务端压缩已确认回执。
 */

export type SyncStatus = "connecting" | "live" | "reconnecting" | "paused" | "closed" | "gone";

export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type VisibilityLike = { hidden(): boolean; subscribe(listener: () => void): () => void };

export type CanvasSyncOptions = {
  canvasId: string;
  actorId: () => string | null;
  onRemoteChange: (revision: number) => void;
  onStatus?: (status: SyncStatus) => void;
  createSource?: (url: string) => EventSourceLike;
  visibility?: VisibilityLike;
};

type RevisionEvent = { canvasId?: string; revision?: number; actors?: Array<string | null>; initial?: boolean };

const browserVisibility = (): VisibilityLike | undefined => {
  if (typeof document === "undefined") return undefined;
  return {
    hidden: () => document.visibilityState === "hidden",
    subscribe: (listener) => { document.addEventListener("visibilitychange", listener); return () => document.removeEventListener("visibilitychange", listener); },
  };
};

export function createCanvasSync(options: CanvasSyncOptions) {
  const create = options.createSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const visibility = options.visibility ?? browserVisibility();
  const url = `/api/canvases/${encodeURIComponent(options.canvasId)}/events`;
  let source: EventSourceLike | null = null;
  let lastRevision = -1;
  let fresh = true;
  let disposed = false;
  let status: SyncStatus = "closed";
  const setStatus = (next: SyncStatus) => { if (status !== next) { status = next; options.onStatus?.(next); } };

  function handle(raw: string | undefined) {
    let event: RevisionEvent;
    try { event = JSON.parse(raw ?? "") as RevisionEvent; } catch { return; }
    if (event.canvasId !== undefined && event.canvasId !== options.canvasId) return; // 迟到的旧画布流
    const revision = event.revision;
    if (!Number.isSafeInteger(revision)) return;
    const reconnect = fresh;
    fresh = false;
    if (!reconnect && revision! <= lastRevision) return;
    lastRevision = Math.max(lastRevision, revision!);
    const self = options.actorId();
    const foreign = (event.actors ?? []).some(actor => actor === null || actor !== self);
    if (reconnect || foreign) options.onRemoteChange(revision!);
  }

  function open() {
    if (disposed || source) return;
    fresh = true;
    setStatus("connecting");
    const next = create(url);
    source = next;
    next.onopen = () => { if (source === next) setStatus("live"); };
    next.onerror = () => {
      if (source !== next) return;
      fresh = true; // 重连后的第一条事件补拉
      setStatus("reconnecting");
    };
    next.addEventListener("revision", event => { if (source === next) handle(event.data); });
    next.addEventListener("gone", () => { if (source !== next) return; close(); setStatus("gone"); });
  }

  function close() {
    const current = source;
    source = null;
    current?.close();
  }

  const unsubscribeVisibility = visibility?.subscribe(() => {
    if (disposed) return;
    if (visibility.hidden()) { close(); setStatus("paused"); }
    else open();
  });
  if (!visibility?.hidden()) open(); else setStatus("paused");

  return {
    status: () => status,
    lastRevision: () => lastRevision,
    /** 手动恢复入口：断开重连，重连后的第一条事件会触发一次拉取。 */
    reconnect() { if (disposed) return; close(); open(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeVisibility?.();
      close();
      setStatus("closed");
    },
  };
}

export type CanvasSync = ReturnType<typeof createCanvasSync>;

export type AckReporterOptions = {
  canvasId: string;
  actorId: string;
  post: (body: { actorId: string; ackSeq: number }) => Promise<unknown>;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
};

/** 节流上报确认水位：只发最高值，失败等下次确认再发；dispose 时尽力发出最后一次。 */
export function createAckReporter(options: AckReporterOptions) {
  const schedule = options.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  const delayMs = options.delayMs ?? 5000;
  let highest = 0;
  let sent = 0;
  let cancel: (() => void) | null = null;
  let inFlight = false;

  async function flush() {
    cancel = null;
    if (inFlight || highest <= sent) return;
    inFlight = true;
    const seq = highest;
    try { await options.post({ actorId: options.actorId, ackSeq: seq }); sent = Math.max(sent, seq); }
    catch { /* 下次确认时重试 */ }
    finally { inFlight = false; }
  }

  return {
    report(actorSeq: number) {
      if (!Number.isSafeInteger(actorSeq) || actorSeq <= highest) return;
      highest = actorSeq;
      if (!cancel) cancel = schedule(() => { void flush(); }, delayMs);
    },
    flush,
    dispose() { cancel?.(); cancel = null; void flush(); },
    state: () => ({ highest, sent }),
  };
}
