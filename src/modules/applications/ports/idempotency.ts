/**
 * Idempotency arbitration port (applications module outbound).
 *
 * Same semantics as the auth module's port (`spec/contracts.md` "Idempotency
 * response rule") but bound to this module's store type: the guarded work
 * receives a transaction-bound `ApplicationStore`, so the ledger row and the
 * operation's durable outcome commit atomically. Deliberately a separate
 * port rather than a shared abstraction: modules do not share application
 * code except through public contracts.
 */

import type { ApplicationStore } from "./application-store";

export interface IdempotencyScope {
  readonly actorId: string;
  readonly applicationId: string | null;
}

export interface IdempotencyArbitration<T> {
  readonly outcome: T;
  readonly replayed: boolean;
}

export interface IdempotencyPort {
  arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (txStore: ApplicationStore) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>>;
}

/** Canonical request fingerprint (deterministic JSON, sorted keys). */
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
