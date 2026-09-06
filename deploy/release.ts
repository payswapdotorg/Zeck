/**
 * deploy/release — the D-06 release-control operator surface
 * (WORK-047; D1.0 delivery: production delivery, observability and
 * release control).
 *
 * THE RELEASE CONTROL MODEL (see deploy/README.md §D-06):
 *
 *   bun run deploy:release -- record   --environment <env>
 *   bun run deploy:release -- gate run   --kind <kind> --environment <phase>
 *   bun run deploy:release -- gate attach --kind <kind> --environment <phase> --evidence-file <file> [--actor <actor>]
 *   bun run deploy:release -- promote  --to <phase> [--actor <actor>]
 *   bun run deploy:release -- rollback --environment <env> [--to <releaseId>] [--reason <text>]
 *   bun run deploy:release -- inspect  [--environment <env>] [--release <id>]
 *   bun run deploy:release -- status   [--environment <env>]
 *   bun run deploy:release -- alerts   [--environment <env>]
 *
 * AUTHORITY: the durable release ledger is PostgreSQL (the single
 * authoritative store) through the governed SqlReleaseControlStore —
 * CI/CD, provider control planes and dashboards are MECHANISMS that
 * drive this tool; they never own release state (the SELF-HOSTING
 * BOUNDARY: the identical commands run from any operator checkout).
 *
 * EVIDENCE: gate results are recorded by the tool RUNNING the gate
 * (tool-run) or ATTACHING externally-produced evidence (external-
 * attach, e.g. CI conclusions and Architect approvals). All evidence
 * is append-only, digest-bound and bounded.
 *
 * GUARDRAILS: promotion refuses on missing gate evidence AND on
 * active CRITICAL quota alerts (cost/quota guards); rollback changes
 * deployment state only (release_control writes exclusively).
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseConnectionConfig } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import type { DatabasePort } from "../src/platform/db/port";
import { shippedMigrations } from "../src/platform/db/startup";
import { deploymentIdentity, manifestDigest } from "../src/platform/deployment/identity";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import {
  evaluateOperationalAlerts,
  evaluateQuotaAlerts,
  hasCriticalAlert,
  loadQuotaGuardsPolicy,
} from "../src/platform/observability/alerts";
import type {
  OperationalAlert,
  QuotaUtilizationSnapshot,
} from "../src/platform/observability/port";
import {
  evidenceDigestOf,
  type HostingEnvironment,
  isHostingEnvironment,
  isReleasePhase,
  ReleaseControlError,
  type ReleasePhase,
  releaseIdentityId,
  SqlReleaseControlStore,
} from "../src/platform/release";
import { evaluatePromotion, loadReleasePolicy } from "../src/platform/release/policy";
import { createUuidv7Generator } from "../src/shared/ids";
import { gitRevision, loadManifest, REPOSITORY_ROOT } from "./lib";
import { resolveDatabaseUrl } from "./migrate";
import { runSmokeAttestation } from "./smoke";
import { validateDeploymentConfiguration } from "./validate";

const execFileAsync = promisify(execFile);

const ACTOR_DEFAULT = "release-operator";

function requireReleaseCommand(argv: readonly string[]): string {
  const command = argv[0] as string;
  const commands = ["record", "gate", "promote", "rollback", "inspect", "status", "alerts"];
  if (!commands.includes(command)) {
    console.error(
      "error: command required: record | gate <run|attach> | promote | rollback | inspect | status | alerts",
    );
    process.exit(2);
  }
  return command;
}

function stringOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return undefined;
  }
  return argv[index + 1];
}

function requireReleasePhase(value: string | undefined): ReleasePhase {
  if (value === undefined || !isReleasePhase(value)) {
    console.error(
      "error: --environment <local|ci|preview|staging|production> is required (the ladder phase the gate applies to)",
    );
    process.exit(2);
  }
  return value;
}

function requireHostingEnvironment(value: string | undefined): HostingEnvironment {
  if (value === undefined || !isHostingEnvironment(value)) {
    console.error(
      "error: --environment <local|preview|staging|production> is required (a hosting environment)",
    );
    process.exit(2);
  }
  return value;
}

/** The release of THIS checkout (exact revision + manifest digest). */
function checkoutRelease(): {
  readonly gitRevision: string;
  readonly manifestDigest: string;
  readonly releaseId: string;
} {
  const manifest = loadManifest();
  const revision = gitRevision();
  const digest = manifestDigest(manifest);
  return {
    gitRevision: revision,
    manifestDigest: digest,
    releaseId: releaseIdentityId(revision, digest),
  };
}

/** Open the environment's authoritative store (the release ledger lives there). */
async function openStore(
  environment: EnvironmentId,
): Promise<{ store: SqlReleaseControlStore; db: PgDatabasePort }> {
  const url = await resolveDatabaseUrl(environment);
  const config = parseConnectionConfig(url, { max: 4, connectionTimeoutMillis: 8000 });
  const db = new PgDatabasePort(config);
  const store = new SqlReleaseControlStore({
    db,
    now: () => new Date(),
    generateId: createUuidv7Generator(),
  });
  return { store, db };
}

// ---------------------------------------------------------------------------
// Quota guard snapshots (authoritative sources only)
// ---------------------------------------------------------------------------

export async function collectQuotaSnapshots(
  db: DatabasePort,
  environment: string,
): Promise<readonly QuotaUtilizationSnapshot[]> {
  const snapshots: QuotaUtilizationSnapshot[] = [];
  // compute-claims: live claims per compute environment vs the quota.
  const claims = await db.execute<{
    readonly compute_environment_id: string;
    readonly max_concurrent_claims: number;
    readonly live: string;
  }>({
    sql: `SELECT q.compute_environment_id, q.max_concurrent_claims,
(SELECT count(*) FROM compute_plane.worker_claims c
 WHERE c.compute_environment_id = q.compute_environment_id AND c.status = 'claimed') AS live
FROM compute_plane.environment_quotas q ORDER BY q.compute_environment_id`,
  });
  for (const row of claims.rows) {
    snapshots.push({
      guard: "compute-claims",
      environment: `${environment}:${row.compute_environment_id}`,
      used: Number(row.live),
      limit: row.max_concurrent_claims,
    });
  }
  // queue-backlog: pending (recorded/backlogged) envelopes.
  const backlog = await db.execute<{ readonly count: string }>({
    sql: `SELECT count(*) AS count FROM queue_transport.dispatch_envelopes
WHERE state IN ('recorded', 'backlogged')`,
  });
  const backlogCount = Number(backlog.rows[0]?.count ?? 0);
  const backlogLimit = Number.parseInt(process.env.ZECK_QUEUE_BACKLOG_BOUND ?? "1000", 10);
  snapshots.push({
    guard: "queue-backlog",
    environment,
    used: backlogCount,
    limit: Number.isFinite(backlogLimit) && backlogLimit > 0 ? backlogLimit : 1000,
  });
  // database-size: pg_database_size vs the declared plan ceiling.
  const size = await db.execute<{ readonly size: string }>({
    sql: `SELECT pg_database_size(current_database()) AS size`,
  });
  const usedBytes = Number(size.rows[0]?.size ?? 0);
  snapshots.push({
    guard: "database-size",
    environment,
    used: usedBytes,
    limit: Number.parseInt(process.env.ZECK_DB_SIZE_LIMIT_BYTES ?? "5368709120", 10),
  });
  return snapshots;
}

export async function collectOperationalSnapshots(
  db: DatabasePort,
): Promise<
  readonly { readonly metric: string; readonly window: string; readonly value: number }[]
> {
  const deadLetters = await db.execute<{ readonly count: string }>({
    sql: `SELECT count(*) AS count FROM queue_transport.dispatch_envelopes WHERE state = 'dead-lettered'`,
  });
  const failed = await db.execute<{ readonly count: string }>({
    sql: `SELECT count(*) AS count FROM executions.executions WHERE status IN ('FAILED', 'EXPIRED')`,
  });
  const gateFailures = await db.execute<{ readonly count: string }>({
    sql: `SELECT count(*) AS count FROM release_control.gate_results WHERE status = 'failed'`,
  });
  return [
    {
      metric: "queue-dead-letters",
      window: "total",
      value: Number(deadLetters.rows[0]?.count ?? 0),
    },
    {
      metric: "terminal-failed-executions",
      window: "total",
      value: Number(failed.rows[0]?.count ?? 0),
    },
    {
      metric: "release-gate-failures",
      window: "total",
      value: Number(gateFailures.rows[0]?.count ?? 0),
    },
  ];
}

export async function evaluateAlerts(
  db: DatabasePort,
  environment: string,
): Promise<readonly OperationalAlert[]> {
  const policy = loadQuotaGuardsPolicy(
    readFileSync(`${REPOSITORY_ROOT}/deploy/manifests/quota-guards.json`, "utf8"),
  );
  const snapshots = await collectQuotaSnapshots(db, environment);
  const byGuard = new Map(policy.guards.map((rule) => [rule.guard, rule]));
  const applicable = snapshots.filter((snapshot) => byGuard.has(snapshot.guard));
  const quotaAlerts = evaluateQuotaAlerts(applicable, {
    guards: Object.fromEntries([...byGuard].map(([guard, rule]) => [guard, rule.thresholds])),
  });
  const operational = evaluateOperationalAlerts(
    await collectOperationalSnapshots(db),
    policy.operationalThresholds,
  );
  return [...quotaAlerts, ...operational];
}

// ---------------------------------------------------------------------------
// Gate evaluators (tool-run evidence)
// ---------------------------------------------------------------------------

interface GateEvaluation {
  readonly status: "passed" | "failed";
  readonly evidence: string;
}

async function execGate(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GateEvaluation> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      cwd: REPOSITORY_ROOT,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const summary = stdout.trim().split("\n")[0]?.slice(0, 200) ?? "";
    return {
      status: "passed",
      evidence: `exit 0; ${command} ${args.join(" ")}; ${summary}`,
    };
  } catch (error) {
    const failure = error as {
      readonly code?: number | string;
      readonly stdout?: string;
      readonly message: string;
    };
    const summary = (failure.stdout ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "";
    return {
      status: "failed",
      evidence: `exit ${String(failure.code ?? "?")}; ${command} ${args.join(" ")}; ${summary || failure.message.slice(0, 160)}`,
    };
  }
}

export async function runValidationGate(): Promise<GateEvaluation> {
  const report = validateDeploymentConfiguration();
  return {
    status: report.valid ? "passed" : "failed",
    evidence: `deploy:validate ${report.valid ? "valid" : `invalid (${report.problems.length} problems)`}; providers ${report.providers}; variables ${report.variables}; releaseGateKinds ${report.releaseGateKinds}; migrations ${report.migrations}${report.valid ? "" : `; ${report.problems[0] ?? ""}`}`,
  };
}

async function runIdentityAuditGate(
  store: SqlReleaseControlStore,
  releaseId: string,
  environment: HostingEnvironment,
): Promise<GateEvaluation> {
  const manifest = loadManifest();
  const revision = gitRevision();
  const identity = deploymentIdentity(manifest, revision, environment);
  const recorded = await store.inspectRelease(releaseId);
  const binding = recorded.environmentDeployments.find(
    (deployment) => deployment.environment === environment,
  );
  if (binding === undefined) {
    return {
      status: "failed",
      evidence: `no environment deployment binding for ${environment} (record it first: deploy:release record)`,
    };
  }
  if (binding.deploymentIdentityId !== identity.identityId) {
    return {
      status: "failed",
      evidence: `deployment identity drift: recorded ${binding.deploymentIdentityId.slice(0, 16)} recomputes ${identity.identityId.slice(0, 16)} (manifest/resource drift or tampering)`,
    };
  }
  return {
    status: "passed",
    evidence: `deployment identity ${identity.identityId.slice(0, 16)} recomputes at revision ${revision.slice(0, 12)} for ${environment} (resource digest ${identity.resourceDigest.slice(0, 12)})`,
  };
}

export async function runMigrationGate(db: DatabasePort): Promise<GateEvaluation> {
  const shipped = shippedMigrations();
  const recorded = await db.execute<{
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }>({
    sql: `SELECT version, name, checksum FROM platform.schema_migrations ORDER BY version`,
  });
  const recordedByVersion = new Map(recorded.rows.map((row) => [row.version, row]));
  const shippedByVersion = new Map(shipped.map((file) => [file.version, file]));
  const unapplied = shipped.filter((file) => !recordedByVersion.has(file.version));
  const unshipped = recorded.rows.filter((row) => !shippedByVersion.has(row.version));
  const checksumDrift = shipped.filter((file) => {
    const row = recordedByVersion.get(file.version);
    return row !== undefined && row.checksum !== file.checksum;
  });
  const ledgerDigest = evidenceDigestOf(
    recorded.rows.map((row) => `${row.version}:${row.name}:${row.checksum}`).join("\n"),
  );
  if (unapplied.length > 0) {
    return {
      status: "failed",
      evidence: `migration required: ${unapplied.length} shipped migration(s) unapplied (next: ${unapplied[0]?.version} ${unapplied[0]?.name}); run deploy:migrate first (fail closed)`,
    };
  }
  if (unshipped.length > 0) {
    return {
      status: "failed",
      evidence: `downgrade hazard: ${unshipped.length} applied migration(s) not in the shipped set (first: v${unshipped[0]?.version} ${unshipped[0]?.name}); the database is ahead of the release revision (fail closed)`,
    };
  }
  if (checksumDrift.length > 0) {
    return {
      status: "failed",
      evidence: `checksum drift on ${checksumDrift.length} migration(s) (first: v${checksumDrift[0]?.version}); shipped SQL changed after application (fail closed)`,
    };
  }
  return {
    status: "passed",
    evidence: `schema converged: ${recorded.rows.length}/${shipped.length} shipped migrations applied in order; ledger digest ${ledgerDigest.slice(0, 16)}`,
  };
}

export async function runHealthGate(
  environment: EnvironmentId,
  branch?: string,
): Promise<GateEvaluation> {
  const attestation = await runSmokeAttestation(environment, { branch });
  const overall = attestation.readiness.overall;
  const dependencies = attestation.readiness.dependencies
    .map((dependency) => `${dependency.concern}=${dependency.status}`)
    .join(", ");
  return {
    status: overall === "ready" ? "passed" : "failed",
    evidence: `readiness overall=${overall} (controlPlane ${attestation.readiness.controlPlane}); dependencies: ${dependencies.slice(0, 300)}`,
  };
}

export async function runSmokeGate(
  environment: EnvironmentId,
  branch?: string,
): Promise<GateEvaluation> {
  const attestation = await runSmokeAttestation(environment, { branch });
  return {
    status: attestation.pass ? "passed" : "failed",
    evidence: `deploy:smoke ${attestation.pass ? "passed" : "failed"}: identity ${attestation.identity.identityId.slice(0, 16)} at ${attestation.gitRevision.slice(0, 12)}; readiness ${attestation.readiness.overall}; contract ${attestation.environmentContract.satisfied ? "satisfied" : "violated"}`,
  };
}

/** The tool-run evaluator dispatch (the closed gate-kind vocabulary). */
async function evaluateGate(
  kind: string,
  phase: ReleasePhase,
  store: SqlReleaseControlStore,
  db: DatabasePort,
): Promise<GateEvaluation> {
  switch (kind) {
    case "governance-check":
      return execGate("python3", ["scripts/governance-check.py"], 120_000);
    case "typecheck":
      return execGate("bun", ["run", "typecheck"], 300_000);
    case "lint":
      return execGate("bun", ["run", "lint"], 300_000);
    case "full-test-suite":
      return execGate("bun", ["run", "test"], 2_700_000);
    case "validation":
      return runValidationGate();
    case "identity-audit":
    case "deployment-identity-audit":
      if (!isHostingEnvironment(phase)) {
        return {
          status: "failed",
          evidence: `identity-audit is an environment-scoped gate (got phase "${phase}")`,
        };
      }
      return runIdentityAuditGate(store, checkoutRelease().releaseId, phase);
    case "migration": {
      if (phase === "ci" || !isHostingEnvironment(phase)) {
        return {
          status: "failed",
          evidence: `migration is an environment-scoped gate (got phase "${phase}")`,
        };
      }
      return runMigrationGate(db);
    }
    case "health": {
      if (phase === "ci" || !isHostingEnvironment(phase)) {
        return {
          status: "failed",
          evidence: `health is an environment-scoped gate (got phase "${phase}")`,
        };
      }
      return runHealthGate(phase);
    }
    case "preview-smoke":
      return runSmokeGate("preview", stringOption(process.argv, "--branch"));
    case "staging-smoke":
      return runSmokeGate("staging", stringOption(process.argv, "--branch"));
    case "ci-gates":
    case "architect-approval":
      return {
        status: "failed",
        evidence: `gate "${kind}" is attach-only evidence (external-attach): attach it with gate attach`,
      };
    default:
      return {
        status: "failed",
        evidence: `unknown gate kind "${kind}" (the vocabulary is closed by release-policy.json)`,
      };
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandRecord(environment: HostingEnvironment, actor: string): Promise<void> {
  const manifest = loadManifest();
  const revision = gitRevision();
  const digest = manifestDigest(manifest);
  const identity = deploymentIdentity(manifest, revision, environment);
  const { store, db } = await openStore(environment);
  try {
    const release = await store.recordRelease({
      gitRevision: revision,
      manifestDigest: digest,
      actor,
    });
    const deployment = await store.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment,
      deploymentIdentityId: identity.identityId,
      resourceDigest: identity.resourceDigest,
      actor,
    });
    console.log(
      JSON.stringify(
        {
          tool: "deploy/release",
          command: "record",
          environment,
          release,
          environmentDeployment: deployment,
          identity: {
            identityId: identity.identityId,
            gitRevision: identity.gitRevision,
            environment: identity.environment,
            manifestDigest: identity.manifestDigest,
            resourceDigest: identity.resourceDigest,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

async function commandGate(
  subcommand: "run" | "attach",
  kind: string,
  phase: ReleasePhase,
  actor: string,
): Promise<void> {
  // Gates are recorded in the release ledger of the PROCESS'S OWN
  // environment (ZECK_ENVIRONMENT; the CI/local ledger by default):
  // evidence is attributed to the PHASE label and is append-only
  // wherever it is recorded — the per-environment ledgers stay
  // isolated, and the operator promoting into an environment
  // re-runs/attaches that environment's evidence from its console
  // (checkout-scoped conclusions travel as external attachments).
  const declaredEnvironment = process.env.ZECK_ENVIRONMENT;
  const ledgerEnvironment: HostingEnvironment =
    declaredEnvironment !== undefined && isHostingEnvironment(declaredEnvironment)
      ? declaredEnvironment
      : "local";
  const { store, db } = await openStore(ledgerEnvironment);
  try {
    const checkout = checkoutRelease();
    // Ensure the release exists in this ledger (idempotent).
    await store.recordRelease({
      gitRevision: checkout.gitRevision,
      manifestDigest: checkout.manifestDigest,
      actor,
    });
    if (subcommand === "attach") {
      const evidenceFile = stringOption(process.argv, "--evidence-file");
      const statement = stringOption(process.argv, "--statement");
      const source =
        evidenceFile !== undefined ? readFileSync(evidenceFile, "utf8") : (statement ?? "");
      if (source.trim() === "") {
        console.error("error: gate attach requires --evidence-file <file> or --statement <text>");
        process.exit(2);
      }
      const result = await store.recordGateResult({
        releaseId: checkout.releaseId,
        environment: phase,
        gateKind: kind,
        status: "passed",
        evidenceDigest: evidenceDigestOf(source),
        evidenceDetail: source.slice(0, 4000),
        source: "external-attach",
        actor,
      });
      console.log(
        JSON.stringify({ tool: "deploy/release", command: "gate attach", result }, null, 2),
      );
      return;
    }
    const evaluation = await evaluateGate(kind, phase, store, db);
    const result = await store.recordGateResult({
      releaseId: checkout.releaseId,
      environment: phase,
      gateKind: kind,
      status: evaluation.status,
      evidenceDigest: evidenceDigestOf(evaluation.evidence),
      evidenceDetail: evaluation.evidence,
      source: "tool-run",
      actor,
    });
    console.log(JSON.stringify({ tool: "deploy/release", command: "gate run", result }, null, 2));
    if (evaluation.status === "failed") {
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}

async function commandPromote(target: ReleasePhase, actor: string): Promise<void> {
  const manifest = loadManifest();
  const policy = loadReleasePolicy(
    readFileSync(`${REPOSITORY_ROOT}/deploy/manifests/release-policy.json`, "utf8"),
    manifest,
  );
  const checkout = checkoutRelease();
  const ledgerEnvironment: HostingEnvironment =
    target === "ci" ? "local" : isHostingEnvironment(target) ? target : "local";
  const { store, db } = await openStore(ledgerEnvironment);
  try {
    // The release + (for hosting targets) the identity binding must exist.
    await store.recordRelease({
      gitRevision: checkout.gitRevision,
      manifestDigest: checkout.manifestDigest,
      actor,
    });
    if (isHostingEnvironment(target)) {
      const identity = deploymentIdentity(manifest, checkout.gitRevision, target);
      await store.recordEnvironmentDeployment({
        releaseId: checkout.releaseId,
        environment: target,
        deploymentIdentityId: identity.identityId,
        resourceDigest: identity.resourceDigest,
        actor,
      });
    }
    const effective = await store.effectiveGateResults(checkout.releaseId, target);
    const evaluation = evaluatePromotion(target, effective, policy);
    // The cost/quota guardrail: a CRITICAL alert for the target
    // environment blocks promotion (observable before exhaustion; no
    // uncontrolled overage).
    let alerts: readonly OperationalAlert[] = [];
    try {
      alerts = await evaluateAlerts(db, ledgerEnvironment);
    } catch {
      // The snapshot collection failed (e.g. an empty fresh ledger
      // database): the guardrail is best-effort on read, fail-closed
      // on write paths that need it (below).
    }
    const critical = hasCriticalAlert(alerts);
    if (!evaluation.allowed || critical) {
      const reason = !evaluation.allowed
        ? (evaluation.reason ?? "promotion refused")
        : `active critical quota/operational alert blocks promotion: ${alerts.find((alert) => alert.severity === "critical")?.subject ?? "unknown"}`;
      await store.recordPromotionDecision({
        releaseId: checkout.releaseId,
        fromPhase: "none",
        toPhase: target,
        decision: "refused",
        reason: reason.slice(0, 1000),
        actor,
      });
      console.error(`error: ${reason}`);
      const inspection = await store.inspectRelease(checkout.releaseId);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/release",
            command: "promote",
            target,
            releaseId: checkout.releaseId,
            allowed: false,
            missingGates: evaluation.missing,
            criticalAlerts: alerts.filter((alert) => alert.severity === "critical"),
            effectiveGates: inspection.effectiveGates.filter((gate) => gate.environment === target),
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    await store.recordPromotionDecision({
      releaseId: checkout.releaseId,
      fromPhase: "none",
      toPhase: target,
      decision: "promoted",
      reason: `entry gates satisfied: ${evaluation.satisfied.join(", ")}`,
      actor,
    });
    if (isHostingEnvironment(target)) {
      const active = await store.activate({
        environment: target,
        releaseId: checkout.releaseId,
        requiredGates: policy.entryGates[target],
        actor,
      });
      console.log(
        JSON.stringify(
          {
            tool: "deploy/release",
            command: "promote",
            target,
            releaseId: checkout.releaseId,
            promoted: true,
            satisfiedGates: evaluation.satisfied,
            activeDeployment: active,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          {
            tool: "deploy/release",
            command: "promote",
            target,
            releaseId: checkout.releaseId,
            promoted: true,
            satisfiedGates: evaluation.satisfied,
            note: "ci is a check phase: the promotion decision is journaled (no hosting pointer)",
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    if (error instanceof ReleaseControlError) {
      // The governed transition refused (missing gates/journal) — the
      // refusal is already journaled or typed; report honestly.
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.close();
  }
}

async function commandRollback(environment: HostingEnvironment, actor: string): Promise<void> {
  const manifest = loadManifest();
  const policy = loadReleasePolicy(
    readFileSync(`${REPOSITORY_ROOT}/deploy/manifests/release-policy.json`, "utf8"),
    manifest,
  );
  const { store, db } = await openStore(environment);
  try {
    const active = await store.activeDeployment(environment);
    if (active === null) {
      console.error(`error: no active deployment for ${environment} (nothing to roll back)`);
      process.exit(1);
    }
    const requested = stringOption(process.argv, "--to");
    let target: string | undefined = requested;
    if (target === undefined) {
      // Default: the most recent OTHER environment deployment bound
      // to this environment (the previous releasable state).
      const inspection = await store.inspectRelease(active.releaseId);
      void inspection;
      const deployments = await db.execute<{
        readonly release_id: string;
        readonly recorded_at: string;
      }>({
        sql: `SELECT release_id, recorded_at FROM release_control.environment_deployments
WHERE environment = $1 AND release_id <> $2
ORDER BY recorded_at DESC, release_id DESC LIMIT 1`,
        parameters: [environment, active.releaseId],
      });
      target = deployments.rows[0]?.release_id;
    }
    if (target === undefined) {
      console.error(`error: no rollback target found for ${environment}; specify --to <releaseId>`);
      process.exit(1);
    }
    const reason = stringOption(process.argv, "--reason") ?? "operator rollback";
    const result = await store.rollback({
      environment,
      toReleaseId: target,
      requiredGates: policy.entryGates[environment],
      reason,
      actor,
    });
    console.log(
      JSON.stringify(
        {
          tool: "deploy/release",
          command: "rollback",
          environment,
          fromReleaseId: active.releaseId,
          toReleaseId: target,
          reason,
          activeDeployment: result,
          note: "deployment-state rollback: the release_control pointer flipped + the rollback event journaled; durable domain state is untouched",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (error instanceof ReleaseControlError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.close();
  }
}

async function commandInspect(environment?: HostingEnvironment, releaseId?: string): Promise<void> {
  const target: HostingEnvironment = environment ?? "local";
  const { store, db } = await openStore(target);
  try {
    const inspection =
      releaseId !== undefined ? await store.inspectRelease(releaseId) : await store.inspect();
    console.log(
      JSON.stringify({ tool: "deploy/release", command: "inspect", inspection }, null, 2),
    );
  } finally {
    await db.close();
  }
}

async function commandStatus(environment: HostingEnvironment): Promise<void> {
  const manifest = loadManifest();
  const policy = loadReleasePolicy(
    readFileSync(`${REPOSITORY_ROOT}/deploy/manifests/release-policy.json`, "utf8"),
    manifest,
  );
  const { store, db } = await openStore(environment);
  try {
    const checkout = checkoutRelease();
    const active = await store.activeDeployment(environment);
    let alerts: readonly OperationalAlert[] = [];
    try {
      alerts = await evaluateAlerts(db, environment);
    } catch {
      // Fresh/empty database: no snapshots yet — honest empty alert set.
    }
    const readiness = Object.entries(policy.entryGates).map(([phase, gates]) => ({
      phase,
      requiredGates: gates,
    }));
    const effective = await store.effectiveGateResults(checkout.releaseId, environment);
    const evaluation = evaluatePromotion(environment, effective, policy);
    console.log(
      JSON.stringify(
        {
          tool: "deploy/release",
          command: "status",
          environment,
          checkoutReleaseId: checkout.releaseId,
          gitRevision: checkout.gitRevision,
          active,
          ladder: readiness,
          promotionToEnvironment: {
            allowed: evaluation.allowed,
            missing: evaluation.missing,
          },
          alerts,
          criticalAlerts: alerts.filter((alert) => alert.severity === "critical").length,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

async function commandAlerts(environment: HostingEnvironment): Promise<void> {
  const { store: _store, db } = await openStore(environment);
  void _store;
  try {
    const alerts = await evaluateAlerts(db, environment);
    console.log(
      JSON.stringify(
        {
          tool: "deploy/release",
          command: "alerts",
          environment,
          alerts,
          critical: hasCriticalAlert(alerts),
        },
        null,
        2,
      ),
    );
    process.exit(hasCriticalAlert(alerts) ? 1 : 0);
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = requireReleaseCommand(argv);
  const actor = stringOption(argv, "--actor") ?? ACTOR_DEFAULT;
  const environmentOption = stringOption(argv, "--environment");

  if (command === "record") {
    await commandRecord(requireHostingEnvironment(environmentOption), actor);
    return;
  }
  if (command === "gate") {
    const subcommand = argv[argv.indexOf("gate") + 1];
    if (subcommand !== "run" && subcommand !== "attach") {
      console.error("error: gate requires run | attach");
      process.exit(2);
    }
    const kind = stringOption(argv, "--kind");
    if (kind === undefined) {
      console.error("error: gate requires --kind <gate-kind> (see release-policy.json)");
      process.exit(2);
    }
    await commandGate(subcommand, kind, requireReleasePhase(environmentOption), actor);
    return;
  }
  if (command === "promote") {
    const target = stringOption(argv, "--to");
    if (target === undefined || !isReleasePhase(target)) {
      console.error("error: promote requires --to <local|ci|preview|staging|production>");
      process.exit(2);
    }
    await commandPromote(target, actor);
    return;
  }
  if (command === "rollback") {
    await commandRollback(requireHostingEnvironment(environmentOption), actor);
    return;
  }
  if (command === "inspect") {
    const env =
      environmentOption === undefined ? undefined : requireHostingEnvironment(environmentOption);
    await commandInspect(env, stringOption(argv, "--release"));
    return;
  }
  if (command === "status") {
    await commandStatus(requireHostingEnvironment(environmentOption));
    return;
  }
  if (command === "alerts") {
    await commandAlerts(requireHostingEnvironment(environmentOption));
    return;
  }
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  await main().catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
}
