import type { CanvasDoc } from "./canvas-store";
import { resolveCanvasReferences, type ReferenceEdge, type ReferenceNode } from "./canvas-references";
import { isLibraryAsset } from "./canvas-library";

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
  const removals: CanvasOperation[] = [], changes: CanvasOperation[] = [], additions: CanvasOperation[] = [];
  const push = (target: CanvasOperation["target"], entityId: string | undefined, path: string[], oldValue: CanvasValue, newValue: CanvasValue) => {
    if (!equal(oldValue, newValue)) changes.push({ id: createId(), target, entityId, path, before: oldValue, after: newValue });
  };
  const fields = (target: CanvasOperation["target"], entityId: string | undefined, left: Record<string, unknown>, right: Record<string, unknown>, path: string[] = []) => {
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

/** Apply a batch atomically to a private copy. Every changed value is checked against its baseline. */
export function applyCanvasOperations(doc: CanvasDoc, operations: CanvasOperation[]): CanvasDoc {
  const next = structuredClone(doc);
  const applied = new Set(next.appliedOperationIds ?? []);
  for (const op of operations) {
    if (applied.has(op.id)) continue;
    if (!op.id || op.path.some(key => !key || unsafe.has(key)) || (op.target === "canvas" && (!op.path.length || !["name", "viewport", "libraryAssets"].includes(op.path[0]!))) || (op.target !== "canvas" && (!op.entityId || op.path[0] === "id" || op.path[0] === "type"))) throw new CanvasOperationConflict(op.id, "无效的画布操作");
    const items = op.target === "node" ? next.nodes : next.edges;
    const index = op.target === "canvas" ? -1 : items.findIndex(item => object(item) && item.id === op.entityId);
    let container: Record<string, unknown>;
    let key: string;
    if (op.target !== "canvas" && op.path.length === 0) {
      const existing = items[index];
      const before: CanvasValue = index < 0 ? { exists: false } : { exists: true, value: object(existing) ? persistedEntity(existing, op.target) : existing };
      if (!equal(before, op.before)) throw new CanvasOperationConflict(op.id, "节点或连线已被修改");
      if (op.after.exists) {
        if (!object(op.after.value) || op.after.value.id !== op.entityId) throw new CanvasOperationConflict(op.id, "节点或连线格式无效");
        if (index < 0) items.push(op.after.value); else items[index] = op.after.value;
      } else if (index >= 0) items.splice(index, 1);
      applied.add(op.id);
      continue;
    }
    const root = op.target === "canvas" ? next : items[index];
    if (!object(root)) throw new CanvasOperationConflict(op.id, "节点或连线已被删除");
    container = root;
    for (const part of op.path.slice(0, -1)) {
      const child = container[part];
      if (!object(child)) throw new CanvasOperationConflict(op.id, "画布内容已被修改");
      container = child;
    }
    key = op.path.at(-1)!;
    if (!equal(read(container, key), op.before)) throw new CanvasOperationConflict(op.id, "画布内容已被修改");
    if (op.after.exists) container[key] = op.after.value; else delete container[key];
    applied.add(op.id);
  }
  if (typeof next.name !== "string" || !next.name.trim() || !object(next.viewport) || ![next.viewport.x, next.viewport.y, next.viewport.zoom].every(Number.isFinite) || (next.libraryAssets !== undefined && (!Array.isArray(next.libraryAssets) || !next.libraryAssets.every(isLibraryAsset)))) throw new CanvasOperationConflict("", "画布属性无效");
  const nodes = next.nodes as ReferenceNode[];
  if (nodes.some(node => !object(node) || typeof node.id !== "string" || !object(node.data))) throw new CanvasOperationConflict("", "节点格式无效");
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new CanvasOperationConflict("", "节点 ID 重复");
  const edges = next.edges as ReferenceEdge[];
  if (edges.some(edge => !object(edge) || typeof edge.id !== "string" || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) || new Set(edges.map(edge => edge.id)).size !== edges.length) throw new CanvasOperationConflict("", "连线的节点已被删除或连线无效");
  try {
    for (const edge of edges) {
      const source = nodes.find(node => node.id === edge.source)!, target = nodes.find(node => node.id === edge.target)!;
      if (source.type !== "canvasText" && target.type !== "canvasText" && (!['image', 'asset'].includes(source.type ?? "") || !['image', 'video'].includes(target.type ?? ""))) throw new Error("连线端点无效");
    }
    for (const node of nodes) if (node.type === "image" || node.type === "video") resolveCanvasReferences(node, nodes, edges);
  } catch (error) { throw new CanvasOperationConflict("", error instanceof Error ? error.message : "连线无效"); }
  next.appliedOperationIds = [...applied];
  return next;
}
