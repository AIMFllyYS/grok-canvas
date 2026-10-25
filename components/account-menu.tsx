"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTheme } from "next-themes";
import { ChevronDown, Grip, LayoutPanelLeft, LogOut, Monitor, Moon, RotateCcw, Sun, UserRound, NotebookText } from "lucide-react";
import { useAuth } from "./auth-status";
import { useDesktopAvailable } from "./desktop-workspace";
import { useWorkspacePreferences } from "./workspace-preferences";
import { ControlButton } from "./ui/control-button";
import { PopoverSurface } from "./ui/popover-surface";
import { UsageIndicator } from "./usage-indicator";
import { accountDisplay, safeProfilePicture } from "@/lib/account-display";

export function AccountMenu() {
  const { status, busy, error, logout, retryStatus } = useAuth();
  const available = useDesktopAvailable();
  const { layout, setLayout, resetPosition } = useWorkspacePreferences();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
  const { name, initial } = accountDisplay(status?.email);
  const picture = safeProfilePicture(status?.picture);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger data-ui-control="true" aria-label={status?.loggedIn ? `${name} 的账户与设置` : "工作区设置"} className="flex h-8 items-center gap-2 rounded-full pl-1 pr-2.5 text-xs outline-none" title={status?.email ?? "工作区设置"}>
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium">
        {status?.loggedIn ? picture && picture !== failedPicture
          ? <img src={picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailedPicture(picture)} />
          : initial : <UserRound size={14} />}
      </span>
      <span className="max-w-32 truncate">{status?.loggedIn ? name : "设置"}</span><ChevronDown size={12} className="text-muted-foreground" />
    </Popover.Trigger>
    {available && <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={10} collisionPadding={12} className="z-50">
      <PopoverSurface className="w-72 p-2" onKeyDown={event => event.stopPropagation()}>
        <Popover.Title className="px-2 pt-2 text-sm font-medium">{status?.loggedIn ? name : "工作区设置"}</Popover.Title>
        <Popover.Description className="truncate px-2 pb-3 pt-1 text-xs text-muted-foreground">{status?.loggedIn ? status.email ?? "Grok 账户" : "让画布按你的习惯工作"}</Popover.Description>
        <section className="border-t px-2 py-3" aria-label="工具栏布局">
          <h3 className="mb-2 text-xs text-muted-foreground">工具栏</h3>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1">
            {([{ value: "aggregated", label: "聚合", Icon: Grip }, { value: "scattered", label: "拆散", Icon: LayoutPanelLeft }] as const).map(({ value, label, Icon }) => <ControlButton key={value} aria-pressed={layout === value} onClick={() => setLayout(value)} className="flex h-8 items-center justify-center gap-2 rounded-md text-xs"><Icon size={14} />{label}</ControlButton>)}
          </div>
          <ControlButton onClick={() => { resetPosition(); setOpen(false); }} className="mt-2 flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground"><RotateCcw size={12} />重置工具栏位置</ControlButton>
        </section>
        <section className="border-t px-2 py-3" aria-label="外观模式">
          <h3 className="mb-2 text-xs text-muted-foreground">外观</h3>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1">
            {([{ value: "system", label: "跟随系统", Icon: Monitor }, { value: "light", label: "米白", Icon: Sun }, { value: "dark", label: "高级黑", Icon: Moon }, { value:"paper",label:"纸张",Icon:NotebookText }] as const).map(({ value, label, Icon }) => <ControlButton key={value} aria-pressed={theme === value} onClick={() => setTheme(value)} className="flex h-8 items-center justify-center gap-1.5 rounded-md text-xs"><Icon size={13} />{label}</ControlButton>)}
          </div>
        </section>
        <div className="border-t"><UsageIndicator key={`${status?.loggedIn}:${status?.email}:${status?.lastRefresh}`} active={open} loggedIn={status?.loggedIn === true} /></div>
        {error && <p role="status" className="px-2 pb-2 text-xs text-destructive">{error}<ControlButton onClick={retryStatus} className="ml-2 underline">重试</ControlButton></p>}
        {status?.loggedIn && <div className="border-t pt-1"><ControlButton disabled={busy} onClick={() => void logout().then(() => setOpen(false))} className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-xs"><LogOut size={14} />{busy ? "正在登出…" : "退出登录"}</ControlButton></div>}
      </PopoverSurface>
    </Popover.Positioner></Popover.Portal>}
  </Popover.Root>;
}
