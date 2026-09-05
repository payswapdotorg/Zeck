/**
 * Integration — THE EXECUTED RESTORE DRILL (WORK-043 / D-02,
 * acceptance criterion 8: "a real backup/restore procedure is
 * executed and demonstrates recovery of authoritative database
 * state; documentation alone is insufficient").
 *
 * The drill, against real PostgreSQL 16 through the PRODUCTION
 * adapter path:
 *
 *  1. SEED authoritative state through the REAL module services
 *     (`seedMediaWorld`: tenants, applications, environments,
 *     budgets/wallet, deployments, plans, executions) and complete a
 *     media job that ADOPTS an artifact (the write-once adoption
 *     ledger row with content digest + lineage);
 *  2. BACKUP: the port-based logical backup (per-table sha256
 *     checksums + the migration history);
 *  3. DESTROY the source database (terminate backends + DROP —
 *     simulated total loss; the dead source URL is then proven
 *     fail-closed);
 *  4. RESTORE into a fresh disposable target: deterministic
 *     migrations (the DDL authority) + data restore (ONE
 *     transaction, replication-role restore mode, sequences
 *     re-seeded) + self-verification (re-read, re-hash, compare);
 *  5. VERIFY the recovered authority: the adoption ledger row is
 *     byte-identical to the backup's row; referential integrity
 *     holds across the restored chain (artifact → job → deployment
 *     → application → tenant); the budget wallet balance matches
 *     exactly; and an identity-sequence-backed table serves NEW
 *     inserts without colliding with restored ids;
 *  6. CLEAN UP the disposable recovery target (and confirm it is
 *     gone).
 *
 * Skips with the exact reason when ZECK_PG_TEST_URL is absent
 * (honesty over silence — the local run is the recorded evidence).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "vitest";
import {
  createLogicalBackup,
  type LogicalBackup,
  restoreDataIntoCurrentState,
} from "../../../src/platform/db/backup";
import { startAuthoritativeDatabase } from "../../../src/platform/db/startup";
import { defineSuite } from "./define-suite";
import { pollToCompletion, seedMediaWorld, submitMediaJob } from "./media-world";

export const PG_TEST_URL = process.env.ZECK_PG_TEST_URL ?? "";

const AUTHORITATIVE_SCHEMAS = [
  "agents",
  "applications",
  "budgets",
  "capabilities",
  "connections",
  "deployments",
  "economics",
  "edge",
  "executions",
  "identity",
  "learning",
  "models",
  "platform",
  "sandbox",
  "tools",
  "verification",
] as const;

interface AuthoritativeFacts {
  readonly jobId: string;
  readonly tenantSlug: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly actorId: string;
  readonly artifactKey: string;
  readonly walletBalance: string;
  readonly maxEventSeq: number;
  readonly totalRows: number;
}

interface DrillContext {
  readonly adminUrl: string;
  readonly sourceDatabase: string;
  readonly sourceUrl: string;
  readonly backup: LogicalBackup;
  readonly facts: AuthoritativeFacts;
  readonly adoptedRowAsBackedUp: Record<string, unknown> | null;
}

async function createDatabase(adminUrl: string): Promise<string> {
  const name = `zeck_work043_drill_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return name;
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

defineSuite<DrillContext>(
  "the executed backup/restore drill (WORK-043 D-02 AC8)",
  PG_TEST_URL,
  (ctx) => {
    test("backup → total source loss → restore → verified recovery of the authoritative state", async () => {
      // ---- 3. the source database was DROPPED in setup: prove the loss.
      const dead = await startAuthoritativeDatabase(ctx.sourceUrl, {
        poolOverrides: { max: 1, connectionTimeoutMillis: 1500 },
      }).catch((error: unknown) => error);
      expect(dead).toBeInstanceOf(Error);

      // ---- 4. restore into a fresh disposable target.
      const targetDatabase = `zeck_work043_restore_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const targetUrl = `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${targetDatabase}`;
      const createAdmin = new Client({ connectionString: ctx.adminUrl });
      await createAdmin.connect();
      await createAdmin.query(`CREATE DATABASE ${targetDatabase}`);
      await createAdmin.end();

      const targetHandle = await startAuthoritativeDatabase(targetUrl, {
        poolOverrides: { max: 4 },
      });
      try {
        const outcome = await restoreDataIntoCurrentState(targetHandle.port, ctx.backup);

        // ---- 5a. self-verification: every table re-read + re-hashed + counted.
        expect(outcome.verification).toHaveLength(ctx.backup.tables.length);
        expect(outcome.verification.every((entry) => entry.verified)).toBe(true);
        expect(outcome.sequencesReseeded).toBeGreaterThanOrEqual(8);

        // ---- 5b. the adoption ledger row is byte-identical to the backup.
        const restored = await targetHandle.port.execute<Record<string, unknown>>({
          sql: "SELECT artifact_key, artifact_digest, parent_digests, role, job_id FROM deployments.media_artifacts WHERE job_id = $1",
          parameters: [ctx.facts.jobId],
        });
        expect(restored.rows).toHaveLength(1);
        const restoredRow = JSON.parse(JSON.stringify(restored.rows[0]));
        expect(ctx.adoptedRowAsBackedUp).not.toBeNull();
        const expected = ctx.adoptedRowAsBackedUp as Record<string, unknown>;
        for (const column of ["artifact_key", "artifact_digest", "role", "job_id"]) {
          expect(restoredRow[column]).toEqual(expected[column]);
        }
        expect(JSON.stringify(restoredRow.parent_digests)).toEqual(
          JSON.stringify(expected.parent_digests),
        );

        // ---- 5c. referential integrity across the restored chain.
        const chain = await targetHandle.port.execute<Record<string, unknown>>({
          sql: `SELECT a.artifact_key, j.generation_kind, d.slug AS deployment_slug,
app.slug AS application_slug, t.slug AS tenant_slug
FROM deployments.media_artifacts a
JOIN deployments.media_jobs j ON j.id = a.job_id
JOIN deployments.deployments d ON d.id = a.deployment_id
JOIN applications.applications app ON app.id = a.application_id AND app.tenant_id = a.tenant_id
JOIN applications.tenants t ON t.id = app.tenant_id
WHERE a.job_id = $1`,
          parameters: [ctx.facts.jobId],
        });
        expect(chain.rows).toHaveLength(1);
        expect(chain.rows[0]?.tenant_slug).toBe(ctx.facts.tenantSlug);
        expect(chain.rows[0]?.artifact_key).toBe(ctx.facts.artifactKey);
        // Every FK in the chain resolved (no orphaned authority).
        expect(chain.rows[0]?.application_slug).toMatch(/^[a-z0-9-]+$/);

        // ---- 5d. the budget wallet balance (authority) matches exactly.
        const wallet = await targetHandle.port.execute<{ balance: string }>({
          sql: "SELECT balance_micro_usd::text AS balance FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
          parameters: [ctx.facts.applicationId],
        });
        expect(wallet.rows[0]?.balance).toBe(ctx.facts.walletBalance);

        // ---- 5e. the total restored row count matches the backup.
        const restoredRows = outcome.tables.reduce((total, table) => total + table.rows, 0);
        expect(restoredRows).toBe(ctx.facts.totalRows);

        // ---- 5f. identity sequences serve NEW rows beyond the restored max.
        const inserted = await targetHandle.port.transaction(async (tx) => {
          const row = await tx.execute<{ event_seq: string }>({
            sql: `INSERT INTO deployments.deployment_events
(id, application_id, tenant_id, deployment_id, kind, actor_id, prior_plan_version, current_plan_version, idempotency_key, created_at)
VALUES ($6, $1, $2, $3, 'create', $4, NULL, 1, $5, now())
RETURNING event_seq`,
            parameters: [
              ctx.facts.applicationId,
              ctx.facts.tenantId,
              ctx.facts.deploymentId,
              ctx.facts.actorId,
              `drill-${randomUUID()}`,
              randomUUID(),
            ],
          });
          return Number(row.rows[0]?.event_seq ?? "0");
        });
        expect(inserted).toBeGreaterThan(ctx.facts.maxEventSeq);
      } finally {
        await targetHandle.close();
      }

      // ---- 6. cleanup of the disposable recovery resource.
      await dropDatabase(ctx.adminUrl, targetDatabase);
      const checkAdmin = new Client({ connectionString: ctx.adminUrl });
      await checkAdmin.connect();
      const stillThere = await checkAdmin.query<{ exists: boolean }>({
        text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        values: [targetDatabase],
      });
      await checkAdmin.end();
      expect(stillThere.rows[0]?.exists).toBe(false);
    });
  },
  async (adminUrl) => {
    // ---- 1-2. seed REAL authoritative state; back it up; drop the source.
    const sourceDatabase = await createDatabase(adminUrl);
    const sourceUrl = `${adminUrl.replace(/\/[^/]*$/, "")}/${sourceDatabase}`;
    const handle = await startAuthoritativeDatabase(sourceUrl, { poolOverrides: { max: 4 } });
    try {
      const world = await seedMediaWorld(handle.port);
      const submitted = await submitMediaJob(world, "drill-restore");
      const completed = await pollToCompletion(world.service, submitted.jobId, world.actor());
      if (completed === null || completed.status !== "completed") {
        throw new Error(
          `the drill seed job did not complete (status: ${completed?.status ?? "null"})`,
        );
      }

      // Authoritative facts BEFORE the loss.
      const adoption = await handle.port.execute<Record<string, unknown>>({
        sql: `SELECT a.artifact_key, a.artifact_digest, a.parent_digests, a.role, a.job_id,
a.application_id, a.tenant_id, a.deployment_id, a.created_by,
w.balance_micro_usd::text AS balance_micro_usd,
(SELECT max(e.event_seq) FROM deployments.deployment_events e WHERE e.application_id = a.application_id) AS max_event_seq
FROM deployments.media_artifacts a
LEFT JOIN budgets.wallets w ON w.application_id = a.application_id AND w.owner_kind = 'developer'
WHERE a.job_id = $1`,
        parameters: [submitted.jobId],
      });
      const adoptionRow = adoption.rows[0];
      if (adoptionRow === undefined) {
        throw new Error("the adoption ledger row is missing before the drill (seed defect)");
      }
      const tenant = await handle.port.execute<{ slug: string }>({
        sql: "SELECT slug FROM applications.tenants WHERE id = $1",
        parameters: [String(adoptionRow.tenant_id)],
      });

      // ---- 2. the backup (through the port, deterministic).
      const backup = await createLogicalBackup(handle.port, [...AUTHORITATIVE_SCHEMAS]);
      const mediaArtifactsBackup = backup.tables.find(
        (table) => table.schema === "deployments" && table.table === "media_artifacts",
      );
      const adoptedRowAsBackedUp =
        mediaArtifactsBackup?.rows.find((row) => row.job_id === submitted.jobId) ?? null;
      const totalRows = backup.tables.reduce((total, table) => total + table.rowCount, 0);

      const facts: AuthoritativeFacts = {
        jobId: submitted.jobId,
        tenantSlug: tenant.rows[0]?.slug ?? "missing",
        applicationId: String(adoptionRow.application_id),
        tenantId: String(adoptionRow.tenant_id),
        deploymentId: String(adoptionRow.deployment_id),
        actorId: String(adoptionRow.created_by),
        artifactKey: String(adoptionRow.artifact_key),
        walletBalance: String(adoptionRow.balance_micro_usd ?? "missing"),
        maxEventSeq: Number(adoptionRow.max_event_seq ?? "0"),
        totalRows,
      };

      // ---- 3. TOTAL SOURCE LOSS.
      await handle.close();
      await dropDatabase(adminUrl, sourceDatabase);
      return {
        context: { adminUrl, sourceDatabase, sourceUrl, backup, facts, adoptedRowAsBackedUp },
        cleanup: async () => {
          // Idempotent safety net if the test aborts before its own cleanup.
          await dropDatabase(adminUrl, sourceDatabase);
        },
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await dropDatabase(adminUrl, sourceDatabase);
      throw error;
    }
  },
);
