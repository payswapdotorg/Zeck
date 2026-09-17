/**
 * SQL adapter for disposable sandbox identities (sandbox module; DEP-014).
 *
 * Bridges `SandboxIdentityStore` to the platform `DatabasePort`. The
 * partial unique index on `supersedes` (migration 0034) is the physical
 * reset-idempotency backstop: a concurrent second reset insert fails at
 * the row level and the service converges on the existing successor.
 */

import type { DatabasePort } from "../../../platform/db/port";
import type { SandboxIdentityRecord } from "../domain/sandbox-identity";
import type {
  InsertSandboxIdentityInput,
  SandboxIdentityStore,
} from "../ports/sandbox-identity-store";

type Executor = Pick<DatabasePort, "execute">;

interface IdentityRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string | null;
  readonly status: SandboxIdentityRecord["status"];
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly superseded_by: string | null;
  readonly supersedes: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRecord(row: IdentityRow): SandboxIdentityRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    status: row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    supersededBy: row.superseded_by,
    supersedes: row.supersedes,
  };
}

const SELECT_COLUMNS = `id, application_id, tenant_id, environment_id, status, created_at, expires_at, superseded_by, supersedes`;

export function createSqlSandboxIdentityStore(db: Executor): SandboxIdentityStore {
  return {
    async insert(input: InsertSandboxIdentityInput) {
      const result = await db.execute<IdentityRow>({
        sql: `INSERT INTO sandbox.identities
           (id, application_id, tenant_id, environment_id, status, expires_at, supersedes)
         VALUES ($1, $2, $3, $4, 'active', $5, $6)
         RETURNING ${SELECT_COLUMNS}`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.environmentId,
          input.expiresAt,
          input.supersedes,
        ],
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("sandbox identity insert returned no row");
      }
      return toRecord(row);
    },
    async find(applicationId, identityId) {
      const result = await db.execute<IdentityRow>({
        sql: `SELECT ${SELECT_COLUMNS} FROM sandbox.identities
          WHERE application_id = $1 AND id = $2`,
        parameters: [applicationId, identityId],
      });
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
    async list(applicationId) {
      const result = await db.execute<IdentityRow>({
        sql: `SELECT ${SELECT_COLUMNS} FROM sandbox.identities
          WHERE application_id = $1 ORDER BY created_at DESC`,
        parameters: [applicationId],
      });
      return result.rows.map(toRecord);
    },
    async transitionStatus(applicationId, identityId, status, supersededBy) {
      const result = await db.execute<IdentityRow>({
        sql: `UPDATE sandbox.identities
            SET status = $3,
                superseded_by = COALESCE($4, superseded_by)
          WHERE application_id = $1 AND id = $2
        RETURNING ${SELECT_COLUMNS}`,
        parameters: [applicationId, identityId, status, supersededBy ?? null],
      });
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };
}
