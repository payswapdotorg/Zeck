/**
 * SQL substrate store (capabilities module adapter; WORK-031).
 *
 * The durable implementation of the `SubstrateStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0013_substrate_federation.sql`). Physical invariants live in the
 * migration; this adapter converges like the WORK-011/023 SQL stores.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { ComputationalSubstrateRecord, SubstrateLifecycleStatus } from "../domain/substrate";
import type {
  SubstrateInsertInput,
  SubstrateInsertOutcome,
  SubstrateStatusInput,
  SubstrateStore,
} from "../ports/substrate-store";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

interface SubstrateRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly substrate_id: string;
  readonly version: string;
  readonly workload_classes: string[];
  readonly modalities: string[];
  readonly latency_class: string;
  readonly resource: ComputationalSubstrateRecord["resource"];
  readonly isolation: string;
  readonly side_effect_classes: string[];
  readonly execution_capability: ComputationalSubstrateRecord["executionCapability"];
  readonly adapter_ref: string;
  readonly description: string | null;
  readonly digest: string;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function toRecord(row: SubstrateRow): ComputationalSubstrateRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    substrateId: row.substrate_id,
    version: row.version,
    workloadClasses: row.workload_classes as ComputationalSubstrateRecord["workloadClasses"],
    modalities: row.modalities as ComputationalSubstrateRecord["modalities"],
    latencyClass: row.latency_class as ComputationalSubstrateRecord["latencyClass"],
    resource: row.resource,
    isolation: row.isolation as ComputationalSubstrateRecord["isolation"],
    sideEffectClasses: row.side_effect_classes as ComputationalSubstrateRecord["sideEffectClasses"],
    executionCapability: row.execution_capability,
    adapterRef: row.adapter_ref,
    description: row.description,
    digest: row.digest,
    status: row.status as SubstrateLifecycleStatus,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const COLUMNS = `id, application_id, tenant_id, substrate_id, version, workload_classes,
    modalities, latency_class, resource, isolation, side_effect_classes,
    execution_capability, adapter_ref, description, digest, status, created_by, created_at`;

export class SqlSubstrateStore implements SubstrateStore {
  constructor(private readonly db: DatabasePort) {}

  async insert(input: SubstrateInsertInput): Promise<SubstrateInsertOutcome> {
    const r = input.record;
    try {
      const result = await this.db.execute<SubstrateRow>({
        sql: `INSERT INTO capabilities.substrates (
    ${COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15, 'available', $16, $17)
RETURNING ${COLUMNS}`,
        parameters: [
          r.id,
          r.applicationId,
          r.tenantId,
          r.substrateId,
          r.version,
          JSON.stringify(r.workloadClasses),
          JSON.stringify(r.modalities),
          r.latencyClass,
          JSON.stringify(r.resource),
          r.isolation,
          JSON.stringify(r.sideEffectClasses),
          JSON.stringify(r.executionCapability),
          r.adapterRef,
          r.description,
          input.digest,
          r.createdBy,
          new Date().toISOString(),
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "published", record: toRecord(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.find(r.applicationId, r.substrateId, r.version);
        if (existing === null) {
          throw new PlatformError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "substrate insert arbitration failed but the committed row is unreadable",
          });
        }
        if (existing.digest !== input.digest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "substrate version already exists with a different body; substrate versions are immutable once published",
            details: { substrateId: r.substrateId, version: r.version },
          });
        }
        return { status: "converged", record: existing };
      }
      throw error;
    }
    throw new PlatformError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "substrate insert returned no row",
    });
  }

  async find(applicationId: string, substrateId: string, version: string) {
    const result = await this.db.execute<SubstrateRow>({
      sql: `SELECT ${COLUMNS} FROM capabilities.substrates
WHERE application_id = $1 AND substrate_id = $2 AND version = $3`,
      parameters: [applicationId, substrateId, version],
    });
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(applicationId: string) {
    const result = await this.db.execute<SubstrateRow>({
      sql: `SELECT ${COLUMNS} FROM capabilities.substrates
WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toRecord);
  }

  async listAvailableByWorkloadClass(applicationId: string, workloadClass: string) {
    const result = await this.db.execute<SubstrateRow>({
      sql: `SELECT ${COLUMNS} FROM capabilities.substrates
WHERE application_id = $1 AND status = 'available' AND workload_classes ? $2
ORDER BY created_at, id`,
      parameters: [applicationId, workloadClass],
    });
    return result.rows.map(toRecord);
  }

  async updateStatus(input: SubstrateStatusInput) {
    const updated = await this.db.execute<SubstrateRow>({
      sql: `UPDATE capabilities.substrates
SET status = $1
WHERE application_id = $2 AND substrate_id = $3 AND version = $4 AND status = $5
RETURNING ${COLUMNS}`,
      parameters: [input.to, input.applicationId, input.substrateId, input.version, input.from],
    });
    const row = updated.rows[0];
    if (row !== undefined) {
      return toRecord(row);
    }
    // First writer moved it (or the guard disagreed): converge when the
    // committed state already equals the target; fail closed otherwise.
    const current = await this.find(input.applicationId, input.substrateId, input.version);
    if (current !== null && current.status === input.to) {
      return current;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `substrate ${input.substrateId}@${input.version} guard disagreed (is ${current?.status ?? "unknown"}; expected ${input.from})`,
    });
  }
}
