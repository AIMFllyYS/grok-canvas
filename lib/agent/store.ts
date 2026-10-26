import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../data-dir";
import { isSafeCanvasId, loadCanvas } from "../canvas-store";
import { ensureConversations, finalizeConversations } from "./conversations";
import type { AgentState } from "./schema";

export class AgentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const scope = globalThis as typeof globalThis & {
  __canvasAgents?: Map<string, { queue: Promise<unknown>; busy: boolean }>;
};
const locks: Map<string, { queue: Promise<unknown>; busy: boolean }> =
  (scope.__canvasAgents ??= new Map());
const key = (id: string) => path.join(dataDir(), "agent", `${id}.json`);
function lock(id: string) {
  const k = key(id);
  if (!locks.has(k)) locks.set(k, { queue: Promise.resolve(), busy: false });
  return locks.get(k)!;
}
export function agentBusy(id: string) {
  return lock(id).busy;
}
export function acquireAgent(id: string) {
  const l = lock(id);
  if (l.busy)
    throw new AgentError("当前画布的 Agent 正在执行，请稍后继续", 409);
  l.busy = true;
  return () => {
    l.busy = false;
  };
}
async function readState(id: string): Promise<AgentState> {
  if (!isSafeCanvasId(id) || !(await loadCanvas(id)))
    throw new AgentError("画布不存在", 404);
  try {
    const p = JSON.parse(await readFile(key(id), "utf8")) as AgentState;
    ensureConversations(p);
    if (!agentBusy(id)) finalizeConversations(p);
    return p;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const now = new Date().toISOString();
  const state: AgentState = {
    id,
    canvasId: id,
    messages: [],
    conversations: [],
    activeConversationId: "",
    createdAt: now,
    updatedAt: now,
  };
  // Preserve old chat records as data; no retired project logic is loaded or executed.
  const legacy = path.join(dataDir(), "studio");
  for (const file of await readdir(legacy).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    try {
      const old = JSON.parse(await readFile(path.join(legacy, file), "utf8"));
      if (old.canvasId !== id) continue;
      state.conversations = old.conversations ?? [];
      state.messages = old.messages ?? [];
      state.activeConversationId = old.activeConversationId ?? "";
      for (const chat of state.conversations)
        chat.messages = chat.messages.map((m) => ({
          ...m,
          parts: m.parts.map((part) =>
            part.type.startsWith("tool-")
              ? {
                  type: "text" as const,
                  text: `历史工具记录：${part.type.slice(5)}\n\n\`\`\`json\n${JSON.stringify(part)}\n\`\`\``,
                }
              : part,
          ),
        }));
      if (!state.conversations.length)
        state.messages = state.messages.filter(
          (m) => !m.parts.some((p) => p.type.startsWith("tool-")),
        );
      break;
    } catch {
      /* Leave unreadable legacy data untouched. */
    }
  }
  ensureConversations(state);
  finalizeConversations(state);
  return state;
}
export function updateAgent(
  id: string,
  mutate: (state: AgentState) => void | Promise<void> = () => {},
): Promise<AgentState> {
  const l = lock(id),
    next = l.queue
      .catch(() => {})
      .then(async () => {
        const state = await readState(id);
        await mutate(state);
        state.updatedAt = new Date().toISOString();
        const file = key(id),
          tmp = `${file}.${crypto.randomUUID()}.tmp`;
        await mkdir(path.dirname(file), { recursive: true });
        try {
          await writeFile(tmp, JSON.stringify(state), "utf8");
          for (let attempt = 0; ; attempt++) {
            try {
              await rename(tmp, file);
              break;
            } catch (e) {
              if (
                attempt >= 4 ||
                !["EPERM", "EBUSY", "EACCES"].includes(
                  (e as NodeJS.ErrnoException).code ?? "",
                )
              )
                throw e;
              await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
            }
          }
        } finally {
          await unlink(tmp).catch(() => {});
        }
        return state;
      });
  l.queue = next;
  return next;
}
