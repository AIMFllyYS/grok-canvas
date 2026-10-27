"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { toast } from "sonner";
import { AuthProvider } from "@/components/auth-status";
import { AuthWidget } from "@/components/auth-widget";
import { CanvasSwitcher } from "@/components/canvas-switcher";
import { FlowCanvas } from "@/components/canvas/flow-canvas";
import { DesktopWorkspace } from "@/components/desktop-workspace";
import { StatusFeedback } from "@/components/ui/status-feedback";
import { ProjectMark } from "@/components/ui/project-mark";
import type { ImageNodeData } from "@/components/canvas/image-node";
import type { CanvasDoc, CanvasSummary } from "@/lib/canvas-store";
import { normalizeNodeResults, parseGenerationCount, UNCONFIRMED_RESULT_MESSAGE } from "@/lib/multi-image";
import type { CanvasSaveStatus } from "@/lib/save-status";
import { WorkspacePreferencesProvider } from "@/components/workspace-preferences";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets } from "@/lib/canvas-library";
import { CanvasAgent } from "@/components/agent/panel";
import { useTheme } from "next-themes";

const AUTH_RESULT_TEXT: Record<string, string> = {
  ok: "登录成功",
  denied: "授权被拒绝",
  missing_code: "回调缺少 code",
  state_mismatch: "state 不匹配，请重新登录",
  no_pending_session: "没有进行中的登录，请重新发起",
  token_exchange_failed: "换 token 失败",
  tier_denied: "当前账号没有对应套餐权限",
  failed: "登录失败",
};

function normalizeDoc(loaded: CanvasDoc): CanvasDoc {
  // 保留服务端确认仍在运行的任务；状态未确认时提示用户检查结果。
  // 图片节点顺带规范化候选/主图/数量（旧节点 assetName 解释为唯一成功槽）
  loaded.nodes = (loaded.nodes as Array<{ id?: string; type?: string; data?: ImageNodeData }>).map((node) => {
    if (!node.data) {
      return node;
    }
    const ownClaim = loaded.generationClaims?.[node.id ?? ""];
    const sourceClaim = typeof node.data.sourceNodeId === "string" ? loaded.generationClaims?.[node.data.sourceNodeId] : undefined;
    const claim = ownClaim ?? (sourceClaim?.id === node.data.generationId ? sourceClaim : undefined);
    const status = claim?.state === "pending" ? "running" : claim?.state === "unknown" ? "failed" : "idle";
    const error = claim?.state === "unknown" ? { errorMessage: UNCONFIRMED_RESULT_MESSAGE } : {};
    if (node.type !== "image") {
      return { ...node, selected: false, data: { ...node.data, status, ...error } };
    }
    const normalized = normalizeNodeResults(node.data);
    return {
      ...node,
      selected: false,
      data: {
        ...node.data,
        status,
        ...error,
        results: normalized.results,
        primaryResultId: normalized.primaryResultId,
        assetName: normalized.assetName,
        generationCount: parseGenerationCount(node.data.generationCount),
      },
    };
  });
  loaded.edges = (loaded.edges as Array<{ type?: string }>).map((edge) => ({
    ...edge,
    selected: false,
    type: "scissor",
  }));
  const knownAssets = normalizeLibraryAssets(loaded.libraryAssets);
  loaded.libraryAssets = mergeLibraryAssets(knownAssets, collectCanvasAssets(loaded.nodes, loaded.createdAt, knownAssets));
  return loaded;
}

export default function Home() {
  const { theme, setTheme } = useTheme();
  useEffect(() => { if (theme === "paper") setTheme("light"); }, [theme, setTheme]);
  return <DesktopWorkspace><WorkspacePreferencesProvider><AuthProvider><Workspace /></AuthProvider></WorkspacePreferencesProvider></DesktopWorkspace>;
}

function Workspace() {
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busyAgents, setBusyAgents] = useState<Record<string, boolean>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRetrying, setSaveRetrying] = useState(false);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const canvasBaselines = useRef(new Map<string, CanvasDoc>());
  const currentCanvasRef = useRef<string | undefined>(undefined);
  currentCanvasRef.current = doc?.id;
  const transitionRef = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const transition = async (action: () => Promise<void>) => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    try { await action(); } finally { transitionRef.current = false; setTransitioning(false); }
  };

  const handleSaveStatus = useCallback((status: CanvasSaveStatus) => {
    setSaveError(status.ok ? null : status.message);
  }, []);

  const openCanvas = useCallback(async (id: string) => {
    const response = await fetch(`/api/canvases/${id}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    const loaded = (await response.json()) as CanvasDoc;
    canvasBaselines.current.set(id, structuredClone(loaded));
    setDoc(normalizeDoc(loaded));
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoadFailed(false);
    try {
      const response = await fetch("/api/canvases", { cache: "no-store" });
      if (!response.ok) throw new Error("load failed");
      const payload = (await response.json()) as { canvases: CanvasSummary[]; lastCanvasId: string };
      setCanvases(payload.canvases);
      await openCanvas(payload.lastCanvasId);
    } catch {
      setLoadFailed(true);
    }
  }, [openCanvas]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get("auth");
    if (auth) {
      const reason = params.get("reason");
      const text = `${AUTH_RESULT_TEXT[auth] ?? auth}${reason ? `：${reason}` : ""}`;
      if (auth === "ok") {
        toast.success(text);
      } else {
        toast.error(text);
      }
      window.history.replaceState(null, "", "/");
    }

    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    setSaveError(null);
    setSaveRetrying(false);
    if (doc?.id) setAgentIds(ids => ids.includes(doc.id) ? ids : [...ids, doc.id]);
  }, [doc?.id]);

  // 切换/新建前必须把当前画布待保存的修改落盘，失败则留在当前画布
  const flushCurrent = async (): Promise<boolean> => (await flushRef.current?.()) ?? true;

  const retrySave = async () => {
    setSaveRetrying(true);
    try {
      await flushCurrent();
    } finally {
      setSaveRetrying(false);
    }
  };

  const switchCanvas = async (id: string) => {
    if (!doc || id === doc.id) {
      return;
    }
    if (!(await flushCurrent())) {
      toast.error("当前画布保存失败，请重试后再切换");
      return;
    }
    try {
      await openCanvas(id);
    } catch {
      toast.error("画布加载失败，请重试");
    }
  };

  const createFreshCanvas = async (): Promise<void> => {
    try {
      const response = await fetch("/api/canvases", { method: "POST" });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const loaded = (await response.json()) as CanvasDoc;
      canvasBaselines.current.set(loaded.id, structuredClone(loaded));
      const created = normalizeDoc(loaded);
      setCanvases((current) => [
        { id: created.id, name: created.name, createdAt: created.createdAt, updatedAt: created.updatedAt },
        ...current,
      ]);
      setDoc(created);
    } catch {
      toast.error("新建画布失败，请重试");
    }
  };

  const createCanvas = async () => {
    if (doc && !(await flushCurrent())) {
      toast.error("当前画布保存失败，请重试");
      return;
    }
    await createFreshCanvas();
  };

  const deleteCanvasById = async (id: string) => {
    if (busyAgents[id]) { toast.error("请先停止该画布正在运行的 Agent"); return; }
    if (doc?.id === id && !(await flushCurrent())) {
      toast.error("当前画布尚未保存，无法删除");
      return;
    }
    try {
      const response = await fetch(`/api/canvases/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
    } catch {
      toast.error("删除画布失败，请重试");
      return;
    }
    const remaining = canvases.filter((item) => item.id !== id);
    setCanvases(remaining);
    setAgentIds(ids => ids.filter(item => item !== id));
    if (doc && id === doc.id) {
      if (remaining[0]) {
        try {
          await openCanvas(remaining[0].id);
        } catch {
          toast.error("画布加载失败，请重试");
        }
      } else {
        // 删光了：新建一个空画布，保证始终有画布可用
        await createFreshCanvas();
      }
    }
  };

  const renameCanvas = (name: string) => {
    if (!doc) {
      return;
    }
    setDoc({ ...doc, name });
    setCanvases((current) => current.map((item) => (item.id === doc.id ? { ...item, name } : item)));
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        {/* 名称区约占顶栏 1/4 宽；上限放在顶栏这一层，百分比才按顶栏宽度算，
            放进里面的子元素会让 max-w 相对收缩成很小的值，长名字只剩两三个字。 */}
        <div className="flex min-w-0 max-w-[25%] items-center gap-2.5">
          <ProjectMark size={22} className="shrink-0" />
          {doc ? (
            <CanvasSwitcher
              doc={doc}
              canvases={canvases}
              onSwitch={(id) => void transition(() => switchCanvas(id))}
              onCreate={() => void transition(createCanvas)}
              onDelete={(id) => void transition(() => deleteCanvasById(id))}
              onRename={renameCanvas}
            />
          ) : (
            <span className="truncate text-sm font-medium">grok-canvas</span>
          )}
        </div>
        <AuthWidget />
      </header>
      {saveError ? (
        <div className="flex shrink-0 justify-center border-b px-4 py-2">
          <StatusFeedback
            compact
            tone="error"
            message={saveRetrying ? "正在保存…" : saveError}
            retry={saveRetrying ? undefined : () => void retrySave()}
          />
        </div>
      ) : null}
      {transitioning && <div role="status" className="border-b px-4 py-1 text-center text-xs text-muted-foreground">正在完成导入并保存画布…</div>}
      <main className="min-h-0 flex-1" inert={transitioning}>
        {doc ? (
          <ReactFlowProvider>
            <FlowCanvas
              key={doc.id}
              doc={doc}
              baseline={canvasBaselines.current.get(doc.id) ?? doc}
              onRegisterFlush={(flush) => {
                flushRef.current = flush;
              }}
              onSaveStatus={handleSaveStatus}
              onRestoreName={name => {
                setDoc(current => current?.id === doc.id ? { ...current, name } : current);
                setCanvases(current => current.map(item => item.id === doc.id ? { ...item, name } : item));
              }}
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <StatusFeedback tone={loadFailed ? "error" : "muted"} message={loadFailed ? "画布加载失败，请重试" : "画布加载中…"} retry={loadFailed ? () => void loadWorkspace() : undefined} />
          </div>
        )}
      </main>
      {agentIds.map(id => <div key={id} hidden={id !== doc?.id}>
        <CanvasAgent canvasId={id} beforeSend={async () => currentCanvasRef.current === id && ((await flushRef.current?.()) ?? true)} onBusy={busy => setBusyAgents(current => current[id] === busy ? current : { ...current, [id]: busy })} onSettled={async () => { if (currentCanvasRef.current === id) await flushRef.current?.(); }}/>
      </div>)}
    </div>
  );
}
