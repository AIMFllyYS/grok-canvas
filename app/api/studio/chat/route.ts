import {
  createAgentUIStreamResponse,
  validateUIMessages,
  type InferAgentUIMessage,
} from "ai";
import { z } from "zod";
import { createDirectorAgent } from "@/lib/studio/agent";
import {
  acquireProduction,
  loadProject,
  updateProject,
} from "@/lib/studio/store";
import { studioError } from "@/lib/studio/http";
import { finalizeInterruptedMessages } from "@/lib/studio/messages";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const { projectId, messages } = z
      .object({
        projectId: z.string(),
        messages: z.array(z.unknown()).min(1).max(300),
      })
      .parse(await request.json());
    release = acquireProduction(projectId);
    const p = await loadProject(projectId);
    const agent = await createDirectorAgent(projectId, request.signal);
    const validated = finalizeInterruptedMessages(await validateUIMessages<
      InferAgentUIMessage<typeof agent>
    >({ messages, tools: agent.tools }),projectId);
    // The trusted project scope comes from the endpoint, never from model arguments.
    await updateProject(projectId, (current) => {
      current.messages = validated;
    });
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
            current.messages = finalizeInterruptedMessages(completed, projectId);
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
