"use client";
// AI Elements Message/MessageResponse composition, adapted to the workspace tokens.
import type { ComponentProps } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { cn } from "@/lib/utils";
export function Message({
  from,
  className,
  ...props
}: ComponentProps<"div"> & { from: "user" | "assistant" | "system" }) {
  return (
    <div
      className={cn("agent-message", `agent-message-${from}`, className)}
      data-role={from}
      {...props}
    />
  );
}
export function MessageContent(props: ComponentProps<"div">) {
  return <div className="agent-message-content" {...props} />;
}
export function MessageResponse({ className, ...props }: StreamdownProps) {
  return (
    <Streamdown
      className={cn("agent-markdown", className)}
      plugins={{ cjk, code }}
      animated={{ animation: "fadeIn", duration: 180, sep: "word" }}
      {...props}
    />
  );
}
