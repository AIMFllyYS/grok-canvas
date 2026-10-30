"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Edge,
  type Node,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { compilePrompt, referencePattern, type PromptReference } from "@/lib/prompt-references";
import { useTheme } from "next-themes";
import { useWorkspacePreferences } from "../workspace-preferences";
import { interactionConfig, interactionShortcut, type InteractionMode } from "@/lib/canvas-interaction";
import { assetsFromOutcome, collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets, type CanvasLibraryAsset, type CanvasLibrarySource } from "@/lib/canvas-library";
import { createChangeTracker, waitForGestureIdle, versionAfterCommit } from "@/lib/canvas-runtime/change-tracker";
import { createGeometryJournal, restoreGeometry, type GeometryCheckpoint } from "@/lib/canvas-runtime/geometry-journal";
import { createGestureStore, type GestureResult } from "@/lib/canvas-runtime/gesture-store";
import { applyFlowGeometry, buildMoveItems, createConfirmedGeometry, displayGeometry, keepLocalGeometry, routeNodeChanges, type ConfirmedGeometry, type ConfirmedSnapshot } from "@/lib/canvas-runtime/scene-adapter";
import { createGeometryChannel, type GeometryChannel, type GeometryConflict, type ReconcileCandidate } from "@/lib/canvas-runtime/geometry-channel";
import { openOutbox, type PostResult } from "@/lib/canvas-runtime/outbox";
import type { HistoryEntry } from "@/lib/canvas-runtime/history";
import type { CanvasCommand, Geometry } from "@/lib/canvas-runtime/types";
import { CanvasScene } from "./canvas-scene";
import { type CanvasOperation } from "@/lib/canvas-operations";
import { generationClaim } from "@/lib/generation-claim-client";
import { canvasDraftKey, clearCanvasDraft, loadCanvasDraft, loadGeometryCheckpoints, saveGeometryCheckpoint } from "@/lib/canvas-drafts";
import { toDraftBody, translateUserWrites } from "@/lib/canvas-runtime/user-actions";
import { persistImageOutcome, persistVideoOutcome, postServiceWrite, type ServiceWriteBody } from "@/lib/canvas-persistence";
import { addFixedReferences, resolveCanvasReferences } from "@/lib/canvas-references";
import { uploadAssets, type UploadProgress, type UploadedAsset } from "@/lib/asset-upload";
import { CanvasAssetsContext, type ReferencePickerOptions } from "./canvas-assets-context";
import { AssetLibrary } from "./asset-library";
import { ReferencePicker } from "./reference-picker";
import {
  compileVideoPrompt,
  defaultNewVideoRole,
  parseVideoEdgeRole,
  VIDEO_REFERENCE_MAX,
  type VideoInput,
  type VideoInputRole,
} from "@/lib/video-references";
import { clampVideoParameters, type VideoAspectRatio, type VideoDuration, type VideoResolution } from "@/lib/video-request";
import {
  applyGenerationOutcome,
  normalizeNodeResults,
  parseGenerationCount,
  UNCONFIRMED_RESULT_MESSAGE,
  type BatchSlotLike,
  type CandidateResult,
  type GenerationCount,
  type GenerationOutcome,
} from "@/lib/multi-image";
import type { CanvasDoc } from "@/lib/canvas-store";
import { canvasSaveErrorMessage, type CanvasSaveStatus } from "@/lib/save-status";
import { AssetNode } from "./asset-node";
import {
  clearPending,
  dispatchOutcome,
  hasPendingFrom,
  isPending,
  markPending,
  pendingFor,
  registerCanvas,
  stashOrphan,
  takeOrphan,
  unregisterCanvas,
} from "./generation-registry";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasEmptyState } from "./canvas-empty-state";
import { CandidatePanel } from "./candidate-panel";
import { PromptPanel } from "./prompt-panel";
import { FloatingMenu, MenuItem as MenuButton } from "@/components/ui/floating-menu";
import { ControlButton } from "@/components/ui/control-button";
import { ScissorEdge } from "./scissor-edge";
import { useAuth } from "@/components/auth-status";
import { useDesktopAvailable } from "@/components/desktop-workspace";
import { LOGIN_REQUIRED_MESSAGE, loginRequired } from "@/lib/generation-auth-feedback";
import {
  dispatchVideoView,
  isVideoWatchStopStatus,
  isWatchingVideo,
  recoverVideoJobs,
  registerVideoCanvas,
  rememberSubmittedVideoTask,
  stashVideoOrphan,
  submitVideoJob,
  submittedVideoTask,
  takeVideoOrphan,
  unregisterVideoCanvas,
  videoNodePatchFromView,
  watchVideoTask,
  type VideoGenerationRequest,
  type VideoTaskView,
} from "@/lib/video-runtime";
import {
  ATTACHMENT_MAX,
  defaultImageNodeData,
  ImageNode,
  type ImageFlowNode,
  type ImageNodeData,
} from "./image-node";
import { defaultVideoNodeData, VideoNode, type VideoFlowNode, type VideoNodeData } from "./video-node";
import { TextNode, type TextFlowNode } from "./text-node";

const nodeTypes = { image: ImageNode, asset: AssetNode, video: VideoNode, canvasText: TextNode };
const edgeTypes = { scissor: ScissorEdge };

function videoEdgeRole(edge: Edge): VideoInputRole {
  return parseVideoEdgeRole((edge.data as { role?: unknown } | undefined)?.role);
}

function videoOccupancy(nodeId: string, nodes: Node[], edges: Edge[]): Array<{ role: VideoInputRole }> {
  const node = nodes.find((item) => item.id === nodeId);
  const uploads = ((node?.data as VideoNodeData | undefined)?.uploadInputs) ?? [];
  return [
    ...edges.filter((edge) => edge.target === nodeId && nodes.find(node => node.id === edge.source)?.type !== "canvasText").map((edge) => ({ role: videoEdgeRole(edge) })),
    ...uploads,
  ];
}

function connectRejectMessage(targetType: string | undefined): string {
  if (targetType === "video") return "无法连线：来源需为图片，且视频素材槽未满";
  if (targetType === "image") return `无法连线：目标需为图片节点，附件最多 ${ATTACHMENT_MAX} 个`;
  return "无法连线：目标需为图片或视频节点";
}

type GenerateOverrides = {
  prompt?: string;
  aspectRatio?: string;
  resolution?: "1k" | "2k";
  quality?: "low" | "medium";
  count?: GenerationCount;
  retry?: boolean;
  retrySlotId?: string;
};

type GenerateVideoOverrides = {
  prompt?: string;
  duration?: VideoDuration;
  aspectRatio?: VideoAspectRatio | null;
  resolution?: VideoResolution;
  audio?: boolean;
  retry?: boolean;
};

type CanvasActions = {
  canvasId: string;
  /** 本标签页 outbox 的 actorId：编辑租约以它为 owner，自己的命令不被自己的租约挡住。 */
  actorId: () => string | null;
  flushEdits: () => Promise<boolean>;
  generate: (nodeId: string, overrides?: GenerateOverrides) => void;
  generateVideo: (nodeId: string, overrides?: GenerateVideoOverrides) => void;
  setPrimaryResult: (nodeId: string, slotId: string) => void;
  copyCandidateAsNode: (sourceNodeId: string, slotId: string) => void;
  openCandidates: (nodeId: string) => void;
  closeCandidates: (restoreFocus?: boolean) => void;
  expandedNodeId: string | null;
  isNodeGenerationLocked: (nodeId: string) => boolean;
  panelNodeId: string | null;
  removeEdge: (edgeId: string) => void;
  requestAttachmentUpload: (nodeId: string, options?: { role?: VideoInputRole }) => void;
};

const CanvasActionsContext = createContext<CanvasActions>({
  canvasId: "",
  actorId: () => null,
  flushEdits: async () => false,
  generate: () => {},
  generateVideo: () => {},
  setPrimaryResult: () => {},
  copyCandidateAsNode: () => {},
  openCandidates: () => {},
  closeCandidates: () => {},
  expandedNodeId: null,
  isNodeGenerationLocked: () => false,
  panelNodeId: null,
  removeEdge: () => {},
  requestAttachmentUpload: () => {},
});

/** 拖拽事件停滞超过这个时长，才认为指针已在别处松开（隐藏窗口里 rAF 会降到约 1Hz）。 */
const DRAG_STALE_MS = 1500;

export type { GenerateOverrides };

export function useCanvasActions(): CanvasActions {
  return useContext(CanvasActionsContext);
}

type MenuState =
  | { kind: "pane"; x: number; y: number; flow: { x: number; y: number } }
  | { kind: "node"; x: number; y: number; nodeId: string }
  | { kind: "selection"; x: number; y: number; nodeIds: string[] }
  | { kind: "edge"; x: number; y: number; edgeId: string }
  | { kind: "connect-create"; x: number; y: number; flow: { x: number; y: number }; sourceId: string }
  | { kind: "add" }
  | null;

type GenerateResponse = {
  slots?: BatchSlotLike[];
  error?: { kind: string; message: string };
};

type UndoEntry =
  | { type: "delete"; nodes: Node[]; edges: Edge[] }
  | { type: "add"; nodes: Node[]; edges: Edge[] }
  // 几何走 P2-04 字段版本历史：commandId 指向已确认命令的 HistoryEntry，撤销/重做是新的条件命令。
  | { type: "geometry"; commandId: string }
  | {
      type: "setPrimary";
      nodeId: string;
      prev: { primaryResultId: string | null; assetName: string | null };
      next: { primaryResultId: string | null; assetName: string | null };
    };

function undoTargets(entry: UndoEntry): string[] {
  if (entry.type === "geometry") return [];
  if (entry.type === "setPrimary") return [`node:${entry.nodeId}`];
  return [...entry.nodes.map(node => `node:${node.id}`), ...entry.edges.map(edge => `edge:${edge.id}`)];
}

/** 领域命令入口（P2-03）；网络异常抛出，由 outbox 发送器按“结果不明”重发原 envelope。 */
async function postCanvasCommand(command: CanvasCommand): Promise<PostResult> {
  const response = await fetch(`/api/canvases/${encodeURIComponent(command.canvasId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => ({})) as { receipt?: unknown; error?: { code?: string; message?: string; retryAfterMs?: number } };
  if (response.ok && body.receipt) return { ok: true, receipt: body.receipt as Extract<PostResult, { ok: true }>["receipt"] };
  return { ok: false, status: response.status, ...(body.error ? { error: body.error } : {}) };
}

async function fetchEntitySnapshot(canvasId: string): Promise<ConfirmedSnapshot> {
  const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/entities?fields=geometry`, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取画布版本失败（${response.status}）`);
  return await response.json() as ConfirmedSnapshot;
}

/** 生成开始时交给服务端的 service 字段（与 generation-commands 的 START_FIELDS 一致）；其余 user 字段走 patch_nodes。 */
const SERVICE_START_FIELDS = new Set(["status", "generationId", "errorMessage", "errorKind", "retryingSlotId", "generationRequest", "taskId", "waitedSeconds"]);

/** 删除墓碑禁止同 ID 复活（contracts.md C3）：重建的节点与连线用新 ID，两端都在集合内的连线重映射。 */
function rebuildWithNewIds(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const idMap = new Map(nodes.map(node => [node.id, crypto.randomUUID()]));
  return {
    nodes: nodes.map(node => ({ ...node, id: idMap.get(node.id)!, selected: false })),
    edges: edges.map(edge => ({ ...edge, id: crypto.randomUUID(), source: idMap.get(edge.source) ?? edge.source, target: idMap.get(edge.target) ?? edge.target })),
  };
}

const hasExplicitSize = (node: Node) => typeof node.width === "number" && typeof node.height === "number";
const geometryPoint = (node: Node) => ({ x: node.position.x, y: node.position.y, ...(hasExplicitSize(node) ? { width: node.width!, height: node.height! } : {}) });
const sameGeometryPoint = (a: ReturnType<typeof geometryPoint>, b: ReturnType<typeof geometryPoint>) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * 生成结束时发起画布已不在前台：读最新存档，更新占位节点后整体 PUT。
 * 409 时重取一次再写；图片资产已落盘，失败只丢画布引用。
 * 节点已被删除时暂存 orphan，等待用户撤销删除后补写。
 */
async function persistResultToOriginCanvas(
  canvasId: string,
  sourceNodeId: string,
  outcome: GenerationOutcome,
): Promise<void> {
  try {
    await persistImageOutcome(canvasId, sourceNodeId, outcome, { orphan: () => stashOrphan(canvasId, sourceNodeId, outcome) });
  } catch { toast.error("生成完成，但写回原画布失败，请刷新对应画布检查"); }
}

async function persistVideoToOriginCanvas(
  canvasId: string,
  sourceNodeId: string,
  view: VideoTaskView,
): Promise<void> {
  try {
    await persistVideoOutcome(canvasId, sourceNodeId, view, { orphan: () => stashVideoOrphan(canvasId, sourceNodeId, view) });
  } catch { toast.error("生成完成，但写回原画布失败，请刷新对应画布检查"); }
}

// 来源右侧不重叠空位：右移一格，被占用则向下避让
function freeSpotRightOf(origin: { x: number; y: number }, nodes: Node[]): { x: number; y: number } {
  let position = { x: origin.x + 380, y: origin.y };
  while (nodes.some((item) => Math.abs(item.position.x - position.x) < 300 && Math.abs(item.position.y - position.y) < 300)) {
    position = { ...position, y: position.y + 360 };
  }
  return position;
}

export function FlowCanvas({
  doc,
  baseline,
  onRegisterFlush,
  onSaveStatus,
  onRestoreName,
}: {
  doc: CanvasDoc;
  baseline: CanvasDoc;
  onRegisterFlush?: (flush: () => Promise<boolean>) => void;
  onSaveStatus?: (status: CanvasSaveStatus) => void;
  onRestoreName?: (name: string) => void;
}) {
  const desktopAvailable = useDesktopAvailable();
  const { resolvedTheme } = useTheme();
  const { layout } = useWorkspacePreferences();
  const [mode, setMode] = useState<InteractionMode>("select");
  const [dragging, setDragging] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState(() => normalizeLibraryAssets(doc.libraryAssets));
  const [generationClaims, setGenerationClaims] = useState(() => doc.generationClaims ?? {});
  const libraryRef = useRef(libraryAssets);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const pendingUploads = useRef(new Set<Promise<unknown>>());
  const [picker, setPicker] = useState<({ nodeId: string } & ReferencePickerOptions) | null>(null);
  const dirtyVersion = useRef(0);
  const savedVersion = useRef(0);
  const mounted = useRef(true);
  const { loggedIn, refresh: refreshAuth } = useAuth();
  const [changes] = useState(createChangeTracker);
  const [geometry] = useState(() => createGeometryJournal());
  // 正式工作文档：拖动/resize 途中不变；React Flow 看到的是 CanvasScene 的投影（正式文档 + 手势覆盖层）。
  const [gesture] = useState(createGestureStore);
  const [nodes, setNodesFromSync, applyNodesChange] = useNodesState<Node>(doc.nodes as Node[]);
  const [edges, setEdgesFromSync, applyEdgesChange] = useEdgesState<Edge>(doc.edges as Edge[]);
  const setNodes = useCallback<typeof setNodesFromSync>((value) => {
    changes.mutate();
    setNodesFromSync(value);
  }, [changes, setNodesFromSync]);
  const setEdges = useCallback<typeof setEdgesFromSync>((value) => {
    changes.mutate(false);
    setEdgesFromSync(value);
  }, [changes, setEdgesFromSync]);
  const commitGeometryRef = useRef<(result: GestureResult | null) => void>(() => {});
  const replayGeometryRef = useRef<(entry: { type: "geometry"; commandId: string }, direction: "undo" | "redo") => void>(() => {});
  const lookupGeometry = useCallback((id: string) => {
    const node = latestRef.current.nodes.find(item => item.id === id);
    return node ? displayGeometry(node) : undefined;
  }, []);
  const onNodesChange = useCallback((items: NodeChange<Node>[]) => {
    // 拖动/resize 进行中只进覆盖层；选择、自然测量、增删进正式文档；松手后提交一条几何命令。
    const routed = routeNodeChanges(items, gesture, lookupGeometry);
    changes.nodes(routed.tracker);
    if (routed.formal.length) applyNodesChange(routed.formal);
    if (routed.discrete.length) commitGeometryRef.current({ kind: "drag", items: routed.discrete });
    if (routed.finished) commitGeometryRef.current(gesture.end());
  }, [changes, applyNodesChange, gesture, lookupGeometry]);
  const onEdgesChange = useCallback((items: EdgeChange<Edge>[]) => {
    changes.edges(items);
    applyEdgesChange(items);
  }, [changes, applyEdgesChange]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [panelNodeId, setPanelNodeId] = useState<string | null>(null);
  // 同时只展开一个候选面板；展开时收起提示词面板
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const expandedNodeIdRef = useRef<string | null>(null);
  expandedNodeIdRef.current = expandedNodeId;
  const openCandidates = useCallback((nodeId: string) => {
    setMenu(null);
    setPanelNodeId(null);
    setExpandedNodeId(nodeId);
  }, []);
  const closeCandidates = useCallback((restoreFocus = true) => {
    const current = expandedNodeIdRef.current;
    setExpandedNodeId(null);
    // 关闭后焦点返回角标入口
    if (current && restoreFocus) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-candidate-badge="${CSS.escape(current)}"]`)?.focus();
      });
    }
  }, []);
  // 小窗口隐藏工作区、节点被删除/撤销掉时关闭候选浮层
  useEffect(() => {
    if (!desktopAvailable) {
      setExpandedNodeId(null);
    }
  }, [desktopAvailable]);
  useEffect(() => {
    if (expandedNodeId && !nodes.some((node) => node.id === expandedNodeId)) {
      setExpandedNodeId(null);
    }
  }, [expandedNodeId, nodes]);
  // React Flow reruns its selection effect when this callback's identity changes.
  // Keep it stable so dismissing the panel cannot immediately reopen it.
  // 提交生成时新结果节点会独占选中，用一次标记跳过这次自动打开面板（提交后收面板、留草稿）
  const suppressPanelForSelectionRef = useRef(false);
  const onSelectionChange = useCallback(({ nodes: selectedNodes }: { nodes: Node[] }) => {
    // 选中变化（点别的节点/框选）收起候选扇形；焦点不返回角标
    closeCandidates(false);
    if (suppressPanelForSelectionRef.current) {
      suppressPanelForSelectionRef.current = false;
      setPanelNodeId(null);
      return;
    }
    setPanelNodeId(selectedNodes.length === 1 ? (selectedNodes[0]?.id ?? null) : null);
  }, [closeCandidates]);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const { screenToFlowPosition, updateNodeData, zoomIn, zoomOut, zoomTo, setViewport } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const libraryUploadInputRef = useRef<HTMLInputElement>(null);
  const libraryUploadSourceRef = useRef<CanvasLibrarySource>("imported");
  const attachInputRef = useRef<HTMLInputElement>(null);
  const uploadAtRef = useRef({ x: 0, y: 0 });
  const attachTargetRef = useRef<string | null>(null);
  const attachRoleRef = useRef<VideoInputRole | undefined>(undefined);
  const menuOpenedAtRef = useRef(0);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const remoteClockRef = useRef(new Map<string, number>());
  const undoClockRef = useRef(new WeakMap<UndoEntry, Map<string, number>>());
  const pushUndo = useCallback((entry: UndoEntry) => {
    undoClockRef.current.set(entry, new Map(undoTargets(entry).map(key => [key, remoteClockRef.current.get(key) ?? 0])));
    undoStackRef.current.push(entry);
  }, []);
  const undoStillValid = (entry: UndoEntry) => {
    const clock = undoClockRef.current.get(entry);
    return clock && undoTargets(entry).every(key => (clock.get(key) ?? 0) === (remoteClockRef.current.get(key) ?? 0));
  };
  const clipboardRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  // 拖拽在途：React Flow 的 onNodeDrag* 事件流还活着时，失焦不能让保存闸门提前打开。
  const dragRef = useRef({ active: false, at: 0 });
  // 几何命令（P2-06）：确认版本缓存、命令通道、已确认命令的字段版本历史。恢复屏障完成后才有值。
  const confirmedRef = useRef<ConfirmedGeometry | null>(null);
  const channelRef = useRef<GeometryChannel | null>(null);
  const historyRef = useRef(new Map<string, HistoryEntry>());

  // 新建类操作入撤销栈（新建节点/上传/粘贴/连线）
  const pushAdd = useCallback((addedNodes: Node[], addedEdges: Edge[]) => {
    pushUndo({ type: "add", nodes: addedNodes, edges: addedEdges });
    redoStackRef.current = [];
  }, [pushUndo]);

  const revisionRef = useRef(doc.revision);
  const acknowledgedRef = useRef<CanvasDoc>(baseline);
  const draftKeyRef = useRef("");
  const draftReadyRef = useRef(false);
  const [draftReady, setDraftReady] = useState(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const onRestoreNameRef = useRef(onRestoreName);
  onRestoreNameRef.current = onRestoreName;
  const viewportRef = useRef<Viewport>(doc.viewport);
  const viewportDirtyRef = useRef(false);
  const viewportVersionRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveOkRef = useRef(true);
  const checkpointFailedRef = useRef(false);
  const latestRef = useRef({ nodes, edges });
  latestRef.current = { nodes, edges };
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = null;
  }, []);
  const onSaveStatusRef = useRef(onSaveStatus);
  onSaveStatusRef.current = onSaveStatus;

  const reportSave = (status: CanvasSaveStatus) => {
    saveOkRef.current = status.ok;
    onSaveStatusRef.current?.(status);
    if (!status.ok) {
      toast.error(status.message);
    }
  };

  const persistGeometry = useCallback((checkpoint: GeometryCheckpoint | null) => {
    if (!checkpoint || !draftReadyRef.current) return;
    void saveGeometryCheckpoint(draftKeyRef.current, doc.id, checkpoint).catch(() => {
      if (!checkpointFailedRef.current) {
        checkpointFailedRef.current = true;
        reportSave({ ok: false, message: "坐标检查点写入失败，请保持页面打开并重试保存" });
      }
    });
  }, [doc.id]);
  // 坐标日志只负责崩溃恢复检查点；撤销历史来自几何命令的回执（P2-04）。
  const finishGeometry = useCallback((draggedNodes?: Node[] | Array<{ id: string; position: { x: number; y: number } }>) => {
    if (draggedNodes) geometry.update(draggedNodes);
    persistGeometry(geometry.finish());
  }, [geometry, persistGeometry]);

  // ---- 持久化（P2-07）：用户写入 → 领域命令进 outbox；只剩 service 字段/视口/素材库走显式命名的兼容写入 ----
  // committedRef 是“已转成命令（或已从远端合并）”的节点/连线对象；保存只看引用被替换过的实体，不做整图 diff。
  const committedRef = useRef({ nodes: new Map<string, Node>(), edges: new Map<string, Edge>() });
  const markCommitted = useCallback((nodes: readonly Node[], edges: readonly Edge[]) => {
    committedRef.current = { nodes: new Map(nodes.map(node => [node.id, node])), edges: new Map(edges.map(edge => [edge.id, edge])) };
  }, []);
  // 画布字段兼容写入：视口与素材库列表没有领域命令，仍走旧 operations 接口，只为变化的字段生成条目。
  // （P2-08 起 service 字段只由服务端 apply_generation 写入，这里不再处理。）
  const canvasFieldWrites = useMemo(() => ({
    pending: [] as CanvasOperation[],
    canvasFields(base: CanvasDoc, viewport: Viewport | null, library: CanvasLibraryAsset[]): CanvasOperation[] {
      const ops: CanvasOperation[] = [];
      if (viewport && JSON.stringify(viewport) !== JSON.stringify(base.viewport)) ops.push({ id: crypto.randomUUID(), target: "canvas", path: ["viewport"], before: { exists: true, value: base.viewport }, after: { exists: true, value: viewport } });
      if (JSON.stringify(library) !== JSON.stringify(base.libraryAssets ?? [])) ops.push({ id: crypto.randomUUID(), target: "canvas", path: ["libraryAssets"], before: base.libraryAssets === undefined ? { exists: false } : { exists: true, value: base.libraryAssets }, after: { exists: true, value: library } });
      return ops;
    },
  }), []);

  const save = useCallback(async () => {
    const channel = channelRef.current, confirmed = confirmedRef.current;
    if (savingRef.current || !draftReadyRef.current || changes.active() || !channel || !confirmed) {
      return;
    }
    clearDraftTimer();
    savingRef.current = true;
    const version = dirtyVersion.current;
    const viewportVersion = viewportVersionRef.current;
    const checkpointThrough = geometry.through();
    try {
      // 1) 用户写入 → 命令（先进持久 outbox 才算接收），提交后的对象成为新的比较基线。
      const { nodes: localNodes, edges: localEdges } = latestRef.current;
      const writes = translateUserWrites({ canvasId: doc.id, committedNodes: committedRef.current.nodes, committedEdges: committedRef.current.edges, nodes: localNodes, edges: localEdges, versions: confirmed });
      const body = toDraftBody(writes.commands);
      if (body) await channel.submitCommand(body as { kind: CanvasCommand["kind"]; payload: unknown });
      for (const issue of writes.issues) console.warn(issue);
      // P2-08：service 字段（生成状态/结果/主图）只由服务端 apply_generation 写入，本地值只作视图，不再发送。
      markCommitted(localNodes, localEdges);
      if (body) void channel.flush();
      // 2) 画布字段兼容写入：只剩视口与素材库（没有对应领域命令）。
      const canvasOps = canvasFieldWrites.canvasFields(acknowledgedRef.current, viewportDirtyRef.current ? viewportRef.current : null, libraryRef.current);
      const operations = [...canvasFieldWrites.pending, ...canvasOps];
      if (!await waitForGestureIdle(changes, () => mounted.current)) return;
      const response = operations.length
        ? await fetch(`/api/canvases/${doc.id}/operations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operations }) })
        : await fetch(`/api/canvases/${doc.id}?background=1&sinceRevision=${acknowledgedRef.current.revision}`, { cache: "no-store" });
      if (operations.length && response.status !== 409 && response.status < 500) canvasFieldWrites.pending = [];
      if (response.status === 409) canvasFieldWrites.pending = [];
      // 在途响应不得在新的手势中途重建整图或回写坐标。
      if (!await waitForGestureIdle(changes, () => mounted.current)) return;
      let payload: CanvasDoc | null = null;
      if (response.status === 304) payload = null;
      else if (response.ok) payload = await response.json() as CanvasDoc;
      else if (response.status === 409) {
        // 生成状态等 service 字段已被服务端改变：放弃本地版本，取最新文档合并。
        const latest = await fetch(`/api/canvases/${doc.id}?background=1`, { cache: "no-store" });
        if (latest.ok) payload = await latest.json() as CanvasDoc;
      } else {
        const failure = await response.json().catch(() => ({})) as { error?: { message?: string } };
        reportSave({ ok: false, message: canvasSaveErrorMessage({ kind: "http", status: response.status, message: failure.error?.message }) });
        return;
      }
      if (!await waitForGestureIdle(changes, () => mounted.current)) return;
      if (payload) {
        // 3) 远端合并：有未确认本地命令或未提交本地修改的实体保留本地，其余取远端。
        const previous = acknowledgedRef.current;
        const previousNodes = new Map((previous.nodes as Node[]).map(node => [node.id, node]));
        const mark = (key: string) => remoteClockRef.current.set(key, (remoteClockRef.current.get(key) ?? 0) + 1);
        for (const node of payload.nodes as Node[]) {
          const before = previousNodes.get(node.id);
          if (!before || JSON.stringify(before) !== JSON.stringify(node)) mark(`node:${node.id}`);
        }
        const current = latestRef.current;
        const committed = committedRef.current;
        const localById = new Map(current.nodes.map(node => [node.id, node]));
        const remoteIds = new Set((payload.nodes as Node[]).map(node => node.id));
        const newerLocal = confirmed.revision() > payload.revision;
        const keepLocal = (id: string) => {
          const local = localById.get(id);
          return !!local && (local !== committed.nodes.get(id) || confirmed.nodePending(id) || (newerLocal && confirmed.has(id)));
        };
        const remoteNodes = keepLocalGeometry(payload.nodes as Node[], current.nodes, id => channel.isPending(id));
        const mergedNodes: Node[] = [];
        for (const node of remoteNodes) {
          if (!localById.has(node.id) && confirmed.nodePending(node.id)) continue; // 本地删除待确认
          const local = localById.get(node.id);
          if (local && keepLocal(node.id)) { mergedNodes.push(local); continue; }
          const claimId = typeof node.data.sourceNodeId === "string" ? node.data.sourceNodeId : node.id;
          const claim = payload.generationClaims?.[claimId];
          const data = claim?.state === "unknown" && node.data.generationId === claim.id
            ? { ...node.data, status: "failed", errorMessage: UNCONFIRMED_RESULT_MESSAGE, errorKind: "network" }
            : node.data;
          mergedNodes.push(local ? { ...node, data, selected: local.selected, dragging: local.dragging, measured: local.measured } : { ...node, data, selected: false });
        }
        for (const local of current.nodes) if (!remoteIds.has(local.id) && keepLocal(local.id)) mergedNodes.push(local);
        const localEdges = new Map(current.edges.map(edge => [edge.id, edge]));
        const remoteEdgeIds = new Set((payload.edges as Edge[]).map(edge => edge.id));
        const keepLocalEdge = (id: string) => { const local = localEdges.get(id); return !!local && (local !== committed.edges.get(id) || confirmed.edgePending(id)); };
        const mergedEdges: Edge[] = [];
        for (const edge of payload.edges as Edge[]) {
          if (!localEdges.has(edge.id) && confirmed.edgePending(edge.id)) continue;
          const local = localEdges.get(edge.id);
          mergedEdges.push(local && keepLocalEdge(edge.id) ? local : { ...edge, type: "scissor", selected: local?.selected });
        }
        for (const local of current.edges) if (!remoteEdgeIds.has(local.id) && keepLocalEdge(local.id)) mergedEdges.push(local);
        acknowledgedRef.current = payload;
        if (payload.name !== docRef.current.name) onRestoreNameRef.current?.(payload.name);
        setGenerationClaims(payload.generationClaims ?? {});
        revisionRef.current = payload.revision;
        const nodesChanged = mergedNodes.length !== current.nodes.length || mergedNodes.some((node, index) => node !== current.nodes[index]);
        const edgesChanged = mergedEdges.length !== current.edges.length || mergedEdges.some((edge, index) => edge !== current.edges[index]);
        // 合并来的远端对象直接作为基线：不会被当成本地修改再发回去。
        const nextCommittedNodes = new Map(committed.nodes);
        for (const node of mergedNodes) if (!keepLocal(node.id)) nextCommittedNodes.set(node.id, node);
        for (const id of [...nextCommittedNodes.keys()]) if (!mergedNodes.some(node => node.id === id) && !confirmed.nodePending(id)) nextCommittedNodes.delete(id);
        const nextCommittedEdges = new Map(committed.edges);
        for (const edge of mergedEdges) if (!keepLocalEdge(edge.id)) nextCommittedEdges.set(edge.id, edge);
        for (const id of [...nextCommittedEdges.keys()]) if (!remoteEdgeIds.has(id) && !confirmed.edgePending(id)) nextCommittedEdges.delete(id);
        committedRef.current = { nodes: nextCommittedNodes, edges: nextCommittedEdges };
        latestRef.current = { nodes: mergedNodes, edges: mergedEdges };
        if (mounted.current) {
          if (nodesChanged) setNodesFromSync(mergedNodes);
          if (edgesChanged) setEdgesFromSync(mergedEdges);
        }
        // 旧路径新增的节点进入服务端后，取一次版本。
        if ((payload.nodes as Node[]).some(node => !confirmed.known(node.id))) {
          void fetchEntitySnapshot(doc.id).then(snapshot => { if (confirmedRef.current === confirmed) confirmed.load(snapshot); }).catch(() => {});
        }
        const merged = mergeLibraryAssets(libraryRef.current, normalizeLibraryAssets(payload.libraryAssets));
        if (merged !== libraryRef.current && mounted.current) { libraryRef.current = merged; setLibraryAssets(merged); }
      }
      if (viewportVersionRef.current === viewportVersion && !canvasOps.some(op => op.path[0] === "viewport" && response.status >= 400)) viewportDirtyRef.current = false;
      dirtyVersion.current = versionAfterCommit(version, dirtyVersion.current, changes.dirty());
      savedVersion.current = version;
      if (dirtyVersion.current === version && !canvasFieldWrites.pending.length) await clearCanvasDraft(draftKeyRef.current, checkpointThrough);
      checkpointFailedRef.current = false;
      reportSave({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      reportSave({ ok: false, message: detail ? `保存失败：${detail}` : canvasSaveErrorMessage({ kind: "network" }) });
    } finally {
      savingRef.current = false;
      if (mounted.current && savedVersion.current === version && dirtyVersion.current !== version) {
        saveTimerRef.current = setTimeout(() => void save(), 500);
      }
    }
  }, [doc.id, changes, geometry, canvasFieldWrites, markCommitted, clearDraftTimer, setNodesFromSync, setEdgesFromSync]);

  // 命令进持久 outbox 即可恢复，不再每 200ms 把完整工作文档写入草稿。
  const scheduleSave = useCallback(() => {
    dirtyVersion.current++;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void save(), 500);
  }, [save]);

  /**
   * 生成状态回写（P2-08）：本地先更新视图，服务端在画布锁内构造 apply_generation 并核验结果。
   * 发送前先把待提交的用户命令（例如刚新增的占位结果节点）送达，避免结果被当成孤儿。
   * 只把开始/失败允许的 service 字段交给服务端；提示词等 user 字段由保存转成 patch_nodes。
   */
  const serviceWrite = useCallback((body: ServiceWriteBody, local?: Record<string, unknown>) => {
    if (local) updateNodeData(body.nodeId, local);
    void (async () => {
      if (dirtyVersion.current !== savedVersion.current && !changes.active()) await save();
      await channelRef.current?.flush();
      await postServiceWrite(doc.id, body);
    })().catch(error => toast.error(error instanceof Error ? error.message : "生成状态写回失败"));
  }, [doc.id, changes, save, updateNodeData]);
  const startWrite = useCallback((nodeId: string, generationId: string, patch: Record<string, unknown>) => {
    const service = Object.fromEntries(Object.entries(patch).filter(([field]) => SERVICE_START_FIELDS.has(field)));
    serviceWrite({ action: "start", nodeId, generationId, patch: service }, patch);
  }, [serviceWrite]);

  // 切换画布前调用：停掉防抖、等在途保存、把最新状态落盘，返回是否成功
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!draftReadyRef.current || changes.active()) return false;
    while (pendingUploads.current.size) await Promise.allSettled([...pendingUploads.current]);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    while (savingRef.current) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await save();
    // 位置走命令通道：只有 outbox 中的移动都被确认才算已保存。
    const geometrySaved = channelRef.current ? (await channelRef.current.flush()).saved : true;
    return geometrySaved && saveOkRef.current && !changes.active() && !changes.dirty() && dirtyVersion.current === savedVersion.current;
  }, [save, changes]);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const key = canvasDraftKey(doc.id);
        draftKeyRef.current = key;
        markCommitted(docRef.current.nodes as Node[], docRef.current.edges as Edge[]);
        let draft = await loadCanvasDraft(key);
        const checkpoints = await loadGeometryCheckpoints(key, doc.id);
        if (cancelled) return;
        if (checkpoints.length) {
          const recovered = restoreGeometry(draft?.working ?? docRef.current, checkpoints);
          if (recovered.conflicts.length) throw new Error(`坐标恢复冲突（${recovered.conflicts.length} 个节点），原检查点已保留，未覆盖已保存位置`);
          for (const checkpoint of checkpoints) geometry.advance(checkpoint.sequence);
          draft = { key, canvasId: doc.id, base: draft?.base ?? acknowledgedRef.current, working: recovered.document, pending: draft?.pending };
        }
        if (draft && draft.canvasId === doc.id && draft.base?.id === doc.id && draft.working?.id === doc.id) {
          acknowledgedRef.current = draft.base;
          revisionRef.current = draft.base.revision;
          const restoredNodes = draft.working.nodes as Node[], restoredEdges = draft.working.edges as Edge[];
          // v1 全量草稿只在加载恢复时转换一次：以草稿基线为比较起点，首次保存把差异转成命令。
          markCommitted(draft.base.nodes as Node[], draft.base.edges as Edge[]);
          latestRef.current = { nodes: restoredNodes, edges: restoredEdges };
          setNodesFromSync(restoredNodes);
          setEdgesFromSync(restoredEdges);
          changes.mutate();
          libraryRef.current = normalizeLibraryAssets(draft.working.libraryAssets);
          setLibraryAssets(libraryRef.current);
          viewportRef.current = draft.working.viewport;
          viewportDirtyRef.current = JSON.stringify(draft.working.viewport) !== JSON.stringify(draft.base.viewport);
          void setViewport(draft.working.viewport);
          if (draft.working.name !== docRef.current.name) onRestoreNameRef.current?.(draft.working.name);
          dirtyVersion.current++;
          toast.info("已恢复该画布的未保存修改");
        }
        if (!cancelled) {
          // ---- 恢复屏障（P2-06）：先登记 outbox 中未确认的移动，再把本地检查点/草稿坐标转成移动命令，最后才开放编辑。
          const snapshot = await fetchEntitySnapshot(doc.id);
          const outbox = await openOutbox();
          if (cancelled) return;
          const confirmed = createConfirmedGeometry(snapshot);
          const channel = createGeometryChannel({
            canvasId: doc.id,
            outbox,
            confirmed,
            post: postCanvasCommand,
            fetchSnapshot: () => fetchEntitySnapshot(doc.id),
            onHistory: (commandId, entry) => { historyRef.current.set(commandId, entry); },
            onConflict: conflict => geometryHandlersRef.current.conflict(conflict),
            onRemote: geometries => geometryHandlersRef.current.remote(geometries),
            onStatus: status => geometryHandlersRef.current.status(status),
          });
          await channel.start();
          const baseNodes = new Map(((draft?.base ?? docRef.current).nodes as Node[]).map(node => [node.id, node]));
          const candidates: ReconcileCandidate[] = [];
          for (const node of latestRef.current.nodes) {
            const before = baseNodes.get(node.id);
            if (before && !sameGeometryPoint(geometryPoint(before), geometryPoint(node))) candidates.push({ id: node.id, from: geometryPoint(before), to: geometryPoint(node) });
          }
          if (candidates.length) await channel.reconcile(candidates, snapshot);
          if (cancelled) { channel.dispose(); return; }
          confirmedRef.current = confirmed;
          channelRef.current = channel;
          actorIdRef.current = outbox.actorId;
          void channel.flush();
          draftReadyRef.current = true;
          setDraftReady(true);
        }
      } catch (error) {
        if (!cancelled) reportSave({ ok: false, message: `本地恢复失败，已暂停编辑：${error instanceof Error ? error.message : "请刷新重试"}` });
      }
    };
    void restore();
    return () => {
      cancelled = true;
      draftReadyRef.current = false;
      // 卸载/切换画布：进行中的手势按最后坐标提交（入队后由下次打开时发送），再停掉通道。
      if (gesture.active()) commitGeometryRef.current(gesture.end());
      channelRef.current?.dispose();
      channelRef.current = null;
      confirmedRef.current = null;
    };
  }, [doc.id, changes, geometry, gesture, markCommitted, setNodesFromSync, setEdgesFromSync, setViewport]);

  // Pull remote changes without remounting the canvas or interrupting a gesture.
  useEffect(() => {
    if (dragging) return;
    const timer = setInterval(() => {
      if (draftReadyRef.current && saveOkRef.current && !savingRef.current && !latestRef.current.nodes.some(node => node.dragging || node.resizing)) void save();
    }, 2000);
    return () => clearInterval(timer);
  }, [dragging, save]);

  useEffect(() => {
    onRegisterFlush?.(flushSave);
  }, [flushSave, onRegisterFlush]);

  // 卸载（切换画布/删除画布）：停掉未触发的防抖保存
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => {
      if (pendingUploads.current.size || changes.dirty() || dirtyVersion.current !== savedVersion.current || (channelRef.current?.pendingGeometry().size ?? 0) > 0) { event.preventDefault(); event.returnValue = ""; }
    };
    const dragInFlight = () => dragRef.current.active && performance.now() - dragRef.current.at < DRAG_STALE_MS;
    // 覆盖层里的当前坐标：正式文档在手势途中仍是起点。
    const gestureNodes = () => gesture.participants().flatMap(id => { const at = gesture.get(id); return at ? [{ id, position: { x: at.x, y: at.y } }] : []; });
    // 真正收尾一次拖拽：坐标日志落最终检查点，手势按覆盖层最后坐标提交一条命令，同时打开保存闸门。
    const closeDragGesture = () => {
      dragRef.current.active = false;
      finishGeometry(gestureNodes());
      commitGeometryRef.current(gesture.end());
      changes.reset();
      setDragging(false);
      setNodesFromSync(current => current.map(node => node.dragging || node.resizing ? { ...node, dragging: false, resizing: false } : node));
    };
    const resetGesture = () => {
      setDragging(false);
      if (!changes.active()) return;
      // 指针还按在节点上（事件仍在流）：只落检查点、保留手势闸门，
      // 否则 500ms 防抖保存会把拖拽中途的坐标当成一次完整移动写进服务端。
      if (dragInFlight()) {
        persistGeometry(geometry.suspend(gestureNodes()));
        return;
      }
      closeDragGesture();
    };
    const onVisibility = () => { if (document.hidden) resetGesture(); };
    // 指针在别处松开（切窗/最小化）时没人再发 onNodeDragStop，事件停滞后自行收尾，
    // 避免手势闸门永久关闭、后续修改再也保存不了。
    const watchdog = window.setInterval(() => {
      if (!dragRef.current.active) return;
      if (performance.now() - dragRef.current.at < DRAG_STALE_MS) return;
      // 可见且聚焦时可能只是按住不动，交给正常事件收尾。
      if (!document.hidden && document.hasFocus()) return;
      closeDragGesture();
    }, 500);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", resetGesture);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("blur", resetGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(watchdog);
      clearDraftTimer();
      mounted.current = false;
      window.removeEventListener("beforeunload", warn);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [changes, clearDraftTimer, finishGeometry, geometry, gesture, latestRef, persistGeometry, setNodesFromSync]);

  const registerAssets = useCallback((items: CanvasLibraryAsset[]) => {
    const next = mergeLibraryAssets(libraryRef.current, items);
    if (next !== libraryRef.current) { libraryRef.current = next; setLibraryAssets(next); scheduleSave(); }
  }, [scheduleSave]);

  // 生成结局落地：整批一次写入；节点已删则暂存 orphan，等撤销删除后补写
  const applyOutcome = useCallback(
    (nodeId: string, outcome: GenerationOutcome) => {
      registerAssets(assetsFromOutcome(outcome, new Date().toISOString()));
      const node = latestRef.current.nodes.find((item) => item.id === nodeId);
      if (!node) {
        stashOrphan(doc.id, nodeId, outcome);
        return;
      }
      const patch = applyGenerationOutcome(node.data, outcome, () => crypto.randomUUID());
      if (patch) {
        serviceWrite({ action: "image", nodeId, outcome }, patch);
      }
    },
    [doc.id, updateNodeData, registerAssets],
  );

  // 注册为前台画布接收生成结果；挂载时恢复仍在进行中的 loading 状态、补写 orphan
  useEffect(() => {
    const handlers = { applyOutcome };
    registerCanvas(doc.id, handlers);
    for (const node of latestRef.current.nodes) {
      const orphan = takeOrphan(doc.id, node.id);
      if (orphan) {
        const patch = applyGenerationOutcome(node.data, orphan, () => crypto.randomUUID());
        if (patch) {
          serviceWrite({ action: "image", nodeId: node.id, outcome: orphan }, patch);
        }
        continue;
      }
      // 刷新后不恢复图片"生成中"：无法确认的任务标记结果未知。视频凭 taskId 恢复轮询。
      if (node.data.status === "running" && !isPending(doc.id, node.id) && !doc.generationClaims?.[node.id]) {
        if (
          node.type === "video" &&
          ((typeof node.data.taskId === "string" && node.data.taskId) || submittedVideoTask(doc.id, node.id))
        ) {
          continue;
        }
        if (typeof node.data.generationId === "string") serviceWrite({ action: "fail", nodeId: node.id, generationId: node.data.generationId, patch: { status: "failed", errorMessage: UNCONFIRMED_RESULT_MESSAGE } }, { status: "failed", errorMessage: UNCONFIRMED_RESULT_MESSAGE });
        else updateNodeData(node.id, { status: "failed", errorMessage: UNCONFIRMED_RESULT_MESSAGE });
      }
    }
    for (const pendingNodeId of pendingFor(doc.id)) {
      if (latestRef.current.nodes.some((item) => item.id === pendingNodeId)) {
        updateNodeData(pendingNodeId, { status: "running" });
      } else {
        clearPending(doc.id, pendingNodeId);
      }
    }
    return () => unregisterCanvas(doc.id, handlers);
  }, [doc.id, applyOutcome, updateNodeData]);

  const applyVideoView = useCallback(
    (nodeId: string, view: VideoTaskView) => {
      const node = latestRef.current.nodes.find((item) => item.id === nodeId);
      if (!node) {
        stashVideoOrphan(doc.id, nodeId, view);
        if (isVideoWatchStopStatus(view.status)) clearPending(doc.id, nodeId);
        return;
      }
      if (typeof node.data.generationId === "string" && view.generationId && node.data.generationId !== view.generationId) return;
      serviceWrite({ action: "video", nodeId, taskId: view.taskId }, videoNodePatchFromView(view));
      if (isVideoWatchStopStatus(view.status)) clearPending(doc.id, nodeId);
    },
    [doc.id, updateNodeData],
  );

  const startVideoWatch = useCallback(
    (nodeId: string, taskId: string) => {
      watchVideoTask(doc.id, nodeId, taskId, (view) => {
        if (!dispatchVideoView(doc.id, nodeId, view) && isVideoWatchStopStatus(view.status)) {
          void persistVideoToOriginCanvas(doc.id, nodeId, view);
        }
      });
    },
    [doc.id],
  );

  useEffect(() => {
    const handlers = { applyVideoView };
    registerVideoCanvas(doc.id, handlers);
    for (const node of latestRef.current.nodes) {
      if (node.type !== "video") continue;
      const orphan = takeVideoOrphan(doc.id, node.id);
      if (orphan) serviceWrite({ action: "video", nodeId: node.id, taskId: orphan.taskId }, videoNodePatchFromView(orphan));
    }
    void (async () => {
      try {
        const recovered = await recoverVideoJobs();
        for (const view of recovered) {
          if (view.canvasId !== doc.id) continue;
          applyVideoView(view.nodeId, view);
          if (!isVideoWatchStopStatus(view.status) && view.taskId) {
            startVideoWatch(view.nodeId, view.taskId);
          }
        }
      } catch {
        // 恢复接口失败时仍按节点上的 taskId 自行轮询
      }
      for (const node of latestRef.current.nodes) {
        if (node.type !== "video") continue;
        const taskId =
          (typeof node.data.taskId === "string" && node.data.taskId) || submittedVideoTask(doc.id, node.id);
        if (node.data.status === "running" && taskId && !isWatchingVideo(doc.id, node.id)) {
          startVideoWatch(node.id, taskId);
        }
      }
    })();
    return () => unregisterVideoCanvas(doc.id, handlers);
  }, [doc.id, applyVideoView, startVideoWatch, updateNodeData]);

  // 标题重命名走常规保存通道（与节点编辑共用 revision）
  const prevNameRef = useRef(doc.name);
  useEffect(() => {
    if (prevNameRef.current !== doc.name) {
      prevNameRef.current = doc.name;
      scheduleSave();
    }
  }, [doc.name, scheduleSave]);

  useEffect(() => {
    const change = changes.take();
    if (!change) return;
    if (change.assets) registerAssets(collectCanvasAssets(nodes, doc.createdAt, libraryRef.current));
    scheduleSave();
  }, [nodes, edges, dragging, draftReady, changes, scheduleSave, registerAssets, doc.createdAt]);

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      changes.end("viewport");
      setDragging(false);
      if (viewport.x === viewportRef.current.x && viewport.y === viewportRef.current.y && viewport.zoom === viewportRef.current.zoom) return;
      viewportRef.current = viewport;
      viewportDirtyRef.current = true;
      viewportVersionRef.current++;
      scheduleSave();
    },
    [scheduleSave, changes],
  );

  // ---- 附件计数：连线附件 + 直传附件共用 5 个名额 ----
  const attachmentCountOf = useCallback((nodeId: string): number => {
    const node = latestRef.current.nodes.find((item) => item.id === nodeId);
    const uploads = (node?.data.uploadAttachments as string[] | undefined) ?? [];
    const incoming = latestRef.current.edges.filter((edge) => edge.target === nodeId && latestRef.current.nodes.find(item => item.id === edge.source)?.type !== "canvasText").length;
    return uploads.length + incoming;
  }, []);

  // ---- 连线规则：图片附件最多 5；视频首帧/尾帧/参考合计未满；同一源不重复（源无图也可连）----
  const checkConnection = useCallback((connection: Connection | Edge): boolean => {
    const { source, target } = connection;
    if (!source || !target || source === target) {
      return false;
    }
    const sourceNode = latestRef.current.nodes.find((node) => node.id === source);
    const targetNode = latestRef.current.nodes.find((node) => node.id === target);
    if (latestRef.current.edges.some((edge) => edge.target === target && edge.source === source)) {
      return false;
    }
    if (!sourceNode || !targetNode) return false;
    if (sourceNode.type === "canvasText" || targetNode.type === "canvasText") return true;
    if (targetNode?.type === "video") {
      if (sourceNode?.type !== "image" && sourceNode?.type !== "asset") {
        return false;
      }
      return defaultNewVideoRole(videoOccupancy(target, latestRef.current.nodes, latestRef.current.edges)) !== null;
    }
    if (targetNode?.type !== "image") {
      return false;
    }
    return (sourceNode.type === "image" || sourceNode.type === "asset") && attachmentCountOf(target) < ATTACHMENT_MAX;
  }, [attachmentCountOf]);

  const connectEdge = useCallback((connection: Connection): Edge => {
    const targetNode = latestRef.current.nodes.find((node) => node.id === connection.target);
    const sourceNode = latestRef.current.nodes.find((node) => node.id === connection.source);
    if (targetNode?.type === "video" && sourceNode?.type !== "canvasText" && connection.target) {
      return {
        ...connection,
        id: crypto.randomUUID(),
        type: "scissor",
        data: { role: defaultNewVideoRole(videoOccupancy(connection.target, latestRef.current.nodes, latestRef.current.edges)) ?? "reference" },
      };
    }
    return { ...connection, id: crypto.randomUUID(), type: "scissor" };
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!checkConnection(connection)) {
        const targetNode = latestRef.current.nodes.find((node) => node.id === connection.target);
        toast.error(connectRejectMessage(targetNode?.type));
        return;
      }
      const edge = connectEdge(connection);
      setEdges((current) => addEdge(edge, current));
      pushAdd([], [edge]);
    },
    [checkConnection, connectEdge, pushAdd, setEdges],
  );

  // 拖线松开：落在节点框上 → 自动连接；落在空白 → 弹"引用该节点生成"菜单
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: { isValid: boolean | null; fromNode?: Node | null; fromHandle?: { type: string } | null }) => {
      setDragging(false);
      if (connectionState.isValid) {
        return;
      }
      const fromNode = connectionState.fromNode;
      if (!fromNode || connectionState.fromHandle?.type !== "source") {
        return;
      }
      const point = "changedTouches" in event
        ? { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 }
        : { x: event.clientX, y: event.clientY };
      const flow = screenToFlowPosition(point);

      const target = latestRef.current.nodes.find((node) => {
        if (node.id === fromNode.id) {
          return false;
        }
        const width = node.measured?.width ?? 0;
        const height = node.measured?.height ?? 0;
        return (
          flow.x >= node.position.x &&
          flow.x <= node.position.x + width &&
          flow.y >= node.position.y &&
          flow.y <= node.position.y + height
        );
      });
      if (target) {
        const connection = { source: fromNode.id, target: target.id, sourceHandle: null, targetHandle: null };
        if (checkConnection(connection)) {
          const edge = connectEdge(connection);
          setEdges((current) => addEdge(edge, current));
          pushAdd([], [edge]);
        } else {
          toast.error(connectRejectMessage(target.type));
        }
        return;
      }
      setMenu({ kind: "connect-create", x: point.x, y: point.y, flow, sourceId: fromNode.id });
      menuOpenedAtRef.current = Date.now();
    },
    [checkConnection, connectEdge, pushAdd, screenToFlowPosition, setEdges],
  );

  // ---- 节点创建 / 上传 ----
  const viewportCenter = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const point = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return screenToFlowPosition(point);
  }, [screenToFlowPosition]);

  const addImageNode = useCallback(
    (at: { x: number; y: number }): ImageFlowNode => {
      const id = crypto.randomUUID();
      const node: ImageFlowNode = {
        id,
        type: "image",
        position: at,
        selected: true,
        data: defaultImageNodeData("图片"),
      };
      // 新节点独占选中并弹出输入框：创建即把注意力放到该节点上
      const next = [...latestRef.current.nodes.map(item => item.selected ? { ...item, selected: false } : item), node];
      latestRef.current = { ...latestRef.current, nodes: next };
      setNodes(next);
      setPanelNodeId(id);
      return node;
    },
    [setNodes],
  );

  const addVideoNode = useCallback(
    (at: { x: number; y: number }): VideoFlowNode => {
      const id = crypto.randomUUID();
      const node: VideoFlowNode = {
        id,
        type: "video",
        position: at,
        selected: true,
        data: defaultVideoNodeData("视频"),
      };
      const next = [...latestRef.current.nodes.map(item => item.selected ? { ...item, selected: false } : item), node];
      latestRef.current = { ...latestRef.current, nodes: next };
      setNodes(next);
      setPanelNodeId(id);
      return node;
    },
    [setNodes],
  );

  const addTextNode = useCallback((at: { x: number; y: number }): TextFlowNode => {
    const node: TextFlowNode = { id: crypto.randomUUID(), type: "canvasText", position: at, width: 360, height: 260, selected: true, data: { name: "文本", content: "" } };
    const next = [...latestRef.current.nodes.map(item => item.selected ? { ...item, selected: false } : item), node];
    latestRef.current = { ...latestRef.current, nodes: next };
    setNodes(next);
    setPanelNodeId(node.id);
    return node;
  }, [setNodes]);

  const addAssetNode = useCallback(
    (at: { x: number; y: number }, assetName: string, name: string): Node => {
      const node: Node = {
        id: crypto.randomUUID(),
        type: "asset",
        position: at,
        data: { name, assetName },
      };
      const next = [...latestRef.current.nodes, node];
      latestRef.current = { ...latestRef.current, nodes: next };
      setNodes(next);
      return node;
    },
    [setNodes],
  );

  const referencePatch = useCallback((nodeId: string, references: PromptReference[], role: VideoInputRole = "reference") => {
    const current = latestRef.current;
    const node = current.nodes.find(item => item.id === nodeId);
    if (!node) throw new Error("目标节点已移除");
    if (isPending(doc.id, nodeId) || hasPendingFrom(doc.id, nodeId)) throw new Error("生成期间不能修改参考图");
    if (references.some(item => !libraryRef.current.some(asset => asset.assetName === item.assetName))) throw new Error("该图片不在当前画布素材库中");
    return addFixedReferences(node, current.nodes, current.edges, references, role);
  }, [doc.id]);
  const referenceError = useCallback((nodeId: string, references: PromptReference[], role: VideoInputRole = "reference"): string | null => {
    try { referencePatch(nodeId, references, role); return null; } catch (error) { return error instanceof Error ? error.message : "无法添加参考图"; }
  }, [referencePatch]);
  const addReferences = useCallback((nodeId: string, references: PromptReference[], role: VideoInputRole = "reference", prompt?: string) => {
    try {
      const patch = referencePatch(nodeId, references, role);
      const next = latestRef.current.nodes.map(node => node.id !== nodeId ? node : { ...node, data: { ...node.data, ...patch, ...(prompt !== undefined ? node.data.assetName ? { draftPrompt: prompt } : { prompt } : {}) } });
      latestRef.current = { ...latestRef.current, nodes: next };
      setNodes(next);
      scheduleSave();
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "无法添加参考图"); return false; }
  }, [referencePatch, setNodes, scheduleSave]);
  const requestPicker = useCallback((nodeId: string, options?: ReferencePickerOptions) => {
    if (!latestRef.current.nodes.some(node => node.id === nodeId)) return;
    setPicker({ nodeId, ...options });
  }, []);
  const assetActions = useMemo(() => ({ assets: libraryAssets, addReferences, referenceError, requestPicker }), [libraryAssets, addReferences, referenceError, requestPicker]);
  useEffect(() => {
    if (picker && (!desktopAvailable || !nodes.some(node => node.id === picker.nodeId))) { picker.onClose?.(); setPicker(null); }
  }, [picker, nodes, desktopAvailable]);

  const runUpload = useCallback((operation: () => Promise<void>): Promise<void> => {
    if (pendingUploads.current.size) { toast.info("请等待当前批次导入完成"); return Promise.resolve(); }
    const pending = operation().catch(() => { toast.error("导入失败，请重试"); }).finally(() => pendingUploads.current.delete(pending));
    pendingUploads.current.add(pending);
    return pending;
  }, []);
  const uploadFiles = useCallback(async (files: File[], source: CanvasLibrarySource): Promise<UploadedAsset[]> => {
    const addedAt = new Date().toISOString();
    const results = await uploadAssets(files, { onUpdate: items => {
      if (!mounted.current) return;
      setUploads(items);
      registerAssets(items.flatMap(item => item.asset ? [{ assetName: item.asset.name, name: item.asset.originalName.slice(0, 512), sources: [source], addedAt }] : []));
    } });
    for (const item of results) if (item.error) toast.error(`${item.name}：${item.error}`);
    return results.flatMap(item => item.asset ? [item.asset] : []);
  }, [registerAssets]);
  const onLibraryUpload = useCallback((files: FileList | null) => {
    const batch = Array.from(files ?? []);
    if (!batch.length) return;
    const source = libraryUploadSourceRef.current;
    libraryUploadSourceRef.current = "imported";
    void runUpload(async () => { await uploadFiles(batch, source); });
  }, [runUpload, uploadFiles]);

  const onCanvasUpload = useCallback((files: FileList | null) => {
    const batch = Array.from(files ?? []);
    if (!batch.length) return;
    const position = { ...uploadAtRef.current };
    return runUpload(async () => {
      const assets = await uploadFiles(batch, "imported");
      // 一批上传记一条撤销，避免多张图要按多次 ⌘Z
      const created = assets.map((asset, index) => addAssetNode({ x: position.x + index * 40, y: position.y + index * 40 }, asset.name, asset.originalName));
      if (created.length) pushAdd(created, []);
    });
  }, [addAssetNode, pushAdd, runUpload, uploadFiles]);

  const onAttachmentUpload = useCallback((files: FileList | null) => {
    const nodeId = attachTargetRef.current, requestedRole = attachRoleRef.current;
    attachTargetRef.current = null; attachRoleRef.current = undefined;
    const file = files?.[0];
    if (!nodeId || !file) return;
    return runUpload(async () => {
      const assets = await uploadFiles([file], "manual");
      const uploaded = assets[0];
      if (!uploaded) return;
      const node = latestRef.current.nodes.find(item => item.id === nodeId);
      const role = requestedRole ?? (node?.type === "video" ? defaultNewVideoRole(videoOccupancy(nodeId, latestRef.current.nodes, latestRef.current.edges)) : "reference");
      if (!role || !addReferences(nodeId, [{ assetName: uploaded.name, name: uploaded.originalName }], role)) toast.info("图片已保留在本画布素材库，可稍后添加");
    });
  }, [addReferences, runUpload, uploadFiles]);

  const requestAttachmentUpload = useCallback((nodeId: string, options?: { role?: VideoInputRole }) => {
    attachTargetRef.current = nodeId;
    attachRoleRef.current = options?.role;
    attachInputRef.current?.click();
  }, []);

  // ---- 生成：空节点填自己，有图节点结果落右侧新节点；retrySlotId 单槽重试不新建节点 ----
  const generate = useCallback(
    async (nodeId: string, overrides?: GenerateOverrides) => {
      let node = latestRef.current.nodes.find((item) => item.id === nodeId);
      // 并发锁定：节点自身在跑，或它作为来源已有进行中的任务
      if (!node || node.data.status === "running" || isPending(doc.id, nodeId) || hasPendingFrom(doc.id, nodeId)) {
        return;
      }
      const retrySlotId = overrides?.retrySlotId ?? null;
      let retry: ImageNodeData["generationRequest"] | undefined;
      if (retrySlotId) {
        // 单槽重试：重放原批次快照但数量为 1，只允许重试失败槽
        const slot = ((node.data.results as ImageNodeData["results"]) ?? []).find((item) => item.id === retrySlotId);
        if (!node.data.generationRequest || !slot || slot.status !== "failed") {
          return;
        }
        retry = { ...(node.data.generationRequest as ImageNodeData["generationRequest"] & object), count: 1 };
      } else if (overrides?.retry) {
        retry = node.data.generationRequest as ImageNodeData["generationRequest"];
      }
      const prompt = String(retry?.prompt ?? overrides?.prompt ?? node.data.prompt ?? "").trim();
      const aspectRatio = retry?.aspectRatio ?? overrides?.aspectRatio ?? (node.data.aspectRatio as string);
      const resolution = retry?.resolution ?? overrides?.resolution ?? (node.data.resolution as "1k" | "2k");
      const quality = retry?.quality ?? overrides?.quality ?? (node.data.quality as "low" | "medium");
      const count = retry?.count ?? overrides?.count ?? parseGenerationCount(node.data.generationCount);
      if (!prompt) {
        return;
      }
      // 未登录直接拦截：不发起请求、不改动节点状态，由面板常驻提示引导登录
      if (loginRequired(loggedIn)) {
        toast.error(LOGIN_REQUIRED_MESSAGE);
        return;
      }
      let referenceAssets: string[];
      try {
        const resolved = retry ? null : resolveCanvasReferences(node, latestRef.current.nodes, latestRef.current.edges);
        if (resolved?.pending) toast.warning(`有 ${resolved.pending} 个附件的来源还没有图片，本次生成未使用`);
        referenceAssets = retry?.referenceAssets ?? resolved!.assets;
      } catch (error) { toast.error(error instanceof Error ? error.message : "参考图无效"); return; }
      // 节点自身是生成结果；只有连入图片和上传附件参与生成。
      if (referenceAssets.length > ATTACHMENT_MAX) {
        toast.error(`参考图超过 ${ATTACHMENT_MAX} 张上限，请先移除多余附件`);
        return;
      }

      try {
        compilePrompt(prompt, referenceAssets);
      } catch (error) {
        toast.error((error as Error).message);
        return;
      }
      const referenceNames = { ...(node.data.attachmentNames as Record<string, string> ?? {}) };
      for (const source of latestRef.current.nodes) {
        if (typeof source.data.assetName === "string" && referenceAssets.includes(source.data.assetName)) {
          referenceNames[source.data.assetName] = String(source.data.name || "参考图");
        }
      }
      const generationId = crypto.randomUUID();
      const claimNodeId = (retrySlotId || overrides?.retry) && typeof node.data.sourceNodeId === "string" ? node.data.sourceNodeId : nodeId;
      const previousClaim = generationClaims[claimNodeId];
      if (previousClaim?.state === "unknown") {
        if (!window.confirm("上次生成的状态未确认，重新生成可能重复计费。确认继续吗？")) return;
        try { await generationClaim(doc.id, claimNodeId, previousClaim.id, "acknowledge"); }
        catch (error) { toast.error(error instanceof Error ? error.message : "无法确认生成状态"); return; }
      }
      if (!(await flushSave())) { toast.error("画布尚未保存，无法开始生成"); return; }
      try { await generationClaim(doc.id, claimNodeId, generationId, "claim"); }
      catch (error) { toast.error(error instanceof Error ? error.message : "无法开始生成"); return; }
      let pendingSourceNodeId: string | null = (node.data.sourceNodeId as string | null | undefined) ?? null;
      if (!retrySlotId && node.data.assetName) {
        const generationRequest = { prompt, aspectRatio, resolution, quality, count, referenceAssets: [...referenceAssets] };
        const original = node;
        const position = freeSpotRightOf(original.position, latestRef.current.nodes);
        nodeId = crypto.randomUUID();
        node = { id: nodeId, type: "image", position, selected: true, data: {
          ...defaultImageNodeData("图片"), prompt, aspectRatio, resolution, quality, generationCount: count,
          uploadAttachments: [...referenceAssets], attachmentNames: referenceNames,
          generationRequest, sourceNodeId: original.id, status: "running", generationId,
        } };
        pendingSourceNodeId = original.id;
        const pendingNode = node;
        suppressPanelForSelectionRef.current = true;
        setNodes(current => [...current.map(item => ({ ...item, selected: false })), pendingNode]);
      } else if (retrySlotId) {
        startWrite(nodeId, generationId, { status: "running", generationId, errorMessage: null, retryingSlotId: retrySlotId });
      } else {
        startWrite(nodeId, generationId, { status: "running", generationId, errorMessage: null, generationRequest: { prompt, aspectRatio, resolution, quality, count, referenceAssets: [...referenceAssets] } });
        setPanelNodeId(null);
      }
      markPending(doc.id, nodeId, pendingSourceNodeId);
      const settle = async (outcome: GenerationOutcome) => {
        // 前台画布（含切回后的新实例）直接更新；不在前台则写回发起画布存档
        if (!dispatchOutcome(doc.id, nodeId, outcome)) {
          await persistResultToOriginCanvas(doc.id, nodeId, outcome);
        }
      };
      let claimResult: "complete" | "unknown" = "unknown";
      try {
        const response = await fetch("/api/generate/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            aspect_ratio: aspectRatio,
            resolution,
            quality,
            count,
            referenceAssets,
          }),
        });
        const payload = (await response.json()) as GenerateResponse;
        if (!response.ok || !Array.isArray(payload.slots)) {
          const message = payload.error?.message ?? `请求失败 (${response.status})`;
          if (payload.error?.kind === "not_logged_in") {
            toast.error(LOGIN_REQUIRED_MESSAGE);
            await refreshAuth().catch(() => {});
          } else {
            toast.error(message);
          }
          await settle({ kind: "failure", generationId, failureKind: "server", message });
          if ([400, 401, 403].includes(response.status)) claimResult = "complete";
          return;
        }
        await settle({ kind: "result", generationId, slots: payload.slots, retrySlotId, prompt });
        claimResult = "complete";
      } catch {
        toast.error("生成请求失败：网络错误");
        await settle({ kind: "failure", generationId, failureKind: "network" });
      } finally {
        clearPending(doc.id, nodeId);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const saved = await flushSave();
        await generationClaim(doc.id, claimNodeId, generationId, saved ? claimResult : "unknown").catch(() => toast.error("生成结果已返回，但任务状态未能同步"));
      }
    },
    [doc.id, loggedIn, refreshAuth, updateNodeData, setNodes, flushSave, generationClaims],
  );

  const generateVideo = useCallback(
    async (nodeId: string, overrides?: GenerateVideoOverrides) => {
      let node = latestRef.current.nodes.find((item) => item.id === nodeId);
      if (!node || node.type !== "video" || node.data.status === "running" || isPending(doc.id, nodeId) || hasPendingFrom(doc.id, nodeId)) {
        return;
      }
      const data = node.data as VideoNodeData;
      if (overrides?.retry && data.errorKind === "save_failed" && data.taskId) {
        updateNodeData(nodeId, { status: "running", errorMessage: null, errorKind: null });
        markPending(doc.id, nodeId, data.sourceNodeId ?? null);
        startVideoWatch(nodeId, data.taskId);
        return;
      }
      const retryRequest = overrides?.retry ? data.generationRequest : undefined;
      const prompt = String(retryRequest?.prompt ?? overrides?.prompt ?? data.draftPrompt ?? data.prompt ?? "").trim();
      if (!prompt) return;
      if (loginRequired(loggedIn)) {
        toast.error(LOGIN_REQUIRED_MESSAGE);
        return;
      }
      const liveNames: Record<string, string> = { ...(data.attachmentNames ?? {}) };
      let inputs: VideoInput[] = retryRequest?.inputs ?? [];
      if (!retryRequest) {
        try {
          const resolved = resolveCanvasReferences(node, latestRef.current.nodes, latestRef.current.edges);
          inputs = resolved.inputs;
          for (const reference of resolved.references) liveNames[reference.assetName] = reference.name;
          if (resolved.pending) toast.warning(`有 ${resolved.pending} 个附件的来源还没有图片，本次生成未使用`);
        } catch (error) { toast.error(error instanceof Error ? error.message : "参考图无效"); return; }
      }
      try {
        compileVideoPrompt(prompt, inputs);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "提示词引用无效");
        return;
      }
      const clamped = clampVideoParameters(inputs, {
        duration: retryRequest?.duration ?? overrides?.duration ?? data.duration,
        aspectRatio: retryRequest
          ? retryRequest.aspectRatio
          : overrides?.aspectRatio !== undefined
            ? overrides.aspectRatio
            : data.aspectRatio,
        resolution: retryRequest?.resolution ?? overrides?.resolution ?? data.resolution,
        audio: retryRequest?.audio ?? overrides?.audio ?? data.audio,
      });
      const generationRequest: VideoGenerationRequest = { prompt, ...clamped, inputs };
      const claimNodeId = overrides?.retry && data.sourceNodeId ? data.sourceNodeId : nodeId;
      const previousClaim = generationClaims[claimNodeId];
      if (previousClaim?.state === "unknown") {
        if (!window.confirm("上次生成的状态未确认，重新生成可能重复计费。确认继续吗？")) return;
        try { await generationClaim(doc.id, claimNodeId, previousClaim.id, "acknowledge"); }
        catch (error) { toast.error(error instanceof Error ? error.message : "无法确认生成状态"); return; }
      }
      const generationId = crypto.randomUUID();
      if (!(await flushSave())) { toast.error("画布尚未保存，无法开始生成"); return; }
      try { await generationClaim(doc.id, claimNodeId, generationId, "claim"); }
      catch (error) { toast.error(error instanceof Error ? error.message : "无法开始生成"); return; }
      let pendingSourceNodeId: string | null = data.sourceNodeId ?? null;
      if (!overrides?.retry && data.assetName) {
        const original = node;
        nodeId = crypto.randomUUID();
        const pendingNode: VideoFlowNode = {
          id: nodeId,
          type: "video",
          position: freeSpotRightOf(original.position, latestRef.current.nodes),
          selected: true,
          data: {
            ...defaultVideoNodeData("视频"),
            prompt,
            duration: generationRequest.duration,
            aspectRatio: generationRequest.aspectRatio,
            resolution: generationRequest.resolution,
            audio: generationRequest.audio,
            uploadInputs: [...inputs],
            attachmentNames: liveNames,
            generationRequest,
            sourceNodeId: original.id,
            status: "running",
            generationId,
            waitedSeconds: 0,
          },
        };
        pendingSourceNodeId = original.id;
        suppressPanelForSelectionRef.current = true;
        setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), pendingNode]);
      } else {
        startWrite(nodeId, generationId, {
          status: "running",
          generationId,
          prompt,
          duration: generationRequest.duration,
          aspectRatio: generationRequest.aspectRatio,
          resolution: generationRequest.resolution,
          audio: generationRequest.audio,
          generationRequest,
          errorMessage: null,
          errorKind: null,
          taskId: null,
          waitedSeconds: 0,
        });
        setPanelNodeId(null);
      }
      markPending(doc.id, nodeId, pendingSourceNodeId);
      try {
        const created = await submitVideoJob({
          prompt,
          canvasId: doc.id,
          nodeId,
          claim: { nodeId: claimNodeId, id: generationId },
          inputs,
          parameters: {
            prompt,
            duration: generationRequest.duration,
            aspectRatio: generationRequest.aspectRatio,
            resolution: generationRequest.resolution,
            audio: generationRequest.audio,
          },
        });
        rememberSubmittedVideoTask(doc.id, nodeId, created.taskId);
        const pendingView: VideoTaskView = {
          taskId: created.taskId,
          requestId: created.requestId,
          canvasId: doc.id,
          nodeId,
          generationId,
          status: "pending",
          waitedSeconds: 0,
          result: null,
          error: null,
        };
        if (!dispatchVideoView(doc.id, nodeId, pendingView)) {
          void persistVideoToOriginCanvas(doc.id, nodeId, pendingView);
        }
        startVideoWatch(nodeId, created.taskId);
      } catch (error) {
        const kind = (error as { kind?: string }).kind;
        if (kind === "not_logged_in") {
          toast.error(LOGIN_REQUIRED_MESSAGE);
          await refreshAuth().catch(() => {});
        } else {
          toast.error(error instanceof Error ? error.message : "生成请求失败");
        }
        const failure = {
          status: "failed",
          errorMessage: kind === "not_logged_in" ? LOGIN_REQUIRED_MESSAGE : (error instanceof Error ? error.message : "生成失败"),
          errorKind: "network",
        };
        serviceWrite({ action: "fail", nodeId, generationId, patch: failure }, failure);
        clearPending(doc.id, nodeId);
        const status = (error as { status?: number }).status;
        await generationClaim(doc.id, claimNodeId, generationId, status && [400, 401, 403].includes(status) ? "complete" : "unknown").catch(() => toast.error("生成任务状态未能同步"));
      }
    },
    [doc.id, loggedIn, refreshAuth, startVideoWatch, updateNodeData, setNodes, flushSave, generationClaims],
  );

  // 生成锁定：节点自身在跑，或它作为来源已有进行中的任务
  const isNodeGenerationLocked = useCallback(
    (nodeId: string) => {
      const node = latestRef.current.nodes.find((item) => item.id === nodeId);
      return !node || generationClaims[nodeId]?.state === "pending" || node.data.status === "running" || isPending(doc.id, nodeId) || hasPendingFrom(doc.id, nodeId);
    },
    [doc.id, generationClaims],
  );

  // ---- 删除（支持撤销）----
  const deleteNodes = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) {
        return;
      }
      const removedNodes = latestRef.current.nodes.filter((node) => nodeIds.includes(node.id));
      const removedEdges = latestRef.current.edges.filter(
        (edge) => nodeIds.includes(edge.source) || nodeIds.includes(edge.target),
      );
      pushUndo({ type: "delete", nodes: removedNodes, edges: removedEdges });
      redoStackRef.current = [];
      // 删除节点同时清掉它的手势锁，不留下指向已删节点的覆盖层。
      for (const id of nodeIds) gesture.drop(id);
      setNodes((current) => current.filter((node) => !nodeIds.includes(node.id)));
      setEdges((current) =>
        current.filter((edge) => !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target)),
      );
    },
    [setNodes, setEdges, pushUndo, gesture],
  );

  // ---- 复制 / 粘贴 / 副本（内部剪贴板，跨画布不共享）----
  const copyNodes = useCallback((nodeIds: string[]) => {
    const nodesToCopy = latestRef.current.nodes.filter((node) => nodeIds.includes(node.id));
    if (nodesToCopy.length === 0) {
      return;
    }
    const edgesToCopy = latestRef.current.edges.filter(
      (edge) => nodeIds.includes(edge.source) && nodeIds.includes(edge.target),
    );
    clipboardRef.current = {
      nodes: nodesToCopy.map((node) => ({
        ...node,
        data: {
          ...node.data,
          // results 深拷贝，副本不与原节点共享槽位引用
          ...(Array.isArray(node.data.results)
            ? { results: (node.data.results as CandidateResult[]).map((item) => ({ ...item })) }
            : {}),
        },
        selected: false,
      })),
      edges: edgesToCopy.map((edge) => ({ ...edge, selected: false })),
    };
  }, []);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) {
      return;
    }
    const OFFSET = 48;
    const idMap = new Map<string, string>();
    const newNodes = clip.nodes.map((node) => {
      const id = crypto.randomUUID();
      idMap.set(node.id, id);
      const data: Record<string, unknown> = { ...node.data };
      if (Array.isArray(node.data.results)) {
        data.results = (node.data.results as CandidateResult[]).map((item) => ({ ...item }));
      }
      // 副本是静态快照：不带 running 状态、不继承运行中任务与未确认状态
      if (data.status === "running") {
        data.status = "idle";
      }
      data.generationId = null;
      data.appliedGenerationId = null;
      data.errorMessage = null;
      if (node.type === "video") {
        data.taskId = null;
        data.waitedSeconds = undefined;
        data.errorKind = null;
      }
      if (node.type === "image") {
        const normalized = normalizeNodeResults(data);
        data.results = normalized.results;
        data.primaryResultId = normalized.primaryResultId;
        data.assetName = normalized.assetName;
      }
      return {
        ...node,
        id,
        position: { x: node.position.x + OFFSET, y: node.position.y + OFFSET },
        selected: true,
        data,
      };
    });
    const newEdges = clip.edges.map((edge) => ({
      ...edge,
      id: crypto.randomUUID(),
      source: idMap.get(edge.source) ?? edge.source,
      target: idMap.get(edge.target) ?? edge.target,
      selected: false,
    }));
    setNodes((current) => [
      ...current.map((node) => (node.selected ? { ...node, selected: false } : node)),
      ...newNodes,
    ]);
    setEdges((current) => [...current, ...newEdges]);
    // 连续粘贴在新位置上继续错位
    clipboardRef.current = {
      nodes: newNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          ...(Array.isArray(node.data.results)
            ? { results: (node.data.results as CandidateResult[]).map((item) => ({ ...item })) }
            : {}),
        },
        selected: false,
      })),
      edges: newEdges.map((edge) => ({ ...edge })),
    };
    pushAdd(newNodes, newEdges);
  }, [pushAdd, setNodes, setEdges]);

  const duplicateNodes = useCallback(
    (nodeIds: string[]) => {
      copyNodes(nodeIds);
      pasteClipboard();
    },
    [copyNodes, pasteClipboard],
  );

  const deleteEdge = useCallback(
    (edgeId: string) => {
      const edge = latestRef.current.edges.find((item) => item.id === edgeId);
      if (!edge) {
        return;
      }
      pushUndo({ type: "delete", nodes: [], edges: [edge] });
      redoStackRef.current = [];
      setEdges((current) => current.filter((item) => item.id !== edgeId));
    },
    [setEdges, pushUndo],
  );

  const deleteSelection = useCallback(() => {
    const selectedNodeIds = latestRef.current.nodes.filter((node) => node.selected).map((node) => node.id);
    const selectedEdges = latestRef.current.edges.filter((edge) => edge.selected);
    for (const edge of selectedEdges) {
      pushUndo({ type: "delete", nodes: [], edges: [edge] });
      redoStackRef.current = [];
    }
    if (selectedEdges.length > 0) {
      const ids = selectedEdges.map((edge) => edge.id);
      setEdges((current) => current.filter((edge) => !ids.includes(edge.id)));
    }
    deleteNodes(selectedNodeIds);
  }, [deleteNodes, setEdges, pushUndo]);

  const undo = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) {
      return;
    }
    if (entry.type === "geometry") { replayGeometryRef.current(entry, "undo"); return; }
    if (!undoStillValid(entry)) { undoStackRef.current.push(entry); toast.error("节点已被其他操作修改，无法安全撤销"); return; }
    redoStackRef.current.push(entry);
    if (entry.type === "delete") {
      // 恢复删除期间完成的任务结果（orphan 补写，成功/失败都补）
      const restored = entry.nodes.map((node) => {
        if (node.type === "video") {
          const orphan = takeVideoOrphan(doc.id, node.id);
          return orphan ? { ...node, data: { ...node.data, ...videoNodePatchFromView(orphan) } } : node;
        }
        const orphan = takeOrphan(doc.id, node.id);
        if (!orphan) {
          return node;
        }
        const patch = applyGenerationOutcome(node.data, orphan, () => crypto.randomUUID());
        return patch ? { ...node, data: { ...node.data, ...patch } } : node;
      });
      // 删除墓碑禁止同 ID 复活：用新 ID 重建，重做时删除的也是这批新 ID。
      const rebuilt = rebuildWithNewIds(restored, entry.edges);
      entry.nodes = rebuilt.nodes;
      entry.edges = rebuilt.edges;
      setNodes((current) => [...current, ...rebuilt.nodes]);
      setEdges((current) => [...current, ...rebuilt.edges]);
    } else if (entry.type === "add") {
      const nodeIds = entry.nodes.map((node) => node.id);
      const edgeIds = new Set(entry.edges.map((edge) => edge.id));
      setNodes((current) => current.filter((node) => !nodeIds.includes(node.id)));
      setEdges((current) =>
        current.filter(
          (edge) => !edgeIds.has(edge.id) && !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target),
        ),
      );
    } else if (entry.type === "setPrimary") {
      if (entry.prev.primaryResultId) serviceWrite({ action: "select", nodeId: entry.nodeId, slotId: entry.prev.primaryResultId }, entry.prev);
      else updateNodeData(entry.nodeId, entry.prev);
    }
  }, [doc.id, setNodes, setEdges, updateNodeData, serviceWrite]);

  const redo = useCallback(() => {
    const entry = redoStackRef.current.pop();
    if (!entry) {
      return;
    }
    if (entry.type === "geometry") { replayGeometryRef.current(entry, "redo"); return; }
    if (!undoStillValid(entry)) { redoStackRef.current.push(entry); toast.error("节点已被其他操作修改，无法安全重做"); return; }
    undoStackRef.current.push(entry);
    if (entry.type === "delete") {
      const nodeIds = entry.nodes.map((node) => node.id);
      const edgeIds = entry.edges.map((edge) => edge.id);
      setNodes((current) => current.filter((node) => !nodeIds.includes(node.id)));
      setEdges((current) => current.filter((edge) => !edgeIds.includes(edge.id)));
    } else if (entry.type === "add") {
      const rebuilt = rebuildWithNewIds(entry.nodes, entry.edges);
      entry.nodes = rebuilt.nodes;
      entry.edges = rebuilt.edges;
      setNodes((current) => [...current, ...rebuilt.nodes]);
      setEdges((current) => [...current, ...rebuilt.edges]);
    } else if (entry.type === "setPrimary") {
      if (entry.next.primaryResultId) serviceWrite({ action: "select", nodeId: entry.nodeId, slotId: entry.next.primaryResultId }, entry.next);
      else updateNodeData(entry.nodeId, entry.next);
    }
  }, [setNodes, setEdges, updateNodeData, serviceWrite]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!desktopAvailable || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [data-workspace-overlay]')) return;
      if (event.key === "Escape") {
        // Nested popovers and reference suggestions handle Escape before it reaches here.
        if (isEditableTarget(event.target) && !(event.target instanceof Element && event.target.closest(".ui-prompt-panel"))) return;
        // Esc 层级：候选面板先于提示词面板/菜单
        if (expandedNodeIdRef.current) {
          closeCandidates();
          return;
        }
        setMenu(null);
        setPanelNodeId(null);
        // 多选包围盒会盖住组内节点，键盘是退出多选的可靠方式。
        setNodesFromSync(current => current.some(node => node.selected) ? current.map(node => node.selected ? { ...node, selected: false } : node) : current);
        return;
      }
      if (event.target instanceof HTMLVideoElement) return;
      if (isEditableTarget(event.target)) return;
      const nextMode = interactionShortcut(event);
      if (nextMode) { event.preventDefault(); setMode(nextMode); return; }
      if (event.metaKey || event.ctrlKey) {
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          void zoomIn();
          return;
        }
        if (event.key === "-") {
          event.preventDefault();
          void zoomOut();
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          void zoomTo(1);
          return;
        }
        if (!event.shiftKey && event.key.toLowerCase() === "c") {
          const selectedIds = latestRef.current.nodes
            .filter((node) => node.selected)
            .map((node) => node.id);
          if (selectedIds.length > 0) {
            event.preventDefault();
            copyNodes(selectedIds);
          }
          return;
        }
        if (!event.shiftKey && event.key.toLowerCase() === "d") {
          const selectedIds = latestRef.current.nodes
            .filter((node) => node.selected)
            .map((node) => node.id);
          if (selectedIds.length > 0) {
            event.preventDefault();
            duplicateNodes(selectedIds);
          }
          return;
        }
        if (!event.shiftKey && event.key.toLowerCase() === "v") {
          if (clipboardRef.current) {
            event.preventDefault();
            pasteClipboard();
          }
          return;
        }
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktopAvailable, closeCandidates, copyNodes, deleteSelection, duplicateNodes, pasteClipboard, redo, setNodesFromSync, undo, zoomIn, zoomOut, zoomTo]);

  // ---- 几何命令接线（P2-06）：手势结束 → move_nodes → outbox → 回执；撤销/重做是条件命令 ----
  const actorIdRef = useRef<string | null>(null);
  const applyGeometries = useCallback((geometries: Map<string, Geometry>) => {
    if (!geometries.size) return;
    setNodesFromSync(current => current.map(node => {
      const target = geometries.get(node.id);
      return target ? applyFlowGeometry(node, target, { size: hasExplicitSize(node) }) : node;
    }));
  }, [setNodesFromSync]);
  const geometryHandlersRef = useRef({
    conflict: (_conflict: GeometryConflict) => {},
    remote: (_geometries: Map<string, Geometry>) => {},
    status: (_status: { state: string; message?: string }) => {},
  });
  geometryHandlersRef.current = {
    // 同几何冲突：画面保留用户的位置，由用户选择，不静默选边。
    conflict: (conflict) => {
      toast.warning(`${conflict.nodeIds.length} 个节点的位置已被其他修改改变`, {
        description: "画面上先保留你的位置。请选择保留哪一方。",
        duration: Infinity,
        dismissible: false,
        action: { label: "保留我的位置", onClick: () => { void conflict.keepMine(); } },
        cancel: { label: "采用对方位置", onClick: () => { void conflict.takeTheirs(); } },
      });
    },
    remote: applyGeometries,
    status: (status) => { if (status.state === "error") reportSave({ ok: false, message: status.message ?? "位置同步失败" }); },
  };
  const commitGeometry = useCallback((result: GestureResult | null) => {
    if (!result) return;
    const size = result.kind === "resize";
    const finals = new Map(result.items.map(item => [item.id, item.to]));
    setNodesFromSync(current => current.map(node => {
      const target = finals.get(node.id);
      return target ? applyFlowGeometry({ ...node, dragging: false, resizing: false }, target, { size }) : node;
    }));
    const confirmed = confirmedRef.current, channel = channelRef.current;
    const { items, unmanaged } = confirmed ? buildMoveItems(result, confirmed) : { items: [], unmanaged: result.items.map(item => item.id) };
    // 服务端还不认识的节点（尚未保存的新节点）：几何随旧保存的新增操作一起写入。
    if (unmanaged.length) changes.mutate(false);
    if (!items.length || !channel) return;
    void channel.submit(items).then(submitted => {
      if (!submitted) return;
      const top = undoStackRef.current.at(-1);
      // 与队尾未发送的移动合并时沿用同一条命令，只记一次历史。
      if (!(top?.type === "geometry" && top.commandId === submitted.commandId)) pushUndo({ type: "geometry", commandId: submitted.commandId });
      redoStackRef.current = [];
      return channel.flush();
    }).catch(error => reportSave({ ok: false, message: `位置保存失败：${error instanceof Error ? error.message : "请重试"}` }));
  }, [changes, pushUndo, setNodesFromSync]);
  commitGeometryRef.current = commitGeometry;
  const replayGeometry = useCallback((entry: Extract<UndoEntry, { type: "geometry" }>, direction: "undo" | "redo") => {
    const source = direction === "undo" ? undoStackRef : redoStackRef;
    const sink = direction === "undo" ? redoStackRef : undoStackRef;
    const label = direction === "undo" ? "撤销" : "重做";
    const history = historyRef.current.get(entry.commandId), channel = channelRef.current;
    if (!history || !channel) { source.current.push(entry); toast.info(`位置仍在保存，请稍后再${label}`); return; }
    void channel.undo(history).then(result => {
      if (!result.ok) { source.current.push(entry); toast.error(`节点已被其他操作修改，无法安全${label}`); return; }
      applyGeometries(result.geometries);
      sink.current.push({ type: "geometry", commandId: result.commandId });
      return channel.flush();
    }).catch(() => { source.current.push(entry); toast.error(`位置${label}失败，请重试`); });
  }, [applyGeometries]);
  replayGeometryRef.current = replayGeometry;

  // 拖动期间给参与节点加 geometry 租约（owner = outbox actorId，自己的命令不被挡），结束/隐藏/卸载即释放。
  useEffect(() => {
    let lease: { owner: string; tokens: Record<string, string>; timer: number } | null = null;
    let claiming = false;
    const call = (body: Record<string, unknown>, keepalive = false) => fetch(`/api/canvases/${encodeURIComponent(doc.id)}/edit-lease`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive,
    });
    const release = () => {
      const held = lease;
      lease = null;
      if (!held) return;
      window.clearInterval(held.timer);
      void call({ nodeIds: Object.keys(held.tokens), field: "geometry", owner: held.owner, action: "release", tokens: held.tokens }, true).catch(() => {});
    };
    const sync = () => {
      if (!gesture.active()) { release(); return; }
      const owner = actorIdRef.current;
      if (lease || claiming || !owner) return;
      claiming = true;
      void call({ nodeIds: gesture.participants().slice(0, 500), field: "geometry", owner, action: "claim" })
        .then(response => response.ok ? response.json() as Promise<{ tokens?: Record<string, string> }> : null)
        .then(body => {
          claiming = false;
          if (!body?.tokens) return;
          const timer = window.setInterval(() => {
            if (lease) void call({ nodeIds: Object.keys(lease.tokens), field: "geometry", owner, action: "renew", tokens: lease.tokens }).catch(() => {});
          }, 1000);
          lease = { owner, tokens: body.tokens, timer };
          if (!gesture.active()) release();
        })
        .catch(() => { claiming = false; });
    };
    const unsubscribe = gesture.subscribe(sync);
    window.addEventListener("pagehide", release);
    return () => { unsubscribe(); window.removeEventListener("pagehide", release); release(); };
  }, [doc.id, gesture]);

  // ---- 移动（拖动结束记一次撤销）----
  const onNodeDragStart = useCallback((_event: unknown, _node: Node, draggedNodes: Node[]) => {
    dragRef.current = { active: true, at: performance.now() };
    changes.begin("node");
    clearDraftTimer();
    setDragging(true);
    // 拖任何节点收起候选扇形
    closeCandidates(false);
    geometry.begin(draggedNodes);
  }, [closeCandidates, changes, geometry, clearDraftTimer]);

  const onNodeDrag = useCallback((_event: unknown, _node: Node, draggedNodes: Node[]) => {
    dragRef.current.at = performance.now();
    // 失焦／隐藏只挂起手势；事件恢复流动时重新接管，锚点丢失则就地重建。
    if (!changes.active()) changes.begin("node");
    if (!geometry.active()) geometry.begin(draggedNodes);
    geometry.update(draggedNodes);
    persistGeometry(geometry.sample());
  }, [changes, geometry, persistGeometry]);

  const onNodeDragStop = useCallback((_event: unknown, _node: Node, draggedNodes: Node[]) => {
    dragRef.current.active = false;
    finishGeometry(draggedNodes);
    // 用最后一次回调坐标收尾；onNodesChange 已收尾时 end() 返回 null，不会重复提交。
    gesture.update(draggedNodes.map(node => ({ id: node.id, x: node.position.x, y: node.position.y })));
    commitGeometry(gesture.end());
    changes.end("node");
    setDragging(false);
  }, [finishGeometry, changes, commitGeometry, gesture]);

  // ---- 设为主图（可撤销）：assetName 始终跟随主图槽 ----
  const setPrimaryResult = useCallback(
    (nodeId: string, slotId: string) => {
      const node = latestRef.current.nodes.find((item) => item.id === nodeId);
      if (!node) {
        return;
      }
      const results = (node.data.results as ImageNodeData["results"]) ?? [];
      const slot = results.find((item) => item.id === slotId);
      if (!slot || slot.status !== "success" || !slot.assetName) {
        return;
      }
      const prev = {
        primaryResultId: (node.data.primaryResultId as string | null | undefined) ?? null,
        assetName: (node.data.assetName as string | null | undefined) ?? null,
      };
      if (prev.primaryResultId === slotId && prev.assetName === slot.assetName) {
        return;
      }
      const next = { primaryResultId: slotId, assetName: slot.assetName };
      pushUndo({ type: "setPrimary", nodeId, prev, next });
      redoStackRef.current = [];
      serviceWrite({ action: "select", nodeId, slotId }, next);
    },
    [serviceWrite, pushUndo],
  );

  // ---- 复制为节点：复用已保存资产，提示词引用转成可读文字，不带连线与运行状态 ----
  const copyCandidateAsNode = useCallback(
    async (sourceNodeId: string, slotId: string) => {
      const source = latestRef.current.nodes.find((item) => item.id === sourceNodeId);
      if (!source || source.type !== "image") {
        return;
      }
      const data = source.data as ImageNodeData;
      const slot = (data.results ?? []).find((item) => item.id === slotId);
      if (!slot || slot.status !== "success" || !slot.assetName) {
        return;
      }
      const assetName = slot.assetName;
      const defaults = defaultImageNodeData("图片");
      // 记录请求失败整体退回来源节点快照；缺失字段用编辑器默认值，不写回历史记录
      let prompt = data.generationRequest?.prompt ?? data.prompt;
      let aspectRatio = data.generationRequest?.aspectRatio ?? defaults.aspectRatio;
      let resolution = data.generationRequest?.resolution ?? defaults.resolution;
      let quality = data.generationRequest?.quality ?? defaults.quality;
      try {
        const response = await fetch(`/api/assets/${assetName}/generation`, { cache: "no-store" });
        if (response.ok) {
          const record = (await response.json()) as {
            originalPrompt?: string;
            parameters?: { aspectRatio?: string | null; resolution?: string | null; quality?: string | null };
          } | null;
          if (record) {
            if (record.originalPrompt) {
              prompt = record.originalPrompt;
            }
            aspectRatio = record.parameters?.aspectRatio ?? defaults.aspectRatio;
            resolution = record.parameters?.resolution === "2k" ? "2k" : defaults.resolution;
            quality = record.parameters?.quality === "medium" ? "medium" : defaults.quality;
          }
        }
      } catch {
        // 读记录失败：退回来源节点快照
      }
      const displayNames = data.attachmentNames ?? {};
      const readablePrompt = prompt.replace(
        referencePattern(),
        (_token, asset: string) => displayNames[asset] ?? "图片",
      );
      const id = crypto.randomUUID();
      const node: ImageFlowNode = {
        id,
        type: "image",
        position: freeSpotRightOf(source.position, latestRef.current.nodes),
        selected: true,
        data: {
          ...defaults,
          assetName,
          results: [{ id: assetName, assetName, status: "success" }],
          primaryResultId: assetName,
          prompt: readablePrompt,
          aspectRatio,
          resolution,
          quality,
        },
      };
      setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node]);
      setPanelNodeId(id);
      pushAdd([node], []);
    },
    [pushAdd, setNodes],
  );

  const actions = useMemo(
    () => ({
      canvasId: doc.id,
      actorId: () => actorIdRef.current,
      flushEdits: flushSave,
      generate,
      generateVideo,
      setPrimaryResult,
      copyCandidateAsNode,
      openCandidates,
      closeCandidates,
      expandedNodeId,
      isNodeGenerationLocked,
      panelNodeId,
      removeEdge: deleteEdge,
      requestAttachmentUpload,
    }),
    [doc.id, flushSave, generate, generateVideo, setPrimaryResult, copyCandidateAsNode, openCandidates, closeCandidates, expandedNodeId, isNodeGenerationLocked, panelNodeId, deleteEdge, requestAttachmentUpload],
  );

  const pickerNode = picker ? nodes.find(node => node.id === picker.nodeId) : undefined;
  const uploading = uploads.some(item => item.state === "waiting" || item.state === "uploading");
  let pickerBound: string[] = [];
  if (pickerNode) { try { pickerBound = resolveCanvasReferences(pickerNode, nodes, edges).assets; } catch { /* 选择器显示实际校验错误。 */ } }
  const openLibraryUpload = (source: CanvasLibrarySource = "imported") => { libraryUploadSourceRef.current = source; libraryUploadInputRef.current?.click(); };

  return (
    <CanvasAssetsContext.Provider value={assetActions}>
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={wrapperRef}
        inert={!draftReady}
        className={`relative h-full w-full ${mode === "hand" ? "canvas-hand" : ""}`}
        onClick={() => {
          // 拖线松开会先弹菜单再触发同一次 click，忽略紧随其后的这次点击
          if (Date.now() - menuOpenedAtRef.current > 200) {
            setMenu(null);
          }
        }}
      >
        <CanvasScene
          nodes={nodes}
          gesture={gesture}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={checkConnection}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{ type: "scissor" }}
          defaultViewport={doc.viewport}
          onMoveEnd={onMoveEnd}
          minZoom={0.1}
          maxZoom={2}
          {...interactionConfig(mode)}
          colorMode={resolvedTheme === "light" ? "light" : "dark"}
          onConnectStart={() => setDragging(true)}
          onMoveStart={() => { changes.begin("viewport"); clearDraftTimer(); setDragging(true); }}
          panActivationKeyCode="Space"
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode={["Meta", "Control"]}
          deleteKeyCode={null}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          onNodeClick={(_event, node) => {
            if (latestRef.current.nodes.filter(item => item.selected).length <= 1) setPanelNodeId(node.id);
          }}
          onPaneClick={() => {
            setPanelNodeId(null);
            closeCandidates(false);
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            const point = { x: event.clientX, y: event.clientY };
            setMenu({ kind: "pane", ...point, flow: screenToFlowPosition(point) });
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            setMenu({ kind: "node", x: event.clientX, y: event.clientY, nodeId: node.id });
          }}
          onSelectionContextMenu={(event, selectedNodes) => {
            event.preventDefault();
            setMenu({
              kind: "selection",
              x: event.clientX,
              y: event.clientY,
              nodeIds: selectedNodes.map((node) => node.id),
            });
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            setMenu({ kind: "edge", x: event.clientX, y: event.clientY, edgeId: edge.id });
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <PromptPanel />
          <CandidatePanel />
        </CanvasScene>

        {nodes.length === 0 ? (
          <CanvasEmptyState
            onAddImage={() => {
              pushAdd([addImageNode(viewportCenter())], []);
            }}
          />
        ) : null}

        <div hidden={layout !== "scattered"} data-workspace-overlay className="absolute left-3 top-1/2 z-20 -translate-y-[calc(50%+48px)]">
          <ControlButton
            className="flex size-8 items-center justify-center rounded-full bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 hover:bg-accent"
            aria-label={menu?.kind === "add" ? "关闭添加菜单" : "添加节点"}
            onClick={(event) => {
              event.stopPropagation();
              setMenu((current) => (current?.kind === "add" ? null : { kind: "add" }));
            }}
          >
            {menu?.kind === "add" ? <X className="size-4" /> : <Plus className="size-4" />}
          </ControlButton>
          {menu?.kind === "add" ? (
            <FloatingMenu className="left-full top-0 ml-2" onClose={() => setMenu(null)}>
              <MenuButton
                label="添加图片节点"
                onClick={() => {
                  pushAdd([addImageNode(viewportCenter())], []);
                  setMenu(null);
                }}
              />
              <MenuButton
                label="添加视频节点"
                onClick={() => {
                  pushAdd([addVideoNode(viewportCenter())], []);
                  setMenu(null);
                }}
              />
              <MenuButton label="添加文本节点" onClick={() => { pushAdd([addTextNode(viewportCenter())], []); setMenu(null); }} />
              <div className="mx-1 my-2 border-t" />
              <MenuButton
                label="上传图片"
                onClick={() => {
                  uploadAtRef.current = viewportCenter();
                  uploadInputRef.current?.click();
                  setMenu(null);
                }}
              />
            </FloatingMenu>
          ) : null}
        </div>

        <CanvasToolbar canvasId={doc.id} containerRef={wrapperRef} mode={mode} onModeChange={next => { setMode(next); setMenu(null); }}
          minimapOpen={minimapOpen} onToggleMinimap={() => setMinimapOpen(open => !open)}
          onAddImage={() => { setMode("select"); pushAdd([addImageNode(viewportCenter())], []); }} onAddVideo={() => { setMode("select"); pushAdd([addVideoNode(viewportCenter())], []); }} onAddText={() => { setMode("select"); pushAdd([addTextNode(viewportCenter())], []); }} onDraggingChange={setDragging} />
        <AssetLibrary canvasName={doc.name} target={nodes.find(node => node.id === panelNodeId)} blocked={dragging || Boolean(picker)} uploading={uploading} onUpload={() => openLibraryUpload()}
          onPlace={asset => { setMode("select"); pushAdd([addAssetNode(viewportCenter(), asset.assetName, asset.name)], []); }} />
        {picker && pickerNode && <ReferencePicker key={`${picker.nodeId}:${picker.role}:${Boolean(picker.onSelect)}`} node={pickerNode} options={picker} bound={pickerBound} uploading={uploading}
          onClose={() => { picker.onClose?.(); setPicker(null); }} onUpload={() => openLibraryUpload("manual")} />}
        <input ref={libraryUploadInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { onLibraryUpload(event.target.files); event.target.value = ""; }} />

        <input
          ref={uploadInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(event) => {
            void onCanvasUpload(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={attachInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            void onAttachmentUpload(event.target.files);
            event.target.value = "";
          }}
        />

        {menu && menu.kind !== "add" ? (
          <FloatingMenu position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}>
            {menu.kind === "pane" ? (
              <>
                <MenuButton
                  label="添加图片节点"
                  onClick={() => {
                    pushAdd([addImageNode(menu.flow)], []);
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="添加视频节点"
                  onClick={() => {
                    pushAdd([addVideoNode(menu.flow)], []);
                    setMenu(null);
                  }}
                />
                <MenuButton label="添加文本节点" onClick={() => { pushAdd([addTextNode(menu.flow)], []); setMenu(null); }} />
                <div className="mx-1 my-2 border-t" />
                <MenuButton
                  label="上传图片"
                  onClick={() => {
                    uploadAtRef.current = menu.flow;
                    uploadInputRef.current?.click();
                    setMenu(null);
                  }}
                />
                <div className="mx-1 my-2 border-t" />
                <MenuButton
                  label="撤销"
                  shortcut="⌘Z"
                  disabled={undoStackRef.current.length === 0}
                  onClick={() => {
                    undo();
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="重做"
                  shortcut="⇧⌘Z"
                  disabled={redoStackRef.current.length === 0}
                  onClick={() => {
                    redo();
                    setMenu(null);
                  }}
                />
              </>
            ) : null}
            {menu.kind === "node" ? (
              <>
                <MenuButton
                  label="复制"
                  shortcut="⌘C"
                  onClick={() => {
                    copyNodes([menu.nodeId]);
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="粘贴"
                  shortcut="⌘V"
                  disabled={!clipboardRef.current}
                  onClick={() => {
                    pasteClipboard();
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="创建副本"
                  shortcut="⌘D"
                  onClick={() => {
                    duplicateNodes([menu.nodeId]);
                    setMenu(null);
                  }}
                />
                <div className="mx-1 my-2 border-t" />
                <MenuButton
                  label="删除"
                  shortcut="⌫"
                  onClick={() => {
                    deleteNodes([menu.nodeId]);
                    setMenu(null);
                  }}
                />
              </>
            ) : null}
            {menu.kind === "selection" ? (
              <>
                <MenuButton
                  label="复制"
                  shortcut="⌘C"
                  onClick={() => {
                    copyNodes(menu.nodeIds);
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="粘贴"
                  shortcut="⌘V"
                  disabled={!clipboardRef.current}
                  onClick={() => {
                    pasteClipboard();
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="创建副本"
                  shortcut="⌘D"
                  onClick={() => {
                    duplicateNodes(menu.nodeIds);
                    setMenu(null);
                  }}
                />
                <div className="mx-1 my-2 border-t" />
                <MenuButton
                  label={`删除 ${menu.nodeIds.length} 项`}
                  shortcut="⌫"
                  onClick={() => {
                    deleteNodes(menu.nodeIds);
                    setMenu(null);
                  }}
                />
              </>
            ) : null}
            {menu.kind === "edge" ? (
              <MenuButton
                label="删除连线"
                onClick={() => {
                  deleteEdge(menu.edgeId);
                  setMenu(null);
                }}
              />
            ) : null}
            {menu.kind === "connect-create" ? (
              <>
                <p className="px-2 py-1 text-xs text-muted-foreground">添加并连接节点</p>
                {latestRef.current.nodes.find(node => node.id === menu.sourceId)?.type !== "video" && <>
                <MenuButton
                  label="图片节点"
                  onClick={() => {
                    const node = addImageNode(menu.flow);
                    const edge: Edge = {
                      id: crypto.randomUUID(),
                      source: menu.sourceId,
                      target: node.id,
                      type: "scissor",
                    };
                    setEdges((current) => addEdge(edge, current));
                    pushAdd([node], [edge]);
                    setMenu(null);
                  }}
                />
                <MenuButton
                  label="视频节点"
                  onClick={() => {
                    const node = addVideoNode(menu.flow);
                    const edge: Edge = {
                      id: crypto.randomUUID(),
                      source: menu.sourceId,
                      target: node.id,
                      type: "scissor",
                      // 新节点的首次引用默认首帧（与 connectEdge 同一规则来源）
                      ...(latestRef.current.nodes.find(item => item.id === menu.sourceId)?.type === "canvasText" ? {} : { data: { role: defaultNewVideoRole([]) ?? "reference" } }),
                    };
                    setEdges((current) => addEdge(edge, current));
                    pushAdd([node], [edge]);
                    setMenu(null);
                  }}
                />
                </>}
                <MenuButton label="文本节点" onClick={() => {
                  const node = addTextNode(menu.flow);
                  const edge: Edge = { id: crypto.randomUUID(), source: menu.sourceId, target: node.id, type: "scissor" };
                  setEdges(current => addEdge(edge, current));
                  pushAdd([node], [edge]);
                  setMenu(null);
                }} />
              </>
            ) : null}
          </FloatingMenu>
        ) : null}
      </div>
    </CanvasActionsContext.Provider>
    </CanvasAssetsContext.Provider>
  );
}
