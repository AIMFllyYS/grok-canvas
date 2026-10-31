/**
 * SQLite 权威模式的命令仓库（P3-08，contracts.md C2/C4）：reducer 仍在 Next 进程内同步执行，数据库只经 DB Worker 访问。
 * 1. 按命令提示（触及的节点/连线/commandId/actor）向 Worker 取读集；reducer 读到缓存外的实体时抛 NeedRead，补读后整条重跑；
 * 2. reducer 产生的写集或拒绝交给 Worker 的 commands.commit：事务内复核 revision/actorSeq/commandId 与读集一致才提交；
 *    不一致（其他写入抢先）返回 retry，丢弃本次结果重新读取并重跑——reducer 是纯函数，重跑安全。
 * 服务端私有模块。
 */
import type { CommandRepository, CommandTxn } from "../canvas-runtime/json-repository";
import type { EntityReader, WriteSet } from "../canvas-runtime/command-reducer";
import type { StoredCommandResult } from "../canvas-runtime/command-state";
import type { CommitReceipt, DocumentRecord, EdgeRecord, NodeSummary } from "../canvas-runtime/types";
import { getDbService, type DbService } from "./service";
import { readStorageState, sqliteDbPath, StorageRecoveryError } from "./storage-mode";

export type ReadRequest = { nodeIds?: string[]; edgeIds?: string[]; documentIds?: string[]; claimNodeIds?: string[]; commandIds?: string[]; actorIds?: string[]; documents?: boolean };
export type CommandHint = ReadRequest;

type CanvasMeta = { name: string; revision: number; nameVersion: number; storageEpoch: string; eventSeq: number };
type ReadSet = {
  canvas: CanvasMeta | null;
  nodes: Record<string, { node: NodeSummary; deleted: boolean } | null>;
  fields: Record<string, Record<string, number>>;
  incoming: Record<string, string[]>;
  outgoing: Record<string, string[]>;
  documents: Record<string, DocumentRecord | null>;
  edges: Record<string, { edge: EdgeRecord; deleted: boolean } | null>;
  claims: Record<string, { id: string; state: string } | null>;
  results: Record<string, StoredCommandResult | null>;
  actors: Record<string, number>;
};

class NeedRead extends Error {
  constructor(readonly request: ReadRequest) { super("need read"); }
}

const MAX_MISSES = 256;
const MAX_RETRIES = 8;

/** 当前 SQLite 权威库的 DB 服务；首次使用时执行迁移（只追加，校验和保护）。 */
const migrated = new WeakSet<DbService>();
export async function sqliteService(): Promise<DbService> {
  const state = readStorageState();
  if (state.backend !== "sqlite") throw new StorageRecoveryError("当前不是 SQLite 权威模式");
  const service = getDbService({ file: sqliteDbPath(state) });
  if (!migrated.has(service)) {
    await service.request("migrate");
    migrated.add(service);
  }
  return service;
}

export async function sqlQuery<T>(repository: string, params: unknown): Promise<T> {
  return (await sqliteService()).request<T>("query", { repository, params });
}
export async function sqlCommand<T>(repository: string, params: unknown): Promise<T> {
  return (await sqliteService()).request<T>("command", { repository, params });
}

function emptyReadSet(): ReadSet {
  return { canvas: null, nodes: {}, fields: {}, incoming: {}, outgoing: {}, documents: {}, edges: {}, claims: {}, results: {}, actors: {} };
}
function merge(into: ReadSet, from: ReadSet) {
  into.canvas = from.canvas;
  for (const key of ["nodes", "fields", "incoming", "outgoing", "documents", "edges", "claims", "results", "actors"] as const) Object.assign(into[key], from[key]);
}
const has = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** 读集里已知的全部键，用于 retry 时整体刷新。 */
function knownKeys(cache: ReadSet): ReadRequest {
  return {
    nodeIds: Object.keys(cache.nodes), edgeIds: Object.keys(cache.edges), documentIds: Object.keys(cache.documents),
    claimNodeIds: Object.keys(cache.claims), commandIds: Object.keys(cache.results), actorIds: Object.keys(cache.actors),
  };
}

function cachedTxn(canvasId: string, cache: ReadSet, record: (pending: Pending) => void): CommandTxn {
  const need = (request: ReadRequest): never => { throw new NeedRead(request); };
  const nodeEntry = (id: string) => (has(cache.nodes, id) ? cache.nodes[id] : need({ nodeIds: [id] }));
  const edgeEntry = (id: string) => (has(cache.edges, id) ? cache.edges[id] : need({ edgeIds: [id] }));
  const canvas = cache.canvas!;
  const reader: EntityReader = {
    canvasId,
    canvasName: () => canvas.name,
    nameVersion: () => canvas.nameVersion,
    getNode(id) { const entry = nodeEntry(id); return entry && !entry.deleted ? entry.node : undefined; },
    getDocument(id) { return has(cache.documents, id) ? cache.documents[id] ?? undefined : need({ documentIds: [id] }); },
    getEdge(id) { const entry = edgeEntry(id); return entry && !entry.deleted ? entry.edge : undefined; },
    incomingEdgeIds(nodeId) { return has(cache.incoming, nodeId) ? cache.incoming[nodeId]! : need({ nodeIds: [nodeId] }); },
    outgoingEdgeIds(nodeId) { return has(cache.outgoing, nodeId) ? cache.outgoing[nodeId]! : need({ nodeIds: [nodeId] }); },
    fieldVersion(nodeId, field) { return has(cache.fields, nodeId) ? cache.fields[nodeId]![field] ?? 0 : need({ nodeIds: [nodeId] }); },
    isNodeTombstoned(id) { return !!nodeEntry(id)?.deleted; },
    isEdgeTombstoned(id) { return !!edgeEntry(id)?.deleted; },
    generationClaim(nodeId) { return has(cache.claims, nodeId) ? cache.claims[nodeId] ?? undefined : need({ claimNodeIds: [nodeId] }); },
  };
  return {
    reader,
    revision: canvas.revision,
    eventSeq: canvas.eventSeq,
    storageEpoch: canvas.storageEpoch,
    acceptedSeq: actorId => (has(cache.actors, actorId) ? cache.actors[actorId]! : need({ actorIds: [actorId] })),
    storedResult: commandId => (has(cache.results, commandId) ? cache.results[commandId] ?? undefined : need({ commandIds: [commandId] })),
    commit(writes, meta) {
      // 回执由 Worker 提交时生成；先返回同一对象，提交成功后原地填充，调用方拿到的就是落盘回执。
      const receipt = {} as CommitReceipt;
      record({ kind: "commit", writes, meta, receipt });
      return receipt;
    },
    reject(meta, error) { record({ kind: "reject", meta, error }); },
  };
}

type Pending =
  | { kind: "commit"; writes: WriteSet; meta: Parameters<CommandTxn["commit"]>[1]; receipt: CommitReceipt }
  | { kind: "reject"; meta: Parameters<CommandTxn["reject"]>[0]; error: Parameters<CommandTxn["reject"]>[1] };

function serializeWrites(w: WriteSet) {
  return {
    nodes: [...w.nodes], documents: [...w.documents], edges: [...w.edges],
    removedNodes: [...w.removedNodes], removedDocuments: [...w.removedDocuments], removedEdges: [...w.removedEdges],
    nodeFieldVersions: [...w.nodeFieldVersions].map(([id, fields]) => [id, [...fields]]),
    fieldVersions: [...w.fieldVersions], assets: [...w.assets],
    ...(w.name !== undefined ? { name: w.name, nameVersion: w.nameVersion } : {}),
  };
}

export type SqlRepositoryStats = { readSets: number; commits: number; retries: number; misses: number };
export const sqlRepositoryStats: SqlRepositoryStats = { readSets: 0, commits: 0, retries: 0, misses: 0 };

export const sqlCommandRepository: CommandRepository & { transact<T>(canvasId: string, edit: (txn: CommandTxn) => T, hint?: CommandHint): Promise<T | null> } = {
  async transact<T>(canvasId: string, edit: (txn: CommandTxn) => T, hint: CommandHint = {}): Promise<T | null> {
    const cache = emptyReadSet();
    const fetch = async (request: ReadRequest) => { sqlRepositoryStats.readSets++; merge(cache, await sqlQuery<ReadSet>("commands.readSet", { canvasId, ...request })); };
    await fetch(hint);
    let misses = 0;
    for (let attempt = 0; attempt < MAX_RETRIES;) {
      if (!cache.canvas) return null;
      let pending: Pending | null = null;
      let result: T;
      try {
        result = edit(cachedTxn(canvasId, cache, p => { pending = p; }));
      } catch (error) {
        if (!(error instanceof NeedRead)) throw error;
        if (++misses > MAX_MISSES) throw new Error(`命令读取的实体过多（最后一次：${JSON.stringify(error.request)}）`);
        sqlRepositoryStats.misses++;
        await fetch(error.request);
        continue;
      }
      const recorded = pending as Pending | null;
      if (!recorded) return result;
      const base = { revision: cache.canvas.revision, actorId: recorded.meta.actorId, acceptedSeq: cache.actors[recorded.meta.actorId] ?? 0 };
      sqlRepositoryStats.commits++;
      const response = await sqlCommand<{ missing?: boolean; retry?: boolean; rejected?: boolean; receipt?: CommitReceipt }>("commands.commit", {
        canvasId, base, meta: recorded.meta,
        ...(recorded.kind === "commit" ? { writes: serializeWrites(recorded.writes) } : { error: recorded.error }),
      });
      if (response.missing) return null;
      if (response.retry) {
        attempt++;
        sqlRepositoryStats.retries++;
        await fetch({ ...knownKeys(cache), commandIds: [...new Set([...(knownKeys(cache).commandIds ?? []), recorded.meta.commandId])] });
        continue;
      }
      if (recorded.kind === "commit" && response.receipt) Object.assign(recorded.receipt, response.receipt);
      return result;
    }
    throw Object.assign(new Error("画布写入竞争过多，请稍后重试"), { code: "SQLITE_BUSY" });
  },
};
