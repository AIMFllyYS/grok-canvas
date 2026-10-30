import type { CanvasDoc } from "./canvas-store";
import type { CanvasOperation } from "./canvas-operations";
import { createLatestQueue } from "./canvas-runtime/latest-queue";
import type { GeometryCheckpoint } from "./canvas-runtime/geometry-journal";
import { openCanvasDatabase } from "./canvas-runtime/outbox";

export type CanvasDraft = {
  key: string;
  canvasId: string;
  base: CanvasDoc;
  working: CanvasDoc;
  checkpointThrough?: number;
  pending?: { base: CanvasDoc; snapshot: CanvasDoc; operations: CanvasOperation[] } | null;
};

const queue = createLatestQueue();
/** v1 drafts 与 v2 outbox 共用同一个本地库（v2 升级保留 drafts，见 outbox.ts）。 */
function openDatabase(): Promise<IDBDatabase> {
  return openCanvasDatabase();
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
/** 只读 v1 兼容入口：列出该画布所有标签页留下的完整草稿（不含坐标检查点），供一次性恢复转换。 */
export function listLegacyDrafts(canvasId: string): Promise<CanvasDraft[]> {
  return enqueue(async () => {
    const prefix = `${canvasId}:`;
    const records = await transact<CanvasDraft[]>("readonly", store => store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)) as IDBRequest<CanvasDraft[]>);
    return records.filter(record => record.canvasId === canvasId && !record.key.includes(":geometry:"));
  });
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
