/**
 * 领域命令严格解析（contracts.md C2）。浏览器与服务端共用，不导入 node:crypto：
 * 命令 hash 由服务端 adapter 对 canonicalCommand() 的输出计算（P2-03）。
 */
import { z } from "zod";
import type { CanvasCommand, CommandErrorField } from "./types";
import {
  CANVAS_ID, GEOMETRY_LIMITS, NODE_REGISTRY, TEXT_LIMITS,
  assetName, checkNodeData, checkNodeGeometry, checkPatchFieldAnyType, entityId, formatIssue, getNodeType,
  type RegistryIssue,
} from "./node-registry";

export const LIMITS = {
  moveItems: 10_000,
  patchItems: 1_000,
  addNodes: 1_000,
  deleteItems: 10_000,
  edgeAdd: 1_000,
  edgeRemove: 10_000,
  assets: 1_000,
  batchCommands: 100,
  generationPatchFields: 64,
  content: TEXT_LIMITS.content,
  prompt: TEXT_LIMITS.prompt,
  canvasName: 160,
  /** 服务端须流式计数请求体；不能只信 Content-Length（P2-03 路由负责）。 */
  requestBytes: 4 * 1024 * 1024,
  jsonDepth: 64,
} as const;

/** 统一的命令校验错误：400，或字节/正文/prompt 超限时 413。 */
export class CommandValidationError extends Error {
  readonly code = "invalid_command" as const;
  readonly status: 400 | 413;
  readonly fields: CommandErrorField[];
  constructor(message: string, fields: CommandErrorField[] = [], status: 400 | 413 = 400) {
    super(message);
    this.name = "CommandValidationError";
    this.fields = fields;
    this.status = status;
  }
  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.fields.length ? { fields: this.fields } : {}) } };
  }
}

// ---------------------------------------------------------------- 通用 JSON 预检

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const pathText = (path: (string | number)[]) => path.length ? path.join(".") : "(root)";

/** 只接受 JSON 可表示的数据，返回脱离调用方引用的深拷贝。 */
function preflight(value: unknown, path: (string | number)[] = [], ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CommandValidationError(`命令无效：${pathText(path)} 不是有限数字`, [{ path: pathText(path), message: "必须是有限数字" }]);
    return value;
  }
  if (typeof value !== "object") throw new CommandValidationError(`命令无效：${pathText(path)} 含不可序列化的 ${typeof value}`, [{ path: pathText(path), message: `不允许 ${typeof value}` }]);
  if (ancestors.has(value)) throw new CommandValidationError(`命令无效：${pathText(path)} 存在循环引用`, [{ path: pathText(path), message: "循环引用" }]);
  if (path.length > LIMITS.jsonDepth) throw new CommandValidationError(`命令无效：嵌套超过 ${LIMITS.jsonDepth} 层`, [{ path: pathText(path), message: "嵌套过深" }]);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => preflight(item, [...path, index], ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CommandValidationError(`命令无效：${pathText(path)} 不是普通对象`, [{ path: pathText(path), message: "仅允许普通对象" }]);
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new CommandValidationError(`命令无效：禁止的属性名 ${key}`, [{ path: pathText([...path, key]), message: `禁止的属性名 ${key}` }]);
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new CommandValidationError(`命令无效：${pathText([...path, key])} 为 undefined`, [{ path: pathText([...path, key]), message: "不允许 undefined" }]);
      Object.defineProperty(copy, key, { value: preflight(child, [...path, key], ancestors), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

// ---------------------------------------------------------------- 基础 schema

const version = () => z.int().min(0);
const initialVersion = () => z.literal(0, { error: "新实体版本必须从 0 开始" });
const coordinate = () => z.number().min(-GEOMETRY_LIMITS.coordinate).max(GEOMETRY_LIMITS.coordinate);
const size = () => z.number().gt(0).max(GEOMETRY_LIMITS.size);
const geometry = () => z.strictObject({ x: coordinate(), y: coordinate(), width: size(), height: size() });
const canvasId = () => z.string().regex(CANVAS_ID, { error: "画布 ID 格式无效" });
const fieldName = () => z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, { error: "字段名必须是注册表中的单层字段" });
const isoDate = () => z.iso.datetime({ offset: true });

type Ctx = z.RefinementCtx;
const report = (ctx: Ctx, issues: RegistryIssue[], prefix: (string | number)[] = []) => {
  for (const issue of issues) ctx.addIssue({ code: "custom", message: issue.message, path: [...prefix, ...issue.path], params: issue.tooLarge ? { tooLarge: true } : undefined });
};
const unique = <T>(ctx: Ctx, items: readonly T[], key: (item: T) => string, label: string, path: (string | number)[]) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) ctx.addIssue({ code: "custom", message: `${label} 在同一组内重复：${value}`, path: [...path, index] });
    seen.add(value);
  });
};

const nodeSummary = () => z.strictObject({
  id: entityId(),
  canvasId: canvasId(),
  type: z.string().min(1).max(64),
  schemaVersion: z.int(),
  geometry: geometry(),
  entityVersion: initialVersion(),
  geometryVersion: initialVersion(),
  documentId: z.union([entityId(), z.null()]),
  data: z.record(z.string(), z.unknown()),
}).superRefine((node, ctx) => {
  const entry = getNodeType(node.type);
  if (!entry) { ctx.addIssue({ code: "custom", message: `未知节点类型：${node.type}`, path: ["type"] }); return; }
  if (node.schemaVersion !== entry.schemaVersion) ctx.addIssue({ code: "custom", message: `${node.type} 不支持 schemaVersion ${node.schemaVersion}`, path: ["schemaVersion"] });
  report(ctx, checkNodeData(node.type, node.data), ["data"]);
  report(ctx, checkNodeGeometry(node.type, node.geometry), ["geometry"]);
  if (entry.hasDocument && node.documentId === null) ctx.addIssue({ code: "custom", message: `${node.type} 必须关联正文文档 documentId`, path: ["documentId"] });
  if (!entry.hasDocument && node.documentId !== null) ctx.addIssue({ code: "custom", message: `${node.type} 不能关联正文文档 documentId`, path: ["documentId"] });
});

const documentRecord = () => z.strictObject({
  id: entityId(),
  nodeId: entityId(),
  content: z.string().max(LIMITS.content, { error: `正文超过 ${LIMITS.content} 字符上限` }),
  version: initialVersion(),
});

const edgeRecord = () => z.strictObject({
  id: entityId(),
  canvasId: canvasId(),
  source: entityId(),
  target: entityId(),
  role: z.union([z.enum(["first", "last", "reference"]), z.null()]),
  version: initialVersion(),
}).refine(edge => edge.source !== edge.target, { error: "连线端点不能指向自身", path: ["target"] });

const assetRegistration = () => z.strictObject({
  assetName: assetName(),
  kind: z.enum(["image", "video"]),
  createdAt: isoDate(),
  missing: z.boolean().optional(),
});

// ---------------------------------------------------------------- 各 kind 的 payload

const payloads = {
  move_nodes: z.strictObject({
    items: z.array(z.strictObject({ nodeId: entityId(), expectedVersion: version(), from: geometry(), to: geometry() })).min(1).max(LIMITS.moveItems),
  }).superRefine((p, ctx) => unique(ctx, p.items, item => item.nodeId, "nodeId", ["items"])),

  patch_nodes: z.strictObject({
    items: z.array(z.strictObject({ nodeId: entityId(), field: fieldName(), expectedVersion: version(), value: z.unknown() })).min(1).max(LIMITS.patchItems),
  }).superRefine((p, ctx) => {
    unique(ctx, p.items, item => `${item.nodeId}/${item.field}`, "nodeId+field", ["items"]);
    p.items.forEach((item, index) => report(ctx, checkPatchFieldAnyType(item.field, item.value, "user", ["items", index, "value"])));
  }),

  add_nodes: z.strictObject({
    nodes: z.array(nodeSummary()).min(1).max(LIMITS.addNodes),
    documents: z.array(documentRecord()).max(LIMITS.addNodes),
  }).superRefine((p, ctx) => {
    unique(ctx, p.nodes, node => node.id, "节点 ID", ["nodes"]);
    unique(ctx, p.documents, doc => doc.id, "文档 ID", ["documents"]);
    const documents = new Map(p.documents.map(doc => [doc.id, doc]));
    const claimed = new Set<string>();
    p.nodes.forEach((node, index) => {
      if (node.documentId === null) return;
      const doc = documents.get(node.documentId);
      if (!doc || doc.nodeId !== node.id) ctx.addIssue({ code: "custom", message: `节点 ${node.id} 的正文文档 ${node.documentId} 缺失或归属不符`, path: ["nodes", index, "documentId"] });
      claimed.add(node.documentId);
    });
    p.documents.forEach((doc, index) => {
      if (!claimed.has(doc.id)) ctx.addIssue({ code: "custom", message: `文档 ${doc.id} 不属于本次新增的任何节点`, path: ["documents", index] });
    });
  }),

  delete_nodes: z.strictObject({
    items: z.array(z.strictObject({ nodeId: entityId(), expectedEntityVersion: version() })).min(1).max(LIMITS.deleteItems),
  }).superRefine((p, ctx) => unique(ctx, p.items, item => item.nodeId, "nodeId", ["items"])),

  edit_edges: z.strictObject({
    add: z.array(edgeRecord()).max(LIMITS.edgeAdd),
    remove: z.array(z.strictObject({ edgeId: entityId(), expectedVersion: version() })).max(LIMITS.edgeRemove),
  }).superRefine((p, ctx) => {
    if (!p.add.length && !p.remove.length) ctx.addIssue({ code: "custom", message: "edit_edges 至少包含一项增删", path: [] });
    unique(ctx, [...p.add.map(edge => edge.id), ...p.remove.map(item => item.edgeId)], id => id, "连线 ID", ["add"]);
  }),

  register_assets: z.strictObject({
    assets: z.array(assetRegistration()).min(1).max(LIMITS.assets),
  }).superRefine((p, ctx) => unique(ctx, p.assets, item => item.assetName, "assetName", ["assets"])),

  apply_generation: z.strictObject({
    nodeId: entityId(),
    generationId: entityId(),
    claimId: entityId(),
    assets: z.array(assetRegistration()).max(16),
    patch: z.record(fieldName(), z.unknown()),
    /** P2-08：result（默认）= 生成结果；start = 已占用的生成开始；select = 用户选择已有候选；fail = 客户端报告请求失败。 */
    mode: z.enum(["result", "start", "select", "fail"]).optional(),
  }).superRefine((p, ctx) => {
    const fields = Object.keys(p.patch);
    if (!fields.length || fields.length > LIMITS.generationPatchFields) ctx.addIssue({ code: "custom", message: `生成补丁须含 1..${LIMITS.generationPatchFields} 个字段`, path: ["patch"] });
    for (const field of fields) report(ctx, checkPatchFieldAnyType(field, p.patch[field], "service", ["patch", field]));
  }),

  rename_canvas: z.strictObject({
    expectedVersion: version(),
    name: z.string().max(LIMITS.canvasName).refine(name => name.trim().length > 0, { error: "画布名称不能为空" }),
  }),
} as const;

type SimpleKind = keyof typeof payloads;
const SIMPLE_KINDS = Object.keys(payloads) as SimpleKind[];

const batchItem = z.discriminatedUnion("kind", SIMPLE_KINDS.map(kind => z.strictObject({ kind: z.literal(kind), payload: payloads[kind] })) as unknown as [z.ZodObject, ...z.ZodObject[]]);
const batchPayload = z.strictObject({ commands: z.array(batchItem).min(1).max(LIMITS.batchCommands) });

const envelope = {
  schemaVersion: z.literal(1, { error: "仅支持命令 schemaVersion 1" }),
  commandId: z.uuid({ error: "commandId 必须是 UUID" }),
  actorId: entityId(),
  actorSeq: z.int().min(1),
  canvasId: canvasId(),
  storageEpoch: entityId(),
  baseRevision: version(),
};

const commandSchema = z.discriminatedUnion("kind", [
  ...SIMPLE_KINDS.map(kind => z.strictObject({ ...envelope, kind: z.literal(kind), payload: payloads[kind] })),
  z.strictObject({ ...envelope, kind: z.literal("batch"), payload: batchPayload }),
] as unknown as [z.ZodObject, ...z.ZodObject[]]).superRefine((command, ctx) => {
  // 新实体必须属于命令所在画布。
  const check = (kind: string, payload: unknown, prefix: (string | number)[]) => {
    if (kind === "add_nodes") (payload as { nodes: { canvasId: string }[] }).nodes.forEach((node, index) => {
      if (node.canvasId !== command.canvasId) ctx.addIssue({ code: "custom", message: "新增节点不属于命令所在画布", path: [...prefix, "nodes", index, "canvasId"] });
    });
    if (kind === "edit_edges") (payload as { add: { canvasId: string }[] }).add.forEach((edge, index) => {
      if (edge.canvasId !== command.canvasId) ctx.addIssue({ code: "custom", message: "新增连线不属于命令所在画布", path: [...prefix, "add", index, "canvasId"] });
    });
  };
  const kind = command.kind as string;
  if (kind === "batch") (command.payload as { commands: { kind: string; payload: unknown }[] }).commands.forEach((item, index) => check(item.kind, item.payload, ["payload", "commands", index, "payload"]));
  else check(kind, command.payload, ["payload"]);
});

// ---------------------------------------------------------------- 公开接口

function toValidationError(error: z.ZodError): CommandValidationError {
  const fields: CommandErrorField[] = error.issues.map(issue => ({ path: pathText(issue.path.map(key => (typeof key === "symbol" ? String(key) : key))), message: issue.message }));
  const tooLarge = error.issues.some(issue =>
    (issue.code === "custom" && (issue as { params?: { tooLarge?: boolean } }).params?.tooLarge === true)
    || (issue.code === "too_big" && issue.origin === "string" && Number(issue.maximum) >= LIMITS.prompt));
  const head = fields.slice(0, 3).map(field => formatIssue({ path: [field.path], message: field.message })).join("；");
  return new CommandValidationError(`命令无效：${head}${fields.length > 3 ? ` 等 ${fields.length} 处` : ""}`, fields, tooLarge ? 413 : 400);
}

/** 严格解析一条命令；任何不合法输入抛出 CommandValidationError，返回值不共享调用方引用。 */
export function parseCommand(input: unknown): CanvasCommand {
  const data = preflight(input);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CommandValidationError("命令无效：命令必须是对象", [{ path: "(root)", message: "必须是对象" }]);
  const record = data as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new CommandValidationError(`命令无效：不支持的命令 schemaVersion ${String(record.schemaVersion)}，仅支持 1`, [{ path: "schemaVersion", message: "仅支持 1" }]);
  if (record.kind === "batch") {
    const commands = (record.payload as { commands?: unknown } | undefined)?.commands;
    if (Array.isArray(commands)) commands.forEach((item, index) => {
      if (item && typeof item === "object" && (item as { kind?: unknown }).kind === "batch") throw new CommandValidationError("命令无效：batch 不允许嵌套 batch", [{ path: `payload.commands.${index}.kind`, message: "batch 不允许嵌套" }]);
    });
  }
  const parsed = commandSchema.safeParse(data);
  if (!parsed.success) throw toValidationError(parsed.error);
  return parsed.data as unknown as CanvasCommand;
}

/** 内部命令（apply_generation、迁移）不向通用 HTTP 客户端开放。 */
export function assertClientCommand(command: CanvasCommand): void {
  const kinds = command.kind === "batch" ? command.payload.commands.map(item => item.kind) : [command.kind];
  if (kinds.includes("apply_generation")) throw new CommandValidationError("命令无效：apply_generation 是服务端内部命令", [{ path: "kind", message: "客户端不可提交" }]);
}

/** 规范化 JSON：递归按键排序对象，数组保持原顺序；只接受有限数字与 JSON 值。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson 不接受非有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => {
      if (record[key] === undefined) throw new TypeError(`canonicalJson 不接受 undefined：${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError(`canonicalJson 不接受 ${typeof value}`);
}

/** 命令 hash 的输入；相同语义不同键序得到相同字符串。 */
export function canonicalCommand(command: CanvasCommand): string {
  return canonicalJson(command);
}

/** 测试与执行器可用：注册表中已登记的节点类型。 */
export const COMMAND_NODE_TYPES = Object.keys(NODE_REGISTRY);
