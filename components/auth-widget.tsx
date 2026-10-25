"use client";

import { useDesktopAvailable } from "@/components/desktop-workspace";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button";
import { PopoverSurface } from "@/components/ui/popover-surface";
import { StatusFeedback } from "@/components/ui/status-feedback";
import { useAuth } from "@/components/auth-status";
import { AccountMenu } from "./account-menu";

export function AuthWidget() {
  return <div className="flex items-center gap-2"><LoginWidget /><AccountMenu /></div>;
}

function LoginWidget() {
  const desktopAvailable = useDesktopAvailable();
  const { status, busy, error, session, open, code, setCode, setOpen, retryStatus, login, complete, cancel } = useAuth();

  if (!status) return <StatusFeedback compact tone={error ? "error" : "muted"} message={error ?? "读取登录状态…"} retry={error ? retryStatus : undefined} />;
  if (status.loggedIn) return null;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger render={<Button size="sm" />} onClick={() => { if (!session && !busy) void login(); }}>
      {busy ? "正在处理…" : session ? "等待授权…" : "登录 Grok"}
    </Popover.Trigger>
    {desktopAvailable && <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8}>
        <PopoverSurface className="w-96 max-w-[calc(100vw-2rem)] p-5">
          <Popover.Title className="text-sm font-medium">登录 Grok</Popover.Title>
          <Popover.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            在授权窗口点击 Allow。页面会显示 Grok Build，完成后这里会自动显示登录结果，画布会保留。
          </Popover.Description>
          {error && <div className="mt-3"><StatusFeedback compact tone="error" message={error} /></div>}
          {session ? <>
            <div className="mt-4"><Button variant="outline" render={<a href={session.authorizeUrl} target="_blank" rel="noopener noreferrer" />}>打开授权页面</Button></div>
            <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void complete(); }}>
              <label htmlFor="grok-auth-code" className="block text-sm">如果授权页显示一串代码，粘贴到这里</label>
              <input id="grok-auth-code" type="password" autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} maxLength={4096} disabled={busy} required className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="粘贴授权码" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !code.trim()}>{busy ? "正在确认…" : "完成登录"}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void login()}>重新登录</Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>取消</Button>
              </div>
            </form>
          </> : <div className="mt-4"><Button disabled={busy} onClick={() => void login()}>{busy ? "正在打开授权…" : "重新登录"}</Button></div>}
        </PopoverSurface>
      </Popover.Positioner>
    </Popover.Portal>}
  </Popover.Root>;
}
