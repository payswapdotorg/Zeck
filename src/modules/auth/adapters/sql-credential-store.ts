/**
 * SQL adapter for the credential lifecycle (auth module; DEP-011).
 *
 * Bridges the module's `CredentialStore` and `CredentialIdempotencyPort` to
 * the provider-neutral platform `DatabasePort` — the same bridge as
 * `sql-identity-store.ts` (no driver/SDK import; the platform port is the
 * only database surface). The durable shape is migration 0033
 * (`identity.application_credentials`): one ACTIVE record per credential
 * identity (partial unique index), retirement/revoke transitions are
 * single-statement and idempotent-exact, and the ledger rows live in
 * `platform.idempotency_records` (migration 0001) under the
 * `credentials.*` operation names.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { CredentialStatus } from "../domain/credential";
import type { ApplicationRole } from "../domain/roles";
import type {
  CredentialIdempotencyArbitration,
  CredentialIdempotencyPort,
  CredentialIdempotencyScope,
  CredentialTx,
} from "../ports/credential-idempotency";
import type {
  CredentialStore,
  CredentialStoreRow,
  InsertCredentialInput,
  ListCredentialsFilter,
  RetireCredentialInput,
} from "../ports/credential-store";

type Executor = Pick<DatabasePort, "execute">;

/** First row or undefined (noUncheckedIndexedAccess-safe). */
function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

interface CredentialRow {
  readonly id: string;
  readonly credential_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly label: string;
  readonly role: ApplicationRole;
  readonly status: CredentialStatus;
  readonly created_at: Date | string;
  readonly rotated_at: Date | string | null;
  readonly superseded_by: string | null;
  readonly secret_reference: string;
}

interface LedgerRow {
  readonly durable_outcome: unknown;
}

function iso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRow(row: CredentialRow): CredentialStoreRow {
  return {
    id: row.id,
    credentialId: row.credential_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    label: row.label,
    role: row.role,
    status: row.status,
    createdAt: iso(row.created_at) ?? "",
    rotatedAt: iso(row.rotated_at),
    supersededBy: row.superseded_by,
    secretReference: row.secret_reference,
  };
}

const SELECT_COLUMNS = `id, credential_id, application_id, tenant_id, label, role, status,
       created_at, rotated_at, superseded_by, secret_reference`;

class SqlCredentialStore implements CredentialStore {
  constructor(private readonly exec: Executor) {}

  async insertCredential(input: InsertCredentialInput): Promise<CredentialStoreRow> {
    const inserted = await this.exec.execute<CredentialRow>({
      sql: `INSERT INTO identity.application_credentials
              (id, credential_id, application_id, tenant_id, label, role, status, secret_reference)
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
            RETURNING ${SELECT_COLUMNS}`,
      parameters: [
        input.id,
        input.credentialId,
        input.applicationId,
        input.tenantId,
        input.label,
        input.role,
        input.secretReference,
      ],
    });
    const row = first(inserted.rows);
    if (row === undefined) {
      // The partial unique index (one ACTIVE per identity) rejected the
      // insert: the service's arbitration domain guarantees this cannot
      // happen on the serialized path — surface it fail-closed.
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "credential insert returned no row (identity already has an active record)",
      });
    }
    return toRow(row);
  }

  async findCurrentByCredentialId(credentialId: string): Promise<CredentialStoreRow | null> {
    const found = await this.exec.execute<CredentialRow>({
      sql: `SELECT ${SELECT_COLUMNS}
            FROM identity.application_credentials
            WHERE credential_id = $1
            ORDER BY (status = 'active') DESC, created_at DESC, id DESC
            LIMIT 1`,
      parameters: [credentialId],
    });
    const row = first(found.rows);
    return row === undefined ? null : toRow(row);
  }

  async listCredentialLineage(credentialId: string): Promise<readonly CredentialStoreRow[]> {
    const found = await this.exec.execute<CredentialRow>({
      sql: `SELECT ${SELECT_COLUMNS}
            FROM identity.application_credentials
            WHERE credential_id = $1
            ORDER BY created_at DESC, id DESC`,
      parameters: [credentialId],
    });
    return found.rows.map(toRow);
  }

  async listCredentials(filter: ListCredentialsFilter): Promise<readonly CredentialStoreRow[]> {
    const found = await this.exec.execute<CredentialRow>({
      sql: `SELECT ${SELECT_COLUMNS}
            FROM identity.application_credentials
            WHERE application_id = $1
            ORDER BY created_at DESC, id DESC`,
      parameters: [filter.applicationId],
    });
    return found.rows.map(toRow);
  }

  async retireCredential(
    recordId: string,
    input: RetireCredentialInput,
  ): Promise<CredentialStoreRow | null> {
    const updated = await this.exec.execute<CredentialRow>({
      sql: `UPDATE identity.application_credentials
            SET status = 'retired', rotated_at = $2, superseded_by = $3
            WHERE id = $1
            RETURNING ${SELECT_COLUMNS}`,
      parameters: [recordId, input.rotatedAt, input.supersededBy],
    });
    const row = first(updated.rows);
    return row === undefined ? null : toRow(row);
  }

  async revokeCredential(recordId: string): Promise<CredentialStoreRow | null> {
    // Immediate + idempotent: revoking an already-revoked record returns
    // the row unchanged (the durable outcome converged); anything else
    // transitions in one statement.
    const updated = await this.exec.execute<CredentialRow>({
      sql: `UPDATE identity.application_credentials
            SET status = 'revoked'
            WHERE id = $1 AND status <> 'revoked'
            RETURNING ${SELECT_COLUMNS}`,
      parameters: [recordId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toRow(row);
    }
    const existing = await this.exec.execute<CredentialRow>({
      sql: `SELECT ${SELECT_COLUMNS}
            FROM identity.application_credentials
            WHERE id = $1`,
      parameters: [recordId],
    });
    const present = first(existing.rows);
    return present === undefined ? null : toRow(present);
  }
}

export class SqlCredentialIdempotency implements CredentialIdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: CredentialIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: CredentialTx) => Promise<T>,
  ): Promise<CredentialIdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      // Ledger insert and guarded work share this transaction: the recorded
      // row exists iff the operation's durable outcome exists (the same
      // crash-atomicity contract as the identity ledger).
      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO platform.idempotency_records
                (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
              VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
              ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
              DO NOTHING
              RETURNING id`,
        parameters: [
          this.generateId(),
          scope.actorId,
          scope.applicationId,
          operationName,
          idempotencyKey,
          requestFingerprint,
        ],
      });

      if (inserted.rows.length === 0) {
        // A previous request (committed, or committing concurrently — the
        // unique index arbitration makes this call wait for the winner)
        // already owns the key. Same fingerprint replays the durable
        // outcome; different fingerprint is key reuse.
        const existing = await tx.execute<LedgerRow & { request_fingerprint: string }>({
          sql: `SELECT durable_outcome, request_fingerprint FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [scope.applicationId, operationName, idempotencyKey],
        });
        const row = first(existing.rows);
        if (row === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "idempotency key conflict disappeared during arbitration",
          });
        }
        if (row.request_fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: row.durable_outcome as T, replayed: true };
      }

      const ledgerRow = first(inserted.rows);
      if (ledgerRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ledger insert returned no row",
        });
      }
      const outcome = await work({ store: new SqlCredentialStore(tx) });
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerRow.id],
      });
      return { outcome, replayed: false };
    });
  }
}

/**
 * Transaction-bound credential store: the same store the idempotency arbiter
 * passes into `work`, exposed for callers that drive explicit transaction
 * interleavings (the concurrency-boundary verification tests).
 */
export function createTxCredentialStore(exec: Pick<DatabasePort, "execute">): CredentialStore {
  return new SqlCredentialStore(exec);
}

export interface SqlCredentialModule {
  readonly store: CredentialStore;
  readonly idempotency: CredentialIdempotencyPort;
}

/** Compose the SQL-backed credential lifecycle over a platform `DatabasePort`. */
export function createSqlCredentialModule(
  db: DatabasePort,
  generateId: () => string,
): SqlCredentialModule {
  return {
    store: new SqlCredentialStore(db),
    idempotency: new SqlCredentialIdempotency(db, generateId),
  };
}
