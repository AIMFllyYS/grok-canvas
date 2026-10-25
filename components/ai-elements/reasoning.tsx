"use client";
import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown } from "lucide-react";
import { MessageResponse } from "./message";
export function Reasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <Collapsible.Root className="studio-reasoning" defaultOpen={false}>
      <Collapsible.Trigger>
        <Brain size={14} />
        {streaming ? "正在思考" : "模型推理摘要"}
        <ChevronDown size={13} />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <MessageResponse isAnimating={streaming}>{text}</MessageResponse>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
