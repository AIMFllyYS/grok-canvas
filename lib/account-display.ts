export function accountDisplay(email: string | null | undefined): { name: string; initial: string } {
  const name = email?.split("@")[0]?.trim() || "用户";
  const initial = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next().value?.segment ?? "用";
  return { name, initial: initial.toLocaleUpperCase() };
}
export function safeProfilePicture(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
