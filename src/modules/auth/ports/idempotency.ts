/**
 * Idempotency arbitration port (auth module outbound).
 *
 * Implements the `spec/contracts.md` "Idempotency response rule" for this
 * module's mutations: the first request with a key stores the fingerprint and
 * the durable outcome in ONE transaction with the guarded operation; a retry
 * with the same key and fingerprint replays the recorded outcome; the same
 * key with a different fingerprint fails `IDEMPOTENCY_KEY_REUSED`; concurrent
 * identical requests converge to one durable identity via PostgreSQL unique
 * indexes and transactional arbitration (the loser replays the winner's
 * outcome after it commits).
 */

import type { IdentityStore } from "./identity-store";

/** Identity of an idempotent operation (the contract's arbitration scope). */
export interface IdempotencyScope {
  /** The authenticated caller executing the operation. */
  readonly actorId: string;
  /**
   * The application the operation is scoped to, or null for pre-application
   * operations (tenant/application creation) where the caller is the scope.
   */
  readonly applicationId: string | null;
}

export interface IdempotencyArbitration<T> {
  readonly outcome: T;
  /** True when the recorded outcome of a previous request was replayed. */
  readonly replayed: boolean;
}

export interface IdempotencyPort {
  /**
   * Arbitrate and execute. When this call is the durable first, `work` runs
   * inside the ledger transaction with a transaction-bound store; on replay
   * `work` is NOT executed and the recorded outcome is returned. On any
   * error the whole transaction (ledger row + guarded writes) rolls back —
   * a crashed attempt leaves no partial state and is safe to retry.
   */
  arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (txStore: IdentityStore) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>>;
}

/**
 * Canonical request fingerprint input: deterministic JSON with sorted object
 * keys. Two requests are the same logical operation iff their canonical
 * forms are byte-equal.
 */
export function canonicalFingerprint(parts: readonly unknown[]): string {
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
