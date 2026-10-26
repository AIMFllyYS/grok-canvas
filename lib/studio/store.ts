import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../data-dir";
import { createCanvas } from "../canvas-store";
import { normalizeMessages, finalizeInterruptedMessages } from "./messages";
import { ensureConversations, finalizeConversations } from "./conversations";
import {
  DEFAULT_NEGATIVE,
  DEFAULT_STYLE,
  type StudioProject,
  type StudioSummary,
} from "./schema";

const directory = () => path.join(dataDir(), "studio");
// Route bundles and development reloads must share the same locks in this server.
const globals = globalThis as typeof globalThis & {
  __grokStudioQueues?: Map<string, Promise<unknown>>;
  __grokStudioBusy?: Set<string>;
};
const queues = (globals.__grokStudioQueues ??= new Map<
  string,
  Promise<unknown>
>());
const busy = (globals.__grokStudioBusy ??= new Set<string>());
export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function projectPath(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new StudioError("无效项目 ID");
  return path.join(directory(), `${id}.json`);
}
export async function loadProject(id: string): Promise<StudioProject> {
  try {
    const project = JSON.parse(
      await readFile(projectPath(id), "utf8"),
    ) as StudioProject;
    project.messages = (busy.has(id)?normalizeMessages:finalizeInterruptedMessages)(project.messages ?? [], project.id);
    ensureConversations(project);
    if (!busy.has(id)) finalizeConversations(project);
    return project;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new StudioError("导演台不存在", 404);
    throw error;
  }
}
export async function listProjects(): Promise<StudioSummary[]> {
  await mkdir(directory(), { recursive: true });
  const entries = await readdir(directory());
  const projects = await Promise.all(
    entries
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          const p = await loadProject(n.slice(0, -5));
          return {
            id: p.id,
            title: p.title,
            canvasId: p.canvasId,
            updatedAt: p.updatedAt,
            shotCount: p.shots.length,
            completed: p.shots.filter((s) => s.videoApproved).length,
          };
        } catch {
          return null;
        }
      }),
  );
  return projects
    .filter((p): p is StudioSummary => p !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function writeProject(project: StudioProject) {
  await mkdir(directory(), { recursive: true });
  const file = projectPath(project.id),
    temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(project), "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, file);
        break;
      } catch (error) {
        if (
          attempt >= 4 ||
          !["EPERM", "EBUSY", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function createProject(
  title = "未命名导演台",
): Promise<StudioProject> {
  const canvas = await createCanvas(),
    now = new Date().toISOString();
  const project: StudioProject = {
    version: 1,
    id: crypto.randomUUID(),
    canvasId: canvas.id,
    revision: 0,
    title,
    brief: "",
    aspect: "16:9",
    targetDuration: 30,
    style: DEFAULT_STYLE,
    negative: DEFAULT_NEGATIVE,
    script: "",
    logline: "",
    references: [],
    shots: [],
    sources: [],
    messages: [],
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  ensureConversations(project);
  await writeProject(project);
  return project;
}
export function updateProject(
  id: string,
  mutate: (project: StudioProject) => void | Promise<void>,
  expectedRevision?: number,
): Promise<StudioProject> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const p = await loadProject(id);
      if (expectedRevision !== undefined && p.revision !== expectedRevision)
        throw new StudioError("导演台已更新，请重新加载后编辑", 409);
      await mutate(p);
      p.revision++;
      p.updatedAt = new Date().toISOString();
      await writeProject(p);
      return p;
    });
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => {});
  return next;
}
/** Never duplicate a paid operation while the UI retries or another tab is active. */
export function acquireProduction(id: string) {
  if (busy.has(id))
    throw new StudioError("这个导演台正在制作中，请等待当前任务结束", 409);
  busy.add(id);
  return () => busy.delete(id);
}
export function isProducing(id: string) {
  return busy.has(id);
}
export async function logEvent(
  id: string,
  action: string,
  status: "running" | "done" | "error",
  detail: string,
) {
  await updateProject(id, (p) => {
    p.events = [
      ...p.events,
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        action,
        status,
        detail,
      },
    ].slice(-200);
  });
}
