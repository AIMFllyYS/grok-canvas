import { loadCanvas, saveCanvas } from "../canvas-store";
import {
  shotPrompt,
  firstFrameVideoPrompt,
  timeline,
  type StudioProject,
} from "./schema";
import { StudioError } from "./store";

/** Managed production nodes share the existing canvas; user nodes/positions survive. */
export async function syncProjectCanvas(project: StudioProject) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = await loadCanvas(project.canvasId);
    if (!canvas)
      throw new StudioError("关联画布已删除，请恢复画布后继续制作", 409);
    type N = {
      id: string;
      type: string;
      position: { x: number; y: number };
      data: Record<string, unknown>;
    };
    const existing = canvas.nodes as N[];
    const nodes: N[] = [],
      edges: Array<Record<string, unknown>> = [];
    const prefix = `studio-${project.id}-`;
    const add = (
      id: string,
      type: string,
      x: number,
      y: number,
      data: Record<string, unknown>,
    ) => {
      const old = existing.find((n) => n.id === prefix + id);
      nodes.push({
        id: prefix + id,
        type,
        position: old?.position ?? { x, y },
        data: { ...data, studioProjectId: project.id },
      });
    };
    const edge = (source: string, target: string, role?: string) =>
      edges.push({
        id: `${prefix}${source}-${target}`,
        source: prefix + source,
        target: prefix + target,
        type: "scissor",
        data: {
          ...(role ? { role } : {}),
          ...(["source", "script"].includes(source) ||
          ["source", "assembly", "script"].includes(target)
            ? { studioControl: true }
            : {}),
        },
      });
    add("source", "workflow", 0, 80, {
      name: "素材 / 项目简报",
      stage: "source",
      text: project.brief || "上传素材或描述你的创意",
      count: project.sources.length,
    });
    add("script", "workflow", 360, 80, {
      name: "导演脚本",
      stage: "script",
      text: project.logline || "等待生成完整导演脚本",
      count: project.shots.length,
    });
    edge("source", "script");
    project.sources.forEach((source, i) => {
      if (source.kind === "image" && source.assetName)
        add(`source-${source.id}`, "asset", -340, i * 260, {
          name: source.name,
          assetName: source.assetName,
        });
      else
        add(`source-${source.id}`, "workflow", -340, i * 260, {
          name: source.name,
          stage: "source",
          text: source.text.slice(0, 800) || "待分析素材",
          count: 1,
          assetName: source.assetName,
        });
      edge(`source-${source.id}`, "source");
    });
    project.references.forEach((ref, i) => {
      add(`ref-${ref.id}`, "image", 760, i * 340, {
        name: `@${ref.id} · ${ref.name}`,
        assetName: ref.assetName ?? null,
        prompt: `${project.style.en} ${ref.prompt.en}`,
        aspectRatio: project.aspect,
        resolution: "1k",
        quality: "low",
        generationCount: 1,
        status: "idle",
        uploadAttachments: [],
      });
      edge("script", `ref-${ref.id}`);
    });
    timeline(project.shots).forEach((shot, i) => {
      add(`shot-${shot.id}`, "image", 1180, i * 400, {
        name: `${shot.id} · ${shot.timelineStart}–${shot.timelineEnd}s · ${shot.title}`,
        assetName: shot.imageAsset ?? null,
        prompt: shotPrompt(project, shot),
        aspectRatio: project.aspect,
        resolution: "1k",
        quality: "low",
        generationCount: 1,
        status: "idle",
        uploadAttachments: shot.refs
          .map((id) => project.references.find((r) => r.id === id)?.assetName)
          .filter(Boolean),
      });
      add(`video-${shot.id}`, "video", 1600, i * 400, {
        name: `${shot.id} · 视频`,
        assetName: shot.videoAsset ?? null,
        prompt: firstFrameVideoPrompt(project, shot),
        duration: shot.duration,
        aspectRatio: shot.imageAsset ? null : project.aspect,
        resolution: "720p",
        audio: false,
        status: "idle",
        uploadInputs: shot.imageAsset
          ? [{ role: "first", assetName: shot.imageAsset }]
          : [],
        taskId: shot.taskId,
      });
      if (shot.refs.length)
        shot.refs.forEach((id) => edge(`ref-${id}`, `shot-${shot.id}`));
      else edge("script", `shot-${shot.id}`);
      edge(`shot-${shot.id}`, `video-${shot.id}`, "first");
      edge(`video-${shot.id}`, "assembly");
    });
    add("assembly", "workflow", 2020, 80, {
      name: "成片 / 验收",
      stage: "assembly",
      text: project.exportAsset
        ? "成片已合成，可下载"
        : "逐镜验收后合成完整视频",
      count: project.shots.filter((s) => s.videoApproved).length,
      assetName: project.exportAsset,
    });
    const managed = new Set(
      existing
        .filter((n) => n.data?.studioProjectId === project.id)
        .map((n) => n.id),
    );
    const next = await saveCanvas(
      {
        ...canvas,
        name: project.title,
        nodes: [...existing.filter((n) => !managed.has(n.id)), ...nodes],
        edges: [
          ...(canvas.edges as Array<{ source: string; target: string }>).filter(
            (e) => !managed.has(e.source) && !managed.has(e.target),
          ),
          ...edges,
        ],
      },
      canvas.revision,
    );
    if (next) return next;
  }
  throw new StudioError("画布正在被其他页面编辑，请保存后重试", 409);
}
