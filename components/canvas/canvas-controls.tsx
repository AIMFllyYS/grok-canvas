"use client";

import { ControlButton } from "@/components/ui/control-button";

import { useReactFlow, useStore } from "@xyflow/react";
import { Hand, Map as MapIcon, Maximize, Minus, MousePointer2, Plus } from "lucide-react";
import type { InteractionMode } from "@/lib/canvas-interaction";
import type { ReactNode } from "react";

export function CanvasControls({
  minimapOpen,
  onToggleMinimap,
  mode,
  onModeChange,
  leading,
}: {
  minimapOpen: boolean;
  onToggleMinimap: () => void;
  mode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  leading?: ReactNode;
}) {
  const zoom = useStore((state) => state.transform[2]);
  const { zoomTo, zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="flex items-center gap-1">
      {leading}
      <ControlButton className="flex size-8 items-center justify-center rounded-full" title="选择（V）" aria-label="选择工具" aria-pressed={mode === "select"} onClick={() => onModeChange("select")}><MousePointer2 size={16} /></ControlButton>
      <ControlButton className="flex size-8 items-center justify-center rounded-full" title="平移与移动节点（H）；按住空格临时平移" aria-label="手型工具" aria-pressed={mode === "hand"} onClick={() => onModeChange("hand")}><Hand size={16} /></ControlButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ControlButton
        className={`flex size-7 items-center justify-center rounded-full hover:bg-accent ${
          minimapOpen ? "bg-accent" : ""
        }`}
        aria-label={minimapOpen ? "隐藏小地图" : "显示小地图"}
        aria-pressed={minimapOpen}
        onClick={onToggleMinimap}
      >
        <MapIcon className="size-4" />
      </ControlButton>
      <ControlButton
        className="flex size-7 items-center justify-center rounded-full hover:bg-accent"
        aria-label="适应全部节点"
        onClick={() => void fitView()}
      >
        <Maximize className="size-4" />
      </ControlButton>
      <ControlButton className="flex size-7 items-center justify-center rounded-full" aria-label="缩小画布" title="缩小" onClick={() => void zoomOut()}><Minus size={14} /></ControlButton>
      <div className="flex items-center gap-1">
        <span className="w-8 text-right text-xs text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <input
          type="range"
          min={0.1}
          max={2}
          step={0.01}
          value={zoom}
          aria-label="缩放"
          className="h-1 w-16 cursor-pointer accent-foreground"
          onChange={(event) => void zoomTo(Number(event.target.value))}
        />
      </div>
      <ControlButton className="flex size-7 items-center justify-center rounded-full" aria-label="放大画布" title="放大" onClick={() => void zoomIn()}><Plus size={14} /></ControlButton>
    </div>
  );
}
