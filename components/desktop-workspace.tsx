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
    const media = window.matchMedia("(min-width: 1100px) and (min-height: 640px)");
    const update = () => {
      const mobile = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
      const next = media.matches && !mobile;
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
      <h1>{checked ? "在电脑上继续创作" : "正在准备画布…"}</h1>
      {checked && <>
        <p>画布需要鼠标和键盘操作，请在电脑浏览器打开当前网址。</p>
        <p>已经在用电脑？请放大窗口，为画布留出至少 1100 × 640 的空间。</p>
        {opened && <p role="status">当前画布仍保留，放大窗口即可继续。</p>}
      </>}
    </main>}
  </>;
}
