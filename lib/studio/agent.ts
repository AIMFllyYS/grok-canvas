import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { loadProject, updateProject } from "./store";
import { analyzeAsset, produce, searchProject } from "./production";
import { studioModel } from "./model";
import { AGENT_RULES } from "./prompts";
import { runProductionBatch } from "./batch";

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
) {
  return new ToolLoopAgent({
    id: "grok-canvas-director",
    model: await studioModel(),
    instructions: AGENT_RULES + `\n当前项目ID：${projectId}`,
    stopWhen: isStepCount(18),
    maxOutputTokens: 10000,
    maxRetries: 0,
    toolCallConcurrency: 1,
    tools: {
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
    },
  });
}
