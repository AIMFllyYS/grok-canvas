"use client";

import { Button } from "@/components/ui/button";

export function CanvasEmptyState({ onAddImage }: { onAddImage: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-8">
      <div
        className="pointer-events-auto max-w-sm rounded-2xl bg-popover p-6 text-center text-popover-foreground shadow-xl ring-1 ring-foreground/10"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-medium">从一张图片开始</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          添加图片节点，在下方输入提示词，即可生成。也可以上传已有图片作为参考。
        </p>
        <Button type="button" className="mt-4" onClick={onAddImage}>
          添加图片节点
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">或点击左侧 +，或在空白处右键</p>
      </div>
    </div>
  );
}
