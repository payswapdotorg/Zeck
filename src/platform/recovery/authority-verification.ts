/**
 * Post-restore authoritative-state verification (platform recovery
 * plane; WORK-048 / D-07, acceptance criterion 1: "Authoritative
 * PostgreSQL state can be restored ... and verified against expected
 * invariants").
 *
 * WHY THIS EXISTS: the WORK-043 restore engine restores data with
 * `session_replication_role = replica` — FK and CHECK triggers are
 * DISABLED while the exact historical state is restored (write-once
 * guards protect LIVE mutations, not recovery). That is correct for
 * restore, and it means the restored rows were never re-validated
 * against the schema's own invariants. This gate re-proves the
 * CRITICAL invariants as explicit queries — the D-07 check that must
 * pass BEFORE an environment may be declared recovered.
 *
 * THE AUTHORITY SPLIT (the module-private table discipline — the
 * WORK-046 worker-fabric seam precedent):
 *
 *   * THIS MODULE verifies the PLATFORM-owned schemas directly:
 *     migration history, queue-transport envelopes (vocabulary +
 *     consumed⇒applied), the compute plane (single live claim,
 *     worker vocabulary) and the workflow waits.
 *   * MODULE-owned tables (executions, budgets, deployments) are
 *     module-private surface: their invariant checks are supplied by
 *     the OWNING MODULE's adapter through the neutral
 *     `ModuleInvariantSource` seam declared here (wired by the
 *     composition root — deploy/drill and the test worlds), exactly
 *     like the executions module already exposes its recovery scan
 *     to the worker fabric.
 *
 * A tampered/incomplete/corrupted restore FAILS a check; the caller
 * (drill/CLI) then refuses the recovered declaration — unverified
 * recovery never becomes a PASS (Work Order discrimination
 * requirement).
 *
 * The module is pure platform: bounded SQL over the `DatabasePort`
 * for platform schemas only; module-private state enters ONLY
 * through the injected seam violations.
 */

import type { DatabasePort } from "../db/port";

/** One invariant violation (bounded, typed evidence). */
export interface AuthorityInvariantViolation {
  readonly check: string;
  readonly detail: string;
}

/** The authority verification report. */
export interface AuthorityVerificationReport {
  readonly checks: readonly string[];
  readonly violations: readonly AuthorityInvariantViolation[];
  /** True iff ZERO violations — the only recovered declaration. */
  readonly verified: boolean;
}

/**
 * One module-owned invariant check: the owning module's adapter
 * verifies its own private tables and reports violations through
 * this neutral seam (the platform never queries module tables
 * directly).
 */
export interface ModuleInvariantSource {
  /** The owning module id (evidence attribution). */
  readonly module: string;
  /** The check names this source owns (reported in `checks`). */
  readonly checks: readonly string[];
  verify(): Promise<readonly AuthorityInvariantViolation[]>;
}

export interface AuthorityVerificationInput {
  /** The expected shipped migration count (from the backup context). */
  readonly expectedMigrationCount: number;
  /** The module-owned invariant checks (executions, budgets, artifact ledger). */
  readonly moduleInvariants: readonly ModuleInvariantSource[];
}

const MAX_VIOLATION_DETAIL = 300;

async function count(
  db: DatabasePort,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<number> {
  const result = await db.execute<{ readonly count: string }>({ sql, parameters });
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Verify the recovered authoritative state. Every check runs even
 * when an earlier one fails (full violation list, one pass).
 */
export async function verifyRecoveredAuthority(
  db: DatabasePort,
  input: AuthorityVerificationInput,
): Promise<AuthorityVerificationReport> {
  if (!Number.isInteger(input.expectedMigrationCount) || input.expectedMigrationCount < 1) {
    throw new Error("expectedMigrationCount must be a positive integer");
  }
  if (input.moduleInvariants.length === 0) {
    throw new Error(
      "the module-owned invariant checks are required (executions, budgets, artifact ledger — the composition root wires them)",
    );
  }
  const violations: AuthorityInvariantViolation[] = [];
  const checks: string[] = [];

  // 1. Migration history — the deterministic DDL authority.
  checks.push("migration-history");
  const migrations = await count(db, "SELECT count(*) AS count FROM platform.schema_migrations");
  if (migrations !== input.expectedMigrationCount) {
    violations.push({
      check: "migration-history",
      detail: `expected ${input.expectedMigrationCount} applied migrations, found ${migrations}`,
    });
  }

  // 2. Queue envelopes (platform-owned): closed vocabulary + the
  //    consumed ⇒ applied boundary.
  checks.push("queue-envelope-vocabulary");
  const badEnvelopeStates = await count(
    db,
    `SELECT count(*) AS count FROM queue_transport.dispatch_envelopes
     WHERE state NOT IN ('recorded', 'published', 'backlogged', 'consumed', 'dead-lettered')`,
  );
  if (badEnvelopeStates > 0) {
    violations.push({
      check: "queue-envelope-vocabulary",
      detail: `${badEnvelopeStates} dispatch envelopes outside the transport vocabulary`,
    });
  }
  checks.push("queue-consumed-applied-boundary");
  const unappliedConsumed = await count(
    db,
    `SELECT count(*) AS count FROM queue_transport.dispatch_envelopes
     WHERE state = 'consumed' AND applied_at IS NULL`,
  );
  if (unappliedConsumed > 0) {
    violations.push({
      check: "queue-consumed-applied-boundary",
      detail: `${unappliedConsumed} consumed envelopes without the authoritative applied marker`,
    });
  }

  // 3. The compute plane (platform-owned): one live claim per
  //    execution; the worker vocabulary.
  checks.push("single-live-claim-per-execution");
  const duplicateLiveClaims = await count(
    db,
    `SELECT count(*) AS count FROM (
       SELECT execution_id FROM compute_plane.worker_claims
       WHERE status = 'claimed'
       GROUP BY execution_id HAVING count(*) > 1
     ) d`,
  );
  if (duplicateLiveClaims > 0) {
    violations.push({
      check: "single-live-claim-per-execution",
      detail: `${duplicateLiveClaims} executions with more than one live worker claim`,
    });
  }
  checks.push("worker-registration-vocabulary");
  const badWorkerStatuses = await count(
    db,
    `SELECT count(*) AS count FROM compute_plane.worker_registrations
     WHERE status NOT IN ('active', 'draining', 'offline')`,
  );
  if (badWorkerStatuses > 0) {
    violations.push({
      check: "worker-registration-vocabulary",
      detail: `${badWorkerStatuses} worker registrations outside the status vocabulary`,
    });
  }

  // 4. Workflow waits (platform-owned): vocabulary + the terminal/
  //    armed instance binding.
  checks.push("workflow-wait-vocabulary");
  const badWaitStates = await count(
    db,
    `SELECT count(*) AS count FROM workflow_orchestration.waits
     WHERE state NOT IN ('recorded', 'deferred', 'armed', 'signaled', 'settled', 'elapsed', 'superseded', 'abandoned')`,
  );
  if (badWaitStates > 0) {
    violations.push({
      check: "workflow-wait-vocabulary",
      detail: `${badWaitStates} workflow waits outside the state vocabulary`,
    });
  }
  checks.push("workflow-armed-instance-binding");
  const unboundArmed = await count(
    db,
    `SELECT count(*) AS count FROM workflow_orchestration.waits
     WHERE state IN ('recorded', 'deferred') AND provider_instance_id IS NOT NULL`,
  );
  if (unboundArmed > 0) {
    violations.push({
      check: "workflow-armed-instance-binding",
      detail: `${unboundArmed} pre-arm waits carrying a provider instance id (authority drift)`,
    });
  }

  // 5. The module-owned invariants (executions state machine + event
  //    ledgers, budget non-negativity, the artifact adoption ledger)
  //    through the neutral seams — the owning modules verify their
  //    own private tables.
  for (const source of input.moduleInvariants) {
    checks.push(...source.checks);
    violations.push(...(await source.verify()));
  }

  return {
    checks: Object.freeze([...checks]),
    violations: Object.freeze(
      violations.map((violation) => ({
        check: violation.check,
        detail: violation.detail.slice(0, MAX_VIOLATION_DETAIL),
      })),
    ),
    verified: violations.length === 0,
  };
}
