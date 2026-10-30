/**
 * v1 CanvasDoc 与实体结构之间的显式转换（contracts.md C1）。
 * - fromCanvasDoc：拆出正文（DocumentRecord）与几何；未知类型/字段保留并写入 issues，不静默抹除。
 * - toCanvasDoc：仅供兼容导出（旧 API/整文件写入）；selected/dragging/resizing/measured 不进入正式实体。
 * 转换须在 cleanCanvas 之后调用。浏览器与服务端均可导入。
 */
import { checkNodeData, getNodeType, NODE_REGISTRY } from "./node-registry";
import type { CanvasStoreSeed, StoreSnapshot } from "./store";
import type { DocumentRecord, EdgeRecord, EdgeRole, LegacyCanvasDocV1, LegacyConversionIssue, NodeSummary } from "./types";

/** 旧文档里除实体数组外的全部字段，原样保留以便兼容导出；revision/name 以 Store 为准。 */
export type LegacyCanvasMeta = {
  doc: Omit<LegacyCanvasDocV1, "nodes" | "edges">;
  /** 原文档中带显式 width/height 的节点；未带的（媒体节点）导出时不写尺寸。 */
  explicitSizeNodeIds: string[];
};

export type LegacyConversion = {
  seed: CanvasStoreSeed;
  meta: LegacyCanvasMeta;
  issues: LegacyConversionIssue[];
  /** nodeId → documentId；调用方应保存并在下次转换传回，保证正文 ID 稳定。 */
  documentIds: Map<string, string>;
};

const VIEW_FIELDS = new Set(["selected", "dragging", "resizing", "measured"]);
const NODE_FIELDS = new Set(["id", "type", "position", "width", "height", "draggable", "data", ...VIEW_FIELDS]);
const EDGE_FIELDS = new Set(["id", "source", "target", "type", "data", "selected"]);
const ROLES = new Set<EdgeRole>(["first", "last", "reference"]);
const MAX_ID = 128;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 32 位 FNV-1a，仅用于把超长节点 ID 确定性地压成文档 ID；不是安全哈希。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function deriveDocumentId(nodeId: string): string {
  const direct = `doc_${nodeId}`;
  return direct.length <= MAX_ID ? direct : `doc_${nodeId.slice(0, 100)}_${fnv1a(nodeId)}`;
}

export type LegacyNodeConversion = {
  summary: NodeSummary;
  /** 仅 canvasText：拆出的正文。 */
  content: string | null;
  explicitSize: boolean;
  issues: LegacyConversionIssue[];
};

/**
 * 单个旧节点 → NodeSummary（版本为 0，调用方可覆盖）。几何无效时返回 null 并写入 issues。
 * JSON 兼容仓库按需逐个转换，避免为一条命令转换全图。
 */
export function convertLegacyNode(raw: Record<string, unknown>, canvasId: string, documentId?: string): LegacyNodeConversion | { summary: null; issues: LegacyConversionIssue[] } {
  const issues: LegacyConversionIssue[] = [];
  const id = String(raw.id);
  const report = (code: LegacyConversionIssue["code"], detail: string) => issues.push({ entity: "node", id, code, detail });
  const type = typeof raw.type === "string" ? raw.type : "";
  const entry = getNodeType(type);
  if (!entry) report("unknown_type", `未知节点类型：${type || "(空)"}`);
  for (const key of Object.keys(raw)) if (!NODE_FIELDS.has(key)) report("unknown_field", `节点顶层字段 ${key} 未登记，导出时不保留`);
  const position = isRecord(raw.position) ? raw.position : {};
  const measured = isRecord(raw.measured) ? raw.measured : {};
  const fallback = entry?.defaultSize ?? NODE_REGISTRY.image.defaultSize;
  const explicitSize = finite(raw.width) || finite(raw.height);
  const geometry = {
    x: position.x as number,
    y: position.y as number,
    width: finite(raw.width) ? raw.width : finite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
    height: finite(raw.height) ? raw.height : finite(measured.height) && measured.height > 0 ? measured.height : fallback.height,
  };
  if (![geometry.x, geometry.y].every(finite) || geometry.width <= 0 || geometry.height <= 0) {
    report("invalid_geometry", "节点位置或尺寸无效，未导入");
    return { summary: null, issues };
  }
  const sourceData = isRecord(raw.data) ? raw.data : {};
  if (!isRecord(raw.data)) report("invalid_value", "节点 data 不是对象");
  const { content, ...rest } = sourceData;
  const hasDocument = entry?.hasDocument ?? false;
  const data: Record<string, unknown> = hasDocument ? rest : { ...sourceData };
  if (raw.draggable === false) data.pinned = true;
  if (hasDocument && content !== undefined && typeof content !== "string") report("invalid_value", "正文不是字符串，已按空正文导入");
  if (entry) for (const issue of checkNodeData(type, data)) report(issue.message.includes("未登记") ? "unknown_field" : "invalid_value", issue.message);
  const summary: NodeSummary = {
    id, canvasId, type, schemaVersion: entry?.schemaVersion ?? 1, geometry, entityVersion: 0, geometryVersion: 0,
    documentId: hasDocument ? documentId ?? deriveDocumentId(id) : null, data,
  };
  return { summary, content: hasDocument ? (typeof content === "string" ? content : "") : null, explicitSize, issues };
}

/**
 * NodeSummary → 旧节点。original 存在时保留其视图字段（measured 等），只覆盖业务字段；
 * 媒体节点没有显式尺寸且尺寸未变时不写 width/height。
 */
export function exportLegacyNode(node: NodeSummary, options: { content?: string | null; explicitSize: boolean; original?: Record<string, unknown> }): Record<string, unknown> {
  const { pinned, ...data } = node.data as Record<string, unknown>;
  const out: Record<string, unknown> = options.original ? { ...options.original } : {};
  out.id = node.id;
  out.type = node.type;
  out.position = { x: node.geometry.x, y: node.geometry.y };
  if (options.explicitSize || getNodeType(node.type)?.hasDocument) { out.width = node.geometry.width; out.height = node.geometry.height; }
  else { delete out.width; delete out.height; }
  if (pinned === true) out.draggable = false;
  else delete out.draggable;
  out.data = node.documentId ? { ...structuredClone(data), content: options.content ?? "" } : structuredClone(data);
  return out;
}

export function fromCanvasDoc(doc: LegacyCanvasDocV1, options: { documentIds?: ReadonlyMap<string, string> } = {}): LegacyConversion {
  const issues: LegacyConversionIssue[] = [];
  const nodes: NodeSummary[] = [];
  const documents: DocumentRecord[] = [];
  const edges: EdgeRecord[] = [];
  const documentIds = new Map<string, string>();
  const explicitSizeNodeIds: string[] = [];
  const seen = new Set<string>();
  const report = (entity: LegacyConversionIssue["entity"], id: string, code: LegacyConversionIssue["code"], detail: string) => issues.push({ entity, id, code, detail });

  for (const raw of doc.nodes) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) { report("node", String(isRecord(raw) ? raw.id : ""), "invalid_value", "节点缺少 ID"); continue; }
    const id = raw.id;
    if (seen.has(id)) { report("node", id, "duplicate_id", "节点 ID 重复，保留首个"); continue; }
    seen.add(id);
    const hasDocument = getNodeType(typeof raw.type === "string" ? raw.type : "")?.hasDocument ?? false;
    const documentId = hasDocument ? options.documentIds?.get(id) ?? deriveDocumentId(id) : undefined;
    const converted = convertLegacyNode(raw, doc.id, documentId);
    issues.push(...converted.issues);
    if (!converted.summary) continue;
    const { summary } = converted as LegacyNodeConversion;
    if (summary.documentId) {
      documentIds.set(id, summary.documentId);
      documents.push({ id: summary.documentId, nodeId: id, content: (converted as LegacyNodeConversion).content ?? "", version: 0 });
    }
    if ((converted as LegacyNodeConversion).explicitSize) explicitSizeNodeIds.push(id);
    nodes.push(summary);
  }

  const edgeSeen = new Set<string>();
  for (const raw of doc.edges) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) { report("edge", String(isRecord(raw) ? raw.id : ""), "invalid_value", "连线缺少 ID"); continue; }
    const id = raw.id;
    if (edgeSeen.has(id)) { report("edge", id, "duplicate_id", "连线 ID 重复，保留首个"); continue; }
    edgeSeen.add(id);
    const source = typeof raw.source === "string" ? raw.source : "";
    const target = typeof raw.target === "string" ? raw.target : "";
    if (!seen.has(source) || !seen.has(target) || source === target) { report("edge", id, "dangling_edge", "连线端点不存在或指向自身，未导入"); continue; }
    for (const key of Object.keys(raw)) if (!EDGE_FIELDS.has(key)) report("edge", id, "unknown_field", `连线字段 ${key} 未登记，导出时不保留`);
    const data = isRecord(raw.data) ? raw.data : {};
    let role: EdgeRole | null = null;
    for (const [key, value] of Object.entries(data)) {
      if (key !== "role") { report("edge", id, "unknown_field", `连线 data.${key} 未登记，导出时不保留`); continue; }
      if (ROLES.has(value as EdgeRole)) role = value as EdgeRole;
      else report("edge", id, "invalid_value", "连线角色无效，按无角色导入");
    }
    edges.push({ id, canvasId: doc.id, source, target, role, version: 0 });
  }

  const { nodes: _nodes, edges: _edges, ...rest } = doc;
  return {
    seed: { canvasId: doc.id, revision: doc.revision, name: doc.name, nodes, documents, edges },
    meta: { doc: structuredClone(rest), explicitSizeNodeIds },
    issues,
    documentIds,
  };
}

/** 兼容导出：只写业务字段；正文回填到 canvasText 的 data.content。 */
export function toCanvasDoc(snapshot: StoreSnapshot, meta: LegacyCanvasMeta): LegacyCanvasDocV1 {
  const explicit = new Set(meta.explicitSizeNodeIds);
  const contentByDocument = new Map(snapshot.documents.map(record => [record.id, record.content]));
  const nodes = snapshot.nodes.map(node => exportLegacyNode(node, {
    explicitSize: explicit.has(node.id),
    content: node.documentId ? contentByDocument.get(node.documentId) ?? "" : null,
  }));
  const edges = snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: "scissor", data: edge.role ? { role: edge.role } : {} }));
  return { ...structuredClone(meta.doc), id: snapshot.canvasId, name: snapshot.name, revision: snapshot.revision, nodes, edges };
}
