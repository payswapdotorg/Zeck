/**
 * Credential idempotency arbitration port (auth module outbound; DEP-011).
 *
 * The same durable contract as the auth/applications/economics/budgets
 * ledgers (`spec/contracts.md` "Idempotency response rule"): the first
 * request with a key stores fingerprint + durable outcome in ONE
 * transaction with the guarded writes; same key + same fingerprint replays
 * the outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge through
 * per-key arbitration.
 *
 * THE SHOW-ONCE RULE RIDES THIS PORT'S SHAPE: the durable outcome a guarded
 * credential mutation returns is METADATA-ONLY (a `CredentialRecord`
 * projection — see `toCredentialRecord`). The issued secret is captured by
 * the service around the arbitration (inside the work closure, outside the
 * ledger row) so the ledger can never contain secret material and a replay
 * can never re-show it.
 *
 * The transaction scope carries the credential store: record inserts and
 * retirement/revoke transitions commit atomically with the idempotency
 * record (crash-atomicity — a crashed attempt leaves no partial state).
 */

import type { CredentialStore } from "./credential-store";

export interface CredentialIdempotencyScope {
  /** The authenticated caller executing the operation. */
  readonly actorId: string;
  /** The application the operation is scoped to (always scoped here). */
  readonly applicationId: string;
}

export interface CredentialIdempotencyArbitration<T> {
  readonly outcome: T;
  /** True when the recorded outcome of a previous request was replayed. */
  readonly replayed: boolean;
}

/** Everything a guarded credential mutation may touch, bound to one transaction. */
export interface CredentialTx {
  readonly store: CredentialStore;
}

export interface CredentialIdempotencyPort {
  /**
   * Arbitrate and execute. When this call is the durable first, `work` runs
   * inside the ledger transaction with a transaction-bound credential
   * store; on replay `work` is NOT executed and the recorded outcome is
   * returned. On any error the whole transaction rolls back.
   */
  arbitrate<T>(
    scope: CredentialIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: CredentialTx) => Promise<T>,
  ): Promise<CredentialIdempotencyArbitration<T>>;
}
