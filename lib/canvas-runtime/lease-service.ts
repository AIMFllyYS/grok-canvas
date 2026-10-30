/**
 * 字段租约（contracts.md C3）：键为 canvasId+nodeId+field，field ∈ geometry/content/prompt。
 * TTL 4000ms，客户端每 1000ms 续期；续期/释放必须 owner+token 同时匹配，旧 token 迟到不影响新租约。
 * 内存实现，跨路由 bundle 与 Agent 工具共享（globalThis，按数据目录隔离）；持久化由 P3-04 接管。
 * 只在服务端使用。
 */
import { dataDir } from "../data-dir";

export const LEASE_TTL_MS = 4_000;
export const LEASE_RENEW_MS = 1_000;
export const LEASE_FIELDS = ["geometry", "content", "prompt"] as const;
export type LeaseField = (typeof LEASE_FIELDS)[number];
export type LeaseRef = { nodeId: string; field: LeaseField };
export type LeaseConflict = LeaseRef & { owner: string; expiresAt: number };
type Lease = { owner: string; token: string; expiresAt: number };

export type AcquireResult = { ok: true; token: string; expiresAt: number } | { ok: false; holder: { owner: string; expiresAt: number } };

export function isLeaseField(value: unknown): value is LeaseField {
  return typeof value === "string" && (LEASE_FIELDS as readonly string[]).includes(value);
}

export function createLeaseService(options: { now?: () => number; ttlMs?: number; createToken?: () => string } = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? LEASE_TTL_MS;
  const createToken = options.createToken ?? (() => crypto.randomUUID());
  const leases = new Map<string, Lease>();
  const key = (canvasId: string, nodeId: string, field: LeaseField) => `${canvasId}\u0000${nodeId}\u0000${field}`;

  function active(canvasId: string, nodeId: string, field: LeaseField): Lease | null {
    const id = key(canvasId, nodeId, field);
    const lease = leases.get(id);
    if (!lease) return null;
    if (lease.expiresAt <= now()) { leases.delete(id); return null; }
    return lease;
  }

  return {
    /** 同一 owner 重新获取会换发新 token（旧 token 随之失效）。 */
    acquire(canvasId: string, nodeId: string, field: LeaseField, owner: string): AcquireResult {
      const current = active(canvasId, nodeId, field);
      if (current && current.owner !== owner) return { ok: false, holder: { owner: current.owner, expiresAt: current.expiresAt } };
      const lease = { owner, token: createToken(), expiresAt: now() + ttl };
      leases.set(key(canvasId, nodeId, field), lease);
      return { ok: true, token: lease.token, expiresAt: lease.expiresAt };
    },
    renew(canvasId: string, nodeId: string, field: LeaseField, owner: string, token: string): { ok: true; expiresAt: number } | { ok: false } {
      const current = active(canvasId, nodeId, field);
      if (!current || current.owner !== owner || current.token !== token) return { ok: false };
      current.expiresAt = now() + ttl;
      return { ok: true, expiresAt: current.expiresAt };
    },
    /** token 省略只用于旧客户端：仍要求 owner 匹配，不能释放其他 owner 的租约。重复释放无副作用。 */
    release(canvasId: string, nodeId: string, field: LeaseField, owner: string, token?: string): boolean {
      const current = active(canvasId, nodeId, field);
      if (!current || current.owner !== owner || (token !== undefined && current.token !== token)) return false;
      leases.delete(key(canvasId, nodeId, field));
      return true;
    },
    /** 旧接口：owner 已持有则续期（保留 token），否则获取。 */
    claimOrRenew(canvasId: string, nodeId: string, field: LeaseField, owner: string): boolean {
      const current = active(canvasId, nodeId, field);
      if (current && current.owner === owner) { current.expiresAt = now() + ttl; return true; }
      return this.acquire(canvasId, nodeId, field, owner).ok;
    },
    holder(canvasId: string, nodeId: string, field: LeaseField): { owner: string; expiresAt: number } | null {
      const lease = active(canvasId, nodeId, field);
      return lease ? { owner: lease.owner, expiresAt: lease.expiresAt } : null;
    },
    /** 命令事务内调用：列出被其他 owner 持有的字段。 */
    conflicts(canvasId: string, refs: Iterable<LeaseRef>, actor: string): LeaseConflict[] {
      const result: LeaseConflict[] = [];
      for (const ref of refs) {
        const lease = active(canvasId, ref.nodeId, ref.field);
        if (lease && lease.owner !== actor) result.push({ ...ref, owner: lease.owner, expiresAt: lease.expiresAt });
      }
      return result;
    },
    size: () => leases.size,
  };
}

export type LeaseService = ReturnType<typeof createLeaseService>;

const globals = globalThis as typeof globalThis & { __canvasLeaseServices?: Map<string, LeaseService> };
/** 进程级单例：API 路由 bundle 与 Agent 工具必须看到同一份租约。 */
export function getLeaseService(): LeaseService {
  const services = globals.__canvasLeaseServices ??= new Map();
  const scope = dataDir();
  let service = services.get(scope);
  if (!service) { service = createLeaseService(); services.set(scope, service); }
  return service;
}
