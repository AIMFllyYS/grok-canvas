import {
  OAUTH_PLAN,
  OAUTH_REFERRER,
  OAUTH_SCOPE,
  XAI_AUTHORIZATION_ENDPOINT,
  XAI_CLIENT_ID,
  XAI_DISCOVERY_URL,
  XAI_ISSUER,
  XAI_TOKEN_ENDPOINT,
} from "./constants";
import { pkceChallenge, randomOpaque } from "./pkce";
import { defaultAuthPath, loadAuth, saveAuth } from "./store";
import type { AuthFile, FetchLike, PendingOAuth } from "./types";

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
  message?: string;
};

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | "session_expired"
      | "state_mismatch"
      | "no_pending_session"
      | "token_exchange_failed"
      | "refresh_failed"
      | "relogin_required"
      | "tier_denied",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

function assertXaiEndpoint(name: string, endpoint: string): void {
  const url = new URL(endpoint);
  const host = url.hostname;
  if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`discovery ${name} must be an https *.x.ai URL, got ${endpoint}`);
  }
}

async function fetchDiscovery(fetchImpl: FetchLike): Promise<Discovery> {
  const fallback: Discovery = {
    authorization_endpoint: XAI_AUTHORIZATION_ENDPOINT,
    token_endpoint: XAI_TOKEN_ENDPOINT,
  };
  try {
    const response = await fetchImpl(XAI_DISCOVERY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return fallback;
    }
    const doc = (await response.json()) as Partial<Discovery> & { issuer?: string };
    if (
      doc.issuer !== XAI_ISSUER ||
      typeof doc.authorization_endpoint !== "string" ||
      typeof doc.token_endpoint !== "string"
    ) {
      return fallback;
    }
    assertXaiEndpoint("authorization_endpoint", doc.authorization_endpoint);
    assertXaiEndpoint("token_endpoint", doc.token_endpoint);
    return {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
    };
  } catch {
    return fallback;
  }
}

export async function beginLogin(options?: {
  fetch?: FetchLike;
  authPath?: string;
  redirectUri?: string;
}): Promise<{ authorizeUrl: string; redirectUri: string; state: string }> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const authPath = options?.authPath ?? defaultAuthPath();
  const auth = await loadAuth(authPath);
  const redirectUri = options?.redirectUri ?? auth.redirect_uri;
  const discovery = await fetchDiscovery(fetchImpl);

  const codeVerifier = randomOpaque(32);
  const pending: PendingOAuth = {
    state: randomOpaque(16),
    nonce: randomOpaque(16),
    code_verifier: codeVerifier,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    created_at: new Date().toISOString(),
  };

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", pending.code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("nonce", pending.nonce);
  url.searchParams.set("plan", OAUTH_PLAN);
  url.searchParams.set("referrer", OAUTH_REFERRER);

  auth.discovery = discovery;
  auth.redirect_uri = redirectUri;
  auth.pending_oauth = pending;
  auth.last_auth_error = null;
  await saveAuth(auth, authPath);

  return { authorizeUrl: url.toString(), redirectUri, state: pending.state };
}

function decodeIdToken(idToken: string | undefined): AuthFile["profile"] {
  if (!idToken) {
    return null;
  }
  const payload = idToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.sub === "string" ? { sub: claims.sub } : {}),
      ...(typeof claims.picture === "string" && claims.picture.length <= 4096 ? { picture: claims.picture } : {}),
    };
  } catch {
    return null;
  }
}

async function postTokenForm(
  fetchImpl: FetchLike,
  endpoint: string,
  form: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: TokenPayload }> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  let payload: TokenPayload = {};
  try {
    payload = (await response.json()) as TokenPayload;
  } catch {
    payload = {};
  }
  return { ok: response.ok, status: response.status, payload };
}

function describeTokenError(status: number, payload: TokenPayload): string {
  return (
    payload.error_description ??
    payload.message ??
    payload.error ??
    `token endpoint returned ${status}`
  );
}

function applyTokens(auth: AuthFile, payload: TokenPayload): void {
  if (typeof payload.access_token !== "string" || !payload.access_token.trim() ||
      (payload.refresh_token !== undefined && (typeof payload.refresh_token !== "string" || !payload.refresh_token.trim())) ||
      (payload.expires_in !== undefined && (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0)) ||
      (payload.token_type !== undefined && (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer"))) {
    throw new OAuthError("token_exchange_failed", "认证服务返回了无效令牌，请重新登录");
  }
  auth.tokens = {
    access_token: payload.access_token ?? auth.tokens.access_token ?? null,
    refresh_token: payload.refresh_token ?? auth.tokens.refresh_token ?? null,
    id_token: payload.id_token ?? auth.tokens.id_token ?? null,
    expires_in: payload.expires_in ?? 3600,
    token_type: payload.token_type ?? auth.tokens.token_type ?? "Bearer",
  };
  auth.last_refresh = new Date().toISOString();
  auth.last_auth_error = null;
  const profile = decodeIdToken(payload.id_token);
  if (profile) {
    auth.profile = profile;
  }
}

export async function completeLogin(input: {
  code: string;
  state: string | null;
  fetch?: FetchLike;
  authPath?: string;
}): Promise<AuthFile> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const authPath = input.authPath ?? defaultAuthPath();
  const auth = await loadAuth(authPath);
  const pending = auth.pending_oauth;
  if (!pending) {
    throw new OAuthError("no_pending_session", "no pending login; start again");
  }
  if (!Number.isFinite(Date.parse(pending.created_at)) || Date.now() - Date.parse(pending.created_at) > 10 * 60_000) {
    throw new OAuthError("session_expired", "登录已超时，请重新登录");
  }
  if (input.state !== pending.state) {
    throw new OAuthError("state_mismatch", "OAuth state does not match pending login");
  }

  // xAI may re-verify the challenge at exchange time, so send it alongside the verifier.
  const result = await postTokenForm(fetchImpl, auth.discovery.token_endpoint, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: pending.redirect_uri,
    client_id: XAI_CLIENT_ID,
    code_verifier: pending.code_verifier,
    code_challenge: pending.code_challenge,
    code_challenge_method: "S256",
  });

  const latest = await loadAuth(authPath);
  if (latest.pending_oauth?.state !== pending.state) {
    throw new OAuthError("no_pending_session", "登录已取消或已重新发起");
  }

  if (!result.ok || !result.payload.access_token) {
    const message = describeTokenError(result.status, result.payload);
    auth.last_auth_error = {
      code: "token_exchange_failed",
      message,
      relogin_required: true,
      at: new Date().toISOString(),
    };
    auth.pending_oauth = null;
    await saveAuth(auth, authPath);
    const lower = message.toLowerCase();
    if (result.status === 403 || lower.includes("entitlement") || lower.includes("tier")) {
      throw new OAuthError("tier_denied", message);
    }
    throw new OAuthError("token_exchange_failed", message);
  }

  auth.tokens = {};
  auth.profile = null;
  auth.session_id = crypto.randomUUID();
  applyTokens(auth, result.payload);
  auth.pending_oauth = null;
  await saveAuth(auth, authPath);
  return auth;
}

// Concurrent callers share one in-flight refresh: xAI rotates refresh tokens,
// so two parallel refreshes could invalidate each other and force a re-login.
let refreshInflight: Promise<AuthFile> | null = null;

export function refreshTokens(options?: {
  fetch?: FetchLike;
  authPath?: string;
}): Promise<AuthFile> {
  if (!refreshInflight) {
    refreshInflight = doRefreshTokens(options ?? {}).finally(() => {
      refreshInflight = null;
    });
  }
  return refreshInflight;
}

async function doRefreshTokens(options: {
  fetch?: FetchLike;
  authPath?: string;
}): Promise<AuthFile> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authPath = options.authPath ?? defaultAuthPath();
  const auth = await loadAuth(authPath);
  const refreshToken = auth.tokens.refresh_token?.trim();

  const fail = async (code: "relogin_required" | "refresh_failed" | "tier_denied", message: string) => {
    auth.last_auth_error = {
      code,
      message,
      relogin_required: code !== "refresh_failed",
      at: new Date().toISOString(),
    };
    await saveAuth(auth, authPath);
    throw new OAuthError(code, message);
  };

  if (!refreshToken) {
    return fail("relogin_required", "refresh token is missing");
  }

  const result = await postTokenForm(fetchImpl, auth.discovery.token_endpoint, {
    grant_type: "refresh_token",
    client_id: XAI_CLIENT_ID,
    refresh_token: refreshToken,
  });

  const latest = await loadAuth(authPath);
  if (latest.tokens.refresh_token?.trim() !== refreshToken || latest.session_id !== auth.session_id) {
    throw new OAuthError("relogin_required", "账户已退出或切换，已丢弃在途刷新结果");
  }
  Object.assign(auth, latest);

  if (!result.ok || !result.payload.access_token) {
    const message = describeTokenError(result.status, result.payload);
    const lower = `${result.payload.error ?? ""} ${message}`.toLowerCase();
    if (result.status === 403 || lower.includes("entitlement") || lower.includes("tier")) {
      return fail("tier_denied", message);
    }
    if (result.payload.error === "invalid_grant" || lower.includes("refresh token")) {
      return fail("relogin_required", message);
    }
    return fail("refresh_failed", message);
  }

  applyTokens(auth, result.payload);
  await saveAuth(auth, authPath);
  return auth;
}
