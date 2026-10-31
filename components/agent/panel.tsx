"use client";
import { memo, useEffect, useMemo, useState, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ToolUIPart, type UIMessage } from "ai";
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
import { Tool, ToolNodeNames, ToolRecords, collectNodeNames, type ToolRecordView } from "@/components/ai-elements/tool";
import { AgentGlyph } from "./icons";
import { AgentComposer } from "./composer";
import { ModelPicker } from "./model-picker";
import { FloatingAgent } from "./floating-agent";
import type { AgentState, AgentSettings, Attachment } from "@/lib/agent/schema";
import { finalizeInterruptedMessages } from "@/lib/agent/messages";
import { bridgeToolPart, previewStore } from "@/lib/canvas-runtime/preview-store";
import { createScheduler } from "@/lib/canvas-runtime/scheduler";
import { createFreezer, MESSAGE_PAGE, windowMessages } from "@/lib/agent/conversation-controller";

/** 预显示更新的有界调度器：同一工具条目只保留最新一次，终态立即执行（P2-09）。 */
const previewScheduler = createScheduler();
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
  active = true,
  beforeSend,
  onBusy,
  onSettled,
}: {
  canvasId: string;
  /** 是否是当前画布的 Agent；不是时面板隐藏，消息列表冻结（P4-06）。 */
  active?: boolean;
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
          visible={active && open}
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
/** 单条消息（P4-06）：已完成的消息对象不变时不重绘；只有正在流式输出的最后一条随 token 更新。 */
const ChatMessage = memo(function ChatMessage({ message: m, animating, nodeNames }: { message: UIMessage; animating: boolean; nodeNames: ReadonlyMap<string, string> }) {
  return (
    <Message from={m.role}>
      <div className="agent-author">
        {m.role === "user" ? "你" : "Agent"}
      </div>
      <MessageContent>
        {m.parts.map((p, i) =>
          p.type === "text" ? (
            <MessageResponse key={i} isAnimating={animating}>
              {p.text}
            </MessageResponse>
          ) : p.type === "reasoning" ? (
            <Reasoning key={i} text={p.text} streaming={animating && p.state === "streaming"} />
          ) : p.type.startsWith("tool-") ? (
            <ToolNodeNames.Provider key={i} value={nodeNames}>
              <Tool part={p as ToolUIPart} />
            </ToolNodeNames.Provider>
          ) : null,
        )}
      </MessageContent>
    </Message>
  );
});
function Chat({
  state,
  visible,
  beforeSend,
  onBusy,
  onFinish,
  onConversation,
}: {
  state: AgentState;
  visible: boolean;
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
  // P4-06：隐藏的面板冻结显示快照（useChat 继续接收，任务照常运行）；只渲染最后 50 条，可加载更早。
  const [freeze] = useState(() => createFreezer<typeof messages>());
  const displayed = freeze(messages, visible);
  const [shownCount, setShownCount] = useState(MESSAGE_PAGE);
  const windowed = windowMessages(displayed, shownCount);
  const lastId = displayed.at(-1)?.id;
  // 工具行显示节点名：从本对话的工具结果里收集 ID → 名称；内容不变时保持同一个对象，已完成的消息不因此重绘。
  const namesRef = useRef<ReturnType<typeof collectNodeNames> | null>(null);
  const nodeNames = useMemo(() => {
    const next = collectNodeNames(displayed);
    const previous = namesRef.current;
    if (previous && previous.size === next.size && [...next].every(([key, value]) => previous.get(key) === value)) return previous;
    namesRef.current = next;
    return next;
  }, [displayed]);
  // 只读预显示：只桥接正在进行的最后一条回复里已确认的工具输入/结果；结束后清掉没有交接正式节点的条目。
  const canvasId = state.canvasId;
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts) if (part.type.startsWith("tool-")) bridgeToolPart(previewStore, canvasId, part as ToolUIPart, previewScheduler);
    if (!busy) {
      previewScheduler.cancelPrefix(`${canvasId}:`);
      for (const entry of previewStore.get(canvasId)) if (!entry.nodeId) previewStore.remove(canvasId, entry.toolCallId, entry.itemIndex);
    }
  }, [messages, busy, canvasId]);
  useEffect(() => () => { previewScheduler.cancelPrefix(`${canvasId}:`); previewStore.clearCanvas(canvasId); }, [canvasId]);
  // P5-04：空闲时读取工具调用的持久状态（读取即收敛中断的调用），中断的工具卡片据此显示真实结果。
  const [toolRecords, setToolRecords] = useState<ReadonlyMap<string, ToolRecordView>>(() => new Map());
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    void fetch(`/api/agent/tool-calls?canvasId=${encodeURIComponent(canvasId)}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { records?: Array<{ toolCallId: string } & ToolRecordView> } | null) => {
        if (!stopped && d?.records) setToolRecords(new Map(d.records.map(r => [r.toolCallId, { phase: r.phase, ...(r.summary ? { summary: r.summary } : {}), ...(r.error ? { error: r.error } : {}) }])));
      })
      .catch(() => {});
    return () => { stopped = true; };
  }, [busy, canvasId]);
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
              <span>整理想法，创建或调整文本、图片与视频节点。</span>
            </div>
          )}
          {windowed.hidden > 0 && (
            <button type="button" className="agent-load-more" onClick={() => setShownCount((count) => count + MESSAGE_PAGE)}>
              加载更早的 {Math.min(windowed.hidden, MESSAGE_PAGE)} 条消息（还有 {windowed.hidden} 条）
            </button>
          )}
          <ToolRecords.Provider value={toolRecords}>
          {windowed.items.map((m) => (
            <ChatMessage key={m.id} message={m} animating={busy && m.id === lastId} nodeNames={nodeNames} />
          ))}
          </ToolRecords.Provider>
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
