/**
 * Agent 的有界画布查询（P5-03）：不再把整个画布交给模型。每个结果同时受条数、字符与字节限制，
 * 在构造结果时就按 64KiB 截止（不是序列化后剪字符串），超出部分通过 nextCursor 继续。
 *
 * - summarizeCanvas：修订号、类型计数、连线数和最多 50 个节点摘要（不含正文、claims、消息）；
 * - getCanvasNodes：按 ID 最多 50 个，正文合计不超过 32000 字符，超出给出 read_document_chunk 游标；
 * - searchCanvasNodes：名称/提示词规范化后 contains，可按类型、区域过滤；中文单字、双字词直接匹配；
 * - readNeighborhood：按 source/target 取上下游，方向与条数明确，高出度节点也有界；
 * - readDocumentChunk：每段最多 16000 字符，带修订号与下一段位置。
 */
import { decodeCursor, encodeCursor, QueryError, queryHash as hashOf } from "./query-cursor";

export const QUERY_LIMITS = { page: 50, bytes: 64 * 1024, detailChars: 32000, chunkChars: 16000, preview: 80 } as const;

type Node = { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; data: Record<string, unknown> };
type Edge = { id: string; source: string; target: string; data?: Record<string, unknown> };
export type QueryCanvas = { id: string; name?: string; revision: number; nodes: readonly Node[]; edges: readonly Edge[] };

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const preview = (value: string, limit: number = QUERY_LIMITS.preview) => {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
};
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** 节点摘要：不含正文全文与内部字段。 */
export function nodeSummary(node: Node) {
  const content = text(node.data.content), prompt = text(node.data.prompt);
  return {
    id: node.id,
    type: node.type,
    name: text(node.data.name),
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(typeof node.data.status === "string" && node.data.status !== "idle" ? { status: node.data.status } : {}),
    ...(typeof node.data.assetName === "string" && node.data.assetName ? { hasAsset: true } : {}),
    ...(content ? { contentChars: content.length, contentPreview: preview(content) } : {}),
    ...(prompt ? { promptPreview: preview(prompt) } : {}),
  };
}

/** 逐条加入直到条数或字节预算用尽；返回加入的数量。 */
function fill<T>(source: readonly T[], start: number, limit: number, base: object, map: (item: T) => unknown, out: unknown[]): number {
  let used = bytes(base) + 64;
  let i = start;
  for (; i < source.length && out.length < limit; i++) {
    const item = map(source[i]!);
    const size = bytes(item) + 1;
    if (out.length && used + size > QUERY_LIMITS.bytes) break;
    out.push(item);
    used += size;
  }
  return i;
}

const page = (limit: number | undefined) => Math.max(1, Math.min(QUERY_LIMITS.page, Math.floor(limit ?? QUERY_LIMITS.page)));

/** 字符串序列化后的 UTF-8 字节数（含 JSON 转义的粗略加量）。 */
function charBytes(code: number) { return code < 0x20 || code === 0x22 || code === 0x5c ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3; }
function utf8Bytes(value: string) { let n = 0; for (let i = 0; i < value.length; i++) n += charBytes(value.charCodeAt(i)); return n; }
/** 从开头取不超过 maxChars 个 UTF-16 单元、且不超过 maxBytes 字节的长度；不切开代理对。 */
function fitChars(value: string, maxChars: number, maxBytes: number) {
  let used = 0, i = 0;
  for (; i < maxChars; i++) {
    const cost = charBytes(value.charCodeAt(i));
    if (used + cost > maxBytes) break;
    used += cost;
  }
  if (i > 0 && i < value.length && /[\uD800-\uDBFF]/.test(value[i - 1] ?? "")) i--;
  return i;
}
const sorted = (nodes: readonly Node[]) => [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : 1));

export function summarizeCanvas(canvas: QueryCanvas, options: { cursor?: string; limit?: number } = {}) {
  const query = { op: "summary", limit: options.limit ?? null };
  const start = decodeCursor(options.cursor, { canvasId: canvas.id, query, revision: canvas.revision });
  const counts: Record<string, number> = {};
  for (const node of canvas.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  const base = { canvasId: canvas.id, name: canvas.name ?? "", revision: canvas.revision, totalNodes: canvas.nodes.length, totalEdges: canvas.edges.length, counts };
  const nodes: unknown[] = [];
  const order = sorted(canvas.nodes);
  const next = fill(order, start, page(options.limit), base, nodeSummary, nodes);
  return { ...base, nodes, ...(next < order.length ? { nextCursor: encodeCursor({ c: canvas.id, q: hashOf(query), r: canvas.revision, k: next }), truncated: true } : {}) };
}

export function getCanvasNodes(canvas: QueryCanvas, ids: readonly string[]) {
  if (ids.length > QUERY_LIMITS.page) throw new QueryError("invalid_request", `一次最多 ${QUERY_LIMITS.page} 个节点`);
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  let budget = QUERY_LIMITS.detailChars;
  const out: unknown[] = [], missing: string[] = [];
  let used = 200;
  // 每个节点的摘要部分先预留，正文按剩余字节计入（中文一个字 3 字节，32000 字可能超过 64KiB）。
  const reserve = () => (ids.length - out.length) * 600;
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) { missing.push(id); continue; }
    const content = text(node.data.content), prompt = text(node.data.prompt);
    const room = Math.max(0, QUERY_LIMITS.bytes - used - reserve());
    const take = fitChars(content, Math.min(content.length, budget), room);
    budget -= take;
    const promptTake = fitChars(prompt, Math.min(prompt.length, budget, 4000), Math.max(0, room - utf8Bytes(content.slice(0, take))));
    budget -= promptTake;
    const incoming = canvas.edges.filter(edge => edge.target === id).length, outgoing = canvas.edges.filter(edge => edge.source === id).length;
    const item = {
      ...nodeSummary(node),
      ...(content ? { content: content.slice(0, take), ...(take < content.length ? { contentTruncated: true, contentCursor: chunkCursor(canvas, id, take) } : {}) } : {}),
      ...(prompt ? { prompt: prompt.slice(0, promptTake), ...(promptTake < prompt.length ? { promptTruncated: true } : {}) } : {}),
      edges: { incoming, outgoing },
    };
    const size = bytes(item);
    if (out.length && used + size > QUERY_LIMITS.bytes) { missing.push(id); continue; }
    used += size;
    out.push(item);
  }
  return { canvasId: canvas.id, revision: canvas.revision, nodes: out, ...(missing.length ? { notReturned: missing } : {}) };
}

export function searchCanvasNodes(canvas: QueryCanvas, options: { query?: string; types?: string[]; region?: { x: number; y: number; width: number; height: number }; limit?: number; cursor?: string }) {
  const term = normalize(options.query ?? "");
  const query = { op: "search", term, types: options.types ?? null, region: options.region ?? null, limit: options.limit ?? null };
  const start = decodeCursor(options.cursor, { canvasId: canvas.id, query, revision: canvas.revision });
  const region = options.region;
  const matches = sorted(canvas.nodes).filter(node => {
    if (options.types?.length && !options.types.includes(node.type)) return false;
    if (region && !(node.position.x < region.x + region.width && node.position.x + (node.width ?? 280) > region.x && node.position.y < region.y + region.height && node.position.y + (node.height ?? 240) > region.y)) return false;
    if (!term) return true;
    // 字面量 contains：查询文本只作数据比较，不拼进任何表达式。
    return normalize(text(node.data.name)).includes(term) || normalize(text(node.data.prompt)).includes(term);
  });
  const base = { canvasId: canvas.id, revision: canvas.revision, total: matches.length };
  const nodes: unknown[] = [];
  const next = fill(matches, start, page(options.limit), base, nodeSummary, nodes);
  return { ...base, nodes, ...(next < matches.length ? { nextCursor: encodeCursor({ c: canvas.id, q: hashOf(query), r: canvas.revision, k: next }), truncated: true } : {}) };
}

export function readNeighborhood(canvas: QueryCanvas, options: { nodeId: string; direction?: "upstream" | "downstream" | "both"; limit?: number; cursor?: string }) {
  const center = canvas.nodes.find(node => node.id === options.nodeId);
  if (!center) throw new QueryError("not_found", "当前画布中没有该节点");
  const direction = options.direction ?? "both";
  const query = { op: "neighborhood", nodeId: options.nodeId, direction, limit: options.limit ?? null };
  const start = decodeCursor(options.cursor, { canvasId: canvas.id, query, revision: canvas.revision });
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const links = canvas.edges
    .filter(edge => (direction !== "downstream" && edge.target === center.id) || (direction !== "upstream" && edge.source === center.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const base = { canvasId: canvas.id, revision: canvas.revision, node: nodeSummary(center), total: links.length };
  const items: unknown[] = [];
  const next = fill(links, start, page(options.limit), base, edge => {
    const upstream = edge.target === center.id;
    const other = byId.get(upstream ? edge.source : edge.target);
    return { edgeId: edge.id, direction: upstream ? "upstream" : "downstream", ...(typeof edge.data?.role === "string" ? { role: edge.data.role } : {}), node: other ? nodeSummary(other) : { id: upstream ? edge.source : edge.target, missing: true } };
  }, items);
  return { ...base, neighbors: items, ...(next < links.length ? { nextCursor: encodeCursor({ c: canvas.id, q: hashOf(query), r: canvas.revision, k: next }), truncated: true } : {}) };
}

function chunkCursor(canvas: QueryCanvas, nodeId: string, start: number) {
  return encodeCursor({ c: canvas.id, q: hashOf({ op: "chunk", nodeId }), r: canvas.revision, k: start });
}

export function readDocumentChunk(canvas: QueryCanvas, options: { nodeId: string; cursor?: string }) {
  const node = canvas.nodes.find(item => item.id === options.nodeId);
  if (!node) throw new QueryError("not_found", "当前画布中没有该节点");
  const content = text(node.data.content);
  const start = decodeCursor(options.cursor, { canvasId: canvas.id, query: { op: "chunk", nodeId: options.nodeId }, revision: canvas.revision });
  // 不切开代理对：按 UTF-16 截取后若末尾是高位代理，少取一个单元。
  let end = Math.min(content.length, start + QUERY_LIMITS.chunkChars);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end--;
  return {
    canvasId: canvas.id, nodeId: node.id, documentVersion: canvas.revision, start, end, totalChars: content.length,
    text: content.slice(start, end),
    ...(end < content.length ? { nextCursor: chunkCursor(canvas, node.id, end) } : {}),
  };
}
