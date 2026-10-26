"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronRight,
  Clapperboard,
  Download,
  FileText,
  Film,
  ImagePlus,
  Layers,
  LoaderCircle,
  Plus,
  ListChecks,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AuthWidget } from "@/components/auth-widget";
import { uploadAssets } from "@/lib/asset-upload";
import type { Source, StudioProject, StudioSummary, AgentSettings } from "@/lib/studio/schema";
import type { ActionInput, ProductionAction } from "@/lib/studio/production";
import { AgentPanel } from "./agent-panel";
import { DirectorDesk, type DeskView } from "./director-desk";
import { EdgePanel } from "./edge-panel";
import {
  StudioMark,
  AgentGlyph,
  DirectorGlyph,
  CanvasGlyph,
} from "./studio-icons";
import { WorkflowPreview } from "./workflow-preview";
import { FloatingAgent } from "@/components/pre/floating-agent";
import { UsageIndicator } from "@/components/usage-indicator";
import { useAuth } from "@/components/auth-status";
import { useTheme } from "next-themes";

type Mode = "director" | "canvas";
type Props = {
  renderCanvas: (
    id: string,
    version: number,
    register: (prepare: () => Promise<boolean>) => void,
    onCanvasChange: (id: string) => Promise<void>,
  ) => ReactNode;
};
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
  return body;
}

export function StudioWorkspace({ renderCanvas }: Props) {
  const { theme, resolvedTheme } = useTheme();
  const { loggedIn, status: authStatus } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [mode, setMode] = useState<Mode>("canvas"),
    [project, setProject] = useState<StudioProject | null>(null),
    [projects, setProjects] = useState<StudioSummary[]>([]);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [agentBusy, setAgentBusy] = useState(false),
    [pending, setPending] = useState("");
  const [floating, setFloating] = useState(false),
    [canvasVersion, setCanvasVersion] = useState(0),
    [batch, setBatch] = useState(false);
  const [deskView, setDeskView] = useState<DeskView>("shots");
  useEffect(() => { const close = () => setFloating(false); window.addEventListener("grok-canvas:library-open", close); return () => window.removeEventListener("grok-canvas:library-open", close); }, []);
  useEffect(() => { if (floating) window.dispatchEvent(new Event("grok-canvas:agent-open")); }, [floating]);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null),
    projectRef = useRef(project),
    prepareRef = useRef<(() => Promise<boolean>) | null>(null),
    stopBatch = useRef(false),
    modeRef = useRef(mode);
  const booted = useRef(false);
  projectRef.current = project;
  modeRef.current = mode;
  const busy = agentBusy || !!pending || batch || remoteBusy;
  const refresh = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const updated = await request<StudioProject & { producing?: boolean }>(
      `/api/studio/projects/${current.id}`,
    );
    if (projectRef.current?.id === current.id) {
      projectRef.current = updated;
      setProject(updated);
      setRemoteBusy(Boolean(updated.producing));
      setProjects((items) =>
        items.map((p) =>
          p.id === updated.id
            ? {
                ...p,
                title: updated.title,
                updatedAt: updated.updatedAt,
                shotCount: updated.shots.length,
                completed: updated.shots.filter((s) => s.videoApproved).length,
              }
            : p,
        ),
      );
    }
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { projects: list } = await request<{ projects: StudioSummary[] }>(
        "/api/studio/projects",
      );
      setProjects(list);
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem("grok-studio-project");
      } catch {}
      const id = list.find((p) => p.id === remembered)?.id ?? list[0]?.id;
      const p = id
        ? await request<StudioProject>(`/api/studio/projects/${id}`)
        : await request<StudioProject>("/api/studio/projects", {
            method: "POST",
            body: "{}",
          });
      projectRef.current = p;
      setProject(p);
      setDeskView(p.shots.length ? "shots" : "brief");
      setRemoteBusy(
        Boolean((p as StudioProject & { producing?: boolean }).producing),
      );
      if (!id) setProjects([{ ...p, shotCount: 0, completed: 0 }]);
      try {
        localStorage.setItem("grok-studio-project", p.id);
      } catch {}
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void load();
  }, [load]);
  const prepare = async () => {
    if (
      modeRef.current === "canvas" &&
      prepareRef.current &&
      !(await prepareRef.current())
    )
      throw new Error("请先保存当前画布，再继续制作");
  };
  const patch = async (fields: Record<string, unknown>, alreadyPrepared = false) => {
    if (!alreadyPrepared) await prepare();
    const p = projectRef.current;
    if (!p) return;
    try {
      const updated = await request<StudioProject>(
        `/api/studio/projects/${p.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ revision: p.revision, ...fields }),
        },
      );
      projectRef.current = updated;
      setProject(updated);
      setProjects((items) =>
        items.map((item) =>
          item.id === p.id ? { ...item, title: updated.title } : item,
        ),
      );
      return updated;
    } catch (error) {
      toast.error((error as Error).message);
      await refresh();
      throw error;
    }
  };
  const action = async (action: ProductionAction, input: ActionInput = {}) => {
    await prepare();
    const p = projectRef.current;
    if (!p) return;
    setPending(`${action}:${input.targetId ?? ""}`);
    try {
      const data = await request<{ project: StudioProject }>(
        `/api/studio/projects/${p.id}/actions`,
        { method: "POST", body: JSON.stringify({ action, ...input }) },
      );
      projectRef.current = data.project;
      setProject(data.project);
      if (action === "script") setDeskView("script");
      setProjects((items) =>
        items.map((item) =>
          item.id === data.project.id
            ? {
                ...item,
                title: data.project.title,
                updatedAt: data.project.updatedAt,
                shotCount: data.project.shots.length,
                completed: data.project.shots.filter((s) => s.videoApproved)
                  .length,
              }
            : item,
        ),
      );
      if (modeRef.current === "canvas") setCanvasVersion((v) => v + 1);
      if (action !== "poll")
        toast.success(
          action === "video"
            ? "视频任务已提交，完成后会自动更新"
            : action === "script"
              ? "导演脚本与分镜计划已生成"
              : action === "export"
                ? "完整视频已合成"
                : "已保存制作结果",
        );
    } catch (error) {
      toast.error((error as Error).message);
      await refresh();
      throw error;
    } finally {
      setPending("");
    }
  };
  const safeAction: typeof action = async (...args) => {
    try {
      await action(...args);
    } catch {}
  };
  const pollInFlight = useRef(false);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (pollInFlight.current) return;
      const p = projectRef.current;
      if (!p) return;
      pollInFlight.current = true;
      try {
        if (agentBusy || pending || remoteBusy) {
          await refresh();
          return;
        }
        if (p.shots.some((s) => s.taskId)) {
          const data = await request<{ project: StudioProject }>(
            `/api/studio/projects/${p.id}/actions`,
            { method: "POST", body: JSON.stringify({ action: "poll" }) },
          );
          if (projectRef.current?.id === p.id) {
            projectRef.current = data.project;
            setProject(data.project);
            if (modeRef.current === "canvas") setCanvasVersion((v) => v + 1);
          }
        }
      } catch {
        /* Individual upstream failures stay visible in the durable event log; retry reads, never submissions. */
      } finally {
        pollInFlight.current = false;
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [agentBusy, pending, remoteBusy, refresh]);
  const changeMode = async (next: Mode) => {
    try {
      await prepare();
      setMode(next);
      if (next !== "canvas") prepareRef.current = null;
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const selectProject = async (id: string) => {
    if (busy) return;
    try {
      await prepare();
      const p = await request<StudioProject>(`/api/studio/projects/${id}`);
      projectRef.current = p;
      setProject(p);
      setDeskView(p.shots.length ? "shots" : "brief");
      try {
        localStorage.setItem("grok-studio-project", id);
      } catch {}
      setCanvasVersion((v) => v + 1);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const create = async () => {
    if (busy) return;
    setPending("create");
    try {
      await prepare();
      const p = await request<StudioProject>("/api/studio/projects", {
        method: "POST",
        body: JSON.stringify({ title: `新作品 ${projects.length + 1}` }),
      });
      projectRef.current = p;
      setProject(p);
      setProjects((items) => [{ ...p, shotCount: 0, completed: 0 }, ...items]);
      setMode("director");
      setDeskView("brief");
      try {
        localStorage.setItem("grok-studio-project", p.id);
      } catch {}
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setPending("");
    }
  };
  const upload = async (files: File[]) => {
    if (!project || busy) return;
    setPending("upload");
    try {
      await prepare();
      for (const file of files) {
        let source: Source;
        if (/\.mp4$/i.test(file.name)) {
          const p = projectRef.current!,
            form = new FormData();
          form.append("file", file);
          const response = await fetch(
            `/api/studio/projects/${p.id}/upload-video`,
            { method: "POST", body: form },
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error?.message ?? "视频上传失败");
          projectRef.current = data.project;
          setProject(data.project);
          continue;
        } else if (/\.(txt|md|markdown)$/i.test(file.name)) {
          if (file.size > 500000) throw new Error("文本素材不能超过500KB");
          source = {
            id: crypto.randomUUID(),
            name: file.name,
            kind: "text",
            text: (await file.text()).slice(0, 120000),
          };
        } else {
          const result = (await uploadAssets([file]))[0];
          if (!result?.asset) throw new Error(result?.error ?? "上传失败");
          source = {
            id: crypto.randomUUID(),
            name: file.name,
            kind: "image",
            text: "",
            assetName: result.asset.name,
          };
        }
        await patch({ source }, true);
      }
      toast.success("素材已加入导演台，可以让 Agent 分析整理");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setPending("");
      if (modeRef.current === "canvas") setCanvasVersion(v => v + 1);
    }
  };
  const runBatch = async (
    stage: "reference" | "storyboard" | "video" | "all",
  ) => {
    if (busy) return;
    setBatch(true);
    stopBatch.current = false;
    const failed: string[] = [];
    try {
      const stages =
        stage === "all"
          ? (["reference", "storyboard", "video"] as const)
          : [stage];
      for (const current of stages) {
        const p = projectRef.current!;
        const ids =
          current === "reference"
            ? p.references.filter((r) => !r.assetName).map((r) => r.id)
            : p.shots
                .filter((s) =>
                  current === "storyboard"
                    ? !s.imageAsset
                    : !s.videoAsset && !s.taskId,
                )
                .map((s) => s.id);
        for (const id of ids) {
          if (stopBatch.current) return;
          try {
            await action(current, { targetId: id });
          } catch {
            failed.push(`${current}:${id}`);
          }
        }
      }
      if (failed.length)
        toast.error(
          `本轮有 ${failed.length} 项未完成，已记录原因；其他可执行镜头继续保留。`,
        );
    } finally {
      setBatch(false);
      setPending("");
    }
  };
  const onAgentBusy = (value: boolean) => {
    setAgentBusy(value);
    if (!value && modeRef.current === "canvas") setCanvasVersion((v) => v + 1);
  };
  const beforeSend = async (text: string) => {
    await prepare();
  };
  return (
    <div
      className="studio-app"
      data-mode={mode}
      data-agent-open={floating}
      data-appearance={
        mounted
          ? theme === "system"
            ? (resolvedTheme ?? "paper")
            : (theme ?? "paper")
          : "paper"
      }
    >
      <header className="studio-topbar">
        <div className="studio-brand">
          <StudioMark size={29} />
          <strong>
            Grok <span>Canvas</span>
          </strong>
        </div>
        <UsageIndicator key={`${authStatus?.email}:${authStatus?.lastRefresh}`} active loggedIn={loggedIn === true} compact/>
        <nav className="studio-mode-switch" aria-label="工作台模式">
          {(
            [
                            ["director", "导演台", DirectorGlyph],
              ["canvas", "创作画布", CanvasGlyph],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={mode === id}
              onClick={() => void changeMode(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
        {mode === "director" && <div className="studio-desk-controls">
          <button className="studio-icon-button" aria-label="刷新制作状态" title="刷新制作状态" disabled={refreshing} onClick={() => { setRefreshing(true); void refresh().catch(error => toast.error(error.message)).finally(() => setRefreshing(false)); }}><RefreshCw size={13} className={refreshing ? "animate-spin" : ""}/></button>
          <select aria-label="导演台视图" value={deskView} onChange={event => setDeskView(event.target.value as DeskView)}>
            <option value="shots">分镜</option><option value="brief">简报</option><option value="script">剧本</option><option value="refs">素材</option><option value="archive">成片</option>
          </select>
          <button className="studio-icon-button" aria-label="自主制作" title="批量补齐缺失产物" disabled={busy || !project?.shots.length} onClick={() => void runBatch("all")}><ListChecks size={16} /></button>
        </div>}
        <div className="studio-account">
          <AuthWidget />
        </div>
      </header>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,video/mp4,.mp4,.txt,.md,.markdown"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />
      <div className="studio-body">
        {(
          <EdgePanel defaultPinned={mode === "director"}><div className="studio-sidebar">
            <button
              className="studio-new-project"
              disabled={busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              新建导演台<span>↗</span>
            </button>
            <div className="studio-sidebar-heading">
              <span>我的作品</span>
              <span>{projects.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="studio-project-list">
              {projects.map((item) => (
                <button
                  key={item.id}
                  data-active={item.id === project?.id}
                  disabled={busy}
                  onClick={() => void selectProject(item.id)}
                >
                  <Film size={15} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.shotCount
                        ? `${item.shotCount} 个镜头 · ${item.completed} 个已验收`
                        : "等待第一个灵感"}
                    </small>
                  </span>
                  {item.id === project?.id && <i />}
                </button>
              ))}
            </div>
            {project && <nav className="pre-desk-nav" aria-label="制作步骤">{([['brief','创作主题'],['script','脚本与批准'],['refs','参考图库'],['shots','分镜制作'],['archive','验收与成片']] as const).map(([id,label],i)=><button key={id} aria-current={mode === 'director' && deskView === id ? 'page' : undefined} onClick={()=>{setDeskView(id);void changeMode('director');}}><span>{String(i+1).padStart(2,'0')}</span>{label}<ChevronRight size={12}/></button>)}</nav>}
            <a className="pre-playbook-link" href="/pre">组件规范 ↗</a>
          </div></EdgePanel>
        )}
        {loading ? (
          <div className="studio-loading">
            <LoaderCircle size={22} className="animate-spin" />
            <p>正在打开创作工作台…</p>
          </div>
        ) : loadError ? (
          <div className="studio-loading" role="alert">
            <p>{loadError}</p>
            <button className="studio-button" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : (
          project && (
            <div className="studio-main">
              {mode === "canvas" && (
                <div className="studio-canvas-host" inert={busy}>
                  {renderCanvas(project.canvasId, canvasVersion, (fn) => {
                    prepareRef.current = fn;
                  }, async canvasId => {
                    const p = projectRef.current;
                    if (!p) return;
                    const updated = await request<StudioProject>(`/api/studio/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ revision: p.revision, canvasId }) });
                    projectRef.current = updated; setProject(updated);
                  })}
                </div>
              )}
              {mode === "director" && (
                <DirectorDesk
                  key={project.id}
                  project={project}
                  busy={busy}
                  pending={pending}
                  onPatch={async (fields) => {
                    await patch(fields);
                  }}
                  onAction={safeAction}
                  onBatch={runBatch}
                  onUpload={() => fileRef.current?.click()}
                  view={deskView}
                  onViewChange={setDeskView}
                />
              )}
              <FloatingAgent open={floating} onOpenChange={setFloating} busy={agentBusy}>
                <AgentPanel
                  key={`${project.id}:${project.activeConversationId}`}
                  project={project} onRefresh={refresh} onBusy={onAgentBusy} beforeSend={beforeSend}
                  onUpload={files => files?.length ? void upload(files) : fileRef.current?.click()}
                  onConversation={async (id,settings) => {
                    const current = projectRef.current;
                    if (!current) return;
                    const updated = await request<StudioProject>(`/api/studio/projects/${current.id}/conversations`, { method: id ? "PATCH" : "POST", body: JSON.stringify(id ? {conversationId:id,settings} : {}) });
                    projectRef.current=updated; setProject(updated);
                  }}
                  disabled={!!pending || batch || remoteBusy}
                />
              </FloatingAgent>
              {batch && (
                <div className="studio-batch-status" role="status">
                  <LoaderCircle size={15} className="animate-spin" />
                  <span>正在顺序制作 · {pending.split(":").join(" ")}</span>
                  <button
                    onClick={() => {
                      stopBatch.current = true;
                      toast("将在当前任务完成后停止，已提交视频会继续保留");
                    }}
                  >
                    <Square size={11} />
                    停止后续制作
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
