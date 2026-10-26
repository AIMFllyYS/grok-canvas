"use client";
// Adapted from Vercel AI Elements Tool (Apache-2.0). Uses the project's Base UI primitive.
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
import { ParameterView } from "@/components/pre/parameter-view";
import { ApprovalCard } from "@/components/pre/primitives";
const names: Record<string, string> = {
  read_project: "读取导演台",
  save_creative_brief: "保存创作简报",
  search_materials: "检索项目素材",
  search_images: "搜索图片参考",
  analyze_asset: "分析视觉素材",
  write_director_script: "编写导演脚本",
  generate_reference: "生成参考图",
  generate_storyboard: "生成分镜图",
  generate_video: "生成视频",
  produce_project: "全自主制作",
  check_video_tasks: "查询视频任务",
  review_shot: "记录镜头验收",
  export_film: "合成完整视频",
  approve_director_script: "确认导演脚本",
  read_canvas: "读取画布",
  add_canvas_nodes: "搭建画布节点",
  edit_canvas_nodes: "编辑画布与连线",
};
export function Tool({ part, onApproval }: { part: ToolUIPart; onApproval?: (decision: { id: string; approved: boolean; reason?: string }) => void }) {
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && part.preliminary === true);
  const failed =
    part.state === "output-error" || part.state === "output-denied";
  const approval = part.state === "approval-requested";
  const [open, setOpen] = useState(running || approval || failed);
  useEffect(() => {
    setOpen(running || approval || failed);
  }, [running, approval, failed]);
  const name = part.type.slice(5),
    output = part.state === "output-available" ? part.output : undefined;
  const result = output as
    { assetName?: string; localUrl?: string; analysis?: string } | undefined;
  const images =
    name === "search_images" && Array.isArray(output)
      ? (output as Array<{
          title: string;
          thumbnail?: string;
          source?: string;
          license?: string;
        }>)
      : null;
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="studio-tool"
      data-tool-state={part.state}
    >
      <Collapsible.Trigger className="studio-tool-header">
        <Wrench size={14} />
        <span>{names[name] ?? name}</span>
        <span className={failed ? "studio-badge-error" : "studio-tool-status"}>
          {running ? (
            <LoaderCircle size={13} className="animate-spin" />
          ) : failed ? (
            <XCircle size={13} />
          ) : (
            <CheckCircle2 size={13} />
          )}{" "}
          {approval ? "等待批准" : part.state === "approval-responded" ? "已提交决定" : running ? "进行中" : failed ? "未完成" : "已完成"}
        </span>
        <ChevronDown size={14} className={open ? "rotate-180" : ""} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="studio-tool-content">
        <div className="studio-eyebrow">工具参数</div>
        <ParameterView value={part.input ?? {}}/>
        {part.state === "output-error" && <div role="alert"><ParameterView value={part.errorText}/></div>}
        {part.state === "output-denied" && <p>本次执行未获批准，未提交生成。</p>}
        {part.state === "approval-requested" && <ApprovalCard approved={false} disabled={!onApproval} onApprove={() => onApproval?.({ id: part.approval.id, approved: true })} onReject={() => onApproval?.({ id: part.approval.id, approved: false, reason: "继续修改脚本，暂不开始制作" })}>请先在导演台审阅当前脚本。批准绑定本次脚本版本，修改后需重新确认。</ApprovalCard>}
        {output !== undefined && (
          <>
            <div className="studio-eyebrow">执行结果</div>
            {images ? (
              <div className="studio-search-results">
                {images.map((item, i) => (
                  <a
                    key={i}
                    href={item.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt={item.title} />
                    )}
                    <strong>{item.title}</strong>
                    <span>{item.license}</span>
                  </a>
                ))}
              </div>
            ) : result?.analysis ? (
              <ParameterView value={result.analysis}/>
            ) : result?.assetName &&
              /\.(png|jpe?g|webp)$/i.test(result.assetName) ? (
              <img src={`/api/assets/${result.assetName}`} alt="工具生成结果" />
            ) : (
              <ParameterView value={output}/>
            )}
          </>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
