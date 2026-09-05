/**
 * deploy/queue — the D-03 asynchronous-execution-transport operator
 * surface (WORK-044).
 *
 * Commands (all fail closed; all read/write through the PostgreSQL
 * authority — the provider is transport only):
 *
 *   inspect   — the observational backlog/failure/dead-letter snapshot
 *               (read-only; never redefines execution state).
 *   republish — bounded crash/outage recovery: republish envelopes
 *               whose durable intent exists but whose publication
 *               never succeeded (reads PostgreSQL authority only).
 *   replay    — bounded replay of one dead-lettered dispatch lineage:
 *               a NEW envelope re-enters the governed execution path
 *               (every admission gate runs again; original provenance
 *               and correlation identity are retained).
 *   consume   — drain N delivery batches through the idempotent
 *               consumer (the governed-effect seam re-entering the
 *               single execution write path).
 *   probe     — the real transport round-trip (publish → pull → ack)
 *               on the DEDICATED operator-owned probe queue
 *               (ZECK_PROBE_QUEUE_ID); never the execution queue.
 *
 * Composition root: this tool wires the platform pieces the frozen
 * dependency rules keep separate — the DatabasePort adapter from the
 * materialized database-url secret, the Cloudflare Queues adapter from
 * the materialized queue-api-token secret + ordinary configuration,
 * the correlation store, the dispatcher/consumer and the executions
 * module's governed effect. Secrets are resolved from the environment
 * immediately before the authorized adapter call; they never appear in
 * output, errors or logs.
 *
 * Usage:
 *   bun run deploy:queue -- inspect   [--environment local]
 *   bun run deploy:queue -- republish [--environment local] [--limit 100]
 *   bun run deploy:queue -- replay    [--environment local] --envelope <uuid>
 *   bun run deploy:queue -- consume   [--environment local] [--batches 1]
 *   bun run deploy:queue -- probe     [--environment preview]
 */

import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../src/modules/executions/adapters/sql-execution-store";
import { createExecutionDispatchEffect } from "../src/modules/executions/adapters/transport-effect";
import { createExecutionService } from "../src/modules/executions/application/execution-service";
import { parseConnectionConfig } from "../src/platform/db/connection";
import { PgDatabasePort } from "../src/platform/db/pg-database-port";
import {
  createCloudflareQueuesTransport,
  loadCloudflareQueuesRuntimeConfig,
} from "../src/platform/queue/cloudflare-queues";
import { loadQueueRetryPolicy } from "../src/platform/queue/config";
import { createIdempotentQueueConsumer } from "../src/platform/queue/consumer";
import { QueueCorrelationStore } from "../src/platform/queue/correlation";
import { createDurableDispatcher, ReplayRejectedError } from "../src/platform/queue/dispatcher";
import { inspectQueueTransport } from "../src/platform/queue/inspection";
import {
  asSecretReference,
  createEnvSecretStore,
  SecretResolutionError,
} from "../src/platform/secret-store/adapters/env-secret-store";
import { createUuidv7Generator, isUuid } from "../src/shared/ids";
import { requireEnvironment } from "./lib";

/**
 * The consumer actor identity for tooling-driven consumption. A stable
 * well-formed UUIDv7-style placeholder identity is fine for provenance
 * (the actor is recorded on every governed transition; it is not a
 * credential and carries no authority).
 */
const TOOL_CONSUMER_ACTOR_ID = "00000000-0000-7000-8000-0000000000ce";

function requireCommand(argv: readonly string[]): string {
  const command = argv[0];
  if (
    command !== "inspect" &&
    command !== "republish" &&
    command !== "replay" &&
    command !== "consume" &&
    command !== "probe"
  ) {
    console.error(
      "error: command required: inspect | republish | replay --envelope <uuid> | consume [--batches N] | probe",
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

interface QueueToolContext {
  readonly command: string;
  readonly environment: string;
}

async function withAuthoritativeDatabase<T>(
  context: QueueToolContext,
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

/** Build the transport when provider configuration exists (probe command). */
function transportFromEnvironment() {
  try {
    const config = loadCloudflareQueuesRuntimeConfig(process.env);
    return createCloudflareQueuesTransport(config);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * The probe command's fail-closed precondition: the probe NEVER runs
 * against the execution queue — a dedicated operator-owned probe queue
 * (ZECK_PROBE_QUEUE_ID) is required, and probe() itself refuses without
 * one. Fail here with the exact variable name for the operator.
 */
function requireProbeQueueId(): void {
  const probeQueueId = process.env.ZECK_PROBE_QUEUE_ID;
  if (probeQueueId === undefined || probeQueueId.trim().length === 0) {
    console.error(
      "error: probe requires ZECK_PROBE_QUEUE_ID (the dedicated operator-owned probe queue; the transport probe never targets the execution queue — see deploy/README.md)",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = requireCommand(argv);
  const environment = requireEnvironment(argv);
  const context: QueueToolContext = { command, environment };
  const policy = loadQueueRetryPolicy(process.env);
  const generateId = createUuidv7Generator();

  if (command === "probe") {
    requireProbeQueueId();
    const transport = transportFromEnvironment();
    const probe = await transport.probe();
    console.log(JSON.stringify({ tool: "deploy/queue", command, environment, probe }, null, 2));
    return;
  }

  if (command === "inspect") {
    await withAuthoritativeDatabase(context, async (db) => {
      const snapshot = await inspectQueueTransport(db);
      console.log(
        JSON.stringify({ tool: "deploy/queue", command, environment, snapshot }, null, 2),
      );
    });
    return;
  }

  if (command === "republish") {
    const limit = numericOption(argv, "--limit", 100);
    await withAuthoritativeDatabase(context, async (db) => {
      const store = new QueueCorrelationStore(db);
      const transport = transportFromEnvironment();
      const dispatcher = createDurableDispatcher({
        store,
        transport,
        policy,
        generateId,
        now: () => new Date(),
      });
      const outcomes = await dispatcher.republishPending(limit);
      console.log(
        JSON.stringify(
          {
            tool: "deploy/queue",
            command,
            environment,
            republished: outcomes.filter((o) => o.published).length,
            stillBacklogged: outcomes.filter((o) => !o.published).length,
            outcomes: outcomes.map((o) => ({
              correlationKey: o.envelope.correlationKey,
              state: o.envelope.state,
              publishAttempts: o.envelope.publishAttempts,
            })),
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  if (command === "replay") {
    const index = argv.indexOf("--envelope");
    const envelopeId = index >= 0 ? argv[index + 1] : undefined;
    if (envelopeId === undefined || !isUuid(envelopeId)) {
      console.error(
        "error: --envelope <uuid> is required for replay (the dead-lettered root envelope)",
      );
      process.exit(2);
    }
    await withAuthoritativeDatabase(context, async (db) => {
      const store = new QueueCorrelationStore(db);
      const transport = transportFromEnvironment();
      const dispatcher = createDurableDispatcher({
        store,
        transport,
        policy,
        generateId,
        now: () => new Date(),
      });
      try {
        const outcome = await dispatcher.replayDispatch(envelopeId);
        console.log(
          JSON.stringify(
            {
              tool: "deploy/queue",
              command,
              environment,
              replay: {
                correlationKey: outcome.envelope.correlationKey,
                replayedIntent: outcome.replayedIntent,
                published: outcome.published,
                state: outcome.envelope.state,
                replayOf: outcome.envelope.replayOf,
              },
            },
            null,
            2,
          ),
        );
      } catch (error) {
        if (error instanceof ReplayRejectedError) {
          console.error(`error: replay rejected: ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
    });
    return;
  }

  // consume: drain batches through the idempotent consumer with the
  // governed execution effect wired.
  const batches = numericOption(argv, "--batches", 1);
  await withAuthoritativeDatabase(context, async (db) => {
    const store = new QueueCorrelationStore(db);
    const transport = transportFromEnvironment();
    const executionStore = new SqlExecutionStore(db);
    const service = createExecutionService({
      store: executionStore,
      idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
      authorization: { evaluate: async () => ({ allowed: true }) },
      generateId,
      now: () => new Date(),
    });
    const effect = createExecutionDispatchEffect({
      service,
      consumerActorId: TOOL_CONSUMER_ACTOR_ID,
    });
    const consumer = createIdempotentQueueConsumer({ store, transport, effect, policy });
    const reports = [];
    for (let i = 0; i < batches; i++) {
      reports.push(await consumer.consumeBatch({ batchSize: 10, visibilityTimeoutMs: 30_000 }));
    }
    console.log(
      JSON.stringify({ tool: "deploy/queue", command, environment, batches, reports }, null, 2),
    );
  });
}

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
