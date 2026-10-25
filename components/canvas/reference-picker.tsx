"use client";

import { useState } from "react";
import { Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { ControlButton } from "../ui/control-button";
import { AssetLibraryGrid } from "./asset-library-grid";
import { useCanvasAssets, type ReferencePickerOptions } from "./canvas-assets-context";
import { VIDEO_ROLE_LABELS, type VideoInputRole } from "@/lib/video-references";
import type { CanvasLibraryAsset } from "@/lib/canvas-library";
import type { ReferenceNode } from "@/lib/canvas-references";

export function ReferencePicker({ node, options, bound, onClose, onUpload, uploading }: {
  node: ReferenceNode; options: ReferencePickerOptions; bound: string[]; onClose: () => void; onUpload: () => void; uploading: boolean;
}) {
  const { assets, addReferences, referenceError } = useCanvasAssets();
  const [selected, setSelected] = useState<CanvasLibraryAsset[]>([]);
  const [role, setRole] = useState<VideoInputRole>(options.role ?? "reference");
  const isMention = Boolean(options.onSelect);
  const error = referenceError(node.id, selected, role);
  const select = (asset: CanvasLibraryAsset) => setSelected(current => current.some(item => item.assetName === asset.assetName)
    ? current.filter(item => item.assetName !== asset.assetName)
    : isMention || role !== "reference" ? [asset] : [...current, asset]);
  const submit = () => {
    if (!selected.length || error) return;
    const accepted = options.onSelect ? options.onSelect(selected[0]!) : addReferences(node.id, selected, role);
    if (accepted) onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex h-[min(680px,86dvh)] w-[min(760px,92vw)] max-w-none flex-col gap-4 p-5 sm:max-w-none" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className="pr-10"><DialogTitle>{isMention ? "在提示词中引用图片" : "选择参考素材"}</DialogTitle><DialogDescription className="mt-2 text-xs">{String(node.data.name || "节点")} · 仅显示当前画布素材，选中后固定绑定这张图片</DialogDescription></div>
      <div className="flex shrink-0 items-center justify-between gap-3">
        {node.type === "video" && !isMention ? <div className="flex gap-1 rounded-lg bg-muted/50 p-1" role="group" aria-label="视频素材角色">{(["first", "reference", "last"] as const).map(value => <ControlButton key={value} aria-pressed={role === value} onClick={() => { setRole(value); setSelected([]); }} className="rounded-md px-3 py-1.5 text-xs">{VIDEO_ROLE_LABELS[value]}</ControlButton>)}</div> : <p className="text-xs text-muted-foreground">{isMention ? "选择一张图片插入 @ 引用" : "可按顺序选择多张图片"}</p>}
        <Button size="sm" variant="outline" onClick={onUpload} disabled={uploading}><Upload size={14} />{uploading ? "正在导入…" : "手动上传"}</Button>
      </div>
      <AssetLibraryGrid assets={assets} selected={selected.map(asset => asset.assetName)} wide onSelect={select} disabledReason={asset => selected.some(item => item.assetName === asset.assetName) ? null : referenceError(node.id, isMention || role !== "reference" ? [asset] : [...selected, asset], role)} />
      <div className="shrink-0 space-y-2 border-t pt-3">
        <p className="text-[11px] text-muted-foreground">当前已绑定 {bound.length} 张 · 本次选择 {selected.length} 张{node.type === "video" ? ` · 用作${VIDEO_ROLE_LABELS[role]}` : " · 最多5张参考图"}</p>
        {selected.length > 0 && <div className="flex max-h-16 flex-wrap gap-1 overflow-y-auto ui-scroll-hidden">{selected.map((asset, index) => <ControlButton key={asset.assetName} onClick={() => select(asset)} className="flex max-w-44 items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]" title={`移除 ${asset.name}`}><span className="text-muted-foreground">{index + 1}</span><span className="truncate">{asset.name}</span><X size={11} /></ControlButton>)}</div>}
        {error && <p role="status" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onClose}>取消</Button><Button size="sm" onClick={submit} disabled={!selected.length || Boolean(error)}>{isMention ? "插入引用" : "添加参考"}</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}
