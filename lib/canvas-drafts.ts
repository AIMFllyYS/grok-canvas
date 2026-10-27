import type { CanvasDoc } from "./canvas-store";
import type { CanvasOperation } from "./canvas-operations";

export type CanvasDraft = {
  key: string;
  canvasId: string;
  base: CanvasDoc;
  working: CanvasDoc;
  pending?: { base: CanvasDoc; snapshot: CanvasDoc; operations: CanvasOperation[] } | null;
};

let database: Promise<IDBDatabase> | undefined;
let queue: Promise<void> = Promise.resolve();
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
  const next = queue.catch(() => {}).then(action);
  queue = next.then(() => {}, () => {});
  return next;
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    const request = action(tx.objectStore("drafts"));
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
export function saveCanvasDraft(draft: CanvasDraft): Promise<void> {
  const snapshot = structuredClone(draft);
  return enqueue(async () => { await transact("readwrite", store => store.put(snapshot)); });
}
export function clearCanvasDraft(key: string): Promise<void> {
  return enqueue(async () => { await transact("readwrite", store => store.delete(key)); });
}
