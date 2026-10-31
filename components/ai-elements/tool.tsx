"use client";
// Adapted from Vercel AI Elements Tool (Apache-2.0), using Base UI.
// 工具调用默认收成一行：图标 + 动作 + 一句摘要（节点名而不是 ID）+ 状态；失败原因直接显示在行下。
// 展开后才看参数与结果，长正文截断，不把整段脚本或 JSON 摊在对话里。
import { Collapsible } from "@base-ui/react/collapsible";
import type { ToolUIPart } from "ai";
import {
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  Eye,
  ImagePlus,
  LayoutGrid,
  LoaderCircle,
  Paperclip,
  PencilLine,
  RefreshCw,
  SquarePlus,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useState } from "react";
import { ParameterView } from "@/components/agent/parameter-view";
import { compactValue, summarizeTool } from "./tool-summary";
export { collectNodeNames } from "./tool-summary";

const tools: Record<string, { label: string; icon: LucideIcon }> = {
  read_canvas: { label: "读取画布", icon: Eye },
  add_canvas_nodes: { label: "添加节点", icon: SquarePlus },
  edit_canvas_nodes: { label: "编辑节点与连线", icon: PencilLine },
  arrange_canvas_nodes: { label: "整理布局", icon: LayoutGrid },
  generate_image: { label: "生成图片", icon: ImagePlus },
  generate_video: { label: "生成视频", icon: Clapperboard },
  check_video_task: { label: "查询视频任务", icon: RefreshCw },
  attach_canvas_assets: { label: "绑定参考素材", icon: Paperclip },
};

/** 对话内已知的节点名（来自 read_canvas / add_canvas_nodes 的结果），用于把 ID 显示成名字。 */
export const ToolNodeNames = createContext<ReadonlyMap<string, string>>(new Map());

export function Tool({ part }: { part: ToolUIPart }) {
  const names = useContext(ToolNodeNames);
  const name = part.type.slice(5);
  const meta = tools[name] ?? { label: name, icon: Wrench };
  const Icon = meta.icon;
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && part.preliminary === true);
  const failed = part.state === "output-error" || part.state === "output-denied";
  const [open, setOpen] = useState(false);
  const output = part.state === "output-available" ? part.output : undefined;
  const summary = part.state === "input-streaming" ? "" : summarizeTool(name, part.input, output, names);
  const asset = output && typeof output === "object" && "name" in output ? String(output.name) : undefined;
  const status = running ? "进行中" : failed ? "未完成" : "已完成";
  return (
    <Collapsible.Root className="agent-tool" open={open} onOpenChange={setOpen} data-tool-state={part.state}>
      <Collapsible.Trigger className="agent-tool-header" title={summary ? `${meta.label}：${summary}` : meta.label}>
        <Icon size={13} className="agent-tool-icon" />
        <span className="agent-tool-label">{meta.label}</span>
        {summary && <span className="agent-tool-summary">{summary}</span>}
        <span className={failed ? "agent-badge-error" : "agent-tool-status"} aria-label={status}>
          {running ? <LoaderCircle size={12} className="animate-spin" /> : failed ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
        </span>
        <ChevronDown size={12} className={open ? "agent-tool-chevron rotate-180" : "agent-tool-chevron"} />
      </Collapsible.Trigger>
      {part.state === "output-error" && !open && <div className="agent-tool-error" role="alert">{part.errorText}</div>}
      <Collapsible.Panel className="agent-tool-content">
        <div className="agent-eyebrow">参数</div>
        <ParameterView value={compactValue(part.input ?? {})} />
        {part.state === "output-error" && (
          <div role="alert" className="agent-tool-error-detail">
            <ParameterView value={part.errorText} />
          </div>
        )}
        {output !== undefined && (
          <>
            <div className="agent-eyebrow">结果</div>
            {asset && /\.(png|jpe?g|webp)$/i.test(asset) ? (
              <img src={`/api/assets/${encodeURIComponent(asset)}`} alt="生成图片" />
            ) : (
              <ParameterView value={compactValue(output)} />
            )}
          </>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
