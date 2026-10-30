/**
 * 字段版本历史（contracts.md C3）：只保存命令受影响字段的前值和提交后的版本，不保存整张画布。
 * undo/redo 都是新的条件命令：任一字段的当前版本与记录不符就整条拒绝，并返回全部冲突字段，
 * 不做半撤销，也不替用户决定保留哪一方。
 * 删除节点的撤销用新 ID 重建（墓碑禁止同 ID 复活），并返回 ID 映射。
 * 纯函数，浏览器与服务端均可使用。
 */
import type {
  BatchItem, CanvasCommand, CommitReceipt, DocumentRecord, EdgeRecord, FieldRef, Geometry, NodeSummary,
} from "./types";

export interface HistoryReader {
  getNode(id: string): NodeSummary | undefined;
  getDocument(id: string): DocumentRecord | undefined;
  getEdge(id: string): EdgeRecord | undefined;
  incomingEdgeIds(nodeId: string): string[];
  outgoingEdgeIds(nodeId: string): string[];
  /** 非几何、非正文字段（name/prompt/pinned 等）的版本，未记录为 0。 */
  fieldVersion(nodeId: string, field: string): number;
  canvasName(): string;
  nameVersion(): number;
}

export type HistoryItem =
  | { kind: "geometry"; nodeId: string; before: Geometry; after: Geometry; version: number }
  | { kind: "field"; nodeId: string; field: string; before: unknown; after: unknown; version: number }
  | { kind: "content"; nodeId: string; documentId: string; before: string; after: string; version: number }
  | { kind: "name"; before: string; after: string; version: number }
  | { kind: "addNode"; node: NodeSummary; document: DocumentRecord | null }
  | { kind: "removeNode"; node: NodeSummary; document: DocumentRecord | null; edges: EdgeRecord[] }
  | { kind: "addEdge"; edge: EdgeRecord }
  | { kind: "removeEdge"; edge: EdgeRecord };

export type HistoryEntry = { canvasId: string; commandId: string; items: HistoryItem[] };

export type HistoryCommandIds = {
  commandId: string;
  actorId: string;
  actorSeq: number;
  storageEpoch: string;
  baseRevision: number;
  /** 为删除撤销重建实体分配新 ID。 */
  createId: () => string;
};

export type HistoryCommandResult =
  | { ok: true; command: CanvasCommand; idMap: Map<string, string> }
  | { ok: false; conflicts: FieldRef[] };

/** 结构化的快照读取器：P2-06 由 Store + 字段版本表实现，测试可直接用实体快照。 */
export type HistorySnapshot = {
  name: string;
  nameVersion: number;
  nodes: readonly NodeSummary[];
  documents: readonly DocumentRecord[];
  edges: readonly EdgeRecord[];
  fieldVersions: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

export function historyReaderFromSnapshot(snapshot: HistorySnapshot): HistoryReader {
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const documents = new Map(snapshot.documents.map(doc => [doc.id, doc]));
  const edges = new Map(snapshot.edges.map(edge => [edge.id, edge]));
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    (incoming.get(edge.target) ?? incoming.set(edge.target, []).get(edge.target)!).push(edge.id);
    (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)!).push(edge.id);
  }
  return {
    getNode: id => nodes.get(id),
    getDocument: id => documents.get(id),
    getEdge: id => edges.get(id),
    incomingEdgeIds: id => [...(incoming.get(id) ?? [])],
    outgoingEdgeIds: id => [...(outgoing.get(id) ?? [])],
    fieldVersion: (nodeId, field) => (Object.hasOwn(snapshot.fieldVersions, nodeId) ? snapshot.fieldVersions[nodeId]![field] : undefined) ?? 0,
    canvasName: () => snapshot.name,
    nameVersion: () => snapshot.nameVersion,
  };
}

const fieldValue = (node: NodeSummary | undefined, field: string) => field === "pinned" ? node?.data.pinned === true : node?.data[field];
const clone = <T>(value: T): T => structuredClone(value);

/**
 * 在命令提交后调用：before 是提交前的读取器（客户端 Store 当时的状态），receipt 是服务端回执。
 * 回执未改变任何实体时返回 null（空变更不进历史）。
 */
export function recordCommitted(command: CanvasCommand, before: HistoryReader, receipt: CommitReceipt): HistoryEntry | null {
  const items: HistoryItem[] = [];
  const after = new Map(receipt.delta.nodes.map(node => [node.id, node]));
  const afterDocs = new Map(receipt.delta.documents.map(doc => [doc.id, doc]));
  const removedNodes = new Set(receipt.delta.removedNodeIds);
  const cascadedEdges = new Set<string>();

  for (const id of receipt.delta.removedNodeIds) {
    const node = before.getNode(id);
    if (!node) continue;
    const edgeIds = [...before.incomingEdgeIds(id), ...before.outgoingEdgeIds(id)];
    const edges = edgeIds.map(edgeId => before.getEdge(edgeId)).filter((edge): edge is EdgeRecord => !!edge);
    for (const edge of edges) cascadedEdges.add(edge.id);
    items.push({ kind: "removeNode", node: clone(node), document: node.documentId ? clone(before.getDocument(node.documentId) ?? null) : null, edges: clone(edges) });
  }
  for (const node of receipt.delta.nodes) {
    if (before.getNode(node.id)) continue;
    items.push({ kind: "addNode", node: clone(node), document: node.documentId ? clone(afterDocs.get(node.documentId) ?? null) : null });
  }
  for (const ref of receipt.fieldVersions) {
    if (ref.target === "node") {
      const previous = before.getNode(ref.id);
      const next = after.get(ref.id);
      if (!previous || !next || removedNodes.has(ref.id)) continue;
      if (ref.field === "geometry") items.push({ kind: "geometry", nodeId: ref.id, before: { ...previous.geometry }, after: { ...next.geometry }, version: ref.version });
      else items.push({ kind: "field", nodeId: ref.id, field: ref.field, before: clone(fieldValue(previous, ref.field)), after: clone(fieldValue(next, ref.field)), version: ref.version });
    } else if (ref.target === "document") {
      const previous = before.getDocument(ref.id);
      const next = afterDocs.get(ref.id);
      if (!previous || !next) continue;
      items.push({ kind: "content", nodeId: next.nodeId, documentId: ref.id, before: previous.content, after: next.content, version: ref.version });
    } else if (ref.target === "canvas" && ref.field === "name") {
      items.push({ kind: "name", before: before.canvasName(), after: receipt.delta.name ?? before.canvasName(), version: ref.version });
    }
  }
  for (const edge of receipt.delta.edges) if (!before.getEdge(edge.id)) items.push({ kind: "addEdge", edge: clone(edge) });
  for (const id of receipt.delta.removedEdgeIds) {
    if (cascadedEdges.has(id)) continue;
    const edge = before.getEdge(id);
    if (edge) items.push({ kind: "removeEdge", edge: clone(edge) });
  }
  void command;
  return items.length ? { canvasId: receipt.delta.canvasId, commandId: receipt.commandId, items } : null;
}

/** 生成撤销命令；任一字段所有权已改变就整条拒绝并列出全部冲突。 */
export function createUndoCommand(entry: HistoryEntry, current: HistoryReader, ids: HistoryCommandIds): HistoryCommandResult {
  const conflicts: FieldRef[] = [];
  const conflict = (target: FieldRef["target"], id: string, field: string) => conflicts.push({ target, id, field });
  const idMap = new Map<string, string>();
  const removedByUndo = new Set<string>();
  for (const item of entry.items) if (item.kind === "addNode") removedByUndo.add(item.node.id);
  const restored = new Map<string, string>();
  for (const item of entry.items) if (item.kind === "removeNode") restored.set(item.node.id, "");

  const moves: Array<{ nodeId: string; expectedVersion: number; from: Geometry; to: Geometry }> = [];
  const patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
  const deletes: Array<{ nodeId: string; expectedEntityVersion: number }> = [];
  const edgeRemovals: Array<{ edgeId: string; expectedVersion: number }> = [];
  const addedNodes: NodeSummary[] = [];
  const addedDocuments: DocumentRecord[] = [];
  const edgeAdds: EdgeRecord[] = [];
  let rename: { expectedVersion: number; name: string } | null = null;

  for (const item of entry.items) {
    switch (item.kind) {
      case "geometry": {
        const node = current.getNode(item.nodeId);
        if (!node || node.geometryVersion !== item.version) { conflict("node", item.nodeId, "geometry"); break; }
        moves.push({ nodeId: item.nodeId, expectedVersion: item.version, from: { ...node.geometry }, to: { ...item.before } });
        break;
      }
      case "field": {
        if (!current.getNode(item.nodeId) || current.fieldVersion(item.nodeId, item.field) !== item.version) { conflict("node", item.nodeId, item.field); break; }
        patches.push({ nodeId: item.nodeId, field: item.field, expectedVersion: item.version, value: clone(item.before) });
        break;
      }
      case "content": {
        const doc = current.getDocument(item.documentId);
        if (!doc || doc.version !== item.version) { conflict("document", item.documentId, "content"); break; }
        patches.push({ nodeId: item.nodeId, field: "content", expectedVersion: item.version, value: item.before });
        break;
      }
      case "name": {
        if (current.nameVersion() !== item.version) { conflict("canvas", entry.canvasId, "name"); break; }
        rename = { expectedVersion: item.version, name: item.before };
        break;
      }
      case "addNode": {
        const node = current.getNode(item.node.id);
        // 节点之后被任何人改过（含生成结果写入）就不能删除，避免撤销抹掉后来的结果。
        if (!node || node.entityVersion !== item.node.entityVersion) { conflict("node", item.node.id, "entity"); break; }
        deletes.push({ nodeId: item.node.id, expectedEntityVersion: node.entityVersion });
        break;
      }
      case "removeNode": {
        const newId = ids.createId();
        idMap.set(item.node.id, newId);
        restored.set(item.node.id, newId);
        const documentId = item.document ? `doc_${newId}` : null;
        addedNodes.push({ ...clone(item.node), id: newId, entityVersion: 0, geometryVersion: 0, documentId });
        if (item.document && documentId) addedDocuments.push({ id: documentId, nodeId: newId, content: item.document.content, version: 0 });
        break;
      }
      case "addEdge": {
        const edge = current.getEdge(item.edge.id);
        if (!edge) {
          // 端点被删除时连线随之消失：若删除来自本次撤销本身则无需再删，否则视为冲突。
          if (!removedByUndo.has(item.edge.source) && !removedByUndo.has(item.edge.target)) conflict("edge", item.edge.id, "entity");
          break;
        }
        if (edge.version !== item.edge.version) { conflict("edge", item.edge.id, "entity"); break; }
        if (!removedByUndo.has(edge.source) && !removedByUndo.has(edge.target)) edgeRemovals.push({ edgeId: edge.id, expectedVersion: edge.version });
        break;
      }
      case "removeEdge":
        break;
    }
  }

  // 重建被删的连线（含随节点级联删除的）：端点取重建后的新 ID 或仍然存在的旧节点。
  const endpoint = (id: string) => restored.get(id) || (current.getNode(id) && !removedByUndo.has(id) ? id : null);
  const rebuildEdge = (edge: EdgeRecord) => {
    const source = endpoint(edge.source), target = endpoint(edge.target);
    if (!source || !target) { conflict("node", !source ? edge.source : edge.target, "entity"); return; }
    const newId = ids.createId();
    idMap.set(edge.id, newId);
    edgeAdds.push({ ...clone(edge), id: newId, source, target, version: 0 });
  };
  const seenEdges = new Set<string>();
  for (const item of entry.items) {
    const edges = item.kind === "removeNode" ? item.edges : item.kind === "removeEdge" ? [item.edge] : [];
    for (const edge of edges) if (!seenEdges.has(edge.id)) { seenEdges.add(edge.id); rebuildEdge(edge); }
  }

  if (conflicts.length) return { ok: false, conflicts };
  const commands: BatchItem[] = [];
  if (edgeRemovals.length) commands.push({ kind: "edit_edges", payload: { add: [], remove: edgeRemovals } });
  if (deletes.length) commands.push({ kind: "delete_nodes", payload: { items: deletes } });
  if (addedNodes.length) commands.push({ kind: "add_nodes", payload: { nodes: addedNodes, documents: addedDocuments } });
  if (edgeAdds.length) commands.push({ kind: "edit_edges", payload: { add: edgeAdds, remove: [] } });
  if (moves.length) commands.push({ kind: "move_nodes", payload: { items: moves } });
  if (patches.length) commands.push({ kind: "patch_nodes", payload: { items: patches } });
  if (rename) commands.push({ kind: "rename_canvas", payload: rename });
  if (!commands.length) return { ok: false, conflicts: [] };
  const envelope = { schemaVersion: 1 as const, commandId: ids.commandId, actorId: ids.actorId, actorSeq: ids.actorSeq, canvasId: entry.canvasId, storageEpoch: ids.storageEpoch, baseRevision: ids.baseRevision };
  const command = (commands.length === 1 ? { ...envelope, ...commands[0]! } : { ...envelope, kind: "batch", payload: { commands } }) as CanvasCommand;
  return { ok: true, command, idMap };
}

/** redo = 对撤销命令记录的历史再做一次撤销；前置条件基于撤销之后的新版本。 */
export function createRedoCommand(undoEntry: HistoryEntry, current: HistoryReader, ids: HistoryCommandIds): HistoryCommandResult {
  return createUndoCommand(undoEntry, current, ids);
}
