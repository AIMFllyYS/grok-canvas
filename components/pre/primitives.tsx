"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, FileText, Paperclip } from "lucide-react";
export function WorkButton({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <button type="button" className={`pre-button pre-button-${variant} ${className}`} {...props}/>;
}
export function FileChip({ name, kind, trailing }: { name: string; kind?: string; trailing?: ReactNode }) {
  return <span className="pre-file-chip" title={name}>{kind === "text" ? <FileText size={13}/> : <Paperclip size={13}/>}<span>{name}</span>{trailing}</span>;
}
export function ApprovalCard({ approved, title = "确认脚本，进入制作", children, onApprove, onReject, disabled }: { approved: boolean; title?: string; children: ReactNode; onApprove: () => void; onReject?: () => void; disabled?: boolean }) {
  return <section className="pre-approval" data-approved={approved} aria-label="脚本批准">
    <div className="pre-approval-mark">{approved ? <Check size={18}/> : <span>01</span>}</div>
    <div><strong>{approved ? "脚本已批准" : title}</strong><div className="pre-approval-description">{children}</div></div>
    <div className="pre-approval-actions">{!approved ? <><WorkButton variant="primary" disabled={disabled} onClick={onApprove}><Check size={14}/>确认批准</WorkButton>{onReject && <WorkButton disabled={disabled} onClick={onReject}>继续修改</WorkButton>}</> : onReject && <WorkButton disabled={disabled} onClick={onReject}>撤销批准</WorkButton>}</div>
  </section>;
}
