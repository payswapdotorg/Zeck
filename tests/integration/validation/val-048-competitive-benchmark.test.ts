/**
 * VAL-048 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * cross-workload competitive corpus runs end to end against the REAL
 * platform path over REAL PostgreSQL.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the RECORDED COMPETITIVE ARM FACTS — the four arms' recorded
 *     windows per cohort (the VAL-040 Zeck rows, the VAL-041 direct
 *     controls, the VAL-042 optimized baseline, the VAL-043 competing
 *     stack — per-round blocks + arm-level aggregates) — pre-seeded
 *     READ-ONLY into REAL SQL through the platform's own
 *     idempotency-record arbitration (the canonical payload-free
 *     digests as fingerprints: an identical re-commit REPLAYS; a
 *     different-content commit under a recorded key THROWS — the
 *     recorded history is a frozen input), then served back over FRESH
 *     SQL reads as the driver's recorded basis (the served basis
 *     verified digest-for-digest against the row's declared references);
 *   - the REAL executions state machine: the canonical transitions, the
 *     durable planning decisions carrying the COMPETITIVE DECISIONS
 *     (the family, the workload class, the arm set with every digest
 *     reference, the adjusted-basis references, the curve context, the
 *     minimums, the Wilson configuration, the multiple-comparison
 *     policy, the declared weights, the expected verdict) BEFORE any
 *     input is consulted, and the gapless step-event journal
 *     (per-record-distinct idempotency keys — the VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every verified arm bundle sealed
 *     through the REAL validation recorder (the measured model cost as
 *     a measured fact at the arm's own pinned revision while the
 *     planner quotes ride as SEPARATE estimate facts);
 *   - the comparison is a PURE derivation over the RECORDED results:
 *     the ten oracles (input integrity, portfolio honesty, unit
 *     comparability, cost-basis integrity, paired statistics,
 *     multiple-comparison honesty, minimum-sample enforcement,
 *     weighting disclosure, failure-cost completeness, estimate/measure
 *     separation) + the family synthesis (the adjusted rankings, the
 *     exact paired sign tests, the Wilson intervals, the honest
 *     verdicts, the portfolio aggregate's weighted class verdicts);
 *   - every row's honest terminal (COMPLETED for the seven honest
 *     verdict rows — ties, null bases and the under-powered refusal
 *     alike; FAILED for the six adversarial probe rows whose
 *     denatured shapes FAIL their named criteria) and the outcome
 *     contract read back over the REAL ledger.
 *
 * Test 2 (the live rail): the env-gated REAL competitive slice — an
 * absent OPENROUTER_API_KEY is an honest NOT RUN boundary (logged,
 * skipped, never fabricated); the live-path code (REAL dispatches on
 * the pinned OpenRouter rail — ONE dispatch binding for both lanes,
 * measured usage priced at the pinned manifest revision, the provider
 * envelope's usage tokens winning over raw HTTP observations, the
 * empty-completion 200 counted honestly, max_tokens 32 pinned
 * explicitly) is fully wired for when the credential lands.
 *
 * Digest-only assertions everywhere (payload bytes never journaled);
 * no credentials in the repository, logs or reports.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { wilsonInterval } from "../../../benchmarks/validation/accounting/aggregate";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { deriveCostPerResolved } from "../../../benchmarks/validation/apps/economic-baseline/normalization";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { runCompetitiveApp } from "../../../benchmarks/validation/apps/economic-competitive-benchmark/application";
import {
  COMPETITIVE_CORPUS,
  COMPETITIVE_CORPUS_VERSION,
  COMPETITIVE_TASK_KIND,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  RECORDED_COMPETITIVE_CLASSES,
  RECORDED_COMPETITIVE_COHORTS,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/corpus";
import type {
  CompetitiveArmReference,
  CompetitiveCorpusRow,
  RecordedArmRound,
  RecordedCompetitiveFacts,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import {
  driveCompetitiveRow,
  LIVE_COMPETITIVE_PLAN,
  recordedCompetitiveArmOf,
  recordedCompetitiveDigestOf,
} from "../../../benchmarks/validation/apps/economic-competitive-benchmark/driver";
import { createRealAccountingRails } from "../../../benchmarks/validation/apps/economic-competitive-benchmark/fixtures";
import { divRoundHalfUp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const REVISION = createHash("sha256")
  .update("val-048|competitive-benchmark|pinned")
  .digest("hex")
  .slice(0, 40);

/** The REAL SQL operation the crown's durable bindings ride. */
const ARM_HISTORY_OPERATION = "val-048.arm-history";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly family: string;
  readonly workloadClass: string;
  readonly arms: number;
  readonly verifiedArms: number;
  readonly ranking: string;
  readonly pairwise: string;
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
 * the COMPETITIVE DECISIONS, the step-event journal (digest references
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
        `val-048-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-048-competitive",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-048-competitive",
            armDecision,
          },
        },
        `val-048-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-048-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        `val-048-${executionId}-${record.kind}-${record.ordinal}`,
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
            recordedBy: "val-048-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-048-${executionId}-${verdict}`,
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
// The RECORDED competitive arm history served over REAL SQL (the frozen basis)
// ---------------------------------------------------------------------------

/** The generic REAL SQL insert-or-replay arbitration (append-only). */
async function arbitrate(
  ctx: PgContext,
  world: ApiPgWorld,
  generateId: () => string,
  operation: string,
  key: string,
  fingerprint: string,
  durableOutcome: Record<string, unknown>,
): Promise<{
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly refused: boolean;
}> {
  return ctx.port.transaction(async (tx: Transaction) => {
    const inserted = await tx.execute<{ id: string }>({
      sql: `INSERT INTO platform.idempotency_records
                (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
              ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
              DO NOTHING
              RETURNING id`,
      parameters: [
        generateId(),
        world.actorId,
        world.applicationId,
        operation,
        key,
        fingerprint,
        JSON.stringify(durableOutcome),
      ],
    });
    if (inserted.rows.length > 0) {
      return { accepted: true, replayed: false, refused: false };
    }
    const existing = await tx.execute<{ request_fingerprint: string }>({
      sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
      parameters: [world.applicationId, operation, key],
    });
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(`the ${operation} arbitration lost the record ${key}`);
    }
    if (existingRow.request_fingerprint === fingerprint) {
      return { accepted: true, replayed: true, refused: false };
    }
    return { accepted: false, replayed: false, refused: true };
  });
}

/** The read-only commit: an identical re-commit replays, different content THROWS. */
async function commitReadOnly(
  ctx: PgContext,
  world: ApiPgWorld,
  generateId: () => string,
  operation: string,
  key: string,
  fingerprint: string,
  durableOutcome: Record<string, unknown>,
): Promise<boolean> {
  const receipt = await arbitrate(
    ctx,
    world,
    generateId,
    operation,
    key,
    fingerprint,
    durableOutcome,
  );
  if (receipt.refused) {
    throw new Error(
      `append-only violation: the recorded record ${key} is already committed with ` +
        "different content — the recorded competitive history is a read-only input",
    );
  }
  return receipt.replayed;
}

/** The JSONB row-shape guards (honest on unknowns). */
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

type SqlRow = {
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly durable_outcome: Record<string, unknown>;
};

/** Parse ONE SQL arm-history row into its RECORDED facts (honest on unknowns). */
function parseArmRow(row: SqlRow): RecordedCompetitiveFacts | null {
  const outcome = row.durable_outcome;
  const runCount = asNumber(outcome.runCount);
  const resolvedCount = asNumber(outcome.resolvedCount);
  const measuredCostMicroUsd = asString(outcome.measuredCostMicroUsd);
  const estimatedCostMicroUsd = asString(outcome.estimatedCostMicroUsd);
  const costPerResolvedMicroUsd = asString(outcome.costPerResolvedMicroUsd);
  const retryOverheadMicroUsd = asString(outcome.retryOverheadMicroUsd);
  const failedAttemptsCount = asNumber(outcome.failedAttemptsCount);
  const resolvedRoundsMicroUsd = asString(outcome.resolvedRoundsMicroUsd);
  const failedRoundsMicroUsd = asString(outcome.failedRoundsMicroUsd);
  const confidence = outcome.resolutionConfidence;
  if (
    runCount === null ||
    resolvedCount === null ||
    measuredCostMicroUsd === null ||
    estimatedCostMicroUsd === null ||
    retryOverheadMicroUsd === null ||
    failedAttemptsCount === null ||
    resolvedRoundsMicroUsd === null ||
    failedRoundsMicroUsd === null ||
    typeof confidence !== "object" ||
    confidence === null
  ) {
    return null;
  }
  const low = asNumber((confidence as Record<string, unknown>).low);
  const high = asNumber((confidence as Record<string, unknown>).high);
  if (low === null || high === null) {
    return null;
  }
  const roundsRaw = Array.isArray(outcome.rounds) ? outcome.rounds : null;
  if (roundsRaw === null) {
    return null;
  }
  const rounds: RecordedArmRound[] = [];
  for (const entry of roundsRaw) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const roundIndex = asNumber(record.roundIndex);
    const resolved = typeof record.resolved === "boolean" ? record.resolved : null;
    const cost = asString(record.measuredCostMicroUsd);
    const retry = asString(record.retryOverheadMicroUsd);
    const latencyMs = asNumber(record.latencyMs);
    const failedAttempts = asNumber(record.failedAttempts);
    if (
      roundIndex === null ||
      resolved === null ||
      cost === null ||
      retry === null ||
      latencyMs === null ||
      failedAttempts === null
    ) {
      return null;
    }
    rounds.push({
      roundIndex,
      resolved,
      measuredCostMicroUsd: cost,
      retryOverheadMicroUsd: retry,
      latencyMs,
      failedAttempts,
    });
  }
  return {
    rounds,
    runCount,
    resolvedCount,
    measuredCostMicroUsd,
    estimatedCostMicroUsd,
    costPerResolvedMicroUsd: costPerResolvedMicroUsd === null ? null : costPerResolvedMicroUsd,
    resolutionConfidence: { low, high },
    retryOverheadMicroUsd,
    failedAttemptsCount,
    resolvedRoundsMicroUsd,
    failedRoundsMicroUsd,
  };
}

/** The serialized durable outcome of one arm's RECORDED facts. */
function durableOutcomeOfFacts(
  reference: CompetitiveArmReference,
  facts: RecordedCompetitiveFacts,
): Record<string, unknown> {
  return {
    armKind: reference.armKind,
    corpusRowId: reference.corpusRowId,
    priceRevision: reference.priceRevision,
    workloadClass: reference.workloadClass,
    runCount: facts.runCount,
    resolvedCount: facts.resolvedCount,
    measuredCostMicroUsd: facts.measuredCostMicroUsd,
    estimatedCostMicroUsd: facts.estimatedCostMicroUsd,
    costPerResolvedMicroUsd: facts.costPerResolvedMicroUsd,
    resolutionConfidence: {
      low: facts.resolutionConfidence.low,
      high: facts.resolutionConfidence.high,
    },
    retryOverheadMicroUsd: facts.retryOverheadMicroUsd,
    failedAttemptsCount: facts.failedAttemptsCount,
    resolvedRoundsMicroUsd: facts.resolvedRoundsMicroUsd,
    failedRoundsMicroUsd: facts.failedRoundsMicroUsd,
    rounds: facts.rounds.map((round) => ({ ...round })),
  };
}

/**
 * Seed the RECORDED competitive arm history into REAL SQL (read-only):
 * every recorded cohort's arm references (the per-round blocks + the
 * arm-level aggregates). The canonical payload-free digests are the
 * fingerprints; the second pass over an already-seeded world REPLAYS
 * every record.
 */
async function seedRealCompetitiveHistory(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly armRows: number;
  readonly replayed: boolean;
}> {
  const generateId = createUuidv7Generator();
  let armRows = 0;
  let anyReplayed = false;
  for (const cohort of RECORDED_COMPETITIVE_COHORTS) {
    for (const reference of cohort.armSet) {
      const resolved = recordedCompetitiveArmOf(reference);
      if (resolved === null) {
        throw new Error(
          `the recorded arm ${reference.armKind}:${reference.corpusRowId} failed to resolve`,
        );
      }
      const replayed = await commitReadOnly(
        ctx,
        world,
        generateId,
        ARM_HISTORY_OPERATION,
        `${reference.armKind}::${reference.corpusRowId}`,
        reference.recordedDigest,
        durableOutcomeOfFacts(reference, resolved.arm.facts),
      );
      armRows += 1;
      anyReplayed = anyReplayed || replayed;
    }
  }
  return { armRows, replayed: anyReplayed };
}

/**
 * Serve one arm reference's RECORDED competitive facts over FRESH SQL
 * reads (the driver's recorded basis), verified digest-for-digest
 * against the reference's own declared digest.
 */
async function sqlArmFactsOf(
  ctx: PgContext,
  world: ApiPgWorld,
  reference: CompetitiveArmReference,
): Promise<RecordedCompetitiveFacts> {
  const rows = await ctx.port.execute<SqlRow>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
           WHERE application_id = $1 AND operation_name = $2
             AND idempotency_key = $3
           ORDER BY created_at ASC, id ASC`,
    parameters: [
      world.applicationId,
      ARM_HISTORY_OPERATION,
      `${reference.armKind}::${reference.corpusRowId}`,
    ],
  });
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error(
      `the SQL arm history holds no record for ${reference.armKind}::${reference.corpusRowId}`,
    );
  }
  const facts = parseArmRow(row);
  if (facts === null) {
    throw new Error(`the SQL arm row ${row.idempotency_key} failed to parse`);
  }
  if (
    recordedCompetitiveDigestOf({
      armKind: reference.armKind,
      corpusRowId: reference.corpusRowId,
      facts,
    }) !== reference.recordedDigest
  ) {
    throw new Error(
      `the SQL arm row ${row.idempotency_key} disagrees with the declared reference digest`,
    );
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one competitive row crown-style: the app rides the public wire
 * (the customer-side submission + completion poll + result retrieval)
 * while the driver drives the landed execution through the REAL
 * platform path — the RECORDED arm facts served over FRESH SQL reads
 * as the recorded basis, the digest-referenced bundles verified against
 * them, sealed through the REAL accounting rails, the comparison
 * derived PURELY over the recorded results.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: CompetitiveCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
  readonly armsOf: (row: CompetitiveCorpusRow) => Promise<
    readonly {
      readonly reference: CompetitiveArmReference;
      readonly facts: RecordedCompetitiveFacts;
    }[]
  >;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveCompetitiveRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runCompetitiveApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();
  // The RECORDED basis served over FRESH SQL reads (never a copy).
  const arms = await options.armsOf(row);

  const metadata = {
    program: "zeck-validation",
    workOrder: "VAL-048",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: COMPETITIVE_CORPUS_VERSION,
    integrationSurface: "competitive:recorded-arm-history",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-048-competitive-benchmark", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runCompetitiveApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: COMPETITIVE_CORPUS_VERSION,
      integrationSurface: "competitive:recorded-arm-history",
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
      configuration: { suite: "val-048-competitive-benchmark" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveCompetitiveRow({
    row,
    lifecycle,
    arms,
    recordedClasses: RECORDED_COMPETITIVE_CLASSES,
    rails: createRealAccountingRails(),
    metadata,
    environmentIdentity: `val-048-crown-${row.rowId}`,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven, COMPETITIVE_TASK_KIND),
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-048 cross-workload competitive benchmark over the real platform path", (ctx) => {
  test("the offline competitive corpus drives every cross-workload row over the REAL platform path", {
    timeout: 600_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    /** Each adversarial probe row's NAMED criterion (the honest failure). */
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-subset-cherry-picking": "portfolio-honesty",
      "probe-unit-pooling": "unit-comparability",
      "probe-cost-basis-switching": "cost-basis-integrity",
      "probe-unpaired-statistics": "paired-statistics",
      "probe-confidence-inflation": "multiple-comparison-honesty",
      "probe-sample-starvation": "minimum-sample-enforcement",
    };

    /** The arms of one row served over FRESH SQL reads (the probes' denaturation applied). */
    const sqlArmsOf = async (row: CompetitiveCorpusRow) => {
      const honest = await Promise.all(
        row.armSet.map(async (reference) => ({
          reference,
          facts: await sqlArmFactsOf(ctx, world, reference),
        })),
      );
      if (row.adversarial !== "unit-pooling") {
        return honest;
      }
      // The unit-pooling probe: the zero cohort's SQL-served rounds
      // appended to the headline cohort's SQL-served blocks (the
      // pooled incomparable units the unit-comparability oracle names).
      const zeroArms = await Promise.all(
        (
          RECORDED_COMPETITIVE_COHORTS.find((c) => c.workloadClass === "zero-resolved-honest")
            ?.armSet ?? []
        ).map(async (reference) => ({
          reference,
          facts: await sqlArmFactsOf(ctx, world, reference),
        })),
      );
      return honest.map((arm) => {
        const zero = zeroArms.find(
          (candidate) => candidate.reference.armKind === arm.reference.armKind,
        );
        if (zero === undefined) {
          return arm;
        }
        const pooledRounds = [...arm.facts.rounds, ...zero.facts.rounds].map((round, index) => ({
          ...round,
          roundIndex: index,
        }));
        const measured = pooledRounds.reduce(
          (total, round) => total + BigInt(round.measuredCostMicroUsd),
          0n,
        );
        return {
          reference: arm.reference,
          facts: {
            ...arm.facts,
            rounds: pooledRounds,
            runCount: pooledRounds.length,
            resolvedCount: pooledRounds.filter((round) => round.resolved).length,
            measuredCostMicroUsd: measured.toString(),
          },
        };
      });
    };

    try {
      // ---- the RECORDED arm history seeded READ-ONLY over REAL SQL ----
      const seeding = await seedRealCompetitiveHistory(ctx, world);
      expect(seeding.replayed).toBe(false);
      // 3 recorded cohorts × 4 arms = 12 recorded arm windows.
      expect(seeding.armRows).toBe(12);
      // The read-only discipline: the identical re-commit REPLAYS
      // (nothing new lands, nothing drifts).
      const reseed = await seedRealCompetitiveHistory(ctx, world);
      expect(reseed.replayed).toBe(true);
      expect(reseed.armRows).toBe(seeding.armRows);
      // A different-content commit under a recorded key THROWS (the
      // recorded competitive history is a frozen input).
      const headlineZeck = RECORDED_COMPETITIVE_COHORTS[0]?.armSet[0];
      if (headlineZeck === undefined) {
        throw new Error("the recorded cohorts hold no headline zeck arm");
      }
      const resolved = recordedCompetitiveArmOf(headlineZeck);
      if (resolved === null) {
        throw new Error("the headline zeck arm failed to resolve");
      }
      const generateId = createUuidv7Generator();
      await expect(
        commitReadOnly(
          ctx,
          world,
          generateId,
          ARM_HISTORY_OPERATION,
          `${headlineZeck.armKind}::${headlineZeck.corpusRowId}`,
          recordedCompetitiveDigestOf({
            armKind: headlineZeck.armKind,
            corpusRowId: headlineZeck.corpusRowId,
            facts: {
              ...resolved.arm.facts,
              resolvedCount: resolved.arm.facts.resolvedCount + 1,
            },
          }),
          durableOutcomeOfFacts(headlineZeck, {
            ...resolved.arm.facts,
            resolvedCount: resolved.arm.facts.resolvedCount + 1,
          }),
        ),
      ).rejects.toThrow(/append-only violation/);
      // The served basis IS the imported corpus basis (digest-for-digest,
      // over FRESH SQL reads — never a copy, never a re-measurement).
      for (const cohort of RECORDED_COMPETITIVE_COHORTS) {
        for (const reference of cohort.armSet) {
          const served = await sqlArmFactsOf(ctx, world, reference);
          const imported = recordedCompetitiveArmOf(reference);
          if (imported === null) {
            throw new Error(`the arm ${reference.corpusRowId} failed to re-derive`);
          }
          expect(served.rounds, `${reference.armKind}:${reference.corpusRowId}`).toHaveLength(
            imported.arm.facts.rounds.length,
          );
          expect(served.measuredCostMicroUsd, `${reference.armKind}:${reference.corpusRowId}`).toBe(
            imported.arm.facts.measuredCostMicroUsd,
          );
        }
      }

      // ---- every offline row end to end over the REAL platform path ----
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = COMPETITIVE_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
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
          armsOf: sqlArmsOf,
        });

        // ---- the honest outcome contracts ----
        if (result.terminal !== row.expected.terminal) {
          for (const criterion of result.criteria) {
            if (criterion.status === "FAIL") {
              console.info(
                `[VAL-048][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
              );
            }
          }
        }
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
        const failedApp = appOutcome.competitiveCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
        expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

        if (row.expected.terminal === "COMPLETED") {
          // The honest verdict row: every mechanical criterion green —
          // ties, null bases and the under-powered refusal alike (the
          // honest classification IS the verified outcome).
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

        // ---- the verdict is the mechanically derived one ----
        const verdict = result.criteria.find((c) => c.criterionId === "row-outcome-contract");
        expect(verdict?.status).toBe("PASS");
        expect(verdict?.evidence.join(" ")).toContain(`expectedVerdict:${row.expected.verdict}`);

        // ---- every verified arm's digest is journaled ----
        const inputDigests: string[] = [];
        for (const arm of result.arms) {
          expect(arm.reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
          inputDigests.push(arm.reference.recordedDigest);
          if (row.adversarial === undefined) {
            expect(arm.integrity, `${row.rowId} ${arm.reference.armKind}`).toBe(true);
            expect(arm.failureReason, `${row.rowId} ${arm.reference.armKind}`).toBeNull();
          }
        }

        // ---- the comparison reproduces the pinned synthesis ----
        const expected = row.expected.synthesis;
        const synthesis = result.synthesis;
        if (expected !== undefined) {
          expect(synthesis, `${row.rowId} synthesis`).not.toBeNull();
        }
        if (expected !== undefined && synthesis !== null) {
          expect(synthesis.family).toBe(expected.family);
          expect(synthesis.workloadClass).toBe(expected.workloadClass);
          expect(synthesis.ranking.join(",")).toBe(expected.ranking.join(","));
          expect(
            synthesis.arms
              .map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd ?? "NULL"}`)
              .join(","),
          ).toBe(
            expected.arms
              .map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd ?? "NULL"}`)
              .join(","),
          );
          expect(
            synthesis.comparisons
              .map(
                (comparison) =>
                  `${comparison.armKind}:${comparison.zeckFavoring}/${comparison.alternativeFavoring}/${comparison.verdict}`,
              )
              .join(","),
          ).toBe(
            expected.comparisons
              .map(
                (comparison) =>
                  `${comparison.armKind}:${comparison.zeckFavoring}/${comparison.alternativeFavoring}/${comparison.verdict}`,
              )
              .join(","),
          );
          expect(synthesis.verdict).toBe(expected.verdict);
          if (expected.classVerdicts !== undefined) {
            expect(
              (synthesis.classVerdicts ?? [])
                .map((entry) => `${entry.workloadClass}=${entry.weight}->${entry.verdict}`)
                .join(","),
            ).toBe(
              expected.classVerdicts
                .map((entry) => `${entry.workloadClass}=${entry.weight}->${entry.verdict}`)
                .join(","),
            );
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
          family: row.family,
          workloadClass: row.workloadClass,
          arms: result.arms.length,
          verifiedArms: result.arms.filter((arm) => arm.integrity).length,
          ranking: synthesis === null ? "none" : synthesis.ranking.join(" < "),
          pairwise:
            synthesis === null
              ? "none"
              : synthesis.comparisons
                  .map(
                    (comparison) =>
                      `${comparison.armKind}:p=${comparison.pValueTwoSided?.toFixed(4) ?? "none"}/${comparison.verdict}`,
                  )
                  .join(" | "),
          appPassed: appOutcome.passed,
          // Offline rows derive over the RECORDED arm corpora — nothing
          // freshly measured offline (the live rail below owns the
          // measured lane).
          usage: "recorded-arm-history",
          latencyMs: result.totalLatencyMs,
          inputDigests,
        });
        console.info(
          `[VAL-048]   ${row.rowId} -> ${result.terminal} (${row.family}/${row.workloadClass}) ` +
            `arms=${result.arms.length} verified=${runFacts[runFacts.length - 1]?.verifiedArms} ` +
            `ranking=${runFacts[runFacts.length - 1]?.ranking} ` +
            `verdict=${row.expected.verdict} latency=${result.totalLatencyMs}ms ` +
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

      // ---- the recorded basis is still frozen (FRESH SQL reads) ----
      for (const cohort of RECORDED_COMPETITIVE_COHORTS) {
        for (const reference of cohort.armSet) {
          const served = await sqlArmFactsOf(ctx, world, reference);
          const imported = recordedCompetitiveArmOf(reference);
          expect(
            served.measuredCostMicroUsd,
            `${reference.armKind}:${reference.corpusRowId} frozen`,
          ).toBe(imported === null ? "" : imported.arm.facts.measuredCostMicroUsd);
        }
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-048] OFFLINE corpus summary: ${completed} COMPLETED + ${failed} honest FAILED of ` +
          `${runFacts.length} driven rows; ${seeding.armRows} recorded arm windows served ` +
          `READ-ONLY from REAL SQL (the canonical payload-free digests as fingerprints; ` +
          `identical re-commit REPLAYS, different content THROWS); the ledger holds exactly ` +
          `${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
          `idempotency records (zero phantoms, zero drift, zero orphan events); every ` +
          `execution_events sequence gapless; every verified arm sealed through the REAL ` +
          `recorder with the measured model cost at its own pinned revision while the ` +
          `planner quotes ride as separate estimate facts; every comparison reproduces the ` +
          `pinned synthesis (the adjusted rankings, the exact paired sign tests, the Wilson ` +
          `intervals, the honest verdicts, the portfolio aggregate's weighted class ` +
          `verdicts); the portfolio/unit/basis/paired/multiple-comparison/minimum oracles ` +
          `green on every honest verdict row and honestly FAILED on every probe row; ` +
          `usage/latency honestly the recorded history's own offline (none freshly measured — ` +
          `the live rail owns that).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      expect(completed).toBe(7);
      expect(failed).toBe(6);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives one REAL competitive slice over the pinned OpenRouter rail", {
    timeout: 480_000,
  }, async () => {
    const notRun: string[] = [];
    const liveRows = LIVE_CORPUS_ROWS;
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
        "[VAL-048] OPENROUTER_API_KEY absent — the REAL live competitive row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every comparison family over the RECORDED arm corpora without credentials. " +
          "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
          "covering the pinned chat model meta-llama/llama-3.3-70b-instruct on the pinned rail — " +
          "the REAL competitive slice demands the PRIMARY pair's live windows (the Zeck live " +
          "window vs the direct-provider live window, 4 REAL rounds each on the ONE pinned rail " +
          "binding — BYOK, measured usage, every priced input at its pinned manifest revision " +
          "rev-001, max_tokens 32 pinned explicitly, temperature unset per the provider's " +
          "documented default, the provider envelope's usage tokens winning over raw HTTP " +
          "observations, the empty-completion 200 counted honestly), the comparison computed " +
          "over MEASURED facts and the verdict recorded through the REAL recorder with honest " +
          "economics. The optimized and competing LIVE windows remain declared in their own " +
          "corpora for the operator's live review. This live lane is reserved for the " +
          "operator/session-B live review (the recorded-input comparison above never " +
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

    /** Price ONE measured dispatch onto the canonical micro-USD basis. */
    const priceTokensAt = (tokens: number, tier: "input" | "output"): bigint => {
      const manifest = manifestRevisionOf(LIVE_COMPETITIVE_PLAN.rail.priceRevision);
      const entry =
        manifest === null
          ? null
          : resolveListPrice(
              manifest,
              LIVE_COMPETITIVE_PLAN.rail.provider,
              LIVE_COMPETITIVE_PLAN.rail.model,
              tier,
            );
      if (entry === null) {
        throw new Error(
          `the pinned model manifest holds no ${tier} price for ${LIVE_COMPETITIVE_PLAN.rail.model}`,
        );
      }
      const price = parseDecimal(entry.price);
      if (price === null) {
        throw new Error("the pinned list price failed to parse as a decimal");
      }
      return divRoundHalfUp(BigInt(tokens) * price.digits, 10n ** BigInt(price.scale));
    };

    try {
      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          continue;
        }
        // Provider-side pacing between the live rows.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const taskIndex = COMPETITIVE_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        const runSuffix = `live-${createUuidv7Generator()().slice(-8)}`;
        const lifecycle = createLifecycleBinding(world, world.executions);
        const baseline = await facts();

        // ---- the REAL competitive slice: both lanes × 4 REAL dispatches ----
        const measuredLanes = await Promise.all(
          LIVE_COMPETITIVE_PLAN.lanes.map(async (lane) => {
            const rounds: RecordedArmRound[] = [];
            for (let round = 0; round < LIVE_COMPETITIVE_PLAN.rounds; round += 1) {
              const startedAt = Date.now();
              const response = await fetch(LIVE_COMPETITIVE_PLAN.rail.endpoint, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${OPENROUTER_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: LIVE_COMPETITIVE_PLAN.rail.model,
                  max_tokens: LIVE_COMPETITIVE_PLAN.rail.maxTokens,
                  messages: [
                    {
                      role: "user",
                      content: `Reply with the single word: ok (round ${round + 1})`,
                    },
                  ],
                }),
              });
              const wallclockMs = Date.now() - startedAt;
              const payload = (await response.json()) as {
                readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
                readonly usage?: {
                  readonly prompt_tokens?: number;
                  readonly completion_tokens?: number;
                };
              };
              // The provider envelope's usage tokens WIN over raw HTTP
              // observations; the empty-completion 200 is an honest
              // non-error (VAL-014 rule) — priced, counted as a run,
              // resolved only when content actually landed.
              const content = payload.choices?.[0]?.message?.content ?? "";
              const inputTokens = payload.usage?.prompt_tokens ?? 0;
              const outputTokens = payload.usage?.completion_tokens ?? 0;
              const cost =
                priceTokensAt(inputTokens, "input") + priceTokensAt(outputTokens, "output");
              rounds.push({
                roundIndex: round,
                resolved: response.ok && content.length > 0,
                measuredCostMicroUsd: response.ok ? cost.toString() : "0",
                retryOverheadMicroUsd: "0",
                latencyMs: Math.max(wallclockMs, 0),
                failedAttempts: response.ok ? 0 : 1,
              });
            }
            return { lane, rounds };
          }),
        );

        // The live arms (the only place new measurements happen).
        const liveArms = measuredLanes.map((measured) => {
          const reference =
            row.armSet.find((candidate) => candidate.armKind === measured.lane) ?? null;
          if (reference === null) {
            throw new Error(`the live row declares no ${measured.lane} lane`);
          }
          const measuredTotal = measured.rounds.reduce(
            (total, round) => total + BigInt(round.measuredCostMicroUsd),
            0n,
          );
          const resolvedCount = measured.rounds.filter((round) => round.resolved).length;
          return {
            reference,
            facts: {
              rounds: measured.rounds,
              runCount: measured.rounds.length,
              resolvedCount,
              measuredCostMicroUsd: measuredTotal.toString(),
              estimatedCostMicroUsd: "0",
              costPerResolvedMicroUsd: deriveCostPerResolved({
                measuredMicroUsd: measuredTotal.toString(),
                estimatedMicroUsd: "0",
                resolvedCount,
              }).costPerResolvedMicroUsd,
              resolutionConfidence: wilsonInterval(resolvedCount, measured.rounds.length),
              retryOverheadMicroUsd: "0",
              failedAttemptsCount: measured.rounds.filter((round) => round.failedAttempts > 0)
                .length,
              resolvedRoundsMicroUsd: measured.rounds
                .filter((round) => round.resolved)
                .reduce((total, round) => total + BigInt(round.measuredCostMicroUsd), 0n)
                .toString(),
              failedRoundsMicroUsd: measured.rounds
                .filter((round) => !round.resolved)
                .reduce((total, round) => total + BigInt(round.measuredCostMicroUsd), 0n)
                .toString(),
            } satisfies RecordedCompetitiveFacts,
          };
        });

        const metadata = {
          program: "zeck-validation",
          workOrder: "VAL-048",
          baseRevision: REVISION,
          applicationRevision: REVISION,
          corpusRevision: COMPETITIVE_CORPUS_VERSION,
          integrationSurface: "competitive:live-measured-slice",
          environment: {
            runtime: `node ${process.version}`,
            toolchain: "vitest",
            database: "postgresql",
            configuration: { suite: "val-048-competitive-benchmark", row: row.rowId },
          },
          observedAt: new Date().toISOString(),
        };

        const appPromise = runCompetitiveApp({
          config: {
            applicationId: world.applicationId,
            baseUrl: address,
            tokenEnvVar: "ZECK_VALIDATION_TOKEN",
            applicationRevision: REVISION,
            corpusRevision: COMPETITIVE_CORPUS_VERSION,
            integrationSurface: "competitive:live-measured-slice",
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
            configuration: { suite: "val-048-competitive-benchmark" },
          },
          runSuffix,
          taskIndex,
        });

        const result = await driveCompetitiveRow({
          row,
          lifecycle,
          arms: liveArms,
          recordedClasses: RECORDED_COMPETITIVE_CLASSES,
          rails: createRealAccountingRails(),
          metadata,
          environmentIdentity: `val-048-live-${row.rowId}`,
          baseline,
          worldFacts: facts,
          landedProvider: createLandedProvider(ctx, world, driven, COMPETITIVE_TASK_KIND),
          now: () => new Date(),
        });
        const appOutcome = await appPromise;

        // The live lane's honesty invariants: the ledger's own terminal
        // agrees with the mechanically derived verdict (whatever the
        // measured facts derive — never a fabricated pass), the app
        // observed the same terminal, and the measured basis is REAL.
        expect(result.observedTerminal).toBe(result.terminal);
        expect(
          result.criteria.find((c) => c.criterionId === "observed-terminal-readback")?.status,
        ).toBe("PASS");
        expect(appOutcome.observedTerminal).toBe(result.terminal);
        expect(result.synthesis).not.toBeNull();
        expect(result.synthesis?.wilson).not.toBeNull();
        const measuredTotal = liveArms.reduce(
          (total, arm) => total + BigInt(arm.facts.measuredCostMicroUsd),
          0n,
        );
        expect(measuredTotal).toBeGreaterThan(0n);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: result.synthesis?.verdict ?? "none",
          family: row.family,
          workloadClass: row.workloadClass,
          arms: result.arms.length,
          verifiedArms: result.arms.filter((arm) => arm.integrity).length,
          ranking: result.synthesis === null ? "none" : result.synthesis.ranking.join(" < "),
          pairwise:
            result.synthesis === null
              ? "none"
              : result.synthesis.comparisons
                  .map(
                    (comparison) =>
                      `${comparison.armKind}:p=${comparison.pValueTwoSided?.toFixed(4) ?? "none"}/${comparison.verdict}`,
                  )
                  .join(" | "),
          appPassed: appOutcome.passed,
          usage: "rail-measured",
          latencyMs: result.totalLatencyMs,
          inputDigests: result.arms.map((arm) => arm.reference.recordedDigest),
        });
        console.info(
          `[VAL-048]   LIVE ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `lanes=${LIVE_COMPETITIVE_PLAN.lanes.join("+")} ` +
            `ranking=${runFacts[runFacts.length - 1]?.ranking} ` +
            `measured=${measuredTotal.toString()}µ$ latency=${result.totalLatencyMs}ms`,
        );
      }

      const driven0 = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-048] LIVE rail summary: ${driven0} COMPLETED of ${runFacts.length} driven live rows ` +
          `over the REAL OpenRouter rail (both lanes' dispatches priced at the pinned manifest ` +
          `revision, the comparison computed over MEASURED facts, the verdict recorded through ` +
          `the REAL recorder with honest economics — the mechanically derived verdict stands on ` +
          `whatever the measured slice derives, never fabricated).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-048] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live request happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
