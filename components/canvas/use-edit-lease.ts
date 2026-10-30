"use client";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useCanvasActions } from "./flow-canvas";

/** 与服务端 lease-service 一致：TTL 4s，每 1s 带 token 续期。 */
const LEASE_RENEW_MS = 1000;

export function useEditLease(nodeId: string, field: "content" | "prompt") {
  const { canvasId, flushEdits, actorId } = useCanvasActions();
  const flushRef = useRef(flushEdits);
  flushRef.current = flushEdits;
  const actorRef = useRef(actorId);
  actorRef.current = actorId;
  const owner = useRef("");
  const token = useRef<string | null>(null);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const request = useCallback(async (action: "claim" | "renew" | "release") => {
    if (!canvasId || !owner.current) return false;
    const response = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/edit-lease`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, field, owner: owner.current, action, ...(token.current && action !== "claim" ? { token: token.current } : {}) }),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({})) as { token?: string };
    if (action === "release") token.current = null;
    else if (typeof body.token === "string") token.current = body.token;
    return true;
  }, [canvasId, nodeId, field]);
  const focus = useCallback(() => {
    focused.current = true;
    // owner 必须与命令的 actorId 一致：租约只挡别人，不挡自己提交的 patch（P2-07）。
    const actor = actorRef.current();
    if (actor && owner.current !== actor) { owner.current = actor; token.current = null; }
    if (!owner.current) owner.current = crypto.randomUUID();
    const warn = (message: string) => { if (focused.current) toast.error(message); };
    const keepAlive = () => {
      // 续期失败（例如租约已过期）时重新获取一次，仍失败才提示。
      const action = token.current ? "renew" : "claim";
      void request(action)
        .then(ok => ok || action === "claim" ? ok : request("claim"))
        .then(ok => { if (!ok) warn("无法保护当前编辑，请检查画布状态"); })
        .catch(() => warn("无法保护当前编辑，请检查网络"));
    };
    keepAlive();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(keepAlive, LEASE_RENEW_MS);
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
