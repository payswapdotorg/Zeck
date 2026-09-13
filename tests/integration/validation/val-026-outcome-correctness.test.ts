/**
 * VAL-026 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * outcome-correctness application runs end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL idempotency ledger arbitrating every submission: the
 *     app's pinned row lands ONE durable execution through the public
 *     wire; the replay rows re-issue the app's submission key (the
 *     identical body) through the SAME ledger and it REPLAYS the
 *     committed outcome — identity preserved, the replayed flag
 *     surfaced, ZERO new executions, ZERO new ledger records, ZERO
 *     new fixture effects (a second identity is a re-arbitration and
 *     FAILs honestly);
 *   - the REAL executions state machine: the canonical transitions
 *     (authorize → plan → queue → start → verify → pass/fail), the
 *     durable planning decision recorded BEFORE the effects, and the
 *     observed terminal READ BACK from the ledger after settlement
 *     (the reconciliation judges the platform's own durable claim,
 *     never the driver's private intent);
 *   - the REAL step-event journal: every committed effect journaled
 *     EXACTLY once through the `agent-action-recorded` vocabulary
 *     with digest references only (the honest failure record on the
 *     discard boundary), the execution_events sequences verified
 *     GAPLESS per execution over the REAL SQL;
 *   - the REAL verification boundary: the driver's mechanically
 *     derived criteria recorded durably with the terminal transition,
 *     and the app reading them back through the PUBLIC result read —
 *     a COMPLETED row surfaces all-PASS statuses, a FAILED row
 *     surfaces its honest FAIL criterion (the anyFail→FAILED
 *     invariant visible at the customer boundary);
 *   - the battery-level ledger cross-checks over the REAL SQL row
 *     counts: no phantom executions, no ledger drift, zero orphan
 *     events, one idempotency record per submission key.
 *
 * The fixture-state oracle (the controlled effect world) is the
 * CUSTOMER's substrate — the declared effect sets are staged against
 * it, committed ALL-AT-ONCE on a passing verdict and DISCARDED on a
 * failing one (a FAILED row's fixture-state delta is EMPTY — the
 * atomicity of the verification boundary), with the world's committed
 * counters deliberately NON-idempotent (any re-application is
 * mechanically visible). Completed rows verify their FULL effect set
 * against the fixture state; FAILED rows verify the ABSENCE of their
 * effects; replayed executions verify ZERO new effects.
 *
 * The live rail row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drives ONE REAL model confirmation round
 * through the REAL platform model gateway BEFORE any effect stages.
 * Absent credentials are a recorded NOT RUN boundary — never a fake
 * success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runOutcomeApp } from "../../../benchmarks/validation/apps/outcome-correctness/application";
import {
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  OUTCOME_CORPUS,
  OUTCOME_TASK_KIND,
  submissionKey,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/outcome-correctness/corpus";
import {
  createOutcomeFixtureWorld,
  type TickClock,
} from "../../../benchmarks/validation/apps/outcome-correctness/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  driveOutcomeRow,
  IDEMPOTENCY_KEY_REUSED_CODE,
  type LandedExecutionsProvider,
  type OutcomeDispatch,
  type OutcomeLifecyclePort,
  type OutcomeSubmissionSeam,
  type OutcomeWorldFacts,
  outcomeDigestOf,
} from "../../../benchmarks/validation/platform/outcome-correctness";
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
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
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
const MODEL = process.env.ZECK_VAL_026_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-026|outcome-correctness|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly committedEffects: number;
  readonly discardedEffects: number;
  readonly journaledEffects: number;
  readonly replay: string;
  readonly latencyMs: number;
  readonly appPassed: boolean;
  readonly appSubmissions: string;
  readonly submissionLatencyMs: number;
  readonly usage: string;
  readonly keyDigest: string;
  readonly bodyDigest: string;
}

/** The app's own outcome (the settled app promise's payload). */
interface AppOutcome {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<typeof runOutcomeApp>>;
}

// ---------------------------------------------------------------------------
// The REAL world bindings
// ---------------------------------------------------------------------------

/** The REAL durable world facts over the application's SQL ledger. */
function createWorldFacts(ctx: PgContext, world: ApiPgWorld): () => Promise<OutcomeWorldFacts> {
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
    // ledger rows — the transitions'/step-events' operation records
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

/** The platform-side lifecycle binding over the REAL executions service. */
function createLifecycleBinding(
  world: ApiPgWorld,
  executions: ApiPgWorld["executions"],
): OutcomeLifecyclePort {
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
        `val-026-${executionId}-${step}-${transitionCounter}`,
      );
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
                strategyId: "val-026-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-026-pinned",
          },
        },
        `val-026-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-026-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-026-${executionId}-${record.kind}-${record.ordinal}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason, callKey }) {
      void callKey;
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
            recordedBy: "val-026-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-026-${executionId}-${verdict}`,
      );
    },
    async statusOf(executionId) {
      const row = await world.executions.getExecution(world.applicationId, executionId);
      return row?.status ?? null;
    },
  };
}

/** The service-level submission seam over the REAL idempotency ledger. */
function createSubmissionSeam(world: ApiPgWorld): OutcomeSubmissionSeam {
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
          status: platformError?.code === IDEMPOTENCY_KEY_REUSED_CODE ? 409 : 0,
        },
        submittedAt,
        latencyMs: Date.now() - submittedAt,
      };
    }
  };
}

/**
 * The landed-executions provider: polls the REAL SQL until the row's
 * expected count of the APP's executions land (the app's submission
 * rides the public wire; the driver waits for the durable row).
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
        parameters: [world.applicationId, OUTCOME_TASK_KIND, [...driven], expectedCount],
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
 * The REAL wall-clock adapter for the fixture world (the crown's
 * latencies are MEASURED against the real clock — the fixture world's
 * simulated advancement is a no-op; never a fabricated timeline).
 */
function createRealClock(): TickClock {
  return {
    now: () => new Date(),
    advance: () => undefined,
    tick: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the VAL-021/025 live-rail precedent)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live row's seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: OutcomeDispatch }> {
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
        return { satisfied: true, catalogRevision: "val-026", satisfactions: [] };
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
      label: "val-026-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-026-conn-${generateId().slice(-8)}`,
  );

  const dispatch: OutcomeDispatch = async ({ executionId, attempt }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the outcome-settlement confirmation supervisor of a governed validation execution.",
            "You receive the declared effect set's settlement request and decide whether the effects",
            "should be applied to the fixture state. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content: `Outcome settlement (execution digest ${outcomeDigestOf(executionId)}, confirmation round ${attempt}). Confirm the effect application.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    const requestDigest = createHash("sha256")
      .update(JSON.stringify({ executionId, attempt, model: MODEL }))
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

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row crown-style: the app rides the public wire
 * (submit → poll → result read → (the replay rows) the key re-issue)
 * while the platform driver waits for the landed execution and drives
 * its chain (the guard → the staged effects → the verification
 * criteria → the ATOMIC commit/discard → the terminal with the
 * durably recorded criteria → the replay probe through the REAL
 * idempotency ledger).
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: (typeof OUTCOME_CORPUS)[number];
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly dispatch?: OutcomeDispatch;
  readonly driven: Set<string>;
  readonly facts: () => Promise<OutcomeWorldFacts>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveOutcomeRow>>;
  readonly appSettled: AppOutcome;
  readonly appPassed: boolean;
  readonly appKey: string;
  readonly appBody: Readonly<Record<string, unknown>>;
}> {
  const { world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const seam = createSubmissionSeam(world);
  // The PRE-ROW durable facts (captured BEFORE the app submits).
  const baseline = await options.facts();

  // The customer's controlled fixture world (the effect-state oracle):
  // frozen targets only where the row's declared failure shape demands
  // one (the mid-work rollback row).
  const fixtureWorld = createOutcomeFixtureWorld({
    clock: createRealClock(),
    ...(row.failure?.atEffect === undefined ? {} : { frozenEffects: [row.failure.atEffect] }),
  });

  const appKey = submissionKey({ runSuffix: options.runSuffix, taskIndex });
  const appBody = taskBodyFor({ rowId: row.rowId, quotaMicro: row.quotaMicro });

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runOutcomeApp({
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
      configuration: { suite: "val-026-outcome-correctness" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then(
    (outcome) => ({ ok: true as const, outcome }),
    (error: unknown) => {
      throw error;
    },
  );

  const result = await driveOutcomeRow({
    row,
    lifecycle,
    world: fixtureWorld,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(options.ctx, world, options.driven),
    submissionSeam: seam,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    appKey,
    appBody,
    now: () => new Date(),
  });

  const appSettled = await appPromise;
  return {
    result,
    appSettled,
    appPassed: appSettled.outcome.passed,
    appKey,
    appBody,
  };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-026 outcome-state correctness and side-effect verification over the real platform path",
  (ctx) => {
    test("the offline corpus drives effect-set/atomicity/replay/reconciliation semantics over the REAL platform path", {
      timeout: 300_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const facts = createWorldFacts(ctx, world);
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];
      let totalCommittedEffects = 0;

      try {
        for (const [taskIndex, row] of OFFLINE_CORPUS_ROWS.entries()) {
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { result, appSettled, appPassed, appKey, appBody } = await driveCrownRow({
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
              `[VAL-026][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
            );
            for (const criterion of result.criteria) {
              if (criterion.status === "FAIL") {
                console.info(
                  `[VAL-026][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                );
              }
            }
            const execution = result.execution;
            if (execution !== null) {
              for (const criterion of execution.criteria) {
                if (criterion.status === "FAIL") {
                  console.info(
                    `[VAL-026][DIAGNOSTIC]   exec FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
                  );
                }
              }
            }
          }
          expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);

          // ---- the fixture-state oracle (AC3) ----
          // Completed rows: the FULL declared effect set, exactly once.
          // FAILED rows: the ABSENCE of their effects (the EMPTY delta).
          expect(result.fixtureDelta, `${row.rowId} fixture delta`).toEqual(
            row.expected.fixtureDelta,
          );
          const committedEffects = result.execution?.committedEffects.length ?? 0;
          const discardedEffects = result.execution?.discardedEffects.length ?? 0;
          totalCommittedEffects += committedEffects;
          if (row.expected.terminal === "COMPLETED") {
            expect(committedEffects, `${row.rowId} committed effects`).toBe(
              row.declaredEffects.length,
            );
            expect(discardedEffects, `${row.rowId} discarded effects`).toBe(0);
          } else {
            expect(committedEffects, `${row.rowId} FAILED commits zero effects`).toBe(0);
            // The discard boundary: a guard failure rejects BEFORE any
            // effect stages (nothing to discard); the mid-work and
            // criterion-fail shapes stage first, then discard
            // atomically (the atomicity evidence).
            if (row.failure?.kind === "pre-effect-guard") {
              expect(discardedEffects, `${row.rowId} guard rejects before staging`).toBe(0);
            } else {
              expect(
                discardedEffects,
                `${row.rowId} staged effects discarded atomically`,
              ).toBeGreaterThan(0);
            }
          }

          // ---- the replay probe (AC3: zero new effects) ----
          if (row.replay !== undefined) {
            const probe = result.replayProbe;
            expect(probe, `${row.rowId} replay probe driven`).not.toBeNull();
            expect(probe?.replayed, `${row.rowId} replayed`).toBe(true);
            expect(probe?.sameIdentity, `${row.rowId} identity preserved`).toBe(true);
            expect(probe?.newExecutions, `${row.rowId} zero new executions`).toBe(0);
            expect(probe?.newIdempotencyRecords, `${row.rowId} zero new records`).toBe(0);
            expect(probe?.newEffects, `${row.rowId} zero new effects`).toBe(0);
          }

          // ---- the app's honest outcome over the public wire ----
          expect(validateHarnessEvidence(appSettled.outcome.evidence)).toEqual([]);
          expect(appPassed, `${row.rowId} app passed`).toBe(true);
          expect(appSettled.outcome.observedTerminal, `${row.rowId} app terminal`).toBe(
            row.expected.terminal,
          );
          // The anyFail→FAILED invariant VISIBLE at the customer
          // boundary: a COMPLETED row surfaces all-PASS verification
          // statuses; a FAILED row surfaces its honest FAIL criterion.
          if (row.expected.terminal === "COMPLETED") {
            expect(appSettled.outcome.verificationStatuses.length).toBeGreaterThan(0);
            expect(
              appSettled.outcome.verificationStatuses.every((status) => status === "PASS"),
              `${row.rowId} app statuses: ${JSON.stringify(appSettled.outcome.verificationStatuses)}`,
            ).toBe(true);
          } else {
            expect(
              appSettled.outcome.verificationStatuses.some((status) => status === "FAIL"),
              `${row.rowId} app statuses: ${JSON.stringify(appSettled.outcome.verificationStatuses)}`,
            ).toBe(true);
          }
          const failedOutcomeCriteria = appSettled.outcome.outcomeCriteria.filter(
            (criterion) => criterion.status === "FAIL",
          );
          expect(
            failedOutcomeCriteria,
            `${row.rowId}: ${JSON.stringify(failedOutcomeCriteria)}`,
          ).toEqual([]);

          // ---- the per-execution ledger cross-checks (the REAL journals) ----
          const execution = result.execution;
          if (execution !== null) {
            const events = await ctx.port.execute<{ sequence: number }>({
              sql: `SELECT sequence FROM executions.execution_events
                      WHERE execution_id = $1 ORDER BY sequence ASC`,
              parameters: [execution.executionId],
            });
            const sequences = events.rows.map((eventRow) => eventRow.sequence);
            // The execution_events sequence is GAPLESS.
            const gapless = sequences.every((sequence, index) => sequence === index + 1);
            expect(
              gapless,
              `${row.rowId}/${execution.executionId} sequences: ${sequences.join(",")}`,
            ).toBe(true);

            // The REAL journal's effect records are EXACTLY the
            // committed effects (journal ↔ fixture over REAL SQL);
            // a FAILED execution journals its ONE honest failure
            // record and ZERO effect records.
            const journalRows = await ctx.port.execute<{ kind: string | null }>({
              sql: `SELECT reference->>'kind' AS kind FROM executions.execution_events
                      WHERE execution_id = $1 AND type = 'execution.agent-action-recorded'`,
              parameters: [execution.executionId],
            });
            const effectRecords = journalRows.rows.filter((r) => r.kind === "effect").length;
            const failureRecords = journalRows.rows.filter((r) => r.kind === "failure").length;
            expect(effectRecords, `${row.rowId} REAL journal effect records`).toBe(
              committedEffects,
            );
            expect(failureRecords, `${row.rowId} REAL journal failure records`).toBe(
              row.expected.terminal === "FAILED" ? 1 : 0,
            );

            // The observed terminal is the ledger's own durable claim.
            const durable = await world.executions.getExecution(
              world.applicationId,
              execution.executionId,
            );
            expect(durable?.status, `${row.rowId} durable terminal`).toBe(row.expected.terminal);
          }

          // ---- the app key's ledger cross-check: ONE record, ONE execution ----
          const keyRecords = await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND idempotency_key = $2
                      AND operation_name = 'executions.create'`,
            parameters: [world.applicationId, appKey],
          });
          expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);

          const submission = appSettled.outcome.submission;
          const replay = appSettled.outcome.replay;
          const created =
            submission !== null && submission.rejection === null && !submission.replayed ? 1 : 0;
          const replayedCount = replay?.replayed === true ? 1 : 0;
          const rejectedCount =
            (submission !== null && submission.rejection !== null ? 1 : 0) +
            (replay !== null && replay.rejection !== null ? 1 : 0);
          const appSubmissions = `${created}c+${replayedCount}r+${rejectedCount}x`;
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            committedEffects,
            discardedEffects,
            journaledEffects: execution?.journalEffects.length ?? 0,
            replay:
              result.replayProbe === null
                ? "none"
                : `replayed=${String(result.replayProbe.replayed)} identity=${String(result.replayProbe.sameIdentity)} new=${result.replayProbe.newExecutions}exec/${result.replayProbe.newIdempotencyRecords}rec/${result.replayProbe.newEffects}fx`,
            latencyMs: result.totalLatencyMs,
            appPassed,
            appSubmissions,
            submissionLatencyMs: appSettled.outcome.submissionLatencyMs[0] ?? 0,
            usage:
              result.usage === null
                ? "none-reported"
                : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                  (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
            // Payload DIGESTS only (never the key/body bytes).
            keyDigest: createHash("sha256").update(appKey, "utf8").digest("hex").slice(0, 16),
            bodyDigest: createHash("sha256")
              .update(JSON.stringify(appBody), "utf8")
              .digest("hex")
              .slice(0, 16),
          });
          console.info(
            `[VAL-026]   ${row.rowId} -> ${result.terminal} effects=${committedEffects}committed/${runFacts[runFacts.length - 1]?.journaledEffects}journaled/${discardedEffects}discarded ` +
              `replay=${runFacts[runFacts.length - 1]?.replay} latency=${result.totalLatencyMs}ms ` +
              `app=${appSubmissions} appPassed=${String(appPassed)} ` +
              `usage=${runFacts[runFacts.length - 1]?.usage} ` +
              `keyDigest=${runFacts[runFacts.length - 1]?.keyDigest} bodyDigest=${runFacts[runFacts.length - 1]?.bodyDigest}`,
          );
        }

        // ---- the battery-level ledger integrity (the whole corpus) ----
        const finalFacts = await facts();
        expect(finalFacts.orphanEventCount).toBe(0);
        const expectedExecutions = OFFLINE_CORPUS_ROWS.reduce(
          (sum, row) => sum + row.expected.executions,
          0,
        );
        expect(finalFacts.executionCount, "no phantom executions").toBe(expectedExecutions);
        const expectedKeys = OFFLINE_CORPUS_ROWS.reduce(
          (sum, row) => sum + row.expected.idempotencyRecords,
          0,
        );
        expect(finalFacts.idempotencyRecordCount, "no ledger drift").toBe(expectedKeys);
        // The corpus's total declared effect count landed EXACTLY
        // (the healthy rows' + the replay row's; the FAILED rows'
        // declared effects never landed — the atomicity boundary).
        const expectedTotalEffects = OFFLINE_CORPUS_ROWS.reduce(
          (sum, row) => sum + Object.values(row.expected.fixtureDelta).reduce((a, b) => a + b, 0),
          0,
        );
        expect(totalCommittedEffects, "the full declared effect set").toBe(expectedTotalEffects);

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
        console.info(
          `[VAL-026] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
            `of ${runFacts.length} driven rows; ${totalCommittedEffects} fixture effects committed exactly-once ` +
            `(every FAILED row's delta EMPTY); the ledger holds exactly ${finalFacts.executionCount} executions and ` +
            `${finalFacts.idempotencyRecordCount} idempotency records (zero phantoms, zero drift, zero orphan ` +
            `events); every execution_events sequence gapless; every replayed key arbitrated exactly once with ` +
            `ZERO new effects.`,
        );
        expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live rail drives the outcome semantics with a REAL model confirmation round", {
      timeout: 240_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const notRun: string[] = [];
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-026] OPENROUTER_API_KEY absent — the REAL live outcome row is a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers every effect-set/atomicity/replay/reconciliation path without credentials. " +
            "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
            "covering the default chat model — the REAL confirmation round demands a REAL model dispatch.",
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
        // ONE live dispatch binding for ALL live rows (the VAL-025
        // review lesson): the connection and its sealed credential
        // envelope are registered ONCE and shared.
        let liveDispatch: OutcomeDispatch | undefined;
        for (const [corpusIndex, row] of OUTCOME_CORPUS.entries()) {
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
          // Provider-side pacing before the live row.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const runSuffix = `live-${generateId().slice(-8)}`;
          if (liveDispatch === undefined) {
            liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
          }
          const dispatch: OutcomeDispatch = liveDispatch;
          const { result, appSettled, appPassed, appKey, appBody } = await driveCrownRow({
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
          expect(validateHarnessEvidence(appSettled.outcome.evidence)).toEqual([]);
          expect(appPassed, `${row.rowId} app passed`).toBe(true);
          // The live row's usage is MEASURED (never estimated).
          expect(result.usage === null || result.usage.inputTokens > 0).toBe(true);
          // The live confirmation round PRECEDED the effects: the
          // full declared set committed exactly once behind it.
          expect(result.fixtureDelta).toEqual(row.expected.fixtureDelta);

          const submission = appSettled.outcome.submission;
          const replay = appSettled.outcome.replay;
          const created =
            submission !== null && submission.rejection === null && !submission.replayed ? 1 : 0;
          const replayedCount = replay?.replayed === true ? 1 : 0;
          const rejectedCount =
            (submission !== null && submission.rejection !== null ? 1 : 0) +
            (replay !== null && replay.rejection !== null ? 1 : 0);
          const appSubmissions = `${created}c+${replayedCount}r+${rejectedCount}x`;
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            committedEffects: result.execution?.committedEffects.length ?? 0,
            discardedEffects: result.execution?.discardedEffects.length ?? 0,
            journaledEffects: result.execution?.journalEffects.length ?? 0,
            replay:
              result.replayProbe === null
                ? "none"
                : `replayed=${String(result.replayProbe.replayed)} identity=${String(result.replayProbe.sameIdentity)} new=${result.replayProbe.newExecutions}exec/${result.replayProbe.newIdempotencyRecords}rec/${result.replayProbe.newEffects}fx`,
            latencyMs: result.totalLatencyMs,
            appPassed,
            appSubmissions,
            submissionLatencyMs: appSettled.outcome.submissionLatencyMs[0] ?? 0,
            usage:
              result.usage === null
                ? "none-reported"
                : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                  (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`),
            // Payload DIGESTS only (never the key/body bytes).
            keyDigest: createHash("sha256").update(appKey, "utf8").digest("hex").slice(0, 16),
            bodyDigest: createHash("sha256")
              .update(JSON.stringify(appBody), "utf8")
              .digest("hex")
              .slice(0, 16),
          });
          console.info(
            `[VAL-026]   LIVE ${row.rowId} -> ${result.terminal} effects=${runFacts[runFacts.length - 1]?.committedEffects} ` +
              `latency=${result.totalLatencyMs}ms usage=${runFacts[runFacts.length - 1]?.usage}`,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-026] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
            `over the REAL OpenRouter rail (model ${MODEL}); measured usage on every dispatched round (BYOK).`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-026] NOT RUN boundary: ${boundary}`);
        }
        // At least one REAL live dispatch happened (never an
        // all-NOT-RUN silent pass once a credential is present).
        expect(runFacts.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
