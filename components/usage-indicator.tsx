"use client";

import { useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "@/lib/xai/usage";

export function UsageIndicator({ active, loggedIn }: { active: boolean; loggedIn: boolean }) {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<UsageSnapshot | null>(null);
  useEffect(() => {
    if (!active || !loggedIn) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (document.hidden || loading || latest.current && Date.now() - Date.parse(latest.current.fetchedAt) < 60_000) return;
      loading = true;
      setError(null);
      try {
        const response = await fetch("/api/auth/usage", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message ?? "暂无法读取共享额度");
        if (payload.status !== "ready" || typeof payload.usedPercent !== "number" || !Number.isFinite(payload.usedPercent) || payload.usedPercent < 0 || payload.usedPercent > 100) throw new Error("用量数据暂不可用");
        if (!controller.signal.aborted) { latest.current = payload; setData(payload); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "暂无法读取共享额度");
      } finally { loading = false; }
    };
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); document.removeEventListener("visibilitychange", refresh); };
  }, [active, loggedIn]);
  return <section aria-label="Grok 共享额度" className="space-y-2 px-2 py-3">
    <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">Grok 共享额度</span><span className="tabular-nums">{loggedIn ? data ? `已用 ${Number(data.usedPercent.toFixed(1))}%` : error ? "暂不可用" : "读取中…" : "登录后查看"}</span></div>
    <div role="progressbar" aria-label="共享额度已用百分比" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data?.usedPercent} className="h-1.5 overflow-hidden rounded-full bg-muted">
      {data && <div className={`h-full rounded-full ${data.usedPercent >= 90 ? "bg-destructive" : "bg-foreground/75"}`} style={{ width: `${data.usedPercent}%` }} />}
    </div>
    {error && <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{data ? `更新失败 · ${error}` : error}</p>}
    {data && <div className="space-y-1 text-[10px] text-muted-foreground">
      {data.resetAt && <p>重置于 {new Date(data.resetAt).toLocaleString()}</p>}
      <p>更新于 {new Date(data.fetchedAt).toLocaleTimeString()} · 与Grok账户共享</p>
    </div>}
  </section>;
}
