import { z } from "zod";
import { updateAgent, agentBusy, AgentError } from "@/lib/agent/store";
import {
  newConversation,
  ensureConversations,
} from "@/lib/agent/conversations";
import { validateAgentSettings } from "@/lib/agent/model-catalog";
import { agentError } from "@/lib/agent/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const body = z.object({
  canvasId: z.string().min(1),
  conversationId: z.string().optional(),
  settings: z
    .object({
      model: z.string().optional(),
      fast: z.boolean().optional(),
      contextWindow: z.number().optional(),
      effort: z.string().optional(),
    })
    .optional(),
});
export async function GET(request: Request) {
  try {
    const id = z
      .string()
      .min(1)
      .parse(new URL(request.url).searchParams.get("canvasId"));
    const state = await updateAgent(id);
    return Response.json({ ...state, busy: agentBusy(id) });
  } catch (e) {
    return agentError(e);
  }
}
export async function POST(request: Request) {
  try {
    const { canvasId } = body.parse(await request.json());
    if (agentBusy(canvasId)) throw new AgentError("请先停止当前执行", 409);
    return Response.json(
      await updateAgent(canvasId, (p) => {
        newConversation(p);
      }),
    );
  } catch (e) {
    return agentError(e);
  }
}
export async function PATCH(request: Request) {
  try {
    const { canvasId, conversationId, settings } = body.parse(
      await request.json(),
    );
    if (agentBusy(canvasId)) throw new AgentError("请先停止当前执行", 409);
    const validated = settings
      ? await validateAgentSettings(settings)
      : undefined;
    return Response.json(
      await updateAgent(canvasId, (p) => {
        const chat = p.conversations.find((c) => c.id === conversationId);
        if (!chat) throw new AgentError("对话不存在", 404);
        if (validated) chat.settings = validated;
        p.activeConversationId = chat.id;
        ensureConversations(p);
      }),
    );
  } catch (e) {
    return agentError(e);
  }
}
