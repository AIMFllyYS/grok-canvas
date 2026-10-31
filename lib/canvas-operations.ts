import type { CanvasDoc } from "./canvas-store";
import { createReferenceIndex, resolveCanvasReferences, type ReferenceEdge, type ReferenceNode } from "./canvas-references";
import { isLibraryAsset } from "./canvas-library";
import { canvasMetrics } from "./canvas-runtime/metrics";

export type CanvasValue = { exists: false } | { exists: true; value: unknown };
export type CanvasOperation = {
  id: string;
  target: "canvas" | "node" | "edge";
  entityId?: string;
  path: string[];
  before: CanvasValue;
  after: CanvasValue;
};

export class CanvasOperationConflict extends Error {
  constructor(public operationId: string, message: string) { super(message); }
}

const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(key => Object.hasOwn(y, key) && equal(x[key], y[key]));
};

const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const read = (v: Record<string, unknown>, key: string): CanvasValue => Object.hasOwn(v, key) ? { exists: true, value: v[key] } : { exists: false };
const persistedEntity = (item: Record<string, unknown>, target: "node" | "edge"): Record<string, unknown> => {
  const { selected: _selected, dragging: _dragging, resizing: _resizing, measured: _measured, ...rest } = item;
  return target === "edge" ? { ...rest, type: "scissor" } : rest;
};

/** Read the current field without creating missing parents. */
export function readCanvasOperationValue(doc: CanvasDoc, op: CanvasOperation): CanvasValue | null {
  const root = op.target === "canvas" ? doc : (op.target === "node" ? doc.nodes : doc.edges).find(item => object(item) && item.id === op.entityId);
  if (!object(root) || !op.path.length) return null;
  let current = root;
  for (const key of op.path.slice(0, -1)) {
    const child = current[key];
    if (!object(child)) return null;
    current = child;
  }
  return read(current, op.path.at(-1)!);
}

/** Produce conditional field changes from the last acknowledged snapshot. */
export function diffCanvasOperations(before: CanvasDoc, after: CanvasDoc, createId: () => string = () => crypto.randomUUID()): CanvasOperation[] {
  // 诊断：整图差异次数（P6-01）。默认关闭时是一次布尔判断。
  canvasMetrics.record("full_scan_count", 1, { nodeCount: after.nodes.length });
  const removals: CanvasOperation[] = [], changes: CanvasOperation[] = [], additions: CanvasOperation[] = [];
  const push = (target: CanvasOperation["target"], entityId: string | undefined, path: string[], oldValue: CanvasValue, newValue: CanvasValue) => {
    if (!equal(oldValue, newValue)) changes.push({ id: createId(), target, entityId, path, before: oldValue, after: newValue });
  };
  const fields = (target: CanvasOperation["target"], entityId: string | undefined, left: Record<string, unknown>, right: Record<string, unknown>, path: string[] = []) => {
    if (left === right) return;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (unsafe.has(key) || (!path.length && (key === "id" || key === "type" || key === "selected" || key === "dragging" || key === "resizing" || key === "measured"))) continue;
      const oldValue = read(left, key), newValue = read(right, key), nextPath = [...path, key];
      if (oldValue.exists && newValue.exists && object(oldValue.value) && object(newValue.value)) fields(target, entityId, oldValue.value, newValue.value, nextPath);
      else push(target, entityId, nextPath, oldValue, newValue);
    }
  };
  for (const key of ["name", "viewport", "libraryAssets"] as const) {
    const left = read(before as unknown as Record<string, unknown>, key), right = read(after as unknown as Record<string, unknown>, key);
    if (left.exists && right.exists && object(left.value) && object(right.value)) fields("canvas", undefined, left.value, right.value, [key]);
    else push("canvas", undefined, [key], left, right);
  }
  for (const [target, a, b] of [["edge", before.edges, after.edges], ["node", before.nodes, after.nodes]] as const) {
    const old = new Map(a.filter(object).map(item => [item.id, item]));
    const next = new Map(b.filter(object).map(item => [item.id, item]));
    for (const [id, item] of old) {
      if (typeof id !== "string") continue;
      const updated = next.get(id);
      if (!updated) removals.push({ id: createId(), target, entityId: id, path: [], before: { exists: true, value: persistedEntity(item, target) }, after: { exists: false } });
      else fields(target, id, item, updated);
    }
    for (const [id, item] of next) if (typeof id === "string" && !old.has(id)) additions.unshift({ id: createId(), target, entityId: id, path: [], before: { exists: false }, after: { exists: true, value: persistedEntity(item, target) } });
  }
  return [...removals, ...additions, ...changes];
}

/** 数组仅在批次结束时物化；批内增删不导致后续操作重新线性查找。 */
function entityDraft(items: unknown[]) {
  let index: Map<string, Record<string, unknown>> | undefined;
  let dirty = false;
  const lookup = () => {
    if (!index) {
      index = new Map();
      for (const item of items) {
        if (!object(item) || typeof item.id !== "string" || index.has(item.id)) throw new CanvasOperationConflict("", "实体格式无效或 ID 重复");
        index.set(item.id, item);
      }
    }
    return index;
  };
  return {
    get: (id: string) => lookup().get(id),
    set(id: string, value: Record<string, unknown>) { lookup().set(id, value); dirty = true; },
    remove(id: string) { dirty = lookup().delete(id) || dirty; },
    finish: () => dirty ? [...lookup().values()] : items,
  };
}

/** 只复制被写的对象路径；输入文档和操作载荷都保持不可变。 */
function patchField(root: Record<string, unknown>, op: CanvasOperation, depth = 0): Record<string, unknown> {
  const key = op.path[depth]!;
  const next = { ...root };
  if (depth === op.path.length - 1) {
    if (!equal(read(root, key), op.before)) throw new CanvasOperationConflict(op.id, "画布内容已被修改");
    if (op.after.exists) next[key] = structuredClone(op.after.value);
    else delete next[key];
  } else {
    const child = Object.hasOwn(root, key) ? root[key] : undefined;
    if (!object(child)) throw new CanvasOperationConflict(op.id, "画布内容已被修改");
    next[key] = patchField(child, op, depth + 1);
  }
  return next;
}

/** 批次原子应用；写时复制保留未变引用，兼容入口仍执行完整校验。 */
export function applyCanvasOperations(doc: CanvasDoc, operations: CanvasOperation[]): CanvasDoc {
  let next = { ...doc };
  const applied = new Set(doc.appliedOperationIds ?? []);
  if (operations.length && operations.every(op => applied.has(op.id))) return doc;
  const nodeDraft = entityDraft(doc.nodes), edgeDraft = entityDraft(doc.edges);
  for (const op of operations) {
    if (applied.has(op.id)) continue;
    if (!op.id || op.path.some(key => !key || unsafe.has(key)) || (op.target === "canvas" && (!op.path.length || !["name", "viewport", "libraryAssets"].includes(op.path[0]!))) || (op.target !== "canvas" && (!op.entityId || op.path[0] === "id" || op.path[0] === "type"))) throw new CanvasOperationConflict(op.id, "无效的画布操作");
    const items = op.target === "node" ? nodeDraft : edgeDraft;
    if (op.target !== "canvas" && op.path.length === 0) {
      const existing = items.get(op.entityId!);
      const before: CanvasValue = existing === undefined ? { exists: false } : { exists: true, value: persistedEntity(existing, op.target) };
      if (!equal(before, op.before)) throw new CanvasOperationConflict(op.id, "节点或连线已被修改");
      if (op.after.exists) {
        if (!object(op.after.value) || op.after.value.id !== op.entityId) throw new CanvasOperationConflict(op.id, "节点或连线格式无效");
        items.set(op.entityId!, structuredClone(op.after.value));
      } else items.remove(op.entityId!);
      applied.add(op.id);
      continue;
    }
    const root = op.target === "canvas" ? next : items.get(op.entityId!);
    if (!object(root)) throw new CanvasOperationConflict(op.id, "节点或连线已被删除");
    const updated = patchField(root, op);
    if (op.target === "canvas") next = updated as CanvasDoc;
    else items.set(op.entityId!, updated);
    applied.add(op.id);
  }
  next.nodes = nodeDraft.finish();
  next.edges = edgeDraft.finish();
  if (typeof next.name !== "string" || !next.name.trim() || !object(next.viewport) || ![next.viewport.x, next.viewport.y, next.viewport.zoom].every(Number.isFinite) || (next.libraryAssets !== undefined && (!Array.isArray(next.libraryAssets) || !next.libraryAssets.every(isLibraryAsset)))) throw new CanvasOperationConflict("", "画布属性无效");
  const nodes = next.nodes as ReferenceNode[];
  if (nodes.some(node => !object(node) || typeof node.id !== "string" || !object(node.data))) throw new CanvasOperationConflict("", "节点格式无效");
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new CanvasOperationConflict("", "节点 ID 重复");
  const edges = next.edges as ReferenceEdge[];
  if (edges.some(edge => !object(edge) || typeof edge.id !== "string" || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) || new Set(edges.map(edge => edge.id)).size !== edges.length) throw new CanvasOperationConflict("", "连线的节点已被删除或连线无效");
  try {
    const index = createReferenceIndex(nodes, edges);
    for (const edge of edges) {
      const source = index.nodeById.get(edge.source)!, target = index.nodeById.get(edge.target)!;
      if (source.type !== "canvasText" && target.type !== "canvasText" && (!['image', 'asset'].includes(source.type ?? "") || !['image', 'video'].includes(target.type ?? ""))) throw new Error("连线端点无效");
    }
    for (const node of nodes) if (node.type === "image" || node.type === "video") resolveCanvasReferences(node, nodes, edges, index);
  } catch (error) { throw new CanvasOperationConflict("", error instanceof Error ? error.message : "连线无效"); }
  next.appliedOperationIds = [...applied];
  return next;
}
