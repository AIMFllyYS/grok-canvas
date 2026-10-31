/**
 * 长 Markdown 分块（P4-06）：在不破坏 Markdown 结构的位置切开，供阅读视图按块渐进挂载、按块缓存解析结果。
 * - 只在代码围栏外的空行处切分；列表（含松散列表）、缩进代码、表格、引用的续行并入同一块；
 * - 每块保留自己的尾随空行，blocks.join("") 与原文逐字节相同；
 * - 短文（≤ 4KB）只有一块，渲染结果与整篇渲染相同。
 * 编辑始终持有完整原文；阅读块只用于显示，卸载不会改动正文。
 */
export const BLOCK_TARGET_CHARS = 4096;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])\s/;
const CONTINUES = /^(\s{2,}|\t| {0,3}(>|\|))/;

export function splitMarkdownBlocks(text: string, target = BLOCK_TARGET_CHARS): string[] {
  if (text.length <= target) return [text];
  const lines = text.split(/(?<=\n)/);
  const blocks: string[] = [];
  let current = "";
  let fence: string | null = null;
  let inList = false;
  let pendingBreak = false;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    const fenceMatch = FENCE.exec(bare);
    if (fence) {
      current += line;
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && bare.trim() === fenceMatch[1]) fence = null;
      continue;
    }
    const blank = bare.trim() === "";
    if (blank) { current += line; pendingBreak = true; continue; }
    // 空行之后的新内容：只有在不属于上一个结构（列表/缩进/表格/引用续行）且当前块够大时才切。
    if (pendingBreak && current.length >= target && !(inList && (LIST.test(bare) || CONTINUES.test(bare))) && !CONTINUES.test(bare)) {
      blocks.push(current);
      current = "";
      inList = false;
    }
    pendingBreak = false;
    if (fenceMatch) fence = fenceMatch[1]!;
    if (LIST.test(bare)) inList = true;
    else if (!CONTINUES.test(bare)) inList = false;
    current += line;
  }
  if (current || !blocks.length) blocks.push(current);
  return blocks;
}

/** 512 字符摘要（轻量视图用）：按字符而不是字节截断，不切开代理对。 */
export function summarize(text: string, limit = 512): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
}

/** 分块结果缓存：key 为文档身份+版本（这里用 nodeId+内容指纹），LRU 上限 100 篇 / 8MiB。 */
export function createBlockCache(limits = { documents: 100, chars: 4 * 1024 * 1024 }) {
  const entries = new Map<string, { blocks: string[]; chars: number }>();
  let chars = 0, parses = 0;
  return {
    get(documentKey: string, text: string): string[] {
      const key = `${documentKey}:${fingerprint(text)}`;
      const hit = entries.get(key);
      if (hit) { entries.delete(key); entries.set(key, hit); return hit.blocks; }
      parses++;
      const blocks = splitMarkdownBlocks(text);
      // 同一文档的旧版本直接失效。
      for (const [other, entry] of entries) if (other.startsWith(`${documentKey}:`)) { entries.delete(other); chars -= entry.chars; }
      entries.set(key, { blocks, chars: text.length });
      chars += text.length;
      for (const [other, entry] of entries) {
        if (entries.size <= limits.documents && chars <= limits.chars) break;
        if (other === key) continue;
        entries.delete(other); chars -= entry.chars;
      }
      return blocks;
    },
    stats: () => ({ documents: entries.size, chars, parses }),
  };
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `${text.length}-${(hash >>> 0).toString(36)}`;
}
