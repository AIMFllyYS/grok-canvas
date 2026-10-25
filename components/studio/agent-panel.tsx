"use client";
import { useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ToolUIPart } from "ai";
import {
  ArrowUp,
  Bot,
  Clapperboard,
  LoaderCircle,
  Minimize2,
  Paperclip,
  Square,
  Sparkles,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Tool } from "@/components/ai-elements/tool";
import { Reasoning } from "@/components/ai-elements/reasoning";
import type { StudioProject } from "@/lib/studio/schema";
import { finalizeInterruptedMessages } from "@/lib/studio/messages";

export function AgentPanel({
  project,
  onRefresh,
  onBusy,
  beforeSend,
  onMinimize,
  onUpload,
  disabled,
}: {
  project: StudioProject;
  onRefresh: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  beforeSend: (text: string) => Promise<void>;
  onMinimize?: () => void;
  onUpload: () => void;
  disabled: boolean;
}) {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/studio/chat",
        body: { projectId: project.id },
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (!response.ok) {
            let message = `请求失败（${response.status}）`;
            try {
              message = (await response.json()).error?.message ?? message;
            } catch {}
            throw new Error(message);
          }
          return response;
        },
      }),
    [project.id],
  );
  const { messages, sendMessage, status, stop, error, regenerate, setMessages } = useChat({
    id: project.id,
    messages: project.messages,
    transport,
    onFinish: async ({messages:completed,isAbort,isDisconnect,isError}) => {
      if(isAbort||isDisconnect||isError)setMessages(finalizeInterruptedMessages(completed,project.id));
      onBusy(false);
      await onRefresh();
    },
    onError: () => {
      setMessages(current=>finalizeInterruptedMessages(current,project.id));
      onBusy(false);
      void onRefresh();
    },
    onToolCall: () => {
      void onRefresh();
    },
    experimental_throttle: 40,
  });
  const busy = status === "streaming" || status === "submitted";
  const send = async (text: string) => {
    if (!text.trim() || busy || disabled) return;
    try {
      await beforeSend(text);
      setInput("");
      onBusy(true);
      await sendMessage({ text });
    } catch {
      onBusy(false);
    }
  };
  return (
    <section className="studio-agent-panel" aria-label="Agent 对话">
      <div className="studio-agent-header">
        <div className="studio-agent-avatar">
          <Bot size={17} />
        </div>
        <div>
          <strong>创作 Agent</strong>
          <span>
            <i className={busy ? "studio-dot-working" : ""} />
            {busy ? "正在推进制作" : "随时开始创作"}
          </span>
        </div>
        {onMinimize && (
          <button
            aria-label="收起 Agent"
            className="studio-icon-button"
            onClick={onMinimize}
          >
            <Minimize2 size={16} />
          </button>
        )}
      </div>
      <Conversation>
        <ConversationContent>
          {!messages.length && (
            <div className="studio-agent-welcome">
              <div className="studio-welcome-mark">
                <Sparkles size={26} />
              </div>
              <h2>开始创作</h2>
              <p>描述故事，或上传素材。</p>
              <div className="studio-suggestions">
                <button
                  onClick={() =>
                    setInput(
                      "我想制作一部30秒的温暖手绘短片：雨后的街角，一只小猫把掉落的花送回花店。先帮我写完整导演脚本，拆好每段动作节拍。",
                    )
                  }
                >
                  <Clapperboard size={16} />
                  <span>
                    编写脚本
                  </span>
                  <span>↗</span>
                </button>
                <button onClick={onUpload}>
                  <Paperclip size={16} />
                  <span>
                    上传素材
                  </span>
                  <span>↗</span>
                </button>
              </div>
            </div>
          )}
          {messages.filter(message => message.parts.some(part =>
            (part.type === "text" || part.type === "reasoning") ? !!part.text.trim() : part.type.startsWith("tool-") || part.type === "source-url"
          )).map((message, index) => (
            <Message
              key={`${message.id || "message"}-${index}`}
              from={message.role}
            >
              <div className="studio-message-author">
                {message.role === "user" ? "你" : "创作 Agent"}
              </div>
              <MessageContent>
                {message.parts.map((part, i) =>
                  part.type === "text" ? (
                    <MessageResponse
                      key={i}
                      isAnimating={busy && message.id === messages.at(-1)?.id}
                    >
                      {part.text}
                    </MessageResponse>
                  ) : part.type === "reasoning" ? (
                    <Reasoning
                      key={i}
                      text={part.text}
                      streaming={part.state === "streaming"}
                    />
                  ) : part.type.startsWith("tool-") ? (
                    <Tool key={i} part={part as ToolUIPart} />
                  ) : part.type === "source-url" ? (
                    <a key={i} href={part.url} target="_blank" rel="noreferrer">
                      {part.title ?? part.url}
                    </a>
                  ) : null,
                )}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && (
            <div className="studio-thinking" role="status">
              <LoaderCircle size={15} className="animate-spin" />
              正在连接模型…
            </div>
          )}
          {error && (
            <div className="studio-error" role="alert">
              <strong>这一步没有完成</strong>
              <p>{error.message}</p>
              <button
                onClick={() => {
                  onBusy(true);
                  void regenerate().finally(() => onBusy(false));
                }}
              >
                重试对话
              </button>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form
        className="studio-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          aria-label="给 Agent 发送消息"
          placeholder="描述你的想法，或告诉我下一步怎么做…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div>
          <button
            type="button"
            className="studio-icon-button"
            aria-label="上传创作素材"
            disabled={busy || disabled}
            onClick={onUpload}
          >
            <Paperclip size={17} />
          </button>
          <span>Grok · 导演助手</span>
          {busy ? (
            <button
              type="button"
              aria-label="停止 Agent"
              className="studio-send"
              onClick={() => {
                void stop();
                onBusy(false);
                void onRefresh();
              }}
            >
              <Square size={13} />
            </button>
          ) : (
            <button
              type="submit"
              className="studio-send"
              aria-label="发送消息"
              disabled={!input.trim() || disabled}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
