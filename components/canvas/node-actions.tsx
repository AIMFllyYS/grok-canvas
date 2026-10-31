"use client";

import { GenerationInformation } from "./generation-information";
import { buttonVariants } from "@/components/ui/button";
import { ControlButton } from "@/components/ui/control-button";

import { useEffect, useState } from "react";
import { NodeToolbar, Position, useReactFlow } from "@xyflow/react";
import { Download, Expand, Pin, PinOff, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const iconButton = "ui-tool-button flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary";
const assetUrl = (name: string) => `/api/assets/${encodeURIComponent(name)}`;

export function NodeActions({ id, name, assetName, selected, pinned, kind = "image" }: {
  id: string;
  name: string;
  assetName?: string | null;
  selected?: boolean;
  pinned: boolean;
  kind?: "image" | "video";
}) {
  const { updateNode } = useReactFlow();
  const [open, setOpen] = useState(false);
  const downloadLabel = kind === "video" ? "下载原片" : "下载原图";
  const inspectLabel = kind === "video" ? "查看详情" : "查看大图";

  return <>
    {/* NodeToolbar keeps its screen size independent of canvas zoom. 只在选中时挂载：
        NodeToolbar 的 store 订阅每次视口/拖动更新都会遍历全部节点数选中数，几千节点时每个实例都很贵。 */}
    {selected && <NodeToolbar position={Position.Top} offset={20} isVisible>
      <div className="nodrag nopan flex items-center rounded-full border bg-popover p-1 shadow-lg" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <ControlButton className={`${iconButton} ${pinned ? "bg-accent text-primary" : ""}`} title={pinned ? "取消固定" : "固定节点"} aria-label={pinned ? "取消固定" : "固定节点"} aria-pressed={pinned} onClick={() => updateNode(id, { draggable: pinned })}>
          {pinned ? <PinOff size={17} /> : <Pin size={17} />}
        </ControlButton>
        {assetName && <>
          <span className="mx-2 h-5 w-px bg-border" aria-hidden="true" />
          <ControlButton className={iconButton} href={assetUrl(assetName)} download={assetName} title={downloadLabel} aria-label={downloadLabel}><Download size={17} /></ControlButton>
          <ControlButton className={iconButton} title={inspectLabel} aria-label={inspectLabel} onClick={() => setOpen(true)}><Expand size={17} /></ControlButton>
        </>}
      </div>
    </NodeToolbar>}
    {pinned && <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-background/85 p-1.5 shadow" title="节点已固定"><Pin size={13} /></span>}
    {assetName && <Dialog open={open} onOpenChange={setOpen}>
      {open && (kind === "video"
        ? <VideoDetails key={assetName} name={name} assetName={assetName} />
        : <ImageDetails key={assetName} name={name} assetName={assetName} />)}
    </Dialog>}
  </>;
}

function CloseButton({ enlarged = false }: { enlarged?: boolean }) {
  return <DialogClose data-ui-control="true" className={`absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full focus-visible:outline-2 ${enlarged ? "bg-black/60 text-white hover:bg-black/80" : "bg-popover hover:bg-accent"}`} aria-label={enlarged ? "返回图片详情" : "关闭图片详情"} title={enlarged ? "返回图片详情" : "关闭"}><X size={18} /></DialogClose>;
}

function ImageView({ name, assetName, onSize }: { name: string; assetName: string; onSize?: (size: { width: number; height: number }) => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="m-auto text-sm text-white/70">图片加载失败，请关闭后重试</p> : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={assetUrl(assetName)} alt={name} draggable={false} className="h-full w-full object-contain" onLoad={(event) => onSize?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function VideoDetails({ name, assetName }: { name: string; assetName: string }) {
  const [size, setSize] = useState<{ width: number; height: number; duration: number } | null>(null);
  const [file, setFile] = useState<{ bytes: number | null; format: string } | null>(null);
  const [metadataFailed, setMetadataFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(assetUrl(assetName), { method: "HEAD", cache: "no-store", signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error("metadata unavailable");
      const length = response.headers.get("Content-Length");
      const bytes = length === null ? null : Number(length);
      const mime = response.headers.get("Content-Type")?.split(";")[0] ?? "";
      setFile({
        bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
        format: mime.replace("video/", "").toUpperCase() || "未知",
      });
    }).catch(() => { if (!controller.signal.aborted) setMetadataFailed(true); });
    return () => controller.abort();
  }, [assetName]);
  const rows = [
    ["尺寸", size ? `${size.width} × ${size.height} px` : "读取中…"],
    ["时长", size ? `${size.duration.toFixed(1)} 秒` : "读取中…"],
    ["格式", file?.format ?? (metadataFailed ? "无法读取" : "读取中…")],
    ["文件大小", file ? (file.bytes === null ? "未知" : formatBytes(file.bytes)) : (metadataFailed ? "无法读取" : "读取中…")],
  ];

  return <DialogContent showCloseButton={false} className="nodrag nopan nowheel flex h-[88dvh] w-[94vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:flex-row" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <CloseButton />
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black/90 p-3">
      <video
        src={assetUrl(assetName)}
        className="max-h-full max-w-full"
        controls
        playsInline
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setSize({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
        }}
      />
    </div>
    <aside className="flex max-h-[45%] w-full shrink-0 flex-col border-t md:max-h-none md:w-72 md:border-l md:border-t-0">
      <DialogTitle className="truncate px-5 py-5 pr-14">{name}</DialogTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <GenerationInformation key={assetName} assetName={assetName} />
        <h3 className="mb-3 text-sm font-medium">视频信息</h3>
        <dl className="space-y-3 rounded-xl bg-muted p-4 text-sm">
          {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="text-right">{value}</dd></div>)}
        </dl>
      </div>
      <div className="p-5">
        <a href={assetUrl(assetName)} download={assetName} className={buttonVariants({ className: "w-full" })}>
          <Download />下载
        </a>
      </div>
    </aside>
  </DialogContent>;
}

function ImageDetails({ name, assetName }: { name: string; assetName: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [file, setFile] = useState<{ bytes: number | null; format: string } | null>(null);
  const [metadataFailed, setMetadataFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(assetUrl(assetName), { method: "HEAD", cache: "no-store", signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error("metadata unavailable");
      const length = response.headers.get("Content-Length");
      const bytes = length === null ? null : Number(length);
      setFile({
        bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
        format: response.headers.get("Content-Type")?.split(";")[0]?.replace("image/", "").toUpperCase() || "未知",
      });
    }).catch(() => { if (!controller.signal.aborted) setMetadataFailed(true); });
    return () => controller.abort();
  }, [assetName]);
  const rows = [
    ["尺寸", size ? `${size.width} × ${size.height} px` : "读取中…"],
    ["格式", file?.format ?? (metadataFailed ? "无法读取" : "读取中…")],
    ["文件大小", file ? (file.bytes === null ? "未知" : formatBytes(file.bytes)) : (metadataFailed ? "无法读取" : "读取中…")],
  ];

  return <DialogContent showCloseButton={false} className="nodrag nopan nowheel flex h-[88dvh] w-[94vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:flex-row" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <CloseButton />
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black/90 p-3">
      <Dialog>
        <DialogTrigger className="h-full w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-white" aria-label="放大图片">
          <ImageView name={name} assetName={assetName} onSize={setSize} />
        </DialogTrigger>
        <DialogContent showCloseButton={false} className="nodrag nopan nowheel flex h-[96dvh] w-[98vw] max-w-none items-center justify-center overflow-hidden bg-black p-2 sm:max-w-none" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <DialogTitle className="sr-only">{name} · 放大查看</DialogTitle>
          <ImageView name={name} assetName={assetName} />
          <CloseButton enlarged />
        </DialogContent>
      </Dialog>
    </div>
    <aside className="flex max-h-[45%] w-full shrink-0 flex-col border-t md:max-h-none md:w-72 md:border-l md:border-t-0">
      <DialogTitle className="truncate px-5 py-5 pr-14">{name}</DialogTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <GenerationInformation key={assetName} assetName={assetName} />
        <h3 className="mb-3 text-sm font-medium">图片信息</h3>
        <dl className="space-y-3 rounded-xl bg-muted p-4 text-sm">
          {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="text-right">{value}</dd></div>)}
        </dl>
      </div>
      <div className="p-5">
        <a href={assetUrl(assetName)} download={assetName} className={buttonVariants({ className: "w-full" })}>
          <Download />下载
        </a>
      </div>
    </aside>
  </DialogContent>;
}
