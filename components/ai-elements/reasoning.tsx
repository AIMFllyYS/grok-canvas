"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDown } from "lucide-react";
import { ReasoningGlyph } from "@/components/agent/icons";
import { MessageResponse } from "./message";
export function Reasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <Collapsible.Root className="agent-reasoning" defaultOpen={false}>
      <Collapsible.Trigger>
        <ReasoningGlyph size={14} />
        {streaming ? "正在思考" : "模型推理摘要"}
        <ChevronDown size={13} />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <MessageResponse isAnimating={streaming}>{text}</MessageResponse>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
