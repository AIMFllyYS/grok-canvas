"use client";
/**
 * 浏览器侧媒体服务（P4-03）：进程内单例 loader 与播放器租约，以及给组件用的 hook。
 * 展示统一取派生图（thumb256/thumb1024）；派生图失败或长时间未就绪时退回原图。
 */
import { useEffect, useRef, useState } from "react";
import { createMediaLoader, MediaLoadError, type FetchResult, type MediaLoader } from "./loader";
import { createPlayerLeases, type PlayerLease, type PlayerLeases } from "./player-leases";
import { canvasMetrics } from "../canvas-runtime/metrics";

export type DisplayVariant = "thumb256" | "thumb1024" | "poster" | "original";

async function fetchMedia(url: string, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(url, { signal, cache: "default" });
  if (response.status === 202) {
    const seconds = Number(response.headers.get("Retry-After") ?? "1");
    return { status: "pending", retryAfterMs: Math.min(5000, Math.max(500, (Number.isFinite(seconds) ? seconds : 1) * 1000)) };
  }
  if (!response.ok) return { status: "failed", message: `HTTP ${response.status}` };
  return { status: "ok", blob: await response.blob() };
}

async function decodeMedia(blob: Blob) {
  let width = 0, height = 0;
  if (typeof createImageBitmap === "function" && blob.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width; height = bitmap.height;
    bitmap.close();
  }
  const url = URL.createObjectURL(blob);
  return { url, width, height, bytes: blob.size, pixels: width * height || Math.ceil(blob.size / 4), dispose: () => URL.revokeObjectURL(url) };
}

const KEY = "__grokCanvasMedia";
type Holder = { [KEY]?: { loader: MediaLoader; players: PlayerLeases } };
export function mediaServices() {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= { loader: createMediaLoader({ fetch: fetchMedia, decode: decodeMedia, maxAttempts: 4 }), players: createPlayerLeases() });
}

const ASSET_URL = /^\/api\/assets\/([^/?#]+)(?:[?#].*)?$/;

/** 资产 URL → 实际请求的变体 URL；非资产 URL 原样返回。 */
export function mediaUrlFor(src: string, variant: DisplayVariant): string {
  const match = ASSET_URL.exec(src);
  if (!match || variant === "original") return src;
  return `/api/assets/${match[1]}/derivative/${variant}`;
}

type MediaState = { url: string | null; state: "loading" | "ready" | "failed"; retry: () => void };

/** 通过共享 loader 取图：卸载或换图时释放引用；派生图失败退回原图（fallback=false 时不退回，例如视频 poster），原图也失败才报错。 */
export function useMediaUrl(src: string, variant: DisplayVariant = "thumb1024", priority = 1, fallback = true): MediaState {
  const [result, setResult] = useState<{ url: string | null; state: MediaState["state"] }>({ url: null, state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const { loader } = mediaServices();
    let cancelled = false;
    const releases: Array<() => void> = [];
    const load = async (url: string) => {
      const handle = loader.acquire(url, url, { priority });
      releases.push(handle.release);
      return handle.promise;
    };
    setResult({ url: null, state: "loading" });
    const preferred = mediaUrlFor(src, variant);
    (async () => {
      try {
        const handle = await load(preferred);
        if (!cancelled) setResult({ url: handle.url, state: "ready" });
      } catch (error) {
        if (cancelled || (error instanceof MediaLoadError && error.code === "aborted")) return;
        if (preferred === src || !fallback) { setResult({ url: null, state: "failed" }); return; }
        try {
          const handle = await load(src);
          if (!cancelled) setResult({ url: handle.url, state: "ready" });
        } catch { if (!cancelled) setResult({ url: null, state: "failed" }); }
      }
      const stats = loader.stats();
      canvasMetrics.record("media_fetch_active", stats.network);
      canvasMetrics.record("media_decode_active", stats.decoding);
    })();
    return () => { cancelled = true; for (const release of releases) release(); };
  }, [src, variant, priority, fallback, attempt]);
  return { ...result, retry: () => setAttempt(value => value + 1) };
}

/** 视频播放器租约：active 为 true 才挂 <video>；被其他节点挤掉时自动卸载。 */
export function usePlayerLease(nodeId: string) {
  const [active, setActive] = useState(false);
  const leaseRef = useRef<PlayerLease | null>(null);
  const pauseRef = useRef<() => void>(() => {});
  useEffect(() => () => { leaseRef.current?.release(); leaseRef.current = null; }, [nodeId]);
  return {
    active,
    /** 申请租约并挂载播放器；pause 回调在其他节点开始播放时调用。 */
    start(pause: () => void) {
      pauseRef.current = pause;
      if (!leaseRef.current?.active()) {
        leaseRef.current = mediaServices().players.acquire(nodeId, {
          pause: () => pauseRef.current(),
          evict: () => { leaseRef.current = null; setActive(false); },
        });
      }
      setActive(true);
      canvasMetrics.record("player_active", mediaServices().players.stats().instances);
      return leaseRef.current;
    },
    lease: () => leaseRef.current,
    stop() { leaseRef.current?.release(); leaseRef.current = null; setActive(false); },
  };
}

/** 首次播放后截一帧上传为 poster（P4-02 只接受客户端截帧）；失败静默，不影响播放。 */
export async function submitPosterFrame(video: HTMLVideoElement, assetName: string) {
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.82));
    if (blob) await fetch(`/api/assets/${encodeURIComponent(assetName)}/derivative/poster`, { method: "POST", body: blob });
  } catch { /* 跨域或解码失败：保持无 poster */ }
}
