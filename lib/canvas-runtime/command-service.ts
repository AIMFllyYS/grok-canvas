/**
 * 服务端领域命令入口（contracts.md C2）：executeCommand(command, context) → CommitReceipt。
 * 解析 → 来源权限 → hash 幂等 → storageEpoch → actorSeq → reducer → 仓库同事务提交。
 * 只在服务端使用（node:crypto、文件系统）；浏览器只导入 command-schema。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { assetPath, isSafeAssetName } from "../assets";
import { assertClientCommand, canonicalCommand, CommandValidationError, LIMITS, parseCommand } from "./command-schema";
import { reduceCommand, ReducerError } from "./command-reducer";
import { jsonCommandRepository, loadEntitySnapshot, type CommandRepository, type CommandTxn } from "./json-repository";
import { getLeaseService, isLeaseField, LEASE_FIELDS, type LeaseRef, type LeaseService } from "./lease-service";
import { COMMAND_ERROR_STATUS, type BatchItem, type CanvasCommand, type CommandErrorBody, type CommandErrorCode, type CommandErrorField, type CommitReceipt } from "./types";

export { JSON_STORAGE_EPOCH } from "./command-state";
export const COMMAND_BODY_LIMIT = LIMITS.requestBytes;

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly status: number;
  readonly fields?: CommandErrorField[];
  readonly retryAfterMs?: number;
  constructor(code: CommandErrorCode, message: string, options: { status?: number; fields?: CommandErrorField[]; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.status = options.status ?? COMMAND_ERROR_STATUS[code];
    if (options.fields?.length) this.fields = options.fields;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
  toBody(): CommandErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}), ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}) } };
  }
}

/** 把已知错误统一为 CommandError；未知错误返回 null，由调用方按 500 处理。 */
export function toCommandError(error: unknown): CommandError | null {
  if (error instanceof CommandError) return error;
  if (error instanceof CommandValidationError) return new CommandError("invalid_command", error.message, { status: error.status, fields: error.fields });
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return new CommandError("storage_unavailable", "画布存储暂不可用，请稍后重试");
  // SQLite 忙/锁：事务已整体回滚，可原样重试保存；服务端不会因此重新发起收费生成。
  if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code)) return new CommandError("storage_unavailable", "画布数据库正忙，请稍后重试", { retryAfterMs: 250 });
  return null;
}

/** C6 增量查询结果：整条事务事件为单位，不拆半个 Delta。 */
export type ChangesPage = {
  events: Array<{ eventSeq: number; revision: number; commandId: string | null; delta: unknown; oversized?: boolean }>;
  fromRevision: number;
  toRevision: number;
  hasMore: boolean;
  storageEpoch: string;
};

/** 显式选择的命令存储（仓库 + 增量查询）。未选择时使用 JSON 仓库。 */
export type CommandStore = {
  repository: CommandRepository;
  listChanges(params: { canvasId: string; afterRevision: number; limit?: number; storageEpoch?: string }): Promise<ChangesPage>;
};

let selectedStore: CommandStore | null = null;
/** 只在测试/明确的特性开关下调用；传 null 恢复 JSON。不会自动切换用户主库。 */
export function selectCommandStore(store: CommandStore | null) { selectedStore = store; }
export const selectedCommandStore = () => selectedStore;
const repositoryFor = (context: CommandContext) => context.repository ?? selectedStore?.repository ?? jsonCommandRepository;

export class ChangesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = "ChangesError"; this.code = code; this.status = status; }
}

/**
 * GET changes 的服务端实现。JSON 仓库不保存事件日志：只有 afterRevision 等于当前修订时返回空页，
 * 否则 410 snapshot_required（客户端改走实体快照）。
 */
export async function listCanvasChanges(params: { canvasId: string; afterRevision: number; limit?: number; storageEpoch?: string }): Promise<ChangesPage> {
  const store = selectedStore;
  try {
    if (store) return await store.listChanges(params);
    const snapshot = await loadEntitySnapshot(params.canvasId);
    if (!snapshot) throw new ChangesError("not_found", "画布不存在或已删除", 404);
    if (params.storageEpoch !== undefined && params.storageEpoch !== snapshot.storageEpoch) throw new ChangesError("stale_epoch", `存储纪元已变为 ${snapshot.storageEpoch}`, 409);
    if (params.afterRevision > snapshot.revision) throw new ChangesError("invalid_request", `afterRevision 超过当前修订 ${snapshot.revision}`, 400);
    if (params.afterRevision < snapshot.revision) throw new ChangesError("snapshot_required", "JSON 存储没有事件日志，需要重新获取快照", 410);
    return { events: [], fromRevision: snapshot.revision, toRevision: snapshot.revision, hasMore: false, storageEpoch: snapshot.storageEpoch };
  } catch (error) {
    if (error instanceof ChangesError) throw error;
    const known = error as { code?: unknown; status?: unknown; message?: string };
    if (typeof known?.code === "string" && typeof known.status === "number") throw new ChangesError(known.code, known.message ?? known.code, known.status);
    const command = toCommandError(error);
    if (command) throw new ChangesError(command.code, command.message, command.status);
    throw error;
  }
}

export type CommandOrigin = "client" | "agent" | "server" | "migration";
export type CommandContext = {
  /** 由服务器注入，不接受 payload 中的管理员标记。 */
  origin: CommandOrigin;
  assetExists?: (assetName: string) => boolean;
  repository?: CommandRepository;
  /** 测试可注入带假时钟的租约服务；默认进程单例。 */
  leases?: LeaseService;
};

/** 命令会写到的受租约保护字段：move→geometry；patch content/prompt；删除节点→三者全部。 */
export function touchedLeaseRefs(command: CanvasCommand): LeaseRef[] {
  const refs = new Map<string, LeaseRef>();
  const add = (nodeId: string, field: LeaseRef["field"]) => refs.set(`${nodeId}/${field}`, { nodeId, field });
  const items: BatchItem[] = command.kind === "batch" ? command.payload.commands : [{ kind: command.kind, payload: command.payload } as BatchItem];
  for (const item of items) {
    if (item.kind === "move_nodes") for (const move of item.payload.items) add(move.nodeId, "geometry");
    else if (item.kind === "patch_nodes") for (const patch of item.payload.items) { if (isLeaseField(patch.field)) add(patch.nodeId, patch.field); }
    else if (item.kind === "delete_nodes") for (const removal of item.payload.items) for (const field of LEASE_FIELDS) add(removal.nodeId, field);
    else if (item.kind === "apply_generation") for (const field of Object.keys(item.payload.patch)) { if (isLeaseField(field)) add(item.payload.nodeId, field); }
  }
  return [...refs.values()];
}

const defaultAssetExists = (name: string) => isSafeAssetName(name) && existsSync(assetPath(name));
export const commandHash = (command: Parameters<typeof canonicalCommand>[0]) => createHash("sha256").update(canonicalCommand(command)).digest("hex");

type Outcome = { receipt: CommitReceipt } | { error: CommandError };

/** 锁内执行一条已解析命令：重放、纪元、序号、租约、归约、提交/拒绝记录。 */
function runInTransaction(txn: CommandTxn, command: CanvasCommand, hash: string, context: CommandContext): Outcome {
  const meta = { commandId: command.commandId, actorId: command.actorId, actorSeq: command.actorSeq, hash };
  const leases = context.leases ?? getLeaseService();
  const stored = txn.storedResult(command.commandId);
  if (stored) {
    if (stored.hash !== hash) return { error: new CommandError("command_id_reused", "该 commandId 已用于不同内容的命令") };
    if (stored.error) return { error: new CommandError(stored.error.code, stored.error.message, { fields: stored.error.fields }) };
    return { receipt: { ...structuredClone(stored.receipt!), replayed: true } };
  }
  if (command.storageEpoch !== txn.storageEpoch) return { error: new CommandError("stale_epoch", `存储纪元已变为 ${txn.storageEpoch}，请重新同步`) };
  const accepted = txn.acceptedSeq(command.actorId);
  if (command.actorSeq !== accepted + 1) {
    return { error: new CommandError("actor_sequence_gap", command.actorSeq <= accepted ? `序号 ${command.actorSeq} 已被使用（已接受到 ${accepted}）` : `序号缺口：期望 ${accepted + 1}，收到 ${command.actorSeq}`) };
  }
  // 租约在同一画布锁内核验：他人持有的字段返回 423，属于暂时性冲突，不占用序号。
  const held = leases.conflicts(command.canvasId, touchedLeaseRefs(command), command.actorId);
  if (held.length) {
    return { error: new CommandError("lease_conflict", `${held.length} 个字段正被其他人编辑`, {
      fields: held.map(lease => ({ path: `node/${lease.nodeId}/${lease.field}`, message: `正被其他人编辑，约 ${Math.max(0, lease.expiresAt - Date.now())}ms 后过期` })),
      retryAfterMs: Math.max(0, Math.min(...held.map(lease => lease.expiresAt)) - Date.now()),
    }) };
  }
  try {
    const writes = reduceCommand(txn.reader, command, { assetExists: context.assetExists ?? defaultAssetExists });
    return { receipt: txn.commit(writes, meta) };
  } catch (error) {
    if (!(error instanceof ReducerError)) throw error;
    txn.reject(meta, { code: error.code, message: error.message, ...(error.fields.length ? { fields: error.fields } : {}) });
    return { error: new CommandError(error.code, error.message, { fields: error.fields }) };
  }
}

export async function executeCommand(input: unknown, context: CommandContext): Promise<CommitReceipt> {
  let outcome: Outcome | null;
  try {
    const command = parseCommand(input);
    if (context.origin === "client") assertClientCommand(command);
    const hash = commandHash(command);
    const repository = repositoryFor(context);
    outcome = await repository.transact<Outcome>(command.canvasId, (txn) => runInTransaction(txn, command, hash, context));
  } catch (error) {
    throw toCommandError(error) ?? error;
  }
  if (!outcome) throw new CommandError("canvas_deleted", "画布不存在或已删除");
  if ("error" in outcome) throw outcome.error;
  return outcome.receipt;
}

export type ServerCommandBody = { kind: CanvasCommand["kind"]; payload: unknown };

/**
 * 服务端写入（Agent、生成回写，P2-08）：在画布锁内读取当前实体与版本来构造命令，
 * 由服务端分配该 actor 的下一个序号，与用户命令走同一套校验、租约与回执。
 * build 返回 null 表示无需写入；画布不存在返回 null。
 */
export async function executeServerCommand(
  canvasId: string,
  actorId: string,
  build: (reader: CommandTxn["reader"], txn: { revision: number }) => ServerCommandBody | null,
  context: CommandContext,
): Promise<CommitReceipt | null> {
  if (context.origin === "client") throw new CommandError("invalid_command", "客户端不能使用服务端命令入口");
  let outcome: Outcome | "skipped" | null;
  try {
    const repository = repositoryFor(context);
    outcome = await repository.transact<Outcome | "skipped">(canvasId, (txn) => {
      const body = build(txn.reader, { revision: txn.revision });
      if (!body) return "skipped";
      const command = parseCommand({
        schemaVersion: 1, commandId: randomUUID(), actorId, actorSeq: txn.acceptedSeq(actorId) + 1,
        canvasId, storageEpoch: txn.storageEpoch, baseRevision: txn.revision, kind: body.kind, payload: body.payload,
      });
      return runInTransaction(txn, command, commandHash(command), context);
    });
  } catch (error) {
    throw toCommandError(error) ?? error;
  }
  if (outcome === null) return null;
  if (outcome === "skipped") return null;
  if ("error" in outcome) throw outcome.error;
  return outcome.receipt;
}

/** 流式读取请求体并计数，超过上限立即取消并返回 413；不信任 Content-Length。 */
export async function readLimitedBody(request: Request, limit: number = COMMAND_BODY_LIMIT): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new CommandError("invalid_command", `请求体超过 ${limit} 字节上限`, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
