/**
 * Shared real-PostgreSQL fixture for the audit suites (WORK-059).
 *
 * Seeds a tenant + application (the audit tables FK into
 * `applications.applications` through composite tenant keys) and wires
 * the REAL SQL audit store over the provider-neutral DatabasePort —
 * the same fabric the production composition root assembles.
 */

import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import { SqlAuditStore } from "../../../src/modules/audit/adapters/sql-audit-store";
import {
  createAuditService,
  createComplianceExportService,
  createLegalHoldService,
  createRetentionService,
} from "../../../src/modules/audit/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const OPERATOR_ID = "00000000-0000-7000-8000-0000000000op";

export interface AuditWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly store: SqlAuditStore;
  readonly audit: ReturnType<typeof createAuditService>;
  readonly holds: ReturnType<typeof createLegalHoldService>;
  readonly retention: ReturnType<typeof createRetentionService>;
  readonly exports: ReturnType<typeof createComplianceExportService>;
  /** Mutate the shared clock (expiry semantics need time travel). */
  advanceTo: (iso: string) => void;
  now: () => Date;
}

export async function seedAuditWorld(db: DatabasePort): Promise<AuditWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "audit tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "audit app"],
  });

  const digest = createAuditNodeDigest();
  let clock = new Date("2026-09-20T12:00:00.000Z");
  const now = () => clock;
  const store = new SqlAuditStore(db, digest, now);
  return {
    db,
    tenantId,
    applicationId,
    store,
    audit: createAuditService({ store, digest }),
    holds: createLegalHoldService({ holds: store }),
    retention: createRetentionService({ policies: store, records: store, now }),
    exports: createComplianceExportService({ store, digest, now }),
    advanceTo: (iso: string) => {
      clock = new Date(iso);
    },
    now,
  };
}

export const T0 = "2026-09-20T12:00:00.000Z";
export const T1 = "2026-09-21T12:00:00.000Z";
export const T2 = "2026-09-22T12:00:00.000Z";
