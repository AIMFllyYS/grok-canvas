import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSettings } from "./schema";
import { StudioError } from "./store";
import { authenticatedFetch } from "../xai/client";
import { isLoggedIn, loadAuth } from "../xai/store";

export type CLIModel = { id: string; name: string; fastId?: string; contextWindows: number[]; efforts: string[]; backend: "responses" | "chat"; baseURL: string };
type CachedInfo = { id: string; model?: string; name?: string; hidden?: boolean; supported_in_api?: boolean; context_window?: number; context_windows?: number[]; reasoning_efforts?: { value: string }[]; api_backend?: string; base_url?: string };
let live: { values: CachedInfo[]; at: number } | undefined;
export async function cliRequestHeaders(settings: AgentSettings = {}) {
  const headers: Record<string, string> = { "x-xai-token-auth": "xai-grok-cli", "x-grok-client-identifier": "grok-canvas" };
  const directory = process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, "version.json"), "utf8"));
    if (/^\d+\.\d+\.\d+/.test(metadata.version)) headers["x-grok-client-version"] = metadata.version;
  } catch { /* Custom endpoints may not need CLI metadata. */ }
  if (settings.contextWindow) headers["x-grok-context-window"] = String(settings.contextWindow);
  return headers;
}
export function parseModelCatalog(values: CachedInfo[]): CLIModel[] {
  return values.filter(v => !v.hidden && v.supported_in_api !== false && !/fast/i.test(v.name ?? v.id)).map(v => ({
    id: v.id, name: v.name ?? v.id,
    fastId: values.find(f => !f.hidden && f.supported_in_api !== false && /fast/i.test(f.name ?? f.id) && f.id.replace(/-build-fast$|-fast$/, "") === v.id)?.id,
    contextWindows: v.context_windows?.length ? v.context_windows : [v.context_window ?? 128000],
    efforts: v.reasoning_efforts?.map(e => e.value) ?? [],
    backend: v.api_backend === "responses" ? "responses" : "chat",
    baseURL: v.base_url ?? "https://api.x.ai/v1",
  }));
}
export async function modelCatalog(): Promise<{ models: CLIModel[]; defaultSettings: AgentSettings; source: "cli-service" | "cli-cache" | "configured"; fetchedAt?: string }> {
  // Read the CLI's own catalog rather than maintaining a competing list. Never expose credential fields.
  try {
    const directory = process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");
    const cache = JSON.parse(await readFile(path.join(directory, "models_cache.json"), "utf8"));
    let values = Object.values(cache.models ?? {}).map((m: unknown) => (m as { info: CachedInfo }).info).filter(Boolean);
    let online = false;
    if (!process.env.STUDIO_BASE_URL && isLoggedIn(await loadAuth())) {
      try {
        if (!live || Date.now() - live.at > 60000) {
          const response = await authenticatedFetch("https://cli-chat-proxy.grok.com/v1/models", { headers: await cliRequestHeaders(), signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error("catalog unavailable");
          const payload = await response.json();
          if (!Array.isArray(payload.data) || !payload.data.length) throw new Error("empty catalog");
          live = { values: payload.data, at: Date.now() };
        }
        values = live.values.map(info => ({ ...values.find(v => v.id === info.id), ...info })); online = true;
      } catch { /* Offline use is explicit in the catalog source, never reported as live. */ }
    }
    const models = parseModelCatalog(values);
    if (!models.length) throw new Error("empty catalog");
    let preferred = "", preferredEffort = "";
    try {
      const config = await readFile(path.join(directory, "config.toml"), "utf8");
      preferred = config.match(/\[models\]([\s\S]*?)(?=\n\[|$)/)?.[1]?.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? "";
      preferredEffort = config.match(/\[models\]([\s\S]*?)(?=\n\[|$)/)?.[1]?.match(/^default_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    } catch { /* The catalog can be used without a saved preference. */ }
    const selected = models.find(m => m.id === preferred || m.fastId === preferred) ?? models[0]!;
    return { models, defaultSettings: { model: selected.id, fast: selected.fastId === preferred, contextWindow: selected.contextWindows[0], effort: selected.efforts.includes(preferredEffort) ? preferredEffort : selected.efforts.includes("high") ? "high" : selected.efforts[0] }, source: online ? "cli-service" : "cli-cache", fetchedAt: online ? new Date(live!.at).toISOString() : cache.fetched_at as string | undefined };
  } catch {
    // Explicit custom endpoints are supported for deployments without a local CLI installation.
    const id = process.env.STUDIO_MODEL;
    if (!id) throw new StudioError("未找到 Grok CLI 模型目录。请在本机运行 grok models 刷新目录，或配置 STUDIO_MODEL 与 STUDIO_BASE_URL。", 503);
    return { models: [{ id, name: id, contextWindows: [128000], efforts: [], backend: "chat" as const, baseURL: process.env.STUDIO_BASE_URL ?? "https://api.x.ai/v1" }], defaultSettings: { model: id, fast: false, contextWindow: 128000, effort: undefined }, source: "configured" as const, fetchedAt: undefined };
  }
}
export async function validateAgentSettings(settings: AgentSettings) {
  const catalog = await modelCatalog();
  const merged = { ...catalog.defaultSettings, ...settings };
  const model = catalog.models.find(m => m.id === merged.model);
  if (!model) throw new StudioError("模型不在 Grok CLI 目录中，请刷新模型列表", 422);
  if (merged.fast && !model.fastId) throw new StudioError("此模型未提供 fast 档位", 422);
  if (merged.contextWindow && !model.contextWindows.includes(merged.contextWindow)) throw new StudioError("此模型不支持所选上下文窗口", 422);
  if (merged.effort && !model.efforts.includes(merged.effort)) throw new StudioError("此模型不支持所选推理强度", 422);
  return merged;
}
