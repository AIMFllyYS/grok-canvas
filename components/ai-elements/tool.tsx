"use client";
// Adapted from Vercel AI Elements Tool (Apache-2.0), using Base UI.
import { Collapsible } from "@base-ui/react/collapsible";
import type { ToolUIPart } from "ai";
import {
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ParameterView } from "@/components/agent/parameter-view";
const names: Record<string, string> = {
  read_canvas: "读取画布",
  add_canvas_nodes: "添加画布节点",
  edit_canvas_nodes: "编辑节点与连线",
  generate_image: "生成图片",
  generate_video: "生成视频",
  check_video_task: "查询视频任务",
  attach_canvas_assets: "绑定参考素材",
};
export function Tool({ part }: { part: ToolUIPart }) {
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && part.preliminary === true);
  const failed =
    part.state === "output-error" || part.state === "output-denied";
  const [open, setOpen] = useState(running || failed);
  useEffect(() => setOpen(running || failed), [running, failed]);
  const output = part.state === "output-available" ? part.output : undefined;
  const asset =
    output && typeof output === "object" && "name" in output
      ? String(output.name)
      : undefined;
  return (
    <Collapsible.Root
      className="agent-tool"
      open={open}
      onOpenChange={setOpen}
      data-tool-state={part.state}
    >
      <Collapsible.Trigger className="agent-tool-header">
        <Wrench size={13} />
        <span>{names[part.type.slice(5)] ?? part.type.slice(5)}</span>
        <span className={failed ? "agent-badge-error" : "agent-tool-status"}>
          {running ? (
            <LoaderCircle size={12} className="animate-spin" />
          ) : failed ? (
            <XCircle size={12} />
          ) : (
            <CheckCircle2 size={12} />
          )}{" "}
          {running ? "进行中" : failed ? "未完成" : "已完成"}
        </span>
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="agent-tool-content">
        <div className="agent-eyebrow">参数</div>
        <ParameterView value={part.input ?? {}} />
        {part.state === "output-error" && (
          <div role="alert">
            <ParameterView value={part.errorText} />
          </div>
        )}
        {output !== undefined && (
          <>
            <div className="agent-eyebrow">结果</div>
            {asset && /\.(png|jpe?g|webp)$/i.test(asset) ? (
              <img
                src={`/api/assets/${encodeURIComponent(asset)}`}
                alt="生成图片"
              />
            ) : (
              <ParameterView value={output} />
            )}
          </>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
