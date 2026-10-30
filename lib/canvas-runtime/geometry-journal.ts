import type { CanvasDoc } from "../canvas-store";

type Point = { x: number; y: number };
type Positioned = { id: string; position: Point };
export type GeometryMove = { id: string; from: Point; to: Point };
export type GeometryCheckpoint = { sequence: number; moves: GeometryMove[] };
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const point = (value: unknown): value is Point => !!value && typeof value === "object" && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);

/** 手势只持有坐标，途中采样不读取文档，不进入正式撤销栈。 */
export function createGeometryJournal(now: () => number = Date.now) {
  let sequence = 0;
  let moves: Map<string, GeometryMove> | null = null;
  let sampledAt = 0;
  let touched = false;
  // moved 跨越挂起保留：中途失焦推出检查点后，整段手势仍要能一次撤销回起点。
  let moved = false;
  let dirty = false;
  const snapshot = (): GeometryCheckpoint => ({ sequence, moves: [...moves!.values()].map(move => ({ id: move.id, from: { ...move.from }, to: { ...move.to } })) });
  const track = (nodes: readonly Positioned[]) => {
    for (const node of nodes) {
      const move = moves?.get(node.id);
      if (move && point(node.position) && !same(move.to, node.position)) {
        move.to = { ...node.position };
        if (!same(move.from, move.to)) moved = true;
        dirty = touched = true;
      }
    }
  };
  return {
    through: () => sequence,
    /** 是否还持有起点锚点（挂起保留，结束后清空）。 */
    active: () => moves !== null,
    advance(value: number) { if (Number.isSafeInteger(value)) sequence = Math.max(sequence, value); },
    begin(nodes: readonly Positioned[]) {
      sequence = Math.max(sequence + 1, now());
      sampledAt = now();
      moves = new Map(nodes.map(node => [node.id, { id: node.id, from: { ...node.position }, to: { ...node.position } }]));
      dirty = touched = moved = false;
    },
    update(nodes: readonly Positioned[]) {
      track(nodes);
    },
    sample(): GeometryCheckpoint | null {
      if (!moves || !dirty || now() - sampledAt < 250) return null;
      sampledAt = now(); dirty = false;
      return snapshot();
    },
    /** 失焦／页面隐藏时落一个检查点，但不结束手势：锚点保留，后续位移仍算同一次移动。 */
    suspend(nodes: readonly Positioned[] = []): GeometryCheckpoint | null {
      track(nodes);
      const result = moves && touched ? snapshot() : null;
      if (moves) {
        sequence = Math.max(sequence + 1, now());
        sampledAt = now();
      }
      dirty = touched = false;
      return result;
    },
    finish(): GeometryCheckpoint | null {
      const result = moves && moved ? snapshot() : null;
      moves = null; dirty = touched = moved = false;
      return result;
    },
  };
}

/** 恢复时才建立一次索引；冲突按整次群组手势跳过，不覆盖远端坐标或正文。 */
export function restoreGeometry(doc: CanvasDoc, checkpoints: readonly GeometryCheckpoint[]) {
  let nodes = doc.nodes;
  const positions = new Map(nodes.map((node, index) => [(node as Positioned).id, index]));
  const conflicts = new Set<string>();
  for (const checkpoint of [...checkpoints].sort((a, b) => a.sequence - b.sequence)) {
    if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 || !Array.isArray(checkpoint.moves)
      || checkpoint.moves.some(move => !move || typeof move.id !== "string" || !point(move.from) || !point(move.to))
      || new Set(checkpoint.moves.map(move => move.id)).size !== checkpoint.moves.length) throw new Error("坐标检查点损坏，已保留原记录");
    const blocked = checkpoint.moves.filter(move => {
      const index = positions.get(move.id);
      if (index === undefined) return false;
      const current = (nodes[index] as Positioned).position;
      return !point(current) || (!same(current, move.from) && !same(current, move.to));
    });
    if (blocked.length) { blocked.forEach(move => conflicts.add(move.id)); continue; }
    for (const move of checkpoint.moves) {
      const index = positions.get(move.id);
      if (index === undefined) continue;
      const node = nodes[index] as Positioned;
      if (same(node.position, move.to)) continue;
      if (nodes === doc.nodes) nodes = [...nodes];
      nodes[index] = { ...node, position: { ...move.to }, dragging: false, resizing: false };
    }
  }
  return { document: nodes === doc.nodes ? doc : { ...doc, nodes }, conflicts: [...conflicts] };
}
