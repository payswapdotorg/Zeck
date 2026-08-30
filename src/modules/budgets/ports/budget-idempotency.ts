/**
 * Idempotency arbitration port (budgets module outbound).
 *
 * Same durable contract as the auth/applications/connections ledgers
 * (`spec/contracts.md` "Idempotency response rule"): the first request
 * with a key stores fingerprint + durable outcome in ONE transaction with
 * the guarded writes; same key + same fingerprint replays the outcome;
 * same key + different fingerprint fails `IDEMPOTENCY_KEY_REUSED`;
 * concurrent identical requests converge through PostgreSQL uniqueness
 * arbitration (the loser replays the winner's committed outcome).
 *
 * The transaction scope carries the budget store: reservation, wallet and
 * ledger writes commit atomically with the ledger record — a crashed
 * attempt leaves no partial hold and is safe to retry (crash-atomicity).
 */

import type { BudgetStore } from "./budget-store";

export interface BudgetsIdempotencyScope {
  readonly actorId: string;
  readonly applicationId: string;
}

export interface BudgetsIdempotencyArbitration<T> {
  readonly outcome: T;
  readonly replayed: boolean;
}

/** Everything a guarded budgets mutation may touch, bound to one transaction. */
export interface BudgetTx {
  readonly store: BudgetStore;
}

export interface BudgetsIdempotencyPort {
  arbitrate<T>(
    scope: BudgetsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: BudgetTx) => Promise<T>,
  ): Promise<BudgetsIdempotencyArbitration<T>>;
}

/**
 * Canonical request fingerprint input: deterministic JSON with sorted object
 * keys. Two requests are the same logical operation iff their canonical
 * forms are byte-equal (same contract as the auth ledger).
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
