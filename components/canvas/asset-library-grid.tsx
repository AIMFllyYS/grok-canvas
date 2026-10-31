"use client";

import { useMemo, useState, type DragEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Images, Search } from "lucide-react";
import { AssetImage } from "../ui/asset-image";
import { ControlButton } from "../ui/control-button";
import { writeAssetDrag } from "@/lib/asset-drag";
import { LIBRARY_SOURCE_LABELS, type CanvasLibraryAsset, type CanvasLibrarySource } from "@/lib/canvas-library";

function AssetCard({ asset, selected, reason, draggable, onSelect, onDragStart, onDragEnd }: {
  asset: CanvasLibraryAsset; selected: boolean; reason?: string | null; draggable: boolean; onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void; onDragEnd: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const blocked = reason || (failed ? "图片文件不可用" : !ready ? "图片正在加载" : null);
  // 不可用的素材不允许拖进提示词，避免插进一个必然 404 的引用。
  const canDrag = draggable && !reason && !failed;
  return <div className="min-w-0" draggable={canDrag} onDragStart={canDrag ? onDragStart : undefined} onDragEnd={canDrag ? onDragEnd : undefined}>
    <div className={`relative aspect-square overflow-hidden rounded-lg bg-muted/50 ring-1 ${selected ? "ring-foreground" : "ring-border"}`}>
      <AssetImage src={`/api/assets/${encodeURIComponent(asset.assetName)}`} variant="thumb256" priority={2} alt={asset.name} decoding="async" className="size-full object-cover" onLoad={() => { setFailed(false); setReady(true); }} onError={() => { setFailed(true); setReady(false); }} />
      <ControlButton aria-label={asset.name} aria-pressed={selected} disabled={Boolean(blocked)} title={blocked ?? asset.name} onClick={onSelect} className="absolute inset-0 rounded-lg bg-transparent! hover:ring-2 hover:ring-inset hover:ring-foreground/50 disabled:pointer-events-none" />
      {selected && <span className="pointer-events-none absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><Check size={12} /></span>}
    </div>
    <p className="mt-2 truncate text-xs" title={asset.name}>{asset.name}</p>
    <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={blocked ?? undefined}>{reason || (failed ? "图片不可用" : asset.sources.map(source => LIBRARY_SOURCE_LABELS[source]).join(" · "))}</p>
  </div>;
}

export function AssetLibraryGrid({ assets, selected = [], onSelect, disabledReason, wide = false, draggable = false, onAssetDragStart, onAssetDragEnd }: {
  assets: CanvasLibraryAsset[]; selected?: string[]; onSelect: (asset: CanvasLibraryAsset) => void; disabledReason?: (asset: CanvasLibraryAsset) => string | null; wide?: boolean;
  /** 开启后素材可拖到提示词输入框，效果与 @ 引用一致。 */
  draggable?: boolean; onAssetDragStart?: (asset: CanvasLibraryAsset) => void; onAssetDragEnd?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<CanvasLibrarySource | "all">("all");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => assets.filter(asset => (source === "all" || asset.sources.includes(source)) && asset.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).toReversed(), [assets, source, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 40));
  const current = Math.min(page, pages - 1);
  const chosen = new Set(selected);
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border bg-background/50 px-3 text-muted-foreground"><Search size={14} /><input aria-label="搜索当前画布素材" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索素材名称…" className="w-full bg-transparent text-xs text-foreground outline-none" /></label>
    <div className="flex shrink-0 gap-1" role="group" aria-label="素材来源">
      {(["all", "generated", "imported", "manual"] as const).map(value => <ControlButton key={value} aria-pressed={source === value} onClick={() => { setSource(value); setPage(0); }} className="flex-1 rounded-md px-1 py-1.5 text-[11px] text-muted-foreground">{value === "all" ? "全部" : LIBRARY_SOURCE_LABELS[value]}</ControlButton>)}
    </div>
    <div className="ui-scroll-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain p-0.5">
      {filtered.length ? <div className={`grid gap-x-3 gap-y-4 ${wide ? "grid-cols-4" : "grid-cols-2"}`}>
        {filtered.slice(current * 40, current * 40 + 40).map(asset => <AssetCard key={asset.assetName} asset={asset} selected={chosen.has(asset.assetName)} reason={disabledReason?.(asset)}
          draggable={draggable && !disabledReason?.(asset)}
          onDragStart={event => { writeAssetDrag(event.dataTransfer, asset.assetName); onAssetDragStart?.(asset); }}
          onDragEnd={() => onAssetDragEnd?.()}
          onSelect={() => onSelect(asset)} />)}
      </div> : <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><Images size={26} strokeWidth={1.2} /><p className="text-xs">{query ? "没有匹配的素材" : "这里还没有图片"}</p><p className="text-[11px]">上传或生成的图片只在当前画布共享</p></div>}
    </div>
    <div className="flex shrink-0 items-center justify-between border-t pt-2 text-[11px] text-muted-foreground"><span>{filtered.length} 张素材</span><div className="flex items-center gap-2"><ControlButton aria-label="上一页素材" disabled={current === 0} onClick={() => setPage(current - 1)} className="rounded p-1 disabled:opacity-30"><ChevronLeft size={14} /></ControlButton><span>{current + 1} / {pages}</span><ControlButton aria-label="下一页素材" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)} className="rounded p-1 disabled:opacity-30"><ChevronRight size={14} /></ControlButton></div></div>
  </div>;
}
