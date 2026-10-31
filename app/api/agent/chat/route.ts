import {
  createAgentUIStreamResponse,
  validateUIMessages,
  type InferAgentUIMessage,
} from "ai";
import { z } from "zod";
import { createCanvasAgent, createCanvasTools } from "@/lib/agent/agent";
import { acquireAgent, updateAgent, AgentError } from "@/lib/agent/store";
import { saveConversation } from "@/lib/agent/conversations";
import { finalizeInterruptedMessages } from "@/lib/agent/messages";
import { validateAgentSettings } from "@/lib/agent/model-catalog";
import { agentError } from "@/lib/agent/http";
import { withExistingCanvas } from "@/lib/canvas-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const { canvasId, conversationId, messages } = z
      .object({
        canvasId: z.string().min(1),
        conversationId: z.string(),
        messages: z.array(z.unknown()).min(1).max(3000),
      })
      .parse(await request.json());
    release = (await withExistingCanvas(canvasId, () => acquireAgent(canvasId))) ?? undefined;
    if (!release) throw new AgentError("画布不存在", 404);
    const state = await updateAgent(canvasId);
    const chat = state.conversations.find((c) => c.id === conversationId);
    if (!chat) throw new AgentError("对话不存在", 404);
    const origin = new URL(request.url).origin;
    const validated = finalizeInterruptedMessages(
      await validateUIMessages<
        InferAgentUIMessage<Awaited<ReturnType<typeof createCanvasAgent>>>
      >({ messages, tools: createCanvasTools(canvasId, origin) }),
      conversationId,
    );
    await updateAgent(canvasId, (p) =>
      saveConversation(p, conversationId, validated),
    );
    const settings = await validateAgentSettings(chat.settings),
      agent = await createCanvasAgent(
        canvasId,
        origin,
        settings,
        request.signal,
        conversationId,
      );
    const unlock = release;
    return await createAgentUIStreamResponse({
      agent,
      uiMessages: validated,
      originalMessages: validated,
      abortSignal: request.signal,
      timeout: 580000,
      generateMessageId: () => crypto.randomUUID(),
      sendReasoning: true,
      onEnd: async ({ messages: completed }) => {
        try {
          await updateAgent(canvasId, (p) =>
            saveConversation(
              p,
              conversationId,
              finalizeInterruptedMessages(completed, conversationId),
              settings,
            ),
          );
        } finally {
          unlock();
        }
      },
      onError: (e) => (e instanceof Error ? e.message : "Agent 执行失败"),
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    release?.();
    return agentError(e);
  }
}
