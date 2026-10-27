"use client";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useCanvasActions } from "./flow-canvas";

export function useEditLease(nodeId: string, field: "content" | "prompt") {
  const { canvasId, flushEdits } = useCanvasActions();
  const flushRef = useRef(flushEdits);
  flushRef.current = flushEdits;
  const owner = useRef("");
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const request = useCallback(async (action: "claim" | "release") => {
    if (!canvasId || !owner.current) return false;
    const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/edit-lease`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, field, owner: owner.current, action }),
    });
    return response.ok;
  }, [canvasId, nodeId, field]);
  const focus = useCallback(() => {
    focused.current = true;
    if (!owner.current) owner.current = crypto.randomUUID();
    const claim = () => void request("claim").then(ok => { if (!ok && focused.current) toast.error("无法保护当前编辑，请检查画布状态"); }).catch(() => { if (focused.current) toast.error("无法保护当前编辑，请检查网络"); });
    claim();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(claim, 5000);
  }, [request]);
  const blur = useCallback(() => {
    focused.current = false;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    void flushRef.current().then(ok => { if (ok && !focused.current) return request("release"); }).catch(() => {});
  }, [request]);
  useEffect(() => () => {
    const wasFocused = focused.current;
    focused.current = false;
    if (timer.current) clearInterval(timer.current);
    if (wasFocused) void flushRef.current().then(ok => { if (ok) return request("release"); }).catch(() => {});
  }, [request]);
  return { onFocus: focus, onBlur: blur };
}
