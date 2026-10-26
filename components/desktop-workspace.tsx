"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { installPageZoomGuard } from "@/lib/page-zoom-guard";

const DesktopAvailableContext = createContext(true);
export const useDesktopAvailable = () => useContext(DesktopAvailableContext);

/** Keep an opened workspace mounted when resizing, so pending work survives. */
export function DesktopWorkspace({ children }: { children: React.ReactNode }) {
  useEffect(() => installPageZoomGuard(document), []);
  const [available, setAvailable] = useState(false);
  const [opened, setOpened] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 320px) and (min-height: 360px)");
    const update = () => {
      const next = media.matches;
      setAvailable(next);
      if (next) setOpened(true);
      setChecked(true);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return <>
    {opened && <DesktopAvailableContext.Provider value={available}>
      <div className="h-full" hidden={!available} inert={!available}>{children}</div>
    </DesktopAvailableContext.Provider>}
    {!available && <main className="desktop-required">
      <Monitor size={40} strokeWidth={1.5} aria-hidden="true" />
      <h1>{checked ? "请稍微放大窗口" : "正在准备画布…"}</h1>
      {checked && <>
        <p>为画布保留至少 320 × 360 的空间。窄屏也可以通过创作 Agent 操作工作流。</p>
        {opened && <p role="status">当前画布仍保留，放大窗口即可继续。</p>}
      </>}
    </main>}
  </>;
}
