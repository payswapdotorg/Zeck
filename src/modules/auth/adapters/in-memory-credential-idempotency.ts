/**
 * In-memory idempotency arbitration for the credential lifecycle (auth
 * module test double; DEP-011).
 *
 * The same durable contract as the SQL adapter (`platform.idempotency_records`,
 * migration 0001 — the operation names `credentials.*` distinguish the rows):
 * first request with a key stores fingerprint + durable outcome in one
 * atomic unit with the guarded writes; same key + same fingerprint replays
 * the outcome; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`.
 *
 * CONCURRENT DUPLICATES converge through per-key promise-queue
 * serialization — the in-memory stand-in for the SQL adapter's
 * unique-index arbitration (the economics in-memory pattern): two in-flight
 * calls with the same key totally order, the loser replays the winner's
 * committed outcome. True crash-atomicity (rollback) is a real-PostgreSQL
 * proof — there is no rollback here.
 *
 * The transaction handle carries the SAME store instance (the in-memory
 * store is single-threaded once a key's queue serializes the writes).
 */

import { PlatformError } from "../../../shared/errors";
import type {
  CredentialIdempotencyArbitration,
  CredentialIdempotencyPort,
  CredentialIdempotencyScope,
  CredentialTx,
} from "../ports/credential-idempotency";
import type { CredentialStore } from "../ports/credential-store";

interface LedgerRow {
  readonly scopeKey: string;
  readonly operationName: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  outcome: unknown;
}

export class InMemoryCredentialIdempotency implements CredentialIdempotencyPort {
  private readonly rows = new Map<string, LedgerRow>();
  /** Per-key serialization (stands in for the unique-index arbitration). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: CredentialStore) {}

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
    scope: CredentialIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: CredentialTx) => Promise<T>,
  ): Promise<CredentialIdempotencyArbitration<T>> {
    const scopeKey = `${scope.applicationId}`;
    const ledgerKey = `${scopeKey}:${operationName}:${idempotencyKey}`;
    return this.queue(ledgerKey, async () => {
      const existing = this.rows.get(ledgerKey);
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
      // The guarded work runs with the transaction-bound store; its return
      // value IS the durable outcome (metadata-only for credential
      // mutations — never secret material).
      const outcome = await work({ store: this.store });
      this.rows.set(ledgerKey, {
        scopeKey,
        operationName,
        idempotencyKey,
        requestFingerprint,
        outcome,
      });
      return { outcome, replayed: false };
    });
  }

  /** Test introspection: the recorded ledger keys. */
  ledgerKeys(): readonly string[] {
    return [...this.rows.keys()];
  }
}
