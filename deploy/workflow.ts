/**
 * deploy/workflow — the D-04 durable-orchestration operator surface
 * (WORK-045).
 *
 * Commands (all fail closed; all read/write through the PostgreSQL
 * authority — the provider is orchestration transport only):
 *
 *   inspect  — the observational orchestration snapshot (read-only;
 *              never redefines execution state) + the explicit
 *              provider limits + the exact Git revision (the
 *              exact-revision workflow verification record).
 *   scan     — arm orchestration waits for authoritative waiting
 *              executions (durable correlation BEFORE any provider
 *              instance; idempotent; bounded replacement budget).
 *   recover  — the restart/outage recovery scan: re-drive deferred
 *              instance starts, re-apply pending governed effects,
 *              re-deliver undelivered provider signals within their
 *              budgets, supersede stale waits, apply due deadlines.
 *   compact  — bounded provider-state compaction: terminate the
 *              provider instances of terminal waits; report the
 *              folded-notification counters.
 *   probe    — the real orchestration round trip (create → observe →
 *              terminate) on the DEDICATED operator-owned probe
 *              workflow (ZECK_WORKFLOW_PROBE_NAME); never the
 *              orchestration workflow.
 *
 * Composition root: this tool wires the platform pieces the frozen
 * dependency rules keep separate — the DatabasePort adapter from the
 * materialized database-url secret, the Cloudflare Workflows adapter
 * from the materialized workflow-api-token secret + ordinary
 * configuration, the correlation store, the coordinator and the
 * executions module's governed effect + candidate source. Secrets
 * are resolved from the environment immediately before the
 * authorized adapter call; they never appear in output, errors or
 * logs.
 *
 * Usage:
 *   bun run deploy:workflow -- inspect  [--environment local]
 *   bun run deploy:workflow -- scan     [--environment local] [--limit 100]
 *   bun run deploy:workflow -- recover  [--environment local] [--limit 100]
 *   bun run deploy:workflow -- compact  [--environment local] [--limit 100]
 *   bun run deploy:workflow -- probe    [--environment preview]
 */

import { createOrchestrationSource } from "../src/modules/executions/adapters/orchestration-source";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../src/modules/executions/adapters/sql-execution-store";
import { createOrchestrationResolutionEffect } from "../src/modules/executions/adapters/workflow-effect";
import { createExecutionService } from "../src/modules/executions/application/execution-service";
import { parseConnectionConfig } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import {
  asSecretReference,
  createEnvSecretStore,
  SecretResolutionError,
} from "../src/platform/secret-store/adapters/env-secret-store";
import {
  createCloudflareWorkflowsTransport,
  loadCloudflareWorkflowsRuntimeConfig,
} from "../src/platform/workflow/cloudflare-workflows";
import { loadWorkflowRetryPolicy, loadWorkflowStateBounds } from "../src/platform/workflow/config";
import { WorkflowCorrelationStore } from "../src/platform/workflow/correlation";
import { createOrchestrationCoordinator } from "../src/platform/workflow/engine";
import { inspectWorkflowOrchestration } from "../src/platform/workflow/inspection";
import { createUuidv7Generator } from "../src/shared/ids";
import { gitRevision, requireEnvironment } from "./lib";

/**
 * The orchestrator actor identity for tooling-driven resolution. A
 * stable well-formed UUID placeholder is fine for provenance (the
 * actor is recorded on every governed transition; it is not a
 * credential and carries no authority).
 */
const TOOL_ORCHESTRATOR_ACTOR_ID = "00000000-0000-7000-8000-0000000000ed";

function requireCommand(argv: readonly string[]): string {
  const command = argv[0];
  if (
    command !== "inspect" &&
    command !== "scan" &&
    command !== "recover" &&
    command !== "compact" &&
    command !== "probe"
  ) {
    console.error(
      "error: command required: inspect | scan | recover [--limit N] | compact [--limit N] | probe",
    );
    process.exit(2);
  }
  return command;
}

function numericOption(argv: readonly string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return fallback;
  }
  const value = Number.parseInt(argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`error: ${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

/** The default wait deadline policy (ZECK_WORKFLOW_WAIT_TIMEOUT_MS; 0 = none). */
function waitTimeoutMs(): number {
  const raw = process.env.ZECK_WORKFLOW_WAIT_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 2_592_000_000) {
    console.error("error: ZECK_WORKFLOW_WAIT_TIMEOUT_MS must be an integer in [0, 2592000000]");
    process.exit(2);
  }
  return value;
}

/** Resolve the materialized database-url secret through the secret store. */
async function authoritativeDatabaseUrl(environment: string): Promise<string> {
  const store = createEnvSecretStore({ environment, env: process.env });
  try {
    const resolved = await store.resolve(
      asSecretReference(`zeck-secret://${environment}/database-url`),
    );
    return resolved.plaintext;
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error: database-url resolution failed: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}

interface WorkflowToolContext {
  readonly command: string;
  readonly environment: string;
}

async function withAuthoritativeDatabase<T>(
  context: WorkflowToolContext,
  work: (db: PgDatabasePort) => Promise<T>,
): Promise<T> {
  const url = await authoritativeDatabaseUrl(context.environment);
  const config = parseConnectionConfig(url, {
    max: 4,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10_000,
  });
  const db = new PgDatabasePort(config);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

/** Build the workflow transport when provider configuration exists. */
function transportFromEnvironment() {
  try {
    const config = loadCloudflareWorkflowsRuntimeConfig(process.env);
    return createCloudflareWorkflowsTransport(config);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** Build the coordinator over the authoritative database + provider. */
function coordinatorFromEnvironment(db: PgDatabasePort, generateId: () => string) {
  const transport = transportFromEnvironment();
  const executionStore = new SqlExecutionStore(db);
  const service = createExecutionService({
    store: executionStore,
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: { evaluate: async () => ({ allowed: true }) },
    generateId,
    now: () => new Date(),
  });
  const effect = createOrchestrationResolutionEffect({
    service,
    orchestratorActorId: TOOL_ORCHESTRATOR_ACTOR_ID,
  });
  const source = createOrchestrationSource({
    db,
    deadlines: { waitTimeoutMs: waitTimeoutMs() },
    now: () => new Date(),
  });
  return createOrchestrationCoordinator({
    store: new WorkflowCorrelationStore(db),
    workflow: transport,
    effect,
    source,
    policy: loadWorkflowRetryPolicy(process.env),
    bounds: loadWorkflowStateBounds(process.env),
    generateId,
    now: () => new Date(),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = requireCommand(argv);
  const environment = requireEnvironment(argv);
  const context: WorkflowToolContext = { command, environment };
  const limit = numericOption(argv, "--limit", 100);
  const generateId = createUuidv7Generator();
  const revision = gitRevision();

  if (command === "probe") {
    const transport = transportFromEnvironment();
    const probeWorkflowName = process.env.ZECK_WORKFLOW_PROBE_NAME;
    if (probeWorkflowName === undefined || probeWorkflowName.trim().length === 0) {
      console.error(
        "error: probe requires ZECK_WORKFLOW_PROBE_NAME (the dedicated operator-owned probe workflow; the orchestration probe never targets the orchestration workflow — see deploy/README.md)",
      );
      process.exit(1);
    }
    const probe = await transport.probe();
    console.log(
      JSON.stringify(
        { tool: "deploy/workflow", command, environment, gitRevision: revision, probe },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "inspect") {
    await withAuthoritativeDatabase(context, async (db) => {
      const snapshot = await inspectWorkflowOrchestration(db);
      const limits = transportFromEnvironment().describeLimits();
      console.log(
        JSON.stringify(
          {
            tool: "deploy/workflow",
            command,
            environment,
            gitRevision: revision,
            correlationModel:
              "wait:<executionId>:<kind>:<ordinal> (durable PostgreSQL wait BEFORE any provider instance; provider instances carry only the pointer)",
            snapshot,
            providerLimits: limits,
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "scan") {
    await withAuthoritativeDatabase(context, async (db) => {
      const coordinator = coordinatorFromEnvironment(db, generateId);
      const outcomes = await coordinator.armWaitingExecutions(limit);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/workflow",
            command,
            environment,
            gitRevision: revision,
            armed: outcomes.length,
            outcomes: outcomes.map((o) => ({
              waitKey: o.wait.waitKey,
              state: o.wait.state,
              created: o.created,
              started: o.started,
              providerInstanceId: o.wait.providerInstanceId,
            })),
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "recover") {
    await withAuthoritativeDatabase(context, async (db) => {
      const coordinator = coordinatorFromEnvironment(db, generateId);
      const deadlines = await coordinator.applyDueDeadlines(limit);
      const recovery = await coordinator.recoverPending(limit);
      const observations = await coordinator.observeProviderInstances(limit);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/workflow",
            command,
            environment,
            gitRevision: revision,
            deadlinesApplied: deadlines.map((d) => ({ waitKey: d.waitKey, state: d.state })),
            recovery,
            providerObservations: observations.map((o) => ({
              waitKey: o.wait.waitKey,
              observed: o.observed,
            })),
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  // compact: bounded provider-state compaction.
  await withAuthoritativeDatabase(context, async (db) => {
    const coordinator = coordinatorFromEnvironment(db, generateId);
    const report = await coordinator.compact(limit);
    console.log(
      JSON.stringify(
        {
          tool: "deploy/workflow",
          command,
          environment,
          gitRevision: revision,
          compaction: report,
        },
        null,
        2,
      ),
    );
  });
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
