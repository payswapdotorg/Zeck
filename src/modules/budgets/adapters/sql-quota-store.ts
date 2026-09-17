/**
 * SQL adapter for sandbox quotas (budgets module; DEP-014).
 *
 * Bridges `QuotaStore` to the provider-neutral platform `DatabasePort`
 * (no driver import — the platform DB layer owns `pg`). Rows live in
 * `budgets.application_quotas` (migration 0034) keyed by
 * (application_id, dimension, identity_id) — one live quota per key.
 *
 * The consume operation is the atomic fail-closed check-and-increment:
 * a single conditional `UPDATE ... WHERE consumed + amount <= limit`
 * — the row-level serialization that makes enforcement race-free (the
 * same discipline as the wallet debit guard in sql-budget-store).
 */

import type { DatabasePort } from "../../../platform/db/port";
import type { QuotaDimension, QuotaRecord } from "../domain/quota";
import type { ConsumeQuotaInput, QuotaStore, UpsertQuotaInput } from "../ports/quota-store";

type Executor = Pick<DatabasePort, "execute">;

interface QuotaRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly dimension: QuotaDimension;
  readonly limit_value: string;
  readonly consumed: string;
  readonly window_kind: QuotaRecord["window"];
  readonly status: QuotaRecord["status"];
  readonly identity_id: string | null;
  readonly updated_at: Date | string;
}

function toRecord(row: QuotaRow): QuotaRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    dimension: row.dimension,
    limit: row.limit_value,
    consumed: row.consumed,
    window: row.window_kind,
    status: row.status,
    identityId: row.identity_id,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export function createSqlQuotaStore(db: Executor): QuotaStore {
  return {
    async upsert(input: UpsertQuotaInput) {
      const result = await db.execute<QuotaRow>({
        sql: `INSERT INTO budgets.application_quotas
           (id, application_id, tenant_id, dimension, limit_value, consumed, window_kind, status, identity_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, '0', $6, 'active', $7, now())
         ON CONFLICT (application_id, dimension, identity_id) DO UPDATE
           SET limit_value = EXCLUDED.limit_value,
               window_kind = EXCLUDED.window_kind,
               updated_at = now()
         RETURNING id, application_id, tenant_id, dimension, limit_value, consumed, window_kind, status, identity_id, updated_at`,
        parameters: [
          input.id,
          input.applicationId,
          input.tenantId,
          input.dimension,
          input.limit,
          input.window,
          input.identityId,
        ],
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("quota upsert returned no row");
      }
      return toRecord(row);
    },
    async list(applicationId, tenantId) {
      const result = await db.execute<QuotaRow>({
        sql: `SELECT id, application_id, tenant_id, dimension, limit_value, consumed, window_kind, status, identity_id, updated_at
           FROM budgets.application_quotas
          WHERE application_id = $1 AND tenant_id = $2
          ORDER BY dimension, identity_id NULLS FIRST`,
        parameters: [applicationId, tenantId],
      });
      return result.rows.map(toRecord);
    },
    async consume(input: ConsumeQuotaInput) {
      // The atomic fail-closed check-and-increment: the conditional
      // WHERE is the enforcement — a row that would exceed simply does
      // not update, and the caller reads that as the denial.
      const result = await db.execute<QuotaRow>({
        sql: `UPDATE budgets.application_quotas
            SET consumed = consumed + $3,
                status = CASE WHEN consumed + $3 = limit_value THEN 'exhausted' ELSE status END,
                updated_at = now()
          WHERE application_id = $1 AND dimension = $2
            AND identity_id IS NOT DISTINCT FROM $4
            AND consumed + $3 <= limit_value
        RETURNING id, application_id, tenant_id, dimension, limit_value, consumed, window_kind, status, identity_id, updated_at`,
        parameters: [input.applicationId, input.dimension, input.amount, input.identityId],
      });
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
    async release(input: ConsumeQuotaInput) {
      const result = await db.execute<QuotaRow>({
        sql: `UPDATE budgets.application_quotas
            SET consumed = CASE WHEN consumed > $3 THEN consumed - $3 ELSE 0 END,
                status = 'active',
                updated_at = now()
          WHERE application_id = $1 AND dimension = $2
            AND identity_id IS NOT DISTINCT FROM $4
        RETURNING id, application_id, tenant_id, dimension, limit_value, consumed, window_kind, status, identity_id, updated_at`,
        parameters: [input.applicationId, input.dimension, input.amount, input.identityId],
      });
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };
}
