import type { CSSProperties, ReactNode } from "react";

/**
 * Shared selection appearance; compensation keeps a 2px screen-space boundary.
 *
 * 节点内容面就是拖动区：React Flow 起手前会丢弃落在 .nodrag 里的按下点，
 * 所以挂在里面的正文/画面不能标 .nodrag（整块标掉，节点就只剩边框能拖），
 * 只有按钮、输入框、进度条这类局部控件层才标，并在需要时配 .nowheel 保住滚动。
 */
export function NodeSurface({ selected, zoom, className = "", style, children }: {
  selected?: boolean;
  zoom?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return <div data-selected={!!selected}
    className={`ui-node-surface overflow-hidden rounded-xl bg-muted transition-shadow ${selected ? "ring-2 ring-primary" : ""} ${className}`}
    style={{ ...style, ...(zoom === undefined ? {} : { "--selection-width": `${2 / Math.max(0.1, zoom)}px` }) } as CSSProperties}>
    {children}
  </div>;
}
