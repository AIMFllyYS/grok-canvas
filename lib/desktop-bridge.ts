type DesktopBridge = {
  openExternal: (url: string) => void | Promise<void>;
};

declare global {
  interface Window {
    grokDesktop?: DesktopBridge;
  }
}

function bridge(): DesktopBridge | null {
  return typeof window === "undefined" ? null : window.grokDesktop ?? null;
}

export function hasDesktopBridge(): boolean {
  return bridge() !== null;
}

/** Hand an http(s) URL to the desktop shell; browser tabs keep their normal behavior. */
export function openExternalUrl(value: string): boolean {
  const desktop = bridge();
  if (!desktop) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  void desktop.openExternal(url.toString());
  return true;
}
