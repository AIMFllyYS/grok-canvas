/**
 * 用户离散动作 → 领域命令（P2-07，contracts.md C1/C2/C3）。
 * 只比较“上次提交后被替换过对象引用”的节点/连线（指针比较 + 单节点字段比较），不做整图 diff。
 * - 新增：预分配 UUID，add_nodes（正文进 DocumentRecord）；同批连线 edit_edges，整批 batch 原子提交。
 * - 删除：delete_nodes 带 expectedEntityVersion，相关边由服务端原子级联，不重复发 remove。
 * - 字段：user 字段 → patch_nodes（正文用文档版本，其他用字段版本）；几何由 P2-06 的 move_nodes 负责。
 * - service/legacy 字段（客户端生成回写）与画布视口/素材库：只为被触碰的字段生成兼容 operations，
 *   由 legacyServiceWrites 发送；P2-08 把生成结果改为服务端 apply_generation 后删除。
 */
import type { CanvasOperation } from "../canvas-operations";
import { convertLegacyNode } from "./legacy-document";
import { fieldAccess, getNodeType } from "./node-registry";
import type { BatchItem, DocumentRecord, EdgeRecord, EdgeRole, NodeSummary } from "./types";

type Point = { x: number; y: number };
export type UserFlowNode = {
  id: string;
  type?: string;
  position: Point;
  width?: number | null;
  height?: number | null;
  draggable?: boolean;
  data: Record<string, unknown>;
  [key: string]: unknown;
};
export type UserFlowEdge = { id: string; source: string; target: string; data?: Record<string, unknown>; [key: string]: unknown };

export interface WriteVersions {
  known(nodeId: string): boolean;
  edgeKnown(edgeId: string): boolean;
  fieldVersion(nodeId: string, field: string): number;
  documentVersion(documentId: string): number;
  documentIdOf(nodeId: string): string | null;
  entityVersion(nodeId: string): number;
  edgeVersion(edgeId: string): number;
}

export type UserWrites = {
  /** 领域命令条目；调用方单条直接发、多条包成 batch。 */
  commands: BatchItem[];
  /** 仅限 service/legacy 字段与 data 删除键的兼容写入（P2-08 删除）。 */
  legacy: CanvasOperation[];
  /** 无法转换的节点（如未知类型），按旧导入路径整体写入并提示。 */
  issues: string[];
};

const ROLES = new Set<EdgeRole>(["first", "last", "reference"]);
const VIEW_KEYS = new Set(["selected", "dragging", "resizing", "measured", "position", "width", "height", "type", "id", "data", "draggable", "style", "className", "zIndex", "hidden", "parentId", "extent", "expandParent", "origin", "handles", "sourcePosition", "targetPosition", "connectable", "deletable", "selectable", "focusable", "ariaLabel", "initialWidth", "initialHeight"]);
const exists = (value: unknown) => value === undefined ? { exists: false as const } : { exists: true as const, value: structuredClone(value) };
const sameValue = (a: unknown, b: unknown) => Object.is(a, b) || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b));
const edgeRole = (edge: UserFlowEdge): EdgeRole | null => {
  const role = edge.data?.role;
  return typeof role === "string" && ROLES.has(role as EdgeRole) ? role as EdgeRole : null;
};
const uuid = () => crypto.randomUUID();

/** 旧 Flow 节点 → NodeSummary（新增用，版本从 0 起）。 */
export function summaryOf(node: UserFlowNode, canvasId: string): { summary: NodeSummary; document: DocumentRecord | null } | { error: string } {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (value !== undefined && (VIEW_KEYS.has(key))) raw[key] = value;
  delete raw.selected; delete raw.dragging; delete raw.resizing;
  const converted = convertLegacyNode(raw, canvasId);
  if (!converted.summary) return { error: converted.issues.map(issue => issue.detail).join("；") || "节点无效" };
  const blocking = converted.issues.filter(issue => issue.code === "unknown_type" || issue.code === "invalid_geometry");
  if (blocking.length) return { error: blocking.map(issue => issue.detail).join("；") };
  const document = converted.summary.documentId ? { id: converted.summary.documentId, nodeId: node.id, content: converted.content ?? "", version: 0 } : null;
  return { summary: converted.summary, document };
}

export function edgeRecordOf(edge: UserFlowEdge, canvasId: string): EdgeRecord {
  return { id: edge.id, canvasId, source: edge.source, target: edge.target, role: edgeRole(edge), version: 0 };
}

/** 单节点字段比较：返回 user 字段补丁与兼容写入。几何不在这里处理。 */
function nodeFieldWrites(before: UserFlowNode, after: UserFlowNode, versions: WriteVersions, patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }>, legacy: CanvasOperation[]) {
  const type = after.type ?? before.type ?? "";
  const hasDocument = getNodeType(type)?.hasDocument ?? false;
  if (before.data !== after.data) {
    for (const field of new Set([...Object.keys(before.data ?? {}), ...Object.keys(after.data ?? {})])) {
      const previous = before.data?.[field], next = after.data?.[field];
      if (sameValue(previous, next)) continue;
      const access = fieldAccess(type, field);
      if (field === "content" && hasDocument && typeof next === "string") {
        const documentId = versions.documentIdOf(after.id);
        if (documentId) { patches.push({ nodeId: after.id, field, expectedVersion: versions.documentVersion(documentId), value: next }); continue; }
      }
      if (access === "user" && next !== undefined) {
        patches.push({ nodeId: after.id, field, expectedVersion: versions.fieldVersion(after.id, field), value: structuredClone(next) });
        continue;
      }
      legacy.push({ id: uuid(), target: "node", entityId: after.id, path: ["data", field], before: exists(previous), after: exists(next) });
    }
  }
  const pinnedBefore = before.draggable === false, pinnedAfter = after.draggable === false;
  if (pinnedBefore !== pinnedAfter) patches.push({ nodeId: after.id, field: "pinned", expectedVersion: versions.fieldVersion(after.id, "pinned"), value: pinnedAfter });
}

/**
 * 把“上次提交后的节点/连线”与当前工作文档之间的差异翻译成命令。
 * committed 与 current 都是同一工作文档的不同时刻：未被替换的对象引用直接跳过。
 */
export function translateUserWrites(input: {
  canvasId: string;
  committedNodes: ReadonlyMap<string, UserFlowNode>;
  committedEdges: ReadonlyMap<string, UserFlowEdge>;
  nodes: readonly UserFlowNode[];
  edges: readonly UserFlowEdge[];
  versions: WriteVersions;
}): UserWrites {
  const { canvasId, committedNodes, committedEdges, nodes, edges, versions } = input;
  const issues: string[] = [];
  const legacy: CanvasOperation[] = [];
  const added: NodeSummary[] = [];
  const documents: DocumentRecord[] = [];
  const patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
  const currentIds = new Set<string>();
  for (const node of nodes) {
    currentIds.add(node.id);
    const before = committedNodes.get(node.id);
    if (before === node) continue;
    // 服务端已知（或已入队新增）：只比较这个节点的字段。
    if (versions.known(node.id)) {
      if (before) nodeFieldWrites(before, node, versions, patches, legacy);
      continue;
    }
    const converted = summaryOf(node, canvasId);
    if ("error" in converted) {
      issues.push(`节点 ${node.id}：${converted.error}`);
      continue;
    }
    added.push(converted.summary);
    if (converted.document) documents.push(converted.document);
  }
  const removedNodes = new Set<string>();
  const deletes: Array<{ nodeId: string; expectedEntityVersion: number }> = [];
  for (const id of committedNodes.keys()) {
    if (currentIds.has(id) || !versions.known(id)) continue;
    removedNodes.add(id);
    deletes.push({ nodeId: id, expectedEntityVersion: versions.entityVersion(id) });
  }
  const edgeAdds: EdgeRecord[] = [];
  const edgeRemovals: Array<{ edgeId: string; expectedVersion: number }> = [];
  const currentEdges = new Set<string>();
  for (const edge of edges) {
    currentEdges.add(edge.id);
    const before = committedEdges.get(edge.id);
    if (before === edge) continue;
    if (!versions.edgeKnown(edge.id)) { edgeAdds.push(edgeRecordOf(edge, canvasId)); continue; }
    if (!before) continue;
    // 端点或角色变化：先删后加（同一批原子），新 ID 保持墓碑语义。
    if (before.source !== edge.source || before.target !== edge.target || edgeRole(before) !== edgeRole(edge)) {
      edgeRemovals.push({ edgeId: edge.id, expectedVersion: versions.edgeVersion(edge.id) });
      edgeAdds.push(edgeRecordOf({ ...edge, id: uuid() }, canvasId));
      issues.push(`连线 ${edge.id} 的端点/角色变化以新 ID 重建`);
    }
  }
  for (const [id, edge] of committedEdges) {
    if (currentEdges.has(id) || !versions.edgeKnown(id)) continue;
    // 随节点删除的边由服务端级联删除。
    if (removedNodes.has(edge.source) || removedNodes.has(edge.target)) continue;
    edgeRemovals.push({ edgeId: id, expectedVersion: versions.edgeVersion(id) });
  }
  const commands: BatchItem[] = [];
  if (edgeRemovals.length) commands.push({ kind: "edit_edges", payload: { add: [], remove: edgeRemovals } });
  if (deletes.length) commands.push({ kind: "delete_nodes", payload: { items: deletes } });
  if (added.length) commands.push({ kind: "add_nodes", payload: { nodes: added, documents } });
  if (edgeAdds.length) commands.push({ kind: "edit_edges", payload: { add: edgeAdds, remove: [] } });
  if (patches.length) commands.push({ kind: "patch_nodes", payload: { items: patches } });
  return { commands, legacy, issues };
}

/** 复制：节点重新分配 UUID，只复制两端都在选中集合内的内部边并重映射；外部边不复制。 */
export function cloneSelection<N extends UserFlowNode, E extends UserFlowEdge>(nodes: readonly N[], edges: readonly E[], ids: ReadonlySet<string>, offset: Point = { x: 48, y: 48 }) {
  const idMap = new Map<string, string>();
  const copies = nodes.filter(node => ids.has(node.id)).map(node => {
    const id = uuid();
    idMap.set(node.id, id);
    return { ...node, id, position: { x: node.position.x + offset.x, y: node.position.y + offset.y }, data: structuredClone(node.data) } as N;
  });
  const internal = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({
    ...edge, id: uuid(), source: idMap.get(edge.source)!, target: idMap.get(edge.target)!,
  }) as E);
  return { nodes: copies, edges: internal, idMap };
}

/** 一组命令条目 → 单条命令草稿（kind + payload）；多于一条用 batch 保证原子。 */
export function toDraftBody(items: readonly BatchItem[]): { kind: BatchItem["kind"] | "batch"; payload: unknown } | null {
  if (!items.length) return null;
  if (items.length === 1) return { kind: items[0]!.kind, payload: items[0]!.payload };
  return { kind: "batch", payload: { commands: items } };
}
