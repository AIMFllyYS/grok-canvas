"use client";
import { useEffect, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ApprovalCard, WorkButton } from "./primitives";
import { isScriptApproved, type StudioProject } from "@/lib/studio/schema";
export function ScriptReview({ project, busy, onSave, onApprove }: { project: StudioProject; busy: boolean; onSave: (fields: Record<string, unknown>) => Promise<void>; onApprove: () => Promise<void> }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(project.script), [saving, setSaving] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (!editing) setDraft(project.script); }, [project.script, editing]);
  const approved = isScriptApproved(project);
  const run = async (operation: () => Promise<void>) => { setSaving(true); setError(""); try { await operation(); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } };
  return <div className="pre-script-review"><div className="pre-script-toolbar"><span>脚本 v{project.scriptVersion ?? 0} · {project.shots.length} 个片段</span><div>{editing ? <><WorkButton disabled={busy || saving} onClick={() => { setEditing(false); setDraft(project.script); }}><X size={13}/>取消</WorkButton><WorkButton variant="primary" disabled={busy || saving || !draft.trim()} onClick={() => void run(async () => { await onSave({ script: draft }); setEditing(false); })}><Save size={13}/>保存修改</WorkButton></> : <WorkButton disabled={busy || saving} onClick={() => setEditing(true)}><Pencil size={13}/>编辑脚本</WorkButton>}</div></div>
    {editing ? <textarea className="pre-script-editor" aria-label="编辑完整导演脚本" value={draft} onChange={e => setDraft(e.target.value)}/> : <MessageResponse className="pre-script-content" mode="static">{project.script}</MessageResponse>}
    <details className="pre-plan-outline"><summary>分镜与参考计划 · {project.shots.length} 个片段 · {project.references.length} 份参考</summary><div>{project.shots.map(shot => <article key={shot.id}><strong>{shot.id} · {shot.title} <span>{shot.duration}s</span></strong><MessageResponse mode="static">{shot.description.zh}</MessageResponse><p>绑定参考：{shot.refs.map(id => `@${id}`).join(" · ") || "无"}</p></article>)}</div></details>
    <ApprovalCard approved={approved} disabled={busy || saving || editing} onApprove={() => void run(onApprove)} onReject={() => { if (approved) void run(() => onSave({ approveScript: false })); else setEditing(true); }}><p>{approved ? "当前版本已批准，可逐镜制作或批量补齐。修改脚本、分镜或视觉规范后需重新批准。" : "审阅脚本、参考库和分镜计划。确认批准后，自动开始生成缺失参考图。"}</p></ApprovalCard>
    {error && <p className="studio-error" role="alert">{error}</p>}
  </div>;
}
