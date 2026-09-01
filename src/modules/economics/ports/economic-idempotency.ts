/**
 * Idempotency arbitration port (economics module outbound; WORK-032).
 *
 * The same durable contract as the auth/applications/connections/budgets
 * ledgers (`spec/contracts.md` "Idempotency response rule"): the first
 * request with a key stores fingerprint + durable outcome in ONE
 * transaction with the guarded writes; same key + same fingerprint
 * replays the outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge
 * through PostgreSQL uniqueness arbitration (the loser replays the
 * winner's committed outcome).
 *
 * The transaction scope carries the economic store: action/authorization/
 * settlement/event writes commit atomically with the idempotency record —
 * a crashed attempt leaves no partial state and is safe to retry
 * (crash-atomicity).
 */

import type { EconomicStore } from "./economic-store";

export interface EconomicsIdempotencyScope {
  readonly actorId: string;
  readonly applicationId: string;
}

export interface EconomicsIdempotencyArbitration<T> {
  readonly outcome: T;
  readonly replayed: boolean;
}

/** Everything a guarded economics mutation may touch, bound to one transaction. */
export interface EconomicsTx {
  readonly store: EconomicStore;
}

export interface EconomicsIdempotencyPort {
  arbitrate<T>(
    scope: EconomicsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: EconomicsTx) => Promise<T>,
  ): Promise<EconomicsIdempotencyArbitration<T>>;
}

/**
 * Canonical request fingerprint basis: deterministic JSON with sorted
 * object keys. Two requests are the same logical operation iff their
 * canonical forms are byte-equal (same contract as the auth ledger).
 *
 * MATERIAL ECONOMIC CONSTRAINTS PARTICIPATE: the service composes every
 * material constraint (recipient, amount bounds, currency, purpose,
 * expiry, scope identities, rail) into these parts — a mutated constraint
 * produces a different fingerprint, so replaying the same idempotency key
 * against it fails `IDEMPOTENCY_KEY_REUSED` (the fingerprint-bypass
 * discrimination red-records exactly this).
 */
export function canonicalEconomicFingerprint(parts: readonly unknown[]): string {
  return JSON.stringify(parts.map(canonicalize));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]);
  }
  return value;
}
