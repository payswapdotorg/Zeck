/**
 * Credential store port (auth module outbound; DEP-011).
 *
 * Implemented by adapters (SQL over the platform `DatabasePort`, plus the
 * in-memory test double). The application layer depends on this interface
 * only — never on platform types (`IMPLEMENTATION.md` §3).
 *
 * The store row is the DURABLE shape: it carries the credential record's
 * metadata PLUS `secretReference` — an OPAQUE STRING HANDLE into the
 * platform secret store (a `zeck-secret://<environment>/<name>` reference).
 * The handle is not secret material (it names stored material; it is not
 * the material), but it never leaves the authority: the application
 * service projects every row to the metadata-only `CredentialRecord` before
 * it returns, so no route, wire shape, log line or console render path can
 * even name it. The projection is structural — `CredentialRecord` has no
 * field where a secret or a secret reference could appear.
 */

import type { CredentialRecord, CredentialStatus } from "../domain/credential";
import type { ApplicationRole } from "../domain/roles";

/** The durable row: the metadata-only record plus the opaque secret handle. */
export interface CredentialStoreRow {
  readonly id: string;
  readonly credentialId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly role: ApplicationRole;
  readonly status: CredentialStatus;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly supersededBy: string | null;
  /** Opaque secret-store handle. NEVER projected into a domain record. */
  readonly secretReference: string;
}

export interface InsertCredentialInput {
  readonly id: string;
  readonly credentialId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly role: ApplicationRole;
  readonly secretReference: string;
}

export interface RetireCredentialInput {
  readonly rotatedAt: string;
  readonly supersededBy: string;
}

export interface ListCredentialsFilter {
  readonly applicationId: string;
}

/**
 * The current-record lookup semantics: for one `credentialId`, the ACTIVE
 * record when one exists, else the most recent record by creation (the
 * idempotent-revocation convergence view).
 */
export type CurrentCredentialRow = CredentialStoreRow;

export interface CredentialStore {
  /**
   * Insert a credential record. The caller (the application service)
   * guarantees the lineage invariants: first issuance has
   * `id === credentialId` and status "active"; a rotation successor is a
   * NEW `id` under the SAME `credentialId`. The SQL schema enforces one
   * ACTIVE record per identity; the in-memory double mirrors it.
   */
  insertCredential(input: InsertCredentialInput): Promise<CredentialStoreRow>;

  /**
   * The current record of a credential identity REGARDLESS of application
   * scope: the service performs the cross-tenant guard itself
   * (`assertScopeCovers` + the application match), so a foreign identity is
   * REJECTED explicitly — never silently no-op'ed as "not found".
   */
  findCurrentByCredentialId(credentialId: string): Promise<CredentialStoreRow | null>;

  /**
   * Every record of one credential identity, newest first (lineage view).
   */
  listCredentialLineage(credentialId: string): Promise<readonly CredentialStoreRow[]>;

  /** Every record of an application (the metadata list the API projects). */
  listCredentials(filter: ListCredentialsFilter): Promise<readonly CredentialStoreRow[]>;

  /**
   * Retire a record (rotation): status -> "retired", `rotatedAt` and
   * `supersededBy` set. Returns the updated row, or null when the record
   * vanished.
   */
  retireCredential(
    recordId: string,
    input: RetireCredentialInput,
  ): Promise<CredentialStoreRow | null>;

  /**
   * Revoke a record: status -> "revoked", IMMEDIATE and IDEMPOTENT —
   * revoking an already-revoked record returns the row unchanged (the
   * durable outcome converged). Returns the row, or null when the record
   * does not exist.
   */
  revokeCredential(recordId: string): Promise<CredentialStoreRow | null>;
}

/**
 * The neutral secret-store port for credential material (auth module
 * outbound; DEP-011). The platform secret store's classification vocabulary
 * (`provider-credential` / `signing-key`) belongs to the platform; this
 * module's port stays provider-neutral and the ADAPTER applies the
 * classification. Application transport credentials are stored with the
 * platform's generic credential classification; the signing-key class
 * applies to signing credentials this order does not issue.
 *
 * WRITE-ONLY from the authority's perspective: the credential service never
 * resolves stored material back (there is no `resolve` on this port by
 * design — nothing in the credential lifecycle may read a secret back).
 */
export interface CredentialSecretStore {
  /** Store material write-only; return the opaque reference handle. */
  store(input: { readonly material: string; readonly description: string }): Promise<{
    readonly reference: string;
  }>;
}

/** Project a durable row to the metadata-only domain record (the ONLY projection). */
export function toCredentialRecord(row: CredentialStoreRow): CredentialRecord {
  return {
    id: row.id,
    credentialId: row.credentialId,
    applicationId: row.applicationId,
    tenantId: row.tenantId,
    label: row.label,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    supersededBy: row.supersededBy,
  };
}
