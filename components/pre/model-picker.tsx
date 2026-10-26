"use client";
import { useEffect, useState } from "react";
import type { AgentSettings } from "@/lib/studio/schema";
type Model = { id: string; name: string; fastId?: string; contextWindows: number[]; efforts: string[] };
export function ModelPicker({ settings, onChange, disabled }: { settings: AgentSettings; onChange: (settings: AgentSettings) => Promise<void>; disabled: boolean }) {
  const [catalog, setCatalog] = useState<{ models: Model[]; defaultSettings: AgentSettings; source?: string; fetchedAt?: string }>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { let alive = true; fetch("/api/studio/models").then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error?.message ?? "模型目录不可用"); if (alive) setCatalog(data); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  const selected = { ...catalog?.defaultSettings, ...settings }, model = catalog?.models.find(m => m.id === selected.model);
  const save = async (next: AgentSettings) => { setSaving(true); setError(""); try { await onChange(next); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } };
  return <details className="pre-model-picker"><summary title={error || "Grok CLI 模型与上下文设置"}>{saving ? "保存中…" : model?.name ?? "选择模型"}<span className="pre-model-tier">{selected.fast ? "FAST" : "STANDARD"}</span></summary><div className="pre-model-popover">
    <strong>模型与上下文</strong><p>沿用 Grok CLI 模型目录 · {catalog?.source === "cli-service" ? "在线读取" : "本机缓存"}{catalog?.fetchedAt ? ` · ${new Date(catalog.fetchedAt).toLocaleDateString("zh-CN")}` : ""}。</p>
    <label>模型<select aria-label="Agent 模型" disabled={disabled || saving} value={selected.model ?? ""} onChange={e => { const next = catalog!.models.find(m => m.id === e.target.value)!; void save({ model: next.id, fast: false, contextWindow: next.contextWindows[0], effort: next.efforts.includes("high") ? "high" : next.efforts[0] }); }}>{!catalog && <option>正在读取模型…</option>}{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label>上下文窗口<select aria-label="上下文窗口" disabled={disabled || saving} value={selected.contextWindow} onChange={e => void save({ ...selected, contextWindow: Number(e.target.value) })}>{model?.contextWindows.map(v => <option value={v} key={v}>{v / 1000}K</option>)}</select></label>
    {!!model?.efforts.length && <label>推理强度<select aria-label="推理强度" disabled={disabled || saving} value={selected.effort} onChange={e => void save({ ...selected, effort: e.target.value })}>{model.efforts.map(v => <option key={v}>{v}</option>)}</select></label>}
    <label className="pre-toggle-label"><span>Fast <small>优先速度，按 CLI fast 变体计费</small></span><input aria-label="Fast 模式" type="checkbox" checked={!!selected.fast} disabled={disabled || saving || !model?.fastId} onChange={e => void save({ ...selected, fast: e.target.checked })}/></label>
    {!model?.fastId && model && <p>此模型没有 fast 档位。</p>}<p>接近预算时自动压缩模型上下文，完整对话仍保留在历史中。</p>{error && <p role="alert">{error}</p>}
  </div></details>;
}
