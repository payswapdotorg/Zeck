/**
 * Integration — THE EXECUTED AUTHORITY-RESTORE DRILL (WORK-048 / D-07,
 * acceptance criterion 1: "Authoritative PostgreSQL state can be
 * restored from repository-defined backup/restore procedures and
 * verified against expected invariants").
 *
 * This is the D-07 drill over the WORK-043 restore engine — the SAFE
 * OPERATOR FORM `deploy:drill authority-loss` runs: the live source is
 * NEVER touched; recovery is proven against a FRESH DISPOSABLE target.
 * The D-07 additions under test:
 *
 *   1. BACKUP the live authoritative state (seeded through the REAL
 *      module services — the WORK-043 media world) with per-table
 *      sha256 checksums + the migration history;
 *   2. RESTORE into a fresh disposable target through the production
 *      startup + restore path (deterministic migrations + one-
 *      transaction data restore + read-back self-verification);
 *   3. THE D-07 AUTHORITY-INVARIANT GATE (`verifyRecoveredAuthority`):
 *      migration history, frozen state vocabularies, gapless event
 *      ledgers, the consumed⇒applied transport boundary, the single
 *      live claim invariant, budget non-negativity, adoption-ledger
 *      digest shape and chain resolution — the gate that must pass
 *      BEFORE any environment may be declared recovered;
 *   4. THE DRILL RUNNER wraps the same procedure as timed, verified
 *      phases (`runRecoveryDrill`) and evaluates the measured
 *      RTO/RPO against the repository target (local: 900s/0ms —
 *      `deploy/manifests/recovery-targets.json`).
 *
 * DISCRIMINATION (the Work Order's mutation requirements):
 *
 *   D-a an INCOMPLETE restore (a truncated event ledger) FAILS the
 *       gapless-sequence check — never silently accepted;
 *   D-b CORRUPTED state (an execution outside the frozen vocabulary,
 *       a negative budget wallet) FAILS the vocabulary/budget checks;
 *   D-c CHECKSUM DRIFT in the backup artifact itself FAILS the
 *       restore self-verification (a tampered backup never restores);
 *   D-d an UNVERIFIED recovery NEVER declares the environment
 *       recovered: the drill records `recovered: false`, RTO is
 *       unmeasured (null), the objective evaluation reports breaches,
 *       and the phases after the failure DO NOT RUN (fail-closed
 *       ordering — replay never runs on top of a broken restore).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { EXECUTION_STATES } from "../../../src/modules/executions/public";
import {
  createLogicalBackup,
  type LogicalBackup,
  restoreDataIntoCurrentState,
} from "../../../src/platform/db/backup";
import {
  authoritativeSchemas,
  shippedMigrations,
  startAuthoritativeDatabase,
  verifySchemaConvergence,
} from "../../../src/platform/db/startup";
import { verifyRecoveredAuthority } from "../../../src/platform/recovery/authority-verification";
import { runRecoveryDrill } from "../../../src/platform/recovery/drill";
import {
  evaluateDrillAgainstTarget,
  parseRecoveryTargets,
} from "../../../src/platform/recovery/rto-rpo";
import { defineSuite } from "./define-suite";
import { pollToCompletion, seedMediaWorld, submitMediaJob } from "./media-world";

export const PG_TEST_URL = process.env.ZECK_PG_TEST_URL ?? "";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RECOVERY_TARGETS = parseRecoveryTargets(
  readFileSync(resolve(REPO_ROOT, "deploy/manifests/recovery-targets.json"), "utf8"),
);
const LOCAL_TARGET = RECOVERY_TARGETS.targets.local;

interface DrillContext {
  readonly adminUrl: string;
  readonly sourceUrl: string;
  readonly sourceDatabase: string;
  readonly backup: LogicalBackup;
  /** [loss instant, last consistent point] — the backup creation instant. */
  readonly lossAt: Date;
}

async function createDatabase(adminUrl: string): Promise<string> {
  const name = `zeck_work048_restore_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
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

/**
 * The corruption simulation session: `session_replication_role =
 * replica` disables the live write guards (append-only triggers,
 * CHECK constraints) exactly as the RESTORE engine itself does —
 * this is how a genuinely corrupted/incomplete restored database
 * LOOKS to the invariant gate (the guards protect live mutations,
 * not recovery verification). The drill proves the GATE catches
 * what the guards cannot.
 */
async function tamperSession(
  targetUrl: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await work(client);
  } finally {
    await client.end();
  }
}

defineSuite<DrillContext>(
  "the executed authority-restore drill (WORK-048 D-07 AC1)",
  PG_TEST_URL,
  (ctx) => {
    test("backup → fresh-target restore → D-07 invariant gate → drill recovered with measured RTO/RPO within the local target", async () => {
      const targetDatabase = await createDatabase(ctx.adminUrl);
      const targetUrl = `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${targetDatabase}`;
      let restoreOutcome: Awaited<ReturnType<typeof restoreDataIntoCurrentState>> | null = null;

      // The drill: timed, verified phases over the REAL procedure —
      // exactly the `deploy:drill authority-loss` composition.
      const drill = await runRecoveryDrill(
        {
          scenarioId: "authority-loss",
          environment: "local",
          revision: "work048-integration",
          lossAt: ctx.lossAt,
          lastConsistentPointAt: ctx.lossAt,
          phases: [
            {
              name: "authority-restore",
              description: "migrations + one-transaction data restore into the disposable target",
              action: async () => {
                const handle = await startAuthoritativeDatabase(targetUrl, {
                  poolOverrides: { max: 4 },
                });
                try {
                  restoreOutcome = await restoreDataIntoCurrentState(handle.port, ctx.backup);
                  if (!restoreOutcome.verification.every((entry) => entry.verified)) {
                    throw new Error("restore self-verification failed (checksum drift detected)");
                  }
                } finally {
                  await handle.close();
                }
              },
            },
            {
              name: "authority-invariants",
              description: "the D-07 recovered-authority invariant gate",
              action: async () => {
                const handle = await startAuthoritativeDatabase(targetUrl, {
                  poolOverrides: { max: 4 },
                });
                try {
                  const report = await verifyRecoveredAuthority(handle.port, {
                    executionStatusVocabulary: EXECUTION_STATES,
                    expectedMigrationCount: shippedMigrations().length,
                  });
                  if (!report.verified) {
                    throw new Error(
                      `recovered-authority invariant violations: ${report.violations
                        .map((violation) => `${violation.check}: ${violation.detail}`)
                        .join("; ")}`,
                    );
                  }
                } finally {
                  await handle.close();
                }
              },
            },
          ],
        },
        { now: () => new Date() },
      );

      // The recovered declaration — ONLY through verified phases.
      expect(drill.recovered).toBe(true);
      expect(drill.phases.map((phase) => phase.name)).toEqual([
        "authority-restore",
        "authority-invariants",
      ]);
      expect(drill.phases.every((phase) => phase.ok)).toBe(true);
      expect(restoreOutcome?.verification.every((entry) => entry.verified)).toBe(true);
      expect(restoreOutcome?.tables.length).toBe(ctx.backup.tables.length);

      // Measured objectives against the repository target (local).
      expect(drill.rtoMs).not.toBeNull();
      expect(drill.rtoMs as number).toBeGreaterThanOrEqual(0);
      expect(drill.rpoMs).toBe(0); // the loss anchor IS the recovery point
      const evaluation = evaluateDrillAgainstTarget(drill, LOCAL_TARGET);
      expect(evaluation.breaches).toEqual([]);
      expect(evaluation.rtoWithinTarget).toBe(true);
      expect(evaluation.rpoWithinTarget).toBe(true);

      await dropDatabase(ctx.adminUrl, targetDatabase);
    });

    test("discrimination D-a/D-b: incomplete (gapped ledger) and corrupted (out-of-vocabulary status, negative wallet) restores FAIL the invariant gate", async () => {
      const targetDatabase = await createDatabase(ctx.adminUrl);
      const targetUrl = `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${targetDatabase}`;
      const handle = await startAuthoritativeDatabase(targetUrl, { poolOverrides: { max: 4 } });
      try {
        const outcome = await restoreDataIntoCurrentState(handle.port, ctx.backup);
        expect(outcome.verification.every((entry) => entry.verified)).toBe(true);

        // A clean restore verifies BEFORE the tamper.
        const clean = await verifyRecoveredAuthority(handle.port, {
          executionStatusVocabulary: EXECUTION_STATES,
          expectedMigrationCount: shippedMigrations().length,
        });
        expect(clean.verified).toBe(true);
        expect(clean.checks.length).toBeGreaterThanOrEqual(12);

        // D-a — the INCOMPLETE restore: a truncated event ledger
        // (delete ONE event of a multi-event execution → the gapless
        // 1..last_event_sequence contract breaks; a partial restore
        // is DETECTED, never silently accepted). The append-only
        // trigger guards LIVE mutations — the corruption a broken
        // restore leaves behind bypasses them by construction (the
        // restore itself runs in replication-role mode), so the
        // simulation uses the same mode.
        const victim = await handle.port.execute<{
          readonly execution_id: string;
          readonly sequence: number;
        }>({
          sql: `SELECT execution_id, sequence FROM executions.execution_events
                WHERE execution_id IN (
                  SELECT execution_id FROM executions.execution_events
                  GROUP BY execution_id HAVING count(*) > 1
                )
                ORDER BY sequence DESC LIMIT 1`,
          parameters: [],
        });
        expect(victim.rows).toHaveLength(1);
        const victimExecution = victim.rows[0]?.execution_id as string;
        const victimSequence = victim.rows[0]?.sequence as number;

        // D-b — CORRUPTED state: an execution outside the frozen
        // vocabulary + a negative budget wallet. These are
        // CHECK-constraint-guarded (an interlocking web on both
        // tables); a genuinely corrupted restored database (schema
        // drift, a foreign restore) can carry them, so the simulation
        // strips the CHECK guards on the two target tables and
        // tampers — the invariant gate must catch what the guards
        // DID NOT see at restore time. (The disposable target is
        // dropped after the proof; the drifted schema never survives
        // the drill.)
        await tamperSession(targetUrl, async (client) => {
          await client.query(
            "DELETE FROM executions.execution_events WHERE execution_id = $1 AND sequence = $2",
            [victimExecution, victimSequence],
          );
          const dropChecksOf = async (relation: string): Promise<void> => {
            const checks = await client.query<{ conname: string }>({
              text: "SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'",
              values: [relation],
            });
            for (const row of checks.rows) {
              await client.query(
                `ALTER TABLE ${relation} DROP CONSTRAINT "${row.conname}"`,
              );
            }
          };
          await dropChecksOf("executions.executions");
          await dropChecksOf("budgets.wallets");
          await client.query(
            "UPDATE executions.executions SET status = 'SPOOFED' WHERE id = (SELECT id FROM executions.executions LIMIT 1)",
          );
          await client.query(
            "UPDATE budgets.wallets SET balance_micro_usd = -1 WHERE id = (SELECT id FROM budgets.wallets LIMIT 1)",
          );
        });

        const report = await verifyRecoveredAuthority(handle.port, {
          executionStatusVocabulary: EXECUTION_STATES,
          expectedMigrationCount: shippedMigrations().length,
        });
        expect(report.verified).toBe(false);
        const failedChecks = new Set(report.violations.map((violation) => violation.check));
        expect(failedChecks.has("execution-event-gapless-sequences")).toBe(true);
        expect(failedChecks.has("execution-status-vocabulary")).toBe(true);
        expect(failedChecks.has("budget-wallet-non-negative")).toBe(true);

        // D-d — the UNVERIFIED recovery never declares recovery: the
        // drill's invariant phase fails, recovery is refused, RTO is
        // unmeasured, and the phases AFTER the failure never run.
        const drill = await runRecoveryDrill(
          {
            scenarioId: "authority-loss-tampered",
            environment: "local",
            revision: "work048-integration",
            lossAt: ctx.lossAt,
            lastConsistentPointAt: ctx.lossAt,
            phases: [
              { name: "probe", action: async () => undefined },
              {
                name: "authority-invariants",
                action: async () => {
                  if (!report.verified) {
                    throw new Error(
                      `recovered-authority invariant violations: ${report.violations.length}`,
                    );
                  }
                },
              },
              {
                name: "never-runs-after-failure",
                action: async () => {
                  throw new Error("this phase must never run (fail-closed ordering)");
                },
              },
            ],
          },
          { now: () => new Date() },
        );
        expect(drill.recovered).toBe(false);
        expect(drill.rtoMs).toBeNull();
        expect(drill.phases.map((phase) => phase.name)).toEqual(["probe", "authority-invariants"]);
        expect(drill.phases[1]?.ok).toBe(false);
        const evaluation = evaluateDrillAgainstTarget(drill, LOCAL_TARGET);
        expect(evaluation.rtoWithinTarget).toBe(false);
        expect(evaluation.rpoWithinTarget).toBe(true);
        expect(evaluation.breaches.join(" ")).toContain("did not verify recovery");
      } finally {
        await handle.close();
        await dropDatabase(ctx.adminUrl, targetDatabase);
      }
    });

    test("discrimination D-c: checksum drift in the backup artifact fails the restore self-verification (a tampered backup never restores)", async () => {
      const tampered: LogicalBackup = JSON.parse(JSON.stringify(ctx.backup)) as LogicalBackup;
      // Tamper ONE row of a data-bearing table WITHOUT fixing its
      // checksum: the restore's read-back + re-hash must detect the
      // drift and refuse the verification. The tampered column is
      // plain TEXT (the tenants' name — a value the type system
      // accepts so the drift, not the type, is what fails).
      const tenantsTable = tampered.tables.find(
        (candidate) => candidate.schema === "applications" && candidate.table === "tenants",
      );
      expect(tenantsTable).toBeDefined();
      const targeted = tenantsTable as NonNullable<typeof tenantsTable>;
      const firstRow = targeted.rows[0] as Record<string, unknown>;
      expect(typeof firstRow.name).toBe("string");
      firstRow.name = `${String(firstRow.name)}-tampered`;

      const targetDatabase = await createDatabase(ctx.adminUrl);
      const targetUrl = `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${targetDatabase}`;
      const handle = await startAuthoritativeDatabase(targetUrl, { poolOverrides: { max: 4 } });
      try {
        // The tampered backup FAILS CLOSED at restore: the typed
        // verification error names the drifted table and the restore
        // transaction never commits corrupted rows.
        await expect(restoreDataIntoCurrentState(handle.port, tampered)).rejects.toThrow(
          /applications\.tenants \(row counts or content checksums do not match the backup\)/,
        );
      } finally {
        await handle.close();
        await dropDatabase(ctx.adminUrl, targetDatabase);
      }
    });
  },
  async (adminUrl) => {
    // ---- 1-2. seed REAL authoritative state through the REAL module
    // services; back it up; the LIVE source stays untouched (the safe
    // operator drill form — recovery is proven against fresh targets).
    const sourceDatabase = await createDatabase(adminUrl);
    const sourceUrl = `${adminUrl.replace(/\/[^/]*$/, "")}/${sourceDatabase}`;
    const handle = await startAuthoritativeDatabase(sourceUrl, { poolOverrides: { max: 4 } });
    let backup: LogicalBackup;
    try {
      const world = await seedMediaWorld(handle.port);
      const submitted = await submitMediaJob(world, "d07-restore");
      const completed = await pollToCompletion(world.service, submitted.jobId, world.actor());
      if (completed === null || completed.status !== "completed") {
        throw new Error(
          `the drill seed job did not complete (status: ${completed?.status ?? "null"})`,
        );
      }
      const migrations = shippedMigrations();
      await verifySchemaConvergence(handle.port, migrations);
      backup = await createLogicalBackup(handle.port, authoritativeSchemas(migrations));
      const adopted = await handle.port.execute<{ readonly count: string }>({
        sql: "SELECT count(*) AS count FROM deployments.media_artifacts",
        parameters: [],
      });
      if (Number(adopted.rows[0]?.count ?? 0) < 1) {
        throw new Error("the adoption ledger is empty before the drill (seed defect)");
      }
    } finally {
      await handle.close();
    }
    return {
      context: { adminUrl, sourceUrl, sourceDatabase, backup, lossAt: new Date() },
      cleanup: async () => {
        await dropDatabase(adminUrl, sourceDatabase);
      },
    };
  },
);
