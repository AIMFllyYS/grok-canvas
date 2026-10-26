"use client";
// Adapted from Vercel AI Elements (Apache-2.0): registry.ai-sdk.dev/conversation.json
import { cn } from "@/lib/utils";
import { ArrowDown } from "lucide-react";
import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
export const Conversation = ({
  className,
  ...props
}: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);
export const ConversationContent = ({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-5 p-5", className)}
    {...props}
  />
);
export function ConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return (
    !isAtBottom && (
      <button
        className="agent-scroll-bottom"
        aria-label="滚动到最新消息"
        onClick={() => void scrollToBottom()}
      >
        <ArrowDown size={16} />
      </button>
    )
  );
}
