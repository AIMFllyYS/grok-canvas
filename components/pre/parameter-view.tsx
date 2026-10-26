"use client";
import { MessageResponse } from "@/components/ai-elements/message";
/** Values that contain prose render as Markdown; structured data uses the same renderer's code block. */
export function ParameterView({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) return <MessageResponse mode="static">{String(value ?? "null")}</MessageResponse>;
  if (value && typeof value === "object" && !Array.isArray(value)) return <dl className="pre-parameters">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{typeof item !== "object" || item === null ? <MessageResponse mode="static">{String(item ?? "null")}</MessageResponse> : <MessageResponse mode="static">{`\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``}</MessageResponse>}</dd></div>)}</dl>;
  return <MessageResponse mode="static">{`\`\`\`json\n${JSON.stringify(value ?? null, null, 2)}\n\`\`\``}</MessageResponse>;
}
