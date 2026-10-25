"use client";

import { useState, type ComponentProps } from "react";
import { StatusFeedback } from "./status-feedback";

/** Key by src to clear failure and retry state when the asset changes. */
type AssetImageProps = Omit<ComponentProps<"img">, "src" | "alt"> & { src: string; alt: string };
export function AssetImage(props: AssetImageProps) {
  return <AssetImageState key={props.src} {...props} />;
}
function AssetImageState({ src, alt, className, onLoad, onError, ...props }: AssetImageProps) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed) return <StatusFeedback tone="error" message="图片加载失败" retry={() => { setFailed(false); setAttempt(value => value + 1); }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} src={attempt ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : src} alt={alt} className={className} draggable={false} onLoad={onLoad} onError={event => { setFailed(true); onError?.(event); }} />;
}
