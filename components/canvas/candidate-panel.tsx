"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useStore, useViewport, type InternalNode, type Viewport } from "@xyflow/react";
import { Copy, Download, Loader2, X } from "lucide-react";
import { ControlButton } from "@/components/ui/control-button";
import { AssetImage } from "@/components/ui/asset-image";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fitFloatingRect } from "@/lib/floating-placement";
import { fanOutSlots, type FanPosition } from "@/lib/multi-image";
import { useCanvasActions } from "./flow-canvas";
import type { ImageNodeData } from "./image-node";

const assetUrl = (name: string) => `/api/assets/${encodeURIComponent(name)}`;

const GAP = 24;
const STAGGER_MS = 50;
const TRANSITION_MS = 180;
const CLOSE_MS = TRANSITION_MS + 3 * STAGGER_MS + 40;

function useReducedMotion(): boolean {
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  return reduced;
}

function nodeScreenRect(node: InternalNode, viewport: Viewport): { cx: number; cy: number; width: number; height: number } {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? 280;
  const height = node.measured?.height ?? 280;
  return {
    cx: (x + width / 2) * viewport.zoom + viewport.x,
    cy: (y + height / 2) * viewport.zoom + viewport.y,
    width: width * viewport.zoom,
    height: height * viewport.zoom,
  };
}

/** 弧位偏移：节点中心 → 卡片中心；卡片与节点同尺寸，偏移即节点尺寸 + 间距 */
function fanOffset(position: FanPosition, node: { width: number; height: number }): { dx: number; dy: number } {
  const side = node.width + GAP;
  const vertical = node.height + GAP;
  switch (position) {
    case "right":
      return { dx: side, dy: 0 };
    case "right-bottom":
      return { dx: side, dy: vertical };
    case "bottom":
      return { dx: 0, dy: vertical };
  }
}

/** 卡片定位相对 .react-flow 容器，边界钳制也用容器尺寸（容器上方有 48px 顶栏） */
function flowContainerSize(): { width: number; height: number } {
  const el = document.querySelector(".react-flow");
  if (!el) {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/**
 * 候选扇出：主图留在节点原位，非主图候选（含失败槽）从节点中心飞出到弧位。
 * 无背板，画布照常交互；收起播放反向动画后卸载。普通 div（非 role=dialog），
 * Esc 由画布按键处理先收扇形；图片预览走 Dialog，Esc 优先。
 */
export function CandidatePanel() {
  const { expandedNodeId } = useCanvasActions();
  const reduced = useReducedMotion();
  const [displayNodeId, setDisplayNodeId] = useState<string | null>(expandedNodeId);
  const [closing, setClosing] = useState(false);

  // 收起时先播反向动画再卸载；减少动态效果时立即卸载
  useEffect(() => {
    if (expandedNodeId) {
      setDisplayNodeId(expandedNodeId);
      setClosing(false);
      return;
    }
    if (!displayNodeId) {
      return;
    }
    if (reduced) {
      setDisplayNodeId(null);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = setTimeout(() => {
      setDisplayNodeId(null);
      setClosing(false);
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [expandedNodeId, displayNodeId, reduced]);

  const node = useStore((state) => (displayNodeId ? state.nodeLookup.get(displayNodeId) : undefined));
  const viewport = useViewport();

  if (!node || !displayNodeId) {
    return null;
  }
  return <FanSurface key={displayNodeId} node={node} viewport={viewport} closing={closing} reduced={reduced} />;
}

function FanSurface({ node, viewport, closing, reduced }: {
  node: InternalNode;
  viewport: Viewport;
  closing: boolean;
  reduced: boolean;
}) {
  const { setPrimaryResult, copyCandidateAsNode, generate, closeCandidates } = useCanvasActions();
  const data = node.data as ImageNodeData;
  const fan = fanOutSlots(data.results ?? [], data.primaryResultId ?? null);
  const [open, setOpen] = useState(reduced);
  const [preview, setPreview] = useState<{ assetName: string; label: string } | null>(null);
  const firstCardRef = useRef<HTMLButtonElement>(null);

  // 挂载后 rAF 触发展开，避免初始帧直接落在终点
  useEffect(() => {
    if (reduced) {
      return;
    }
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  // 展开后焦点进第一张扇出卡；收起后焦点由 closeCandidates 返回角标
  useEffect(() => {
    if (open) {
      firstCardRef.current?.focus();
    }
  }, [open]);

  const rect = nodeScreenRect(node, viewport);
  // 扇出卡与节点同尺寸（screen 换算后）
  const cardW = rect.width;
  const cardH = rect.height;
  const baseLeft = rect.cx - cardW / 2;
  const baseTop = rect.cy - cardH / 2;
  const container = flowContainerSize();
  const shown = open && !closing;

  return (
    <>
      {fan.map(({ slot, position }, index) => {
        const label = `候选 ${(data.results ?? []).indexOf(slot) + 1}`;
        const retrying = data.status === "running" && data.retryingSlotId === slot.id;
        const { dx, dy } = fanOffset(position, rect);
        // 窗口边界钳制：换算成相对节点位置的最终位移
        const clamped = fitFloatingRect(
          rect.cx + dx - cardW / 2,
          rect.cy + dy - cardH / 2,
          cardW,
          cardH,
          container.width,
          container.height,
        );
        const tx = clamped.left - baseLeft;
        const ty = clamped.top - baseTop;
        const motion = reduced
          ? { transform: `translate(${tx}px, ${ty}px)`, opacity: shown ? 1 : 0 }
          : {
              transform: shown ? `translate(${tx}px, ${ty}px) scale(1)` : "translate(0px, 0px) scale(0.8)",
              opacity: shown ? 1 : 0,
              transition: `transform ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease`,
              transitionDelay: `${index * STAGGER_MS}ms`,
            };
        return (
          <div
            key={slot.id}
            role="group"
            aria-label={label}
            className="nodrag nopan nowheel group absolute z-30 overflow-hidden rounded-xl bg-muted"
            style={{ left: baseLeft, top: baseTop, width: cardW, height: cardH, ...motion }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {slot.status === "failed" ? (
              <div
                className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center"
                aria-label={`${label}，生成失败`}
              >
                {retrying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span role="status" className="text-xs text-muted-foreground">生成中…</span>
                  </>
                ) : (
                  <>
                    <p className="line-clamp-3 text-xs text-muted-foreground">{slot.error ?? "生成失败"}</p>
                    <ControlButton
                      ref={index === 0 ? firstCardRef : undefined}
                      className="flex h-7 items-center rounded-full bg-secondary px-3 text-xs text-secondary-foreground"
                      aria-label={`重试${label}`}
                      disabled={data.status === "running"}
                      onClick={() => generate(node.id, { retrySlotId: slot.id })}
                    >
                      重试
                    </ControlButton>
                  </>
                )}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  ref={index === 0 ? firstCardRef : undefined}
                  aria-label={label}
                  className="flex h-full w-full items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                  onClick={() => setPreview({ assetName: slot.assetName!, label })}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <AssetImage src={assetUrl(slot.assetName!)} variant="thumb256" alt={label} className="h-full w-full object-contain" />
                </button>
                <div className="absolute inset-x-1.5 top-1.5 flex items-start justify-between gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <ControlButton
                    className="flex h-7 items-center rounded-full bg-popover px-2.5 text-xs shadow ring-1 ring-foreground/10"
                    onClick={() => {
                      setPrimaryResult(node.id, slot.id);
                      closeCandidates();
                    }}
                  >
                    设为主图
                  </ControlButton>
                  <span className="flex items-center gap-1">
                    <ControlButton
                      className="flex size-7 items-center justify-center rounded-full bg-popover shadow ring-1 ring-foreground/10"
                      href={assetUrl(slot.assetName!)}
                      download={slot.assetName!}
                      title={`下载${label}`}
                      aria-label={`下载${label}`}
                      onClick={(event: ReactMouseEvent) => event.stopPropagation()}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </ControlButton>
                    <ControlButton
                      className="flex size-7 items-center justify-center rounded-full bg-popover shadow ring-1 ring-foreground/10"
                      title={`复制${label}为节点`}
                      aria-label={`复制${label}为节点`}
                      onClick={() => {
                        // 焦点转去新节点的提示词面板，不返回旧角标
                        void copyCandidateAsNode(node.id, slot.id);
                        closeCandidates(false);
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </ControlButton>
                  </span>
                </div>
              </>
            )}
          </div>
        );
      })}

      <Dialog open={preview !== null} onOpenChange={(openState) => { if (!openState) setPreview(null); }}>
        {preview ? (
          <DialogContent
            showCloseButton={false}
            className="nodrag nopan nowheel flex h-[88dvh] w-[94vw] max-w-none items-center justify-center overflow-hidden bg-black p-2 sm:max-w-none"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <DialogTitle className="sr-only">{preview.label} · 预览</DialogTitle>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <AssetImage src={assetUrl(preview.assetName)} alt={preview.label} className="h-full w-full object-contain" />
            <DialogClose
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2"
              aria-label="关闭预览"
              title="关闭预览"
            >
              <X size={18} />
            </DialogClose>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
