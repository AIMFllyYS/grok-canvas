"use client";

import { WorkButton } from "@/components/pre/primitives";
import { ImagePlus } from "lucide-react";

export function CanvasEmptyState({ onAddImage }: { onAddImage: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-8">
      <div
        className="pre-canvas-empty pointer-events-auto"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>你的创作，从这里展开</h2>
        <p>
          添加节点，或让右下角的 Agent 帮你搭建。
        </p>
        <WorkButton onClick={onAddImage}><ImagePlus size={14}/>添加图片节点</WorkButton>
      </div>
    </div>
  );
}
