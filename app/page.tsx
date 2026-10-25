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
import type { ImageNodeData } from "@/components/canvas/image-node";
import type { CanvasDoc, CanvasSummary } from "@/lib/canvas-store";
import { normalizeNodeResults, parseGenerationCount } from "@/lib/multi-image";
import type { CanvasSaveStatus } from "@/lib/save-status";
import { WorkspacePreferencesProvider } from "@/components/workspace-preferences";
import { collectCanvasAssets, mergeLibraryAssets, normalizeLibraryAssets } from "@/lib/canvas-library";

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
  // 刷新后不恢复"生成中"状态：MVP 任务不跨页面存活
  // 图片节点顺带规范化候选/主图/数量（旧节点 assetName 解释为唯一成功槽）
  loaded.nodes = (loaded.nodes as Array<{ type?: string; data?: ImageNodeData }>).map((node) => {
    if (!node.data) {
      return node;
    }
    if (node.type !== "image") {
      return { ...node, data: { ...node.data, status: "idle" } };
    }
    const normalized = normalizeNodeResults(node.data);
    return {
      ...node,
      data: {
        ...node.data,
        status: "idle",
        results: normalized.results,
        primaryResultId: normalized.primaryResultId,
        assetName: normalized.assetName,
        generationCount: parseGenerationCount(node.data.generationCount),
      },
    };
  });
  loaded.edges = (loaded.edges as Array<{ type?: string }>).map((edge) => ({
    ...edge,
    type: "scissor",
  }));
  const knownAssets = normalizeLibraryAssets(loaded.libraryAssets);
  loaded.libraryAssets = mergeLibraryAssets(knownAssets, collectCanvasAssets(loaded.nodes, loaded.createdAt, knownAssets));
  return loaded;
}

export default function Home() {
  return <DesktopWorkspace><WorkspacePreferencesProvider><AuthProvider><Workspace /></AuthProvider></WorkspacePreferencesProvider></DesktopWorkspace>;
}

function Workspace() {
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveRetrying, setSaveRetrying] = useState(false);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
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
    setDoc(normalizeDoc((await response.json()) as CanvasDoc));
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
      const created = normalizeDoc((await response.json()) as CanvasDoc);
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
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
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
          <span className="text-sm font-medium">grok-canvas</span>
        )}
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
              onRegisterFlush={(flush) => {
                flushRef.current = flush;
              }}
              onSaveStatus={handleSaveStatus}
            />
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <StatusFeedback tone={loadFailed ? "error" : "muted"} message={loadFailed ? "画布加载失败，请重试" : "画布加载中…"} retry={loadFailed ? () => void loadWorkspace() : undefined} />
          </div>
        )}
      </main>
    </div>
  );
}
