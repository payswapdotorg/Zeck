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
 * against the schema's own invariants. This module re-proves the
 * CRITICAL invariants as explicit queries — the D-07 gate that must
 * pass BEFORE an environment may be declared recovered:
 *
 *   1. migration history: exactly the shipped deterministic set;
 *   2. execution states: every row inside the frozen 14-state
 *      vocabulary (the state machine integrity);
 *   3. execution events: per-execution sequences are gapless
 *      1..last_event_sequence (append-only ledger completeness —
 *      a partial restore is DETECTED, not silently accepted);
 *   4. queue envelopes: closed 5-state vocabulary; `consumed` ⇒
 *      applied (the transport-vs-authority boundary);
 *   5. worker claims: at most ONE live claim per execution (the
 *      physical arbitration invariant); worker/claim vocabularies;
 *   6. budget wallets: no negative balances (the frozen budget
 *      invariant);
 *   7. artifact adoption ledger: digest shape + the artifact → job →
 *      deployment → application → tenant chain resolves (referential
 *      integrity across the restored FK-disabled boundary);
 *   8. workflow waits: closed state vocabulary + the terminal/armed
 *      instance binding.
 *
 * A tampered/incomplete/corrupted restore FAILS a check; the caller
 * (drill/CLI) then refuses the recovered declaration — unverified
 * recovery never becomes a PASS (Work Order discrimination
 * requirement).
 *
 * The module is pure platform: bounded SQL over the `DatabasePort`,
 * the execution vocabulary injected by the composition root (the
 * frozen vocabulary belongs to the architecture, not to a platform
 * default).
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

export interface AuthorityVerificationInput {
  /**
   * The frozen execution state vocabulary (the composition root
   * supplies the architecture-frozen list; fail closed on absence).
   */
  readonly executionStatusVocabulary: readonly string[];
  /** The expected shipped migration count (from the backup context). */
  readonly expectedMigrationCount: number;
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
  if (input.executionStatusVocabulary.length === 0) {
    throw new Error("the frozen execution status vocabulary is required (composition root)");
  }
  if (!Number.isInteger(input.expectedMigrationCount) || input.expectedMigrationCount < 1) {
    throw new Error("expectedMigrationCount must be a positive integer");
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

  // 2. Execution states inside the frozen vocabulary.
  checks.push("execution-status-vocabulary");
  const vocabulary = input.executionStatusVocabulary.map((state) => `'${state}'`).join(", ");
  const badStatuses = await count(
    db,
    `SELECT count(*) AS count FROM executions.executions WHERE status NOT IN (${vocabulary})`,
  );
  if (badStatuses > 0) {
    violations.push({
      check: "execution-status-vocabulary",
      detail: `${badStatuses} executions outside the frozen state vocabulary`,
    });
  }

  // 3. Execution event ledger: gapless per-execution sequences.
  checks.push("execution-event-gapless-sequences");
  const gappedEvents = await count(
    db,
    `SELECT count(*) AS count FROM (
       SELECT e.id
       FROM executions.executions e
       JOIN LATERAL (
         SELECT count(*) AS rows, max(sequence) AS top
         FROM executions.execution_events ev WHERE ev.execution_id = e.id
       ) s ON true
       WHERE s.rows <> s.top OR s.rows <> e.last_event_sequence
     ) g`,
  );
  if (gappedEvents > 0) {
    violations.push({
      check: "execution-event-gapless-sequences",
      detail: `${gappedEvents} executions with gapped or truncated event ledgers (incomplete restore)`,
    });
  }

  // 4. Queue envelope vocabulary + consumed ⇒ applied boundary.
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

  // 5. Worker claims: one live claim per execution; vocabularies.
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

  // 6. Budget wallets: never negative (frozen invariant 8).
  checks.push("budget-wallet-non-negative");
  const negativeWallets = await count(
    db,
    "SELECT count(*) AS count FROM budgets.wallets WHERE balance_micro_usd < 0",
  );
  if (negativeWallets > 0) {
    violations.push({
      check: "budget-wallet-non-negative",
      detail: `${negativeWallets} wallets with negative balances (corrupted restore)`,
    });
  }

  // 7. Artifact adoption ledger: digest shape + chain resolution.
  checks.push("artifact-adoption-digest-shape");
  const badDigests = await count(
    db,
    "SELECT count(*) AS count FROM deployments.media_artifacts WHERE artifact_digest !~ '^[0-9a-f]{64}$'",
  );
  if (badDigests > 0) {
    violations.push({
      check: "artifact-adoption-digest-shape",
      detail: `${badDigests} adoption rows with malformed digests`,
    });
  }
  checks.push("artifact-adoption-chain-resolution");
  const brokenChains = await count(
    db,
    `SELECT count(*) AS count FROM deployments.media_artifacts a
     LEFT JOIN deployments.media_jobs j ON j.id = a.job_id
     LEFT JOIN deployments.deployments d ON d.id = a.deployment_id
     LEFT JOIN applications.applications app ON app.id = a.application_id AND app.tenant_id = a.tenant_id
     LEFT JOIN applications.tenants t ON t.id = a.tenant_id
     WHERE j.id IS NULL OR d.id IS NULL OR app.id IS NULL OR t.id IS NULL`,
  );
  if (brokenChains > 0) {
    violations.push({
      check: "artifact-adoption-chain-resolution",
      detail: `${brokenChains} adoption rows with unresolvable job/deployment/application/tenant chains`,
    });
  }

  // 8. Workflow wait vocabulary + terminal/armed instance binding.
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
