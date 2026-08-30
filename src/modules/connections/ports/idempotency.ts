/**
 * Idempotency arbitration port (connections module outbound).
 *
 * Same contract as the auth/applications ledgers (`spec/contracts.md`
 * "Idempotency response rule"): first request with a key stores fingerprint
 * + durable outcome in ONE transaction with the guarded writes; same key +
 * same fingerprint replays; same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent identical requests converge through
 * PostgreSQL uniqueness arbitration.
 *
 * The transaction scope for this module carries BOTH durable surfaces of a
 * connection mutation: the connection store and the credential vault
 * (rotation must swap the reference and destroy the old material atomically).
 */

import type { ConnectionStore } from "./connection-store";
import type { CredentialVault } from "./credential-vault";

export interface IdempotencyScope {
  readonly actorId: string;
  readonly applicationId: string;
}

export interface IdempotencyArbitration<T> {
  readonly outcome: T;
  readonly replayed: boolean;
}

/** Everything a guarded connection mutation may touch, bound to one transaction. */
export interface ConnectionTx {
  readonly store: ConnectionStore;
  readonly vault: CredentialVault;
}

export interface ConnectionsIdempotencyPort {
  arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ConnectionTx) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>>;
}
