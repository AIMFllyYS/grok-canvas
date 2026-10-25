"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopAvailable } from "@/components/desktop-workspace";

export type AuthStatus = { loggedIn: boolean; email: string | null; picture?: string | null; lastRefresh?: string | null; pendingLogin: boolean; error: { code: string } | null };
export type LoginSession = { authorizeUrl: string; state: string; started: number };

type AuthContextValue = {
  status: AuthStatus | null;
  loggedIn: boolean | null;
  busy: boolean;
  error: string | null;
  session: LoginSession | null;
  open: boolean;
  code: string;
  setCode: (code: string) => void;
  setOpen: (open: boolean) => void;
  refresh: () => Promise<AuthStatus>;
  retryStatus: () => void;
  login: () => Promise<void>;
  complete: () => Promise<void>;
  cancel: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const desktopAvailable = useDesktopAvailable();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<LoginSession | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const popup = useRef<Window | null>(null);
  useEffect(() => { if (!desktopAvailable) setOpen(false); }, [desktopAvailable]);
  const finish = useCallback(() => {
    setSession(null);
    setCode("");
    setError(null);
    setOpen(false);
    popup.current?.close();
    popup.current = null;
  }, []);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/status", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("读取登录状态失败，请重试");
    const next = await response.json() as AuthStatus;
    setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    const check = () => { void refresh().catch(() => setError("读取登录状态失败，请重试")); };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [refresh]);
  useEffect(() => {
    if (session && status?.loggedIn) finish();
    else if (session && status?.error && !status.pendingLogin) {
      setSession(null);
      setCode("");
      setError(status.error.code === "denied" ? "你已取消授权，可以重新登录" : "登录未完成，请重新登录后再试");
    }
  }, [session, status, finish]);
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() - session.started >= 10 * 60_000) {
        setSession(null);
        setCode("");
        setError("登录已超时，请重新登录");
        return;
      }
      try { await refresh(); } catch { if (!stopped) setError("暂时无法检查登录状态，正在重试"); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, refresh]);

  const login = async () => {
    // Open synchronously with the click so browsers do not block an awaited window.open.
    popup.current?.close();
    const child = window.open("about:blank", "grok-canvas-auth", "popup,width=760,height=820");
    if (child) child.opener = null;
    popup.current = child;
    setBusy(true);
    setError(null);
    setCode("");
    setSession(null);
    setOpen(true);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", signal: AbortSignal.timeout(20_000) });
      const payload = await response.json() as { authorizeUrl?: string; state?: string };
      if (!response.ok || !payload.authorizeUrl || !payload.state) throw new Error();
      setStatus(current => current ? { ...current, error: null, pendingLogin: true } : current);
      setSession({ authorizeUrl: payload.authorizeUrl, state: payload.state, started: Date.now() });
      if (child && !child.closed) child.location.href = payload.authorizeUrl;
    } catch {
      child?.close();
      setError("无法发起登录，请重试");
    } finally { setBusy(false); }
  };
  const complete = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), state: session.state }), signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error("授权码无效或已过期，请重新登录后再试");
      const next = await refresh();
      if (next.loggedIn) finish();
    } catch (e) {
      setError(e instanceof Error && e.message.startsWith("授权码") ? e.message : "未能确认登录结果，正在自动检查；也可以重试");
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: session.state }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      finish();
    } catch { setError("取消失败，请重试"); } finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      await refresh();
    } catch { setError("登出失败，请重试"); } finally { setBusy(false); }
  };

  const value = useMemo<AuthContextValue>(() => ({
    status,
    loggedIn: status ? status.loggedIn : null,
    busy,
    error,
    session,
    open,
    code,
    setCode,
    setOpen,
    refresh,
    retryStatus: () => void refresh().then(() => setError(null)).catch(() => setError("读取登录状态失败，请重试")),
    login,
    complete,
    cancel,
    logout,
  }), [status, busy, error, session, open, code, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
