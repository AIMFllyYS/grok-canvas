import type { SVGProps } from "react";
type IconProps = SVGProps<SVGSVGElement> & { size?: number };
function Glyph({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}
export function StudioMark({ size = 30, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <rect x="1" y="1" width="34" height="34" rx="9" fill="#1D1C22" />
      <path
        d="M10 14V10H15M21 10H26V15M26 21V26H21M15 26H10V21"
        stroke="#E8D3A2"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M16 13.5L23 18L16 22.5V13.5Z" fill="#E8D3A2" />
      <path
        d="M8 18H11M25 18H28"
        stroke="#E8D3A2"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function AgentGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5L14.4 9.6L20.5 12L14.4 14.4L12 20.5L9.6 14.4L3.5 12L9.6 9.6L12 3.5Z" />
      <path d="M19 3.5V6.5M17.5 5H20.5" />
    </Glyph>
  );
}
export function DirectorGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="9" width="17" height="11.5" rx="2" />
      <path d="M3.5 9L3 5.5L19.5 2.5L20.5 6.5L3.5 9ZM7 4.8L10 7.8M13 3.7L16 6.7M10 12.5L15 15L10 17.5V12.5Z" />
    </Glyph>
  );
}
export function CanvasGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1.4" />
      <rect x="14.5" y="14.5" width="6" height="6" rx="1.4" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1.4" />
      <path d="M14 6.5L17.5 3L21 6.5L17.5 10L14 6.5Z" />
      <path d="M10 6.5H13M6.5 10V14M10 17.5H14" strokeDasharray="1 2" />
    </Glyph>
  );
}
export function SourceGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 3.5H15L19 7.5V20.5H6V3.5ZM14 3.5V8.5H19M9 12H16M9 15.5H14" />
      <path d="M3 8V22H14" opacity=".5" />
    </Glyph>
  );
}
export function ScriptGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5 3.5H15L19 7.5V20.5H5V3.5ZM14 3.5V8.5H19M8.5 12H15.5M8.5 15.5H13" />
      <path d="M3 5.5H6.5M3 10H6.5M3 14.5H6.5M3 19H6.5" />
    </Glyph>
  );
}
export function ReferenceGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="5" width="14" height="15.5" rx="2" />
      <path d="M7 5V2.5H21V18H17.5M3.5 16L8 11.5L13 16.5L15 14.5L17.5 17" />
      <circle cx="13" cy="9" r="1.2" />
    </Glyph>
  );
}
export function ShotsGlyph(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="6" width="8" height="12" rx="1.5" />
      <rect x="13.5" y="6" width="8" height="12" rx="1.5" />
      <path d="M6.5 3V6M17.5 3V6M6.5 18V21M17.5 18V21M10.5 12H13.5" />
    </Glyph>
  );
}
