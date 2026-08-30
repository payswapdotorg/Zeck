/**
 * Connection store port (connections module outbound).
 *
 * Implemented by adapters (SQL over the platform `DatabasePort`). Inner
 * layers depend on this interface only — never on platform types
 * (`IMPLEMENTATION.md` §3).
 */

import type {
  ConnectionDispatchFacts,
  ConnectionRecord,
  ConnectionStatus,
  CredentialKind,
  StoredConnection,
} from "../domain/connection";
import type { RailSlug } from "../domain/rails";

export interface InsertConnectionInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly rail: RailSlug;
  readonly label: string;
  readonly endpointUrl: string | null;
  readonly credentialKind: CredentialKind;
  readonly credentialRef: string | null;
}

export interface ConnectionStore {
  /**
   * Insert a connection; returns null when the (application, tenant, label)
   * uniqueness key already exists (the caller converges or rejects).
   */
  insertConnection(input: InsertConnectionInput): Promise<StoredConnection | null>;

  /** Fetch by id WITHOUT tenant filtering (cross-tenant guard is caller-side). */
  findConnection(id: string): Promise<StoredConnection | null>;

  /** Fetch by the uniqueness key (application, tenant, label). */
  findConnectionByLabel(
    applicationId: string,
    tenantId: string,
    label: string,
  ): Promise<StoredConnection | null>;

  /** The dispatch facts of a connection, read together with its credential reference. */
  findDispatchFacts(id: string): Promise<ConnectionDispatchFacts | null>;

  /** Connections of one application (tenant filter is caller-side, defense in depth kept). */
  listConnectionsByApplication(
    applicationId: string,
    tenantId: string,
  ): Promise<readonly StoredConnection[]>;

  /**
   * Serialization boundary for connection mutations whose decision depends
   * on row state (status changes, credential rotation, removal).
   *
   * Locks the connection row for the remainder of the enclosing transaction
   * (SQL: `SELECT ... FOR UPDATE`) and returns the row as committed at lock
   * acquisition. Concurrent rotate/disable/remove of the SAME connection
   * totally order; a vanished row returns null (converge, never guess).
   *
   * MUST be called inside the arbitration transaction (the tx-bound store
   * provides it). This is the WORK-002 discipline applied to this module:
   * every state-derived mutation decision is derived under the lock.
   */
  lockConnection(id: string): Promise<StoredConnection | null>;

  updateStatus(id: string, status: ConnectionStatus): Promise<StoredConnection | null>;

  /** Swap the credential reference (rotation). Returns the updated record or null. */
  updateCredentialRef(id: string, credentialRef: string): Promise<StoredConnection | null>;

  /** Delete the connection row. Returns true when a row was deleted. */
  deleteConnection(id: string): Promise<boolean>;
}

export type { ConnectionRecord, StoredConnection };
