import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./data-dir";
import { notifyCanvasChanged } from "./canvas-runtime/change-bus";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets, type CanvasLibraryAsset } from "./canvas-library";
import { cleanCanvas } from "./canvas-cleanup";
import { bumpVersionsForLegacyWrite, type CanvasCommandState } from "./canvas-runtime/command-state";
import { assertJsonWritable, isSqliteMode } from "./db/storage-mode";
/** SQLite 实现只在切换后按需加载：JSON 模式不引入命令服务与数据库模块。 */
const sqlRecords = () => import("./db/sql-records");

const DATA_DIR = dataDir();
const CANVASES_DIR = path.join(DATA_DIR, "canvases");
const APP_STATE_FILE = path.join(DATA_DIR, "app-state.json");
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
// API route bundles and Agent tools must serialize writes through the same queue.
const canvasGlobals = globalThis as typeof globalThis & { __grokCanvasStores?: Map<string, { writes: Map<string, Promise<void>>; deletedIds: Set<string> }> };
const stores = (canvasGlobals.__grokCanvasStores ??= new Map());
if (!stores.has(DATA_DIR)) stores.set(DATA_DIR, { writes: new Map(), deletedIds: new Set() });
const { writes, deletedIds } = stores.get(DATA_DIR)!;

async function withCanvasLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  writes.set(id, tail);
  await previous;
  try { return await action(); } finally {
    release();
    if (writes.get(id) === tail) writes.delete(id);
  }
}

/** Coordinate short-lived per-field leases with canvas mutations. */
export async function withExistingCanvas<T>(id: string, action: (doc: CanvasDoc) => T): Promise<T | null> {
  return withCanvasLock(id, async () => {
    if (deletedIds.has(id)) return null;
    const doc = await loadCanvas(id);
    return doc ? action(doc) : null;
  });
}

/**
 * 原子替换目标文件。Windows 上并发 rename 或目标被短暂占用会返回 EPERM/EBUSY，
 * 短暂重试即可成功，不需放宽原子性。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

export type CanvasSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type CanvasDoc = {
  id: string;
  name: string;
  schemaVersion: 1;
  revision: number;
  createdAt: string;
  updatedAt: string;
  viewport: { x: number; y: number; zoom: number };
  nodes: unknown[];
  edges: unknown[];
  libraryAssets?: CanvasLibraryAsset[];
  /** Durable operation IDs allow safe retry after a lost response. */
  appliedOperationIds?: string[];
  generationClaims?: Record<string, { id: string; state: "pending" | "unknown"; taskId?: string }>;
  /**
   * JSON 兼容阶段的命令元数据（字段版本、回执、actor 水位、墓碑）。只由服务端命令仓库写入；
   * 客户端整份保存带来的值一律忽略。对外输出前用 publicCanvas 去掉。
   */
  commandState?: CanvasCommandState;
};

/** 对外（HTTP/Agent 工具）输出的画布：不含服务端命令元数据，保持旧响应形状。 */
export function publicCanvas<T extends CanvasDoc | Omit<CanvasDoc, "revision" | "updatedAt">>(doc: T): Omit<T, "commandState"> {
  const { commandState: _state, ...rest } = doc;
  return rest;
}

export function isSafeCanvasId(id: string): boolean {
  return SAFE_ID.test(id);
}

function canvasPath(id: string): string {
  if (!isSafeCanvasId(id)) {
    throw new Error(`unsafe canvas id: ${id}`);
  }
  return path.join(CANVASES_DIR, `${id}.json`);
}

export function emptyCanvas(id: string): CanvasDoc {
  const now = new Date().toISOString();
  return {
    id,
    name: "未命名画布",
    schemaVersion: 1,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    libraryAssets: [],
  };
}

/** Load a canvas; the default canvas is created on first access. */
export async function loadCanvas(id: string): Promise<CanvasDoc | null> {
  // P3-08：storage-state 标记为 SQLite 时唯一权威是数据库；旧 JSON 文件只读保留，不再读取。
  if (isSqliteMode()) return deletedIds.has(id) ? null : (await sqlRecords()).loadCanvasSql(id);
  try {
    const raw = await readFile(canvasPath(id), "utf8");
    return cleanCanvas(JSON.parse(raw) as CanvasDoc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return id === "default" && !deletedIds.has(id) ? emptyCanvas(id) : null;
    }
    throw error;
  }
}

/**
 * Save with optimistic concurrency: `expectedRevision` must match the stored
 * revision or the save is rejected (returns null) instead of silently
 * overwriting newer state.
 */
export async function saveCanvas(
  doc: Omit<CanvasDoc, "revision" | "updatedAt">,
  expectedRevision: number,
): Promise<CanvasDoc | null> {
  const saved = await withCanvasLock(doc.id, async () => {
    if (deletedIds.has(doc.id)) return null;
    if (isSqliteMode()) return saveCanvasSql(doc, expectedRevision);
    const current = await loadCanvas(doc.id);
    const currentRevision = current?.revision ?? -1;
    if (currentRevision !== expectedRevision) return null;
    return writeCanvas(doc, current, currentRevision);
  });
  if (saved) notifyCanvasChanged({ canvasId: doc.id, revision: saved.revision, actorId: null });
  return saved;
}

/**
 * SSE 事件流的低成本修订探测（P3-09）：JSON 模式先比较文件 mtime/大小，未变化直接复用上次结果；
 * SQLite 模式只查 canvases 一行。画布不存在返回 null。
 */
const revisionCache = new Map<string, { mtimeMs: number; size: number; revision: number }>();
export async function canvasRevision(id: string): Promise<{ revision: number } | null> {
  if (!isSafeCanvasId(id) || deletedIds.has(id)) return null;
  if (isSqliteMode()) return (await sqlRecords()).canvasRevisionSql(id);
  try {
    const info = await stat(canvasPath(id));
    const cached = revisionCache.get(id);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return { revision: cached.revision };
    const doc = await loadCanvas(id);
    if (!doc) return null;
    revisionCache.set(id, { mtimeMs: info.mtimeMs, size: info.size, revision: doc.revision });
    return { revision: doc.revision };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return id === "default" ? { revision: 0 } : null;
    throw error;
  }
}

/** SQLite 模式的旧 PUT：新建画布直接落库；已有画布按 revision 前置条件转成带版本的命令，冲突返回 null（409）。 */
async function saveCanvasSql(doc: Omit<CanvasDoc, "revision" | "updatedAt">, expectedRevision: number): Promise<CanvasDoc | null> {
  if (expectedRevision === -1) {
    if (await (await sqlRecords()).loadCanvasSql(doc.id)) return null;
    await (await sqlRecords()).createCanvasSql(doc.id, doc.name, doc.viewport);
    if (!doc.nodes.length && !doc.edges.length && !doc.libraryAssets?.length) return (await sqlRecords()).loadCanvasSql(doc.id);
    expectedRevision = 0;
  }
  try {
    return await (await sqlRecords()).transformCanvasSql(doc.id, current => ({ ...current, name: doc.name, viewport: doc.viewport, nodes: doc.nodes, edges: doc.edges, ...(doc.libraryAssets !== undefined ? { libraryAssets: doc.libraryAssets } : {}) }), { access: "user", expectedRevision });
  } catch (error) {
    if ((await sqlRecords()).isConflict(error)) return null;
    throw error;
  }
}

type WriteMode = { command: boolean; bumpRevision: boolean };
const LEGACY_WRITE: WriteMode = { command: false, bumpRevision: true };

async function writeCanvas(doc: Omit<CanvasDoc, "revision" | "updatedAt">, current: CanvasDoc | null, revision: number, mode: WriteMode = LEGACY_WRITE): Promise<CanvasDoc> {
  assertJsonWritable("canvas-store.writeCanvas");
  let libraryAssets = mergeLibraryAssets(normalizeLibraryAssets(current?.libraryAssets), normalizeLibraryAssets(doc.libraryAssets));
  libraryAssets = mergeLibraryAssets(libraryAssets, collectCanvasAssets(doc.nodes, doc.createdAt, libraryAssets));
  const appliedOperationIds = [...new Set([...(current?.appliedOperationIds ?? []), ...(doc.appliedOperationIds ?? [])])];
  const generationClaims = doc.generationClaims ?? current?.generationClaims;
  // 命令元数据只信任命令仓库；旧路径写入沿用服务端当前值，并按差异递增受影响字段的版本。
  const { commandState: incomingState, ...body } = doc;
  const commandState = mode.command
    ? incomingState
    : current?.commandState && bumpVersionsForLegacyWrite(current.commandState, current, { ...body, revision, updatedAt: current.updatedAt } as CanvasDoc);
  const next: CanvasDoc = {
    ...body,
    ...(generationClaims ? { generationClaims } : {}),
    ...(appliedOperationIds.length ? { appliedOperationIds } : {}),
    ...(commandState ? { commandState } : {}),
    libraryAssets,
    revision: mode.bumpRevision ? revision + 1 : revision,
    updatedAt: mode.bumpRevision || !current ? new Date().toISOString() : current.updatedAt,
  };
  const file = canvasPath(doc.id);
  await mkdir(CANVASES_DIR, { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next)}\n`, "utf8");
    await renameWithRetry(tmp, file);
  } finally { await unlink(tmp).catch(() => {}); }
  return next;
}

/** Run a synchronous edit against the latest canvas under the same lock as saves and deletes. */
export async function updateCanvas(id: string, edit: (doc: CanvasDoc) => void | false): Promise<CanvasDoc | null> {
  return transformCanvas(id, current => {
    const next = structuredClone(current);
    return edit(next) === false ? current : next;
  });
}

/**
 * 不可变命令入口，与旧修改入口共用写锁；返回原引用表示已处理，不再写盘。
 * SQLite 模式：实体差异转为带前置版本的命令，画布字段单独写入；access="user" 用于旧客户端协议（只允许用户字段）。
 */
export async function transformCanvas(id: string, edit: (doc: CanvasDoc) => CanvasDoc, options: { access?: "user" | "service" } = {}): Promise<CanvasDoc | null> {
  return withCanvasLock(id, async () => {
    if (deletedIds.has(id)) return null;
    if (isSqliteMode()) return (await sqlRecords()).transformCanvasSql(id, edit, { access: options.access ?? "service" });
    const current = await loadCanvas(id);
    if (!current) return null;
    const next = edit(current);
    if (next === current) return current;
    if (next.id !== id) throw new Error("命令不能更改画布 ID");
    return writeCanvas(next, current, current.revision);
  });
}

/**
 * 领域命令仓库的写入口：与其他写入共用画布锁，原子整文件写。
 * edit 返回 next=null 表示无需写盘（重放/只读）；bumpRevision=false 用于空变更或拒绝记录，
 * 只持久化 commandState，不改变对外可见的 revision。画布不存在或已删除时返回 null。
 */
export async function commitCommandWrite<T>(id: string, edit: (doc: CanvasDoc) => { next: CanvasDoc | null; bumpRevision: boolean; result: T }): Promise<{ saved: CanvasDoc; result: T } | null> {
  assertJsonWritable("canvas-store.commitCommandWrite");
  return withCanvasLock(id, async () => {
    if (deletedIds.has(id)) return null;
    const current = await loadCanvas(id);
    if (!current) return null;
    const { next, bumpRevision, result } = edit(current);
    if (!next) return { saved: current, result };
    if (next.id !== id) throw new Error("命令不能更改画布 ID");
    const saved = await writeCanvas(next, current, current.revision, { command: true, bumpRevision });
    return { saved, result };
  });
}

/** Create a brand-new empty canvas and persist it. */
export async function createCanvas(): Promise<CanvasDoc> {
  const created = await saveCanvas(emptyCanvas(crypto.randomUUID()), -1);
  if (!created) {
    throw new Error("failed to create canvas");
  }
  return created;
}

/** All canvas summaries, newest first by creation time. Corrupt files are skipped. */
export async function listCanvases(): Promise<CanvasSummary[]> {
  if (isSqliteMode()) return (await sqlRecords()).listCanvasesSql();
  await mkdir(CANVASES_DIR, { recursive: true });
  const files = (await readdir(CANVASES_DIR)).filter((file) => file.endsWith(".json"));
  const summaries: CanvasSummary[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(CANVASES_DIR, file), "utf8");
      const doc = JSON.parse(raw) as CanvasDoc;
      summaries.push({ id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
    } catch {
      // 跳过损坏的画布文件
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadLastCanvasId(): Promise<string | null> {
  if (isSqliteMode()) return (await sqlRecords()).loadLastCanvasIdSql();
  try {
    const raw = await readFile(APP_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { lastCanvasId?: unknown };
    return typeof parsed.lastCanvasId === "string" ? parsed.lastCanvasId : null;
  } catch {
    return null;
  }
}

// app-state.json 只记录最近画布；并发打开页面会同时写入，因此串行执行。
let appStateQueue: Promise<void> = Promise.resolve();

export function saveLastCanvasId(id: string): Promise<void> {
  const task = appStateQueue.catch(() => {}).then(() => writeLastCanvasId(id));
  appStateQueue = task.catch(() => {});
  return task;
}

async function writeLastCanvasId(id: string): Promise<void> {
  if (isSqliteMode()) return (await sqlRecords()).saveLastCanvasIdSql(id);
  assertJsonWritable("canvas-store.writeLastCanvasId");
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${APP_STATE_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ lastCanvasId: id })}\n`, "utf8");
    await renameWithRetry(tmp, APP_STATE_FILE);
  } finally { await unlink(tmp).catch(() => {}); }
}

/** Delete a canvas file. Returns false when it did not exist. Assets are untouched. */
export async function deleteCanvas(id: string, canDelete?: () => boolean): Promise<boolean> {
  return withCanvasLock(id, async () => {
    if (canDelete && !canDelete()) throw new Error("画布 Agent 正在运行，请先停止");
    if (isSqliteMode()) { const removed = await (await sqlRecords()).deleteCanvasSql(id); deletedIds.add(id); return removed; }
    assertJsonWritable("canvas-store.deleteCanvas");
    try {
      await unlink(canvasPath(id));
      deletedIds.add(id);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { deletedIds.add(id); return false; }
      throw error;
    }
  });
}
