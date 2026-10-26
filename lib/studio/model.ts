import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentSettings } from "./schema";
import { modelCatalog, validateAgentSettings, cliRequestHeaders } from "./model-catalog";
import { authenticatedFetch } from "../xai/client";
import { isLoggedIn, loadAuth } from "../xai/store";
import { StudioError } from "./store";
export function studioProviderOptions(settings: AgentSettings = {}) {
  return { openai: { store: false, forceReasoning: true, reasoningSummary: "auto", ...(settings.effort ? { reasoningEffort: settings.effort } : {}) }, studio: { ...(settings.effort ? { reasoningEffort: settings.effort } : {}) } };
}

export async function studioModel(settings: AgentSettings = {}) {
  const selected = await validateAgentSettings(settings);
  const entry = (await modelCatalog()).models.find(m => m.id === selected.model)!;
  const auth = await loadAuth();
  const apiKey = process.env.STUDIO_API_KEY;
  if (!apiKey && !isLoggedIn(auth))
    throw new StudioError(
      "请先在右上角登录 Grok，再使用 Agent 与脚本生成",
      401,
    );
  const connection = {
    baseURL: process.env.STUDIO_BASE_URL ?? entry.baseURL,
    headers: await cliRequestHeaders(selected),
    ...(apiKey ? { apiKey } : { apiKey: "oauth", fetch: (input: RequestInfo | URL, init?: RequestInit) => authenticatedFetch(input, init) }),
  };
  const modelId = selected.fast ? entry.fastId! : entry.id;
  if (entry.backend === "responses" && !process.env.STUDIO_BASE_URL) {
    return createOpenAI(connection).responses(modelId);
  }
  const provider = createOpenAICompatible({
    name: "studio",
    ...connection,
    supportsStructuredOutputs: true,
  });
  return provider.chatModel(process.env.STUDIO_MODEL ?? modelId);
}
