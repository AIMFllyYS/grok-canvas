"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GripHorizontal,
  Maximize2,
  Minimize2,
  MoveDiagonal2,
  X,
} from "lucide-react";
import { AgentGlyph } from "@/components/agent/icons";
import { WorkButton } from "./primitives";
type Rect = { x: number; y: number; width: number; height: number };
// 位置偏好键带版本号：默认位置从右下角改到左下角后，旧键里的右侧坐标不再复用。
const PANEL_STORAGE_KEY = "grok-agent-panel:v2";
const PANEL_DEFAULT = { width: 432, height: 640, offset: 22 };
/** 默认展开在画布左下角，与左下角的启动器对齐。 */
function defaultRect(): Rect {
  const w = PANEL_DEFAULT.width,
    h = PANEL_DEFAULT.height,
    o = PANEL_DEFAULT.offset;
  return { x: o, y: Math.max(o, window.innerHeight - h - o), width: w, height: h };
}
function fit(rect: Rect): Rect {
  const w = Math.min(
      window.innerWidth,
      window.visualViewport?.width ?? window.innerWidth,
    ),
    h = Math.min(
      window.innerHeight,
      window.visualViewport?.height ?? window.innerHeight,
    );
  const width = Math.min(Math.max(340, rect.width), w - 24),
    height = Math.min(Math.max(360, rect.height), h - 76);
  return {
    width,
    height,
    x: Math.max(12, Math.min(rect.x, w - width - 12)),
    y: Math.max(60, Math.min(rect.y, h - height - 12)),
  };
}
export function FloatingAgent({
  children,
  open,
  onOpenChange,
  busy = false,
  headerActions,
}: {
  children: ReactNode;
  headerActions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
}) {
  const [rect, setRect] = useState<Rect>();
  const current = useRef<Rect | undefined>(rect),
    drag = useRef<{ x: number; y: number; rect: Rect; resize: boolean } | null>(
      null,
    );
  const [maximized, setMaximized] = useState(false),
    previous = useRef<Rect | undefined>(undefined);
  const place = useCallback((next: Rect) => {
    const fitted = fit(next);
    current.current = fitted;
    setRect(fitted);
  }, []);
  useEffect(() => {
    let saved: Rect | undefined;
    try {
      saved = JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) ?? "null");
    } catch {}
    const valid =
      saved &&
      [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite);
    place(valid ? saved! : defaultRect());
    const resize = () => {
      if (current.current) place(current.current);
    };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [place]);
  const finish = () => {
    drag.current = null;
    try {
      localStorage.setItem(
        PANEL_STORAGE_KEY,
        JSON.stringify(current.current),
      );
    } catch {}
  };
  const pointer = (resize: boolean) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || !current.current) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = {
        x: e.clientX,
        y: e.clientY,
        rect: current.current,
        resize,
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const start = drag.current;
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      place(
        start.resize
          ? {
              ...start.rect,
              width: start.rect.width + dx,
              height: start.rect.height + dy,
            }
          : { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy },
      );
      setMaximized(false);
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const r = current.current;
      if (!r || !e.key.startsWith("Arrow")) return;
      e.preventDefault();
      const dx = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0,
        dy = e.key === "ArrowUp" ? -16 : e.key === "ArrowDown" ? 16 : 0;
      place(
        resize
          ? { ...r, width: r.width + dx, height: r.height + dy }
          : { ...r, x: r.x + dx, y: r.y + dy },
      );
      finish();
    },
  });
  return (
    <>
      <div
        className="agent-floating"
        data-workspace-overlay
        hidden={!open}
        style={
          rect
            ? {
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }
            : undefined
        }
      >
        <div
          className="agent-floating-chrome"
          role="toolbar"
          aria-label="Agent 顶部工具栏"
        >
          <button
            className="agent-drag-handle"
            aria-label="移动 Agent 面板，方向键微调"
            {...pointer(false)}
          >
            <AgentGlyph size={16} />
            <span>创作 Agent</span>
            <GripHorizontal size={12} />
          </button>
          {headerActions}
          <WorkButton
            variant="ghost"
            aria-label={maximized ? "还原 Agent 大小" : "放大 Agent 面板"}
            onClick={() => {
              if (!current.current) return;
              if (maximized && previous.current) place(previous.current);
              else {
                previous.current = current.current;
                place({
                  x: 24,
                  y: 64,
                  width: window.innerWidth - 48,
                  height: window.innerHeight - 88,
                });
              }
              setMaximized(!maximized);
            }}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </WorkButton>
          <WorkButton
            variant="ghost"
            aria-label="收起 Agent"
            onClick={() => onOpenChange(false)}
          >
            <X size={15} />
          </WorkButton>
        </div>
        {children}
        <button
          className="agent-resize-handle"
          aria-label="调整 Agent 面板大小，方向键微调"
          {...pointer(true)}
        >
          <MoveDiagonal2 size={13} />
        </button>
      </div>
      {!open && (
        <button
          className="agent-launcher"
          aria-label="展开创作 Agent"
          onClick={() => onOpenChange(true)}
        >
          <AgentGlyph size={21} />
          <span>创作 Agent</span>
          {busy && <i />}
        </button>
      )}
    </>
  );
}
