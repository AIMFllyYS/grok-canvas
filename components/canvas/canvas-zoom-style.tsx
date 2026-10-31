"use client";

import { memo, useLayoutEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { bindCanvasZoom } from "@/lib/canvas-runtime/node-view";

export const CanvasZoomStyle = memo(function CanvasZoomStyle() {
  const anchor = useRef<HTMLSpanElement>(null);
  const store = useStoreApi();
  useLayoutEffect(() => {
    // 从自己的已挂载 DOM 找祖先，避免子 effect 执行时父 ref 尚未赋值。
    const root = anchor.current?.closest<HTMLElement>(".react-flow");
    if (!root) return;
    return bindCanvasZoom(store, root.style);
  }, [store]);
  return <span hidden aria-hidden ref={anchor} />;
});
