/**
 * VAL-047 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * longitudinal cost-curve corpus runs end to end against the REAL
 * platform path over REAL PostgreSQL.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the RECORDED CURVE INPUTS — the longitudinal ledgers + the
 *     VAL-045 attribution results — pre-seeded READ-ONLY into REAL SQL
 *     through the platform's own idempotency-record arbitration (the
 *     canonical payload-free digests as fingerprints: an identical
 *     re-commit REPLAYS; a different-content commit under a recorded
 *     key THROWS — the recorded history is a frozen input), then served
 *     back over FRESH SQL reads as the driver's recorded basis (the
 *     served basis is verified digest-for-digest against the imported
 *     corpora — the platform serves the RECORDED results, never a
 *     copy, never a re-measurement);
 *   - the REAL executions state machine: the canonical transitions, the
 *     durable planning decisions carrying the CURVE DECISIONS (the
 *     family, the workload class, the declared window with every
 *     digest reference, the declared cohorts, the regime change
 *     points, the minimums, the Wilson configuration, the expected
 *     verdict) BEFORE any input is consulted, and the gapless
 *     step-event journal (per-record-distinct idempotency keys — the
 *     VAL-018 lesson);
 *   - the REAL idempotency ledger arbitrating every submission (one
 *     record per app key; no drift, no phantoms, no orphan events —
 *     verified against the REAL SQL row counts);
 *   - the REAL accounting rails: every verified ledger point is sealed
 *     through the REAL validation recorder (the measured model cost
 *     and the substrate overhead as measured facts at their own pinned
 *     revisions — the VAL-040 model manifests + the VAL-046 substrate
 *     manifests — while the planner quote rides as a SEPARATE estimate
 *     fact);
 *   - the curve is a PURE derivation over the RECORDED results: the
 *     nine oracles (input integrity, window honesty, price-regime
 *     marking, no extrapolation, improvement-rate reconciliation, cohort
 *     honesty, estimate/measure separation, confidence-and-minimum,
 *     below-minimum refusal honesty) + the family synthesis (the
 *     cost-per-outcome trajectory, the improvement-rate decomposition,
 *     the plateau-maturity verdict) with the Wilson 95% interval;
 *   - every row's honest terminal (COMPLETED for the four honest
 *     verdict rows — improving, plateaued, never-materialized and
 *     mixed-cohort-regressing alike; FAILED for the eight adversarial
 *     probe rows whose denatured shapes FAIL their named criteria) and
 *     the outcome contract read back over the REAL ledger.
 *
 * Test 2 (the live rail): the env-gated REAL longitudinal slice — an
 * absent OPENROUTER_API_KEY is an honest NOT RUN boundary (logged,
 * skipped, never fabricated); the live-path code (REAL dispatches on
 * the pinned OpenRouter rail, measured usage priced at the pinned
 * manifest revisions) is fully wired for when the credential lands.
 *
 * Digest-only assertions everywhere (payload bytes never journaled);
 * no credentials in the repository, logs or reports.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type {
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { runCurveApp } from "../../../benchmarks/validation/apps/economic-longitudinal-curve/application";
import {
  CURVE_CORPUS,
  CURVE_CORPUS_VERSION,
  CURVE_TASK_KIND,
  curveAttributionResultOf,
  curveLedgerById,
  LIVE_CORPUS_ROWS,
  LONGITUDINAL_LEDGERS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/corpus";
import type {
  CurveAttributionResult,
  CurveCorpusRow,
  CurvePointInput,
  RecordedCurvePoint,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  curveAttributionDigestOf,
  driveCurveRow,
  LIVE_CURVE_PLAN,
  liveCurvePlanDigestOf,
  recordedCurvePointDigestOf,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/driver";
import {
  createRealAccountingRails,
  curveInputsForRow,
} from "../../../benchmarks/validation/apps/economic-longitudinal-curve/fixtures";
import {
  deriveSubstrateManifestIntegrity,
  divRoundHalfUp,
  fxRateForSubstrate,
  priceMeasuredMs,
  resolveSubstratePrice,
  substrateManifestFor,
} from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const REVISION = createHash("sha256")
  .update("val-047|longitudinal-curve|pinned")
  .digest("hex")
  .slice(0, 40);

/** The REAL SQL operations the crown's durable bindings ride. */
const LEDGER_HISTORY_OPERATION = "val-047.ledger-history";
const ATTRIBUTION_HISTORY_OPERATION = "val-047.attribution-history";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly family: string;
  readonly workloadClass: string;
  readonly points: number;
  readonly verifiedPoints: number;
  readonly trajectory: string;
  readonly totalImprovementMicroUsd: string;
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
 * the CURVE DECISIONS, the step-event journal (digest references
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
        `val-047-${executionId}-${step}-${transitionCounter}`,
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
                strategyId: "val-047-curve",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-047-curve",
            armDecision,
          },
        },
        `val-047-${executionId}-decision`,
      );
    },
    async recordStepEvent({ executionId, record }) {
      await executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-047-${record.kind}-${record.ordinal}`,
          reference: {
            kind: record.kind,
            ordinal: record.ordinal,
            digest: record.digest,
          },
          payload: { kind: record.kind, ordinal: record.ordinal },
        },
        // Distinct per record (the ledger sees distinct payloads — the
        // VAL-018 lesson).
        `val-047-${executionId}-${record.kind}-${record.ordinal}`,
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
            recordedBy: "val-047-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-047-${executionId}-${verdict}`,
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
// The RECORDED curve inputs served over REAL SQL (the frozen basis)
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
        "different content — the recorded longitudinal history is a read-only input",
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

/**
 * Seed the RECORDED curve inputs into REAL SQL (read-only): every
 * workload class's longitudinal ledger points (the curve's own fact
 * basis — the runs, the successful outcomes, the measured model cost,
 * the substrate overhead share, the pinned price revisions) and every
 * generation's RECORDED VAL-045 attribution result (the per-mechanism
 * attributed split + the honest residual + the digest references).
 * The canonical payload-free digests are the fingerprints; the second
 * pass over an already-seeded world REPLAYS every record.
 */
async function seedRealCurveHistory(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly ledgerRows: number;
  readonly attributionRows: number;
  readonly replayed: boolean;
}> {
  const generateId = createUuidv7Generator();
  let ledgerRows = 0;
  let attributionRows = 0;
  let anyReplayed = false;
  for (const ledger of LONGITUDINAL_LEDGERS) {
    for (const point of ledger.points) {
      const replayed = await commitReadOnly(
        ctx,
        world,
        generateId,
        LEDGER_HISTORY_OPERATION,
        `${ledger.workloadClass}::g${point.generation}`,
        recordedCurvePointDigestOf(point),
        {
          workloadClass: point.workloadClass,
          generation: point.generation,
          runs: point.runs,
          successfulOutcomes: point.successfulOutcomes,
          measuredModelCostMicroUsd: point.measuredModelCostMicroUsd,
          substrateOverheadMicroUsd: point.substrateOverheadMicroUsd,
          modelPriceRevision: point.modelPriceRevision,
          substratePriceRevision: point.substratePriceRevision,
          costBasis: point.costBasis,
          ...(point.estimatedQuoteMicroUsd === undefined
            ? {}
            : { estimatedQuoteMicroUsd: point.estimatedQuoteMicroUsd }),
        },
      );
      ledgerRows += 1;
      anyReplayed = anyReplayed || replayed;
    }
    const generations = [...ledger.points]
      .sort((left, right) => left.generation - right.generation)
      .map((point) => point.generation);
    const lastGeneration = generations[generations.length - 1] ?? 0;
    for (let generation = 1; generation <= lastGeneration; generation += 1) {
      const result = curveAttributionResultOf(ledger.workloadClass, generation);
      const replayed = await commitReadOnly(
        ctx,
        world,
        generateId,
        ATTRIBUTION_HISTORY_OPERATION,
        `${ledger.workloadClass}::g${generation}`,
        result.attributionDigest,
        {
          workloadClass: result.workloadClass,
          generation: result.generation,
          attributedMicroUsd: { ...result.attributedMicroUsd },
          residualMicroUsd: result.residualMicroUsd,
          ledgerEntryDigests: [...result.ledgerEntryDigests],
          recordedTotalDigests: [...result.recordedTotalDigests],
        },
      );
      attributionRows += 1;
      anyReplayed = anyReplayed || replayed;
    }
  }
  return { ledgerRows, attributionRows, replayed: anyReplayed };
}

/** Parse ONE SQL ledger row into its RECORDED point (honest on unknowns). */
function parseLedgerRow(row: SqlRow): RecordedCurvePoint | null {
  const outcome = row.durable_outcome;
  const workloadClass = asString(outcome.workloadClass);
  const generation = asNumber(outcome.generation);
  const runs = asNumber(outcome.runs);
  const successfulOutcomes = asNumber(outcome.successfulOutcomes);
  const measuredModelCostMicroUsd = asNumber(outcome.measuredModelCostMicroUsd);
  const substrateOverheadMicroUsd = asNumber(outcome.substrateOverheadMicroUsd);
  const modelPriceRevision = asString(outcome.modelPriceRevision);
  const substratePriceRevision = asString(outcome.substratePriceRevision);
  const costBasis = asString(outcome.costBasis);
  if (
    workloadClass === null ||
    generation === null ||
    runs === null ||
    successfulOutcomes === null ||
    measuredModelCostMicroUsd === null ||
    substrateOverheadMicroUsd === null ||
    modelPriceRevision === null ||
    substratePriceRevision === null ||
    costBasis !== "measured"
  ) {
    return null;
  }
  const estimatedQuoteMicroUsd = asNumber(outcome.estimatedQuoteMicroUsd);
  const quote =
    estimatedQuoteMicroUsd === null || estimatedQuoteMicroUsd === undefined
      ? null
      : estimatedQuoteMicroUsd;
  return {
    workloadClass,
    generation,
    runs,
    successfulOutcomes,
    measuredModelCostMicroUsd,
    substrateOverheadMicroUsd,
    modelPriceRevision,
    substratePriceRevision,
    costBasis: "measured",
    ...(quote === null ? {} : { estimatedQuoteMicroUsd: quote }),
  };
}

/** Parse ONE SQL attribution row into its RECORDED result (honest on unknowns). */
function parseAttributionRow(row: SqlRow): CurveAttributionResult | null {
  const outcome = row.durable_outcome;
  const workloadClass = asString(outcome.workloadClass);
  const generation = asNumber(outcome.generation);
  const residualMicroUsd = asNumber(outcome.residualMicroUsd);
  const attributed = outcome.attributedMicroUsd;
  if (
    workloadClass === null ||
    generation === null ||
    residualMicroUsd === null ||
    typeof attributed !== "object" ||
    attributed === null
  ) {
    return null;
  }
  const mechanisms = attributed as Record<string, unknown>;
  const numbers = ["reuse", "cache", "competence", "deterministicization"].map(
    (mechanism) => mechanisms[mechanism],
  );
  if (numbers.some((value) => typeof value !== "number")) {
    return null;
  }
  const ledgerEntryDigests = Array.isArray(outcome.ledgerEntryDigests)
    ? (outcome.ledgerEntryDigests as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : null;
  const recordedTotalDigests = Array.isArray(outcome.recordedTotalDigests)
    ? (outcome.recordedTotalDigests as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : null;
  if (ledgerEntryDigests === null || recordedTotalDigests === null) {
    return null;
  }
  const preliminary = {
    workloadClass,
    generation,
    attributedMicroUsd: {
      reuse: numbers[0] as number,
      cache: numbers[1] as number,
      competence: numbers[2] as number,
      deterministicization: numbers[3] as number,
    },
    residualMicroUsd,
    ledgerEntryDigests,
    recordedTotalDigests,
  };
  return { ...preliminary, attributionDigest: curveAttributionDigestOf(preliminary) };
}

/**
 * Serve one workload class's RECORDED curve basis over FRESH SQL reads
 * (the driver's recorded ledger + the recorded attribution results),
 * verified digest-for-digest against the SQL rows' own fingerprints.
 */
async function sqlCurveBasisOf(
  ctx: PgContext,
  world: ApiPgWorld,
  workloadClass: string,
): Promise<{
  readonly ledger: readonly RecordedCurvePoint[];
  readonly attribution: readonly CurveAttributionResult[];
}> {
  const ledgerRows = await ctx.port.execute<SqlRow>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
           WHERE application_id = $1 AND operation_name = $2
             AND idempotency_key LIKE $3 || '%'
           ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, LEDGER_HISTORY_OPERATION, `${workloadClass}::`],
  });
  const attributionRows = await ctx.port.execute<SqlRow>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
           WHERE application_id = $1 AND operation_name = $2
             AND idempotency_key LIKE $3 || '%'
           ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, ATTRIBUTION_HISTORY_OPERATION, `${workloadClass}::`],
  });
  const ledger = ledgerRows.rows.flatMap((row) => {
    const point = parseLedgerRow(row);
    if (point === null) {
      throw new Error(`the SQL ledger row ${row.idempotency_key} failed to parse`);
    }
    // The served basis IS the recorded content: the re-derived digest
    // equals the SQL row's own fingerprint (the digest discipline).
    if (recordedCurvePointDigestOf(point) !== row.request_fingerprint) {
      throw new Error(
        `the SQL ledger row ${row.idempotency_key} disagrees with its own fingerprint`,
      );
    }
    return [point];
  });
  const attribution = attributionRows.rows.flatMap((row) => {
    const result = parseAttributionRow(row);
    if (result === null) {
      throw new Error(`the SQL attribution row ${row.idempotency_key} failed to parse`);
    }
    if (result.attributionDigest !== row.request_fingerprint) {
      throw new Error(
        `the SQL attribution row ${row.idempotency_key} disagrees with its own fingerprint`,
      );
    }
    return [result];
  });
  return { ledger, attribution };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one curve row crown-style: the app rides the public wire (the
 * customer-side submission + completion poll + result retrieval) while
 * the driver drives the landed execution through the REAL platform
 * path — the RECORDED ledger points + VAL-045 attribution results
 * served over FRESH SQL reads as the recorded basis, the digest-
 * referenced bundles verified against them, sealed through the REAL
 * accounting rails, the curve derived PURELY over the recorded results.
 */
async function driveCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: CurveCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly driven: Set<string>;
  readonly facts: () => Promise<EconomicWorldFacts>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof driveCurveRow>>;
  readonly appOutcome: Awaited<ReturnType<typeof runCurveApp>>;
}> {
  const { ctx, world, row, taskIndex } = options;
  const lifecycle = createLifecycleBinding(world, world.executions);
  const baseline = await options.facts();
  // The RECORDED basis served over FRESH SQL reads (never a copy).
  const basis = await sqlCurveBasisOf(ctx, world, row.workloadClass);
  const inputs = curveInputsForRow(row);

  const metadata = {
    program: "zeck-validation",
    workOrder: "VAL-047",
    baseRevision: REVISION,
    applicationRevision: REVISION,
    corpusRevision: CURVE_CORPUS_VERSION,
    integrationSurface: "curve:recorded-longitudinal-history",
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-047-longitudinal-curve", row: row.rowId },
    },
    observedAt: new Date().toISOString(),
  };

  // The app promise: submits through the public wire and polls to the
  // row's terminal while the driver drives the landed lane.
  const appPromise = runCurveApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: CURVE_CORPUS_VERSION,
      integrationSurface: "curve:recorded-longitudinal-history",
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
      configuration: { suite: "val-047-longitudinal-curve" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  });

  const result = await driveCurveRow({
    row,
    lifecycle,
    points: inputs.points,
    attribution: inputs.attribution,
    recordedLedger: basis.ledger,
    recordedAttribution: basis.attribution,
    rails: createRealAccountingRails(),
    metadata,
    environmentIdentity: `val-047-crown-${row.rowId}`,
    baseline,
    worldFacts: options.facts,
    landedProvider: createLandedProvider(ctx, world, options.driven, CURVE_TASK_KIND),
    now: () => new Date(),
  });
  const appOutcome = await appPromise;
  return { result, appOutcome };
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-047 longitudinal cost curve over the real platform path", (ctx) => {
  test("the offline curve corpus drives every longitudinal cost-curve row over the REAL platform path", {
    timeout: 600_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const facts = createWorldFacts(ctx, world);
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    /** Each adversarial probe row's NAMED criterion (the honest failure). */
    const probeNamedCriterion: Readonly<Record<string, string>> = {
      "probe-cherry-picked-window": "window-honesty",
      "probe-regime-normalizing": "price-regime-marking",
      "probe-extrapolating": "no-extrapolation",
      "probe-residual-hiding": "improvement-rate-reconciliation",
      "probe-cohort-hiding": "cohort-honesty",
      "probe-post-hoc-exclusion": "confidence-and-minimum",
      "probe-sample-size-violation": "below-minimum-refusal-honesty",
      "probe-remeasurement-masquerade": "curve-input-integrity",
    };

    try {
      // ---- the RECORDED curve inputs seeded READ-ONLY over REAL SQL ----
      const seeding = await seedRealCurveHistory(ctx, world);
      expect(seeding.replayed).toBe(false);
      // 20 recorded ledger points + 15 recorded attribution results.
      expect(seeding.ledgerRows).toBe(20);
      expect(seeding.attributionRows).toBe(20 - LONGITUDINAL_LEDGERS.length);
      // The read-only discipline: the identical re-commit REPLAYS
      // (nothing new lands, nothing drifts).
      const reseed = await seedRealCurveHistory(ctx, world);
      expect(reseed.replayed).toBe(true);
      expect(reseed.ledgerRows).toBe(seeding.ledgerRows);
      expect(reseed.attributionRows).toBe(seeding.attributionRows);
      // A different-content commit under a recorded key THROWS (the
      // recorded longitudinal history is a frozen input).
      const invoice = curveLedgerById("invoice-extraction");
      const baselinePoint = invoice?.points.find((point) => point.generation === 0);
      if (baselinePoint === undefined) {
        throw new Error("the invoice ledger holds no baseline point");
      }
      const generateId = createUuidv7Generator();
      await expect(
        commitReadOnly(
          ctx,
          world,
          generateId,
          LEDGER_HISTORY_OPERATION,
          `invoice-extraction::g0`,
          recordedCurvePointDigestOf({ ...baselinePoint, runs: baselinePoint.runs + 1 }),
          { ...baselinePoint, runs: baselinePoint.runs + 1 },
        ),
      ).rejects.toThrow(/append-only violation/);
      // The served basis IS the imported corpus basis (digest-for-digest,
      // over FRESH SQL reads — never a copy, never a re-measurement).
      for (const ledger of LONGITUDINAL_LEDGERS) {
        const served = await sqlCurveBasisOf(ctx, world, ledger.workloadClass);
        expect(served.ledger, `${ledger.workloadClass} served ledger`).toHaveLength(
          ledger.points.length,
        );
        for (const point of served.ledger) {
          const imported = ledger.points.find(
            (candidate) => candidate.generation === point.generation,
          );
          expect(imported, `${ledger.workloadClass}@g${point.generation}`).toBeDefined();
          expect(
            recordedCurvePointDigestOf(point),
            `${ledger.workloadClass}@g${point.generation} digest`,
          ).toBe(imported === undefined ? "" : recordedCurvePointDigestOf(imported));
          // Every served point's substrate revision verifies against the
          // VAL-046 substrate manifests (REAL PG serving REAL pinned facts).
          expect(
            deriveSubstrateManifestIntegrity({ revision: point.substratePriceRevision }).agreed,
            `${ledger.workloadClass}@g${point.generation} substrate manifest`,
          ).toBe(true);
        }
        const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
        const lastGeneration = sorted[sorted.length - 1]?.generation ?? 0;
        expect(served.attribution, `${ledger.workloadClass} served attribution`).toHaveLength(
          lastGeneration,
        );
      }

      // ---- every offline row end to end over the REAL platform path ----
      for (const row of OFFLINE_CORPUS_ROWS) {
        const taskIndex = CURVE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
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
                `[VAL-047][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
              );
            }
          }
        }
        expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
        expect(appOutcome.passed, `${row.rowId} app passed`).toBe(true);
        expect(validateHarnessEvidence(appOutcome.evidence)).toEqual([]);
        const failedApp = appOutcome.curveCriteria.filter(
          (criterion) => criterion.status === "FAIL",
        );
        expect(failedApp, `${row.rowId} app: ${JSON.stringify(failedApp)}`).toEqual([]);
        expect(appOutcome.observedTerminal).toBe(row.expected.terminal);

        if (row.expected.terminal === "COMPLETED") {
          // The honest verdict row: every mechanical criterion green —
          // improving, plateaued, never-materialized and
          // mixed-cohort-regressing alike (the honest classification IS
          // the verified outcome).
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

        // ---- the curve verdict is the mechanically derived one ----
        const verdict = result.criteria.find((c) => c.criterionId === "row-outcome-contract");
        expect(verdict?.status).toBe("PASS");
        expect(verdict?.evidence.join(" ")).toContain(`expectedVerdict:${row.expected.verdict}`);

        // ---- every verified point's digest is journaled in its pinned class ----
        if (row.adversarial === undefined) {
          expect(result.points).toHaveLength(row.pointSet.length);
        }
        const inputDigests: string[] = [];
        for (const point of result.points) {
          expect(point.reference.recordedDigest).toMatch(/^[0-9a-f]{8}$/);
          inputDigests.push(point.reference.recordedDigest);
          if (row.adversarial === undefined) {
            // The honest rows: every RECORDED ledger point verified over
            // REAL SQL against the served recorded basis (digest + field
            // equality).
            expect(point.integrity, `${row.rowId} ${point.reference.generation}`).toBe(true);
            expect(point.failureReason, `${row.rowId} ${point.reference.generation}`).toBeNull();
          }
        }

        // ---- the curve reproduces the pinned synthesis ----
        const expected = row.expected.synthesis;
        const synthesis = result.synthesis;
        if (expected !== undefined) {
          expect(synthesis, `${row.rowId} synthesis`).not.toBeNull();
        }
        if (expected !== undefined && synthesis !== null) {
          expect(synthesis.family).toBe(expected.family);
          expect(synthesis.workloadClass).toBe(expected.workloadClass);
          expect(synthesis.windowFromGeneration).toBe(expected.windowFromGeneration);
          expect(synthesis.windowToGeneration).toBe(expected.windowToGeneration);
          expect(synthesis.points).toBe(expected.points);
          expect(synthesis.perPointCostPerOutcomeMicroUsd.join(",")).toBe(
            expected.perPointCostPerOutcomeMicroUsd.join(","),
          );
          expect(synthesis.totalCostFromMicroUsd).toBe(expected.totalCostFromMicroUsd);
          expect(synthesis.totalCostToMicroUsd).toBe(expected.totalCostToMicroUsd);
          expect(synthesis.totalImprovementMicroUsd).toBe(expected.totalImprovementMicroUsd);
          expect(synthesis.improvementRatePerGeneration).toBeCloseTo(
            expected.improvementRatePerGeneration,
            12,
          );
          expect(synthesis.lastWindowImprovementRate).toBeCloseTo(
            expected.lastWindowImprovementRate,
            12,
          );
          expect(synthesis.regimeChangePoints).toBe(expected.regimeChangePoints);
          expect(
            synthesis.cohorts.map((entry) => `${entry.mechanism}=${entry.verdict}`).join(","),
          ).toBe(expected.cohorts.map((entry) => `${entry.mechanism}=${entry.verdict}`).join(","));
          expect(synthesis.wilson.low).toBeCloseTo(expected.wilson.low, 12);
          expect(synthesis.wilson.high).toBeCloseTo(expected.wilson.high, 12);
          expect(synthesis.verdict).toBe(expected.verdict);
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
          points: result.points.length,
          verifiedPoints: result.points.filter((point) => point.integrity).length,
          trajectory:
            synthesis === null ? "none" : synthesis.perPointCostPerOutcomeMicroUsd.join(" -> "),
          totalImprovementMicroUsd: synthesis?.totalImprovementMicroUsd ?? "0",
          wilson:
            synthesis === null
              ? "none"
              : `[${synthesis.wilson.low.toFixed(3)}, ${synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          // Offline rows derive over the RECORDED longitudinal ledgers +
          // the RECORDED VAL-045 attribution results — nothing freshly
          // measured offline (the live rail below owns the measured lane).
          usage: "recorded-longitudinal-history",
          latencyMs: result.totalLatencyMs,
          inputDigests,
        });
        console.info(
          `[VAL-047]   ${row.rowId} -> ${result.terminal} (${row.family}/${row.workloadClass}) ` +
            `points=${result.points.length} verified=${runFacts[runFacts.length - 1]?.verifiedPoints} ` +
            `trajectory=${runFacts[runFacts.length - 1]?.trajectory} ` +
            `improvement=${runFacts[runFacts.length - 1]?.totalImprovementMicroUsd}µ$ ` +
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

      // ---- the recorded basis is still frozen (FRESH SQL reads) ----
      for (const ledger of LONGITUDINAL_LEDGERS) {
        const served = await sqlCurveBasisOf(ctx, world, ledger.workloadClass);
        expect(served.ledger, `${ledger.workloadClass} frozen ledger`).toHaveLength(
          ledger.points.length,
        );
        for (const point of served.ledger) {
          const imported = ledger.points.find(
            (candidate) => candidate.generation === point.generation,
          );
          expect(
            recordedCurvePointDigestOf(point),
            `${ledger.workloadClass}@g${point.generation} frozen digest`,
          ).toBe(imported === undefined ? "" : recordedCurvePointDigestOf(imported));
        }
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
      console.info(
        `[VAL-047] OFFLINE corpus summary: ${completed} COMPLETED + ${failed} honest FAILED of ${runFacts.length} driven rows; ` +
          `${seeding.ledgerRows} recorded ledger points + ${seeding.attributionRows} recorded ` +
          `attribution results served READ-ONLY from REAL SQL (the canonical payload-free digests ` +
          `as fingerprints; identical re-commit REPLAYS, different content THROWS); the ledger holds ` +
          `exactly ${finalFacts.executionCount} executions and ${finalFacts.idempotencyRecordCount} ` +
          `idempotency records (zero phantoms, zero drift, zero orphan events); every ` +
          `execution_events sequence gapless; every verified point sealed through the REAL recorder ` +
          `with the measured model cost + substrate overhead at their own pinned revisions (the ` +
          `VAL-040 model manifests + the VAL-046 substrate manifests) while the planner quotes ride ` +
          `as separate estimate facts; every curve reproduces the pinned synthesis (the ` +
          `cost-per-outcome trajectory, the total improvement, the improvement-rate statistics, the ` +
          `derived cohorts, the Wilson 95% interval, the honest verdict); the window/regime/` +
          `extrapolation/residual/cohort/estimate/minimum/integrity oracles green on every honest ` +
          `verdict row and honestly FAILED on every probe row (the cherry-picked windows, the ` +
          `normalized regimes, the extrapolated points, the hidden residuals, the hidden cohorts, ` +
          `the post-hoc exclusions, the below-minimum verdict claims and the re-measurements ` +
          `named); usage/latency honestly the recorded history's own offline (none freshly ` +
          `measured — the live rail owns that).`,
      );
      expect(runFacts.length).toBe(OFFLINE_CORPUS_ROWS.length);
      expect(completed).toBe(4);
      expect(failed).toBe(8);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives one REAL longitudinal slice over the pinned OpenRouter rail", {
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
        "[VAL-047] OPENROUTER_API_KEY absent — the REAL live longitudinal-curve row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every curve family over the RECORDED longitudinal history without credentials. " +
          "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
          "covering the pinned chat model meta-llama/llama-3.3-70b-instruct on the pinned rail — " +
          "the REAL longitudinal slice demands three REAL curve points of three REAL workload " +
          "dispatches each (BYOK, measured usage, every priced input at its pinned manifest " +
          "revision rev-001, temperature unset per the provider's documented default, max_tokens " +
          "32 pinned explicitly), the substrate share priced at the pinned sub-rev-001 manifest, " +
          "the curve points computed over MEASURED facts and the verdict recorded through the REAL " +
          "recorder with honest economics. This live lane is reserved for the operator/session-B " +
          "live review (the recorded-input curve above never re-measures; the live row is the only " +
          "place new measurements happen).",
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

    /**
     * Price ONE measured dispatch onto the canonical micro-USD basis at
     * the pinned model manifest revision (exact BigInt rational —
     * PUBLIC LIST PRICES ONLY, never an ad-hoc rate).
     */
    const priceTokensAt = (tokens: number, tier: "input" | "output"): bigint => {
      const manifest = manifestRevisionOf(LIVE_CURVE_PLAN.modelPriceRevision);
      const entry =
        manifest === null
          ? null
          : resolveListPrice(manifest, "openrouter", LIVE_CURVE_PLAN.rail.model, tier);
      if (entry === null) {
        throw new Error(
          `the pinned model manifest holds no ${tier} price for ${LIVE_CURVE_PLAN.rail.model}`,
        );
      }
      const price = parseDecimal(entry.price);
      if (price === null) {
        throw new Error("the pinned list price failed to parse as a decimal");
      }
      // The list price is USD per 1M tokens → micro-USD per token is the
      // price's own decimal value (tokens × price, half-up).
      return divRoundHalfUp(BigInt(tokens) * price.digits, 10n ** BigInt(price.scale));
    };

    try {
      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          continue;
        }
        // Provider-side pacing between the live rows.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const taskIndex = CURVE_CORPUS.findIndex((candidate) => candidate.rowId === row.rowId);
        const runSuffix = `live-${createUuidv7Generator()().slice(-8)}`;
        const lifecycle = createLifecycleBinding(world, world.executions);
        const baseline = await facts();

        // ---- the REAL longitudinal slice: 3 points × 3 REAL dispatches ----
        const substrateManifest = substrateManifestFor(LIVE_CURVE_PLAN.substratePriceRevision);
        const substrateEntry = resolveSubstratePrice(substrateManifest, "warm-fleet-a", "usage");
        const substrateFx = fxRateForSubstrate(substrateManifest, "USD");
        if (substrateEntry === null || substrateFx === null) {
          throw new Error("the pinned substrate manifest holds no warm-fleet-a usage price");
        }
        const measuredPoints: RecordedCurvePoint[] = [];
        for (let point = 1; point <= LIVE_CURVE_PLAN.points; point += 1) {
          let modelMicroUsd = 0n;
          let substrateMicroUsd = 0n;
          let successfulOutcomes = 0;
          for (let unit = 0; unit < LIVE_CURVE_PLAN.workloadUnitsPerPoint; unit += 1) {
            const startedAt = Date.now();
            const response = await fetch(LIVE_CURVE_PLAN.rail.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: LIVE_CURVE_PLAN.rail.model,
                max_tokens: LIVE_CURVE_PLAN.rail.maxTokens,
                messages: [
                  { role: "user", content: `Reply with the single word: ok (unit ${unit + 1})` },
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
            if (!response.ok) {
              continue;
            }
            const content = payload.choices?.[0]?.message?.content ?? "";
            if (content.length > 0) {
              successfulOutcomes += 1;
            }
            const inputTokens = payload.usage?.prompt_tokens ?? 0;
            const outputTokens = payload.usage?.completion_tokens ?? 0;
            modelMicroUsd +=
              priceTokensAt(inputTokens, "input") + priceTokensAt(outputTokens, "output");
            substrateMicroUsd += priceMeasuredMs({
              milliseconds: Math.max(wallclockMs, 0),
              entry: substrateEntry,
              fx: substrateFx,
            });
          }
          measuredPoints.push({
            workloadClass: LIVE_CURVE_PLAN.workloadClass,
            generation: point,
            runs: LIVE_CURVE_PLAN.workloadUnitsPerPoint,
            successfulOutcomes,
            measuredModelCostMicroUsd: Number(modelMicroUsd),
            substrateOverheadMicroUsd: Number(substrateMicroUsd),
            modelPriceRevision: LIVE_CURVE_PLAN.modelPriceRevision,
            substratePriceRevision: LIVE_CURVE_PLAN.substratePriceRevision,
            costBasis: "measured",
          });
        }
        // The measured lane's LIVE point inputs (the only place new
        // measurements happen) + the measured slice's own ledger. The
        // attribution bundles are the honest EMPTY results (nothing
        // attributed on the measured lane — the decomposition reconciles
        // over whatever the measured slice actually did).
        const livePoints: CurvePointInput[] = measuredPoints.map((point) => ({
          workloadClass: point.workloadClass,
          generation: point.generation,
          recordedDigest: liveCurvePlanDigestOf(),
          modelPriceRevision: point.modelPriceRevision,
          substratePriceRevision: point.substratePriceRevision,
          live: true,
          facts: point,
        }));
        const liveAttribution = measuredPoints
          .slice(1)
          .map((point) => liveEmptyAttributionOf(point.workloadClass, point.generation));

        const metadata = {
          program: "zeck-validation",
          workOrder: "VAL-047",
          baseRevision: REVISION,
          applicationRevision: REVISION,
          corpusRevision: CURVE_CORPUS_VERSION,
          integrationSurface: "curve:live-measured-slice",
          environment: {
            runtime: `node ${process.version}`,
            toolchain: "vitest",
            database: "postgresql",
            configuration: { suite: "val-047-longitudinal-curve", row: row.rowId },
          },
          observedAt: new Date().toISOString(),
        };

        const appPromise = runCurveApp({
          config: {
            applicationId: world.applicationId,
            baseUrl: address,
            tokenEnvVar: "ZECK_VALIDATION_TOKEN",
            applicationRevision: REVISION,
            corpusRevision: CURVE_CORPUS_VERSION,
            integrationSurface: "curve:live-measured-slice",
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
            configuration: { suite: "val-047-longitudinal-curve" },
          },
          runSuffix,
          taskIndex,
        });

        const result = await driveCurveRow({
          row,
          lifecycle,
          points: livePoints,
          attribution: liveAttribution,
          recordedLedger: measuredPoints,
          recordedAttribution: liveAttribution,
          rails: createRealAccountingRails(),
          metadata,
          environmentIdentity: `val-047-live-${row.rowId}`,
          baseline,
          worldFacts: facts,
          landedProvider: createLandedProvider(ctx, world, driven, CURVE_TASK_KIND),
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
        const measuredTotal = measuredPoints.reduce(
          (sum, point) =>
            sum + BigInt(point.measuredModelCostMicroUsd) + BigInt(point.substrateOverheadMicroUsd),
          0n,
        );
        expect(measuredTotal).toBeGreaterThan(0n);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: result.synthesis?.verdict ?? "none",
          family: row.family,
          workloadClass: row.workloadClass,
          points: result.points.length,
          verifiedPoints: result.points.filter((point) => point.integrity).length,
          trajectory:
            result.synthesis === null
              ? "none"
              : result.synthesis.perPointCostPerOutcomeMicroUsd.join(" -> "),
          totalImprovementMicroUsd: result.synthesis?.totalImprovementMicroUsd ?? "0",
          wilson:
            result.synthesis === null
              ? "none"
              : `[${result.synthesis.wilson.low.toFixed(3)}, ${result.synthesis.wilson.high.toFixed(3)}]`,
          appPassed: appOutcome.passed,
          usage: "rail-measured",
          latencyMs: result.totalLatencyMs,
          inputDigests: result.points.map((point) => point.reference.recordedDigest),
        });
        console.info(
          `[VAL-047]   LIVE ${row.rowId} -> ${result.terminal} (${row.family}) ` +
            `trajectory=${runFacts[runFacts.length - 1]?.trajectory} ` +
            `measured=${measuredTotal.toString()}µ$ latency=${result.totalLatencyMs}ms`,
        );
      }

      const driven0 = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-047] LIVE rail summary: ${driven0} COMPLETED of ${runFacts.length} driven live rows ` +
          `over the REAL OpenRouter rail (every dispatch priced at the pinned manifest revision, ` +
          `the substrate share priced at the pinned sub-rev-001 manifest, the curve points computed ` +
          `over MEASURED facts, the verdict recorded through the REAL recorder with honest ` +
          `economics — the mechanically derived verdict stands on whatever the measured slice ` +
          `derives, never fabricated).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-047] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live request happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});

/** One LIVE empty attribution result (the measured lane's honest shape). */
function liveEmptyAttributionOf(workloadClass: string, generation: number): CurveAttributionResult {
  const preliminary = {
    workloadClass,
    generation,
    attributedMicroUsd: {
      reuse: 0,
      cache: 0,
      competence: 0,
      deterministicization: 0,
    },
    residualMicroUsd: 0,
    ledgerEntryDigests: [] as readonly string[],
    recordedTotalDigests: [] as readonly string[],
  };
  return { ...preliminary, attributionDigest: curveAttributionDigestOf(preliminary) };
}
