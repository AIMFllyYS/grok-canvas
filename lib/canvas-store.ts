import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./data-dir";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets, type CanvasLibraryAsset } from "./canvas-library";
import { cleanCanvas } from "./canvas-cleanup";

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
};

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
  return withCanvasLock(doc.id, async () => {
    if (deletedIds.has(doc.id)) return null;
    const current = await loadCanvas(doc.id);
    const currentRevision = current?.revision ?? -1;
    if (currentRevision !== expectedRevision) return null;
    return writeCanvas(doc, current, currentRevision);
  });
}

async function writeCanvas(doc: Omit<CanvasDoc, "revision" | "updatedAt">, current: CanvasDoc | null, revision: number): Promise<CanvasDoc> {
  let libraryAssets = mergeLibraryAssets(normalizeLibraryAssets(current?.libraryAssets), normalizeLibraryAssets(doc.libraryAssets));
  libraryAssets = mergeLibraryAssets(libraryAssets, collectCanvasAssets(doc.nodes, doc.createdAt, libraryAssets));
  const appliedOperationIds = [...new Set([...(current?.appliedOperationIds ?? []), ...(doc.appliedOperationIds ?? [])])];
  const generationClaims = doc.generationClaims ?? current?.generationClaims;
  const next: CanvasDoc = { ...doc, ...(generationClaims ? { generationClaims } : {}), ...(appliedOperationIds.length ? { appliedOperationIds } : {}), libraryAssets, revision: revision + 1, updatedAt: new Date().toISOString() };
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
  return withCanvasLock(id, async () => {
    if (deletedIds.has(id)) return null;
    const current = await loadCanvas(id);
    if (!current) return null;
    const next = structuredClone(current);
    if (edit(next) === false) return current;
    return writeCanvas(next, current, current.revision);
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
