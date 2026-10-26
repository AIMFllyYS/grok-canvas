import {
  createAgentUIStreamResponse,
  validateUIMessages,
  type InferAgentUIMessage,
} from "ai";
import { z } from "zod";
import { createDirectorAgent, createDirectorTools } from "@/lib/studio/agent";
import {
  acquireProduction,
  loadProject,
  updateProject,
} from "@/lib/studio/store";
import { studioError } from "@/lib/studio/http";
import { finalizeInterruptedMessages } from "@/lib/studio/messages";
import { saveConversation } from "@/lib/studio/conversations";
import { validateAgentSettings } from "@/lib/studio/model-catalog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const { projectId, conversationId, messages } = z
      .object({
        projectId: z.string(),
        conversationId: z.string().optional(),
        messages: z.array(z.unknown()).min(1).max(3000),
      })
      .parse(await request.json());
    release = acquireProduction(projectId);
    const p = await loadProject(projectId);
    const chatId = conversationId ?? p.activeConversationId!;
    const chat = p.conversations!.find(c => c.id === chatId);
    if (!chat) throw new Error("对话不存在");
    const validated = finalizeInterruptedMessages(await validateUIMessages<
      InferAgentUIMessage<typeof agent>
    >({ messages, tools: createDirectorTools(projectId, request.signal) }),chatId);
    // The trusted project scope comes from the endpoint, never from model arguments.
    await updateProject(projectId, (current) => {
      saveConversation(current, chatId, validated);
    });
    const settings = await validateAgentSettings(chat.settings);
    const agent = await createDirectorAgent(projectId, request.signal, settings);
    await updateProject(projectId, current => { saveConversation(current, chatId, validated, settings); });
    const unlock = release;
    return await createAgentUIStreamResponse({
      agent,
      uiMessages: validated,
      abortSignal: request.signal,
      timeout: 580000,
      originalMessages: validated,
      generateMessageId: () => crypto.randomUUID(),
      onEnd: async ({ messages: completed }) => {
        try {
          await updateProject(projectId, (current) => {
            saveConversation(current, chatId, finalizeInterruptedMessages(completed, chatId));
          });
        } finally {
          unlock();
        }
      },
      onError: (error) =>
        error instanceof Error ? error.message : "Agent 执行失败，请重试",
      // Expose model-provided reasoning summaries only; never manufacture hidden reasoning.
      sendReasoning: true,
      headers: { "Cache-Control": "no-store", "X-Studio-Project": p.id },
    });
  } catch (error) {
    release?.();
    return studioError(error);
  }
}
