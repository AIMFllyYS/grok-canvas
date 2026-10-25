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
};
export function Tool({ part }: { part: ToolUIPart }) {
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && part.preliminary === true);
  const failed =
    part.state === "output-error" || part.state === "output-denied";
  const [open, setOpen] = useState(running);
  useEffect(() => {
    setOpen(running);
  }, [running]);
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
          {running ? "进行中" : failed ? "失败" : "已完成"}
        </span>
        <ChevronDown size={14} className={open ? "rotate-180" : ""} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="studio-tool-content">
        <div className="studio-eyebrow">工具参数</div>
        <pre>{JSON.stringify(part.input ?? {}, null, 2)}</pre>
        {part.state === "output-error" && <p role="alert">{part.errorText}</p>}
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
              <p className="studio-analysis-result">{result.analysis}</p>
            ) : result?.assetName &&
              /\.(png|jpe?g|webp)$/i.test(result.assetName) ? (
              <img src={`/api/assets/${result.assetName}`} alt="工具生成结果" />
            ) : (
              <pre>{JSON.stringify(output, null, 2).slice(0, 18000)}</pre>
            )}
          </>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
