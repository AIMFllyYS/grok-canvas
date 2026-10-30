/**
 * 工作站跨任务唯一的数据契约（docs/workstation-plan/contracts.md C1/C2）。
 * 后续任务只消费这里的类型，不再另建同义类型；修改须先更新契约并列出受影响 Task-ID。
 * 本文件只含类型和一个状态码常量，浏览器与服务端均可导入。
 */
import type { CanvasDoc } from "../canvas-store";

// ---------------------------------------------------------------- C1 实体

export type FieldVersion = number;
export type Geometry = { x: number; y: number; width: number; height: number };
export type NodeType = "image" | "video" | "asset" | "canvasText";

export type NodeSummary = {
  id: string;
  canvasId: string;
  type: string;
  schemaVersion: number;
  geometry: Geometry;
  entityVersion: number;
  geometryVersion: FieldVersion;
  /** 仅 canvasText 指向正文 DocumentRecord；其余类型为 null。 */
  documentId: string | null;
  /** 不含正文 content；prompt 留在 data 中并有独立字段版本。 */
  data: Readonly<Record<string, unknown>>;
};

export type DocumentRecord = { id: string; nodeId: string; content: string; version: FieldVersion };

export type EdgeRole = "first" | "last" | "reference";
export type EdgeRecord = {
  id: string;
  canvasId: string;
  source: string;
  target: string;
  role: EdgeRole | null;
  version: number;
};

export type FieldRef = { target: "node" | "document" | "edge" | "canvas"; id: string; field: string };
export type Subscription = () => void;

/** 节点注册表对字段的归属分类：user 可由用户 patch；service 只能由服务端命令写；legacy 只在新增/导入时接受。 */
export type FieldAccess = "user" | "service" | "legacy";

// ---------------------------------------------------------------- C2 命令

export type CommandKind =
  | "move_nodes" | "patch_nodes" | "add_nodes" | "delete_nodes"
  | "edit_edges" | "register_assets" | "apply_generation" | "rename_canvas" | "batch";

export type MoveNodesPayload = { items: Array<{ nodeId: string; expectedVersion: number; from: Geometry; to: Geometry }> };
export type PatchNodesPayload = { items: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> };
export type AddNodesPayload = { nodes: NodeSummary[]; documents: DocumentRecord[] };
export type DeleteNodesPayload = { items: Array<{ nodeId: string; expectedEntityVersion: number }> };
export type EditEdgesPayload = { add: EdgeRecord[]; remove: Array<{ edgeId: string; expectedVersion: number }> };
export type AssetRegistration = { assetName: string; kind: "image" | "video"; createdAt: string; missing?: boolean };
export type RegisterAssetsPayload = { assets: AssetRegistration[] };
export type ApplyGenerationPayload = {
  nodeId: string;
  generationId: string;
  claimId: string;
  assets: AssetRegistration[];
  patch: Record<string, unknown>;
};
export type RenameCanvasPayload = { expectedVersion: number; name: string };

export type CommandPayloads = {
  move_nodes: MoveNodesPayload;
  patch_nodes: PatchNodesPayload;
  add_nodes: AddNodesPayload;
  delete_nodes: DeleteNodesPayload;
  edit_edges: EditEdgesPayload;
  register_assets: RegisterAssetsPayload;
  apply_generation: ApplyGenerationPayload;
  rename_canvas: RenameCanvasPayload;
  batch: BatchPayload;
};

/** batch 内的子命令：共享外层身份，不能嵌套 batch。 */
export type BatchItem = { [K in Exclude<CommandKind, "batch">]: { kind: K; payload: CommandPayloads[K] } }[Exclude<CommandKind, "batch">];
export type BatchPayload = { commands: BatchItem[] };

export type CommandEnvelope = {
  schemaVersion: 1;
  commandId: string;
  actorId: string;
  actorSeq: number;
  canvasId: string;
  storageEpoch: string;
  baseRevision: number;
};

/** 已严格解析的命令；payload 随 kind 精确收窄。 */
export type CanvasCommand = { [K in CommandKind]: CommandEnvelope & { kind: K; payload: CommandPayloads[K] } }[CommandKind];
export type CanvasCommandOf<K extends CommandKind> = Extract<CanvasCommand, { kind: K }>;

export type Delta = {
  canvasId: string;
  fromRevision: number;
  revision: number;
  nodes: NodeSummary[];
  documents: DocumentRecord[];
  edges: EdgeRecord[];
  removedNodeIds: string[];
  removedDocumentIds: string[];
  removedEdgeIds: string[];
  assets: unknown[];
  name?: string;
};

export type CommitReceipt = {
  commandId: string;
  revision: number;
  eventSeq: number;
  storageEpoch: string;
  changedNodeIds: string[];
  changedEdgeIds: string[];
  fieldVersions: Array<FieldRef & { version: number }>;
  delta: Delta;
  replayed: boolean;
};

export type CommandErrorCode =
  | "invalid_command" | "field_conflict" | "lease_conflict"
  | "canvas_deleted" | "command_id_reused" | "actor_sequence_gap"
  | "stale_epoch" | "queue_full" | "maintenance" | "storage_unavailable";

export type CommandErrorField = { path: string; message: string };
export type CommandErrorBody = {
  error: { code: CommandErrorCode; message: string; fields?: CommandErrorField[]; retryAfterMs?: number };
};

/**
 * 错误码到 HTTP 状态的默认映射。invalid_command 在字节/正文/prompt 超限时改用 413。
 * 禁止用 HTTP 200 包裹未保存的失败。
 */
export const COMMAND_ERROR_STATUS: Readonly<Record<CommandErrorCode, number>> = {
  invalid_command: 400,
  canvas_deleted: 404,
  field_conflict: 409,
  command_id_reused: 409,
  actor_sequence_gap: 409,
  stale_epoch: 409,
  lease_conflict: 423,
  maintenance: 423,
  queue_full: 429,
  storage_unavailable: 503,
};

// ---------------------------------------------------------------- v1 旧文档的显式转换类型（实现见 P2-02）

/** 旧 CanvasDoc.nodes 中 React Flow 节点的持久形状；selected/dragging/measured 等视图字段不迁移。 */
export type LegacyFlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  /** 旧“固定节点”状态；false 迁移为 data.pinned = true。 */
  draggable?: boolean;
  data: Record<string, unknown>;
  measured?: { width?: number; height?: number };
};

export type LegacyFlowEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: { role?: EdgeRole; [key: string]: unknown };
};

export type LegacyCanvasDocV1 = Omit<CanvasDoc, "nodes" | "edges"> & { nodes: unknown[]; edges: unknown[] };

export type LegacyConversionIssue = {
  entity: "node" | "edge";
  id: string;
  code: "unknown_type" | "unknown_field" | "invalid_value" | "invalid_geometry" | "dangling_edge" | "duplicate_id";
  detail: string;
};

/** 未知类型/字段必须进 issues 明确报告，不得静默抹除或改成 image。 */
export type LegacyConversionResult = {
  nodes: NodeSummary[];
  documents: DocumentRecord[];
  edges: EdgeRecord[];
  issues: LegacyConversionIssue[];
};

export type ConvertLegacyCanvas = (doc: LegacyCanvasDocV1) => LegacyConversionResult;
