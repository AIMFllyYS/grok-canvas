import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { authenticatedFetch } from "../xai/client";
import { isLoggedIn, loadAuth } from "../xai/store";
import { StudioError } from "./store";

export async function studioModel() {
  const auth = await loadAuth();
  const apiKey = process.env.STUDIO_API_KEY;
  if (!apiKey && !isLoggedIn(auth))
    throw new StudioError(
      "请先在右上角登录 Grok，再使用 Agent 与脚本生成",
      401,
    );
  const provider = createOpenAICompatible({
    name: "studio",
    baseURL: process.env.STUDIO_BASE_URL ?? auth.base_url,
    ...(apiKey
      ? { apiKey }
      : { fetch: (input, init) => authenticatedFetch(input, init) }),
    supportsStructuredOutputs: true,
  });
  return provider.chatModel(process.env.STUDIO_MODEL ?? "grok-4.3");
}
