import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

/**
 * 项目标识。由 build/icon.png 的图形提炼成矢量：圆角方块底 + 三个节点。
 * 颜色走 globals.css 里的 --mark-* 变量，浅色/深色模式自动切换。
 */
export function ProjectMark({ size = 22, ...props }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Grok Canvas"
      {...props}
    >
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
        fill="var(--mark-tile)"
        stroke="var(--mark-ring)"
        strokeWidth="1.5"
      />
      <rect
        x="5.5"
        y="5.5"
        width="21"
        height="21"
        rx="5.5"
        stroke="var(--mark-ring)"
        strokeWidth="1"
        opacity="0.7"
      />
      <g stroke="var(--mark-line)" strokeWidth="1.1" strokeLinecap="round">
        <path d="M16 13.4v4.4M16 17.8l-4.2 2.4M16 17.8l4.2 2.4" />
      </g>
      <circle cx="16" cy="10.9" r="2.7" fill="var(--mark-node-a)" />
      <circle cx="11.6" cy="20.9" r="2.7" fill="var(--mark-node-b)" />
      <circle cx="20.4" cy="20.9" r="2.7" fill="var(--mark-node-c)" />
    </svg>
  );
}
