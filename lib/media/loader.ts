/**
 * 统一媒体调度（P4-03）：节点、素材库、候选面板与工具结果共享下载/解码预算。
 * - 同一 key 只下载一次，订阅者共享；某个订阅者取消只移除它自己，最后一个退出才取消底层下载；
 * - 网络并发 6、解码并发 2，按优先级（0 正在看/编辑，1 视口附近，2 预取）出队；
 * - 解码前再检查是否还有订阅者，没有就丢弃；结果进缓存，按引用计数释放；
 * - 派生图仍在生成（202）时按 Retry-After 延迟重排，最多 10 次，不占网络槽位、不无限循环。
 */
import { createMediaCache, type CacheEntry } from "./cache";

export type MediaHandle = { url: string; width: number; height: number; bytes: number };
export type Decoded = MediaHandle & { pixels: number; dispose: () => void };
export type FetchResult = { status: "ok"; blob: Blob } | { status: "pending"; retryAfterMs: number } | { status: "failed"; message: string };

export type LoaderOptions = {
  fetch: (url: string, signal: AbortSignal) => Promise<FetchResult>;
  decode: (blob: Blob) => Promise<Decoded>;
  limits?: { network: number; decode: number };
  maxAttempts?: number;
  schedule?: (fn: () => void, ms: number) => void;
  cache?: ReturnType<typeof createMediaCache<MediaHandle>>;
};

export const MEDIA_LIMITS = { network: 6, decode: 2 };

type Subscriber = { resolve: (handle: MediaHandle) => void; reject: (error: Error) => void; settled: boolean };
type Job = {
  key: string; url: string; priority: number; attempts: number;
  subscribers: Set<Subscriber>; controller: AbortController;
  stage: "queued" | "fetching" | "waiting" | "decoding";
};

export class MediaLoadError extends Error { constructor(message: string, readonly code: "failed" | "aborted" = "failed") { super(message); this.name = "MediaLoadError"; } }

export function createMediaLoader(options: LoaderOptions) {
  const limits = options.limits ?? MEDIA_LIMITS;
  const maxAttempts = options.maxAttempts ?? 10;
  const schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
  const cache = options.cache ?? createMediaCache<MediaHandle>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const decodeQueue: Array<{ job: Job; blob: Blob }> = [];
  let network = 0, decoding = 0;
  const peak = { network: 0, decode: 0 };
  const counts = { fetches: 0, decodes: 0, coldLoads: 0, warmHits: 0, failures: 0 };

  const settleAll = (job: Job, outcome: { handle?: MediaHandle; error?: Error }) => {
    for (const sub of job.subscribers) {
      if (sub.settled) continue;
      sub.settled = true;
      if (outcome.handle) sub.resolve(outcome.handle); else sub.reject(outcome.error!);
    }
  };
  const finish = (job: Job) => { if (jobs.get(job.key) === job) jobs.delete(job.key); };

  function pump() {
    while (network < limits.network && queue.length) {
      queue.sort((a, b) => a.priority - b.priority);
      const job = queue.shift()!;
      if (!job.subscribers.size) { finish(job); continue; }
      void runFetch(job);
    }
    while (decoding < limits.decode && decodeQueue.length) {
      const { job, blob } = decodeQueue.shift()!;
      if (!job.subscribers.size) { finish(job); continue; }
      void runDecode(job, blob);
    }
  }

  async function runFetch(job: Job) {
    job.stage = "fetching";
    network++; peak.network = Math.max(peak.network, network); counts.fetches++;
    let result: FetchResult;
    try { result = await options.fetch(job.url, job.controller.signal); }
    catch (error) { result = { status: "failed", message: job.controller.signal.aborted ? "aborted" : error instanceof Error ? error.message : String(error) }; }
    finally { network--; }
    if (!job.subscribers.size || job.controller.signal.aborted) { finish(job); pump(); return; }
    if (result.status === "ok") { job.stage = "decoding"; decodeQueue.push({ job, blob: result.blob }); }
    else if (result.status === "pending" && ++job.attempts < maxAttempts) {
      job.stage = "waiting";
      schedule(() => { if (job.subscribers.size && !job.controller.signal.aborted) { job.stage = "queued"; queue.push(job); pump(); } else finish(job); }, result.retryAfterMs);
    } else {
      counts.failures++;
      settleAll(job, { error: new MediaLoadError(result.status === "pending" ? "派生图长时间未就绪" : result.message) });
      finish(job);
    }
    pump();
  }

  async function runDecode(job: Job, blob: Blob) {
    decoding++; peak.decode = Math.max(peak.decode, decoding); counts.decodes++;
    let decoded: Decoded | null = null;
    try { decoded = await options.decode(blob); }
    catch (error) { counts.failures++; settleAll(job, { error: new MediaLoadError(error instanceof Error ? error.message : "解码失败") }); }
    finally { decoding--; }
    if (decoded) {
      const live = [...job.subscribers].filter(sub => !sub.settled);
      if (!live.length) { decoded.dispose(); }
      else {
        const { dispose, pixels, ...handle } = decoded;
        const entry: CacheEntry<MediaHandle> = { value: handle, bytes: handle.bytes, pixels, dispose };
        cache.put(job.key, entry);
        for (let i = 1; i < live.length; i++) cache.retain(job.key);
        counts.coldLoads++;
        settleAll(job, { handle });
      }
    }
    finish(job);
    pump();
  }

  return {
    /**
     * 订阅一个媒体。promise 解析为可直接用于 <img src> 的句柄；release 幂等，调用后不再持有缓存引用。
     * signal 取消只影响本订阅者。
     */
    acquire(key: string, url: string, opts: { priority?: number; signal?: AbortSignal } = {}) {
      const priority = opts.priority ?? 1;
      let released = false;
      let holding = false;
      const cached = cache.retain(key);
      if (cached) {
        counts.warmHits++;
        holding = true;
        return { promise: Promise.resolve(cached), release: () => { if (released) return; released = true; cache.release(key); } };
      }
      let job = jobs.get(key);
      if (!job) {
        job = { key, url, priority, attempts: 0, subscribers: new Set(), controller: new AbortController(), stage: "queued" };
        jobs.set(key, job);
        queue.push(job);
      } else if (priority < job.priority) job.priority = priority;
      const owner = job;
      let sub!: Subscriber;
      const promise = new Promise<MediaHandle>((resolve, reject) => {
        sub = { resolve: (handle) => { holding = true; resolve(handle); }, reject, settled: false };
      });
      owner.subscribers.add(sub);
      const leave = () => {
        if (released) return;
        released = true;
        if (holding) { cache.release(key); return; }
        owner.subscribers.delete(sub);
        if (!sub.settled) { sub.settled = true; sub.reject(new MediaLoadError("已取消", "aborted")); }
        // 最后一个订阅者退出：取消底层下载；解码中的结果在完成后丢弃。
        if (!owner.subscribers.size && (owner.stage === "fetching" || owner.stage === "waiting" || owner.stage === "queued")) owner.controller.abort();
      };
      opts.signal?.addEventListener("abort", leave, { once: true });
      pump();
      return { promise, release: leave };
    },
    stats: () => ({ network, decoding, peak: { ...peak }, queued: queue.length, jobs: jobs.size, ...counts, cache: cache.stats() }),
    cache,
  };
}

export type MediaLoader = ReturnType<typeof createMediaLoader>;
