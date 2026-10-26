"use client";

import { useEffect, useRef, useState } from "react";
import { Images, Pin, Upload, X } from "lucide-react";
import { AssetLibraryGrid } from "./asset-library-grid";
import { useCanvasAssets } from "./canvas-assets-context";
import { AssetImage } from "../ui/asset-image";
import { ControlButton } from "../ui/control-button";
import { WorkButton } from "@/components/pre/primitives";
import { Button } from "../ui/button";
import { useDesktopAvailable } from "../desktop-workspace";
import type { CanvasLibraryAsset } from "@/lib/canvas-library";
import type { ReferenceNode } from "@/lib/canvas-references";
import { VIDEO_ROLE_LABELS, type VideoInputRole } from "@/lib/video-references";

export function AssetLibrary({ canvasName, target, blocked, onUpload, onPlace, uploading }: {
  canvasName: string; target: ReferenceNode | undefined; blocked: boolean; onUpload: () => void; onPlace: (asset: CanvasLibraryAsset) => void; uploading: boolean;
}) {
  const { assets, addReferences, referenceError } = useCanvasAssets();
  const available = useDesktopAvailable();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState<CanvasLibraryAsset | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open && pinned) window.dispatchEvent(new Event("grok-canvas:library-open")); }, [open, pinned]);
  useEffect(() => { const close = () => { setOpen(false); setPinned(false); }; window.addEventListener("grok-canvas:agent-open", close); return () => window.removeEventListener("grok-canvas:agent-open", close); }, []);
  // 拖素材到提示词时鼠标会离开抽屉，这时不能自动收起，否则刚拿起的图会被抽走。
  const dragging = useRef(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => { if (enterTimer.current) clearTimeout(enterTimer.current); if (leaveTimer.current) clearTimeout(leaveTimer.current); };
  useEffect(() => {
    if (!available) { setOpen(false); setPinned(false); }
    clearTimers();
    return clearTimers;
  }, [available, blocked]);
  const enter = () => { clearTimers(); if (!blocked && !document.querySelector('.pre-floating:not([hidden])')) enterTimer.current = setTimeout(() => setOpen(true), 250); };
  const leave = () => {
    clearTimers();
    if (dragging.current) return;
    if (!pinned && !blocked) leaveTimer.current = setTimeout(() => { if (!panel.current?.contains(document.activeElement)) setOpen(false); }, 350);
  };
  const close = () => { clearTimers(); setOpen(false); setPinned(false); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); };
  const selectPreview = (asset: CanvasLibraryAsset) => { setPreview(asset); setPreviewFailed(false); };
  const editable = target?.type === "image" || target?.type === "video";
  const applyReference = (role: VideoInputRole) => { if (target && preview) addReferences(target.id, [preview], role); };
  if (!available) return null;
  return <div className="pointer-events-none absolute inset-y-0 right-0 z-40 w-4" data-workspace-overlay onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="absolute inset-y-0 right-0 w-4" style={{ pointerEvents: blocked ? "none" : "auto" }} onPointerEnter={enter} onPointerLeave={leave} aria-hidden="true" />
    {!open && <ControlButton ref={trigger} aria-label="打开当前画布素材库" title="当前画布素材库" aria-expanded={open} onClick={() => { clearTimers(); setPinned(true); setOpen(true); }} className="pointer-events-auto absolute right-3 top-1/2 flex h-11 w-9 -translate-y-1/2 items-center justify-center rounded-xl bg-popover text-muted-foreground shadow-md ring-1 ring-foreground/10" onPointerEnter={enter} onPointerLeave={leave}><Images size={17} /></ControlButton>}
    {open && <aside ref={panel} aria-label="当前画布素材库" className="ui-library-drawer pointer-events-auto absolute bottom-3 right-3 top-3 flex w-80 flex-col gap-3 rounded-2xl bg-popover p-4 text-popover-foreground shadow-xl ring-1 ring-foreground/10" onPointerEnter={clearTimers} onPointerLeave={leave} onFocusCapture={clearTimers} onBlurCapture={leave} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); close(); } }}>
      <div className="flex items-center gap-2"><Images size={16} /><h2 className="flex-1 text-sm font-medium">素材库</h2><ControlButton aria-label={pinned ? "取消固定素材库" : "固定素材库"} aria-pressed={pinned} title="固定展开" onClick={() => { clearTimers(); setPinned(!pinned); }} className="rounded-md p-1.5"><Pin size={14} /></ControlButton><ControlButton aria-label="关闭素材库" onClick={close} className="rounded-md p-1.5"><X size={15} /></ControlButton></div>
      <p className="-mt-2 truncate text-[11px] text-muted-foreground" title={canvasName}>{canvasName} · 画布内共享</p>
      <Button variant="outline" size="sm" onClick={onUpload} disabled={uploading}><Upload size={13} />{uploading ? "正在导入…" : "上传图片"}</Button>
      <p className="-mt-1 text-[11px] text-muted-foreground">把图片拖进提示词输入框，可直接插入 @ 引用</p>
      <AssetLibraryGrid assets={assets} selected={preview ? [preview.assetName] : []} onSelect={selectPreview} draggable
        onAssetDragStart={() => { dragging.current = true; clearTimers(); }}
        onAssetDragEnd={() => { dragging.current = false; leave(); }} />
      {preview && <section className="pre-library-preview shrink-0 space-y-2 border-t pt-3" aria-label="素材预览">
        <div className="flex items-center gap-3"><AssetImage src={`/api/assets/${encodeURIComponent(preview.assetName)}`} alt={preview.name} className="size-16 rounded-md object-contain" onError={() => setPreviewFailed(true)} onLoad={() => setPreviewFailed(false)} /><div className="min-w-0"><p className="truncate text-xs" title={preview.name}>{preview.name}</p><WorkButton onClick={() => onPlace(preview)} disabled={previewFailed} className="mt-1">放到画布</WorkButton></div></div>
        {editable && target ? <div className="flex flex-wrap gap-1">{(target.type === "video" ? ["first", "reference", "last"] as const : ["reference"] as const).map(role => {
          const reason = referenceError(target.id, [preview], role);
          return <WorkButton key={role} disabled={Boolean(reason) || previewFailed} title={reason ?? `添加到${String(target.data.name || "节点")}`} onClick={() => applyReference(role)} className="flex-1">用作{VIDEO_ROLE_LABELS[role]}</WorkButton>;
        })}</div> : <p className="text-[11px] text-muted-foreground">选中图片或视频节点后，可添加为参考</p>}
      </section>}
    </aside>}
  </div>;
}
