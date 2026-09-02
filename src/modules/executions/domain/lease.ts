/**
 * Lease domain (executions module domain; WORK-028, LNG-002).
 *
 * THE single-owner lease of a live mutable execution: exactly ONE owner
 * is authoritative at a time. The lease is an EXTENSION table keyed by
 * the EXISTING execution identity (no second execution identity), and
 * every side-effecting operation of the long-running surface carries a
 * lease-validity guard derived here (fail closed — the Work Order's
 * explicit requirement: lease conflicts FAIL CLOSED, and stale workers
 * — expired, superseded or foreign-held leases — can never commit side
 * effects).
 *
 * The epoch scheme: epochs are MONOTONIC. Acquiring a free (released,
 * expired or absent) lease takes epoch = prior + 1; a stale worker's
 * (ownerId, epoch) pair can therefore never match the current lease
 * again — the same discipline as the WORK-024 realtime channel epoch.
 * Heartbeats (renewals) extend the expiry of the CURRENT epoch only;
 * `heartbeatCount` is the monotonic heartbeat ledger.
 *
 * Human authority trumps worker ownership: the governed human
 * interruption and termination paths force-release a LIVE lease (any
 * owner) with an explicit cause — recorded durably, never silent.
 */

import { PlatformError } from "../../../shared/errors";

/** The durable lease row (one row per execution, guarded transitions). */
export interface LeaseRecord {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The current (or last) owner identity of the lease. */
  readonly ownerId: string;
  /** Monotonic acquisition generation — stale owners never match again. */
  readonly epoch: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastHeartbeatAt: string;
  /** Monotonic heartbeat ledger (renewals of this epoch). */
  readonly heartbeatCount: number;
  readonly releasedAt: string | null;
  readonly releaseCause: string | null;
}

export type LeaseState = "held" | "expired" | "released";

/** Classify a lease row at a point in time. */
export function classifyLease(lease: LeaseRecord, at: string): LeaseState {
  if (lease.releasedAt !== null) {
    return "released";
  }
  return lease.expiresAt > at ? "held" : "expired";
}

/** The ownership claim a worker presents to commit side effects. */
export interface LeaseGuard {
  readonly ownerId: string;
  readonly epoch: number;
}

export type LeaseRejectionCode = "EXPIRED" | "INVALID_STATE_TRANSITION";

export interface LeaseRejection {
  readonly code: LeaseRejectionCode;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The lease-validity guard for side-effecting operations: returns the
 * typed rejection when this worker may NOT commit, or null when the
 * lease is live and owned by exactly this (ownerId, epoch). FAIL CLOSED
 * on every mismatch class:
 *   * no lease row / released  -> INVALID_STATE_TRANSITION (nothing held)
 *   * epoch mismatch           -> INVALID_STATE_TRANSITION (superseded — a
 *                                 NEWER worker owns the execution)
 *   * foreign owner            -> INVALID_STATE_TRANSITION (another live
 *                                 owner is authoritative)
 *   * expiry passed            -> EXPIRED (the stale-worker class)
 */
export function leaseGuardRejection(
  lease: LeaseRecord | null,
  guard: LeaseGuard,
  at: string,
): LeaseRejection | null {
  if (lease === null) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: "no execution lease is held; side effects require a live lease",
      details: { executionId: guard },
    };
  }
  if (lease.releasedAt !== null) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `the execution lease was released (${lease.releaseCause ?? "released"}); side effects require a live lease`,
      details: { ownerId: lease.ownerId, epoch: lease.epoch, releasedAt: lease.releasedAt },
    };
  }
  if (lease.epoch !== guard.epoch) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `lease epoch mismatch: the execution lease is at epoch ${lease.epoch}; a stale worker at epoch ${guard.epoch} is not authoritative`,
      details: { currentEpoch: lease.epoch, workerEpoch: guard.epoch, ownerId: lease.ownerId },
    };
  }
  if (lease.ownerId !== guard.ownerId) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `the execution lease is held by another owner (${lease.ownerId}); lease conflicts fail closed`,
      details: { leaseOwner: lease.ownerId, worker: guard.ownerId, epoch: lease.epoch },
    };
  }
  if (lease.expiresAt <= at) {
    return {
      code: "EXPIRED",
      reason: `the execution lease expired at ${lease.expiresAt}; stale workers cannot commit side effects`,
      details: { ownerId: lease.ownerId, epoch: lease.epoch, expiresAt: lease.expiresAt },
    };
  }
  return null;
}

/** Throw the typed PlatformError for a lease guard rejection. */
export function throwLeaseRejection(executionId: string, rejection: LeaseRejection): never {
  throw new PlatformError({
    code: rejection.code,
    message: rejection.reason,
    details: { ...rejection.details, executionId },
  });
}

/** The governed release causes (auditable vocabulary). */
export const LEASE_RELEASE_CAUSES = [
  "paused",
  "worker-released",
  "human-interruption",
  "terminated",
] as const;

export type LeaseReleaseCause = (typeof LEASE_RELEASE_CAUSES)[number];
