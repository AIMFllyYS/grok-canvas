/**
 * JSON 兼容阶段保存在 CanvasDoc.commandState 中的命令元数据（contracts.md C2/C5 的过渡形态）：
 * 字段版本、墓碑、actor 水位、回执与 eventSeq。P3 切到 SQLite 后由对应表替代。
 * 旧写入路径（整份 PUT、旧 operations、Agent mutateCanvas）落盘时调用 bumpVersionsForLegacyWrite，
 * 让命令不会拿着旧版本覆盖旧路径刚写入的值。本模块只依赖纯逻辑，不引入 zod。
 */
import { diffCanvasOperations } from "../canvas-operations";
import type { CanvasDoc } from "../canvas-store";
import type { AssetRegistration, CommandErrorCode, CommandErrorField, CommitReceipt } from "./types";

export const JSON_STORAGE_EPOCH = "json-v1";

export type NodeVersions = { entity: number; geometry: number; fields?: Record<string, number> };
export type StoredCommandResult = {
  hash: string;
  actorId: string;
  actorSeq: number;
  receipt?: CommitReceipt;
  error?: { code: CommandErrorCode; message: string; fields?: CommandErrorField[] };
};
export type CanvasCommandState = {
  v: 1;
  storageEpoch: string;
  eventSeq: number;
  nameVersion: number;
  nodes: Record<string, NodeVersions>;
  edges: Record<string, number>;
  tombstones: { nodes: Record<string, NodeVersions>; edges: Record<string, number> };
  actors: Record<string, { acceptedSeq: number }>;
  receipts: Record<string, StoredCommandResult>;
  assets: Record<string, Required<Pick<AssetRegistration, "kind" | "createdAt">> & { missing: boolean }>;
  /** 仅记录不等于 deriveDocumentId(nodeId) 的正文 ID。 */
  documentIds: Record<string, string>;
};

export function emptyCommandState(): CanvasCommandState {
  return { v: 1, storageEpoch: JSON_STORAGE_EPOCH, eventSeq: 0, nameVersion: 0, nodes: {}, edges: {}, tombstones: { nodes: {}, edges: {} }, actors: {}, receipts: {}, assets: {}, documentIds: {} };
}

const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
/** 以 ID 为键的记录只用自有属性读写；原型相关键一律跳过。 */
export const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  !UNSAFE.has(key) && Object.hasOwn(record, key) ? record[key] : undefined;
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  if (UNSAFE.has(key)) return;
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
export function deleteOwn<T>(record: Record<string, T>, key: string): void {
  if (!UNSAFE.has(key) && Object.hasOwn(record, key)) delete record[key];
}

/** 旧节点顶层/数据路径 → 版本字段。 */
function versionField(path: string[]): string | null {
  const [head, second] = path;
  if (head === "position" || head === "width" || head === "height") return "geometry";
  if (head === "draggable") return "pinned";
  if (head === "data" && second) return second;
  return null;
}

const bumpAll = (versions: NodeVersions): NodeVersions => ({
  entity: versions.entity + 1,
  geometry: versions.geometry + 1,
  ...(versions.fields ? { fields: Object.fromEntries(Object.entries(versions.fields).map(([key, value]) => [key, value + 1])) } : {}),
});

/**
 * 非命令写入落盘前调用：对 before→after 的差异递增对应版本。
 * 被删节点/连线写入墓碑；墓碑 ID 被旧路径重新加入（例如旧撤销）时，从墓碑版本 +1 继续。
 */
export function bumpVersionsForLegacyWrite(state: CanvasCommandState, before: CanvasDoc, after: CanvasDoc): CanvasCommandState {
  const operations = diffCanvasOperations(before, after, () => "");
  if (!operations.length) return state;
  const next: CanvasCommandState = {
    ...state,
    nodes: { ...state.nodes },
    edges: { ...state.edges },
    tombstones: { nodes: { ...state.tombstones.nodes }, edges: { ...state.tombstones.edges } },
  };
  const touched = new Map<string, Set<string>>();
  const touchedEdges = new Set<string>();
  for (const op of operations) {
    if (op.target === "canvas") {
      if (op.path[0] === "name") next.nameVersion = state.nameVersion + 1;
      continue;
    }
    const id = op.entityId;
    if (!id || UNSAFE.has(id)) continue;
    if (op.target === "node") {
      if (!op.path.length) {
        const current = own(next.nodes, id) ?? { entity: 0, geometry: 0 };
        if (op.before.exists && !op.after.exists) { setOwn(next.tombstones.nodes, id, current); deleteOwn(next.nodes, id); }
        else if (!op.before.exists && op.after.exists) {
          const tomb = own(next.tombstones.nodes, id);
          if (tomb) { setOwn(next.nodes, id, bumpAll(tomb)); deleteOwn(next.tombstones.nodes, id); }
        }
        continue;
      }
      let fields = touched.get(id);
      if (!fields) { fields = new Set(); touched.set(id, fields); }
      const field = versionField(op.path);
      if (field) fields.add(field);
    } else {
      if (!op.path.length) {
        if (op.before.exists && !op.after.exists) { setOwn(next.tombstones.edges, id, own(next.edges, id) ?? 0); deleteOwn(next.edges, id); }
        else if (!op.before.exists && op.after.exists) {
          const tomb = own(next.tombstones.edges, id);
          if (tomb !== undefined) { setOwn(next.edges, id, tomb + 1); deleteOwn(next.tombstones.edges, id); }
        }
        continue;
      }
      touchedEdges.add(id);
    }
  }
  for (const [id, fields] of touched) {
    const current = own(next.nodes, id) ?? { entity: 0, geometry: 0 };
    const updated: NodeVersions = { entity: current.entity + 1, geometry: current.geometry + (fields.has("geometry") ? 1 : 0), ...(current.fields ? { fields: { ...current.fields } } : {}) };
    for (const field of fields) {
      if (field === "geometry") continue;
      updated.fields ??= {};
      setOwn(updated.fields, field, (own(updated.fields, field) ?? 0) + 1);
    }
    setOwn(next.nodes, id, updated);
  }
  for (const id of touchedEdges) setOwn(next.edges, id, (own(next.edges, id) ?? 0) + 1);
  return next;
}
