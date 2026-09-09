/**
 * deploy/drill — the D-07 resilience/disaster-recovery operator
 * surface (WORK-048).
 *
 * Commands (all fail closed; all read/write through the PostgreSQL
 * authority — providers are mechanisms):
 *
 *   authority-loss    — the executed restore drill: backup the live
 *                       authority → restore into a FRESH DISPOSABLE
 *                       target (migrations + data + self-verification)
 *                       → the D-07 authority-invariant gate → cleanup.
 *                       The live source is NEVER touched (the safe
 *                       operator form of the total-loss procedure).
 *   artifact-exit     — the R2 → alternate S3-compatible artifact-
 *                       store substitution proof: scan the adoption
 *                       ledger (authority) → migrate bytes content-
 *                       addressed → verify identity + lineage at the
 *                       alternate. NOT RUN without both endpoints.
 *   queue-recovery    — the transport-loss recovery plan from the
 *                       authority: classify every dispatch envelope;
 *                       when the transport configuration exists, the
 *                       bounded republish executes through the real
 *                       adapter; otherwise the transport half is
 *                       reported NOT RUN (honest, never a PASS).
 *   worker-evacuation — evacuate one region's workers (drain or
 *                       fence) through the durable compute plane +
 *                       the lease force-release seam; stale workers
 *                       are fenced at the authority.
 *   outage-readiness  — the fail-closed readiness gate: the recovery
 *                       targets load and cover every environment.
 *
 * RTO/RPO are MEASURED per drill and evaluated against
 * deploy/manifests/recovery-targets.json (repository truth). Every
 * report records the exact Git revision. Secrets resolve from the
 * environment immediately before authorized adapter use and never
 * appear in output.
 *
 * Usage:
 *   bun run deploy:drill -- authority-loss    [--environment local] [--out <backup.json>] [--keep-target]
 *   bun run deploy:drill -- artifact-exit     [--environment local]
 *   bun run deploy:drill -- queue-recovery    [--environment local] [--limit 100]
 *   bun run deploy:drill -- worker-evacuation [--environment local] --region <label> [--mode drain|fence]
 *   bun run deploy:drill -- outage-readiness  [--environment local]
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { createBudgetRecoveryInvariants } from "../src/modules/budgets/adapters/recovery-invariants";
import {
  createArtifactInventorySource,
  createArtifactLedgerRecoveryInvariants,
} from "../src/modules/deployments/adapters/recovery-inventory";
import { createLeaseEvacuationSeam } from "../src/modules/executions/adapters/evacuation-seam";
import { createExecutionRecoveryInvariants } from "../src/modules/executions/adapters/recovery-invariants";
import { SqlLongRunningExecutionStore } from "../src/modules/executions/adapters/sql-long-running-store";
import { EXECUTION_STATES } from "../src/modules/executions/public";
import { loadWorkerPolicy } from "../src/platform/compute/config";
import { SqlComputeWorkerStore } from "../src/platform/compute/pg-store";
import {
  createLogicalBackup,
  type LogicalBackup,
  restoreDataIntoCurrentState,
} from "../src/platform/db/backup";
import { parseConnectionConfig, redactConnectionString } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import {
  authoritativeSchemas,
  shippedMigrations,
  startAuthoritativeDatabase,
  verifySchemaConvergence,
} from "../src/platform/db/startup";
import { evaluateEnvironmentContract } from "../src/platform/deployment/env-contract";
import {
  createS3ObjectStore,
  type S3ObjectStoreConfig,
} from "../src/platform/object-store/s3-object-store";
import {
  createCloudflareQueuesTransport,
  loadCloudflareQueuesRuntimeConfig,
} from "../src/platform/queue/cloudflare-queues";
import { loadQueueRetryPolicy } from "../src/platform/queue/config";
import { QueueCorrelationStore } from "../src/platform/queue/correlation";
import { createDurableDispatcher } from "../src/platform/queue/dispatcher";
import {
  recoverArtifactBytes,
  verifyArtifactInventory,
} from "../src/platform/recovery/artifact-recovery";
import { verifyRecoveredAuthority } from "../src/platform/recovery/authority-verification";
import { type DrillPhaseSpec, runRecoveryDrill } from "../src/platform/recovery/drill";
import { RegionalWorkerEvacuator } from "../src/platform/recovery/evacuation";
import {
  evaluateDrillAgainstTarget,
  parseRecoveryTargets,
  recoveryTargetFor,
} from "../src/platform/recovery/rto-rpo";
import { planTransportRecovery } from "../src/platform/recovery/transport-recovery";
import {
  asSecretReference,
  createEnvSecretStore,
} from "../src/platform/secret-store/adapters/env-secret-store";
import { gitRevision, loadManifest, REPOSITORY_ROOT, requireEnvironment } from "./lib";
import { validateDeploymentConfiguration } from "./validate";

type DrillCommand =
  | "authority-loss"
  | "artifact-exit"
  | "queue-recovery"
  | "worker-evacuation"
  | "outage-readiness";

const DRILL_COMMANDS: readonly DrillCommand[] = [
  "authority-loss",
  "artifact-exit",
  "queue-recovery",
  "worker-evacuation",
  "outage-readiness",
];

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolve the drill's authoritative PostgreSQL URL for one environment. */
function authorityUrlFor(environment: string): string {
  if (environment === "local") {
    const adminUrl = process.env.ZECK_PG_ADMIN_URL ?? "";
    if (adminUrl.length === 0) {
      console.error("error: ZECK_PG_ADMIN_URL is required for local drills (see deploy/README.md)");
      process.exit(2);
    }
    return `${adminUrl.replace(/\/[^/]*$/, "")}/zeck_local`;
  }
  const url = process.env.ZECK_DATABASE_URL ?? "";
  if (url.length === 0) {
    console.error(
      "error: provider-environment drills require the materialized ZECK_DATABASE_URL (credential-shaped, environment-only)",
    );
    process.exit(2);
  }
  return url;
}

async function withAuthorityPort<T>(
  url: string,
  work: (port: PgDatabasePort) => Promise<T>,
): Promise<T> {
  const config = parseConnectionConfig(url, { max: 4 });
  const adapter = new PgDatabasePort(config);
  try {
    return await work(adapter);
  } finally {
    await adapter.close();
  }
}

interface DisposalTarget {
  readonly name: string;
  readonly adminUrl: string;
}

async function createDisposalTarget(adminUrl: string): Promise<DisposalTarget> {
  const name = `zeck_drill_restore_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  return { name, adminUrl };
}

async function dropDisposalTarget(target: DisposalTarget): Promise<void> {
  const client = new Client({ connectionString: target.adminUrl });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [target.name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${target.name}`);
  } finally {
    await client.end();
  }
}

/**
 * The alternate (substitution-target) object-store configuration for
 * the artifact-exit drill. Credential-shaped values are
 * environment-only materialization; missing configuration is an
 * honest NOT RUN, never a PASS.
 */
function alternateObjectStoreFromEnvironment(): S3ObjectStoreConfig {
  const missing: string[] = [];
  const values = {
    endpoint: process.env.ZECK_DRILL_ALTERNATE_OBJECT_STORE_ENDPOINT,
    bucket: process.env.ZECK_DRILL_ALTERNATE_OBJECT_STORE_BUCKET,
    region: process.env.ZECK_DRILL_ALTERNATE_OBJECT_STORE_REGION,
    accessKeyId: process.env.ZECK_DRILL_ALTERNATE_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: process.env.ZECK_DRILL_ALTERNATE_OBJECT_STORE_SECRET_ACCESS_KEY,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value.length === 0) {
      missing.push(
        `ZECK_DRILL_ALTERNATE_OBJECT_STORE_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
      );
    }
  }
  if (missing.length > 0) {
    console.error(
      `error: artifact-exit requires the alternate object-store configuration; missing: ${missing.join(", ")} (NOT RUN without it — never claimed as PASS)`,
    );
    process.exit(2);
  }
  return values as unknown as S3ObjectStoreConfig;
}

/**
 * Resolve the OPERATIVE (migration source) object store. Local has no
 * operative S3-compatible endpoint by design (local artifacts are
 * filesystem-scoped) — that boundary is an honest NOT RUN.
 */
async function operativeObjectStoreFor(environment: string): Promise<S3ObjectStoreConfig> {
  if (environment === "local") {
    throw new Error(
      "the local environment defines no operative S3-compatible object-store endpoint (local artifacts are filesystem-scoped); run artifact-exit from an environment with a real endpoint",
    );
  }
  const endpoint = process.env.ZECK_OBJECT_STORE_ENDPOINT;
  const bucket = process.env.ZECK_OBJECT_STORE_BUCKET;
  const region = process.env.ZECK_OBJECT_STORE_REGION;
  const missing: string[] = [];
  for (const [name, value] of [
    ["ZECK_OBJECT_STORE_ENDPOINT", endpoint],
    ["ZECK_OBJECT_STORE_BUCKET", bucket],
    ["ZECK_OBJECT_STORE_REGION", region],
  ] as const) {
    if (value === undefined || value.length === 0) {
      missing.push(name);
    }
  }
  const secretStore = createEnvSecretStore({
    environment,
    env: process.env,
    materialization: {
      "object-store-access-key-id": "ZECK_OBJECT_STORE_ACCESS_KEY_ID",
      "object-store-secret-access-key": "ZECK_OBJECT_STORE_SECRET_ACCESS_KEY",
    },
  });
  const accessKeyId = (
    await secretStore.resolve(
      asSecretReference(`zeck-secret://${environment}/object-store-access-key-id`),
    )
  ).plaintext;
  const secretAccessKey = (
    await secretStore.resolve(
      asSecretReference(`zeck-secret://${environment}/object-store-secret-access-key`),
    )
  ).plaintext;
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    missing.push("ZECK_OBJECT_STORE_ACCESS_KEY_ID", "ZECK_OBJECT_STORE_SECRET_ACCESS_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `operative object-store configuration is not materialized: ${missing.join(", ")}`,
    );
  }
  return {
    endpoint: endpoint as string,
    bucket: bucket as string,
    region: region as string,
    accessKeyId,
    secretAccessKey,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] as DrillCommand;
  if (!DRILL_COMMANDS.includes(command)) {
    console.error(
      "error: command required: authority-loss | artifact-exit | queue-recovery | worker-evacuation | outage-readiness",
    );
    process.exit(2);
  }
  const environment = requireEnvironment(argv);
  const manifest = loadManifest();
  const contract = evaluateEnvironmentContract(manifest, environment, process.env);
  if (!contract.satisfied) {
    console.error(
      `error: the environment contract is not satisfied: ${contract.problems.join("; ")}`,
    );
    process.exit(2);
  }

  const revision = gitRevision();
  const targets = parseRecoveryTargets(
    readFileSync(resolve(REPOSITORY_ROOT, "deploy", "manifests", "recovery-targets.json"), "utf8"),
  );
  const target = recoveryTargetFor(targets, environment);
  const startedAt = new Date();
  const phases: DrillPhaseSpec[] = [];
  const notRun: string[] = [];
  let drillOutput: Record<string, unknown> = {};

  if (command === "authority-loss") {
    const keepTarget = hasFlag(argv, "--keep-target");
    const outPath =
      argumentValue(argv, "--out") ?? `/tmp/zeck-drill-backup-${randomUUID().slice(0, 8)}.json`;
    const sourceUrl = authorityUrlFor(environment);
    const adminUrl = `${sourceUrl.replace(/\/[^/]*$/, "")}/postgres`;
    let backupArtifact: LogicalBackup | null = null;
    let restoreTargetName = "";

    phases.push({
      name: "authority-backup",
      description: "the logical backup of the live authoritative state (port-based, checksummed)",
      action: async () => {
        await withAuthorityPort(sourceUrl, async (port) => {
          const migrations = shippedMigrations();
          await verifySchemaConvergence(port, migrations);
          const backup = await createLogicalBackup(port, authoritativeSchemas(migrations));
          writeFileSync(outPath, JSON.stringify(backup, null, 2), { encoding: "utf8" });
          backupArtifact = backup;
          drillOutput = {
            ...drillOutput,
            backup: {
              artifact: outPath,
              tables: backup.tables.length,
              rows: backup.tables.reduce((total, table) => total + table.rowCount, 0),
              migrations: backup.migrationHistory.length,
              createdAt: backup.createdAt,
            },
          };
        });
      },
    });
    phases.push({
      name: "authority-restore",
      description:
        "deterministic migrations + one-transaction data restore into a fresh disposable target",
      action: async () => {
        if (backupArtifact === null) {
          throw new Error(
            "the backup phase did not produce an artifact (internal ordering defect)",
          );
        }
        const targetDb = await createDisposalTarget(adminUrl);
        restoreTargetName = targetDb.name;
        drillOutput = { ...drillOutput, restoreTarget: targetDb.name };
        const targetUrl = `${adminUrl.replace(/\/[^/]*$/, "")}/${targetDb.name}`;
        const handle = await startAuthoritativeDatabase(targetUrl, { poolOverrides: { max: 4 } });
        try {
          const outcome = await restoreDataIntoCurrentState(handle.port, backupArtifact);
          if (!outcome.verification.every((entry) => entry.verified)) {
            throw new Error("restore self-verification failed (checksum drift detected)");
          }
          drillOutput = {
            ...drillOutput,
            restore: {
              tablesRestored: outcome.tables.length,
              rowsRestored: outcome.tables.reduce((total, table) => total + table.rows, 0),
              sequencesReseeded: outcome.sequencesReseeded,
              allTablesVerified: true,
            },
          };
        } finally {
          await handle.close();
        }
      },
    });
    phases.push({
      name: "authority-invariants",
      description:
        "the D-07 recovered-authority invariant gate (state machine, ledgers, vocabularies, chains)",
      action: async () => {
        if (restoreTargetName.length === 0) {
          throw new Error("no restore target recorded (internal ordering defect)");
        }
        const targetUrl = `${adminUrl.replace(/\/[^/]*$/, "")}/${restoreTargetName}`;
        const handle = await startAuthoritativeDatabase(targetUrl, { poolOverrides: { max: 4 } });
        try {
          const report = await verifyRecoveredAuthority(handle.port, {
            expectedMigrationCount: shippedMigrations().length,
            moduleInvariants: [
              createExecutionRecoveryInvariants(handle.port, EXECUTION_STATES),
              createBudgetRecoveryInvariants(handle.port),
              createArtifactLedgerRecoveryInvariants(handle.port),
            ],
          });
          drillOutput = { ...drillOutput, authorityInvariants: report };
          if (!report.verified) {
            const violations = report.violations
              .map((violation) => `${violation.check}: ${violation.detail}`)
              .join("; ");
            throw new Error(`recovered-authority invariant violations: ${violations}`);
          }
        } finally {
          await handle.close();
        }
      },
    });
    phases.push({
      name: "cleanup",
      description: "drop the disposable recovery target (the live source was never touched)",
      action: async () => {
        if (keepTarget || restoreTargetName.length === 0) {
          drillOutput = {
            ...drillOutput,
            cleanup: restoreTargetName.length === 0 ? "no target" : "kept (operator --keep-target)",
          };
          return;
        }
        await dropDisposalTarget({ name: restoreTargetName, adminUrl });
        drillOutput = { ...drillOutput, cleanup: "dropped" };
      },
    });
  }

  if (command === "artifact-exit") {
    const alternate = alternateObjectStoreFromEnvironment();
    const authorityUrl = authorityUrlFor(environment);
    if (environment === "local") {
      notRun.push(
        "operative object-store endpoint: the local environment defines no operative S3-compatible endpoint (local artifacts are filesystem-scoped); the artifact-exit drill requires a real source endpoint",
      );
    }
    let operativeConfig: S3ObjectStoreConfig | null = null;

    phases.push({
      name: "inventory-scan",
      description:
        "scan the authoritative adoption ledger (PostgreSQL is the recovery source of truth)",
      action: async () => {
        await withAuthorityPort(authorityUrl, async (port) => {
          const scan = await createArtifactInventorySource(port).scan();
          if (scan.malformedDigests.length > 0) {
            throw new Error(
              `the authority carries malformed artifact digests (keys: ${scan.malformedDigests.join(", ")})`,
            );
          }
          drillOutput = { ...drillOutput, inventory: { entries: scan.entries.length } };
          if (scan.entries.length === 0) {
            throw new Error(
              "the adoption ledger is empty; the artifact-exit drill requires adopted artifacts to prove substitution",
            );
          }
        });
      },
    });
    phases.push({
      name: "byte-migration",
      description:
        "content-addressed byte migration source → alternate with digest verification at both ends",
      action: async () => {
        if (operativeConfig === null) {
          operativeConfig = await operativeObjectStoreFor(environment);
        }
        const sourceStore = createS3ObjectStore(operativeConfig);
        await withAuthorityPort(authorityUrl, async (port) => {
          const inventory = await createArtifactInventorySource(port).scan();
          const alternateStore = createS3ObjectStore(alternate);
          const report = await recoverArtifactBytes(
            sourceStore,
            alternateStore,
            inventory.entries,
            digestOf,
          );
          drillOutput = { ...drillOutput, migration: report };
          if (!report.completed) {
            const failures = report.failures
              .map((failure) => `${failure.key}: ${failure.reason}`)
              .join("; ");
            throw new Error(
              `artifact byte migration failed (identity/lineage not preserved): ${failures}`,
            );
          }
        });
      },
    });
    phases.push({
      name: "target-verification",
      description:
        "verify the alternate store against the authority (content identity) and the lineage binding",
      action: async () => {
        const alternateStore = createS3ObjectStore(alternate);
        await withAuthorityPort(authorityUrl, async (port) => {
          const inventorySource = createArtifactInventorySource(port);
          const inventory = await inventorySource.scan();
          const verification = await verifyArtifactInventory(
            alternateStore,
            inventory.entries,
            digestOf,
          );
          const lineage = await inventorySource.verifyLineagePreservation(inventory.entries);
          drillOutput = { ...drillOutput, targetVerification: verification, lineage };
          if (!verification.recovered) {
            throw new Error(
              `alternate store verification failed (missing: ${verification.missing.join(", ") || "none"}; corrupt: ${verification.corrupt.join(", ") || "none"})`,
            );
          }
          if (!lineage.preservedAll) {
            throw new Error(`lineage preservation failed for keys: ${lineage.broken.join(", ")}`);
          }
        });
      },
    });
  }

  if (command === "queue-recovery") {
    const limit = Number.parseInt(argumentValue(argv, "--limit") ?? "1000", 10);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error("error: --limit must be a positive integer");
      process.exit(2);
    }
    const authorityUrl = authorityUrlFor(environment);
    const transportConfigured =
      environment !== "local" &&
      (process.env.ZECK_QUEUE_ID ?? "").length > 0 &&
      (process.env.ZECK_QUEUE_API_TOKEN ?? "").length > 0;
    if (!transportConfigured) {
      notRun.push(
        "transport republish half: no queue transport configuration is materialized for this environment (the bounded recovery plan from the authority is the executed half; republish is NOT RUN — never claimed as PASS)",
      );
    }

    phases.push({
      name: "recovery-plan",
      description:
        "classify every durable dispatch envelope by its recovery class (fail closed on drift)",
      action: async () => {
        await withAuthorityPort(authorityUrl, async (port) => {
          const plan = await planTransportRecovery(port, limit);
          drillOutput = {
            ...drillOutput,
            transportPlan: {
              items: plan.items.length,
              byClass: plan.byClass,
              complete: plan.planned,
            },
          };
          if (!plan.planned) {
            throw new Error(
              "the recovery plan hit its bounded limit before classifying every envelope (raise --limit)",
            );
          }
        });
      },
    });
    if (transportConfigured) {
      phases.push({
        name: "republish-outstanding",
        description:
          "bounded republish of recorded/backlogged envelopes through the real transport adapter",
        action: async () => {
          // The token is the materialized queue-api-token secret (the
          // environment-only credential; resolved immediately before
          // adapter use — the same fail-closed path as deploy:queue).
          const token = process.env.ZECK_QUEUE_API_TOKEN ?? "";
          if (token.length === 0) {
            throw new Error(
              "ZECK_QUEUE_API_TOKEN is not materialized (the queue-api-token secret value); the republish half cannot run — this is reported NOT RUN, never a PASS",
            );
          }
          const config = loadCloudflareQueuesRuntimeConfig(process.env);
          const transport = createCloudflareQueuesTransport(config);
          await withAuthorityPort(authorityUrl, async (port) => {
            const store = new QueueCorrelationStore(port);
            const dispatcher = createDurableDispatcher({
              store,
              transport,
              policy: loadQueueRetryPolicy(process.env),
              generateId: () => randomUUID(),
              now: () => new Date(),
            });
            const outcomes = await dispatcher.republishPending(limit);
            drillOutput = {
              ...drillOutput,
              republish: {
                published: outcomes.filter((outcome) => outcome.published).length,
                stillBacklogged: outcomes.filter((outcome) => !outcome.published).length,
              },
            };
          });
        },
      });
    }
  }

  if (command === "worker-evacuation") {
    const region = argumentValue(argv, "--region");
    const mode = argumentValue(argv, "--mode") ?? "fence";
    if (region === undefined || region.length === 0) {
      console.error("error: --region <label> is required for worker-evacuation");
      process.exit(2);
    }
    if (mode !== "drain" && mode !== "fence") {
      console.error("error: --mode must be drain or fence");
      process.exit(2);
    }
    const authorityUrl = authorityUrlFor(environment);

    phases.push({
      name: "evacuate-region",
      description:
        "retire/drain the region's workers, abandon live claims, force-release their leases (the fence)",
      action: async () => {
        await withAuthorityPort(authorityUrl, async (port) => {
          // The repository-validated worker policy defaults (bounded
          // by the platform's own WORKER_POLICY_BOUNDS).
          const policy = loadWorkerPolicy({});
          const store = new SqlComputeWorkerStore({
            db: port,
            maxClaimAttempts: policy.maxClaimAttempts,
            defaultEnvironmentQuota: policy.defaultEnvironmentQuota,
            claimRetentionMs: policy.claimRetentionMs,
            generateId: () => randomUUID(),
          });
          const leaseStore = new SqlLongRunningExecutionStore(port);
          const evacuator = new RegionalWorkerEvacuator({
            store,
            lease: createLeaseEvacuationSeam(leaseStore),
            now: () => new Date(),
          });
          const report = await evacuator.evacuate({ region, mode });
          drillOutput = { ...drillOutput, evacuation: report };
        });
      },
    });
    phases.push({
      name: "fence-verification",
      description:
        "every abandoned execution's lease is released and its claim is abandoned (stale workers fenced)",
      action: async () => {
        await withAuthorityPort(authorityUrl, async (port) => {
          const evacuation = drillOutput.evacuation as {
            abandonedClaims: readonly {
              claimId: string;
              executionId: string;
              applicationId: string;
              leaseReleased: boolean;
            }[];
          };
          const leaseStore = new SqlLongRunningExecutionStore(port);
          const released: string[] = [];
          const pending: string[] = [];
          for (const claim of evacuation.abandonedClaims) {
            const lease = await leaseStore.getLease(claim.applicationId, claim.executionId);
            const isReleased = lease !== null && lease.releasedAt !== null;
            if (isReleased) {
              released.push(claim.executionId);
            } else {
              pending.push(claim.executionId);
            }
          }
          drillOutput = {
            ...drillOutput,
            fenceVerification: {
              releasedLeases: released.length,
              unreleasedLeases: pending.length,
            },
          };
          if (pending.length > 0) {
            throw new Error(
              `${pending.length} evacuated executions still hold live leases (stale workers are NOT fenced)`,
            );
          }
        });
      },
    });
  }

  if (command === "outage-readiness") {
    phases.push({
      name: "recovery-targets",
      description: "the repository recovery targets load, are bounded, and cover this environment",
      action: async () => {
        drillOutput = {
          ...drillOutput,
          targets: {
            environment,
            rtoTargetMs: target.rtoTargetMs,
            rpoTargetMs: target.rpoTargetMs,
            scope: target.scope,
            environments: Object.keys(targets.targets),
          },
        };
      },
    });
    phases.push({
      name: "drill-surface",
      description:
        "the drill machinery is wired (package script + manifest validation + this tool)",
      action: async () => {
        const report = validateDeploymentConfiguration();
        drillOutput = { ...drillOutput, deploymentValidation: report };
        if (!report.valid) {
          throw new Error(`the deployment configuration is invalid: ${report.problems.join("; ")}`);
        }
      },
    });
  }

  const report = await runRecoveryDrill(
    {
      scenarioId: command,
      environment,
      revision,
      lossAt: startedAt,
      lastConsistentPointAt: command === "authority-loss" ? startedAt : null,
      phases,
    },
    { now: () => new Date() },
  );
  // Objective evaluation applies only to LOSS scenarios (outage-
  // readiness is a configuration gate, not a recovery measurement).
  const measuresObjectives = command !== "outage-readiness";
  const evaluation = measuresObjectives ? evaluateDrillAgainstTarget(report, target) : null;
  const output = {
    tool: "deploy/drill",
    command,
    environment,
    revision,
    drill: report,
    objectives:
      evaluation === null
        ? {
            measured: false,
            note: "readiness gate: RTO/RPO are measured by the loss scenarios (authority-loss, artifact-exit, queue-recovery, worker-evacuation)",
            target: { rtoTargetMs: target.rtoTargetMs, rpoTargetMs: target.rpoTargetMs },
          }
        : {
            measured: true,
            target: { rtoTargetMs: target.rtoTargetMs, rpoTargetMs: target.rpoTargetMs },
            evaluation,
          },
    notRun,
    ...drillOutput,
  };
  console.log(JSON.stringify(output, null, 2));
  const objectiveBreaches = evaluation?.breaches.length ?? 0;
  if (!report.recovered || objectiveBreaches > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${redactConnectionString((error as Error).message)}`);
  process.exit(1);
});
