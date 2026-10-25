import { referencePattern } from "./prompt-references";

/**
 * 视频节点的 @ 引用与接口编号映射（模型 grok-imagine-video-1.5）。
 *
 * 编号规则为 2026-09-14 实测结论，不是官方永久契约：
 * - 不传首帧：reference_images[i] 对应 <IMAGE_i>，从 0 开始；
 * - 传首帧：首帧占 <IMAGE_0>，参考图从 1 开始；
 * - 仅加尾帧不改变参考图起点。
 *
 * @ 绑定素材身份（assetName），接口编号只在提交时按当前角色与顺序生成。
 * 越界编号上游不报错、照样出片，因此引用校验必须在本地完成，不能依赖接口。
 */

export const VIDEO_REFERENCE_MAX = 7;

export type VideoInputRole = "first" | "last" | "reference";

export type VideoInput = {
  /** 稳定身份：本地素材名。@ 与快照都引用它，永不持久化接口编号。 */
  assetName: string;
  role: VideoInputRole;
};

/** 参考区素材名 -> 接口标记。inputs 的数组顺序即 reference_images 提交顺序。 */
export function referenceTokenMap(inputs: VideoInput[]): Map<string, string> {
  const first = inputs.filter((input) => input.role === "first");
  const last = inputs.filter((input) => input.role === "last");
  if (first.length > 1) throw new Error("首帧最多一张");
  if (last.length > 1) throw new Error("尾帧最多一张");
  const references = inputs.filter((input) => input.role === "reference");
  if (references.length > VIDEO_REFERENCE_MAX) throw new Error(`参考图最多 ${VIDEO_REFERENCE_MAX} 张`);
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.assetName)) throw new Error("同一图片不能兼任首尾帧与参考图");
    seen.add(input.assetName);
  }
  const offset = first.length === 1 ? 1 : 0;
  return new Map(references.map((input, index) => [input.assetName, `<IMAGE_${index + offset}>`]));
}

/**
 * 把提示词中的 @ 标记替换为 <IMAGE_n>。
 * 引用已不在参考区（被移除或改为首尾帧）时抛错，绝不静默改指其他图片。
 */
export function compileVideoPrompt(prompt: string, inputs: VideoInput[]): string {
  const tokens = referenceTokenMap(inputs);
  return prompt.replace(referencePattern(), (_, assetName: string) => {
    const token = tokens.get(assetName);
    if (token === undefined) {
      throw new Error(`提示词引用的图片 ${assetName} 已不在参考区，请更新引用后再生成`);
    }
    return token;
  });
}

/** 提示词中已失效的 @ 引用（素材名列表），供面板标记「需更新」。 */
export function staleVideoReferences(prompt: string, inputs: VideoInput[]): string[] {
  const tokens = referenceTokenMap(inputs);
  const stale = new Set<string>();
  for (const match of prompt.matchAll(referencePattern())) {
    const assetName = match[1];
    if (assetName && !tokens.has(assetName)) {
      stale.add(assetName);
    }
  }
  return [...stale];
}

export const VIDEO_ROLE_LABELS: Record<VideoInputRole, string> = {
  first: "首帧",
  last: "尾帧",
  reference: "参考",
};

export type VideoSlot = {
  key: string;
  role: VideoInputRole;
  assetName: string | null;
  name: string;
  edgeId?: string;
};

export function parseVideoEdgeRole(value: unknown): VideoInputRole {
  return value === "first" || value === "last" || value === "reference" ? value : "reference";
}

/** 新连入/上传的默认角色：首帧空则首帧，其后进参考区；尾帧必须主动设置，不自动分配。 */
export function defaultNewVideoRole(inputs: Array<{ role: VideoInputRole }>): VideoInputRole | null {
  if (!inputs.some((input) => input.role === "first")) return "first";
  const references = inputs.filter((input) => input.role === "reference").length;
  if (references < VIDEO_REFERENCE_MAX) return "reference";
  return null;
}

export function videoInputsFromSlots(slots: VideoSlot[]): VideoInput[] {
  const inputs: VideoInput[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (!slot.assetName) continue;
    if (seen.has(slot.assetName)) {
      if (inputs.find(input => input.assetName === slot.assetName)?.role !== slot.role) throw new Error("同一图片不能兼任首尾帧与参考图");
      continue;
    }
    seen.add(slot.assetName);
    inputs.push({ assetName: slot.assetName, role: slot.role });
  }
  return inputs;
}

/** 首帧/尾帧互斥：被挤占的槽接手当前角色。参考图满员时不能再改成参考。 */
export function setVideoSlotRole(slots: VideoSlot[], key: string, role: VideoInputRole): VideoSlot[] {
  const index = slots.findIndex((slot) => slot.key === key);
  const current = index >= 0 ? slots[index] : undefined;
  if (!current || current.role === role) return slots;
  if (role === "reference") {
    const references = slots.filter((slot) => slot.role === "reference").length;
    if (references >= VIDEO_REFERENCE_MAX) return slots;
  }
  const holder = role === "reference" ? -1 : slots.findIndex((slot) => slot.role === role);
  return slots.map((slot, itemIndex) => {
    if (itemIndex === index) return { ...slot, role };
    if (itemIndex === holder) return { ...slot, role: current.role };
    return slot;
  });
}

/**
 * 拖动槽位：跨角色对调角色（首/尾帧与参考互换）；同角色按 place 插入排序（参考图调序）。
 * @ 绑定素材名，重排只改变提交顺序与 <IMAGE_n> 编号，引用不会指错。
 */
export function moveVideoSlot(slots: VideoSlot[], fromKey: string, toKey: string, place: "before" | "after" = "before"): VideoSlot[] {
  const from = slots.findIndex((slot) => slot.key === fromKey);
  const to = slots.findIndex((slot) => slot.key === toKey);
  if (from < 0 || to < 0 || from === to) return slots;
  const a = slots[from]!;
  const b = slots[to]!;
  if (a.role !== b.role) {
    return slots.map((slot) => {
      if (slot.key === fromKey) return { ...slot, role: b.role };
      if (slot.key === toKey) return { ...slot, role: a.role };
      return slot;
    });
  }
  const next = slots.filter((_, index) => index !== from);
  const target = next.findIndex((slot) => slot.key === toKey);
  next.splice(place === "after" ? target + 1 : target, 0, a);
  return next;
}
