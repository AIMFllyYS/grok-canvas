/**
 * 客户端增量 Outbox（contracts.md C3）：IndexedDB v2 中的待确认命令日志。
 * - actorId 存于会话存储；actorSeq 与命令在同一事务中分配，刷新后序号继续；
 * - queued 同字段合并（最早 before/expectedVersion + 最新 after），sent 后载荷与 ID 不可改；
 * - ack 在同一事务中删除该命令、写确认水位、清理已覆盖的检查点；
 * - 1000 项 / 16MiB 上限：超出时新命令在写入前被明确拒绝，不丢已接受的修改；
 * - 任一写入失败使整个事务 abort。
 * 浏览器模块：不导入 node: 内置模块。
 */
import type { CanvasCommand, CommandErrorCode, CommitReceipt } from "./types";

export const CANVAS_DB_NAME = "grok-canvas-drafts";
export const CANVAS_DB_VERSION = 2;
export const OUTBOX_LIMITS = { items: 1000, bytes: 16 * 1024 * 1024 } as const;
const ACTOR_SESSION_KEY = "grok-canvas-actor-id";

export type OutboxState = "queued" | "sent" | "conflict";
export type CommandDraft = { kind: CanvasCommand["kind"]; payload: unknown; storageEpoch: string; baseRevision: number };
export type OutboxRecord = {
  canvasId: string;
  actorId: string;
  actorSeq: number;
  command: CanvasCommand;
  state: OutboxState;
  createdAt: number;
  bytes: number;
  mergeKey: string | null;
  error?: { code: CommandErrorCode | string; message: string };
};
export type CheckpointRecord = { canvasId: string; actorId: string; sequence: number; [key: string]: unknown };
export type Watermark = { ackSeq: number; revision: number; eventSeq: number };

export class OutboxError extends Error {
  readonly code: "queue_full" | "not_found" | "mismatch" | "not_conflict";
  constructor(code: OutboxError["code"], message: string) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- IndexedDB 基础

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("本地存储请求失败"));
});

/** 事务内只能链式等待 IDB 请求；body 抛错即 abort，整个事务不留任何写入。 */
export async function inTransaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("本地事务已中止"));
  });
  let result: T;
  try {
    result = await body(tx);
  } catch (error) {
    try { tx.abort(); } catch { /* 已结束 */ }
    await done.catch(() => {});
    throw error;
  }
  await done;
  return result!;
}

let opening: Promise<IDBDatabase> | undefined;

/**
 * 打开 v2 本地库：保留 v1 drafts，新增 outbox/checkpoints/client_state。
 * 升级在 versionchange 事务内进行，异常时整个升级回滚，旧数据不删除。
 */
export function openCanvasDatabase(options: { upgradeHook?: (db: IDBDatabase) => void } = {}): Promise<IDBDatabase> {
  if (opening && !options.upgradeHook) return opening;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(CANVAS_DB_NAME, CANVAS_DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      try {
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: ["canvasId", "actorId", "actorSeq"] });
        if (!db.objectStoreNames.contains("checkpoints")) db.createObjectStore("checkpoints", { keyPath: ["canvasId", "actorId", "sequence"] });
        if (!db.objectStoreNames.contains("client_state")) db.createObjectStore("client_state", { keyPath: "key" });
        options.upgradeHook?.(db);
      } catch (error) {
        open.transaction?.abort();
        reject(error);
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error("无法打开本地画布库"));
    open.onblocked = () => reject(new Error("本地画布库被旧页面占用，请关闭其他画布标签页后重试"));
  });
  if (!options.upgradeHook) {
    opening = promise.catch(error => { opening = undefined; throw error; });
    return opening;
  }
  return promise;
}

const canvasRange = (canvasId: string) => IDBKeyRange.bound([canvasId], [canvasId, []]);
const actorRange = (canvasId: string, actorId: string) => IDBKeyRange.bound([canvasId, actorId], [canvasId, actorId, []]);
const encoder = new TextEncoder();
const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

// ---------------------------------------------------------------- 合并

type MoveItem = { nodeId: string; expectedVersion: number; from: unknown; to: unknown };
type PatchItem = { nodeId: string; field: string; expectedVersion: number; value: unknown };

/** 只合并单一类型的移动或字段补丁；键集合必须完全相同。 */
export function mergeKeyOf(draft: CommandDraft): string | null {
  if (draft.kind === "move_nodes") return `move:${(draft.payload as { items: MoveItem[] }).items.map(item => item.nodeId).sort().join("|")}`;
  if (draft.kind === "patch_nodes") return `patch:${(draft.payload as { items: PatchItem[] }).items.map(item => `${item.nodeId}/${item.field}`).sort().join("|")}`;
  return null;
}

function mergePayload(kind: CanvasCommand["kind"], earlier: unknown, later: unknown): unknown {
  if (kind === "move_nodes") {
    const latest = new Map((later as { items: MoveItem[] }).items.map(item => [item.nodeId, item]));
    return { items: (earlier as { items: MoveItem[] }).items.map(item => ({ ...item, to: structuredClone(latest.get(item.nodeId)!.to) })) };
  }
  const latest = new Map((later as { items: PatchItem[] }).items.map(item => [`${item.nodeId}/${item.field}`, item]));
  return { items: (earlier as { items: PatchItem[] }).items.map(item => ({ ...item, value: structuredClone(latest.get(`${item.nodeId}/${item.field}`)!.value) })) };
}

// ---------------------------------------------------------------- 事务内写入

type Totals = { key: "totals"; items: number; bytes: number };
type EnqueueOptions = { merge: boolean; limits: { items: number; bytes: number }; now: () => number; createId: () => string };

/** 在调用方的事务中分配序号并写入；恢复转换复用它与迁移标记同事务提交。 */
export async function enqueueWithin(tx: IDBTransaction, actorId: string, canvasId: string, draft: CommandDraft, options: EnqueueOptions): Promise<OutboxRecord> {
  const outbox = tx.objectStore("outbox"), state = tx.objectStore("client_state");
  const seqKey = `seq:${canvasId}:${actorId}`;
  const seq = (await request(state.get(seqKey)) as { nextSeq: number } | undefined)?.nextSeq ?? 1;
  const totals = (await request(state.get("totals")) as Totals | undefined) ?? { key: "totals", items: 0, bytes: 0 };
  const mergeKey = mergeKeyOf(draft);
  if (options.merge && mergeKey) {
    const cursor = await request(outbox.openCursor(actorRange(canvasId, actorId), "prev"));
    const tail = cursor?.value as OutboxRecord | undefined;
    if (tail && tail.state === "queued" && tail.mergeKey === mergeKey && tail.command.storageEpoch === draft.storageEpoch) {
      const command = { ...tail.command, payload: mergePayload(draft.kind, tail.command.payload, draft.payload) } as CanvasCommand;
      const bytes = sizeOf(command);
      if (totals.bytes - tail.bytes + bytes > options.limits.bytes) throw new OutboxError("queue_full", "本地待确认修改已达容量上限，请等待同步完成");
      const merged: OutboxRecord = { ...tail, command, bytes };
      outbox.put(merged);
      state.put({ ...totals, bytes: totals.bytes - tail.bytes + bytes });
      return merged;
    }
  }
  const command = {
    schemaVersion: 1, commandId: options.createId(), actorId, actorSeq: seq, canvasId,
    storageEpoch: draft.storageEpoch, baseRevision: draft.baseRevision, kind: draft.kind, payload: draft.payload,
  } as CanvasCommand;
  const bytes = sizeOf(command);
  if (totals.items + 1 > options.limits.items || totals.bytes + bytes > options.limits.bytes) {
    throw new OutboxError("queue_full", `本地待确认修改已达上限（${options.limits.items} 项 / ${options.limits.bytes} 字节），请等待同步完成`);
  }
  const record: OutboxRecord = { canvasId, actorId, actorSeq: seq, command, state: "queued", createdAt: options.now(), bytes, mergeKey };
  outbox.put(record);
  state.put({ key: seqKey, nextSeq: seq + 1 });
  state.put({ ...totals, items: totals.items + 1, bytes: totals.bytes + bytes });
  return record;
}

// ---------------------------------------------------------------- 公开接口

export type OpenOutboxOptions = {
  session?: Pick<Storage, "getItem" | "setItem">;
  limits?: { items: number; bytes: number };
  now?: () => number;
  createId?: () => string;
};

export async function openOutbox(options: OpenOutboxOptions = {}) {
  const db = await openCanvasDatabase();
  const session = options.session ?? globalThis.sessionStorage;
  const limits = options.limits ?? OUTBOX_LIMITS;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  // 会话里的 actorId 必须在本地库有记录；库被清空时换发新 actorId，避免同一 actorId 的序号回到 1。
  const actorId = await inTransaction(db, ["client_state"], "readwrite", async (tx) => {
    const store = tx.objectStore("client_state");
    const remembered = session.getItem(ACTOR_SESSION_KEY);
    if (remembered && await request(store.get(`actor:${remembered}`))) return remembered;
    const fresh = createId();
    store.put({ key: `actor:${fresh}`, createdAt: now() });
    return fresh;
  });
  session.setItem(ACTOR_SESSION_KEY, actorId);
  const enqueueOptions: EnqueueOptions = { merge: true, limits, now, createId };

  const update = (canvasId: string, actorSeq: number, change: (record: OutboxRecord) => OutboxRecord | null) =>
    inTransaction(db, ["outbox"], "readwrite", async (tx) => {
      const store = tx.objectStore("outbox");
      const record = await request(store.get([canvasId, actorId, actorSeq])) as OutboxRecord | undefined;
      if (!record) throw new OutboxError("not_found", `待确认命令 ${canvasId}#${actorSeq} 不存在`);
      const next = change(record);
      if (next) store.put(next);
      return next ?? record;
    });

  return {
    actorId,
    db,
    enqueue: (canvasId: string, draft: CommandDraft) =>
      inTransaction(db, ["outbox", "client_state"], "readwrite", tx => enqueueWithin(tx, actorId, canvasId, draft, enqueueOptions)),
    /** sent 之后载荷与 ID 不再改变；重复标记无副作用。 */
    markSent: (canvasId: string, actorSeq: number) => update(canvasId, actorSeq, record => record.state === "queued" ? { ...record, state: "sent" } : null),
    markConflict: (canvasId: string, actorSeq: number, error?: { code?: string; message?: string }) =>
      update(canvasId, actorSeq, record => ({ ...record, state: "conflict", error: { code: error?.code ?? "field_conflict", message: error?.message ?? "命令与服务端状态冲突" } })),
    /**
     * 丢弃一条已由用户/仲裁处理的冲突记录（P2-06）。只接受 state=conflict：
     * queued/sent 的记录可能已被服务端接收，不能静默丢掉。计数与删除同事务。
     */
    discard: (canvasId: string, actorSeq: number) =>
      inTransaction(db, ["outbox", "client_state"], "readwrite", async (tx) => {
        const outboxStore = tx.objectStore("outbox"), state = tx.objectStore("client_state");
        const record = await request(outboxStore.get([canvasId, actorId, actorSeq])) as OutboxRecord | undefined;
        if (!record) throw new OutboxError("not_found", `待确认命令 ${canvasId}#${actorSeq} 不存在`);
        if (record.state !== "conflict") throw new OutboxError("not_conflict", `只能丢弃已标记 conflict 的命令（当前 ${record.state}）`);
        outboxStore.delete([canvasId, actorId, actorSeq]);
        const totals = (await request(state.get("totals")) as Totals | undefined) ?? { key: "totals", items: 1, bytes: record.bytes };
        state.put({ ...totals, items: Math.max(0, totals.items - 1), bytes: Math.max(0, totals.bytes - record.bytes) });
      }),
    /** 确认、水位与检查点清理同事务：只删除该 commandId，不碰其他序号或画布。 */
    ack: (receipt: CommitReceipt, target: { canvasId: string; actorSeq: number; checkpointThrough?: number }) =>
      inTransaction(db, ["outbox", "client_state", "checkpoints"], "readwrite", async (tx) => {
        const outbox = tx.objectStore("outbox"), state = tx.objectStore("client_state");
        const record = await request(outbox.get([target.canvasId, actorId, target.actorSeq])) as OutboxRecord | undefined;
        if (!record) throw new OutboxError("not_found", "确认的命令不在本地队列中");
        if (record.command.commandId !== receipt.commandId) throw new OutboxError("mismatch", "回执与本地命令不一致");
        outbox.delete([target.canvasId, actorId, target.actorSeq]);
        const totals = (await request(state.get("totals")) as Totals | undefined) ?? { key: "totals", items: 1, bytes: record.bytes };
        state.put({ ...totals, items: Math.max(0, totals.items - 1), bytes: Math.max(0, totals.bytes - record.bytes) });
        const markKey = `ack:${target.canvasId}:${actorId}`;
        const previous = await request(state.get(markKey)) as (Watermark & { key: string }) | undefined;
        state.put({ key: markKey, ackSeq: Math.max(previous?.ackSeq ?? 0, target.actorSeq), revision: receipt.revision, eventSeq: receipt.eventSeq });
        if (target.checkpointThrough !== undefined) {
          if (!Number.isSafeInteger(target.checkpointThrough) || target.checkpointThrough < 0) throw new Error("坐标检查点序号无效");
          tx.objectStore("checkpoints").delete(IDBKeyRange.bound([target.canvasId, actorId, 0], [target.canvasId, actorId, target.checkpointThrough]));
        }
      }),
    loadPending: (canvasId: string) =>
      inTransaction(db, ["outbox"], "readonly", async tx => await request(tx.objectStore("outbox").getAll(canvasRange(canvasId))) as OutboxRecord[]),
    saveCheckpoint: (canvasId: string, checkpoint: { sequence: number; [key: string]: unknown }) =>
      inTransaction(db, ["checkpoints"], "readwrite", async (tx) => {
        if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) throw new Error("坐标检查点序号无效");
        tx.objectStore("checkpoints").put({ ...checkpoint, canvasId, actorId });
      }),
    loadCheckpoints: (canvasId: string) =>
      inTransaction(db, ["checkpoints"], "readonly", async tx => await request(tx.objectStore("checkpoints").getAll(actorRange(canvasId, actorId))) as CheckpointRecord[]),
    watermark: (canvasId: string) =>
      inTransaction(db, ["client_state"], "readonly", async (tx) => {
        const mark = await request(tx.objectStore("client_state").get(`ack:${canvasId}:${actorId}`)) as (Watermark & { key: string }) | undefined;
        return mark ? { ackSeq: mark.ackSeq, revision: mark.revision, eventSeq: mark.eventSeq } : null;
      }),
    /** 恢复转换等需要与其他写入同事务时使用。 */
    enqueueOptions,
  };
}

export type Outbox = Awaited<ReturnType<typeof openOutbox>>;

// ---------------------------------------------------------------- 发送器

export type PostResult =
  | { ok: true; receipt: CommitReceipt; checkpointThrough?: number }
  | { ok: false; status: number; error?: { code?: string; message?: string; retryAfterMs?: number } };
export type SendResult =
  | { status: "idle"; saved: true }
  | { status: "retry"; saved: false; retryAfterMs?: number; error?: unknown }
  | { status: "conflict"; saved: false; record?: OutboxRecord }
  | { status: "recovery_required"; saved: false };

const TRANSIENT = new Set(["lease_conflict", "queue_full", "maintenance", "storage_unavailable"]);

/**
 * 每个画布同时只有一条命令在途。网络结果不明时只重发原 envelope（不换 ID）；
 * 确定性冲突暂停后续发送；stale_epoch 交给恢复协调，不重发到新库。只有 ack 后才算已保存。
 */
export function createCommandSender(options: { outbox: Outbox; canvasId: string; post: (command: CanvasCommand) => Promise<PostResult> }) {
  const { outbox, canvasId, post } = options;
  let running: Promise<SendResult> | null = null;
  async function drain(): Promise<SendResult> {
    for (;;) {
      const pending = (await outbox.loadPending(canvasId)).filter(record => record.actorId === outbox.actorId);
      const head = pending[0];
      if (!head) return { status: "idle", saved: true };
      if (head.state === "conflict") return { status: "conflict", saved: false, record: head };
      if (head.state === "queued") await outbox.markSent(canvasId, head.actorSeq);
      let result: PostResult;
      try { result = await post(head.command); }
      catch (error) { return { status: "retry", saved: false, error }; }
      if (result.ok) {
        await outbox.ack(result.receipt, { canvasId, actorSeq: head.actorSeq, checkpointThrough: result.checkpointThrough });
        continue;
      }
      const code = result.error?.code ?? "";
      if (code === "stale_epoch") return { status: "recovery_required", saved: false };
      if (TRANSIENT.has(code) || [423, 429, 503].includes(result.status) || result.status >= 500) {
        return { status: "retry", saved: false, ...(result.error?.retryAfterMs !== undefined ? { retryAfterMs: result.error.retryAfterMs } : {}) };
      }
      await outbox.markConflict(canvasId, head.actorSeq, result.error);
      return { status: "conflict", saved: false };
    }
  }
  return {
    flush(): Promise<SendResult> {
      if (!running) running = drain().finally(() => { running = null; });
      return running;
    },
  };
}
