/**
 * 几何命令通道（P2-06，contracts.md C2/C3）：手势结束 → move_nodes 入 outbox → 串行发送 → 回执。
 * - 回执更新确认几何缓存并按 P2-04 记录一条历史（每个 commandId 只记一次）。
 * - 冲突：重新读取服务端实体快照。几何未变、仅版本号前进的，静默改基重发；
 *   几何确实被他人改过的，交给用户选择“保留我的位置 / 采用对方位置”，决定前不回弹、不静默选边。
 * - 恢复：先登记 outbox 中未确认的移动作为预测（远端合并不回弹），再把本地检查点/草稿坐标转成命令。
 * 不依赖 React；FlowCanvas 通过回调应用远端几何与提示冲突。
 */
import { createCommandSender, type Outbox, type OutboxRecord, type PostResult, type SendResult } from "./outbox";
import { createUndoCommand, recordCommitted, type HistoryEntry } from "./history";
import { sameGeometry, type ConfirmedGeometry, type ConfirmedSnapshot, type MoveItem } from "./scene-adapter";
import type { CanvasCommand, FieldRef, Geometry } from "./types";

type Point = { x: number; y: number };
export type GeometryConflict = {
  nodeIds: string[];
  /** 本地想要的落点。 */
  local: Map<string, Geometry>;
  /** 服务端当前几何。 */
  remote: Map<string, Geometry>;
  keepMine(): Promise<void>;
  takeTheirs(): Promise<void>;
};
export type ReconcileCandidate = { id: string; from: Point & Partial<Pick<Geometry, "width" | "height">>; to: Point & Partial<Pick<Geometry, "width" | "height">> };
export type ChannelStatus = { pending: number; state: "idle" | "sending" | "retry" | "conflict" | "error"; message?: string };

export type GeometryChannelOptions = {
  canvasId: string;
  outbox: Pick<Outbox, "actorId" | "enqueue" | "loadPending" | "markSent" | "markConflict" | "ack" | "discard">;
  confirmed: ConfirmedGeometry;
  post: (command: CanvasCommand) => Promise<PostResult>;
  fetchSnapshot: () => Promise<ConfirmedSnapshot>;
  onHistory?: (commandId: string, entry: HistoryEntry) => void;
  onConflict?: (conflict: GeometryConflict) => void;
  /** 用户选择采用对方位置时，把远端几何应用到正式工作文档。 */
  onRemote?: (geometries: Map<string, Geometry>) => void;
  onStatus?: (status: ChannelStatus) => void;
  /** 非几何命令被服务端拒绝且无法安全改基时（P2-07）。 */
  onRejected?: (rejection: { kind: string; message: string; ids: string[] }) => void;
  /** 本地 outbox 确认某序号后（P3-10 上报服务端水位）。 */
  onAcked?: (actorSeq: number) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
};

/** 冲突时以用户输入为准改基重发的字段：用户正在编辑的文本（持有租约）。 */
const REBASE_FIELDS = new Set(["content", "prompt", "draftPrompt", "name"]);

const copy = (g: Geometry): Geometry => ({ x: g.x, y: g.y, width: g.width, height: g.height });
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const isMove = (record: OutboxRecord) => record.command.kind === "move_nodes";
const moveItems = (record: OutboxRecord) => (record.command.payload as { items: MoveItem[] }).items;
const RETRY_MAX_MS = 30_000;

export function createGeometryChannel(options: GeometryChannelOptions) {
  const { canvasId, outbox, confirmed } = options;
  const schedule = options.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); });
  const recorded = new Set<string>();
  let disposed = false;
  let cancelRetry: (() => void) | null = null;
  let retryDelay = 1000;
  let blocked = false;
  const status = (state: ChannelStatus["state"], message?: string) => options.onStatus?.({ pending: confirmed.pendingGeometry().size, state, ...(message ? { message } : {}) });

  const sender = createCommandSender({
    outbox: outbox as Outbox,
    canvasId,
    ...(options.onAcked ? { onAcked: options.onAcked } : {}),
    post: async (command) => {
      const before = confirmed.reader();
      const result = await options.post(command);
      if (result.ok && !recorded.has(command.commandId)) {
        recorded.add(command.commandId);
        const entry = recordCommitted(command, before, result.receipt);
        confirmed.applyReceipt(result.receipt);
        if (entry) options.onHistory?.(command.commandId, entry);
      }
      return result;
    },
  });

  const ownPending = async () => (await outbox.loadPending(canvasId)).filter(record => record.actorId === outbox.actorId);
  const predictFrom = (record: OutboxRecord) => confirmed.predictCommand(record.command.kind, record.command.payload);

  /** 任意用户命令（P2-07）：入队后按落库记录预测版本。 */
  async function submitCommand(body: { kind: CanvasCommand["kind"]; payload: unknown }): Promise<{ commandId: string; actorSeq: number }> {
    const record = await outbox.enqueue(canvasId, { kind: body.kind, payload: body.payload, storageEpoch: confirmed.storageEpoch(), baseRevision: confirmed.revision() });
    predictFrom(record);
    status("sending");
    return { commandId: record.command.commandId, actorSeq: record.actorSeq };
  }

  /** 非几何冲突：正在编辑的文本字段以用户输入为准改基重发；其余（新增/删除/连线）丢弃并提示，由远端合并恢复真实状态。 */
  async function handleOtherConflict(head: OutboxRecord): Promise<boolean> {
    confirmed.load(await options.fetchSnapshot());
    const items = head.command.kind === "batch"
      ? (head.command.payload as { commands: Array<{ kind: string; payload: unknown }> }).commands
      : [{ kind: head.command.kind, payload: head.command.payload }];
    const patchesOnly = items.every(item => item.kind === "patch_nodes");
    await outbox.discard(canvasId, head.actorSeq);
    confirmed.clearPredictions();
    for (const record of await ownPending()) predictFrom(record);
    if (patchesOnly) {
      const rebuilt: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
      const dropped: string[] = [];
      for (const item of items) for (const patch of (item.payload as { items: Array<{ nodeId: string; field: string; value: unknown }> }).items) {
        if (!confirmed.known(patch.nodeId)) { dropped.push(patch.nodeId); continue; }
        if (!REBASE_FIELDS.has(patch.field)) { dropped.push(`${patch.nodeId}/${patch.field}`); continue; }
        const documentId = patch.field === "content" ? confirmed.documentIdOf(patch.nodeId) : null;
        rebuilt.push({ ...patch, expectedVersion: documentId ? confirmed.documentVersion(documentId) : confirmed.fieldVersion(patch.nodeId, patch.field) });
      }
      if (rebuilt.length) await submitCommand({ kind: "patch_nodes", payload: { items: rebuilt } });
      if (dropped.length) options.onRejected?.({ kind: "patch_nodes", message: head.error?.message ?? "字段已被其他修改改变", ids: dropped });
      return true;
    }
    options.onRejected?.({ kind: head.command.kind, message: head.error?.message ?? "命令与服务端状态冲突", ids: [] });
    return true;
  }

  async function submit(items: readonly MoveItem[]): Promise<{ commandId: string; actorSeq: number } | null> {
    if (!items.length) return null;
    const record = await outbox.enqueue(canvasId, {
      kind: "move_nodes",
      payload: { items: items.map(item => ({ ...item, from: copy(item.from), to: copy(item.to) })) },
      storageEpoch: confirmed.storageEpoch(),
      baseRevision: confirmed.revision(),
    });
    // 以落库后的记录为准：与队尾合并时保留最早的前置版本，预测随之对齐。
    predictFrom(record);
    status("sending");
    return { commandId: record.command.commandId, actorSeq: record.actorSeq };
  }

  /** 丢弃冲突记录以及其后同节点、尚未发送的移动，合并成一组意图。 */
  async function collapse(head: OutboxRecord) {
    const intents = new Map<string, Geometry>();
    for (const item of moveItems(head)) intents.set(item.nodeId, copy(item.to));
    const ids = new Set(intents.keys());
    const followers = (await ownPending()).filter(record => record.actorSeq > head.actorSeq && record.state === "queued" && isMove(record) && moveItems(record).some(item => ids.has(item.nodeId)));
    for (const record of followers) for (const item of moveItems(record)) intents.set(item.nodeId, copy(item.to));
    const drop = async () => {
      await outbox.discard(canvasId, head.actorSeq);
      for (const record of followers) {
        await outbox.markConflict(canvasId, record.actorSeq, { code: "superseded", message: "并入冲突仲裁" });
        await outbox.discard(canvasId, record.actorSeq);
      }
      confirmed.unpredict(intents.keys());
    };
    return { intents, drop };
  }

  const rebuild = (intents: Map<string, Geometry>, ids: Iterable<string>): MoveItem[] => {
    const items: MoveItem[] = [];
    for (const id of ids) {
      const node = confirmed.get(id);
      const to = intents.get(id);
      if (!node || !to || sameGeometry(node.geometry, to)) continue;
      items.push({ nodeId: id, expectedVersion: node.geometryVersion, from: copy(node.geometry), to: copy(to) });
    }
    return items;
  };

  function raiseConflict(nodeIds: string[], local: Map<string, Geometry>, onKeep: () => Promise<void>, onTake: () => Promise<void>) {
    const remote = new Map<string, Geometry>();
    for (const id of nodeIds) { const node = confirmed.get(id); if (node) remote.set(id, copy(node.geometry)); }
    let settled = false;
    const once = (fn: () => Promise<void>) => async () => {
      if (settled) return;
      settled = true;
      blocked = false;
      await fn();
      void flush();
    };
    options.onConflict?.({ nodeIds, local, remote, keepMine: once(onKeep), takeTheirs: once(onTake) });
  }

  /** 返回 true 表示已静默解决，可继续发送。 */
  async function handleConflict(head: OutboxRecord): Promise<boolean> {
    if (!isMove(head)) return handleOtherConflict(head);
    confirmed.load(await options.fetchSnapshot());
    const { intents, drop } = await collapse(head);
    const firstFrom = new Map(moveItems(head).map(item => [item.nodeId, item.from]));
    const real: string[] = [];
    for (const [id, to] of intents) {
      const node = confirmed.get(id);
      if (!node || sameGeometry(node.geometry, to)) continue;
      const from = firstFrom.get(id);
      // 只有版本号前进、几何仍是我们的起点：没有人真正移动它。
      if (from && sameGeometry(node.geometry, from)) continue;
      if (!from) continue;
      real.push(id);
    }
    if (!real.length) {
      await drop();
      await submit(rebuild(intents, intents.keys()));
      return true;
    }
    blocked = true;
    status("conflict", `${real.length} 个节点的位置已被其他修改改变`);
    const local = new Map(real.map(id => [id, copy(intents.get(id)!)]));
    raiseConflict(real, local,
      async () => { await drop(); await submit(rebuild(intents, intents.keys())); },
      async () => {
        await drop();
        const remote = new Map<string, Geometry>();
        for (const id of real) { const node = confirmed.get(id); if (node) remote.set(id, copy(node.geometry)); }
        options.onRemote?.(remote);
        await submit(rebuild(intents, [...intents.keys()].filter(id => !real.includes(id))));
      });
    return false;
  }

  async function flush(): Promise<SendResult> {
    if (disposed) return { status: "retry", saved: false };
    if (blocked) return { status: "conflict", saved: false };
    cancelRetry?.(); cancelRetry = null;
    for (;;) {
      const result = await sender.flush();
      if (result.status === "idle") { retryDelay = 1000; status("idle"); return result; }
      if (result.status === "conflict") {
        const head = result.record ?? (await ownPending())[0];
        if (head && await handleConflict(head)) continue;
        return result;
      }
      if (result.status === "retry") {
        const wait = result.retryAfterMs ?? retryDelay;
        retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
        status("retry", "网络异常，稍后重试同步位置");
        if (!disposed) cancelRetry = schedule(() => { cancelRetry = null; void flush(); }, Math.max(250, wait));
        return result;
      }
      status("error", "存储纪元已变化，需要恢复协调后再同步位置");
      return result;
    }
  }

  return {
    submit,
    flush,
    /** 恢复屏障：读出未确认移动作为预测，之后才开放编辑。返回待发送条数。 */
    async start(): Promise<number> {
      const pending = await ownPending();
      for (const record of pending) predictFrom(record);
      return pending.length;
    },
    /** 把本地检查点/草稿里的坐标转成移动命令；起点与服务端不符的交给用户仲裁。 */
    async reconcile(candidates: readonly ReconcileCandidate[], snapshot: ConfirmedSnapshot) {
      confirmed.load(snapshot);
      const submitted: string[] = [], conflicts: string[] = [], skipped: string[] = [];
      const items: MoveItem[] = [];
      const local = new Map<string, Geometry>();
      for (const candidate of candidates) {
        const base = confirmed.base(candidate.id);
        if (!base) { skipped.push(candidate.id); continue; }
        const to = { x: candidate.to.x, y: candidate.to.y, width: candidate.to.width ?? base.geometry.width, height: candidate.to.height ?? base.geometry.height };
        if (sameGeometry(base.geometry, to)) { skipped.push(candidate.id); continue; }
        const fromMatches = samePoint(base.geometry, candidate.from)
          && (candidate.from.width === undefined || candidate.from.width === base.geometry.width)
          && (candidate.from.height === undefined || candidate.from.height === base.geometry.height);
        if (fromMatches) {
          items.push({ nodeId: candidate.id, expectedVersion: base.geometryVersion, from: copy(base.geometry), to });
          submitted.push(candidate.id);
        } else {
          conflicts.push(candidate.id);
          local.set(candidate.id, to);
        }
      }
      await submit(items);
      if (conflicts.length) {
        raiseConflict(conflicts, local,
          async () => { await submit(rebuild(local, conflicts)); },
          async () => {
            const remote = new Map<string, Geometry>();
            for (const id of conflicts) { const node = confirmed.get(id); if (node) remote.set(id, copy(node.geometry)); }
            options.onRemote?.(remote);
          });
      }
      return { submitted, conflicts, skipped };
    },
    /** 撤销是一条新的条件命令；任一节点所有权已改变则整条拒绝，不半撤销。 */
    async undo(entry: HistoryEntry): Promise<{ ok: true; commandId: string; geometries: Map<string, Geometry> } | { ok: false; conflicts: FieldRef[] }> {
      const result = createUndoCommand(entry, confirmed.reader(true), {
        commandId: "pending", actorId: outbox.actorId, actorSeq: 0, storageEpoch: confirmed.storageEpoch(), baseRevision: confirmed.revision(),
        createId: () => crypto.randomUUID(),
      });
      if (!result.ok) return result;
      if (result.command.kind !== "move_nodes") return { ok: false, conflicts: [] };
      const items = result.command.payload.items;
      const submitted = await submit(items);
      if (!submitted) return { ok: false, conflicts: [] };
      return { ok: true, commandId: submitted.commandId, geometries: new Map(items.map(item => [item.nodeId, copy(item.to)])) };
    },
    pendingGeometry: () => confirmed.pendingGeometry(),
    isPending: (id: string) => confirmed.pending(id),
    submitCommand,
    /** outbox 中是否还有本画布未确认的命令。 */
    async hasPending() { return (await ownPending()).length > 0; },
    blocked: () => blocked,
    dispose() { disposed = true; cancelRetry?.(); cancelRetry = null; },
  };
}

export type GeometryChannel = ReturnType<typeof createGeometryChannel>;
