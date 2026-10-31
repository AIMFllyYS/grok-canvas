import { getLeaseService, LEASE_TTL_MS } from "./canvas-runtime/lease-service";

/**
 * 旧 content/prompt 编辑租约的兼容接口，统一由 lease-service 提供（TTL 4s）。
 * owner 已持有则续期；缺 token 的旧调用只能释放自己 owner 的租约。
 * 新代码应直接使用 lease-service 的 acquire/renew/release（带 token）。
 */
export const EDIT_LEASE_MS = LEASE_TTL_MS;

/** These helpers must be called while holding the corresponding canvas lock. */
export function claimEditLease(canvasId: string, nodeId: string, field: "content" | "prompt", owner: string): boolean {
  return getLeaseService().claimOrRenew(canvasId, nodeId, field, owner);
}
export function releaseEditLease(canvasId: string, nodeId: string, field: "content" | "prompt", owner: string): void {
  getLeaseService().release(canvasId, nodeId, field, owner);
}
export function editLeaseActive(canvasId: string, nodeId: string, field: "content" | "prompt"): boolean {
  return getLeaseService().holder(canvasId, nodeId, field) !== null;
}
