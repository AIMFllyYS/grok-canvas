"use client";

import { memo, useEffect, useState, type ComponentProps, type CSSProperties } from "react";
import { sameNodeView } from "@/lib/canvas-runtime/node-view";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AssetImage } from "@/components/ui/asset-image";
import { ControlButton } from "@/components/ui/control-button";
import { NodeSurface } from "@/components/ui/node-surface";
import { Copy, Download, ImageIcon, Plus } from "lucide-react";
import { NodeActions } from "./node-actions";
import { NodeTitle } from "./node-title";
import { StatusFeedback } from "@/components/ui/status-feedback";
import { useAuth } from "@/components/auth-status";
import { generationStatusFeedback, loginRequired } from "@/lib/generation-auth-feedback";
import { badgeLabel, summarizeResults, type CandidateResult, type GenerationCount } from "@/lib/multi-image";
import { useCanvasActions } from "./flow-canvas";
import { ImagineLoading } from "./imagine-loading";

export type ImageNodeData = {
  name: string;
  assetName: string | null;
  /** attachments uploaded directly in the panel (not from canvas edges) */
  uploadAttachments: string[];
  attachmentNames?: Record<string, string>;
  prompt: string;
  /** 有图节点上用户正在编辑的提示词草稿；prompt 保持为生成时快照 */
  draftPrompt?: string;
  aspectRatio: string;
  resolution: "1k" | "2k";
  quality: "low" | "medium";
  status: "idle" | "running" | "failed";
  /** 下一次生成数量 */
  generationCount?: GenerationCount;
  /** 候选槽位；assetName 始终与主图槽同步 */
  results?: CandidateResult[];
  primaryResultId?: string | null;
  /** 当前批次/请求的稳定标识，防止旧响应覆盖新任务 */
  generationId?: string | null;
  /** 已落盘批次的标识，同一批次重复派发不重复写入 */
  appliedGenerationId?: string | null;
  /** 节点级失败/结果未知信息，成功时清空 */
  errorMessage?: string | null;
  /** 单槽重试进行中的槽位 id，用于面板槽位级生成中状态 */
  retryingSlotId?: string | null;
  generationRequest?: { prompt: string; aspectRatio: string; resolution: "1k" | "2k"; quality: "low" | "medium"; count: GenerationCount; referenceAssets: string[] };
  sourceNodeId?: string | null;
  [key: string]: unknown;
};

export type ImageFlowNode = Node<ImageNodeData, "image">;

export const ATTACHMENT_MAX = 5;

const BOX_SIZE = 280;

const HANDLE_PLUS =
  "!flex !h-5 !w-5 !items-center !justify-center !rounded-full !border !border-muted-foreground/60 !bg-card !opacity-50 !transition-opacity group-hover:!opacity-100";

export function PlusHandle(props: ComponentProps<typeof Handle>) {
  const outward =
    props.position === Position.Left ? { left: -12 } : props.position === Position.Right ? { right: -12 } : undefined;
  return (
    <Handle {...props} style={{ ...outward, ...props.style }} className={`${HANDLE_PLUS} ${props.className ?? ""}`}>
      <span aria-hidden className="absolute -inset-2 rounded-full" />
      <Plus className="pointer-events-none h-3 w-3 text-muted-foreground" />
    </Handle>
  );
}

export function defaultImageNodeData(name: string): ImageNodeData {
  return {
    name,
    assetName: null,
    uploadAttachments: [],
    prompt: "",
    aspectRatio: "auto",
    resolution: "1k",
    quality: "low",
    status: "idle",
    generationCount: 1,
    sourceNodeId: null,
  };
}

export const ImageNode = memo(function ImageNode({ id, data, selected, draggable }: NodeProps<ImageFlowNode>) {
  const { generate, openCandidates, closeCandidates, copyCandidateAsNode, expandedNodeId } = useCanvasActions();
  const { loggedIn, login } = useAuth();
  const running = data.status === "running";
  const failedFeedback = generationStatusFeedback(loggedIn);
  const [ratio, setRatio] = useState<number | null>(null);
  const results = data.results ?? [];
  const badge = badgeLabel(results);
  const runningCount = data.generationRequest?.count ?? data.generationCount ?? 1;
  const primarySlot = results.find((item) => item.id === data.primaryResultId && item.status === "success");
  // 候选扇出展开且有成功主图时，节点封面补 hover 操作层（不展开时行为不变）
  const showPrimaryOverlay = expandedNodeId === id && Boolean(data.assetName) && Boolean(primarySlot);

  useEffect(() => {
    setRatio(null);
  }, [data.assetName]);

  // 无图：1:1 占位框；有图：按实际宽高比，横向固定宽、竖向固定高
  let boxStyle: CSSProperties;
  if (!data.assetName) {
    boxStyle = { width: 240, height: 240 };
  } else if (ratio !== null && ratio < 1) {
    boxStyle = { height: BOX_SIZE, width: Math.max(120, Math.round(BOX_SIZE * ratio)) };
  } else {
    boxStyle = { width: BOX_SIZE, aspectRatio: ratio ? String(ratio) : "1 / 1" };
  }

  return (
    <div className="group relative">
      <NodeActions id={id} name={data.name} assetName={data.assetName} selected={selected} pinned={draggable === false} />
      <PlusHandle type="target" position={Position.Left} className={selected ? "!opacity-100" : ""} />
      <PlusHandle type="source" position={Position.Right} className={selected ? "!opacity-100" : ""} />

      <div className="nodrag absolute -top-7 left-0 flex items-center gap-1.5">
        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <NodeTitle nodeId={id} name={data.name} />
      </div>

      {/* 多图叠卡：主图后错位两层卡边，纯装饰；候选扇出展开时隐藏 */}
      {badge && data.assetName && expandedNodeId !== id ? (
        <>
          <div aria-hidden className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl bg-muted ring-1 ring-foreground/10" />
          <div aria-hidden className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl bg-muted ring-1 ring-foreground/15" />
        </>
      ) : null}

      <NodeSurface selected={selected} className="relative flex items-center justify-center" style={boxStyle}>
        {data.assetName ? (
          // eslint-disable-next-line @next/next/no-img-element
          <AssetImage
            src={`/api/assets/${data.assetName}`}
            alt={data.name}
            className="h-full w-full object-contain"
            onLoad={(event) =>
              setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)
            }
          />
        ) : data.status === "failed" ? (
          <div className="nodrag nopan p-4">
            <StatusFeedback
              tone={loginRequired(loggedIn) ? "muted" : "error"}
              message={loginRequired(loggedIn) ? failedFeedback.message : (data.errorMessage ?? failedFeedback.message)}
              actionLabel={failedFeedback.actionLabel}
              retry={loginRequired(loggedIn) ? () => void login() : () => generate(id, { retry: true })}
            />
          </div>
        ) : running ? (
          <ImagineLoading />
        ) : (
          <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
        )}
        {running && <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-popover px-3 py-1 text-xs text-foreground">{runningCount > 1 ? `正在生成 ${runningCount} 张…` : "生成中…"}</div>}
        {showPrimaryOverlay ? (
          <div className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="absolute left-1.5 top-1.5 rounded-full bg-popover px-2 py-0.5 text-[11px] leading-none shadow ring-1 ring-foreground/10">
              主图
            </span>
            <span
              className="nodrag nopan pointer-events-auto absolute right-1.5 top-1.5 flex items-center gap-1"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <ControlButton
                className="flex size-7 items-center justify-center rounded-full bg-popover shadow ring-1 ring-foreground/10"
                href={`/api/assets/${encodeURIComponent(data.assetName!)}`}
                download={data.assetName!}
                title="下载主图"
                aria-label="下载主图"
              >
                <Download className="h-3.5 w-3.5" />
              </ControlButton>
              <ControlButton
                className="flex size-7 items-center justify-center rounded-full bg-popover shadow ring-1 ring-foreground/10"
                title="复制主图为节点"
                aria-label="复制主图为节点"
                onClick={() => {
                  void copyCandidateAsNode(id, primarySlot!.id);
                  closeCandidates(false);
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </ControlButton>
            </span>
          </div>
        ) : null}
        {badge ? (() => {
          const { total, failed } = summarizeResults(results);
          return (
            <button
              type="button"
              data-ui-control="true"
              data-candidate-badge={id}
              aria-expanded={expandedNodeId === id}
              aria-label={`查看候选：共 ${total} 张${failed > 0 ? `，${failed} 张失败` : ""}`}
              className="nodrag nopan absolute bottom-1.5 right-1.5 z-10 flex h-6 items-center whitespace-nowrap rounded-full bg-popover px-2 text-[11px] leading-none text-muted-foreground shadow ring-1 ring-foreground/10 hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                openCandidates(id);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {badge}
            </button>
          );
        })() : null}
      </NodeSurface>
    </div>
  );
}, sameNodeView);
