/**
 * 迁移输入目录（P3-04，交接 P3-06）：数据目录里每一类源路径 → 目标表、ID 转换、校验与缺失/损坏语义。
 * 缺失（missing）与损坏（corrupt）是两种不同结果，不可混淆；未登记路径报 unknown，不静默跳过。
 * OAuth/auth 显式排除，不进入工作站数据库。
 */
export type ImportKind = "canvas" | "agent" | "studio" | "video-task" | "generation" | "app-state" | "asset" | "auth";
export type ImportEntry = {
  kind: ImportKind;
  /** 相对数据目录的路径模式。 */
  pattern: RegExp;
  description: string;
  tables: string[];
  idTransform: string;
  checksum: string;
  onMissing: string;
  onCorrupt: string;
  supportedVersions?: number[];
  excluded?: boolean;
};

export const IMPORT_CATALOG: readonly ImportEntry[] = Object.freeze([
  {
    kind: "canvas", pattern: /^canvases\/[A-Za-z0-9-]+\.json$/, description: "画布文档（含 commandState 版本/回执/水位与 appliedOperationIds）",
    tables: ["canvases", "nodes", "documents", "node_fields", "edges", "canvas_assets", "command_receipts", "actor_watermarks", "legacy_operation_ids", "generation_claims"],
    idTransform: "文件名 = canvasId；节点/连线/正文 ID 原样保留（节点按 canvas 复合主键，同一 legacy nodeId 可存在于多个画布）",
    checksum: "sha256(原文件字节) 记入 import_runs.report；导入后按实体计数与版本复核",
    onMissing: "跳过并在报告中记 missing（画布列表与目录不一致时阻断该画布）", onCorrupt: "阻断该画布，记 corrupt_json，不写入任何部分实体", supportedVersions: [1],
  },
  {
    kind: "agent", pattern: /^agent\/[A-Za-z0-9-]+\.json$/, description: "Agent 会话状态（新格式 conversations + 旧顶层 messages）",
    tables: ["agent_conversations", "agent_messages"],
    idTransform: "文件名 = canvasId；会话/消息 ID 原样；只有顶层消息时生成 legacy-<canvasId> 会话；与会话相同的顶层消息去重",
    checksum: "sha256(原文件)；按会话复核消息数与 ID 顺序",
    onMissing: "该画布没有会话（正常）", onCorrupt: "阻断该画布的会话导入并报告，不影响画布实体",
  },
  {
    kind: "studio", pattern: /^studio\/[A-Za-z0-9-]+\.json$/, description: "更早的 studio 会话目录（lib/agent/store.ts 迁移来源）",
    tables: ["agent_conversations", "agent_messages"],
    idTransform: "按 lib/agent/store.ts 的旧格式规则映射到 canvasId；已存在 agent/ 新文件时以新文件为准",
    checksum: "sha256(原文件)", onMissing: "无旧目录（正常）", onCorrupt: "报告 corrupt_json，保留原文件，不导入",
  },
  {
    kind: "video-task", pattern: /^video-tasks\/[A-Za-z0-9-]+\.json$/, description: "视频任务（上游 requestId、提交快照、remoteUrl、结果、claim 是否已释放）",
    tables: ["task_runs"],
    idTransform: "taskId 原样；canvasId/nodeId 来自记录本身，并核对画布存在",
    checksum: "sha256(原文件)；往返字段逐一比较",
    onMissing: "无任务（正常）", onCorrupt: "报告 corrupt_json；不得据此重新提交收费生成", supportedVersions: [1],
  },
  {
    kind: "generation", pattern: /^generations\/[A-Za-z0-9_.-]+\.json$/, description: "不可变生成来源记录",
    tables: ["generation_records"],
    idTransform: "文件名去掉 .json = assetName",
    checksum: "快照规范化 sha256：相同幂等，不同拒绝覆盖", onMissing: "上传/旧素材没有记录（正常，不伪造）", onCorrupt: "报告 corrupt_json，该素材显示为无来源", supportedVersions: [1],
  },
  {
    kind: "app-state", pattern: /^app-state\.json$/, description: "最后打开的画布",
    tables: ["workspace_preferences"], idTransform: "lastCanvasId → key=lastCanvas",
    checksum: "sha256(原文件)", onMissing: "使用第一个画布（正常）", onCorrupt: "忽略偏好并报告，不阻断画布导入",
  },
  {
    kind: "asset", pattern: /^assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/, description: "媒体文件（不存 BLOB，只登记元数据与相对路径）",
    tables: ["assets"], idTransform: "文件名 = assetName；画布归属来自画布的 libraryAssets/commandState.assets，写 canvas_assets",
    checksum: "文件 sha256 与字节数", onMissing: "被画布引用但文件不存在：canvas_assets.missing=1 并报告", onCorrupt: "读取失败：status=missing 并报告，不删除引用",
  },
  {
    kind: "auth", pattern: /^(auth(\.[^/]+)?\.json|oauth[^/]*|\.grok\/.*)$/, description: "OAuth / 登录凭据",
    tables: [], idTransform: "不导入", checksum: "不读取内容", onMissing: "不适用", onCorrupt: "不适用", excluded: true,
  },
]);

export type ClassifiedSource = (ImportEntry & { path: string }) | { kind: "unknown"; path: string; excluded?: false };

export function classifySource(relativePath: string): ClassifiedSource {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const entry = IMPORT_CATALOG.find(item => item.pattern.test(normalized));
  return entry ? { ...entry, path: normalized } : { kind: "unknown", path: normalized };
}

export type SourceOutcome = "ok" | "missing" | "corrupt" | "unsupported_version";

/** 读取一个源文件的结果分类：缺失、损坏（无法解析）、版本不支持与正常严格区分。 */
export function sourceOutcome(input: { exists: boolean; parse?: () => unknown; supportedVersions?: number[] }): SourceOutcome {
  if (!input.exists) return "missing";
  let value: unknown;
  try { value = input.parse?.(); } catch { return "corrupt"; }
  if (input.supportedVersions && value && typeof value === "object") {
    const version = (value as { schemaVersion?: unknown }).schemaVersion ?? 1;
    if (!input.supportedVersions.includes(Number(version))) return "unsupported_version";
  }
  return "ok";
}
