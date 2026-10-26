import { z } from "zod";

export const bilingual = z.object({
  zh: z.string().min(1).max(12000),
  en: z.string().min(1).max(12000),
});
export const referenceSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/),
  name: z.string().min(1).max(120),
  group: z.enum(["角色", "场景", "道具"]),
  description: z.string().max(2000),
  prompt: bilingual,
});
export const beatSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  action: bilingual,
});
export const shotSchema = z.object({
  id: z.string().regex(/^P\d{2,3}$/),
  title: z.string().min(1).max(160),
  scene: z.string().max(200),
  duration: z.union([z.literal(6), z.literal(10), z.literal(15)]),
  description: bilingual,
  camera: bilingual,
  refs: z.array(z.string()).max(5),
  beats: z.array(beatSchema).min(2).max(4),
  narration: z.string().max(4000),
  notes: z.string().max(3000),
});
export const planSchema = z.object({
  title: z.string().min(1).max(160),
  logline: z.string().max(1000),
  script: z.string().min(30).max(80000),
  style: bilingual,
  negative: bilingual,
  references: z.array(referenceSchema).min(1).max(30),
  shots: z.array(shotSchema).min(1).max(40),
});
export type Plan = z.infer<typeof planSchema>;
export type Reference = z.infer<typeof referenceSchema> & {
  assetName?: string;
  history?: string[];
  approved?: boolean;
  error?: string;
};
export type Shot = z.infer<typeof shotSchema> & {
  imageAsset?: string;
  imageHistory?: string[];
  imageApproved?: boolean;
  videoAsset?: string;
  videoHistory?: string[];
  videoApproved?: boolean;
  taskId?: string;
  error?: string;
  feedback?: string;
};
export type Source = {
  id: string;
  name: string;
  text: string;
  assetName?: string;
  kind: "text" | "image" | "video";
  analyzed?: boolean;
  frames?: Array<{ assetName: string; at: number }>;
};
export type StudioEvent = {
  id: string;
  at: string;
  action: string;
  status: "running" | "done" | "error";
  detail: string;
};
export type StudioProject = {
  version: 1;
  id: string;
  canvasId: string;
  revision: number;
  title: string;
  brief: string;
  aspect: "16:9" | "9:16" | "1:1";
  targetDuration: number;
  style: z.infer<typeof bilingual>;
  negative: z.infer<typeof bilingual>;
  script: string;
  logline: string;
  references: Reference[];
  shots: Shot[];
  sources: Source[];
  messages: import("ai").UIMessage[];
  conversations?: StudioConversation[];
  activeConversationId?: string;
  scriptVersion?: number;
  scriptApproval?: { version: number; approvedAt: string };
  events: StudioEvent[];
  createdAt: string;
  updatedAt: string;
  exportAsset?: string;
  exportSignature?: string;
};
export type AgentSettings = { model?: string; fast?: boolean; contextWindow?: number; effort?: string };
export type StudioConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: import("ai").UIMessage[];
  settings: AgentSettings;
};
export function isScriptApproved(p: Pick<StudioProject, "script" | "scriptVersion" | "scriptApproval">) {
  return !!p.script && !!p.scriptApproval && p.scriptApproval.version === (p.scriptVersion ?? 0);
}
export type StudioSummary = Pick<
  StudioProject,
  "id" | "title" | "updatedAt" | "canvasId"
> & { shotCount: number; completed: number };
export const DEFAULT_STYLE = {
  zh: "电影感手绘动画，克制的暖色、细腻纸张纹理、柔和自然光；角色造型、服装与场景色彩始终一致。",
  en: "Cinematic hand-drawn animation, restrained warm palette, subtle paper texture, soft natural light. Maintain identical character design, wardrobe and scene colors across every frame.",
};
export const DEFAULT_NEGATIVE = {
  zh: "字幕、画面文字、水印、真实商标、手部畸形、多余肢体、角色变脸、服装漂移、闪烁、突变、口型同步",
  en: "subtitles, on-screen text, watermark, real brand logos, deformed hands, extra limbs, face drift, outfit drift, flicker, abrupt morphing, lip sync",
};

/** Validate temporal coverage and references before any paid generation. */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  const refs = new Set(plan.references.map((r) => r.id));
  if (refs.size !== plan.references.length) errors.push("参考 ID 重复");
  if (new Set(plan.shots.map((s) => s.id)).size !== plan.shots.length)
    errors.push("分镜 ID 重复");
  if (
    /[\u3400-\u9fff]/.test(
      [
        plan.style.en,
        plan.negative.en,
        ...plan.references.map((r) => r.prompt.en),
      ].join(" "),
    )
  )
    errors.push("全片风格、负面词与参考图英文提示词不能含中文");
  for (const shot of plan.shots) {
    let end = 0;
    for (const beat of shot.beats) {
      if (
        Math.abs(beat.start - end) > 0.01 ||
        beat.end <= beat.start ||
        beat.end - beat.start < 1 ||
        beat.end > shot.duration
      )
        errors.push(
          `${shot.id} 动作节拍必须连续，每拍至少 1 秒且不超过片段时长`,
        );
      end = beat.end;
    }
    if (Math.abs(end - shot.duration) > 0.01)
      errors.push(`${shot.id} 动作节拍没有覆盖完整时长`);
    for (const ref of shot.refs)
      if (!refs.has(ref)) errors.push(`${shot.id} 引用了未知参考 ${ref}`);
    const english = [
      shot.description.en,
      shot.camera.en,
      ...shot.beats.map((b) => b.action.en),
    ].join(" ");
    if (/[\u3400-\u9fff]/.test(english))
      errors.push(`${shot.id} 英文生成提示词含中文`);
    if (
      /\b(speak(?:s|ing)?|speech|dialogue?|say(?:s|ing)?|said|voice(?:s|over)?|narrat(?:e|es|ing)|talk(?:s|ing)?|whisper(?:s|ing)?|shout(?:s|ing)?|sing(?:s|ing)?|monologue)\b|lip[- ]?sync/i.test(
        english,
      )
    )
      errors.push(
        `${shot.id} 画面提示词含配音或口型指令，请把配音放到 narration`,
      );
    for (const tag of english.matchAll(/\(@([A-Z][A-Z0-9_-]*)\)/g))
      if (!shot.refs.includes(tag[1]!))
        errors.push(`${shot.id} 的 @${tag[1]} 未绑定参考`);
  }
  return [...new Set(errors)];
}

export function shotPrompt(
  project: Pick<StudioProject, "style" | "negative" | "aspect" | "references">,
  shot: Shot,
  language: "en" | "zh" = "en",
): string {
  const tags = shot.refs
    .map((id) => project.references.find((r) => r.id === id))
    .filter(Boolean)
    .map(
      (r) =>
        `${language === "en" ? r!.prompt.en.split(".")[0] : r!.name} (@${r!.id})`,
    )
    .join("; ");
  return `${project.style[language]} ${project.aspect} ${language === "en" ? "frame" : "画幅"}. ${shot.description[language]} ${tags}. ${shot.camera[language]}\n\n${shot.beats.map((b) => `${b.start}-${b.end}s: ${b.action[language]}`).join("\n")}\n\n${language === "en" ? "Avoid: " : "避免："}${project.negative[language]}`;
}

export function timeline(shots: Shot[]) {
  let start = 0;
  return shots.map((shot) => {
    const item = {
      ...shot,
      timelineStart: start,
      timelineEnd: start + shot.duration,
    };
    start += shot.duration;
    return item;
  });
}

/** @IDs are library aliases, not API reference slots in first-frame-only video. */
export function firstFrameVideoPrompt(project: StudioProject, shot: Shot) {
  return `Use the supplied first frame as the visual source. Preserve subject identity, wardrobe, geometry, scene layout and palette.\n${shotPrompt(project, shot).replace(/\s*\(@[A-Z][A-Z0-9_-]*\)/g, "")}`;
}

export function invalidateShotImage(shot: Shot) {
  shot.imageApproved = false;
  shot.videoApproved = false;
  // All previous assets remain in history and on disk, but are not current outputs.
  if (shot.imageAsset)
    shot.imageHistory = [
      ...new Set([...(shot.imageHistory ?? []), shot.imageAsset]),
    ];
  if (shot.videoAsset)
    shot.videoHistory = [
      ...new Set([...(shot.videoHistory ?? []), shot.videoAsset]),
    ];
  shot.imageAsset = undefined;
  shot.videoAsset = undefined;
}

export function exportSignature(project: StudioProject) {
  return JSON.stringify(
    project.shots.map((s) => [s.id, s.videoAsset, s.duration, s.videoApproved]),
  );
}
