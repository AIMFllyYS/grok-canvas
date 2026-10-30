/**
 * 媒体派生服务（P4-02，contracts.md C7）：缩略图 thumb256/thumb1024 与视频 poster。
 * - 派生键 = assetName + variant + sourceHash（源文件 sha256 前 16 位）；同键请求共享一次处理（去重）。
 * - 处理在独立 Worker（derivative-worker.cjs，独占 sharp）中串行执行：并发 1、队列 ≤200；不持有网络或 SQL 事务。
 * - 产物先写临时文件，Worker 校验通过后原子发布（link 无覆盖），文件存在即 ready；崩溃后同键重做即可，不产生重复条目。
 * - 失败持久化为 <key>.failed.json，返回错误与重试入口，不自动无限重试；显式 retry 才清除。
 * - 旧素材只在访问时排队；视频 poster 只在用户首次主动播放后由客户端上传截帧生成，不批量提取。
 * 服务端私有模块。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { assetPath, isSafeAssetName } from "../assets";
import { dataDir } from "../data-dir";

export const VARIANTS = { thumb256: 256, thumb1024: 1024, poster: 1024 } as const;
export type Variant = keyof typeof VARIANTS;
export const isVariant = (value: string): value is Variant => Object.prototype.hasOwnProperty.call(VARIANTS, value);
export const QUEUE_LIMIT = 200;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;

export type DerivativeStatus =
  | { status: "ready"; url: string; width: number; height: number; sourceHash: string }
  | { status: "pending"; url: string; sourceHash: string }
  | { status: "failed"; url: string; sourceHash: string; error: { code: string; message: string }; retry: string }
  | { status: "absent"; url: string; reason: string };

export class DerivativeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = "DerivativeError"; this.code = code; this.status = status; }
}

export const derivativeUrl = (assetName: string, variant: Variant) => `/api/assets/${encodeURIComponent(assetName)}/derivative/${variant}`;
const derivativesDir = () => path.join(dataDir(), "derivatives");
const keyOf = (assetName: string, variant: Variant, sourceHash: string) => `${assetName}.${variant}.${sourceHash}`;
const filesOf = (key: string) => ({ file: path.join(derivativesDir(), `${key}.webp`), meta: path.join(derivativesDir(), `${key}.json`), failed: path.join(derivativesDir(), `${key}.failed.json`) });

/** Worker 入口：GROK_CANVAS_MEDIA_WORKER → <cwd>/media-runtime（standalone/Electron 产物）→ 仓库 lib/media（开发）。 */
export function resolveMediaWorkerPath(cwd: string = process.cwd()): string {
  const configured = process.env.GROK_CANVAS_MEDIA_WORKER;
  if (configured) return path.resolve(configured);
  const packaged = path.join(cwd, "media-runtime", "lib", "media", "derivative-worker.cjs");
  return existsSync(packaged) ? packaged : path.join(cwd, "lib", "media", "derivative-worker.cjs");
}

type Job = { id: string; op: "metadata" | "derive" | "poster" | "selftest"; args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void };

export type DerivativeServiceOptions = { workerPath?: string; queueLimit?: number };

export function createDerivativeService(options: DerivativeServiceOptions = {}) {
  const queueLimit = options.queueLimit ?? QUEUE_LIMIT;
  const workerPath = options.workerPath ?? resolveMediaWorkerPath();
  let worker: Worker | null = null;
  let current: Job | null = null;
  const queue: Job[] = [];
  const inflight = new Map<string, Promise<DerivativeStatus>>();
  const hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  let processed = 0;

  const spawn = () => {
    if (worker) return worker;
    if (!existsSync(workerPath)) throw new DerivativeError("worker_missing", `缺少媒体派生 Worker：${workerPath}`, 503);
    const created = new Worker(workerPath);
    created.on("message", (message: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }) => {
      const job = current;
      if (!job || job.id !== message.id) return;
      current = null;
      if (message.ok) job.resolve(message.result);
      else job.reject(new DerivativeError(message.error?.code ?? "invalid_image", message.error?.message ?? "派生失败", 422));
      pump();
    });
    const crash = (error: Error) => {
      worker = null;
      const job = current;
      current = null;
      // Worker 退出：在途任务失败但不写 failed 记录，下一次请求同键会重新排队。
      job?.reject(Object.assign(new DerivativeError("worker_exited", error.message, 503), { transient: true }));
      pump();
    };
    created.on("error", crash);
    created.on("exit", (code) => { if (worker === created) crash(new Error(`媒体 Worker 已退出（code ${code}）`)); });
    worker = created;
    return created;
  };

  function pump() {
    if (current || !queue.length) return;
    current = queue.shift()!;
    try { spawn().postMessage({ id: current.id, op: current.op, args: current.args }); }
    catch (error) { const job = current; current = null; job.reject(error as Error); pump(); }
  }

  function run<T>(op: Job["op"], args: Record<string, unknown>): Promise<T> {
    if (queue.length >= queueLimit) return Promise.reject(Object.assign(new DerivativeError("queue_full", `派生队列已满（${queueLimit}）`, 503), { transient: true }));
    return new Promise<T>((resolve, reject) => { queue.push({ id: randomUUID(), op, args, resolve: resolve as (v: unknown) => void, reject }); pump(); });
  }

  async function sourceHash(assetName: string): Promise<string> {
    const file = assetPath(assetName);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new DerivativeError("not_found", `素材 ${assetName} 不存在`, 404);
    const cached = hashes.get(assetName);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    const digest = hash.digest("hex").slice(0, 16);
    hashes.set(assetName, { size: info.size, mtimeMs: info.mtimeMs, hash: digest });
    return digest;
  }

  async function readReady(key: string, url: string, sourceHash: string): Promise<DerivativeStatus | null> {
    const files = filesOf(key);
    if (!existsSync(files.file)) return null;
    const meta = JSON.parse(await readFile(files.meta, "utf8").catch(() => "{}")) as { width?: number; height?: number };
    return { status: "ready", url, width: meta.width ?? 0, height: meta.height ?? 0, sourceHash };
  }

  async function readFailed(key: string, url: string, sourceHash: string): Promise<DerivativeStatus | null> {
    const raw = await readFile(filesOf(key).failed, "utf8").catch(() => null);
    if (!raw) return null;
    const error = JSON.parse(raw) as { code: string; message: string };
    return { status: "failed", url, sourceHash, error, retry: url };
  }

  /** 在 Worker 中生成到临时文件，再无覆盖地发布并写尺寸元数据；返回 ready。 */
  async function produce(key: string, url: string, sourceHash: string, op: "derive" | "poster", source: string, size: number): Promise<DerivativeStatus> {
    const files = filesOf(key);
    await mkdir(derivativesDir(), { recursive: true });
    const temporary = path.join(derivativesDir(), `.tmp-${randomUUID()}.webp`);
    try {
      const result = await run<{ width: number; height: number; bytes: number }>(op, { source, target: temporary, size });
      if (!(result.width > 0 && result.height > 0 && result.bytes > 0)) throw new DerivativeError("invalid_output", "派生结果为空", 422);
      await writeFile(files.meta, JSON.stringify({ width: result.width, height: result.height, bytes: result.bytes, sourceHash }));
      try { await link(temporary, files.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      processed++;
      return { status: "ready", url, width: result.width, height: result.height, sourceHash };
    } catch (error) {
      if (!(error as { transient?: boolean }).transient) {
        const failure = { code: (error as DerivativeError).code ?? "invalid_image", message: (error as Error).message };
        await writeFile(files.failed, JSON.stringify(failure)).catch(() => {});
        return { status: "failed", url, sourceHash, error: failure, retry: url };
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /**
   * 请求派生：ready/failed 直接返回；否则排队（同键共享）并立即返回 pending。
   * wait=true 时等待处理完成（测试与内部使用）。
   */
  async function requestDerivative(assetName: string, variant: Variant, opts: { wait?: boolean } = {}): Promise<DerivativeStatus> {
    if (!isSafeAssetName(assetName)) throw new DerivativeError("not_found", "素材名无效", 404);
    const url = derivativeUrl(assetName, variant);
    if (variant === "poster") {
      if (!VIDEO.test(assetName)) throw new DerivativeError("invalid_variant", "poster 只用于视频", 400);
      const hash = await sourceHash(assetName);
      const key = keyOf(assetName, variant, hash);
      return (await readReady(key, url, hash)) ?? (await readFailed(key, url, hash)) ?? { status: "absent", url, reason: "首次主动播放后由客户端提交截帧生成" };
    }
    if (!IMAGE.test(assetName)) throw new DerivativeError("invalid_variant", `${variant} 只用于图片`, 400);
    const hash = await sourceHash(assetName);
    const key = keyOf(assetName, variant, hash);
    const known = (await readReady(key, url, hash)) ?? (await readFailed(key, url, hash));
    if (known) return known;
    let task = inflight.get(key);
    if (!task) {
      // 队列满是暂时状态：直接告诉调用方稍后再试，不写 failed 记录。
      if (queue.length >= queueLimit) throw new DerivativeError("queue_full", `派生队列已满（${queueLimit}）`, 503);
      task = produce(key, url, hash, "derive", assetPath(assetName), VARIANTS[variant]).finally(() => inflight.delete(key));
      task.catch(() => {});
      inflight.set(key, task);
    }
    return opts.wait ? task : { status: "pending", url, sourceHash: hash };
  }

  /** 视频首次主动播放后：客户端截帧（PNG/JPEG/WebP 字节）→ Worker 校验并转存为 poster。 */
  async function submitPoster(assetName: string, frame: Uint8Array): Promise<DerivativeStatus> {
    if (!isSafeAssetName(assetName) || !VIDEO.test(assetName)) throw new DerivativeError("invalid_variant", "poster 只用于视频", 400);
    if (frame.byteLength === 0 || frame.byteLength > 8 * 1024 * 1024) throw new DerivativeError("invalid_input", "截帧大小必须在 1B..8MiB", 413);
    const hash = await sourceHash(assetName);
    const key = keyOf(assetName, "poster", hash);
    const url = derivativeUrl(assetName, "poster");
    const ready = await readReady(key, url, hash);
    if (ready) return ready;
    await mkdir(derivativesDir(), { recursive: true });
    const upload = path.join(derivativesDir(), `.frame-${randomUUID()}`);
    await writeFile(upload, frame, { flag: "wx" });
    try { return await produce(key, url, hash, "poster", upload, VARIANTS.poster); }
    finally { await unlink(upload).catch(() => {}); }
  }

  /** 显式重试：清除失败记录后重新排队。 */
  async function retry(assetName: string, variant: Variant): Promise<DerivativeStatus> {
    const hash = await sourceHash(assetName);
    await rm(filesOf(keyOf(assetName, variant, hash)).failed, { force: true });
    return requestDerivative(assetName, variant);
  }

  /** 已 ready 的派生文件路径（供路由流式返回）；未就绪返回 null。 */
  async function readyFile(assetName: string, variant: Variant): Promise<string | null> {
    const status = await requestDerivative(assetName, variant);
    return status.status === "ready" ? filesOf(keyOf(assetName, variant, status.sourceHash)).file : null;
  }

  return {
    requestDerivative, submitPoster, retry, readyFile,
    metadata: (assetName: string) => run<{ width: number; height: number; orientation: number; format: string; hasAlpha: boolean }>("metadata", { source: assetPath(assetName) }),
    selftest: () => run<{ ok: boolean }>("selftest", {}),
    stats: () => ({ queued: queue.length + (current ? 1 : 0), processed, inflight: inflight.size }),
    async close() { const w = worker; worker = null; await w?.terminate(); },
    /** 仅测试：模拟 Worker 崩溃。 */
    async crashForTest() { await worker?.terminate(); },
  };
}

export type DerivativeService = ReturnType<typeof createDerivativeService>;
let shared: DerivativeService | null = null;
/** 进程单例；首次排队时才启动 Worker。 */
export function getDerivativeService(): DerivativeService {
  shared ??= createDerivativeService();
  return shared;
}

/** 上传/生成落盘后的排队接点：图片预排 thumb256，失败不影响已保存的正式资产记录。 */
export function scheduleDerivatives(assetName: string): void {
  if (!IMAGE.test(assetName)) return;
  getDerivativeService().requestDerivative(assetName, "thumb256").catch(() => {});
}
