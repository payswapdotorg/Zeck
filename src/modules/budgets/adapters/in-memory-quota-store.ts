/**
 * In-memory quota store (budgets module adapter; DEP-014).
 *
 * The test double + in-memory composition. Rows key by
 * (application, dimension, identityId) — one live quota per key. The
 * consume operation is the atomic check-and-increment (single-JS-thread
 * atomicity; the SQL twin enforces it with a conditional UPDATE).
 */

import type { QuotaDimension, QuotaRecord, QuotaWindow } from "../domain/quota";
import type { ConsumeQuotaInput, QuotaStore, UpsertQuotaInput } from "../ports/quota-store";

interface Row {
  record: QuotaRecord;
}

export function createInMemoryQuotaStore(now: () => string): QuotaStore {
  const rows = new Map<string, Row>();
  const key = (
    applicationId: string,
    dimension: QuotaDimension,
    identityId: string | null,
  ): string => `${applicationId}|${dimension}|${identityId ?? "-"}`;
  const toRecord = (row: Row): QuotaRecord => ({ ...row.record });
  return {
    async upsert(input: UpsertQuotaInput) {
      const k = key(input.applicationId, input.dimension, input.identityId);
      const existing = rows.get(k);
      const record: QuotaRecord = {
        id: existing?.record.id ?? input.id,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        dimension: input.dimension,
        limit: input.limit,
        consumed: existing?.record.consumed ?? "0",
        window: input.window,
        status: existing?.record.status ?? "active",
        identityId: input.identityId,
        updatedAt: now(),
      };
      rows.set(k, { record });
      return toRecord({ record });
    },
    async list(applicationId, _tenantId) {
      return [...rows.values()]
        .filter((row) => row.record.applicationId === applicationId)
        .map(toRecord);
    },
    async consume(input: ConsumeQuotaInput) {
      const k = key(input.applicationId, input.dimension, input.identityId);
      const row = rows.get(k);
      if (row === undefined) {
        return null;
      }
      const { record } = row;
      const wouldExceed =
        !/^\d+$/.test(input.amount) ||
        BigInt(record.consumed) + BigInt(input.amount) > BigInt(record.limit);
      if (wouldExceed) {
        return null;
      }
      const consumed = (BigInt(record.consumed) + BigInt(input.amount)).toString();
      const next: QuotaRecord = {
        ...record,
        consumed,
        status: consumed === record.limit ? "exhausted" : "active",
        updatedAt: now(),
      };
      rows.set(k, { record: next });
      return toRecord({ record: next });
    },
    async release(input: ConsumeQuotaInput) {
      const k = key(input.applicationId, input.dimension, input.identityId);
      const row = rows.get(k);
      if (row === undefined) {
        return null;
      }
      const { record } = row;
      const amount = /^\d+$/.test(input.amount) ? BigInt(input.amount) : 0n;
      const consumed =
        BigInt(record.consumed) > amount ? (BigInt(record.consumed) - amount).toString() : "0";
      const next: QuotaRecord = {
        ...record,
        consumed,
        status: consumed === record.limit ? "exhausted" : "active",
        updatedAt: now(),
      };
      rows.set(k, { record: next });
      return toRecord({ record: next });
    },
  };
}

export type { QuotaWindow };
