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
 * CONCURRENT DUPLICATES converge through per-key promise-queue
 * serialization — the in-memory stand-in for the SQL adapter's
 * unique-index arbitration (the WORK-002..006 discipline; the same
 * pattern as the tools in-memory store): two in-flight calls with the
 * same key totally order, the loser replays the winner's committed
 * outcome. True crash-atomicity (rollback) is still a real-PostgreSQL
 * proof — there is no rollback here.
 *
 * The transaction handle carries the SAME store instance (the in-memory
 * store is single-threaded once a key's queue serializes the writes).
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
  /** Per-key serialization (stands in for the unique-index arbitration). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: EconomicStore) {}

  private queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  arbitrate<T>(
    scope: EconomicsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: EconomicsTx) => Promise<T>,
  ): Promise<EconomicsIdempotencyArbitration<T>> {
    const scopeKey = `${scope.actorId}:${scope.applicationId}`;
    const key = `${scopeKey}:${operationName}:${idempotencyKey}`;
    return this.queue(key, async () => {
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
    });
  }
}
