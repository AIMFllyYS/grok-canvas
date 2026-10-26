"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import type { Attachment } from "@/lib/agent/schema";
export function AgentComposer({
  value,
  onChange,
  onSend,
  busy,
  disabled,
  onStop,
  onUpload,
  attachments,
  onRemove,
  children,
}: {
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  busy: boolean;
  disabled: boolean;
  onStop: () => void;
  onUpload: (files?: File[]) => void;
  attachments: Attachment[];
  onRemove: (id: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "24px";
    if (value) el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  }, [value]);
  return (
    <form
      className="agent-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy && !disabled) onUpload(Array.from(e.dataTransfer.files));
      }}
    >
      {!!attachments.length && (
        <div className="agent-attachments">
          {attachments.map((a) => (
            <span key={a.id} title={a.name}>
              <Paperclip size={11} />
              <span>{a.name}</span>
              <button
                type="button"
                aria-label={`移除附件 ${a.name}`}
                disabled={busy || disabled}
                onClick={() => onRemove(a.id)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="agent-input-row">
        <button
          className="agent-icon-button"
          type="button"
          aria-label="上传 Agent 附件"
          disabled={busy || disabled}
          onClick={() => onUpload()}
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={ref}
          rows={1}
          aria-label="给 Agent 发送消息"
          placeholder="描述你的想法…"
          value={value}
          disabled={disabled}
          title="Enter 发送，Shift + Enter 换行"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {children}
        {busy ? (
          <button
            type="button"
            className="agent-send"
            aria-label="停止 Agent"
            onClick={onStop}
          >
            <Square size={12} />
          </button>
        ) : (
          <button
            type="submit"
            className="agent-send"
            aria-label="发送消息"
            disabled={disabled || (!value.trim() && !attachments.length)}
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </form>
  );
}
