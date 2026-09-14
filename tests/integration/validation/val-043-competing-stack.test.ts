/**
 * VAL-043 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * competing-stack experiments run end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decisions carrying the COMPETING ARM
 *     DECISIONS (the declared competitor configuration revision +
 *     digest + the model-selection table + the retry posture + the
 *     fixed-cost budget bound) BEFORE the first request, the gapless
 *     step-event journal (per-record-distinct idempotency keys — the
 *     VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every round is sealed through the
 *     REAL validation recorder (micro-USD cost facts with the
 *     estimate/measured separation), evaluated through the REAL
 *     evaluation oracle and aggregated through the REAL accounting
 *     aggregate (the Wilson 95% interval carried on every comparison);
 *   - the competing stack: the requests through the competitor's own
 *     interface semantics (the internal-fallback amortization inside
 *     the request's aggregate usage), the routed usage facts (every
 *     rail priced through the pinned manifest per fact), the
 *     client-side bounded retry and the
 *     configuration-conformance/model-selection/retry-posture/
 *     behavior-variance/replay-fidelity/charge-observation-separation
 *     oracles verified mechanically per row;
 *   - the normalized comparison reproduces the corpus's pinned
 *     expected economics exactly (the honest competing baseline);
 *   - the app rides the public SDK boundary (the customer-side
 *     submission + completion poll + result retrieval) while the
 *     driver drives the landed lane.
 *
 * The live rail rows (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drive REAL competing requests through the
 * competitor's REAL interface — the REAL model gateway over the REAL
 * OpenRouter rail with the declared configuration (the pinned model
 * for the extract class, temperature UNSET — the competitor's
 * documented default, max_tokens 64 pinned explicitly). ONE dispatch
 * binding (one registered connection) serves ALL live rows of a run —
 * the VAL-025 live-run lesson. Absent credentials are a recorded NOT
 * RUN boundary — never a fake success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { runCompetingApp } from "../../../benchmarks/validation/apps/economic-controls-competing/application";
import {
  competitorConfigFor,
  routeForClass,
} from "../../../benchmarks/validation/apps/economic-controls-competing/competitor-config";
import {
  COMPETING_CORPUS,
  COMPETING_CORPUS_VERSION,
  competingTasksForArm,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/economic-controls-competing/corpus";
import {
  type CompetitorExecutor,
  type CompetitorRoundDispatchOutcome,
  createRealAccountingRails,
  driveCompetingRow,
} from "../../../benchmarks/validation/apps/economic-controls-competing/driver";
import { createCompetingReplayExecutor } from "../../../benchmarks/validation/apps/economic-controls-competing/fixtures";
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
const REVISION = "054a041530ecffe0f82df8faf343fc5ece3b1046";
const COMPETING_TASK_KIND = "economic-controls-competing.experiment.v1";

/** The live dispatch roundtrip (one REAL model-gateway request per call). */
export type CompetingDispatchBinding = (input: {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly taskClass: string;
}) => Promise<CompetitorRoundDispatchOutcome>;

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
 * the COMPETING ARM DECISIONS, the step-event journal (digest
 * references only), the terminal completion with the mechanically
 * derived criteria and the observed-terminal read-back.
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
        `val-043-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-043-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-043-pinned",
            armDecision,
          },
        },
        `val-043-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-043-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-043-${executionId}-${record.kind}-${record.ordinal}`,
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
            recordedBy: "val-043-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-043-${executionId}-${verdict}`,
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

// ---------------------------------------------------------------------------
// The REAL live dispatch binding (the competitor's real interface)
// ---------------------------------------------------------------------------

/**
 * The competitor-interface request preamble (the confirmation
 * contract the golden tasks' deterministic oracle settles on).
 */
const COMPETITOR_SYSTEM = [
  "You are the settlement confirmation supervisor for the competing-stack experiment round.",
  "Decide and answer with the single word: confirm",
].join(" ");

/**
 * Build the REAL live dispatch binding (the live rows' competing
 * executor): the REAL model gateway over the REAL OpenRouter rail
 * with the REAL fetch transport, the REAL dispatch journal and BYOK
 * credential registration. The requests ride the competitor's DECLARED
 * configuration: the pinned model for the round's class (the
 * model-selection table), temperature UNSET (the competitor's
 * documented default — the model's own default applies), max_tokens
 * pinned explicitly (the 402 lesson), and the generation data's usage
 * (measured) + cost (cross-check observation only) mapped onto the
 * executor's report. ONE binding (ONE registered connection) serves
 * ALL live rows of the run — the VAL-025 live-run lesson.
 */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: CompetingDispatchBinding }> {
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
        return { satisfied: true, catalogRevision: "val-043", satisfiations: [] } as never;
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
      label: "val-043-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-043-conn-${generateId().slice(-8)}`,
  );

  const config = competitorConfigFor("cmp-rev-001");
  const dispatch: CompetingDispatchBinding = async ({
    executionId,
    taskId,
    attempt,
    taskClass,
  }) => {
    const route = routeForClass(config, taskClass);
    const startedAt = Date.now();
    const user = `Round ${taskId} of the competing-stack experiment (the competing gateway dispatch, attempt ${attempt}). Confirm the settlement round.`;
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: route.model,
      maxTokens: MAX_TOKENS,
      // temperature UNSET — the competitor's documented default (the
      // model's own default applies; the declared request-defaults
      // toggle owns this posture).
      messages: [
        { role: "system", content: COMPETITOR_SYSTEM },
        { role: "user", content: user },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ executionId, taskId, attempt, route: route.model }))
      .digest("hex")
      .slice(0, 8);
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure",
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${response.content.join("\n").slice(0, 120)}`,
          latencyMs,
          requestDigest,
          route: { provider: route.provider, model: route.model },
          routedEndpoint: "live-openrouter-pool",
          internalAttempts: 1,
          appliedSettings: config.entries.map((entry) => entry.name),
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
        route: { provider: route.provider, model: route.model },
        routedEndpoint: "live-openrouter-pool",
        internalAttempts: 1,
        appliedSettings: config.entries.map((entry) => entry.name),
      };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
      requestDigest,
      route: { provider: route.provider, model: route.model },
      routedEndpoint: "live-openrouter-pool",
      internalAttempts: 1,
      appliedSettings: config.entries.map((entry) => entry.name),
    };
  };
  return { dispatch };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row crown-style: the app rides the public wire
 * (the customer-side submission + completion poll + result retrieval)
 * while the driver drives the landed execution through the REAL
 * platform path — the competing recorded-trace executor offline, the
 * REAL model-gateway request through the competitor's real interface
 * on the live rows.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: (typeof COMPETING_CORPUS)[number];
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
  readonly dispatch?: CompetingDispatchBinding;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveCompetingRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runCompetingApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();

  // The executor: the competing recorded-trace replay offline; the
  // REAL gateway request through the competitor's real interface live.
  let executor: CompetitorExecutor;
  if (row.needsDispatch) {
    if (options.dispatch === undefined) {
      throw new Error(`corpus row ${row.rowId} demands the live dispatch seam but none was bound`);
    }
    const dispatch = options.dispatch;
    executor = async (input) => dispatch(input);
  } else {
    executor = createCompetingReplayExecutor({ row });
  }

  const metadata: RunMetadata = {
    program: "zeck-validation",
    workOrder: "VAL-043",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: COMPETING_CORPUS_VERSION,
    integrationSurface: "stack:openrouter",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-043-competing-stack", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runCompetingApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: COMPETING_CORPUS_VERSION,
      integrationSurface: "stack:openrouter",
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
      configuration: { suite: "val-043-competing-stack" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveCompetingRow({
    row,
    lifecycle,
    executor,
    rails: createRealAccountingRails(),
    tasks: competingTasksForArm(row.arm),
    metadata,
    environmentIdentity: `val-043-crown-${row.rowId}`,
    corpusVersion: COMPETING_CORPUS_VERSION,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven, COMPETING_TASK_KIND),
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

definePgSuite("VAL-043 competing gateway/router stack over the real platform path", (ctx) => {
  test("the offline corpus drives the competing experiments over the REAL platform path", {
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
                `[VAL-043][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
              );
            }
          }
        }
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
        const failedApp = appOutcome.competingCriteria.filter(
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
          `[VAL-043]   ${row.rowId} -> ${result.terminal} rounds=${result.rounds.length} ` +
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
        `[VAL-043] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven rows; ` +
          `the ledger holds exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
          `idempotency records (zero phantoms, zero drift, zero orphan events); every execution_events ` +
          `sequence gapless; every round sealed through the REAL recorder and aggregated through the ` +
          `REAL accounting rails (the Wilson 95% interval carried on every comparison); the ` +
          `configuration-conformance, model-selection, retry-posture, behavior-variance, replay-fidelity ` +
          `and charge-observation-separation oracles green on every row.`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the competing experiments with REAL requests", {
    timeout: 480_000,
  }, async () => {
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-043] OPENROUTER_API_KEY absent — the REAL live competing rows are a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every competing-stack path without credentials. Required access: an " +
          "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned " +
          "chat model meta-llama/llama-3.3-70b-instruct — the REAL competing experiments demand " +
          "REAL requests through the competitor's real interface with measured usage (the pinned " +
          "model, temperature unset per the documented default, max_tokens 64 pinned explicitly).",
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
      let liveDispatch: CompetingDispatchBinding | undefined;
      for (const [corpusIndex, row] of COMPETING_CORPUS.entries()) {
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
        const dispatch: CompetingDispatchBinding = liveDispatch;
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
          `[VAL-043]   LIVE ${row.rowId} -> ${result.terminal} rounds=${result.rounds.length} ` +
            `resolved=${comparison?.resolvedCount ?? 0} measured=${comparison?.measuredCostMicroUsd ?? "0"}µ$ ` +
            `cpr=${comparison?.costPerResolvedMicroUsd ?? "null"}µ$ latency=${result.totalLatencyMs}ms`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-043] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
          `over the REAL OpenRouter rail (model meta-llama/llama-3.3-70b-instruct, priced at the ` +
          `pinned manifest rev-001 through the competitor's declared configuration cmp-rev-001); ` +
          `measured usage on every dispatched request (BYOK), temperature unset per the documented ` +
          `default, max_tokens pinned, the competitor's own charge observation recorded as the ` +
          `cross-check (never the basis).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-043] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live request happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
