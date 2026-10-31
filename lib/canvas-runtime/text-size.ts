/** 文本节点尺寸规则（无依赖，服务端、预显示与测试共用）。 */
/** 用户缩放由 NodeResizer 限定；Agent 写入时夹到 560×800（lib/agent/canvas.ts），高度还不超过正文所需。 */
export const TEXT_GEOMETRY = { minWidth: 200, minHeight: 120, maxWidth: 3000, maxHeight: 3000, agentMaxWidth: 560, agentMaxHeight: 800 } as const;

/**
 * 按正文估算文本节点需要的高度（与 text-node 的排版一致：p-4 内边距，12px 字号 / 1.75 行高，
 * 段落间距 0.75em，标题 13px / 1.5 且上方 1.4em）。只是估算：Agent 据此不把节点拉得比内容高，长文在节点内滚动。
 */
export function fitTextNodeHeight(content: string, width: number): number {
  const PADDING = 32, LINE = 21, GAP = 9, HEADING_LINE = 20, HEADING_GAP = 18;
  const columns = (text: string, available: number) => {
    let px = 0;
    for (const char of text) px += /[⺀-￿]/.test(char) ? 12 : 6.6;
    return Math.max(1, Math.ceil(px / Math.max(available, 60)));
  };
  const inner = width - PADDING;
  let height = PADDING + 8, previous: "none" | "blank" | "text" = "none";
  for (const raw of content.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) { if (previous === "text") previous = "blank"; continue; }
    const heading = /^#{1,6}\s/.test(line);
    const list = /^([-*+]|\d+[.)])\s/.test(line);
    if (previous !== "none") height += heading ? HEADING_GAP : previous === "blank" ? GAP : 0;
    height += heading ? columns(line.replace(/^#+\s*/, ""), inner) * HEADING_LINE : columns(line, list ? inner - 17 : inner) * LINE;
    previous = heading ? "blank" : "text";
  }
  return Math.max(TEXT_GEOMETRY.minHeight, Math.ceil(height));
}

/** Agent 文本高度：不超过上限，也不超过正文所需（模型常把上限当目标值）；空正文用默认高度。 */
export function agentTextHeight(requested: number | undefined, content: string, width: number): number {
  const needed = content.trim() ? fitTextNodeHeight(content, width) : TEXT_DEFAULT_SIZE.height;
  return Math.max(TEXT_GEOMETRY.minHeight, Math.min(requested ?? needed, needed, TEXT_GEOMETRY.agentMaxHeight));
}
export const TEXT_DEFAULT_SIZE = { width: 360, height: 260 } as const;
