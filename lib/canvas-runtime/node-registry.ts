/**
 * 节点注册表（contracts.md C1）：固定支持 image/video/asset/canvasText。
 * 字段白名单取自四类现有 Node data 类型与代码中的实际读写，并按归属分类：
 * - user：用户可通过 patch_nodes 修改；
 * - service：生成/任务状态，只能由服务端命令（add_nodes 创建或 apply_generation）写入；
 * - legacy：Agent addNodes 历史写入的跨类型默认值，新增/导入时接受，不可 patch。
 * 未知类型与未登记字段一律报告，不静默改型或丢弃。浏览器与服务端均可导入。
 */
import { z } from "zod";
import type { FieldAccess, Geometry, NodeType } from "./types";

export type RegistryIssue = { path: (string | number)[]; message: string; tooLarge?: boolean };

export class NodeRegistryError extends Error {
  readonly issues: RegistryIssue[];
  constructor(issues: RegistryIssue[]) {
    super(issues.map(formatIssue).join("；"));
    this.name = "NodeRegistryError";
    this.issues = issues;
  }
}

export const formatIssue = (issue: RegistryIssue): string =>
  issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;

// ---------------------------------------------------------------- 公共限制

export const TEXT_LIMITS = { content: 100_000, prompt: 12_000, name: 512, message: 4_000 } as const;
export const GEOMETRY_LIMITS = { coordinate: 1e9, size: 1e6 } as const;
/** 旧行为：用户缩放由 NodeResizer 限定；Agent 写入时夹到 560×1120（lib/agent/canvas.ts）。 */
export const TEXT_GEOMETRY = { minWidth: 200, minHeight: 120, maxWidth: 3000, maxHeight: 3000, agentMaxWidth: 560, agentMaxHeight: 1120 } as const;
const TEXT_DEFAULT_SIZE = { width: 360, height: 260 } as const;
/** 未测量的媒体节点按 node-placement 的回退尺寸处理。 */
const MEDIA_DEFAULT_SIZE = { width: 280, height: 240 } as const;

/** 持久实体 ID：首字符为字母数字，禁止原型相关保留名。新 ID 使用 UUID。 */
export const ENTITY_ID = /^(?!(?:prototype|constructor)$)[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const CANVAS_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 与 lib/assets.ts 的 SAFE_NAME 一致，禁止路径分隔符。 */
export const ASSET_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

export const entityId = () => z.string().regex(ENTITY_ID, { error: "ID 格式无效" });
export const assetName = () => z.string().max(255).regex(ASSET_NAME, { error: "素材名格式无效" });
const text = (max: number) => z.string().max(max, { error: `超过 ${max} 字符上限` });
const optionalId = () => z.union([entityId(), z.null()]);
const optionalText = (max: number) => z.union([text(max), z.null()]);

const IMAGE_ASPECT = /^(?:auto|\d{1,3}(?:\.\d{1,2})?:\d{1,3}(?:\.\d{1,2})?)$/;
const VIDEO_DURATIONS = [6, 10, 15] as const;
const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;

const generationCount = () => z.union([z.literal(1), z.literal(2), z.literal(4)]);
const imageAspect = () => z.string().regex(IMAGE_ASPECT, { error: "比例格式无效" });
const imageResolution = () => z.enum(["1k", "2k"]);
const imageQuality = () => z.enum(["low", "medium"]);
const videoDuration = () => z.union([z.literal(VIDEO_DURATIONS[0]), z.literal(VIDEO_DURATIONS[1]), z.literal(VIDEO_DURATIONS[2])]);
const videoAspect = () => z.union([z.enum(VIDEO_ASPECT_RATIOS), z.null()]);
const videoResolution = () => z.enum(VIDEO_RESOLUTIONS);
const status = () => z.enum(["idle", "running", "failed"]);
const assetList = (max: number) => z.array(assetName()).max(max);
const attachmentNames = () => z.record(assetName(), text(TEXT_LIMITS.name))
  .refine(value => Object.keys(value).length <= 32, { error: "附件名称最多 32 项" });
const videoInput = () => z.strictObject({ assetName: assetName(), role: z.enum(["first", "last", "reference"]) });
const candidate = () => z.strictObject({
  id: z.string().min(1).max(128),
  assetName: z.union([assetName(), z.null()]),
  status: z.enum(["success", "failed"]),
  error: text(TEXT_LIMITS.message).optional(),
});
const imageRequest = () => z.strictObject({
  prompt: text(TEXT_LIMITS.prompt), aspectRatio: imageAspect(), resolution: imageResolution(),
  quality: imageQuality(), count: generationCount(), referenceAssets: assetList(16),
});
const videoRequest = () => z.strictObject({
  prompt: text(TEXT_LIMITS.prompt), duration: videoDuration(), aspectRatio: videoAspect(),
  resolution: videoResolution(), audio: z.boolean(), inputs: z.array(videoInput()).max(9),
});

type FieldSpec = { access: FieldAccess; schema: z.ZodType; document?: true };
const user = (schema: z.ZodType): FieldSpec => ({ access: "user", schema });
const service = (schema: z.ZodType): FieldSpec => ({ access: "service", schema });
const legacy = (schema: z.ZodType): FieldSpec => ({ access: "legacy", schema });

const common = () => ({ name: user(text(TEXT_LIMITS.name)), pinned: user(z.boolean()) });
/** 粘贴逻辑（flow-canvas 粘贴副本）对所有类型写入的生成状态字段；文本/素材节点只作旧数据接受。 */
const pasteLegacy = () => ({
  status: legacy(status()),
  generationId: legacy(optionalId()),
  appliedGenerationId: legacy(optionalId()),
  errorMessage: legacy(optionalText(TEXT_LIMITS.message)),
});

export type NodeTypeEntry = {
  type: NodeType;
  schemaVersion: number;
  fields: Readonly<Record<string, FieldSpec>>;
  required: readonly string[];
  /** 正文存放在 DocumentRecord 时为 true（目前仅 canvasText）。 */
  hasDocument: boolean;
  defaultSize: Readonly<{ width: number; height: number }>;
  validate: (data: unknown) => RegistryIssue[];
  migrate: (data: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
};

function entry(type: NodeType, fields: Record<string, FieldSpec>, options: { required?: string[]; hasDocument?: boolean; defaultSize: { width: number; height: number } }): NodeTypeEntry {
  const required = options.required ?? ["name"];
  const result: NodeTypeEntry = {
    type,
    schemaVersion: 1,
    fields,
    required,
    hasDocument: options.hasDocument ?? false,
    defaultSize: options.defaultSize,
    validate: data => checkData(result, data),
    migrate: (data, fromVersion) => {
      if (fromVersion !== 1) throw new NodeRegistryError([{ path: ["schemaVersion"], message: `${type} 不支持 schemaVersion ${fromVersion}` }]);
      return { ...data };
    },
  };
  return result;
}

export const NODE_REGISTRY: Readonly<Record<NodeType, NodeTypeEntry>> = {
  image: entry("image", {
    ...common(),
    prompt: user(text(TEXT_LIMITS.prompt)),
    draftPrompt: user(text(TEXT_LIMITS.prompt)),
    aspectRatio: user(imageAspect()),
    resolution: user(imageResolution()),
    quality: user(imageQuality()),
    generationCount: user(generationCount()),
    uploadAttachments: user(assetList(16)),
    attachmentNames: user(attachmentNames()),
    assetName: service(z.union([assetName(), z.null()])),
    status: service(status()),
    results: service(z.array(candidate()).max(16)),
    primaryResultId: service(z.union([z.string().min(1).max(128), z.null()])),
    generationId: service(optionalId()),
    appliedGenerationId: service(optionalId()),
    errorMessage: service(optionalText(TEXT_LIMITS.message)),
    retryingSlotId: service(z.union([z.string().min(1).max(128), z.null()])),
    generationRequest: service(imageRequest()),
    sourceNodeId: service(optionalId()),
    duration: legacy(videoDuration()),
    audio: legacy(z.boolean()),
    uploadInputs: legacy(z.array(videoInput()).max(9)),
  }, { defaultSize: MEDIA_DEFAULT_SIZE }),
  video: entry("video", {
    ...common(),
    prompt: user(text(TEXT_LIMITS.prompt)),
    draftPrompt: user(text(TEXT_LIMITS.prompt)),
    duration: user(videoDuration()),
    aspectRatio: user(videoAspect()),
    resolution: user(videoResolution()),
    audio: user(z.boolean()),
    uploadInputs: user(z.array(videoInput()).max(9)),
    attachmentNames: user(attachmentNames()),
    assetName: service(z.union([assetName(), z.null()])),
    status: service(status()),
    taskId: service(z.union([z.string().min(1).max(256), z.null()])),
    waitedSeconds: service(z.number().min(0).max(7 * 86_400)),
    errorMessage: service(optionalText(TEXT_LIMITS.message)),
    errorKind: service(z.union([z.enum(["server", "save_failed", "expired", "network"]), z.null()])),
    generationRequest: service(videoRequest()),
    generationId: service(optionalId()),
    sourceNodeId: service(optionalId()),
    quality: legacy(imageQuality()),
    generationCount: legacy(generationCount()),
    uploadAttachments: legacy(assetList(16)),
  }, { defaultSize: MEDIA_DEFAULT_SIZE }),
  asset: entry("asset", {
    ...common(),
    ...pasteLegacy(),
    assetName: service(assetName()),
  }, { required: ["name", "assetName"], defaultSize: MEDIA_DEFAULT_SIZE }),
  canvasText: entry("canvasText", {
    ...common(),
    ...pasteLegacy(),
    content: { access: "user", schema: text(TEXT_LIMITS.content), document: true },
  }, { hasDocument: true, defaultSize: TEXT_DEFAULT_SIZE }),
};

const NODE_TYPES = Object.keys(NODE_REGISTRY) as NodeType[];

export function getNodeType(type: string): NodeTypeEntry | null {
  return Object.hasOwn(NODE_REGISTRY, type) ? NODE_REGISTRY[type as NodeType] : null;
}

export function fieldAccess(type: string, field: string): FieldAccess | null {
  const spec = getNodeType(type)?.fields;
  return spec && Object.hasOwn(spec, field) ? spec[field]!.access : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function zodIssues(error: z.ZodError, prefix: (string | number)[]): RegistryIssue[] {
  return error.issues.map(issue => ({
    path: [...prefix, ...issue.path.map(key => (typeof key === "symbol" ? String(key) : key))],
    message: issue.message,
    ...(issue.code === "too_big" && issue.origin === "string" && Number(issue.maximum) >= TEXT_LIMITS.prompt ? { tooLarge: true } : {}),
  }));
}

function checkField(spec: FieldSpec, field: string, value: unknown, prefix: (string | number)[]): RegistryIssue[] {
  const parsed = spec.schema.safeParse(value);
  return parsed.success ? [] : zodIssues(parsed.error, [...prefix, field]);
}

function checkData(entry: NodeTypeEntry, data: unknown): RegistryIssue[] {
  if (!isRecord(data)) return [{ path: [], message: "节点 data 必须是对象" }];
  const issues: RegistryIssue[] = [];
  for (const field of entry.required) if (!Object.hasOwn(data, field)) issues.push({ path: [field], message: `${entry.type} 缺少必填字段 ${field}` });
  for (const [field, value] of Object.entries(data)) {
    const spec = Object.hasOwn(entry.fields, field) ? entry.fields[field]! : null;
    if (!spec) issues.push({ path: [field], message: `${entry.type} 未登记的字段 ${field}` });
    else if (spec.document) issues.push({ path: [field], message: `${field} 属于 DocumentRecord，不能放进节点 data` });
    else issues.push(...checkField(spec, field, value, []));
  }
  return issues;
}

/** 新增/导入时的整份 data 校验；未知类型明确报错，不当成 image。 */
export function checkNodeData(type: string, data: unknown): RegistryIssue[] {
  const found = getNodeType(type);
  return found ? found.validate(data) : [{ path: ["type"], message: `未知节点类型：${type}` }];
}

/**
 * 部分字段补丁。access=user 只允许 user 字段；access=service 允许 user+service。
 * legacy 字段任何补丁都拒绝。
 */
export function checkNodePatch(type: string, patch: Record<string, unknown>, access: "user" | "service"): RegistryIssue[] {
  const found = getNodeType(type);
  if (!found) return [{ path: ["type"], message: `未知节点类型：${type}` }];
  const issues: RegistryIssue[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const spec = Object.hasOwn(found.fields, field) ? found.fields[field]! : null;
    if (!spec) issues.push({ path: [field], message: `${type} 未登记的字段 ${field}` });
    else if (spec.access === "legacy" || (spec.access === "service" && access === "user")) issues.push({ path: [field], message: `${field} 不可由${access === "user" ? "用户" : "服务端"}补丁修改` });
    else issues.push(...checkField(spec, field, value, []));
  }
  return issues;
}

/** 解析期尚不知道节点类型：字段须是某一类型允许的字段，且值至少符合其中一种类型的定义。 */
export function checkPatchFieldAnyType(field: string, value: unknown, access: "user" | "service", prefix: (string | number)[]): RegistryIssue[] {
  const candidates = NODE_TYPES.map(type => NODE_REGISTRY[type].fields)
    .filter(fields => Object.hasOwn(fields, field))
    .map(fields => fields[field]!)
    .filter(spec => spec.access === "user" || (access === "service" && spec.access === "service"));
  if (!candidates.length) return [{ path: prefix, message: `字段 ${field} 不在${access === "user" ? "用户可写" : "可写"}白名单内` }];
  let first: RegistryIssue[] | null = null;
  for (const spec of candidates) {
    const issues = checkField(spec, field, value, prefix.slice(0, -1));
    if (!issues.length) return [];
    first ??= issues;
  }
  return first!;
}

export function checkNodeGeometry(type: string, geometry: Geometry): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const { coordinate, size } = GEOMETRY_LIMITS;
  for (const key of ["x", "y"] as const) if (!Number.isFinite(geometry[key]) || Math.abs(geometry[key]) > coordinate) issues.push({ path: [key], message: `坐标须为有限数且绝对值不超过 ${coordinate}` });
  for (const key of ["width", "height"] as const) if (!Number.isFinite(geometry[key]) || geometry[key] <= 0 || geometry[key] > size) issues.push({ path: [key], message: `尺寸须大于 0 且不超过 ${size}` });
  if (type === "canvasText") {
    if (geometry.width > TEXT_GEOMETRY.maxWidth) issues.push({ path: ["width"], message: `文本宽度不能超过 ${TEXT_GEOMETRY.maxWidth}` });
    if (geometry.height > TEXT_GEOMETRY.maxHeight) issues.push({ path: ["height"], message: `文本高度不能超过 ${TEXT_GEOMETRY.maxHeight}` });
  }
  return issues;
}

const thrower = (issues: RegistryIssue[]) => { if (issues.length) throw new NodeRegistryError(issues); };
export const validateNodeData = (type: string, data: unknown): void => thrower(checkNodeData(type, data));
export const validateNodePatch = (type: string, patch: Record<string, unknown>, access: "user" | "service"): void => thrower(checkNodePatch(type, patch, access));
export const validateNodeGeometry = (type: string, geometry: Geometry): void => thrower(checkNodeGeometry(type, geometry));

/**
 * 与 lib/agent/canvas.ts 的 addNodes/editNodes 相同的 Agent 文本尺寸规则：
 * 给定的边夹到 560×1120；未给定的边保留当前值（用户手动尺寸），新建时用默认 360×260。
 */
export function clampAgentTextSize(requested: { width?: number; height?: number }, current?: { width?: number; height?: number }): { width: number; height: number } {
  const pick = (value: number | undefined, max: number, existing: number | undefined, fallback: number) =>
    value !== undefined ? Math.min(value, max) : existing ?? Math.min(fallback, max);
  return {
    width: pick(requested.width, TEXT_GEOMETRY.agentMaxWidth, current?.width, TEXT_DEFAULT_SIZE.width),
    height: pick(requested.height, TEXT_GEOMETRY.agentMaxHeight, current?.height, TEXT_DEFAULT_SIZE.height),
  };
}
