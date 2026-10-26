import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentSettings } from "./schema";
import {
  modelCatalog,
  validateAgentSettings,
  cliRequestHeaders,
} from "./model-catalog";
import { authenticatedFetch } from "../xai/client";
import { isLoggedIn, loadAuth } from "../xai/store";
import { AgentError } from "./store";
export function agentProviderOptions(settings: AgentSettings = {}) {
  return {
    openai: {
      store: false,
      forceReasoning: true,
      reasoningSummary: "auto",
      ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
    },
    agent: { ...(settings.effort ? { reasoningEffort: settings.effort } : {}) },
  };
}

export async function agentModel(settings: AgentSettings = {}) {
  const selected = await validateAgentSettings(settings);
  const entry = (await modelCatalog()).models.find(
    (m) => m.id === selected.model,
  )!;
  const auth = await loadAuth();
  if (!isLoggedIn(auth))
    throw new AgentError("请先在右上角登录 Grok，再使用画布 Agent", 401);
  const connection = {
    baseURL: entry.baseURL,
    headers: await cliRequestHeaders(selected),
    apiKey: "oauth",
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      authenticatedFetch(input, init),
  };
  const modelId = selected.fast ? entry.fastId! : entry.id;
  if (entry.backend === "responses") {
    return createOpenAI(connection).responses(modelId);
  }
  const provider = createOpenAICompatible({
    name: "agent",
    ...connection,
    supportsStructuredOutputs: true,
  });
  return provider.chatModel(modelId);
}
