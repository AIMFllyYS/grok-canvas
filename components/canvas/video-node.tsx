"use client";

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { sameNodeView } from "@/lib/canvas-runtime/node-view";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeSurface } from "@/components/ui/node-surface";
import { StatusFeedback } from "@/components/ui/status-feedback";
import { useAuth } from "@/components/auth-status";
import { generationStatusFeedback, loginRequired } from "@/lib/generation-auth-feedback";
import type { VideoAspectRatio, VideoDuration, VideoResolution } from "@/lib/video-request";
import type { VideoInput } from "@/lib/video-references";
import type { VideoErrorKind, VideoGenerationRequest } from "@/lib/video-runtime";
import { Pause, Play, Video, Volume2, VolumeX } from "lucide-react";
import { NodeActions } from "./node-actions";
import { NodeTitle } from "./node-title";
import { PlusHandle } from "./image-node";
import { useCanvasActions } from "./flow-canvas";
import { ImagineLoading } from "./imagine-loading";
import { submitPosterFrame, useMediaUrl, usePlayerLease } from "@/lib/media/browser-media";

/** 视频封面：取 poster 派生图（不退回原视频，避免为封面下载整段视频）；没有封面时显示占位。点击开始播放。 */
function VideoPoster({ assetName, name, onRatio, onPlay }: { assetName: string; name: string; onRatio: (ratio: number) => void; onPlay: () => void }) {
  const poster = useMediaUrl(`/api/assets/${encodeURIComponent(assetName)}`, "poster", 1, false);
  return (
    <button type="button" aria-label={`播放视频：${name}`} onClick={onPlay} className="relative flex h-full w-full items-center justify-center bg-black/80">
      {poster.url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={poster.url} alt="" draggable={false} className="h-full w-full object-contain" onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) onRatio(img.naturalWidth / img.naturalHeight); }} />
        : <Video className="h-8 w-8 text-white/40" aria-hidden />}
    </button>
  );
}

export type VideoNodeData = {
  name: string;
  assetName: string | null;
  prompt: string;
  draftPrompt?: string;
  duration: VideoDuration;
  aspectRatio: VideoAspectRatio | null;
  resolution: VideoResolution;
  audio: boolean;
  status: "idle" | "running" | "failed";
  taskId?: string | null;
  waitedSeconds?: number;
  errorMessage?: string | null;
  errorKind?: VideoErrorKind | null;
  generationRequest?: VideoGenerationRequest;
  uploadInputs?: VideoInput[];
  attachmentNames?: Record<string, string>;
  sourceNodeId?: string | null;
  [key: string]: unknown;
};

export type VideoFlowNode = Node<VideoNodeData, "video">;

const BOX_SIZE = 280;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function previewRatio(aspectRatio: VideoAspectRatio | null): number {
  if (!aspectRatio) return 16 / 9;
  const parts = aspectRatio.split(":").map(Number);
  const width = parts[0];
  const height = parts[1];
  return width && height && width > 0 && height > 0 ? width / height : 16 / 9;
}

export function defaultVideoNodeData(name: string): VideoNodeData {
  return {
    name,
    assetName: null,
    prompt: "",
    duration: 10,
    aspectRatio: "16:9",
    resolution: "720p",
    audio: true,
    status: "idle",
    uploadInputs: [],
    sourceNodeId: null,
  };
}

export const VideoNode = memo(function VideoNode({ id, data, selected, draggable }: NodeProps<VideoFlowNode>) {
  const { generateVideo } = useCanvasActions();
  const { loggedIn, login } = useAuth();
  const running = data.status === "running";
  const failedFeedback = generationStatusFeedback(loggedIn);
  const [ratio, setRatio] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(data.waitedSeconds ?? 0);
  // 播放器换成自绘控件：画面本体留给节点拖动，只有底部控制条是 nodrag。
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  // P4-03：默认只显示 poster；点播放才申请播放器租约并挂 <video>，被其他节点挤掉时自动卸载。
  const player = usePlayerLease(id);
  const posterSent = useRef(false);
  const togglePlay = () => {
    const video = videoRef.current;
    if (!player.active || !video) { player.start(() => videoRef.current?.pause()); return; }
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  // 页面隐藏时暂停，回到前台不自动播放。
  useEffect(() => {
    if (!player.active) { setPlaying(false); return; }
    const onVisibility = () => { if (document.visibilityState === "hidden") videoRef.current?.pause(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [player.active]);
  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  useEffect(() => {
    setRatio(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [data.assetName]);

  useEffect(() => {
    setElapsed(data.waitedSeconds ?? 0);
    if (!running) return;
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running, data.waitedSeconds]);

  let boxStyle: CSSProperties;
  if (!data.assetName) {
    const selected = previewRatio(data.aspectRatio);
    boxStyle = selected < 1
      ? { height: BOX_SIZE, width: Math.max(120, Math.round(BOX_SIZE * selected)) }
      : { width: BOX_SIZE, aspectRatio: String(selected) };
  } else if (ratio !== null && ratio < 1) {
    boxStyle = { height: BOX_SIZE, width: Math.max(120, Math.round(BOX_SIZE * ratio)) };
  } else {
    boxStyle = { width: BOX_SIZE, aspectRatio: ratio ? String(ratio) : "16 / 9" };
  }

  return (
    <div className="group relative">
      <NodeActions
        id={id}
        name={data.name}
        assetName={data.assetName}
        selected={selected}
        pinned={draggable === false}
        kind="video"
      />
      <PlusHandle type="target" position={Position.Left} className={selected ? "!opacity-100" : ""} />
      <PlusHandle type="source" position={Position.Right} className={selected ? "!opacity-100" : ""} />
      <div className="nodrag absolute -top-7 left-0 flex items-center gap-1.5">
        <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <NodeTitle nodeId={id} name={data.name} />
      </div>
      <NodeSurface selected={selected} className="relative flex items-center justify-center" style={boxStyle}>
        {data.assetName ? (
          <div className="group/video relative h-full w-full">
            {player.active ? <video
              ref={videoRef}
              src={`/api/assets/${encodeURIComponent(data.assetName)}`}
              aria-label={`视频：${data.name}`}
              className="h-full w-full object-contain"
              playsInline
              autoPlay
              preload="metadata"
              onClick={togglePlay}
              onLoadedData={(event) => {
                if (posterSent.current || !data.assetName) return;
                posterSent.current = true;
                void submitPosterFrame(event.currentTarget, data.assetName);
              }}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                  setRatio(video.videoWidth / video.videoHeight);
                }
                setDuration(Number.isFinite(video.duration) ? video.duration : 0);
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onPlay={() => { setPlaying(true); player.lease()?.play(); }}
              onPause={() => { setPlaying(false); player.lease()?.paused(); }}
              onEnded={() => { setPlaying(false); player.lease()?.paused(); }}
              onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
            /> : <VideoPoster assetName={data.assetName} name={data.name} onRatio={setRatio} onPlay={togglePlay} />}
            <div
              className={`nodrag nopan absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-1.5 pb-1.5 pt-4 text-white/90 transition-opacity duration-150 ${playing ? "opacity-0 group-hover/video:opacity-100 group-focus-within/video:opacity-100" : "opacity-100"}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button type="button" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} onClick={togglePlay} className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white">
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <input
                type="range"
                aria-label="播放进度"
                min={0}
                max={duration || 0}
                step={0.05}
                value={Math.min(currentTime, duration || 0)}
                onChange={(event) => {
                  const video = videoRef.current;
                  const next = Number(event.target.value);
                  if (video) video.currentTime = next;
                  setCurrentTime(next);
                }}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
              />
              <span className="shrink-0 tabular-nums text-[10px]">{formatTime(currentTime)} / {formatTime(duration)}</span>
              <button type="button" aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} onClick={toggleMute} className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white">
                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            </div>
          </div>
        ) : data.status === "failed" ? (
          <div className="nodrag nopan p-4">
            <StatusFeedback
              tone={loginRequired(loggedIn) ? "muted" : "error"}
              message={loginRequired(loggedIn) ? failedFeedback.message : (data.errorMessage ?? failedFeedback.message)}
              actionLabel={failedFeedback.actionLabel}
              retry={loginRequired(loggedIn) ? () => void login() : () => generateVideo(id, { retry: true })}
            />
          </div>
        ) : running ? (
          <ImagineLoading />
        ) : (
          <Video className="h-8 w-8 text-muted-foreground/40" />
        )}
        {running ? (
          <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-popover px-3 py-1 text-xs text-foreground">
            {`生成中 · 已等待 ${elapsed} 秒`}
          </div>
        ) : null}
      </NodeSurface>
    </div>
  );
}, sameNodeView);
