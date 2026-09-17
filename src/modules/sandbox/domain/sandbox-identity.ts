/**
 * Sandbox identity domain (sandbox module; DEP-014).
 *
 * The DISPOSABLE sandbox identity lifecycle: a per-application identity
 * with a time-to-live that a developer establishes, inspects, and — when
 * expired or quota-exhausted — RESETS into a fresh successor. Reset
 * NEVER carries state forward: the successor is a fresh admission under
 * fresh budgets, and the lineage (supersedes/supersededBy) is auditable.
 *
 * This is NOT a second environment authority: the environment catalog
 * (WORK-012) owns persistent compute environments; this vocabulary owns
 * the disposable identity a sandbox session runs under — the
 * lifecycle dimension DEP-014 adds to the SAME module.
 *
 * Post-expiry reads return the record with its EXPIRED status — records
 * never silently disappear (the honest-expired-state contract).
 */

/** The sandbox identity lifecycle status vocabulary. */
export const SANDBOX_IDENTITY_STATUSES = ["active", "expired", "quota-exhausted", "reset"] as const;

export type SandboxIdentityStatus = (typeof SANDBOX_IDENTITY_STATUSES)[number];

export function isSandboxIdentityStatus(value: string): value is SandboxIdentityStatus {
  return (SANDBOX_IDENTITY_STATUSES as readonly string[]).includes(value);
}

/** One disposable sandbox identity record. */
export interface SandboxIdentityRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The environment the identity runs under (the catalog's record). */
  readonly environmentId: string | null;
  readonly status: SandboxIdentityStatus;
  readonly createdAt: string;
  /** The TTL deadline — expiry transitions are explicit ledger events. */
  readonly expiresAt: string;
  /** The successor identity when this one was reset (else null). */
  readonly supersededBy: string | null;
  /** The predecessor this identity replaced (else null). */
  readonly supersedes: string | null;
}

/** The default TTL for a disposable sandbox identity (ms). */
export const SANDBOX_IDENTITY_DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** Is the record past its TTL deadline at `now`? */
export function identityIsPastTtl(record: SandboxIdentityRecord, now: string): boolean {
  return Date.parse(now) >= Date.parse(record.expiresAt);
}

/**
 * The honest post-expiry read state: the SAME record with its expired
 * status — the record never disappears, the reader always learns why.
 */
export function expiredViewOf(record: SandboxIdentityRecord): SandboxIdentityRecord {
  return record.status === "active" ? { ...record, status: "expired" } : record;
}
