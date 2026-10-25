import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  AUTH_MODE,
  AUTH_PROVIDER,
  DEFAULT_REDIRECT_URI,
  XAI_API_BASE_URL,
  XAI_AUTHORIZATION_ENDPOINT,
  XAI_TOKEN_ENDPOINT,
} from "./constants";
import type { AuthFile } from "./types";

export function defaultAuthPath(): string {
  return (
    process.env.GROK_CANVAS_AUTH_PATH ??
    path.join(os.homedir(), ".grok-canvas", "auth.json")
  );
}

export function emptyAuthFile(): AuthFile {
  return {
    version: 1,
    provider: AUTH_PROVIDER,
    auth_mode: AUTH_MODE,
    base_url: XAI_API_BASE_URL,
    tokens: {},
    discovery: {
      authorization_endpoint: XAI_AUTHORIZATION_ENDPOINT,
      token_endpoint: XAI_TOKEN_ENDPOINT,
    },
    redirect_uri: process.env.XAI_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    last_refresh: null,
    last_auth_error: null,
    pending_oauth: null,
    profile: null,
  };
}

export async function loadAuth(authPath = defaultAuthPath()): Promise<AuthFile> {
  try {
    const raw = await readFile(authPath, "utf8");
    return { ...emptyAuthFile(), ...(JSON.parse(raw) as Partial<AuthFile>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyAuthFile();
    }
    throw error;
  }
}

export async function saveAuth(
  auth: AuthFile,
  authPath = defaultAuthPath(),
): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true });
  const temporary = `${authPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, authPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function isLoggedIn(auth: AuthFile): boolean {
  const hasToken = Boolean(
    auth.tokens.access_token?.trim() || auth.tokens.refresh_token?.trim(),
  );
  return hasToken && auth.last_auth_error?.relogin_required !== true;
}

export async function clearAuth(authPath = defaultAuthPath()): Promise<void> {
  const auth = await loadAuth(authPath);
  auth.tokens = {};
  delete auth.session_id;
  auth.last_auth_error = null;
  auth.pending_oauth = null;
  auth.profile = null;
  await saveAuth(auth, authPath);
}
