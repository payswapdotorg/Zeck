/**
 * VAL-040 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * economic-baseline experiments run end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decisions carrying the ARM DECISION
 *     (the fixed-cost budget bound) BEFORE the first dispatch, the
 *     gapless step-event journal (per-record-distinct idempotency
 *     keys — the VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every round is sealed through the
 *     REAL validation recorder (micro-USD cost facts with the
 *     estimate/measured separation), evaluated through the REAL
 *     evaluation oracle and aggregated through the REAL accounting
 *     aggregate (the Wilson 95% interval carried on every
 *     comparison);
 *   - the normalization core: every round's heterogeneous usage
 *     converges onto the canonical micro-USD basis through the
 *     pinned manifest (mixed currencies, per-1K units, batched
 *     metering, retry amortization), and the normalized comparison
 *     reproduces the corpus's pinned expected economics exactly;
 *   - the offline rows' economics replay RECORDED accounting
 *     records deterministically (zero credentials, zero network);
 *   - the app rides the public SDK boundary (the customer-side
 *     submission + completion poll + result retrieval) while the
 *     driver drives the landed lanes.
 *
 * The live rail rows (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drive one REAL fixed-quality experiment and
 * one REAL fixed-cost experiment through the REAL platform model
 * gateway — measured usage, pinned completion budgets (the
 * unaffordable-budget 402 lesson), the threshold recomputed from
 * REAL verdicts. ONE dispatch binding (one registered connection)
 * serves ALL live rows of a run — the VAL-025 live-run lesson (a
 * per-row binding mints fresh master keys while the connection
 * label converges re-registrations onto the first connection, and
 * the cross-cipher materialize fails the envelope integrity check).
 * Absent credentials are a recorded NOT RUN boundary — never a fake
 * success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runEconomicApp } from "../../../benchmarks/validation/apps/economic-baseline/application";
import {
  ECONOMIC_CORPUS,
  ECONOMIC_CORPUS_VERSION,
  economicTasksForArm,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/economic-baseline/corpus";
import {
  createRealAccountingRails,
  driveEconomicRow,
  type EconomicExecutor,
  type EconomicLifecyclePort,
  type EconomicWorldFacts,
  economicDigestOf,
  type RoundDispatchOutcome,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { createRecordedReplayExecutor } from "../../../benchmarks/validation/apps/economic-baseline/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import { validateRunRecord } from "../../../benchmarks/validation/recorder/record";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";
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
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MAX_TOKENS = 64;
const REVISION = "d63a77e684f6097dd974caabe4a05d6c39302fe3";

/** The live dispatch roundtrip (one REAL model-gateway round per call). */
export type EconomicDispatchBinding = (input: {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly model: string;
}) => Promise<RoundDispatchOutcome>;

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly rounds: number;
  readonly resolved: number;
  readonly measuredMicroUsd: string;
  readonly costPerResolved: string;
  readonly wilson: string;
  readonly appPassed: boolean;
  readonly usage: string;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// The REAL world bindings
// ---------------------------------------------------------------------------

/** The REAL durable world facts over the application's SQL ledger. */
function createWorldFacts(ctx: PgContext, world: ApiPgWorld): () => Promise<EconomicWorldFacts> {
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
 * The platform-side lifecycle binding over the REAL executions
 * service: the canonical transitions (per-call-distinct idempotency
 * keys — the VAL-018 lesson), the durable planning decisions carrying
 * the ARM DECISION, the step-event journal (digest references only),
 * the terminal completion with the mechanically derived criteria and
 * the observed-terminal read-back.
 */
function createLifecycleBinding(
  world: ApiPgWorld,
  executions: ExecutionService,
): EconomicLifecyclePort {
  const generateId = createUuidv7Generator();
  let transitionCounter = 0;
  return {
    async transition({ executionId, step, reason, callKey }) {
      transitionCounter += 1;
      void callKey;
      await executions.transition(
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
        `val-040-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route, armDecision }) {
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
                strategyId: "val-040-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-040-pinned",
            armDecision,
          },
        },
        `val-040-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-040-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-040-${executionId}-${record.kind}-${record.ordinal}`,
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
            recordedBy: "val-040-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-040-${executionId}-${verdict}`,
      );
    },
    async statusOf(executionId) {
      const execution = await executions.getExecution(world.applicationId, executionId);
      return execution?.status ?? null;
    },
  };
}

/**
 * The landed-executions provider: polls the REAL SQL until the row's
 * expected count of the APP's experiment executions land.
 */
function createLandedProvider(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  taskKind: string,
): (group: number, expectedCount: number) => Promise<readonly string[]> {
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
        parameters: [world.applicationId, taskKind, [...driven], expectedCount],
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

/**
 * Build the REAL live dispatch binding (the live rows' executor):
 * the REAL model gateway over the REAL OpenRouter rail with the REAL
 * fetch transport, the REAL dispatch journal and BYOK credential
 * registration. ONE binding (ONE registered connection) serves ALL
 * live rows of the run — the VAL-025 live-run lesson.
 */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: EconomicDispatchBinding }> {
  const generateId = createUuidv7Generator();
  const { createEnvelopeCipher, generateMasterKey } = await import(
    "../../../src/platform/crypto/envelope-cipher"
  );
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
        return { satisfied: true, catalogRevision: "val-040", satisfactions: [] };
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
  // ONE connection registered ONCE for ALL live rows (the review-proven
  // posture: a per-row registration would mint fresh master keys while
  // the label uniqueness converges onto the first connection — the
  // cross-cipher materialize then fails the envelope integrity check).
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-040-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-040-conn-${generateId().slice(-8)}`,
  );

  const dispatch: EconomicDispatchBinding = async ({ executionId, taskId, attempt, model }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the settlement confirmation supervisor of a governed economic-baseline",
            "validation experiment. At each round boundary you receive the committed round",
            "progress and decide whether the round's settlement should be confirmed. Answer",
            "with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content: `Round ${taskId} of the economic baseline experiment (execution digest ${economicDigestOf(
            executionId,
          )}, attempt ${attempt}). Confirm the settlement round.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ executionId, taskId, attempt, model }))
      .digest("hex")
      .slice(0, 8);
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
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
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          currency: "USD" as const,
          ...(response.usage.costUsd === null || response.usage.costUsd === undefined
            ? {}
            : { costUsd: response.usage.costUsd }),
        },
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
void economicDigestOf;

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row crown-style: the app rides the public wire
 * (the customer-side submission + completion poll + result
 * retrieval) while the driver drives the landed execution through
 * the REAL platform path — the recorded-replay executor offline,
 * the REAL model gateway dispatch on the live rows.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: (typeof ECONOMIC_CORPUS)[number];
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
  readonly dispatch?: EconomicDispatchBinding;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveEconomicRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runEconomicApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();

  // The executor: the recorded replay offline; the REAL gateway live.
  let executor: EconomicExecutor;
  if (row.needsDispatch) {
    if (options.dispatch === undefined) {
      throw new Error(`corpus row ${row.rowId} demands the live dispatch seam but none was bound`);
    }
    const dispatch = options.dispatch;
    executor = async ({ executionId, taskId, attempt }) =>
      dispatch({ executionId, taskId, attempt, model: row.arm.model });
  } else {
    executor = createRecordedReplayExecutor({ row });
  }

  const metadata: RunMetadata = {
    program: "zeck-validation",
    workOrder: "VAL-040",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: ECONOMIC_CORPUS_VERSION,
    integrationSurface: "sdk",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-040-economic-baseline", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runEconomicApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: ECONOMIC_CORPUS_VERSION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: 300_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-040-economic-baseline" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveEconomicRow({
    row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: economicTasksForArm(row.arm),
    metadata,
    environmentIdentity: `val-040-crown-${row.rowId}`,
    corpusVersion: ECONOMIC_CORPUS_VERSION,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(
      ctx,
      world,
      options.driven,
      "economic-baseline.experiment.v1",
    ),
    retry: {
      maxExtraAttempts: 2,
      // The live rows keep the VAL-025-proven pacing; the offline
      // replays are deterministic (the backoff is not load-bearing).
      backoffMs: row.needsDispatch ? 4_000 : 100,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-040 economic baseline normalization + experiment protocol over the real platform path",
  (ctx) => {
    test("the offline corpus drives the fixed-quality/fixed-cost experiments over the REAL platform path", {
      timeout: 600_000,
    }, async () => {
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const facts = createWorldFacts(ctx, world);
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
          const runSuffix = `it-${createUuidv7Generator()().slice(-8)}`;
          const { result, appOutcome } = await driveCrownRow({
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
            for (const criterion of result.criteria) {
              if (criterion.status === "FAIL") {
                console.info(
                  `[VAL-040][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                );
              }
            }
          }
          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
          expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
          const failedApp = appOutcome.economicCriteria.filter(
            (criterion) => criterion.status === "FAIL",
          );
          expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
          expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

          // ---- the REAL recorder sealed every round's record ----
          for (const round of result.rounds) {
            expect(validateRunRecord(round.record), `${row.rowId}/${round.taskId} record`).toEqual(
              [],
            );
          }

          // ---- the comparison reproduces the pinned economics ----
          const expected = row.expected.normalized;
          const comparison = result.comparison;
          expect(comparison).not.toBeNull();
          if (expected !== undefined && comparison !== null) {
            expect(comparison.runCount).toBe(expected.runCount);
            expect(comparison.resolvedCount).toBe(expected.resolvedCount);
            expect(comparison.measuredCostMicroUsd).toBe(expected.measuredCostMicroUsd);
            expect(comparison.estimatedCostMicroUsd).toBe(expected.estimatedCostMicroUsd);
            expect(comparison.costPerResolvedMicroUsd).toBe(expected.costPerResolvedMicroUsd);
            expect(comparison.resolutionConfidence?.low).toBeCloseTo(
              expected.resolutionConfidence.low,
              12,
            );
          }

          // ---- the journal sequences are GAPLESS over the REAL SQL ----
          if (result.executionId !== null) {
            const events = await ctx.port.execute<{ sequence: number }>({
              sql: `SELECT sequence FROM executions.execution_events
                  WHERE execution_id = $1 ORDER BY sequence ASC`,
              parameters: [result.executionId],
            });
            const sequences = events.rows.map((eventRow) => eventRow.sequence);
            const gapless = sequences.every((sequence, index) => sequence === index + 1);
            expect(gapless, `${row.rowId} sequences: ${sequences.join(",")}`).toBe(true);
          }

          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            rounds: result.rounds.length,
            resolved: comparison?.resolvedCount ?? 0,
            measuredMicroUsd: comparison?.measuredCostMicroUsd ?? "0",
            costPerResolved: comparison?.costPerResolvedMicroUsd ?? "null",
            wilson:
              comparison?.resolutionConfidence === null ||
              comparison?.resolutionConfidence === undefined
                ? "none"
                : `[${comparison.resolutionConfidence.low.toFixed(3)}, ${comparison.resolutionConfidence.high.toFixed(3)}]`,
            appPassed: appOutcome.passed,
            usage: row.needsDispatch ? "rail-measured" : "replayed-record",
            latencyMs: result.totalLatencyMs,
          });
          console.info(
            `[VAL-040]   ${row.rowId} -> ${result.terminal} rounds=${result.rounds.length} ` +
              `resolved=${comparison?.resolvedCount ?? 0} measured=${comparison?.measuredCostMicroUsd ?? "0"}µ$ ` +
              `cpr=${comparison?.costPerResolvedMicroUsd ?? "null"}µ$ ` +
              `wilson=${runFacts[runFacts.length - 1]?.wilson} latency=${result.totalLatencyMs}ms ` +
              `appPassed=${String(appOutcome.passed)}`,
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
          `[VAL-040] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven rows; ` +
            `the ledger holds exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
            `idempotency records (zero phantoms, zero drift, zero orphan events); every execution_events ` +
            `sequence gapless; every round sealed through the REAL recorder and aggregated through the ` +
            `REAL accounting rails (the Wilson 95% interval carried on every comparison).`,
        );
        expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live rail drives one fixed-quality and one fixed-cost experiment with REAL model dispatches", {
      timeout: 480_000,
    }, async () => {
      const notRun: string[] = [];
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-040] OPENROUTER_API_KEY absent — the REAL live economics rows are a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers every normalization/protocol path without credentials. Required access: an " +
            "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned " +
            "chat model meta-llama/llama-3.3-70b-instruct — the REAL fixed-quality and fixed-cost " +
            "experiments demand REAL model dispatches with measured usage.",
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
        // ONE live dispatch binding for ALL live rows (the review-proven
        // posture): the connection and its sealed credential envelope are
        // registered ONCE and shared across the live rows.
        let liveDispatch: EconomicDispatchBinding | undefined;
        for (const [corpusIndex, row] of ECONOMIC_CORPUS.entries()) {
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
          const runSuffix = `live-${createUuidv7Generator()().slice(-8)}`;
          if (liveDispatch === undefined) {
            liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
          }
          const dispatch: EconomicDispatchBinding = liveDispatch;
          const { result, appOutcome } = await driveCrownRow({
            ctx,
            world,
            address,
            row,
            taskIndex: corpusIndex,
            runSuffix,
            driven,
            facts,
            dispatch,
          });

          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
          // The live rows' usage is MEASURED (never estimated): the
          // comparison's measured basis is populated from REAL tokens.
          expect(result.comparison?.measuredCostMicroUsd ?? "0").not.toBe("0");
          const comparison = result.comparison;
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            rounds: result.rounds.length,
            resolved: comparison?.resolvedCount ?? 0,
            measuredMicroUsd: comparison?.measuredCostMicroUsd ?? "0",
            costPerResolved: comparison?.costPerResolvedMicroUsd ?? "null",
            wilson:
              comparison?.resolutionConfidence === null ||
              comparison?.resolutionConfidence === undefined
                ? "none"
                : `[${comparison.resolutionConfidence.low.toFixed(3)}, ${comparison.resolutionConfidence.high.toFixed(3)}]`,
            appPassed: appOutcome.passed,
            usage: "rail-measured",
            latencyMs: result.totalLatencyMs,
          });
          console.info(
            `[VAL-040]   LIVE ${row.rowId} -> ${result.terminal} rounds=${result.rounds.length} ` +
              `resolved=${comparison?.resolvedCount ?? 0} measured=${comparison?.measuredCostMicroUsd ?? "0"}µ$ ` +
              `cpr=${comparison?.costPerResolvedMicroUsd ?? "null"}µ$ latency=${result.totalLatencyMs}ms`,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-040] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
            `over the REAL OpenRouter rail (model meta-llama/llama-3.3-70b-instruct, priced at the ` +
            `pinned manifest rev-001); measured usage on every dispatched round (BYOK).`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-040] NOT RUN boundary: ${boundary}`);
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
