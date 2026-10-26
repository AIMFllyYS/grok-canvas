import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { loadProject, updateProject } from "./store";
import { analyzeAsset, produce, searchProject } from "./production";
import { studioModel, studioProviderOptions } from "./model";
import { AGENT_RULES } from "./prompts";
import { runProductionBatch } from "./batch";
import type { AgentSettings } from "./schema";
import { isScriptApproved } from "./schema";
import { compactDirectorContext } from "./context";
import { loadCanvas, saveCanvas } from "../canvas-store";
import { StudioError } from "./store";
import { editCanvasDocument } from "./canvas-edit";
import { resolveCanvasReferences } from "../canvas-references";

export async function searchImages(query: string) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "6",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "600",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "GrokCanvas/0.1 local AIGC research" },
  });
  if (!response.ok) throw new Error(`图片检索失败（${response.status}）`);
  const data = await response.json();
  type Page = {
    pageid: number;
    title: string;
    imageinfo?: Array<{
      url: string;
      thumburl?: string;
      descriptionurl: string;
      extmetadata?: Record<string, { value: string }>;
    }>;
  };
  return Object.values((data.query?.pages ?? {}) as Record<string, Page>).map(
    (page) => {
      const info = page.imageinfo?.[0];
      return {
        title: page.title,
        thumbnail: info?.thumburl,
        url: info?.url,
        source: info?.descriptionurl,
        license: info?.extmetadata?.LicenseShortName?.value ?? "请查看来源授权",
        attribution: info?.extmetadata?.Artist?.value
          ?.replace(/<[^>]+>/g, "")
          .slice(0, 300),
      };
    },
  );
}

export async function createDirectorAgent(
  projectId: string,
  signal?: AbortSignal,
  settings: AgentSettings = {},
) {
  const model = await studioModel(settings);
  return new ToolLoopAgent({
    id: "grok-canvas-director",
    model,
    instructions: AGENT_RULES + `\n当前项目ID：${projectId}`,
    stopWhen: isStepCount(18),
    maxOutputTokens: 10000,
    maxRetries: 0,
    toolCallConcurrency: 1,
    prepareStep: async ({ messages }) => ({ messages: await compactDirectorContext(messages, model, settings.contextWindow, signal) }),
    providerOptions: studioProviderOptions(settings),
    toolApproval: { approve_director_script: { type: "user-approval", reason: "请审阅完整脚本与分镜计划，批准后才会开始生成参考图。" } },
    tools: createDirectorTools(projectId, signal),
  });
}

/** Tool schemas are available before authentication, so failed model requests still save validated history. */
export function createDirectorTools(projectId: string, signal?: AbortSignal) {
  return {
      approve_director_script: tool({
        description: "提交脚本供人类确认批准。先 read_project 获取 scriptVersion，等待界面批准后才继续生成；每次修改必须重新批准。",
        inputSchema: z.object({ scriptVersion: z.number().int().nonnegative() }),
        execute: async ({ scriptVersion }) => {
          await updateProject(projectId, p => {
            if (!p.script || (p.scriptVersion ?? 0) !== scriptVersion) throw new StudioError("脚本已修改，请重新审阅最新版本", 409);
            p.scriptApproval = { version: scriptVersion, approvedAt: new Date().toISOString() };
          });
          return { approved: true, scriptVersion };
        },
      }),
      read_canvas: tool({
        description: "读取当前项目的画布节点和连线；节点使用共享组件渲染。",
        inputSchema: z.object({}),
        execute: async () => { const p = await loadProject(projectId); return loadCanvas(p.canvasId); },
      }),
      edit_canvas_nodes: tool({
        description: "编辑当前画布的自建节点名称、文本、提示词和位置，连接/断开参数或图片参考，或删除用户明确要求删除的节点。导演台管理节点需用对应制作工具修改。先 read_canvas 获取 ID。",
        inputSchema: z.object({
          updates: z.array(z.object({ id:z.string(),name:z.string().max(160).optional(),text:z.string().max(12000).optional(),prompt:z.string().max(12000).optional(),x:z.number().min(-50000).max(50000).optional(),y:z.number().min(-50000).max(50000).optional() })).max(30).default([]),
          remove:z.array(z.string()).max(30).default([]),connect:z.array(z.object({source:z.string(),target:z.string(),role:z.enum(["first","last","reference"]).optional()})).max(40).default([]),disconnect:z.array(z.string()).max(40).default([]),
        }),
        execute: async edit => {
          const p=await loadProject(projectId),canvas=await loadCanvas(p.canvasId);
          if(!canvas)throw new StudioError("画布不存在",404);
          const next=editCanvasDocument(canvas,edit),saved=await saveCanvas(next,canvas.revision);
          if(!saved)throw new StudioError("画布已更新，请重新读取后操作",409);
          return {updated:edit.updates.length,removed:edit.remove.length,connected:edit.connect.length,disconnected:edit.disconnect.length};
        },
      }),
      add_canvas_nodes: tool({
        description: "向当前画布添加文本、提示词参数、图片或视频节点并连接。使用共享节点组件；返回真实节点 ID，可由用户继续编辑和生成。",
        inputSchema: z.object({ nodes: z.array(z.object({ key: z.string().min(1).max(60), type: z.enum(["text", "prompt", "image", "video"]), name: z.string().min(1).max(160), text: z.string().max(12000).default(""), x: z.number().min(-50000).max(50000), y: z.number().min(-50000).max(50000) })).min(1).max(20), edges: z.array(z.object({ source: z.string(), target: z.string() })).max(40).default([]) }),
        execute: async ({ nodes, edges }) => {
          const p = await loadProject(projectId), canvas = await loadCanvas(p.canvasId);
          if (!canvas) throw new StudioError("画布不存在", 404);
          const ids = new Map(nodes.map(n => [n.key, crypto.randomUUID()]));
          if (ids.size !== nodes.length) throw new StudioError("节点 key 不可重复");
          const added = nodes.map(n => ({ id: ids.get(n.key)!, type: n.type, position: { x: n.x, y: n.y }, data: { name: n.name, text: n.text, prompt: n.text, status: "idle", assetName: null, aspectRatio: "16:9", resolution: n.type === "video" ? "720p" : "1k", quality: "low", generationCount: 1, duration: 6, audio: false, uploadAttachments: [], uploadInputs: [] } }));
          const links = edges.map(e => {
            const source = added.find(n => n.id === ids.get(e.source)), target = added.find(n => n.id === ids.get(e.target));
            if (!source || !target || source.id === target.id) throw new StudioError("连线端点无效");
            if (!["image", "video"].includes(target.type)) throw new StudioError("参数连线目标必须是图片或视频节点");
            if (!["text", "prompt", "image"].includes(source.type)) throw new StudioError("来源节点不能输出此参数");
            return { id: crypto.randomUUID(), source: source.id, target: target.id, type: "scissor", data: ["text", "prompt"].includes(source.type) ? { promptInput: true } : target.type === "video" ? { role: "first" } : {} };
          });
          for (const node of added.filter(n => n.type === "image" || n.type === "video")) resolveCanvasReferences(node, added, links);
          const saved = await saveCanvas({ ...canvas, nodes: [...canvas.nodes, ...added], edges: [...canvas.edges, ...links] }, canvas.revision);
          if (!saved) throw new StudioError("画布已被其他页面更新，请重新读取后操作", 409);
          return { nodes: added.map(n => ({ id: n.id, type: n.type, name: n.data.name })), edges: links.length };
        },
      }),
      read_project: tool({
        description:
          "读取当前导演台、脚本、参考库、分镜、已上传素材与制作状态。",
        inputSchema: z.object({}),
        execute: async () => {
          const {
            messages: _messages,
            events: _events,
            ...project
          } = await loadProject(projectId);
          return {
            ...project,
            conversations: undefined,
            scriptApproved: isScriptApproved(project),
            scriptVersion: project.scriptVersion ?? 0,
            script: project.script.slice(0, 24000),
            sources: project.sources.map((s) => ({
              ...s,
              text: s.text.slice(0, 1600),
            })),
          };
        },
      }),
      save_creative_brief: tool({
        description:
          "根据用户的明确要求保存或修改当前项目的创作简报和目标时长。不会重写已有脚本或覆盖产物。",
        inputSchema: z.object({
          brief: z.string().min(1).max(60000),
          targetDuration: z.number().int().min(6).max(600).optional(),
        }),
        execute: async ({ brief, targetDuration }) => {
          await updateProject(projectId, (p) => {
            p.brief = brief;
            if (targetDuration) p.targetDuration = targetDuration;
          });
          return {
            saved: true,
            message: "创作简报已保存；现有脚本与产物保持不变",
          };
        },
      }),
      search_materials: tool({
        description: "在当前项目素材、脚本和参考库中检索，返回来源ID与摘录。",
        inputSchema: z.object({ query: z.string().min(1).max(300) }),
        execute: async ({ query }) =>
          searchProject(await loadProject(projectId), query),
      }),
      search_images: tool({
        description:
          "搜索 Wikimedia Commons 图片作为视觉研究，返回缩略图、来源和授权信息。不会自动将外部内容视为已授权素材。",
        inputSchema: z.object({ query: z.string().min(1).max(200) }),
        execute: ({ query }) => searchImages(query),
      }),
      analyze_asset: tool({
        description:
          "使用视觉模型分析当前项目图片或视频关键帧，整理可见内容。assetName 可传服务器素材名、来源ID或上传文件名；视频仅分析0/2/4秒采样，不能推断音频。",
        inputSchema: z.object({
          assetName: z.string(),
          question: z.string().max(2000),
        }),
        execute: async ({ assetName, question }) =>
          analyzeAsset(
            await loadProject(projectId),
            assetName,
            question,
            signal,
          ),
      }),
      write_director_script: tool({
        description:
          "根据已保存的简报和素材生成完整导演脚本、固定参考库与精细时间节拍分镜。已有脚本默认保留。",
        inputSchema: z.object({ rewrite: z.boolean().default(false) }),
        execute: ({ rewrite }) =>
          produce(projectId, "script", { force: rewrite }, signal),
      }),
      generate_reference: tool({
        description:
          "真实生成指定ID的角色/场景/道具参考图并创建画布图片节点。已有结果保留。",
        inputSchema: z.object({ referenceId: z.string() }),
        execute: ({ referenceId }) =>
          produce(projectId, "reference", { targetId: referenceId }, signal),
      }),
      generate_storyboard: tool({
        description:
          "以已生成的参考图制作分镜首帧。必须先完成该镜头的全部参考图。",
        inputSchema: z.object({ shotId: z.string() }),
        execute: ({ shotId }) =>
          produce(projectId, "storyboard", { targetId: shotId }, signal),
      }),
      generate_video: tool({
        description:
          "用分镜首帧与逐秒动作提示词提交真实视频任务，返回任务ID；不会自动重复已有任务。",
        inputSchema: z.object({ shotId: z.string() }),
        execute: ({ shotId }) =>
          produce(projectId, "video", { targetId: shotId }, signal),
      }),
      produce_project: tool({
        description:
          "全自主按顺序补齐导演脚本、参考图、分镜图与视频，流式报告每一步。长项目优先使用此工具，避免每张图占一个模型步骤。仅补缺失产物，不重复生成已完成项；失败记录后继续其他可执行项。",
        inputSchema: z.object({
          stage: z.enum(["reference", "storyboard", "video", "all"]),
        }),
        execute: async function* ({ stage }) {
          yield* runProductionBatch(projectId, stage, signal);
        },
      }),
      check_video_tasks: tool({
        description:
          "查询当前项目已提交视频任务，下载完成的视频；未完成时等待用户下次继续，勿密集调用。",
        inputSchema: z.object({}),
        execute: () => produce(projectId, "poll", {}, signal),
      }),
      review_shot: tool({
        description:
          "仅在用户明确表示验收通过或驳回时，记录分镜图/视频的人工验收与修改意见。",
        inputSchema: z.object({
          shotId: z.string(),
          kind: z.enum(["image", "video"]),
          approved: z.boolean(),
          feedback: z.string().max(3000),
        }),
        execute: ({ shotId, ...input }) =>
          produce(projectId, "review", { targetId: shotId, ...input }, signal),
      }),
      export_film: tool({
        description: "所有视频经人工验收后，调用FFmpeg合成可下载的完整MP4。",
        inputSchema: z.object({}),
        execute: () => produce(projectId, "export", {}, signal),
      }),
  };
}
