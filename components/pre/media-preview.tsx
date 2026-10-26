"use client";
import { Dialog } from "@base-ui/react/dialog";
import { Download, Maximize2, X } from "lucide-react";
/** A single preview primitive for references and generated frames; no extra action row. */
export function MediaPreview({ assetName, name }: { assetName: string; name: string }) {
  const src = `/api/assets/${encodeURIComponent(assetName)}`;
  return <Dialog.Root><Dialog.Trigger className="pre-media-trigger" aria-label={`查看大图：${name}`}><img src={src} alt={name}/><span><Maximize2 size={14}/></span></Dialog.Trigger><Dialog.Portal><Dialog.Backdrop className="pre-media-backdrop"/><Dialog.Popup className="pre-media-dialog"><header><Dialog.Title>{name}</Dialog.Title><a href={src} download aria-label="下载图片"><Download size={16}/></a><Dialog.Close aria-label="关闭图片预览"><X size={17}/></Dialog.Close></header><Dialog.Description className="sr-only">参考图原尺寸预览。按 Escape 关闭，回到当前制作位置。</Dialog.Description><img src={src} alt={name}/></Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
