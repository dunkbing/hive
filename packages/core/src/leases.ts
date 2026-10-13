import type { Lease, LeaseScope } from "./types.ts";

export const DEFAULT_LEASE_TTL_MS = 120_000;

/** Two scopes overlap if they share a path and their line ranges intersect. A missing range covers the whole file. */
export function scopesOverlap(a: LeaseScope, b: LeaseScope): boolean {
  if (a.path !== b.path) return false;
  if (a.startLine === undefined || b.startLine === undefined) return true;
  const aEnd = a.endLine ?? a.startLine;
  const bEnd = b.endLine ?? b.startLine;
  return a.startLine <= bEnd && b.startLine <= aEnd;
}

export function isActive(lease: Lease, now: number): boolean {
  return lease.expiresAt > now;
}

/** Returns the lease that blocks `agentId` from taking `scope`, if any. An agent never blocks itself. */
export function findBlockingLease(
  leases: Iterable<Lease>,
  scope: LeaseScope,
  agentId: string,
  now: number,
): Lease | undefined {
  for (const lease of leases) {
    if (lease.agentId === agentId || !isActive(lease, now)) continue;
    if (scopesOverlap(lease, scope)) return lease;
  }
  return undefined;
}

/** Returns true when `agentId` holds an active lease covering `scope`. */
export function holdsLease(leases: Iterable<Lease>, scope: LeaseScope, agentId: string, now: number): boolean {
  for (const lease of leases) {
    if (lease.agentId !== agentId || !isActive(lease, now) || lease.path !== scope.path) continue;
    if (lease.startLine === undefined) return true;
    if (scope.startLine === undefined) continue;
    const end = scope.endLine ?? scope.startLine;
    if (lease.startLine <= scope.startLine && end <= (lease.endLine ?? lease.startLine)) return true;
  }
  return false;
}
