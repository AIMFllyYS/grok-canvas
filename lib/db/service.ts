/**
 * 单例 DB Worker 服务（contracts.md C4）：一个数据库文件一个长驻 worker_threads Worker。
 * - globalThis 内按 canonical 路径持有单例，路由 bundle 重复导入也不会重复 new Worker；
 * - requestId 关联请求；超时、Worker 退出时立即清理并 reject 在途回调；
 * - 队列上限 128 条 / 16MiB，单请求 4MiB；交互请求 5s 超时，维护任务 60s；
 * - 状态：starting → ready → closing → closed；Worker 意外退出 → crashed，需显式 restart。
 * 服务端私有模块，浏览器不得导入。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { dataDir } from "../data-dir";
import { DB_LIMITS, DB_OPS, DbError, type DbHealth, type DbLimits, type DbOp, type DbResponse } from "./protocol";

export { DbError } from "./protocol";

/**
 * Worker 入口解析（P3-02）：GROK_CANVAS_DB_WORKER（Electron 主进程注入）→ <cwd>/db-runtime/lib/db/worker.cjs
 * （standalone 产物，server.js 会 chdir 到自身目录）→ <cwd>/lib/db/worker.cjs（Node 开发）。
 */
export function resolveDbWorkerPath(cwd: string = process.cwd()): string {
  const configured = process.env.GROK_CANVAS_DB_WORKER;
  if (configured) return path.resolve(configured);
  const packaged = path.join(cwd, "db-runtime", "lib", "db", "worker.cjs");
  return existsSync(packaged) ? packaged : path.join(cwd, "lib", "db", "worker.cjs");
}

export type DbServiceOptions = {
  /** 数据库文件；默认 <dataDir>/grok-canvas.sqlite。 */
  file?: string;
  /** worker.cjs 路径；默认见 resolveDbWorkerPath。文件不存在时立即以 storage_unavailable 失败。 */
  workerPath?: string;
  /** 仅测试：开启 worker 内的测试 repository。 */
  enableTestRepository?: boolean;
  limits?: Partial<DbLimits>;
};

export type DbServiceState = "starting" | "ready" | "closing" | "closed" | "crashed";
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; bytes: number };

function canonicalFile(file: string): string {
  const directory = path.dirname(path.resolve(file));
  mkdirSync(directory, { recursive: true });
  const real = realpathSync.native(directory);
  const resolved = path.join(real, path.basename(file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const MAINTENANCE: ReadonlySet<DbOp> = new Set(["migrate", "backup", "maintenance"]);

function createDbService(key: string, file: string, options: DbServiceOptions, onClosed: () => void) {
  const limits: DbLimits = { ...DB_LIMITS, ...options.limits };
  const workerPath = path.resolve(options.workerPath ?? resolveDbWorkerPath());
  if (!existsSync(workerPath)) throw new DbError("storage_unavailable", `缺少 DB Worker：${workerPath}。打包产物须包含 db-runtime，或设置 GROK_CANVAS_DB_WORKER`);
  const pending = new Map<string, Pending>();
  let queuedBytes = 0;
  let state: DbServiceState = "starting";
  let worker: Worker;
  let exited: Promise<number>;

  const settle = (requestId: string) => {
    const entry = pending.get(requestId);
    if (!entry) return null;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    queuedBytes -= entry.bytes;
    return entry;
  };
  const failAll = (error: DbError) => { for (const id of [...pending.keys()]) settle(id)?.reject(error); };

  function start() {
    state = "starting";
    worker = new Worker(workerPath, { workerData: { file, busyTimeoutMs: limits.busyTimeoutMs, enableTestRepository: options.enableTestRepository === true } });
    worker.unref();
    worker.on("message", (response: DbResponse) => {
      const entry = settle(response.requestId);
      if (!entry) return;
      if (response.ok) entry.resolve(response.result);
      else entry.reject(new DbError(response.error.code, response.error.message));
    });
    worker.on("online", () => { if (state === "starting") state = "ready"; });
    exited = new Promise<number>((resolve) => {
      worker.once("exit", (code) => {
        if (state !== "closing") state = "crashed";
        failAll(new DbError("worker_exited", `DB Worker 已退出（code ${code}），结果未知的命令请按原 ID 查询`));
        resolve(code);
      });
    });
    worker.on("error", (error: unknown) => {
      if (state !== "closing") state = "crashed";
      failAll(new DbError("worker_exited", `DB Worker 异常：${error instanceof Error ? error.message : String(error)}`));
    });
  }
  start();

  function request<T = unknown>(op: DbOp, args: unknown = {}): Promise<T> {
    if (state === "closed" || state === "closing") return Promise.reject(new DbError("closed", "DB 服务已关闭"));
    if (state === "crashed") return Promise.reject(new DbError("worker_exited", "DB Worker 已退出，需显式 restart"));
    if (!(DB_OPS as readonly string[]).includes(op)) return Promise.reject(new DbError("unknown_op", `不支持的 DB 操作：${op}`));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(args ?? null)); }
    catch { return Promise.reject(new DbError("invalid_request", "请求参数不可序列化")); }
    if (bytes > limits.requestBytes) return Promise.reject(new DbError("request_too_large", `单个请求超过 ${limits.requestBytes} 字节`));
    if (pending.size >= limits.queueItems || queuedBytes + bytes > limits.queueBytes) return Promise.reject(new DbError("queue_full", "DB 队列已满，请稍后重试"));
    const requestId = randomUUID();
    const timeoutMs = MAINTENANCE.has(op) ? limits.maintenanceTimeoutMs : limits.interactiveTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { settle(requestId)?.reject(new DbError("timeout", `DB 请求超过 ${timeoutMs}ms`)); }, timeoutMs);
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer, bytes });
      queuedBytes += bytes;
      try { worker.postMessage({ requestId, op, args }); }
      catch (error) { settle(requestId)?.reject(new DbError("invalid_request", error instanceof Error ? error.message : String(error))); }
    });
  }

  const service = {
    file,
    state: () => state,
    pendingCount: () => pending.size,
    request,
    health: () => request<DbHealth>("health"),
    /** 只在 crashed 状态允许：重新启动 Worker；未确认的命令由调用方按原 ID 恢复查询。 */
    async restart() {
      if (state !== "crashed") throw new DbError("invalid_request", `当前状态 ${state} 不能重启`);
      start();
      await request("health");
    },
    /** 等待 checkpoint 与 close 完成后释放线程和单例。 */
    async close() {
      if (state === "closed") return;
      if (state !== "crashed") {
        try { await request("maintenance", { action: "close" }); } catch { /* Worker 已不可用 */ }
      }
      state = "closing";
      failAll(new DbError("closed", "DB 服务正在关闭"));
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (worker.threadId !== -1) await worker.terminate().catch(() => {});
      state = "closed";
      onClosed();
    },
  };
  void key;
  return service;
}

export type DbService = ReturnType<typeof createDbService>;

const globals = globalThis as typeof globalThis & { __grokCanvasDbServices?: Map<string, DbService> };
const services = (globals.__grokCanvasDbServices ??= new Map());

/** 按 canonical 数据库路径返回单例；已关闭的实例会被替换为新实例。 */
export function getDbService(options: DbServiceOptions = {}): DbService {
  const file = options.file ?? path.join(dataDir(), "grok-canvas.sqlite");
  const key = canonicalFile(file);
  const existing = services.get(key);
  if (existing && existing.state() !== "closed") return existing;
  const service = createDbService(key, key, options, () => { if (services.get(key) === service) services.delete(key); });
  services.set(key, service);
  return service;
}

export const activeDbServiceCount = () => services.size;

export async function closeAllDbServices(): Promise<void> {
  await Promise.all([...services.values()].map(service => service.close()));
}
