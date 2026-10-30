/**
 * 存储权威（P3-08，contracts.md C6）：<dataDir>/storage-state.json 是唯一切换标记。
 * - 不存在：JSON 权威（默认）；
 * - {version:1, backend:"sqlite", epoch, dbFile, importRunId}：SQLite 权威，旧 JSON 只读保留；
 * - 存在但无效、或 DB 文件缺失：进入恢复（StorageRecoveryError），绝不回退到 JSON。
 * 所有持久入口先问这里；SQLite 模式下任何旧 JSON 写函数调用 assertJsonWritable 会抛错并计数。
 * 服务端私有模块。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../data-dir";

export const STORAGE_STATE_FILE = "storage-state.json";
export type SqliteState = { version: 1; backend: "sqlite"; epoch: string; dbFile: string; importRunId: string };
export type StorageState = { backend: "json" } | SqliteState;

export class StorageRecoveryError extends Error {
  readonly code = "storage_recovery";
  readonly status = 503;
  constructor(message: string) { super(message); this.name = "StorageRecoveryError"; }
}

export class JsonReadonlyError extends Error {
  readonly code = "json_readonly";
  readonly status = 409;
  constructor(entry: string) { super(`已切换到 SQLite：旧 JSON 只读，拒绝写入（${entry}）`); this.name = "JsonReadonlyError"; }
}

const globals = globalThis as typeof globalThis & { __grokJsonWriteAttempts?: Map<string, number>; __grokStorageCache?: Map<string, { mtimeMs: number; state: StorageState }> };
/** SQLite 模式下被拒绝的旧 JSON 写入次数（按入口）；测试据此断言为 0 或被拦截。 */
export const jsonWriteAttempts = (globals.__grokJsonWriteAttempts ??= new Map());
const cache = (globals.__grokStorageCache ??= new Map());

export function storageStatePath(dir: string = dataDir()): string {
  return path.join(dir, STORAGE_STATE_FILE);
}

/** 解析标记；每次 stat（文件很小），mtime 不变时用缓存。 */
export function readStorageState(dir: string = dataDir()): StorageState {
  const file = storageStatePath(dir);
  if (!existsSync(file)) { cache.delete(file); return { backend: "json" }; }
  const mtimeMs = statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.state;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new StorageRecoveryError("storage-state.json 无法解析，进入恢复；不会回退到旧 JSON"); }
  const state = parsed as Partial<SqliteState>;
  if (state.version !== 1 || state.backend !== "sqlite" || typeof state.epoch !== "string" || !/^sqlite-[0-9a-z-]+$/.test(state.epoch) || typeof state.dbFile !== "string" || typeof state.importRunId !== "string") {
    throw new StorageRecoveryError("storage-state.json 内容无效，进入恢复");
  }
  const dbPath = path.resolve(dir, state.dbFile);
  const rel = path.relative(path.resolve(dir), dbPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new StorageRecoveryError("storage-state.json 指向数据目录之外的数据库");
  if (!existsSync(dbPath)) throw new StorageRecoveryError(`SQLite 数据库缺失：${state.dbFile}。进入恢复，不会回退到旧 JSON`);
  const result: SqliteState = { version: 1, backend: "sqlite", epoch: state.epoch, dbFile: state.dbFile, importRunId: state.importRunId };
  cache.set(file, { mtimeMs, state: result });
  return result;
}

export const isSqliteMode = (dir?: string) => readStorageState(dir).backend === "sqlite";

export function sqliteDbPath(state: SqliteState, dir: string = dataDir()): string {
  return path.resolve(dir, state.dbFile);
}

/** 旧 JSON 写函数的守卫：SQLite 模式下计数并拒绝。 */
export function assertJsonWritable(entry: string): void {
  if (readStorageState().backend === "json") return;
  jsonWriteAttempts.set(entry, (jsonWriteAttempts.get(entry) ?? 0) + 1);
  throw new JsonReadonlyError(entry);
}
