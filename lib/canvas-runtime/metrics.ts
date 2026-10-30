/**
 * 可归因埋点（P6-01，contracts.md C7/C9）：定长环形缓冲，最多 capacity 条（默认 10000）。
 * - 默认关闭：关闭时 record 直接返回，不分配对象；
 * - 只接受有限、非负数值；异常值丢弃并计数；缓冲满时覆盖最旧样本并计数，不增长；
 * - metadata 只允许白名单键，值为数字或脱敏 ID（[a-z0-9_-]{1,64}），不记录用户正文、提示词或 token；
 * - snapshot() 导出版本/环境/每个指标的 count/p50/p95/p99/max/mean；没有样本时为 unmeasured，不显示 0ms 达标。
 */
export const METRICS_SCHEMA_VERSION = 1;

export const METRIC_NAMES = [
  "pointer_to_paint_ms", "pointer_to_paint_unmeasured", "frame_interval_ms", "react_commit_ms",
  "full_scan_count", "clone_count", "outbox_items", "outbox_bytes",
  "db_queue_ms", "db_txn_ms", "media_active", "subscriptions", "event_to_visible_ms", "local_commit_ms",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

const METADATA_KEYS = new Set(["phase", "nodeCount", "edgeCount", "participants", "canvas", "variant", "kind"]);
const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

export type MetricSummary =
  | { status: "measured"; count: number; p50: number; p95: number; p99: number; max: number; mean: number }
  | { status: "unmeasured"; count: 0 };

export type MetricsSnapshot = {
  schemaVersion: number;
  environment: Record<string, string | number | boolean>;
  capacity: number;
  size: number;
  dropped: number;
  overwritten: number;
  metrics: Record<string, MetricSummary>;
};

/** 最近秩（nearest-rank）百分位：sorted 升序，p ∈ (0,100]。 */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (!sorted.length) throw new Error("空样本没有百分位");
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, number | string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && SAFE_ID.test(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createMetrics(options: { capacity?: number; enabled?: boolean; now?: () => number; environment?: Record<string, string | number | boolean> } = {}) {
  const capacity = Math.max(1, Math.min(options.capacity ?? 10_000, 100_000));
  let enabled = options.enabled ?? false;
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const nameIndex = new Map<string, number>(METRIC_NAMES.map((name, index) => [name, index]));
  // 定长存储：名称下标、数值、时间与可选元数据。
  const names = new Uint16Array(capacity);
  const values = new Float64Array(capacity);
  const times = new Float64Array(capacity);
  const metadata: Array<Record<string, number | string> | undefined> = new Array(capacity);
  let head = 0, size = 0, dropped = 0, overwritten = 0;
  return {
    enabled: () => enabled,
    setEnabled(next: boolean) { enabled = next; },
    record(name: MetricName, value: number, meta?: Record<string, unknown>): boolean {
      if (!enabled) return false;
      const index = nameIndex.get(name);
      if (index === undefined || typeof value !== "number" || !Number.isFinite(value) || value < 0) { dropped++; return false; }
      if (size === capacity) overwritten++;
      names[head] = index; values[head] = value; times[head] = now();
      metadata[head] = sanitizeMetadata(meta);
      head = (head + 1) % capacity;
      if (size < capacity) size++;
      return true;
    },
    size: () => size,
    snapshot(environment: Record<string, string | number | boolean> = {}): MetricsSnapshot {
      const buckets = new Map<number, number[]>();
      for (let i = 0; i < size; i++) {
        const at = (head - size + i + capacity) % capacity;
        let bucket = buckets.get(names[at]!);
        if (!bucket) { bucket = []; buckets.set(names[at]!, bucket); }
        bucket.push(values[at]!);
      }
      const metrics: Record<string, MetricSummary> = {};
      METRIC_NAMES.forEach((name, index) => {
        const bucket = buckets.get(index);
        if (!bucket?.length) { metrics[name] = { status: "unmeasured", count: 0 }; return; }
        const sorted = Float64Array.from(bucket).sort();
        let sum = 0;
        for (const value of sorted) sum += value;
        metrics[name] = { status: "measured", count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1]!, mean: sum / sorted.length };
      });
      return { schemaVersion: METRICS_SCHEMA_VERSION, environment: { ...options.environment, ...environment }, capacity, size, dropped, overwritten, metrics };
    },
    clear() { head = size = dropped = overwritten = 0; metadata.fill(undefined); },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

/** 浏览器单例：localStorage["grok-canvas:metrics"]="1" 时开启；默认关闭。 */
const globals = globalThis as typeof globalThis & { __grokCanvasMetrics?: Metrics };
export const canvasMetrics: Metrics = globals.__grokCanvasMetrics ??= createMetrics({
  enabled: typeof localStorage !== "undefined" && (() => { try { return localStorage.getItem("grok-canvas:metrics") === "1"; } catch { return false; } })(),
});

/**
 * 指针到绘制：用输入事件的 timeStamp 与之后第一个 rAF 回调时刻关联（rAF 在绘制前执行，是下界近似）。
 * 100ms 内没有 rAF（页面隐藏等）记为 unmeasured，不估算。
 */
export function measurePointerToPaint(eventTimeStamp: number, metrics: Metrics = canvasMetrics, raf: (cb: (t: number) => void) => number = (cb) => requestAnimationFrame(cb)) {
  if (!metrics.enabled() || !Number.isFinite(eventTimeStamp)) return;
  let done = false;
  const timeout = setTimeout(() => { if (!done) { done = true; metrics.record("pointer_to_paint_unmeasured", 1); } }, 100);
  raf((frameTime) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    const latency = frameTime - eventTimeStamp;
    if (latency >= 0 && latency < 10_000) metrics.record("pointer_to_paint_ms", latency);
    else metrics.record("pointer_to_paint_unmeasured", 1);
  });
}
