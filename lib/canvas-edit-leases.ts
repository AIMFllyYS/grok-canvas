import { dataDir } from "./data-dir";

type Lease = { owner: string; expiresAt: number };
const globals = globalThis as typeof globalThis & { __canvasEditLeases?: Map<string, Lease> };
const leases = globals.__canvasEditLeases ??= new Map();
const key = (canvasId: string, nodeId: string, field: string) => JSON.stringify([dataDir(), canvasId, nodeId, field]);
export const EDIT_LEASE_MS = 15_000;

/** These helpers must be called while holding the corresponding canvas lock. */
export function claimEditLease(canvasId: string, nodeId: string, field: "content" | "prompt", owner: string, now = Date.now()): boolean {
  const id = key(canvasId, nodeId, field), current = leases.get(id);
  if (current && current.expiresAt > now && current.owner !== owner) return false;
  leases.set(id, { owner, expiresAt: now + EDIT_LEASE_MS });
  return true;
}
export function releaseEditLease(canvasId: string, nodeId: string, field: "content" | "prompt", owner: string): void {
  const id = key(canvasId, nodeId, field);
  if (leases.get(id)?.owner === owner) leases.delete(id);
}
export function editLeaseActive(canvasId: string, nodeId: string, field: "content" | "prompt", now = Date.now()): boolean {
  const id = key(canvasId, nodeId, field), lease = leases.get(id);
  if (!lease) return false;
  if (lease.expiresAt <= now) { leases.delete(id); return false; }
  return true;
}
