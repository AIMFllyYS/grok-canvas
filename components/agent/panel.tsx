"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ToolUIPart } from "ai";
import { Popover } from "@base-ui/react/popover";
import { Check, Plus, History, LoaderCircle } from "lucide-react";
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
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import { AgentGlyph } from "./icons";
import { AgentComposer } from "./composer";
import { ModelPicker } from "./model-picker";
import { FloatingAgent } from "./floating-agent";
import type { AgentState, AgentSettings, Attachment } from "@/lib/agent/schema";
import { finalizeInterruptedMessages } from "@/lib/agent/messages";
async function request(url: string, init?: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message ?? "请求失败");
  return d;
}
export function CanvasAgent({
  canvasId,
  beforeSend,
  onBusy,
  onSettled,
}: {
  canvasId: string;
  beforeSend: () => Promise<boolean>;
  onBusy: (busy: boolean) => void;
  onSettled: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState<AgentState>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState(false),
    [changing, setChanging] = useState(false);
  const current = useRef(canvasId);
  current.current = canvasId;
  const reload = async () => {
    const p = await request(
      `/api/agent/conversations?canvasId=${encodeURIComponent(canvasId)}`,
    );
    if (current.current === canvasId) {
      setState(p);
      return p;
    }
  };
  useEffect(() => {
    setState(undefined);
    setError("");
    void reload().catch((e) => setError(e.message));
  }, [canvasId]);
  const change = async (id?: string, settings?: AgentSettings) => {
    setChanging(true);
    setError("");
    try {
      const p = await request("/api/agent/conversations", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify({ canvasId, conversationId: id, settings }),
      });
      setState(p);
      setHistory(false);
    } finally {
      setChanging(false);
    }
  };
  const updateBusy = (v: boolean) => {
    setBusy(v);
    onBusy(v);
  };
  const actions = (
    <>
      <Popover.Root open={history} onOpenChange={setHistory}>
        <Popover.Trigger
          className="agent-icon-button"
          aria-label="历史对话"
          title="历史对话"
          disabled={busy || changing || !state}
        >
          <History size={14} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="agent-menu-layer"
          >
            <Popover.Popup className="agent-history-menu">
              <header>
                <Popover.Title>历史对话</Popover.Title>
              </header>
              <div>
                {state?.conversations.map((c) => (
                  <button
                    key={c.id}
                    disabled={busy || changing}
                    aria-pressed={c.id === state.activeConversationId}
                    onClick={() =>
                      void change(c.id).catch((e) => setError(e.message))
                    }
                  >
                    <History size={13} />
                    <span>
                      <strong>{c.title}</strong>
                      <small>
                        {c.messages.length} 条消息 ·{" "}
                        {new Date(c.updatedAt).toLocaleDateString("zh-CN")}
                      </small>
                    </span>
                    {c.id === state.activeConversationId && <Check size={13} />}
                  </button>
                ))}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <button
        className="agent-icon-button"
        aria-label="新建对话"
        title="新建对话"
        disabled={busy || changing || !state}
        onClick={() => void change().catch((e) => setError(e.message))}
      >
        <Plus size={16} />
      </button>
    </>
  );
  return (
    <FloatingAgent
      open={open}
      onOpenChange={setOpen}
      busy={busy}
      headerActions={actions}
    >
      {error && (
        <p className="agent-menu-error" role="alert">
          {error}
        </p>
      )}
      {state ? (
        <Chat
          key={`${canvasId}:${state.activeConversationId}`}
          state={state}
          beforeSend={beforeSend}
          onBusy={updateBusy}
          onFinish={async () => {
            await reload();
            await onSettled();
          }}
          onConversation={change}
        />
      ) : (
        <div className="agent-loading">
          <LoaderCircle size={16} className="animate-spin" />
        </div>
      )}
    </FloatingAgent>
  );
}
function Chat({
  state,
  beforeSend,
  onBusy,
  onFinish,
  onConversation,
}: {
  state: AgentState;
  beforeSend: () => Promise<boolean>;
  onBusy: (v: boolean) => void;
  onFinish: () => Promise<void>;
  onConversation: (id?: string, settings?: AgentSettings) => Promise<void>;
}) {
  const [input, setInput] = useState(""),
    [switching, setSwitching] = useState(false),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [uploading, setUploading] = useState(false),
    [localError, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const chat = state.conversations.find(
    (c) => c.id === state.activeConversationId,
  )!;
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        body: { canvasId: state.canvasId, conversationId: chat.id },
        fetch: async (url, init) => {
          const r = await fetch(url, init);
          if (!r.ok) {
            const d = await r.json();
            throw new Error(d.error?.message ?? "请求失败");
          }
          return r;
        },
      }),
    [state.canvasId, chat.id],
  );
  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    setMessages,
    regenerate,
  } = useChat({
    id: chat.id,
    messages: chat.messages,
    transport,
    onFinish: async ({ messages: done, isAbort, isDisconnect, isError }) => {
      if (isAbort || isDisconnect || isError)
        setMessages(finalizeInterruptedMessages(done, chat.id));
      onBusy(false);
      await onFinish();
    },
    onError: () => {
      onBusy(false);
      void onFinish();
    },
    experimental_throttle: 40,
  });
  const busy = status === "streaming" || status === "submitted",
    disabled = switching || uploading;
  useEffect(() => {
    onBusy(busy);
    return () => {};
  }, [busy]);
  const send = async () => {
    if (busy || disabled || (!input.trim() && !attachments.length)) return;
    setError("");
    try {
      if (!(await beforeSend())) throw new Error("请先保存画布");
      const text = [
        input,
        ...attachments.map((a) =>
          a.kind === "text"
            ? `附件 ${a.name}：\n${a.text}`
            : `附件 ${a.name}（${a.kind}），已保存素材名：${a.assetName}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
      setInput("");
      setAttachments([]);
      await sendMessage({ text });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const change = async (id?: string, settings?: AgentSettings) => {
    setSwitching(true);
    try {
      await onConversation(id, settings);
    } finally {
      setSwitching(false);
    }
  };
  const upload = async (files?: File[]) => {
    if (!files) {
      file.current?.click();
      return;
    }
    setUploading(true);
    try {
      if (files.length + attachments.length > 8) throw new Error("最多8个附件");
      const body = new FormData();
      for (const f of files) body.append("files", f);
      const r = await fetch("/api/agent/attachments", { method: "POST", body }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error?.message ?? "上传失败");
      setAttachments((a) => [...a, ...d.attachments]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  return (
    <section className="canvas-agent" aria-label="Agent 对话">
      <Conversation>
        <ConversationContent>
          {!messages.length && (
            <div className="agent-empty">
              <AgentGlyph size={25} />
              <p>从当前画布开始</p>
              <span>整理想法，创建或调整图片与视频节点。</span>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} from={m.role}>
              <div className="agent-author">
                {m.role === "user" ? "你" : "Agent"}
              </div>
              <MessageContent>
                {m.parts.map((p, i) =>
                  p.type === "text" ? (
                    <MessageResponse
                      key={i}
                      isAnimating={busy && m.id === messages.at(-1)?.id}
                    >
                      {p.text}
                    </MessageResponse>
                  ) : p.type === "reasoning" ? (
                    <Reasoning
                      key={i}
                      text={p.text}
                      streaming={busy && p.state === "streaming"}
                    />
                  ) : p.type.startsWith("tool-") ? (
                    <Tool key={i} part={p as ToolUIPart} />
                  ) : null,
                )}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && (
            <div className="agent-status">
              <LoaderCircle size={13} className="animate-spin" />
              正在连接 Grok…
            </div>
          )}
          {(error || localError) && (
            <div role="alert" className="agent-error">
              <MessageResponse mode="static">
                {error?.message ?? localError}
              </MessageResponse>
              {error && (
                <button
                  disabled={busy || disabled}
                  onClick={() => void regenerate()}
                >
                  重试
                </button>
              )}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <input
        hidden
        ref={file}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,.md,.txt,.markdown"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (list.length) void upload(list);
        }}
      />
      <AgentComposer
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        busy={busy}
        disabled={disabled}
        onStop={() => void stop()}
        onUpload={(files) => void upload(files)}
        attachments={attachments}
        onRemove={(id) => setAttachments((a) => a.filter((f) => f.id !== id))}
      >
        <ModelPicker
          settings={chat.settings}
          disabled={busy || disabled}
          onChange={(s) => change(chat.id, s)}
        />
      </AgentComposer>
    </section>
  );
}
