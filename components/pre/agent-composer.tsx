"use client";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { FileChip, WorkButton } from "./primitives";
import type { Source } from "@/lib/studio/schema";
export function AgentComposer({ value, onChange, onSend, busy, disabled, onStop, onUpload, sources = [], children }: { value: string; onChange: (value: string) => void; onSend: () => void; busy: boolean; disabled: boolean; onStop: () => void; onUpload: (files?: File[]) => void; sources?: Source[]; children?: React.ReactNode }) {
  return <form className="pre-composer" onSubmit={e => { e.preventDefault(); onSend(); }} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (!busy && !disabled) onUpload(Array.from(e.dataTransfer.files)); }}>
    {sources.length > 0 && <div className="pre-composer-files" aria-label="可用项目素材">{sources.map(s => <FileChip key={s.id} name={s.name} kind={s.kind}/>)}</div>}
    <textarea aria-label="给 Agent 发送消息" placeholder="描述想法，让创作开始。" value={value} disabled={disabled} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); } }}/>
    <div className="pre-composer-footer"><WorkButton variant="ghost" aria-label="上传创作素材" title="上传图片、MP4 或 Markdown，也可以拖入" disabled={busy || disabled} onClick={() => onUpload()}><Paperclip size={16}/></WorkButton><div className="pre-composer-settings">{children}</div>{busy ? <WorkButton aria-label="停止 Agent" onClick={onStop}><Square size={13}/></WorkButton> : <WorkButton type="submit" variant="primary" aria-label="发送消息" disabled={!value.trim() || disabled}><ArrowUp size={17}/></WorkButton>}</div>
    <p className="pre-composer-hint">Enter 发送 · Shift + Enter 换行 · 支持拖入附件</p>
  </form>;
}
