"use client";

import { memo, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { createBlockCache } from "@/lib/canvas-runtime/document-blocks";

/**
 * 长文阅读视图（P4-06）：正文按 Markdown 结构分块，每块单独 memo，正文某处改动只重新解析变化的块；
 * 先挂前 8 块，滚动接近底部时每次再挂 8 块。短文只有一块，与整篇渲染一致。
 * 只读：编辑仍在面板里持有完整原文。
 */
const blockCache = createBlockCache();
const INITIAL = 8;
const STEP = 8;

const Block = memo(function Block({ text }: { text: string }) {
  return <MessageResponse mode="static">{text}</MessageResponse>;
});

export function DocumentReader({ documentKey, content }: { documentKey: string; content: string }) {
  const blocks = blockCache.get(documentKey, content);
  const [count, setCount] = useState(INITIAL);
  const sentinel = useRef<HTMLDivElement>(null);
  const more = blocks.length > count;
  useEffect(() => {
    const target = sentinel.current;
    if (!more || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setCount(value => value + STEP);
    }, { rootMargin: "400px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, count]);
  return (
    <>
      {blocks.slice(0, count).map((text, index) => <Block key={index} text={text} />)}
      {more && <div ref={sentinel} className="py-2 text-center text-xs text-muted-foreground">继续加载…</div>}
    </>
  );
}
