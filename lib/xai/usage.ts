import { createHash } from "node:crypto";
import { authenticatedFetch, type ClientOptions } from "./client";
import { defaultAuthPath, isLoggedIn, loadAuth } from "./store";

export const USAGE_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export type UsageSnapshot = { status: "ready"; usedPercent: number | null; balanceCredits?: number; onDemandUsed?: number; onDemandCap?: number; resetAt: string | null; fetchedAt: string };
export class UsageError extends Error {
  kind: string;
  status: number;
  constructor(kind: string, message: string, status = 502) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const date = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function parseUsage(payload: unknown, now = Date.now()): UsageSnapshot {
  const config = record(record(payload).config);
  const percent = config.creditUsagePercent;
  if (percent === undefined && config.isUnifiedBillingUser === true) {
    const balance = record(config.prepaidBalance).val, used = record(config.onDemandUsed).val, cap = record(config.onDemandCap).val;
    if (typeof balance === "number" && Number.isFinite(balance) && balance >= 0) return {
      status: "ready", usedPercent: null, balanceCredits: balance,
      onDemandUsed: typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined,
      onDemandCap: typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : undefined,
      resetAt: date(record(config.currentPeriod).end) ?? date(config.billingPeriodEnd), fetchedAt: new Date(now).toISOString(),
    };
  }
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new UsageError("usage_unavailable", "上游暂未提供可识别的共享额度");
  }
  return { status: "ready", usedPercent: percent, resetAt: date(record(config.currentPeriod).end) ?? date(config.billingPeriodEnd), fetchedAt: new Date(now).toISOString() };
}

type UsageDependencies = { identity: () => Promise<string | null>; request: () => Promise<Response>; now?: () => number };
export function createUsageReader(deps: UsageDependencies) {
  let cached: { identity: string; value: UsageSnapshot; at: number } | null = null;
  let inFlight: { identity: string; promise: Promise<UsageSnapshot> } | null = null;
  return async (force = false): Promise<UsageSnapshot> => {
    const identity = await deps.identity();
    if (!identity) {
      cached = null;
      throw new UsageError("not_logged_in", "请登录后查看用量", 401);
    }
    const now = deps.now ?? Date.now;
    if (!force && cached?.identity === identity && now() - cached.at < 60_000) return cached.value;
    if (inFlight?.identity === identity) return inFlight.promise;
    const promise = (async () => {
      const response = await deps.request();
      if (!response.ok) {
        const status = response.status;
        throw new UsageError(status === 401 ? "auth_expired" : status === 403 ? "usage_unsupported" : status === 429 ? "rate_limited" : "usage_unavailable",
          status === 403 ? "当前账户暂不支持读取共享额度" : status === 401 ? "登录已过期，请重新登录" : status === 429 ? "查询过于频繁，请稍后再试" : "暂时无法读取共享额度", status >= 500 ? 502 : status);
      }
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new UsageError("usage_unavailable", "用量服务返回了无法识别的数据"); }
      const value = parseUsage(payload, now());
      if (await deps.identity() !== identity) throw new UsageError("account_changed", "账户已变化，请重新查看用量", 409);
      cached = { identity, value, at: now() };
      return value;
    })();
    inFlight = { identity, promise };
    try { return await promise; } finally { if (inFlight?.promise === promise) inFlight = null; }
  };
}

export function requestUsage(options: ClientOptions = {}) {
  return authenticatedFetch(USAGE_ENDPOINT, {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json", "x-xai-token-auth": "xai-grok-cli" },
  }, options);
}

// 指纹仅在服务端作为缓存键，既不输出到浏览器，也不写日志。
export const readAccountUsage = createUsageReader({
  identity: async () => {
    const auth = await loadAuth();
    if (!isLoggedIn(auth)) return null;
    return createHash("sha256").update(JSON.stringify([defaultAuthPath(), auth.session_id ?? auth.profile?.sub ?? auth.profile?.email ?? auth.tokens.refresh_token ?? auth.tokens.access_token])).digest("hex");
  },
  request: () => requestUsage(),
});
