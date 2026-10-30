/**
 * 服务端写入统一走领域命令（P2-08，contracts.md C2/C3/C8）。服务端私有模块。
 * - 生成回写：apply_generation（result/start/select/fail），绑定原 canvasId/nodeId/generationId/claimId，
 *   在画布锁内按当前节点状态决定：节点已删 → 只登记素材（orphan）；generationId 已换 → 不覆盖新结果；
 *   画布已删 → 返回 canvas_deleted，不重建画布。
 * - 浏览器结果登记：成功结果必须能在服务端核验（图片素材文件 + 生成记录；视频任务记录），不接受伪造的收费成功。
 * - Agent：新增/编辑/连线/参考绑定直接构造 add_nodes/patch_nodes/move_nodes/delete_nodes/edit_edges，
 *   不再 clone 整图推导补丁；租约在命令服务内核验。
 */
import { existsSync } from "node:fs";
import { assetPath, isSafeAssetName, readGenerationRecord } from "../assets";
import { mergeLibraryAssets, normalizeLibraryAssets, assetsFromOutcome } from "../canvas-library";
import { updateCanvas } from "../canvas-store";
import { applyGenerationOutcome, type GenerationOutcome } from "../multi-image";
import { readVideoTask } from "../video-tasks";
import { videoTaskView } from "../video-generate";
import { videoNodePatchFromView } from "../video-runtime";
import { CommandError, executeServerCommand, type CommandOrigin } from "./command-service";
import type { CommandTxn } from "./json-repository";
import { summaryOf, type UserFlowNode } from "./user-actions";
import type { AssetRegistration, BatchItem, CommitReceipt, Geometry } from "./types";

export const AGENT_ACTOR_ID = "a9e70000-0000-4000-8000-000000000001";
export const GENERATION_ACTOR_ID = "a9e70000-0000-4000-8000-000000000002";

type Reader = CommandTxn["reader"];
export type ServiceWriteResult = { status: "applied" | "unchanged" | "orphan" | "canvas_deleted"; receipt?: CommitReceipt };

/** 生成开始时可写的字段：只描述状态与请求快照，不包含任何结果。 */
const START_FIELDS = new Set(["status", "generationId", "errorMessage", "errorKind", "retryingSlotId", "generationRequest", "taskId", "waitedSeconds"]);
const FAIL_FIELDS = new Set(["status", "errorMessage", "errorKind", "retryingSlotId"]);

export type ServiceWrite =
  | { action: "start"; nodeId: string; generationId: string; patch: Record<string, unknown> }
  | { action: "image"; nodeId: string; outcome: GenerationOutcome }
  | { action: "video"; nodeId: string; taskId: string }
  | { action: "fail"; nodeId: string; generationId: string; patch: Record<string, unknown> }
  | { action: "select"; nodeId: string; slotId: string }
  | { action: "task"; nodeId: string; generationId: string; taskId: string };

export class ServiceWriteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const nowIso = () => new Date().toISOString();
const claimOf = (reader: Reader, nodeId: string) => {
  const node = reader.getNode(nodeId);
  const source = typeof node?.data.sourceNodeId === "string" ? node.data.sourceNodeId : null;
  return reader.generationClaim(nodeId) ?? (source ? reader.generationClaim(source) : undefined);
};

function statusOf(receipt: CommitReceipt | null, nodeId: string, nodeExisted: boolean): ServiceWriteResult {
  if (!receipt) return { status: "canvas_deleted" };
  if (!nodeExisted) return { status: "orphan", receipt };
  return { status: receipt.changedNodeIds.includes(nodeId) ? "applied" : "unchanged", receipt };
}

/** 浏览器提交的图片结果：每个成功槽位的素材文件与生成记录都必须由服务端写过。返回记录的保存时间（稳定，重复登记不变）。 */
async function verifyImageOutcome(outcome: GenerationOutcome): Promise<Map<string, string>> {
  const savedAt = new Map<string, string>();
  if (outcome.kind !== "result") return savedAt;
  for (const slot of outcome.slots) {
    if (slot.status !== "success") continue;
    const name = slot.asset?.name;
    if (typeof name !== "string" || !isSafeAssetName(name) || !existsSync(assetPath(name))) throw new ServiceWriteError("生成结果引用的素材不存在");
    const record = await readGenerationRecord(name);
    if (!record) throw new ServiceWriteError("生成结果没有服务端生成记录，拒绝登记");
    savedAt.set(name, record.savedAt);
  }
  return savedAt;
}

/** 一次生成回写（浏览器或 Agent）。所有判断都在画布锁内基于当前节点做出。 */
export async function applyServiceWrite(canvasId: string, write: ServiceWrite, options: { origin?: CommandOrigin; actorId?: string } = {}): Promise<ServiceWriteResult> {
  const origin = options.origin ?? "server";
  const actorId = options.actorId ?? GENERATION_ACTOR_ID;
  let assets: AssetRegistration[] = [];
  let videoView: ReturnType<typeof videoTaskView> | null = null;
  let libraryAdditions: ReturnType<typeof assetsFromOutcome> = [];
  if (write.action === "image") {
    const savedAt = await verifyImageOutcome(write.outcome);
    libraryAdditions = assetsFromOutcome(write.outcome, "").map(asset => ({ ...asset, addedAt: savedAt.get(asset.assetName) ?? nowIso() }));
    assets = libraryAdditions.map(asset => ({ assetName: asset.assetName, kind: "image" as const, createdAt: asset.addedAt }));
  }
  if (write.action === "video") {
    const record = await readVideoTask(write.taskId).catch(() => null);
    if (!record || record.canvasId !== canvasId) throw new ServiceWriteError("视频任务不属于该画布", 409);
    videoView = videoTaskView(record);
    if (record.result && record.status === "completed") assets = [{ assetName: record.result.assetName, kind: "video", createdAt: record.updatedAt }];
  }
  if ((write.action === "start" || write.action === "fail") && Object.keys(write.patch).some(field => !(write.action === "start" ? START_FIELDS : FAIL_FIELDS).has(field))) {
    throw new ServiceWriteError(write.action === "start" ? "生成开始只能写状态与请求快照" : "失败只能写状态与错误信息");
  }
  if (write.action === "start" && (write.patch.status !== "running" || write.patch.generationId !== write.generationId)) throw new ServiceWriteError("生成开始须把状态设为 running 并绑定 generationId");
  if (write.action === "fail" && write.patch.status !== "failed") throw new ServiceWriteError("失败写入须把状态设为 failed");

  let nodeExisted = false;
  const receipt = await executeServerCommand(canvasId, actorId, (reader) => {
    const node = reader.getNode(write.nodeId);
    nodeExisted = !!node;
    const claim = claimOf(reader, write.nodeId);
    const data = (node?.data ?? {}) as Record<string, unknown>;
    const currentGeneration = typeof data.generationId === "string" ? data.generationId : null;
    const item = (generationId: string, claimId: string, patch: Record<string, unknown>, mode: "result" | "start" | "select" | "fail") => {
      // 节点已删：只登记素材（无补丁时用一个占位字段，reducer 在节点不存在时不写节点）。
      const body = Object.keys(patch).length ? patch : { status: data.status ?? "idle" };
      return { kind: "apply_generation" as const, payload: { nodeId: write.nodeId, generationId, claimId, assets, patch: body, mode } };
    };
    switch (write.action) {
      case "start":
        return item(write.generationId, write.generationId, write.patch, "start");
      case "fail":
        return item(write.generationId, claim?.id ?? write.generationId, write.patch, "fail");
      case "task":
        return item(write.generationId, claim?.id ?? write.generationId, { taskId: write.taskId }, "result");
      case "image": {
        const outcome = write.outcome;
        const patch = node ? applyGenerationOutcome(data, outcome, () => crypto.randomUUID()) : null;
        if (node && !patch && !assets.length) return null;
        return item(outcome.generationId, claim?.id ?? outcome.generationId, patch ?? {}, "result");
      }
      case "video": {
        const view = videoView!;
        const generationId = view.generationId ?? currentGeneration;
        if (!generationId) return null;
        if (node && view.nodeId !== write.nodeId && data.sourceNodeId !== view.nodeId) throw new ServiceWriteError("视频任务不属于该节点", 409);
        return item(generationId, claim?.id ?? generationId, node ? videoNodePatchFromView(view) : {}, "result");
      }
      case "select": {
        if (!node) return null;
        const results = Array.isArray(data.results) ? data.results as Array<{ id?: unknown; status?: unknown; assetName?: unknown }> : [];
        const slot = results.find(result => result.id === write.slotId);
        if (!slot || slot.status !== "success" || typeof slot.assetName !== "string") throw new ServiceWriteError("候选不存在或未成功");
        return item(currentGeneration ?? write.nodeId, write.nodeId, { primaryResultId: write.slotId, assetName: slot.assetName }, "select");
      }
    }
  }, { origin });
  // 画布素材库列表仍在旧文档字段上（过渡期两步写入；P3-05 在 SQL 中原子合并）。
  if (receipt && libraryAdditions.length) {
    await updateCanvas(canvasId, doc => {
      const current = normalizeLibraryAssets(doc.libraryAssets);
      const merged = mergeLibraryAssets(current, libraryAdditions);
      if (merged === current || JSON.stringify(merged) === JSON.stringify(current)) return false;
      doc.libraryAssets = merged;
    });
  }
  if (write.action === "select" && !nodeExisted && receipt === null) return { status: "orphan" };
  return statusOf(receipt, write.nodeId, nodeExisted);
}

// ---------------------------------------------------------------- Agent

export class AgentCommandError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function agentError(error: unknown): never {
  if (error instanceof CommandError) {
    if (error.code === "lease_conflict") throw new AgentCommandError("用户正在编辑该节点内容，请稍后重试", 409);
    if (error.code === "canvas_deleted") throw new AgentCommandError("画布不存在", 404);
    if (error.code === "field_conflict") throw new AgentCommandError(`节点已被其他修改改变：${error.message}`, 409);
    throw new AgentCommandError(error.message, error.status);
  }
  throw error;
}

async function runAgent(canvasId: string, build: (reader: Reader) => BatchItem[] | null): Promise<CommitReceipt | null> {
  try {
    const receipt = await executeServerCommand(canvasId, AGENT_ACTOR_ID, reader => {
      const items = build(reader);
      if (!items || !items.length) return null;
      return items.length === 1 ? { kind: items[0]!.kind, payload: items[0]!.payload } : { kind: "batch", payload: { commands: items } };
    }, { origin: "agent" });
    return receipt;
  } catch (error) { agentError(error); }
}

/** Agent 新增：预分配 ID 的旧节点（放置已算好）→ add_nodes。 */
export async function agentAddNodes(canvasId: string, nodes: readonly UserFlowNode[]): Promise<void> {
  const summaries = nodes.map(node => {
    const converted = summaryOf(node, canvasId);
    if ("error" in converted) throw new AgentCommandError(converted.error, 400);
    return converted;
  });
  const receipt = await runAgent(canvasId, () => [{ kind: "add_nodes", payload: { nodes: summaries.map(item => item.summary), documents: summaries.flatMap(item => item.document ? [item.document] : []) } }]);
  if (!receipt) throw new AgentCommandError("画布不存在", 404);
}

export type AgentEdit = {
  updates: Array<{ id: string; name?: string; prompt?: string; content?: string; width?: number; height?: number; x?: number; y?: number }>;
  remove: string[];
  connect: Array<{ source: string; target: string; role?: "first" | "last" | "reference" }>;
  disconnect: string[];
};

/** Agent 编辑：在锁内按当前版本构造补丁、移动、删除与连线，一条 batch 原子提交。 */
export async function agentEditNodes(canvasId: string, edit: AgentEdit, limits: { maxTextWidth: number; maxTextHeight: number }): Promise<CommitReceipt | null> {
  return runAgent(canvasId, (reader) => {
    const items: BatchItem[] = [];
    const patches: Array<{ nodeId: string; field: string; expectedVersion: number; value: unknown }> = [];
    const moves: Array<{ nodeId: string; expectedVersion: number; from: Geometry; to: Geometry }> = [];
    for (const id of [...edit.updates.map(update => update.id), ...edit.remove]) {
      const node = reader.getNode(id);
      if (!node) throw new AgentCommandError(`节点不存在：${id}`, 400);
      if (node.data.status === "running") throw new AgentCommandError("节点正在生成，请稍后修改", 400);
    }
    for (const update of edit.updates) {
      const node = reader.getNode(update.id)!;
      if (update.name !== undefined) patches.push({ nodeId: node.id, field: "name", expectedVersion: reader.fieldVersion(node.id, "name"), value: update.name });
      if (update.content !== undefined || update.width !== undefined || update.height !== undefined) {
        if (node.type !== "canvasText") throw new AgentCommandError("仅文本节点支持正文和调整尺寸", 400);
      }
      if (update.content !== undefined) {
        const document = node.documentId ? reader.getDocument(node.documentId) : undefined;
        patches.push({ nodeId: node.id, field: "content", expectedVersion: document?.version ?? 0, value: update.content });
      }
      if (update.prompt !== undefined) {
        if (!["image", "video"].includes(node.type)) throw new AgentCommandError("仅图片和视频节点支持提示词", 400);
        patches.push({ nodeId: node.id, field: "prompt", expectedVersion: reader.fieldVersion(node.id, "prompt"), value: update.prompt });
      }
      if (update.x !== undefined || update.y !== undefined || update.width !== undefined || update.height !== undefined) {
        const g = node.geometry;
        const to = {
          x: update.x ?? g.x, y: update.y ?? g.y,
          width: update.width !== undefined ? Math.min(update.width, limits.maxTextWidth) : g.width,
          height: update.height !== undefined ? Math.min(update.height, limits.maxTextHeight) : g.height,
        };
        if (to.x !== g.x || to.y !== g.y || to.width !== g.width || to.height !== g.height) moves.push({ nodeId: node.id, expectedVersion: node.geometryVersion, from: { ...g }, to });
      }
    }
    const removed = new Set(edit.remove);
    const edgeRemovals: Array<{ edgeId: string; expectedVersion: number }> = [];
    for (const edgeId of edit.disconnect) {
      const edge = reader.getEdge(edgeId);
      if (edge && !removed.has(edge.source) && !removed.has(edge.target)) edgeRemovals.push({ edgeId, expectedVersion: edge.version });
    }
    const adds: Array<{ id: string; canvasId: string; source: string; target: string; role: "first" | "last" | "reference" | null; version: number }> = [];
    for (const link of edit.connect) {
      const source = reader.getNode(link.source), target = reader.getNode(link.target);
      if (!source || !target || source.id === target.id || removed.has(source.id) || removed.has(target.id)) throw new AgentCommandError("连线端点无效；图片可作为图片或视频参考", 400);
      const textLink = source.type === "canvasText" || target.type === "canvasText";
      if (!textLink && target.data.status === "running") throw new AgentCommandError("目标节点正在生成", 400);
      const exists = reader.outgoingEdgeIds(source.id).some(id => reader.getEdge(id)?.target === target.id && !edit.disconnect.includes(id));
      if (exists || adds.some(edge => edge.source === source.id && edge.target === target.id)) continue;
      adds.push({ id: crypto.randomUUID(), canvasId, source: source.id, target: target.id, role: !textLink && target.type === "video" ? link.role ?? "reference" : null, version: 0 });
    }
    if (edgeRemovals.length) items.push({ kind: "edit_edges", payload: { add: [], remove: edgeRemovals } });
    if (edit.remove.length) items.push({ kind: "delete_nodes", payload: { items: edit.remove.map(id => ({ nodeId: id, expectedEntityVersion: reader.getNode(id)!.entityVersion })) } });
    if (patches.length) items.push({ kind: "patch_nodes", payload: { items: patches } });
    if (moves.length) items.push({ kind: "move_nodes", payload: { items: moves } });
    if (adds.length) items.push({ kind: "edit_edges", payload: { add: adds, remove: [] } });
    return items;
  });
}

/** Agent 参考绑定：只写 user 字段（附件/输入/名称表）。 */
export async function agentPatchFields(canvasId: string, nodeId: string, fields: Record<string, unknown>): Promise<void> {
  await runAgent(canvasId, (reader) => {
    const node = reader.getNode(nodeId);
    if (!node) throw new AgentCommandError("节点不存在", 400);
    const items = Object.entries(fields).map(([field, value]) => ({ nodeId, field, expectedVersion: reader.fieldVersion(nodeId, field), value }));
    return items.length ? [{ kind: "patch_nodes", payload: { items } }] : null;
  });
}

/** Agent 触发的生成（服务端自己调用生成接口，结果可信）：开始/结果/失败/任务 ID 都是 apply_generation。 */
export async function agentGenerationWrite(canvasId: string, nodeId: string, generationId: string, patch: Record<string, unknown>, mode: "start" | "result" | "fail"): Promise<ServiceWriteResult> {
  try {
    let existed = false;
    const receipt = await executeServerCommand(canvasId, AGENT_ACTOR_ID, (reader) => {
      const node = reader.getNode(nodeId);
      existed = !!node;
      if (!node) return null;
      const claim = claimOf(reader, nodeId);
      if (mode !== "start" && node.data.generationId !== generationId) throw new AgentCommandError("节点已有更新的生成任务", 409);
      if (claim && claim.id !== generationId) throw new AgentCommandError("生成任务已不再属于该节点", 409);
      return { kind: "apply_generation", payload: { nodeId, generationId, claimId: generationId, assets: [], patch, mode } };
    }, { origin: "agent" });
    if (!existed) throw new AgentCommandError("节点已删除", 409);
    return statusOf(receipt, nodeId, existed);
  } catch (error) { agentError(error); }
}
