/**
 * DB Worker 协议（contracts.md C4）。op 为固定白名单；query/command 再映射到固定 repository 名称，
 * HTTP 端与浏览器都不能提交任意 SQL。本文件只含类型与常量，服务端私有。
 */
export const DB_OPS = ["health", "query", "command", "migrate", "backup", "maintenance"] as const;
export type DbOp = (typeof DB_OPS)[number];

export type DbRequest = { requestId: string; op: DbOp; args: unknown };
export type DbErrorCode =
  | "queue_full" | "request_too_large" | "timeout" | "worker_exited" | "closed"
  | "invalid_request" | "unknown_op" | "unknown_repository" | "constraint" | "storage_unavailable" | "not_found";
export type DbResponse =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: { code: DbErrorCode; message: string } };

export const DB_LIMITS = {
  queueItems: 128,
  queueBytes: 16 * 1024 * 1024,
  requestBytes: 4 * 1024 * 1024,
  interactiveTimeoutMs: 5_000,
  maintenanceTimeoutMs: 60_000,
  busyTimeoutMs: 2_000,
} as const;
export type DbLimits = { -readonly [K in keyof typeof DB_LIMITS]: number };

export const MIN_SQLITE_VERSION = "3.51.3";

export type DbHealth = {
  ok: boolean;
  driver: "better-sqlite3";
  driverVersion: string;
  sqliteVersion: string;
  sqliteVersionOk: boolean;
  pragmas: { journal_mode: string; synchronous: number; foreign_keys: number; busy_timeout: number };
  configOk: boolean;
  compileOptions: string[];
  runtime: { node: string; modules: string; napi: string | null; electron: string | null; platform: string; arch: string; execPath: string };
  workerThreadId: number;
  file: string;
  nativeBinding: string | null;
};

export class DbError extends Error {
  readonly code: DbErrorCode;
  constructor(code: DbErrorCode, message: string) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

/** 点分版本比较：a ≥ b 返回 true。 */
export function versionAtLeast(a: string, b: string): boolean {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0, y = right[index] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
