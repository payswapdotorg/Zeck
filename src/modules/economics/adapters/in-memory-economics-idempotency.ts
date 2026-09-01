/**
 * In-memory idempotency arbitration for the economics module (unit-test
 * substrate; WORK-032).
 *
 * The same durable contract as the SQL adapter (`platform.idempotency_records`,
 * migration 0001): first request with a key stores fingerprint + durable
 * outcome in one atomic unit with the guarded writes; same key + same
 * fingerprint replays the outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`.
 *
 * The transaction handle carries the SAME store instance (the in-memory
 * store is single-threaded; there is no rollback — crash-atomicity and
 * concurrent-duplicate convergence proofs live in the real-PostgreSQL
 * suites).
 */

import { PlatformError } from "../../../shared/errors";
import type {
  EconomicsIdempotencyArbitration,
  EconomicsIdempotencyPort,
  EconomicsIdempotencyScope,
  EconomicsTx,
} from "../ports/economic-idempotency";
import type { EconomicStore } from "../ports/economic-store";

interface LedgerRow {
  readonly scopeKey: string;
  readonly operationName: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  outcome: unknown;
}

export class InMemoryEconomicsIdempotency implements EconomicsIdempotencyPort {
  private readonly rows = new Map<string, LedgerRow>();

  constructor(private readonly store: EconomicStore) {}

  async arbitrate<T>(
    scope: EconomicsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: EconomicsTx) => Promise<T>,
  ): Promise<EconomicsIdempotencyArbitration<T>> {
    const scopeKey = `${scope.actorId}:${scope.applicationId}`;
    const key = `${scopeKey}:${operationName}:${idempotencyKey}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { operationName },
        });
      }
      return { outcome: existing.outcome as T, replayed: true };
    }
    const tx: EconomicsTx = { store: this.store };
    const outcome = await work(tx);
    this.rows.set(key, {
      scopeKey,
      operationName,
      idempotencyKey,
      requestFingerprint,
      outcome,
    });
    return { outcome, replayed: false };
  }
}
