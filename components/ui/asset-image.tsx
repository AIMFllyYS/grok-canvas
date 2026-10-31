"use client";

import { useState, type ComponentProps } from "react";
import { useMediaUrl, type DisplayVariant } from "@/lib/media/browser-media";
import { StatusFeedback } from "./status-feedback";

/**
 * 资产图片（P4-03）：经共享媒体服务加载（网络 6 / 解码 2 并发、同图去重、按引用释放），
 * 默认显示 thumb1024 派生图，variant="original" 才取原图。按 src+variant 作为 key，换图时重置失败与重试状态。
 */
type AssetImageProps = Omit<ComponentProps<"img">, "src" | "alt"> & { src: string; alt: string; variant?: DisplayVariant; priority?: number };
export function AssetImage(props: AssetImageProps) {
  return <AssetImageState key={`${props.src}|${props.variant ?? "thumb1024"}`} {...props} />;
}
function AssetImageState({ src, alt, className, onLoad, onError, variant = "thumb1024", priority = 1, loading: _loading, ...props }: AssetImageProps) {
  const media = useMediaUrl(src, variant, priority);
  const [broken, setBroken] = useState(false);
  if (media.state === "failed" || broken) return <StatusFeedback tone="error" message="图片加载失败" retry={() => { setBroken(false); media.retry(); }} />;
  if (!media.url) return <div className={`${className ?? ""} animate-pulse bg-muted/40`} role="img" aria-label={alt} aria-busy="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} src={media.url} alt={alt} className={className} draggable={false} onLoad={onLoad} onError={event => { setBroken(true); onError?.(event); }} />;
}
