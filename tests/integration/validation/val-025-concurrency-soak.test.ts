/**
 * VAL-025 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * concurrency/soak application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL idempotency ledger arbitrating every racing
 *     submission: the app's same-key pairs/storms/conflicts are fired
 *     CONCURRENTLY through the public wire and converge through
 *     PostgreSQL's unique-index/transactional arbitration (the loser
 *     WAITS for the winner's commit, then replays the durable outcome;
 *     the racing conflict's loser gets the REAL typed 409
 *     IDEMPOTENCY_KEY_REUSED) — never two executions;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decisions recorded BEFORE the lanes' work,
 *     the GENUINE concurrent chain driving (the fan-out's observed
 *     overlap and the interleaved step-event journal);
 *   - the REAL admission seam: the over-ceiling bursts ride the
 *     CREATED→authorize boundary through a REAL authorization adapter
 *     composed over the platform's own policy authority — the denied
 *     lanes receive the typed POLICY_DENIED (the platform's REAL
 *     throttled/queue-full vocabulary) with the DURABLE
 *     execution.policy-denied envelope, the row STAYS CREATED
 *     (dispatch remains impossible) and ZERO effects land; the
 *     slot-release wave ADMITS on the freed slots (the prune);
 *   - the REAL ledger journal: every step-event record journaled
 *     exactly once (per-record-distinct idempotency keys — the VAL-018
 *     lesson), the execution_events sequences verified GAPLESS per
 *     execution;
 *   - the soak rounds over the declared sustained window with the
 *     durable invariants re-verified after EVERY round (the REAL SQL
 *     row counts: no ledger drift, no row-count leak, the replay
 *     probes never re-arbitrating a key);
 *   - the battery-level ledger cross-checks: one idempotency record
 *     per submission key, the racing keys' single executions, zero
 *     orphan events.
 *
 * The live rail rows (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drive REAL model dispatches through the REAL
 * platform model gateway — concurrent REAL confirmation rounds for the
 * live fan-out; the racing winner's REAL round for the live race.
 * Absent credentials are a recorded NOT RUN boundary — never a fake
 * success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runConcurrencySoakApp } from "../../../benchmarks/validation/apps/concurrency-soak/application";
import {
  CONCURRENCY_CORPUS,
  CONCURRENCY_TASK_KIND,
  CORPUS_RETRY_POLICY,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  submissionKey,
} from "../../../benchmarks/validation/apps/concurrency-soak/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  type ConcurrencyDispatch,
  type ConcurrencyLifecyclePort,
  type ConcurrencySubmissionSeam,
  type ConcurrencyWorldFacts,
  driveConcurrencyRow,
  type LandedExecutionsProvider,
} from "../../../benchmarks/validation/platform/concurrency-soak";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/public";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import {
  createTxCredentialVault,
  SqlCredentialVault,
} from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import { TERMINAL_STATUSES } from "../../../src/modules/executions/domain/state-machine";
import type {
  AuthorizationDecision,
  ExecutionAdmissionInput,
  ExecutionAuthorizationPort,
} from "../../../src/modules/executions/ports/authorization";
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import { createExecutionAuthorization } from "../../../src/modules/policies/public";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { Transaction } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.ZECK_VAL_025_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-025|concurrency-soak|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly executions: number;
  readonly admitted: number;
  readonly denied: number;
  readonly probes: number;
  readonly rounds: number;
  readonly latencyMs: number;
  readonly soakWindowMs: number | null;
  readonly appPassed: boolean;
  readonly appSubmissions: string;
  readonly usage: string;
}

// ---------------------------------------------------------------------------
// The REAL world bindings
// ---------------------------------------------------------------------------

/** The REAL durable world facts over the application's SQL ledger. */
function createWorldFacts(ctx: PgContext, world: ApiPgWorld): () => Promise<ConcurrencyWorldFacts> {
  return async () => {
    const execCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    const eventCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    // The create-arbitration records only (the submission keys' own
    // ledger rows — the transitions' and step-events' operation records
    // are the platform's expected machinery, never submission drift).
    const keyCount = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = 'executions.create'`,
      parameters: [world.applicationId],
    });
    const orphans = await ctx.port.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM executions.execution_events e
            LEFT JOIN executions.executions x ON e.execution_id = x.id
            WHERE e.application_id = $1 AND x.id IS NULL`,
      parameters: [world.applicationId],
    });
    return {
      executionCount: execCount.rows[0]?.c ?? 0,
      eventCount: eventCount.rows[0]?.c ?? 0,
      idempotencyRecordCount: keyCount.rows[0]?.c ?? 0,
      orphanEventCount: orphans.rows[0]?.c ?? 0,
    };
  };
}

/**
 * The REAL admission gate: an authorization adapter composed over the
 * platform's own policy authority. The prune-then-decide discipline —
 * terminal executions release their slots (the REAL status reads)
 * BEFORE the decision; the synchronous check-and-add is atomic in
 * single-threaded JS, so a wave's concurrent authorize transitions
 * arbitrate exactly the declared ceiling admissions.
 */
function createCeilingGate(options: {
  readonly ceiling: number;
  readonly inner: ExecutionAuthorizationPort;
  readonly statusOf: (executionId: string) => Promise<string | null>;
}): ExecutionAuthorizationPort {
  const admitted = new Set<string>();
  return {
    async evaluate(input: ExecutionAdmissionInput): Promise<AuthorizationDecision> {
      for (const id of [...admitted]) {
        const status = await options.statusOf(id);
        if (status === null || (TERMINAL_STATUSES as readonly string[]).includes(status)) {
          admitted.delete(id);
        }
      }
      if (admitted.size >= options.ceiling) {
        return {
          allowed: false,
          reason: `concurrency ceiling ${options.ceiling} reached: ${admitted.size} admitted executions in flight (load shaping)`,
        };
      }
      admitted.add(input.execution.id);
      return options.inner.evaluate(input);
    },
  };
}

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(
  world: ApiPgWorld,
  executions: ExecutionService,
): ConcurrencyLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason, callKey }) {
      transitionCounter += 1;
      void callKey;
      const outcome = await executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        // Every call gets a unique key: repeated steps must never
        // collide on the ledger.
        `val-025-${executionId}-${step}-${transitionCounter}`,
      );
      // The platform's admission denial is a DURABLE outcome (the
      // execution.policy-denied envelope, the status staying CREATED —
      // the identity-preserving sequence advance) surfaced to the
      // driver as the typed POLICY_DENIED rejection — the REAL
      // throttled/queue-full vocabulary. The denial shape: an
      // authorize transition that did NOT move the execution to
      // AUTHORIZED.
      if (step === "authorize" && outcome.execution.status !== "AUTHORIZED") {
        throw Object.assign(
          new Error("policy admission denied the authorize transition (concurrency load shaping)"),
          { code: "POLICY_DENIED" },
        );
      }
    },
    async recordPlanningDecision({ executionId, route }) {
      await executions.recordPlanningDecision(
        {
          applicationId: world.applicationId,
          executionId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          decisionId: generateId(),
          planId: generateId(),
          payload: {
            candidates: [
              {
                strategyId: "val-025-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-025-pinned",
          },
        },
        `val-025-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-025-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-025-${executionId}-${record.kind}-${record.ordinal}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: verdict,
          reason,
          verificationResults: criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            strategy: criterion.strategy,
            status: criterion.status,
            recordedBy: "val-025-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-025-${executionId}-${verdict}`,
      );
    },
  };
}

/** The service-level submission seam over the REAL idempotency ledger. */
function createSubmissionSeam(world: ApiPgWorld): ConcurrencySubmissionSeam {
  return async ({ key, body }) => {
    const submittedAt = Date.now();
    try {
      const receipt = await world.executions.createExecution(
        { applicationId: world.applicationId, task: { ...body } },
        key,
        { actorId: world.actorId, tenantId: world.tenantId },
      );
      return {
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        status: receipt.status,
        rejection: null,
        submittedAt,
        latencyMs: Date.now() - submittedAt,
      };
    } catch (error) {
      const platformError = error instanceof PlatformError ? error : null;
      return {
        executionId: "",
        replayed: false,
        status: null,
        rejection: {
          code: platformError?.code ?? "UNEXPECTED",
          status: platformError?.code === "IDEMPOTENCY_KEY_REUSED" ? 409 : 0,
        },
        submittedAt,
        latencyMs: Date.now() - submittedAt,
      };
    }
  };
}

/**
 * The landed-executions provider: polls the REAL SQL until the group's
 * expected count of the APP's settlement lanes land (the driver's own
 * probe lanes carry the probe task kind and are excluded).
 */
function createLandedProvider(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
): LandedExecutionsProvider {
  return async (group, expectedCount) => {
    void group;
    for (let attempt = 0; attempt < 4_800; attempt += 1) {
      const rows = await ctx.port.execute<{ id: string }>({
        sql: `SELECT id FROM executions.executions
              WHERE application_id = $1
                AND task->>'kind' = $2
                AND id != ALL($3::uuid[])
              ORDER BY created_at ASC, id ASC
              LIMIT $4`,
        parameters: [world.applicationId, CONCURRENCY_TASK_KIND, [...driven], expectedCount],
      });
      if (rows.rows.length >= expectedCount) {
        const ids = rows.rows.map((row) => row.id);
        for (const id of ids) {
          driven.add(id);
        }
        return ids;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no new landed executions after 120s (expected ${expectedCount})`);
  };
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the VAL-021 live-rail precedent)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live rows' seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: ConcurrencyDispatch }> {
  const generateId = createUuidv7Generator();
  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(ctx.port, generateId);
  const vault = new SqlCredentialVault(ctx.port, cipher, generateId);
  const connections = createConnectionService(
    new SqlConnectionStore(ctx.port),
    new SqlConnectionsIdempotency(
      ctx.port,
      (tx: Transaction) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  const registry = createRailRegistry([
    createOpenRouterAdapter({ transport: createFetchTransport() }),
  ]);
  const gateway = createModelGateway({
    resolver: createScopeResolver(auth.store),
    catalog: connections,
    credentials: vault,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "val-025", satisfactions: [] };
      },
    },
    rails: registry,
    journal: createSqlDispatchJournal(ctx.port),
    generateId,
    defaultTimeoutMs: 150_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });
  const principal = { actorId: world.actorId, authenticatedAt: new Date().toISOString() };
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-025-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-025-conn-${generateId().slice(-8)}`,
  );

  const dispatch: ConcurrencyDispatch = async ({ executionId, lane }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the settlement confirmation supervisor of a governed concurrency validation execution.",
            "At each lane boundary you receive the committed settlement progress and decide whether",
            "the lane's settlement should proceed. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content: `Lane ${lane} of the settlement batch (execution digest ${concurrencyDigestOfKey(executionId)}). Confirm the settlement.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ executionId, lane, model: MODEL }))
      .digest("hex")
      .slice(0, 8);
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage: LabUsage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure",
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${(response.content.join("\n")).slice(0, 120)}`,
          latencyMs,
          requestDigest,
        };
      }
      return {
        kind: "success",
        content: response.content.join("\n"),
        usage,
        latencyMs,
        requestDigest,
      };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
      requestDigest,
    };
  };
  return { dispatch };
}

/** The execution-id digest for the live prompts (digest references only). */
function concurrencyDigestOfKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row crown-style: the app rides the public wire
 * while the platform driver drives the landed lanes — the multi-group
 * rows (the burst's waves, the soak's rounds) interleave the app's
 * group submissions with the driver's group driving through the
 * landed provider.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: (typeof CONCURRENCY_CORPUS)[number];
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly dispatch?: ConcurrencyDispatch;
  readonly driven: Set<string>;
  readonly facts: () => Promise<ConcurrencyWorldFacts>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveConcurrencyRow>>;
  readonly appSettled: {
    readonly ok: true;
    readonly outcome: Awaited<ReturnType<typeof runConcurrencySoakApp>>;
  }[];
  readonly appPassed: boolean;
}> {
  const { ctx, world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();

  // The lifecycle service: the burst rows ride the gated service (the
  // admission seam); every other row rides the world's own service
  // (the platform's default policy authority).
  let service: ExecutionService = world.executions;
  let gateClient: import("pg").Client | null = null;
  if (row.pattern === "over-ceiling-burst") {
    // The gate's prune reads ride a DEDICATED connection: the gate
    // evaluates INSIDE the arbitrate transaction (which holds a pool
    // connection), so a pooled status read could self-deadlock the
    // four-connection pool under a wave's concurrent authorizes.
    const { Client } = await import("pg");
    gateClient = new Client({
      connectionString: `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${ctx.databaseName}`,
    });
    await gateClient.connect();
    service = createExecutionService({
      store: new SqlExecutionStore(ctx.port),
      idempotency: new SqlExecutionsIdempotency(
        ctx.port,
        (tx) => new SqlExecutionStore(tx),
        generateId,
      ),
      authorization: createCeilingGate({
        ceiling: row.ceiling ?? 1,
        inner: createExecutionAuthorization(world.policyAuthority),
        statusOf: async (executionId) => {
          if (gateClient === null) {
            return null;
          }
          const result = await gateClient.query<{ status: string }>(
            "SELECT status FROM executions.executions WHERE id = $1",
            [executionId],
          );
          return result.rows[0]?.status ?? null;
        },
      }),
      generateId,
      now: () => new Date(),
    });
  }
  const lifecycle = createLifecycleBinding(world, service);
  const seam = createSubmissionSeam(world);
  const baseline = await options.facts();

  // The driver's controlled settlement world (the exactly-once
  // multiplicity oracle — deliberately non-idempotent counters).
  const observedCounts: Record<string, number> = {};
  const settlementWorld = {
    apply: (effect: {
      readonly effect: string;
      readonly key: string;
      readonly amountMicro: number;
    }) => {
      observedCounts[effect.effect] = (observedCounts[effect.effect] ?? 0) + 1;
      return { ok: true, value: `settled ${effect.key} for ${effect.amountMicro} micro-USD` };
    },
    observedCounts,
  };

  // The app promise(s): the soak rows run ONE ROUND PER INVOCATION —
  // each round's app run submits the round's lanes and polls them to
  // settlement while the driver drives them (the landed provider
  // blocks per group, so the interleaving is deadlock-free).
  const appSettled: {
    readonly ok: true;
    readonly outcome: Awaited<ReturnType<typeof runConcurrencySoakApp>>;
  }[] = [];
  const runApp = (round?: number): Promise<void> =>
    runConcurrencySoakApp({
      config: {
        applicationId: world.applicationId,
        baseUrl: options.address,
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: REVISION,
        corpusRevision: REVISION,
        integrationSurface: "sdk",
        pollIntervalMs: 250,
        completionTimeoutMs: 120_000,
      },
      token: world.bearerToken,
      transport: globalThis.fetch,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      environment: {
        runtime: `node ${process.version}`,
        toolchain: "vitest",
        database: "postgresql",
        configuration: { suite: "val-025-concurrency-soak" },
      },
      runSuffix: options.runSuffix,
      taskIndex,
      ...(round === undefined ? {} : { roundIndex: round }),
    }).then(
      (outcome) => {
        appSettled.push({ ok: true, outcome });
      },
      (error: unknown) => {
        throw error;
      },
    );

  const driverPromise = driveConcurrencyRow({
    row,
    lifecycle,
    world: settlementWorld,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven),
    submissionSeam: seam,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    runSuffix: options.runSuffix,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  try {
    if (row.pattern === "soak-rounds") {
      const soak = row.soak ?? { rounds: 1, interRoundSpacingMs: 0 };
      for (let round = 1; round <= soak.rounds; round += 1) {
        await runApp(round);
      }
    } else {
      await runApp();
    }
    const result = await driverPromise;
    const appPassed =
      appSettled.length > 0 && appSettled.every((settled) => settled.outcome.passed);
    return { result, appSettled, appPassed };
  } finally {
    if (gateClient !== null) {
      await gateClient.end().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-025 concurrency, load, endurance and soak over the real platform path",
  (ctx) => {
    test("the offline corpus drives racing/fanout/burst/soak semantics over the REAL platform path", {
      timeout: 600_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const facts = createWorldFacts(ctx, world);
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { result, appSettled, appPassed } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex,
            runSuffix,
            driven,
            facts,
          });

          // ---- the honest outcome contracts ----
          if (
            result.terminal !== row.expected.terminal ||
            result.criteria.some((c) => c.status === "FAIL")
          ) {
            console.info(
              `[VAL-025][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
            );
            for (const criterion of result.criteria) {
              if (criterion.status === "FAIL") {
                console.info(
                  `[VAL-025][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                );
              }
            }
            for (const execution of result.executions) {
              const failed = execution.criteria.filter((c) => c.status === "FAIL");
              if (failed.length > 0 || execution.outcome !== "COMPLETED") {
                console.info(
                  `[VAL-025][DIAGNOSTIC]   exec ${execution.executionId} outcome=${execution.outcome} denial=${JSON.stringify(execution.denial)} window=${JSON.stringify(execution.window)}`,
                );
                for (const criterion of failed) {
                  console.info(
                    `[VAL-025][DIAGNOSTIC]     FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                  );
                }
              }
            }
            for (const probe of result.probes) {
              console.info(
                `[VAL-025][DIAGNOSTIC]   probe verdict: ${JSON.stringify(probe.verdict)} observations=${JSON.stringify(probe.observations.map((o) => ({ id: o.executionId.slice(-8), replayed: o.replayed, rejection: o.rejection })))}`,
              );
            }
          }
          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          for (const settled of appSettled) {
            expect(validateHarnessEvidence(settled.outcome.evidence)).toEqual([]);
            expect(settled.outcome.passed, `${row.rowId} app passed`).toBe(true);
            const failedSubmission = settled.outcome.submissionCriteria.filter(
              (criterion) => criterion.status === "FAIL",
            );
            expect(failedSubmission, `${row.rowId}: ${JSON.stringify(failedSubmission)}`).toEqual(
              [],
            );
          }
          expect(appPassed).toBe(true);

          // ---- the per-execution ledger cross-checks (the REAL journals) ----
          for (const execution of result.executions) {
            const events = await ctx.port.execute<{ sequence: number; command: string }>({
              sql: `SELECT sequence, command FROM executions.execution_events
                  WHERE execution_id = $1 ORDER BY sequence ASC`,
              parameters: [execution.executionId],
            });
            const sequences = events.rows.map((eventRow) => eventRow.sequence);
            // The execution_events sequence is GAPLESS (the AC4 continuity).
            const gapless = sequences.every((sequence, index) => sequence === index + 1);
            expect(
              gapless,
              `${row.rowId}/${execution.executionId} sequences: ${sequences.join(",")}`,
            ).toBe(true);
            if (execution.denial !== null) {
              // The denied lane: CREATED + the durable policy-denied
              // envelope + ZERO transitions beyond the authorize attempt.
              const commands = events.rows.map((eventRow) => eventRow.command);
              expect(
                commands.filter(
                  (command) =>
                    command === "plan" ||
                    command === "queue" ||
                    command === "start" ||
                    command === "verify",
                ),
              ).toEqual([]);
              const types = await ctx.port.execute<{ type: string }>({
                sql: `SELECT type FROM executions.execution_events WHERE execution_id = $1`,
                parameters: [execution.executionId],
              });
              expect(types.rows.map((eventRow) => eventRow.type)).toContain(
                "execution.policy-denied",
              );
              const deniedRow = await world.executions.getExecution(
                world.applicationId,
                execution.executionId,
              );
              expect(deniedRow?.status).toBe("CREATED");
            }
          }

          // ---- the racing keys' ledger cross-check: ONE record, ONE execution ----
          if (row.pattern === "same-key-race") {
            const appKey = submissionKey({
              runSuffix,
              taskIndex,
              lane: 0,
              racingPair: true,
            });
            const keyRecords = await ctx.port.execute<{ c: number }>({
              sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND idempotency_key = $2`,
              parameters: [world.applicationId, appKey],
            });
            expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);
          }

          // ---- the app-side racing observations: exactly one created ----
          const settled = appSettled[0];
          if (settled !== undefined && row.pattern === "same-key-race") {
            const created = settled.outcome.observations.filter(
              (observation) => !observation.replayed && observation.rejection === null,
            );
            const replayed = settled.outcome.observations.filter(
              (observation) => observation.replayed && observation.rejection === null,
            );
            expect(created.length).toBe(1);
            expect(replayed.length).toBe(row.expected.replayedSubmissions);
          }

          const appSubmissions = settled
            ? `${settled.outcome.observations.filter((o) => !o.replayed && o.rejection === null).length}c+${settled.outcome.observations.filter((o) => o.replayed).length}r+${settled.outcome.observations.filter((o) => o.rejection !== null).length}x`
            : "n/a";
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            executions: result.executions.length,
            admitted: result.executions.filter((e) => e.denial === null).length,
            denied: result.executions.filter((e) => e.denial !== null).length,
            probes: result.probes.length,
            rounds: result.rounds.length,
            latencyMs: result.totalLatencyMs,
            soakWindowMs: result.soakWindowMs,
            appPassed,
            appSubmissions,
            usage:
              result.usage === null
                ? "none-reported"
                : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                  (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
          });
          console.info(
            `[VAL-025]   ${row.rowId} -> ${result.terminal} executions=${result.executions.length} ` +
              `(admitted=${runFacts[runFacts.length - 1]?.admitted} denied=${runFacts[runFacts.length - 1]?.denied}) ` +
              `probes=${result.probes.length} rounds=${result.rounds.length} ` +
              `latency=${result.totalLatencyMs}ms soakWindow=${result.soakWindowMs ?? "n/a"}ms ` +
              `app=${appSubmissions} appPassed=${String(appPassed)}`,
          );
        }

        // ---- the battery-level ledger integrity (the whole corpus) ----
        const finalFacts = await facts();
        expect(finalFacts.orphanEventCount).toBe(0);
        const expectedExecutions = OFFLINE_CORPUS_ROWS.reduce(
          (sum, row) => sum + row.expected.executions,
          0,
        );
        expect(finalFacts.executionCount).toBe(expectedExecutions);
        const expectedKeys = OFFLINE_CORPUS_ROWS.reduce(
          (sum, row) => sum + row.expected.idempotencyRecords,
          0,
        );
        expect(finalFacts.idempotencyRecordCount).toBe(expectedKeys);

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-025] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven rows; ` +
            `the ledger holds exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
            `idempotency records (zero phantoms, zero drift, zero orphan events); every execution_events ` +
            `sequence gapless; every racing key arbitrated exactly once.`,
        );
        expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live rail drives the concurrency semantics with REAL model dispatches", {
      timeout: 480_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const notRun: string[] = [];
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-025] OPENROUTER_API_KEY absent — the REAL live concurrency rows are a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers every racing/fanout/burst/soak path without credentials. Required access: an " +
            "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default " +
            "chat model — the concurrent REAL confirmation rounds demand REAL model dispatches.",
        );
        expect(true).toBe(true);
        return;
      }

      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const facts = createWorldFacts(ctx, world);
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        for (const [corpusIndex, row] of CONCURRENCY_CORPUS.entries()) {
          if (row.liveGate === undefined) {
            continue;
          }
          if (!liveGateOpen(row, process.env)) {
            notRun.push(
              `${row.rowId} — gate closed (${row.liveGate.envVars.join("+")} absent); ` +
                `requirement: ${row.liveGate.requirement}`,
            );
            continue;
          }
          // Provider-side pacing between the live rows.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const runSuffix = `live-${generateId().slice(-8)}`;
          const { dispatch } = await buildLiveDispatch(ctx, world);
          const { result, appSettled, appPassed } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex: corpusIndex,
            runSuffix,
            dispatch,
            driven,
            facts,
          });

          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          for (const settled of appSettled) {
            expect(settled.outcome.passed, `${row.rowId} app passed`).toBe(true);
          }
          expect(appPassed).toBe(true);
          // The live rows' usage is MEASURED (never estimated).
          expect(result.usage === null || result.usage.inputTokens > 0).toBe(true);

          const usage =
            result.usage === null
              ? "none-reported"
              : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            executions: result.executions.length,
            admitted: result.executions.filter((e) => e.denial === null).length,
            denied: result.executions.filter((e) => e.denial !== null).length,
            probes: result.probes.length,
            rounds: result.rounds.length,
            latencyMs: result.totalLatencyMs,
            soakWindowMs: result.soakWindowMs,
            appPassed,
            appSubmissions: "live",
            usage,
          });
          console.info(
            `[VAL-025]   LIVE ${row.rowId} -> ${result.terminal} executions=${result.executions.length} ` +
              `latency=${result.totalLatencyMs}ms usage=${usage}`,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-025] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
            `over the REAL OpenRouter rail (model ${MODEL}); measured usage on every dispatched lane (BYOK).`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-025] NOT RUN boundary: ${boundary}`);
        }
        // At least one REAL live dispatch happened (never an all-NOT-RUN
        // silent pass once a credential is present).
        expect(runFacts.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
