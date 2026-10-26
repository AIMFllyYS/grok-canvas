"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UsageSnapshot } from "@/lib/xai/usage";
export function UsageIndicator({ active, loggedIn, compact = false }: { active: boolean; loggedIn: boolean; compact?: boolean }) {
  const [data, setData] = useState<UsageSnapshot | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const latest = useRef<UsageSnapshot | null>(null), pending = useRef(false), abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async (force = false) => {
    if (!loggedIn || pending.current || !force && (document.hidden || latest.current && Date.now() - Date.parse(latest.current.fetchedAt) < 60000)) return;
    pending.current = true; setLoading(true); setError(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const response = await fetch(`/api/auth/usage${force ? "?refresh=1" : ""}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "暂无法读取共享额度");
      if (payload.status !== "ready" || !(Number.isFinite(payload.usedPercent) || Number.isFinite(payload.balanceCredits))) throw new Error("用量数据暂不可用");
      if (!controller.signal.aborted) { latest.current = payload; setData(payload); }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { pending.current = false; if (!controller.signal.aborted) setLoading(false); }
  }, [loggedIn]);
  useEffect(() => {
    if (!loggedIn) { latest.current = null; setData(null); setError(null); }
    if (!active || !loggedIn) return;
    void refresh();
    const update = () => void refresh(); document.addEventListener("visibilitychange", update);
    return () => { abort.current?.abort(); pending.current = false; document.removeEventListener("visibilitychange", update); };
  }, [active, loggedIn, refresh]);
  const amount = loggedIn ? data ? data.usedPercent !== null ? `${Number(data.usedPercent.toFixed(1))}%` : `余额 ${data.balanceCredits?.toLocaleString()}` : loading ? "读取中" : error ? "暂不可用" : "—" : "未登录";
  const info = error ? `${data ? "保留上次数据。" : ""}${error}` : data ? `${data.usedPercent !== null ? `已用 ${amount}` : `上游 credits 余额 ${data.balanceCredits}，按需已用 ${data.onDemandUsed ?? "未知"} / 上限 ${data.onDemandCap ?? "未知"}。上游当前未返回订阅已用百分比` }，更新于 ${new Date(data.fetchedAt).toLocaleTimeString()}${data.resetAt ? `；重置于 ${new Date(data.resetAt).toLocaleString()}` : ""}` : "与 Grok 账户共享";
  return <section aria-label="Grok 共享额度" className={compact ? "pre-usage-inline" : "pre-usage-details"} title={info}>
    <div className="pre-usage-line"><span>共享额度</span><span className="pre-usage-value">{amount}</span><button type="button" aria-label="刷新 Grok 共享额度" title={error ? `${error}，点击刷新` : "刷新共享额度"} disabled={!loggedIn || loading} onClick={() => void refresh(true)}><RefreshCw size={12} className={loading ? "animate-spin" : ""}/></button></div>
    {data?.usedPercent !== null && <div role="progressbar" aria-label="共享额度已用百分比" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data?.usedPercent ?? undefined} aria-valuetext={info} className="pre-usage-progress"><span style={{ width: `${data?.usedPercent ?? 0}%` }}/></div>}
    {!compact && <p role={error ? "status" : undefined}>{info}</p>}
  </section>;
}
