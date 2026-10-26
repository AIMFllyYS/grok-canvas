import type { SVGProps } from "react";
type Props = SVGProps<SVGSVGElement> & { size?: number };
export function AgentGlyph({ size = 18, ...props }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M7 4h10l4 8-4 8H7l-4-8zM8 8l-2.5 4L8 16m8-8 2.5 4L16 16m-2.5-8-3 8" />
    </svg>
  );
}
export function ReasoningGlyph({ size = 16, ...props }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v8a4 4 0 0 0 4 4h6M8 5h8a3 3 0 0 1 0 6h-4" />
    </svg>
  );
}
