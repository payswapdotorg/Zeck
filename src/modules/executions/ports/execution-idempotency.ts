/**
 * Idempotency arbitration port (executions module outbound; WORK-006).
 *
 * Same durable contract as the auth/applications/connections/budgets
 * ledgers (`spec/contracts.md` "Idempotency response rule" — API-003:
 * every mutating execution request supports idempotency): the first
 * request with a key stores fingerprint + durable outcome in ONE
 * transaction with the guarded writes; same key + same fingerprint replays
 * the outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge through
 * PostgreSQL uniqueness/transactional arbitration (the loser replays the
 * winner's committed outcome).
 */

export interface ExecutionsIdempotencyScope {
  readonly actorId: string;
  readonly applicationId: string;
}

export interface ExecutionsIdempotencyArbitration<T> {
  readonly outcome: T;
  readonly replayed: boolean;
}

/** Everything a guarded executions mutation may touch, bound to one transaction. */
export interface ExecutionsTx {
  readonly store: import("./execution-store").ExecutionStore;
}

export interface ExecutionsIdempotencyPort {
  arbitrate<T>(
    scope: ExecutionsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ExecutionsTx) => Promise<T>,
  ): Promise<ExecutionsIdempotencyArbitration<T>>;
}

/**
 * Canonical request fingerprint input: deterministic JSON with sorted object
 * keys (same contract as the auth/applications/connections/budgets ledgers;
 * kept module-local so the module stays dependency-light — WORK-004
 * precedent). Two requests are the same logical operation iff their
 * canonical forms are byte-equal.
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
