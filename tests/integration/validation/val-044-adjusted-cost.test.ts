/**
 * VAL-044 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * adjusted-cost synthesis rows run end to end against the REAL
 * platform path.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL
 *     authorities (seeded PostgreSQL world) on a real port;
 *   - the REAL executions state machine: the canonical transitions,
 *     the durable planning decisions carrying the SYNTHESIS DECISIONS
 *     (the family, the pre-registered arm set with every digest
 *     reference, the minimums, the Wilson configuration, the pinned
 *     revisions, the expected verdict) BEFORE any input is consulted,
 *     and the gapless step-event journal (per-record-distinct
 *     idempotency keys — the VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every verified input is sealed
 *     through the REAL validation recorder (micro-USD cost facts with
 *     the estimate/measured separation, the recorded latencies
 *     carried as recorded) while the driver verifies each RECORDED
 *     arm input against its arm corpus over REAL SQL;
 *   - the synthesis is a PURE derivation over the RECORDED arm
 *     corpora (digest-referenced inputs served and verified over the
 *     imported corpora — never copied, never re-measured, never
 *     re-priced): the five oracles (quality-adjustment honesty,
 *     latency-adjustment inclusion, failure-adjustment completeness,
 *     estimate/measure separation, confidence-and-minimum +
 *     below-minimum refusal honesty + the input-integrity
 *     re-measurement catch) verified mechanically per row — the six
 *     adversarial probe rows FAIL their named criteria honestly (the
 *     honest failure IS the verified outcome);
 *   - every comparison reproduces the corpus's pinned expected
 *     synthesis exactly (the pooled runs/resolved, the measured and
 *     estimate totals, the verified attainment, the family's adjusted
 *     cost, the Wilson 95% interval, the latency compliance);
 *   - the app rides the public SDK boundary (the customer-side
 *     submission + completion poll + result retrieval) while the
 *     driver drives the landed lane.
 *
 * The live rail row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) demands one REAL adjusted comparison over a
 * REAL representative slice with every arm priced at its pinned
 * manifest revision — REAL dispatches on the pinned OpenRouter rail
 * with BYOK credentials and MEASURED usage. The repair binds the
 * REAL dispatch seam the row was declared against: the three arms'
 * live corpus rows are driven over the rail FIRST (the live-rail
 * module's `driveLiveArmsAndRecord` — the 041/042/043 precedent
 * seams' arm characters), the measured traces are RECORDED into the
 * arm corpora, and the synthesis then derives over the RECORDED
 * measured facts with the input-integrity oracle re-deriving them.
 * Absent credentials are a recorded NOT RUN boundary — never a fake
 * success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runAdjustedApp } from "../../../benchmarks/validation/apps/economic-adjusted-cost/application";
import {
  ADJUSTED_CORPUS,
  ADJUSTED_CORPUS_VERSION,
  ADJUSTED_TASK_KIND,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/corpus";
import type {
  AdjustedCorpusRow,
  RecordedArmInput,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import { driveAdjustedRow } from "../../../benchmarks/validation/apps/economic-adjusted-cost/driver";
import {
  createRealAccountingRails,
  inputsForRow,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/fixtures";
import {
  driveLiveArmsAndRecord,
  type LiveRailCompletionRequest,
  type LiveRailCompletionResult,
  type LiveRailDispatch,
} from "../../../benchmarks/validation/apps/economic-adjusted-cost/live-rail";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
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
const REVISION = "3359788a11c0d2f7e5a4b6c8d9e0f1a2b3c4d5e6f";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly inputs: number;
  readonly verifiedInputs: number;
  readonly pooledRuns: number;
  readonly pooledResolved: number;
  readonly measuredMicroUsd: string;
  readonly adjustedMicroUsd: string;
  readonly wilson: string;
  readonly appPassed: boolean;
  readonly usage: string;
  readonly latencyMs: number;
  readonly inputDigests: readonly string[];
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
 * the SYNTHESIS DECISIONS, the step-event journal (digest references
 * only), the terminal completion with the mechanically derived
 * criteria and the observed-terminal read-back.
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
        `val-044-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-044-synthesis",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-044-synthesis",
            armDecision,
          },
        },
        `val-044-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-044-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-044-${executionId}-${record.kind}-${record.ordinal}`,
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
            recordedBy: "val-044-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-044-${executionId}-${verdict}`,
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
// The REAL live dispatch binding (the raw OpenRouter rail completion)
// ---------------------------------------------------------------------------

/**
 * Build the REAL live dispatch binding (the live rows' raw rail
 * seam — the 041/042/043 precedent bindings' own gateway stack): the
 * REAL model gateway over the REAL OpenRouter rail with the REAL
 * fetch transport, the REAL dispatch journal and BYOK credential
 * registration. ONE binding (ONE registered connection) serves the
 * whole live run — the VAL-025 live-run lesson. The binding carries
 * NO synthesis semantics: it issues exactly the completion request
 * the live-rail driver builds (the arm's pinned model, the pinned
 * max_tokens, the arm's own temperature posture) and maps the
 * provider's own report (the measured usage + the charge
 * cross-check observation) onto the raw result — the arm characters,
 * the bounded retry and the trace recording live in the live-rail
 * module.
 */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: LiveRailDispatch }> {
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
        return { satisfied: true, catalogRevision: "val-044", satisfiations: [] } as never;
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
  // ONE connection registered ONCE for the whole live run (the
  // review-proven posture: a per-row registration would mint fresh
  // master keys while the label uniqueness converges onto the first
  // connection — the cross-cipher materialize then fails the envelope
  // integrity check).
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-044-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-044-conn-${generateId().slice(-8)}`,
  );

  const dispatch: LiveRailDispatch = async (request: LiveRailCompletionRequest) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: request.model,
      maxTokens: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      messages: request.messages,
    });
    const latencyMs = Date.now() - startedAt;
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const completion: LiveRailCompletionResult = {
        kind: "success",
        content: response.content.join("\n"),
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          ...(response.usage.costUsd === null || response.usage.costUsd === undefined
            ? {}
            : { costUsd: response.usage.costUsd }),
        },
        latencyMs,
      };
      return completion;
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
    };
  };
  return { dispatch };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one synthesis row crown-style: the app rides the public wire
 * (the customer-side submission + completion poll + result retrieval)
 * while the driver drives the landed execution through the REAL
 * platform path — the RECORDED arm inputs verified against their arm
 * corpora, sealed through the REAL accounting rails, the adjusted
 * comparison derived PURELY over the recorded results. The inputs
 * default to the row's honest recorded bundles; the live row passes
 * the bundles re-derived over its freshly MEASURED arm traces (the
 * live-rail recording — RECORDED digests over real measured facts).
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: AdjustedCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
  /** The row's input bundles (default: the honest recorded bundles). */
  readonly inputs?: readonly RecordedArmInput[];
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveAdjustedRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runAdjustedApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();

  const metadata = {
    program: "zeck-validation",
    workOrder: "VAL-044",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: ADJUSTED_CORPUS_VERSION,
    integrationSurface: "synthesis:recorded-arm-corpora",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-044-adjusted-cost", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runAdjustedApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: ADJUSTED_CORPUS_VERSION,
      integrationSurface: "synthesis:recorded-arm-corpora",
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
      configuration: { suite: "val-044-adjusted-cost" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveAdjustedRow({
    row,
    lifecycle,
    inputs: options.inputs ?? inputsForRow(row),
    rails: createRealAccountingRails(),
    metadata,
    environmentIdentity: `val-044-crown-${row.rowId}`,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven, ADJUSTED_TASK_KIND),
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-044 adjusted-cost synthesis over the real platform path", (ctx) => {
  test("the offline synthesis corpus drives every adjusted comparison over the REAL platform path", {
    timeout: 600_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    /** Each adversarial probe row's NAMED criterion (the honest failure). */
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-quality-inflated-denominator": "quality-adjustment-honesty",
      "probe-latency-omission": "latency-adjustment-inclusion",
      "probe-failure-hiding": "failure-adjustment-completeness",
      "probe-estimate-conflation": "estimate-measure-separation",
      "probe-remeasurement-masquerade": "input-integrity-digest-verified",
      "probe-below-minimum-comparability-claim": "below-minimum-refusal-honesty",
    };

    try {
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = ADJUSTED_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        expect(taskIndex).toBeGreaterThanOrEqual(0);
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
        if (result.terminal !== row.expected.terminal) {
          for (const criterion of result.criteria) {
            if (criterion.status === "FAIL") {
              console.info(
                `[VAL-044][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
              );
            }
          }
        }
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
        const failedApp = appOutcome.adjustedCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
        expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

        if (row.expected.terminal === "COMPLETED") {
          // The honest verdict row: every mechanical criterion green —
          // comparable, honestly-incomparable and refused-below-minimum
          // alike (the honest verdict IS the verified outcome).
          const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
          expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
          expect(result.failure).toBeNull();
        } else {
          // The honest probe failure: the row's NAMED criterion FAILs,
          // the observed terminal read-back agrees (never a fabricated
          // pass) — the honest failure IS the verified outcome.
          const named = probeNamedCriterion[row.rowId];
          expect(named, `${row.rowId} named criterion`).toBeDefined();
          const criterion = result.criteria.find((c) => c.criterionId === named);
          expect(criterion?.status, `${row.rowId} ${named}`).toBe("FAIL");
          expect(result.observedTerminal).toBe("FAILED");
          expect(
            result.criteria.find((c) => c.criterionId === "observed-terminal-readback")?.status,
          ).toBe("PASS");
        }

        // ---- the comparability verdict is the mechanically derived one ----
        const verdict = result.criteria.find((c) => c.criterionId === "row-outcome-contract");
        expect(verdict?.status).toBe("PASS");
        expect(verdict?.evidence.join(" ")).toContain(`expectedVerdict:${row.expected.verdict}`);

        // ---- every verified input's digest is journaled in its pinned class ----
        expect(result.inputs).toHaveLength(row.armSet.length);
        const inputDigests: string[] = [];
        for (const input of result.inputs) {
          expect(input.reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
          inputDigests.push(input.reference.recordedDigest);
          if (row.adversarial === undefined) {
            // The honest rows: every RECORDED arm input verified over
            // REAL SQL against its arm corpus (digest + field equality).
            expect(input.integrity, `${row.rowId} ${input.reference.corpusRowId}`).toBe(true);
          }
        }

        // ---- the comparison reproduces the pinned synthesis ----
        const expected = row.expected.synthesis;
        const synthesis = result.synthesis;
        expect(synthesis).not.toBeNull();
        if (expected !== undefined && synthesis !== null) {
          expect(synthesis.family).toBe(expected.family);
          expect(synthesis.pooledRuns).toBe(expected.pooledRuns);
          expect(synthesis.pooledResolved).toBe(expected.pooledResolved);
          expect(synthesis.measuredCostMicroUsd).toBe(expected.measuredCostMicroUsd);
          expect(synthesis.estimatedCostMicroUsd).toBe(expected.estimatedCostMicroUsd);
          expect(synthesis.attainment).toBeCloseTo(expected.attainment, 12);
          expect(synthesis.adjustedCostMicroUsd).toBe(expected.adjustedCostMicroUsd);
          expect(synthesis.wilson.low).toBeCloseTo(expected.wilson.low, 12);
          expect(synthesis.wilson.high).toBeCloseTo(expected.wilson.high, 12);
          if (expected.latencyCompliance === null) {
            expect(synthesis.latencyCompliance).toBeNull();
          } else {
            expect(synthesis.latencyCompliance ?? 0).toBeCloseTo(expected.latencyCompliance, 12);
          }
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
          verdict: row.expected.verdict,
          inputs: result.inputs.length,
          verifiedInputs: result.inputs.filter((input) => input.integrity).length,
          pooledRuns: synthesis?.pooledRuns ?? 0,
          pooledResolved: synthesis?.pooledResolved ?? 0,
          measuredMicroUsd: synthesis?.measuredCostMicroUsd ?? "0",
          adjustedMicroUsd: synthesis?.adjustedCostMicroUsd ?? "null",
          wilson:
            synthesis === null
              ? "none"
              : `[${synthesis.wilson.low.toFixed(3)}, ${synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          // Offline rows derive over the RECORDED arm corpora — the
          // usage is the recorded traces' own (none freshly measured
          // offline; the live rail below owns the measured rail).
          usage: "recorded-arm-corpora",
          latencyMs: result.totalLatencyMs,
          inputDigests,
        });
        console.info(
          `[VAL-044]   ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `inputs=${result.inputs.length} verified=${runFacts[runFacts.length - 1]?.verifiedInputs} ` +
            `pooled=${synthesis?.pooledRuns ?? 0}r/${synthesis?.pooledResolved ?? 0}x ` +
            `measured=${synthesis?.measuredCostMicroUsd ?? "0"}µ$ ` +
            `adjusted=${synthesis?.adjustedCostMicroUsd ?? "null"}µ$ ` +
            `wilson=${runFacts[runFacts.length - 1]?.wilson} verdict=${row.expected.verdict} ` +
            `latency=${result.totalLatencyMs}ms appPassed=${String(appOutcome.passed)}`,
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
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-044] OFFLINE corpus summary: ${completed} COMPLETED + ${failed} honest FAILED of ${runFacts.length} driven rows; ` +
          `the ledger holds exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
          `idempotency records (zero phantoms, zero drift, zero orphan events); every execution_events ` +
          `sequence gapless; every verified input sealed through the REAL recorder with the estimate/` +
          `measured separation and the recorded latencies carried as recorded; every comparison ` +
          `reproduces the pinned synthesis (the pooled runs/resolved, the measured and estimate ` +
          `totals, the verified attainment, the family's adjusted cost, the Wilson 95% interval, the ` +
          `latency compliance); the quality/latency/failure/estimate/minimum oracles green on every ` +
          `honest verdict row and honestly FAILED on every probe row (the inflated claims, omitted ` +
          `latencies, hidden failures, conflated estimates, re-measurements and below-minimum claims ` +
          `named); usage/latency honestly the recorded arm corpora's own offline (none freshly ` +
          `measured — the live rail owns that).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      expect(completed).toBe(7);
      expect(failed).toBe(6);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives one REAL adjusted comparison over a REAL representative slice", {
    timeout: 480_000,
  }, async () => {
    const notRun: string[] = [];
    const liveRows = ADJUSTED_CORPUS.filter((row) => row.liveGate !== undefined);
    for (const row of liveRows) {
      if (!liveGateOpen(row, process.env)) {
        notRun.push(
          `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+") ?? "?"} absent); ` +
            `requirement: ${row.liveGate?.requirement ?? ""}`,
        );
      }
    }
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-044] OPENROUTER_API_KEY absent — the REAL live adjusted-cost synthesis row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every adjusted-cost family over the three arms' RECORDED results without " +
          "credentials. Required access: an operator-authorized OpenRouter credential (env " +
          "OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct on " +
          "every arm's pinned rail — the REAL adjusted comparison demands REAL dispatches over a " +
          "REAL representative slice on each of the three arms' live rows (BYOK, measured usage, " +
          "every arm priced at its pinned manifest revision rev-001, temperature unset per the " +
          "provider's documented default, max_tokens 64 pinned explicitly, the measured facts " +
          "composed into the adjusted families with the Wilson 95% interval and the verdict " +
          "recorded through the REAL recorder with honest economics). This live lane is reserved " +
          "for the operator/session-B live review (the recorded-input synthesis above never " +
          "re-measures; the live row is the only place new measurements happen).",
      );
      expect(notRun.length).toBe(liveRows.length);
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      // ONE live dispatch binding for the whole live run (the
      // review-proven VAL-025 posture): the connection and its sealed
      // credential envelope are registered ONCE and shared.
      const { dispatch } = await buildLiveDispatch(ctx, world);

      // ---- the REAL dispatch seam (the Task-78/79 repair): the three
      //      arms' live corpus rows are driven over the rail FIRST and
      //      the MEASURED traces recorded — the arm references then
      //      carry RECORDED digests over real measured facts and the
      //      input-integrity oracle re-derives them ----
      const recording = await driveLiveArmsAndRecord({
        dispatch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        paceMs: 500,
      });
      for (const arm of recording.arms) {
        console.info(
          `[VAL-044]   LIVE arm ${arm.armLabel}:${arm.corpusRowId} -> recorded ` +
            `${arm.runCount}r/${arm.resolvedCount}x over ${arm.dispatchedRequests} REAL dispatch(es)` +
            `${arm.cacheHits > 0 ? ` + ${arm.cacheHits} cache hit(s)` : ""} ` +
            `measured=${arm.measuredCostMicroUsd}µ$ digest=${arm.recordedDigest} ` +
            `latency=${arm.latencyMs}ms`,
        );
      }
      console.info(
        `[VAL-044] LIVE arms recorded: ${recording.totalDispatches} REAL dispatch(es) on the pinned ` +
          `rail, ${recording.totalMeasuredMicroUsd}µ$ measured total, wallclock ${recording.totalLatencyMs}ms ` +
          `— the three arms' live traces are now the RECORDED corpora the synthesis derives over.`,
      );

      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          continue;
        }
        // Provider-side pacing between the live rows.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const taskIndex = ADJUSTED_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        const runSuffix = `live-${createUuidv7Generator()().slice(-8)}`;
        const { result, appOutcome } = await driveCrownRow({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          driven,
          facts,
          // The live row consumes the bundles re-derived over the
          // freshly MEASURED arm traces (RECORDED digests — the
          // input-integrity oracle re-derives the same facts).
          ...(row.needsDispatch ? { inputs: recording.inputs } : {}),
        });

        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        // The live row's usage is MEASURED (never estimated): the
        // comparison's measured basis is populated from REAL tokens.
        expect(result.synthesis?.measuredCostMicroUsd ?? "0").not.toBe("0");
        const synthesis = result.synthesis;
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: row.expected.verdict,
          inputs: result.inputs.length,
          verifiedInputs: result.inputs.filter((input) => input.integrity).length,
          pooledRuns: synthesis?.pooledRuns ?? 0,
          pooledResolved: synthesis?.pooledResolved ?? 0,
          measuredMicroUsd: synthesis?.measuredCostMicroUsd ?? "0",
          adjustedMicroUsd: synthesis?.adjustedCostMicroUsd ?? "null",
          wilson:
            synthesis === null
              ? "none"
              : `[${synthesis.wilson.low.toFixed(3)}, ${synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          usage: "rail-measured",
          latencyMs: result.totalLatencyMs,
          inputDigests: result.inputs.map((input) => input.reference.recordedDigest),
        });
        console.info(
          `[VAL-044]   LIVE ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `inputs=${result.inputs.length} verified=${runFacts[runFacts.length - 1]?.verifiedInputs} ` +
            `pooled=${synthesis?.pooledRuns ?? 0}r/${synthesis?.pooledResolved ?? 0}x ` +
            `measured=${synthesis?.measuredCostMicroUsd ?? "0"}µ$ ` +
            `adjusted=${synthesis?.adjustedCostMicroUsd ?? "null"}µ$ ` +
            `digests=${runFacts[runFacts.length - 1]?.inputDigests.join(",")} ` +
            `latency=${result.totalLatencyMs}ms appPassed=${String(appOutcome.passed)}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-044] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live rows ` +
          `over the REAL OpenRouter rail (${recording.totalDispatches} REAL dispatches on the three ` +
          `arms' live slices recorded into their corpora first — every arm priced at its pinned ` +
          `manifest revision, the arm references carrying RECORDED digests over the MEASURED traces, ` +
          `the input-integrity oracle re-deriving them, the adjusted families computed over MEASURED ` +
          `facts, the verdict recorded through the REAL recorder with honest economics).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-044] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live request happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
