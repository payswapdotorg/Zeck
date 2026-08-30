/**
 * SQL adapter for the connections module (WORK-003).
 *
 * Bridges `ConnectionStore` and the module `ConnectionsIdempotencyPort` to
 * the provider-neutral platform `DatabasePort`. No driver/SDK import happens
 * here — `pg` is owned by `src/platform/db/` per the SDK boundary table.
 *
 * The idempotency ledger reuses `platform.idempotency_records` (migration
 * 0001) with application-scoped arbitration keys — the same durable
 * arbitration contract as auth/applications (`spec/contracts.md` "Idempotency
 * response rule").
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  ConnectionDispatchFacts,
  ConnectionStatus,
  CredentialKind,
  StoredConnection,
} from "../domain/connection";
import type { RailSlug } from "../domain/rails";
import type { ConnectionStore, InsertConnectionInput } from "../ports/connection-store";
import type { CredentialVault } from "../ports/credential-vault";
import type {
  ConnectionsIdempotencyPort,
  ConnectionTx,
  IdempotencyArbitration,
  IdempotencyScope,
} from "../ports/idempotency";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

interface ConnectionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly rail: RailSlug;
  readonly label: string;
  readonly endpoint_url: string | null;
  readonly credential_kind: CredentialKind;
  readonly credential_ref: string | null;
  readonly status: ConnectionStatus;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const CONNECTION_COLUMNS =
  "id, application_id, tenant_id, rail, label, endpoint_url, credential_kind, credential_ref, status, created_at, updated_at";

function toConnection(row: ConnectionRow): StoredConnection {
  // Full internal row (with the opaque vault reference); the application
  // service strips the reference via toPublicConnection before any outcome
  // leaves the module (architecture-lock invariant 9).
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    rail: row.rail,
    label: row.label,
    endpointUrl: row.endpoint_url,
    credentialKind: row.credential_kind,
    credentialRef: row.credential_ref,
    status: row.status,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class SqlConnectionStore implements ConnectionStore {
  constructor(private readonly exec: Executor) {}

  async insertConnection(input: InsertConnectionInput): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `INSERT INTO connections.connections
  (id, application_id, tenant_id, rail, label, endpoint_url, credential_kind, credential_ref)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (application_id, tenant_id, label) DO NOTHING
RETURNING ${CONNECTION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.rail,
        input.label,
        input.endpointUrl,
        input.credentialKind,
        input.credentialRef,
      ],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async findConnection(id: string): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections WHERE id = $1`,
      parameters: [id],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async findConnectionByLabel(
    applicationId: string,
    tenantId: string,
    label: string,
  ): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections
WHERE application_id = $1 AND tenant_id = $2 AND label = $3`,
      parameters: [applicationId, tenantId, label],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async findDispatchFacts(id: string): Promise<ConnectionDispatchFacts | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections WHERE id = $1`,
      parameters: [id],
    });
    const row = first(result.rows);
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      applicationId: row.application_id,
      rail: row.rail,
      endpointUrl: row.endpoint_url,
      credentialKind: row.credential_kind,
      credentialRef: row.credential_ref,
      status: row.status,
    };
  }

  async listConnectionsByApplication(
    applicationId: string,
    tenantId: string,
  ): Promise<readonly StoredConnection[]> {
    // Tenant filter is part of the query itself (defense in depth), except
    // when the caller passes the empty wildcard to inspect collisions.
    const result =
      tenantId === ""
        ? await this.exec.execute<ConnectionRow>({
            sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections WHERE application_id = $1`,
            parameters: [applicationId],
          })
        : await this.exec.execute<ConnectionRow>({
            sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections WHERE application_id = $1 AND tenant_id = $2`,
            parameters: [applicationId, tenantId],
          });
    return result.rows.map(toConnection);
  }

  async lockConnection(id: string): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `SELECT ${CONNECTION_COLUMNS} FROM connections.connections WHERE id = $1 FOR UPDATE`,
      parameters: [id],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async updateStatus(id: string, status: ConnectionStatus): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `UPDATE connections.connections SET status = $2, updated_at = now()
WHERE id = $1 RETURNING ${CONNECTION_COLUMNS}`,
      parameters: [id, status],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async updateCredentialRef(id: string, credentialRef: string): Promise<StoredConnection | null> {
    const result = await this.exec.execute<ConnectionRow>({
      sql: `UPDATE connections.connections SET credential_ref = $2, updated_at = now()
WHERE id = $1 RETURNING ${CONNECTION_COLUMNS}`,
      parameters: [id, credentialRef],
    });
    const row = first(result.rows);
    return row === undefined ? null : toConnection(row);
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.exec.execute({
      sql: "DELETE FROM connections.connections WHERE id = $1",
      parameters: [id],
    });
    return result.rowCount > 0;
  }
}

interface LedgerRow {
  readonly durable_outcome: unknown;
}

/**
 * Transaction-bound idempotency arbitration over `platform.idempotency_records`
 * — the exact durable contract of the auth/applications ledgers (WORK-002):
 * the ledger row, the guarded writes and the durable outcome commit in ONE
 * transaction; concurrent identical requests converge through the partial
 * unique index arbitration (the loser replays the winner's committed outcome).
 */
export class SqlConnectionsIdempotency implements ConnectionsIdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly vaultFactory: (tx: Transaction) => CredentialVault,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: ConnectionTx) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      const txStore = new SqlConnectionStore(tx);
      const txVault = this.vaultFactory(tx);

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
      const outcome = await work({ store: txStore, vault: txVault });
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerRow.id],
      });
      return { outcome, replayed: false };
    });
  }
}

/** Factory: composition roots and tests. */
export function createSqlConnectionStore(db: DatabasePort): SqlConnectionStore {
  return new SqlConnectionStore(db);
}
