import { z } from "zod";
import { acquireProduction, loadProject, updateProject, StudioError } from "@/lib/studio/store";
import { ensureConversations, newConversation } from "@/lib/studio/conversations";
import { studioError } from "@/lib/studio/http";
import { validateAgentSettings } from "@/lib/studio/model-catalog";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Context) {
  try { return Response.json(await loadProject((await params).id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return studioError(error); }
}
export async function POST(_: Request, { params }: Context) {
  let release: (() => void) | undefined;
  try {
    const { id } = await params; release = acquireProduction(id);
    return Response.json(await updateProject(id, p => { newConversation(p); }));
  } catch (error) { return studioError(error); } finally { release?.(); }
}
export async function PATCH(request: Request, { params }: Context) {
  let release: (() => void) | undefined;
  try {
    const body = z.object({ conversationId: z.string(), settings: z.object({ model: z.string().max(160).optional(), fast: z.boolean().optional(), contextWindow: z.number().int().positive().optional(), effort: z.string().max(20).optional() }).optional() }).parse(await request.json());
    const settings = body.settings ? await validateAgentSettings(body.settings) : undefined;
    const { id } = await params; release = acquireProduction(id);
    return Response.json(await updateProject(id, p => {
      ensureConversations(p);
      const chat = p.conversations!.find(c => c.id === body.conversationId);
      if (!chat) throw new StudioError("对话不存在", 404);
      if (settings) chat.settings = settings;
      p.activeConversationId = chat.id; p.messages = chat.messages;
    }));
  } catch (error) { return studioError(error); } finally { release?.(); }
}
