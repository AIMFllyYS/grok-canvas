"use client";
import { useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type ToolUIPart } from "ai";
import { History, Plus, LoaderCircle, Clapperboard, Paperclip, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Tool } from "@/components/ai-elements/tool";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { AgentComposer } from "@/components/pre/agent-composer";
import { ModelPicker } from "@/components/pre/model-picker";
import { WorkButton } from "@/components/pre/primitives";
import { AgentGlyph } from "./studio-icons";
import type { StudioProject, AgentSettings } from "@/lib/studio/schema";
import { finalizeInterruptedMessages } from "@/lib/studio/messages";

export function AgentPanel({ project, onRefresh, onBusy, beforeSend, onUpload, onConversation, disabled }: {
  project: StudioProject; onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void;
  beforeSend: (text: string) => Promise<void>; onUpload: (files?: File[]) => void;
  onConversation: (id?: string, settings?: AgentSettings) => Promise<void>; disabled: boolean;
}) {
  const [input, setInput] = useState(""), [history, setHistory] = useState(false), [switching, setSwitching] = useState(false);
  const chat = project.conversations?.find(c => c.id === project.activeConversationId);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/studio/chat", body: { projectId: project.id, conversationId: project.activeConversationId }, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) { let message = `请求失败（${response.status}）`; try { message = (await response.json()).error?.message ?? message; } catch {} throw new Error(message); }
    return response;
  } }), [project.id, project.activeConversationId]);
  const { messages, sendMessage, status, stop, error, regenerate, setMessages, addToolApprovalResponse } = useChat({
    id: project.activeConversationId ?? project.id, messages: project.messages, transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: async ({ messages: completed, isAbort, isDisconnect, isError }) => { if (isAbort || isDisconnect || isError) setMessages(finalizeInterruptedMessages(completed, project.id)); onBusy(false); await onRefresh(); },
    onError: () => { setMessages(current => finalizeInterruptedMessages(current, project.id)); onBusy(false); void onRefresh(); },
    onToolCall: () => { void onRefresh(); }, experimental_throttle: 40,
  });
  const busy = status === "streaming" || status === "submitted";
  useEffect(() => { onBusy(busy); }, [busy]);
  const send = async (text: string) => {
    if (!text.trim() || busy || disabled || switching) return;
    try { await beforeSend(text); setInput(""); onBusy(true); await sendMessage({ text }); }
    catch (e) { toast.error((e as Error).message); onBusy(false); }
  };
  const select = async (id?: string) => { setSwitching(true); try { await onConversation(id); setHistory(false); } catch (e) { toast.error((e as Error).message); } finally { setSwitching(false); } };
  return <section className="studio-agent-panel" aria-label="Agent 对话">
    <header className="pre-agent-header"><span className="pre-agent-avatar"><AgentGlyph size={23}/></span><div><strong>创作 Agent</strong><small>{busy ? "正在推进制作" : "与画布一起思考"}</small></div><WorkButton variant="ghost" aria-label="历史对话" aria-expanded={history} onClick={() => setHistory(!history)}><History size={16}/></WorkButton><WorkButton variant="ghost" aria-label="新建对话" disabled={busy || disabled || switching} onClick={() => void select()}><Plus size={17}/></WorkButton></header>
    {history ? <div className="pre-chat-history"><div className="pre-section-heading"><strong>历史对话</strong><span>{project.conversations?.length ?? 1}</span></div>{project.conversations?.map(c => <button key={c.id} aria-pressed={c.id === project.activeConversationId} disabled={busy || disabled || switching} onClick={() => void select(c.id)}><History size={15}/><span><strong>{c.title}</strong><small>{c.messages.length} 条消息 · {new Date(c.updatedAt).toLocaleDateString("zh-CN")}</small></span><ChevronRight size={14}/></button>)}</div> : <>
      <div className="pre-chat-title"><span>{chat?.title ?? "新对话"}</span><span>{busy ? "正在执行" : "已保存"}</span></div>
      <Conversation><ConversationContent>
        {!messages.length && <div className="studio-agent-welcome"><div className="pre-welcome-symbol"><AgentGlyph size={34}/></div><span className="studio-eyebrow">YOUR CREATIVE PARTNER</span><h2>从一个想法，<br/>到完整的作品。</h2><p>整理素材、编写脚本，或直接搭建画布。<br/>每一步都在这里，与你一起推进。</p><div className="pre-suggestions"><WorkButton onClick={() => setInput("先帮我梳理创作主题，生成完整导演脚本与分镜计划，等我确认批准后再制作参考图。") }><Clapperboard size={15}/>规划导演脚本<ChevronRight size={13}/></WorkButton><WorkButton onClick={() => onUpload()}><Paperclip size={15}/>从素材开始<ChevronRight size={13}/></WorkButton></div></div>}
        {messages.filter(m => m.parts.some(p => p.type === "text" || p.type === "reasoning" ? !!p.text.trim() : p.type.startsWith("tool-"))).map(message => <Message key={message.id} from={message.role}><div className="studio-message-author">{message.role === "user" ? "你" : <><AgentGlyph size={13}/>创作 Agent</>}</div><MessageContent>{message.parts.map((part, i) => part.type === "text" ? <MessageResponse key={i} isAnimating={busy && message.id === messages.at(-1)?.id}>{part.text}</MessageResponse> : part.type === "reasoning" ? <Reasoning key={i} text={part.text} streaming={busy && part.state === "streaming"}/> : part.type.startsWith("tool-") ? <Tool key={i} part={part as ToolUIPart} onApproval={decision => { onBusy(true); void addToolApprovalResponse(decision); }}/>: part.type === "source-url" ? <a key={i} href={part.url} target="_blank" rel="noreferrer">{part.title ?? part.url}</a> : null)}</MessageContent></Message>)}
        {status === "submitted" && <div className="studio-thinking" role="status"><LoaderCircle size={14} className="animate-spin"/>正在连接 Grok…</div>}
        {error && <div className="studio-error" role="alert"><strong>这一步没有完成</strong><MessageResponse mode="static">{error.message}</MessageResponse><WorkButton disabled={disabled || busy} onClick={() => { onBusy(true); void regenerate().finally(() => onBusy(false)); }}>重试对话</WorkButton></div>}
      </ConversationContent><ConversationScrollButton/></Conversation>
    </>}
    <AgentComposer value={input} onChange={setInput} onSend={() => void send(input)} busy={busy} disabled={disabled || switching} onStop={() => { void stop(); }} onUpload={onUpload} sources={project.sources}><ModelPicker settings={chat?.settings ?? {}} disabled={disabled || busy || switching} onChange={settings => onConversation(project.activeConversationId, settings)}/></AgentComposer>
  </section>;
}
