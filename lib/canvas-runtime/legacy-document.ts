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
    const type = typeof raw.type === "string" ? raw.type : "";
    const entry = getNodeType(type);
    if (!entry) report("node", id, "unknown_type", `未知节点类型：${type || "(空)"}`);
    for (const key of Object.keys(raw)) if (!NODE_FIELDS.has(key)) report("node", id, "unknown_field", `节点顶层字段 ${key} 未登记，导出时不保留`);

    const position = isRecord(raw.position) ? raw.position : {};
    const measured = isRecord(raw.measured) ? raw.measured : {};
    const fallback = entry?.defaultSize ?? NODE_REGISTRY.image.defaultSize;
    const explicit = finite(raw.width) || finite(raw.height);
    const geometry = {
      x: position.x as number,
      y: position.y as number,
      width: finite(raw.width) ? raw.width : finite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
      height: finite(raw.height) ? raw.height : finite(measured.height) && measured.height > 0 ? measured.height : fallback.height,
    };
    if (![geometry.x, geometry.y].every(finite) || geometry.width <= 0 || geometry.height <= 0) { report("node", id, "invalid_geometry", "节点位置或尺寸无效，未导入"); continue; }
    if (explicit) explicitSizeNodeIds.push(id);

    const sourceData = isRecord(raw.data) ? raw.data : {};
    if (!isRecord(raw.data)) report("node", id, "invalid_value", "节点 data 不是对象");
    const { content, ...rest } = sourceData;
    const hasDocument = entry?.hasDocument ?? false;
    const data: Record<string, unknown> = hasDocument ? rest : { ...sourceData };
    if (raw.draggable === false) data.pinned = true;
    let documentId: string | null = null;
    if (hasDocument) {
      documentId = options.documentIds?.get(id) ?? deriveDocumentId(id);
      documentIds.set(id, documentId);
      documents.push({ id: documentId, nodeId: id, content: typeof content === "string" ? content : "", version: 0 });
      if (content !== undefined && typeof content !== "string") report("node", id, "invalid_value", "正文不是字符串，已按空正文导入");
    }
    if (entry) {
      for (const issue of checkNodeData(type, data)) {
        const unknown = issue.message.includes("未登记");
        report("node", id, unknown ? "unknown_field" : "invalid_value", issue.message);
      }
    }
    nodes.push({ id, canvasId: doc.id, type, schemaVersion: entry?.schemaVersion ?? 1, geometry, entityVersion: 0, geometryVersion: 0, documentId, data });
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
  const nodes = snapshot.nodes.map(node => {
    const { pinned, ...data } = node.data as Record<string, unknown>;
    const out: Record<string, unknown> = {
      id: node.id,
      type: node.type,
      position: { x: node.geometry.x, y: node.geometry.y },
    };
    if (explicit.has(node.id) || getNodeType(node.type)?.hasDocument) { out.width = node.geometry.width; out.height = node.geometry.height; }
    if (pinned === true) out.draggable = false;
    out.data = node.documentId ? { ...structuredClone(data), content: contentByDocument.get(node.documentId) ?? "" } : structuredClone(data);
    return out;
  });
  const edges = snapshot.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: "scissor", data: edge.role ? { role: edge.role } : {} }));
  return { ...structuredClone(meta.doc), id: snapshot.canvasId, name: snapshot.name, revision: snapshot.revision, nodes, edges };
}
