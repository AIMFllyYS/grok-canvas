"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { parseToolbarLayout, TOOLBAR_LAYOUT_KEY, type ToolbarLayout } from "@/lib/workspace-preferences";

type Preferences = { layout: ToolbarLayout; setLayout: (layout: ToolbarLayout) => void; resetPosition: () => void; positionReset: number };
const Context = createContext<Preferences | null>(null);
export function WorkspacePreferencesProvider({ children }: { children: ReactNode }) {
  const [layout, setValue] = useState<ToolbarLayout>("aggregated");
  const [positionReset, setPositionReset] = useState(0);
  useEffect(() => {
    try { setValue(parseToolbarLayout(localStorage.getItem(TOOLBAR_LAYOUT_KEY))); } catch { /* 存储不可用时保留内存偏好。 */ }
    const sync = (event: StorageEvent) => { if (event.key === TOOLBAR_LAYOUT_KEY) setValue(parseToolbarLayout(event.newValue)); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setLayout = useCallback((next: ToolbarLayout) => {
    setValue(next);
    try { localStorage.setItem(TOOLBAR_LAYOUT_KEY, next); } catch { /* 不阻断本次操作。 */ }
  }, []);
  const resetPosition = useCallback(() => setPositionReset(n => n + 1), []);
  // 让样式层知道工具栏布局：拆散布局的工具栏也贴左下角，创作 Agent 启动器需要让位。
  useEffect(() => { document.documentElement.dataset.toolbarLayout = layout; }, [layout]);
  const value = useMemo(() => ({ layout, setLayout, positionReset, resetPosition }), [layout, setLayout, positionReset, resetPosition]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkspacePreferences() {
  const value = useContext(Context);
  if (!value) throw new Error("工作区偏好尚未初始化");
  return value;
}
