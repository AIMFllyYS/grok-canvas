/**
 * 领域命令 reducer（contracts.md C2）：输入实体读取接口与已解析命令，输出写集。
 * - 只读取目标实体、相关边与受影响的引用下游，不加载或遍历全图；
 * - 同一子命令内的版本冲突全部收集后一次报告（fields 列出确切实体与字段），不做部分成功；
 * - batch 在影子状态上顺序执行，任一子命令失败则整条命令无写集（原子）；
 * - 不分配 revision/eventSeq，不写回执：由仓库在同一事务内完成。
 */
import { resolveCanvasReferences, type ReferenceEdge, type ReferenceNode } from "../canvas-references";
import { canonicalJson } from "./command-schema";
import { checkNodeGeometry, checkNodePatch, formatIssue } from "./node-registry";
import type {
  AssetRegistration, BatchItem, CanvasCommand, CommandErrorField, DocumentRecord, EdgeRecord, FieldRef, Geometry, NodeSummary,
} from "./types";

export interface EntityReader {
  readonly canvasId: string;
  canvasName(): string;
  nameVersion(): number;
  getNode(id: string): NodeSummary | undefined;
  getDocument(id: string): DocumentRecord | undefined;
  getEdge(id: string): EdgeRecord | undefined;
  incomingEdgeIds(nodeId: string): string[];
  outgoingEdgeIds(nodeId: string): string[];
  /** 非几何、非正文字段的版本；未记录为 0。 */
  fieldVersion(nodeId: string, field: string): number;
  isNodeTombstoned(id: string): boolean;
  isEdgeTombstoned(id: string): boolean;
  generationClaim(nodeId: string): { id: string; state: string } | undefined;
}

export type RegisteredAsset = Required<Pick<AssetRegistration, "assetName" | "kind" | "createdAt">> & { missing: boolean };

export type WriteSet = {
  nodes: Map<string, NodeSummary>;
  documents: Map<string, DocumentRecord>;
  edges: Map<string, EdgeRecord>;
  removedNodes: Set<string>;
  removedDocuments: Set<string>;
  removedEdges: Set<string>;
  /** nodeId → field → 新版本（name/prompt/pinned 等）。 */
  nodeFieldVersions: Map<string, Map<string, number>>;
  fieldVersions: Map<string, FieldRef & { version: number }>;
  name?: string;
  nameVersion?: number;
  assets: Map<string, RegisteredAsset>;
};

export type ReducerContext = {
  /** 受信服务端核验素材物理存在；未提供时采信命令中的 missing。 */
  assetExists?: (assetName: string) => boolean;
};

export class ReducerError extends Error {
  readonly code: "field_conflict" | "invalid_command";
  readonly fields: CommandErrorField[];
  constructor(code: "field_conflict" | "invalid_command", message: string, fields: CommandErrorField[] = []) {
    super(message);
    this.name = "ReducerError";
    this.code = code;
    this.fields = fields;
  }
}

/** 冲突字段路径：target/id/field，例如 node/n1/geometry、document/doc_t1/content、canvas/c1/name。 */
export const fieldPath = (ref: FieldRef) => `${ref.target}/${ref.id}/${ref.field}`;

const invalid = (message: string): never => { throw new ReducerError("invalid_command", message); };
const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameValue = (a: unknown, b: unknown) => Object.is(a, b) || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && canonicalJson(a) === canonicalJson(b));
const REFERENCE_FIELDS = new Set(["uploadAttachments", "uploadInputs", "attachmentNames"]);

export const emptyWriteSet = (): WriteSet => ({
  nodes: new Map(), documents: new Map(), edges: new Map(),
  removedNodes: new Set(), removedDocuments: new Set(), removedEdges: new Set(),
  nodeFieldVersions: new Map(), fieldVersions: new Map(), assets: new Map(),
});

export const isEmptyWriteSet = (w: WriteSet) =>
  !w.nodes.size && !w.documents.size && !w.edges.size && !w.removedNodes.size && !w.removedDocuments.size
  && !w.removedEdges.size && w.name === undefined && !w.assets.size;

/** 在底层读取器之上叠加本命令已产生的写集。 */
function shadow(base: EntityReader, w: WriteSet): EntityReader {
  const edgeIds = (nodeId: string, side: "source" | "target", baseIds: string[]) => {
    const ids = baseIds.filter(id => !w.removedEdges.has(id));
    for (const edge of w.edges.values()) if (edge[side] === nodeId && !ids.includes(edge.id)) ids.push(edge.id);
    return ids;
  };
  return {
    canvasId: base.canvasId,
    canvasName: () => w.name ?? base.canvasName(),
    nameVersion: () => w.nameVersion ?? base.nameVersion(),
    getNode: id => w.removedNodes.has(id) ? undefined : w.nodes.get(id) ?? base.getNode(id),
    getDocument: id => w.removedDocuments.has(id) ? undefined : w.documents.get(id) ?? base.getDocument(id),
    getEdge: id => w.removedEdges.has(id) ? undefined : w.edges.get(id) ?? base.getEdge(id),
    incomingEdgeIds: nodeId => edgeIds(nodeId, "target", base.incomingEdgeIds(nodeId)),
    outgoingEdgeIds: nodeId => edgeIds(nodeId, "source", base.outgoingEdgeIds(nodeId)),
    fieldVersion: (nodeId, field) => w.nodeFieldVersions.get(nodeId)?.get(field) ?? base.fieldVersion(nodeId, field),
    isNodeTombstoned: id => w.removedNodes.has(id) || base.isNodeTombstoned(id),
    isEdgeTombstoned: id => w.removedEdges.has(id) || base.isEdgeTombstoned(id),
    generationClaim: nodeId => base.generationClaim(nodeId),
  };
}

function recordField(w: WriteSet, ref: FieldRef, version: number) {
  w.fieldVersions.set(fieldPath(ref), { ...ref, version });
}

function bumpNodeField(s: EntityReader, w: WriteSet, nodeId: string, field: string): number {
  const version = s.fieldVersion(nodeId, field) + 1;
  let fields = w.nodeFieldVersions.get(nodeId);
  if (!fields) { fields = new Map(); w.nodeFieldVersions.set(nodeId, fields); }
  fields.set(field, version);
  recordField(w, { target: "node", id: nodeId, field }, version);
  return version;
}

/** 只对受影响的图片/视频节点按现有规则解析引用：入边来源与本节点参考字段。 */
function validateReferences(s: EntityReader, nodeIds: Iterable<string>) {
  for (const id of nodeIds) {
    const node = s.getNode(id);
    if (!node || (node.type !== "image" && node.type !== "video")) continue;
    const incoming: ReferenceEdge[] = [];
    const nodeById = new Map<string, ReferenceNode>([[node.id, { id: node.id, type: node.type, data: node.data as Record<string, unknown> }]]);
    for (const edgeId of s.incomingEdgeIds(id)) {
      const edge = s.getEdge(edgeId);
      if (!edge) continue;
      incoming.push({ id: edge.id, source: edge.source, target: edge.target, data: edge.role ? { role: edge.role } : {} });
      const source = s.getNode(edge.source);
      if (source) nodeById.set(source.id, { id: source.id, type: source.type, data: source.data as Record<string, unknown> });
    }
    try {
      resolveCanvasReferences(nodeById.get(id)!, [], [], { nodeById, incomingByNode: new Map([[id, incoming]]) });
    } catch (error) {
      invalid(`节点 ${id} 的参考关系无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function reduceItem(base: EntityReader, w: WriteSet, item: BatchItem, context: ReducerContext) {
  const view = () => shadow(base, w);
  const conflicts: CommandErrorField[] = [];
  const conflict = (ref: FieldRef, message: string) => { conflicts.push({ path: fieldPath(ref), message }); };
  const nodeOrConflict = (nodeId: string, field: string): NodeSummary | undefined => {
    const node = view().getNode(nodeId);
    if (!node) conflict({ target: "node", id: nodeId, field }, view().isNodeTombstoned(nodeId) ? `节点 ${nodeId} 已删除` : `节点 ${nodeId} 不存在`);
    return node;
  };
  const referenceTargets = new Set<string>();
  switch (item.kind) {
    case "move_nodes": {
      for (const move of item.payload.items) {
        const node = nodeOrConflict(move.nodeId, "geometry");
        if (!node) continue;
        const ref = { target: "node" as const, id: node.id, field: "geometry" };
        if (node.geometryVersion !== move.expectedVersion) { conflict(ref, `节点 ${node.id} 的位置已被修改（版本 ${node.geometryVersion}）`); continue; }
        if (!sameGeometry(node.geometry, move.from)) { conflict(ref, `节点 ${node.id} 的起始位置与当前不一致`); continue; }
        if (sameGeometry(node.geometry, move.to)) continue;
        const issues = checkNodeGeometry(node.type, move.to);
        if (issues.length) invalid(issues.map(formatIssue).join("；"));
        const geometryVersion = node.geometryVersion + 1;
        w.nodes.set(node.id, { ...node, geometry: { ...move.to }, geometryVersion, entityVersion: node.entityVersion + 1 });
        recordField(w, ref, geometryVersion);
      }
      break;
    }
    case "patch_nodes": {
      for (const patch of item.payload.items) {
        const node = nodeOrConflict(patch.nodeId, patch.field);
        if (!node) continue;
        const issues = checkNodePatch(node.type, { [patch.field]: patch.value }, "user");
        if (issues.length) invalid(issues.map(formatIssue).join("；"));
        if (patch.field === "content") {
          const doc = node.documentId ? view().getDocument(node.documentId) : undefined;
          if (!doc) { conflict({ target: "node", id: node.id, field: "content" }, `节点 ${node.id} 没有正文文档`); continue; }
          if (doc.version !== patch.expectedVersion) { conflict({ target: "document", id: doc.id, field: "content" }, `节点 ${node.id} 的正文已被修改（版本 ${doc.version}）`); continue; }
          if (doc.content === patch.value) continue;
          const version = doc.version + 1;
          w.documents.set(doc.id, { ...doc, content: patch.value as string, version });
          recordField(w, { target: "document", id: doc.id, field: "content" }, version);
          w.nodes.set(node.id, { ...node, entityVersion: node.entityVersion + 1 });
          continue;
        }
        const current = view().fieldVersion(node.id, patch.field);
        if (current !== patch.expectedVersion) { conflict({ target: "node", id: node.id, field: patch.field }, `节点 ${node.id} 的 ${patch.field} 已被修改（版本 ${current}）`); continue; }
        const previous = patch.field === "pinned" ? node.data.pinned === true : node.data[patch.field];
        if (sameValue(previous, patch.value)) continue;
        const data: Record<string, unknown> = { ...node.data };
        if (patch.field === "pinned" && patch.value === false) delete data.pinned;
        else data[patch.field] = structuredClone(patch.value);
        bumpNodeField(view(), w, node.id, patch.field);
        w.nodes.set(node.id, { ...node, data, entityVersion: node.entityVersion + 1 });
        if (REFERENCE_FIELDS.has(patch.field)) referenceTargets.add(node.id);
      }
      break;
    }
    case "add_nodes": {
      const documents = new Map(item.payload.documents.map(doc => [doc.id, doc]));
      for (const node of item.payload.nodes) {
        const ref = { target: "node" as const, id: node.id, field: "entity" };
        if (view().getNode(node.id)) { conflict(ref, `节点 ${node.id} 已存在`); continue; }
        if (view().isNodeTombstoned(node.id)) { conflict(ref, `节点 ${node.id} 已删除，不能用同一 ID 复活`); continue; }
        if (node.documentId && view().getDocument(node.documentId)) { conflict({ target: "document", id: node.documentId, field: "entity" }, `正文文档 ${node.documentId} 已存在`); continue; }
        w.nodes.set(node.id, structuredClone(node));
        if (node.documentId) w.documents.set(node.documentId, { ...documents.get(node.documentId)! });
        referenceTargets.add(node.id);
      }
      break;
    }
    case "delete_nodes": {
      for (const removal of item.payload.items) {
        const node = nodeOrConflict(removal.nodeId, "entity");
        if (!node) continue;
        if (node.entityVersion !== removal.expectedEntityVersion) { conflict({ target: "node", id: node.id, field: "entity" }, `节点 ${node.id} 已被修改（版本 ${node.entityVersion}）`); continue; }
        if (conflicts.length) continue;
        const current = view();
        for (const edgeId of [...current.incomingEdgeIds(node.id), ...current.outgoingEdgeIds(node.id)]) {
          w.edges.delete(edgeId);
          w.removedEdges.add(edgeId);
        }
        if (node.documentId) { w.documents.delete(node.documentId); w.removedDocuments.add(node.documentId); }
        w.nodes.delete(node.id);
        w.removedNodes.add(node.id);
      }
      break;
    }
    case "edit_edges": {
      for (const removal of item.payload.remove) {
        const edge = view().getEdge(removal.edgeId);
        const ref = { target: "edge" as const, id: removal.edgeId, field: "entity" };
        if (!edge) { conflict(ref, `连线 ${removal.edgeId} 不存在或已删除`); continue; }
        if (edge.version !== removal.expectedVersion) { conflict(ref, `连线 ${removal.edgeId} 已被修改（版本 ${edge.version}）`); continue; }
        w.edges.delete(removal.edgeId);
        w.removedEdges.add(removal.edgeId);
      }
      for (const edge of item.payload.add) {
        const current = view();
        const ref = { target: "edge" as const, id: edge.id, field: "entity" };
        if (current.getEdge(edge.id)) { conflict(ref, `连线 ${edge.id} 已存在`); continue; }
        if (current.isEdgeTombstoned(edge.id)) { conflict(ref, `连线 ${edge.id} 已删除，不能用同一 ID 复活`); continue; }
        const source = current.getNode(edge.source), target = current.getNode(edge.target);
        if (!source || !target) { conflict({ target: "node", id: !source ? edge.source : edge.target, field: "entity" }, `连线 ${edge.id} 的端点不存在或已删除`); continue; }
        const textLink = source.type === "canvasText" || target.type === "canvasText";
        if (!textLink && (!["image", "asset"].includes(source.type) || !["image", "video"].includes(target.type))) invalid("连线端点无效；图片可作为图片或视频参考");
        w.edges.set(edge.id, { ...edge });
        referenceTargets.add(edge.target);
      }
      break;
    }
    case "register_assets": {
      for (const asset of item.payload.assets) {
        const missing = context.assetExists ? !context.assetExists(asset.assetName) : asset.missing ?? false;
        w.assets.set(asset.assetName, { assetName: asset.assetName, kind: asset.kind, createdAt: asset.createdAt, missing });
      }
      break;
    }
    case "apply_generation": {
      const { nodeId, generationId, claimId, assets, patch } = item.payload;
      for (const asset of assets) {
        const missing = context.assetExists ? !context.assetExists(asset.assetName) : asset.missing ?? false;
        w.assets.set(asset.assetName, { assetName: asset.assetName, kind: asset.kind, createdAt: asset.createdAt, missing });
      }
      const node = view().getNode(nodeId);
      // 结果节点的占用记在来源节点上（sourceNodeId），与客户端 claimNodeId 规则一致。
      const claim = view().generationClaim(nodeId) ?? (node && typeof node.data.sourceNodeId === "string" ? view().generationClaim(node.data.sourceNodeId) : undefined);
      // 过期结果：节点已删、已换新任务或 claim 不符时只登记素材（孤儿），不覆盖新任务。
      const mode = item.payload.mode ?? "result";
      if (!node) break;
      if (mode === "start") {
        // 生成开始：必须持有同 ID 的待定占用，且补丁把 generationId 设为该 ID。
        if (!claim || claim.id !== claimId || claim.state !== "pending" || patch.generationId !== generationId) break;
      } else if (mode === "select") {
        // 选择已有候选：只允许主图字段，不碰生成状态。
        if (Object.keys(patch).some(field => field !== "primaryResultId" && field !== "assetName")) invalid("选择候选只能修改 primaryResultId/assetName");
      } else if (node.data.generationId !== generationId || (claim && claim.id !== claimId)) break;
      const issues = checkNodePatch(node.type, patch, "service");
      if (issues.length) invalid(issues.map(formatIssue).join("；"));
      const data: Record<string, unknown> = { ...node.data };
      let changed = false;
      for (const [field, value] of Object.entries(patch)) {
        if (sameValue(data[field], value)) continue;
        data[field] = structuredClone(value);
        bumpNodeField(view(), w, nodeId, field);
        if (REFERENCE_FIELDS.has(field)) referenceTargets.add(nodeId);
        changed = true;
      }
      if (changed) w.nodes.set(nodeId, { ...node, data, entityVersion: node.entityVersion + 1 });
      break;
    }
    case "rename_canvas": {
      const version = view().nameVersion();
      if (version !== item.payload.expectedVersion) { conflict({ target: "canvas", id: base.canvasId, field: "name" }, `画布名称已被修改（版本 ${version}）`); break; }
      if (view().canvasName() === item.payload.name) break;
      w.name = item.payload.name;
      w.nameVersion = version + 1;
      recordField(w, { target: "canvas", id: base.canvasId, field: "name" }, version + 1);
      break;
    }
  }
  if (conflicts.length) {
    throw new ReducerError("field_conflict", conflicts.length === 1 ? conflicts[0]!.message : `${conflicts.length} 个字段已被修改：${conflicts.slice(0, 3).map(c => c.path).join("、")}${conflicts.length > 3 ? " 等" : ""}`, conflicts);
  }
  validateReferences(view(), referenceTargets);
}

/** 失败抛出 ReducerError；成功返回写集（可能为空，表示空变更）。 */
export function reduceCommand(reader: EntityReader, command: CanvasCommand, context: ReducerContext = {}): WriteSet {
  if (reader.canvasId !== command.canvasId) invalid("命令画布与目标仓库不一致");
  const w = emptyWriteSet();
  const items: BatchItem[] = command.kind === "batch" ? command.payload.commands : [{ kind: command.kind, payload: command.payload } as BatchItem];
  for (const item of items) reduceItem(reader, w, item, context);
  return w;
}
