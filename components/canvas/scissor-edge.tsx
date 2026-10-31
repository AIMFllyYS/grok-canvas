"use client";

import { ControlButton } from "@/components/ui/control-button";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { Scissors } from "lucide-react";
import { useCanvasActions } from "./flow-canvas";

/** 光标在命中路径上的最近点（流程坐标系），粗采样 + 三分细化 */
function nearestPointOnPath(el: SVGPathElement, x: number, y: number): [number, number] | null {
  const ctm = el.getScreenCTM();
  const svg = el.ownerSVGElement;
  if (!ctm || !svg) return null;
  const point = new DOMPoint(x, y).matrixTransform(ctm.inverse());
  const total = el.getTotalLength();
  const samples = 40;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const length = (i / samples) * total;
    const p = el.getPointAtLength(length);
    const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = length;
    }
  }
  const step = total / samples;
  let lo = Math.max(0, best - step);
  let hi = Math.min(total, best + step);
  for (let i = 0; i < 10; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const p1 = el.getPointAtLength(m1);
    const p2 = el.getPointAtLength(m2);
    const d1 = (p1.x - point.x) ** 2 + (p1.y - point.y) ** 2;
    const d2 = (p2.x - point.x) ** 2 + (p2.y - point.y) ** 2;
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  const p = el.getPointAtLength((lo + hi) / 2);
  return [p.x, p.y];
}

/** Edge with a scissors button that follows the cursor along the path; click cuts the connection. */
export function ScissorEdge(props: EdgeProps) {
  const [hover, setHover] = useState(false);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hitPathRef = useRef<SVGPathElement>(null);
  const { removeEdge } = useCanvasActions();
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  // 移出线后留一点余量，移到按钮上不会闪烁
  const show = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHover(true);
  };
  const hide = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 150);
  };
  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const follow = (event: ReactMouseEvent) => {
    const el = hitPathRef.current;
    if (!el) return;
    const next = nearestPointOnPath(el, event.clientX, event.clientY);
    if (next) setPoint(next);
  };

  const [buttonX, buttonY] = point ?? [labelX, labelY];

  return (
    <g onMouseEnter={show} onMouseLeave={hide} onMouseMove={follow}>
      <BaseEdge id={props.id} path={path} />
      <path ref={hitPathRef} d={path} fill="none" strokeWidth={24} stroke="transparent" />
      {hover || props.selected ? (
        <EdgeLabelRenderer>
          <ControlButton
            style={{
              // 与节点胶囊、输入框同一规则：缩放画布时保持屏幕尺寸不变
              transform: `translate(-50%, -50%) translate(${buttonX}px, ${buttonY}px) scale(var(--canvas-inverse-zoom, 1))`,
              pointerEvents: "all",
            }}
            className="nodrag nopan absolute flex size-6 items-center justify-center rounded-full bg-popover text-muted-foreground shadow-md ring-1 ring-foreground/10 hover:bg-accent hover:text-foreground"
            onMouseEnter={show}
            onMouseLeave={hide}
            onMouseMove={follow}
            onClick={() => removeEdge(props.id)}
            aria-label="断开连线"
            title="断开连线"
          >
            <Scissors className="h-3 w-3" />
          </ControlButton>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
