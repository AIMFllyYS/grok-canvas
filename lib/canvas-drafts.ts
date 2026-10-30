import type { CanvasDoc } from "./canvas-store";
import type { CanvasOperation } from "./canvas-operations";
import { createLatestQueue } from "./canvas-runtime/latest-queue";
import type { GeometryCheckpoint } from "./canvas-runtime/geometry-journal";

export type CanvasDraft = {
  key: string;
  canvasId: string;
  base: CanvasDoc;
  working: CanvasDoc;
  checkpointThrough?: number;
  pending?: { base: CanvasDoc; snapshot: CanvasDoc; operations: CanvasOperation[] } | null;
};

let database: Promise<IDBDatabase> | undefined;
const queue = createLatestQueue();
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("grok-canvas-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿"));
    request.onblocked = () => reject(new Error("本地草稿数据库被占用"));
  }).catch(error => { database = undefined; throw error; });
  return database!;
}
function enqueue<T>(action: () => Promise<T>): Promise<T> {
  return queue.barrier(action);
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    let request: IDBRequest<T>;
    try { request = action(tx.objectStore("drafts")); }
    catch (error) { tx.abort(); reject(error); return; }
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("本地草稿操作失败"));
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("本地草稿事务失败"));
    tx.onerror = () => reject(tx.error ?? new Error("本地草稿事务失败"));
  });
}
export function canvasDraftKey(canvasId: string): string {
  const storageKey = "grok-canvas-draft-session";
  let session = sessionStorage.getItem(storageKey);
  if (!session) { session = crypto.randomUUID(); sessionStorage.setItem(storageKey, session); }
  return `${canvasId}:${session}`;
}
export function loadCanvasDraft(key: string): Promise<CanvasDraft | undefined> {
  return enqueue(() => transact("readonly", store => store.get(key)));
}
/** 调用者传入不可变文档引用；只在任务真正开始时由 IndexedDB 克隆一次。 */
export function saveCanvasDraft(draft: CanvasDraft): Promise<void> {
  return queue.latest(draft.key, draft, async snapshot => {
    await transact("readwrite", store => {
      const request = store.put(snapshot);
      if (snapshot.checkpointThrough !== undefined) store.delete(geometryRange(snapshot.key, snapshot.checkpointThrough));
      return request;
    });
  });
}
export function clearCanvasDraft(key: string, checkpointThrough?: number): Promise<void> {
  return enqueue(async () => {
    await transact("readwrite", store => {
      const request = store.delete(key);
      if (checkpointThrough !== undefined) store.delete(geometryRange(key, checkpointThrough));
      return request;
    });
  });
}

function geometryRange(key: string, through?: number): IDBKeyRange {
  if (through !== undefined && (!Number.isSafeInteger(through) || through < 0)) throw new Error("坐标检查点序号无效");
  const prefix = `${key}:geometry:`;
  return IDBKeyRange.bound(prefix, `${prefix}${through === undefined ? "\uffff" : String(through).padStart(16, "0")}`);
}

/** 同一手势仅保留最新坐标，不携带正文、素材或整份画布。 */
export function saveGeometryCheckpoint(key: string, canvasId: string, checkpoint: GeometryCheckpoint): Promise<void> {
  geometryRange(key, checkpoint.sequence);
  const record = { ...checkpoint, key: `${key}:geometry:${String(checkpoint.sequence).padStart(16, "0")}`, canvasId };
  return queue.latest(record.key, record, async snapshot => { await transact("readwrite", store => store.put(snapshot)); });
}

export function loadGeometryCheckpoints(key: string, canvasId: string): Promise<GeometryCheckpoint[]> {
  return enqueue(async () => {
    const records = await transact<Array<GeometryCheckpoint & { canvasId: string }>>("readonly", store => store.getAll(geometryRange(key)));
    if (records.some(record => record.canvasId !== canvasId)) throw new Error("坐标检查点的画布不匹配");
    return records;
  });
}
