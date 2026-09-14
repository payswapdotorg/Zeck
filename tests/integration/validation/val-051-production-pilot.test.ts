/**
 * VAL-051 — the integration crown: the PRODUCTION-STYLE PILOT's durable
 * surface over REAL PostgreSQL (env-gated on ZECK_PG_TEST_URL; the live
 * rail additionally env-gated on OPENROUTER_API_KEY).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - REAL PostgreSQL 16 (a per-run disposable database created off the
 *     admin database named by ZECK_PG_TEST_URL, the shipped migrations
 *     applied, dropped on teardown — the house harness's disposable-DB
 *     lifecycle, inlined at the env gate this work order demands);
 *   - the RECORDED BASIS (every corpus digest reference: the journey
 *     stage economics with their VAL-049 audit anchors) committed
 *     READ-ONLY into REAL SQL through the platform's own
 *     idempotency-record arbitration: an identical re-commit REPLAYS, a
 *     different-content commit under a recorded key is REFUSED (the
 *     frozen-input discipline — the recorded basis is never re-priced),
 *     then served back over FRESH SQL reads and verified
 *     digest-for-digest against the engine's own resolution at
 *     verification time;
 *   - the REAL Fastify public API over the REAL SQL authorities
 *     (seedApiPgWorld) listening on a real port: every row's window
 *     lands through the public create boundary under the app's OWN
 *     submission key discipline (`submissionKey` — one submission per
 *     row), the identical re-submission REPLAYS over REAL HTTP and a
 *     different-content commit under the recorded key THROWS (the
 *     platform's IDEMPOTENCY_KEY_REUSED refusal);
 *   - the REAL executions state machine drives every landed window
 *     through the canonical transitions (authorize → plan → durable
 *     planning decision → queue → start → per-shift per-stage step
 *     events carrying the RECORDED basis DIGEST references → verify →
 *     pass/fail), the events gapless by construction and asserted so;
 *   - the REAL validation recorder seals every row: the eight settled
 *     criteria land as durable verification_results rows over REAL SQL
 *     (criterion, strategy, status, evidence, recorded_by) and the
 *     public read boundary serves the durable terminal back over REAL
 *     HTTP;
 *   - the whole offline corpus (the 6 honest rows + the 7 adversarial
 *     probes) driven crown-style: the observation re-derived AT THE
 *     BOUNDARY over the DURABLE LEDGER (the step events of the row's
 *     executions, the SQL-served recorded basis, the committed window
 *     record — never trusting the platform's own claim) and the eight
 *     PURE oracles settling the pinned verdicts — every honest row
 *     PILOT-COMPLETED with 8/8 criteria (the honest drifting-named and
 *     regressing-reported findings completing with their mechanism
 *     NAMED in the criteria's own evidence), every probe row
 *     PILOT-FAILED with exactly its pinned NAMED criteria.
 *
 * The durable discriminations: the seven adversarial durable shapes
 * (a cherry-picked window — the anomalous shifts' events never land; a
 * dropped shift — the mid-window shift's events never land; a
 * double-driven resume — three durable attempts for the failed stage;
 * a drift normalization — the committed record's claim rewritten back
 * within bounds over the drifted economics; an incident hiding — the
 * committed log omits the failure shift's incident while the timeline
 * holds the event and the reported total hides the cost; a residual
 * hiding — the committed window total hides part of a stage's cost; a
 * boundary leak — the leak shift's events land durably under ANOTHER
 * customer's application) are each DETECTED over the durable ledger by
 * the NAMED oracle, and the durable denaturation reproduces the
 * offline controlled fake EXACTLY (full-record parity against the
 * engine's own derivation-level record).
 *
 * The live rail is env-gated on OPENROUTER_API_KEY: without the
 * credential the live row is honestly NOT RUN (the env var NAMED,
 * never a fake success — the gate-closed invariants asserted: the live
 * row holds NO offline record, the pinned live plan's digest stays
 * deterministic, the closed-gate driver yields NOT-RUN with the env
 * var named). With the credential the live row drives 3 shifts × 2
 * REAL dispatches SUSTAINED across the declared live window on the ONE
 * pinned OpenRouter rail, every dispatch recorded through the REAL
 * recorder (createRealAccountingRails) with honest MEASURED economics,
 * live incidents classified through the REAL taxonomy, and the verdict
 * DERIVED from the measured facts — the harness asserts honest
 * recording, never a verdict family.
 *
 * Honest skip: without ZECK_PG_TEST_URL the suite SKIPS (never fails,
 * never fake-passes) with the env var NAMED.
 */

import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { JourneyStageKind } from "../../../benchmarks/validation/apps/customer-journey/corpus";
import { FOREIGN_APPLICATION_ID } from "../../../benchmarks/validation/apps/customer-journey/driver";
import {
  createRealAccountingRails,
  economicDigestOf,
} from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { divRoundHalfUp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import type { PilotCorpusRow } from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_CARRIED_AUDIT_ROW_IDS,
  PILOT_CORPUS_ROWS,
  PILOT_ROW_IDS,
  PILOT_TASK_KIND,
  PROBE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  pilotRowById,
  pilotWindowRecordFor,
  pinnedPilotInputDigest,
  submissionKey,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import type {
  ClaimedDriftClassification,
  IncidentDispositionKind,
  ObservedShiftRecord,
  ObservedShiftSegment,
  PilotRowResult,
  PilotWindowObservation,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  carriedAuditBasisDigests,
  createWindowLedger,
  deriveWindowDrift,
  drivePilotRow,
  isKnownAttributionClass,
  LIVE_PILOT_PLAN,
  livePilotPlanDigestOf,
  PILOT_CUSTOMER_APPLICATION_ID,
  PILOT_OBSERVATION_FAMILIES,
  pilotWindowDigestOf,
  scheduleDigestOf,
  windowRecordDigestOf,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  PILOT_RECORDED_JOURNEY_REPLAYS,
  recordedJourneyReplayFor,
} from "../../../benchmarks/validation/apps/production-pilot/fixtures";
import {
  type AttributionClass,
  classifyProviderEnvelope,
  classifyTransportError,
  isRetryableAttributionClass,
} from "../../../benchmarks/validation/platform/failure-attribution";
import { createZeckClient } from "../../../sdk";
import { applyShippedMigrations } from "../../../src/platform/db/migrations/runner";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { dropDatabase } from "../postgres/harness";

// ---------------------------------------------------------------------------
// The env gates (the honest skip names the env var)
// ---------------------------------------------------------------------------

const url = process.env.ZECK_PG_TEST_URL ?? "";
if (!url) {
  console.info(
    "[val-051-production-pilot] SKIPPED: ZECK_PG_TEST_URL is not set — the integration crown demands REAL PostgreSQL " +
      "(e.g. ZECK_PG_TEST_URL='postgres://val@127.0.0.1:5433/postgres'); the pilot's durable surface " +
      "(the recorded basis over REAL SQL, the window executions, the idempotency ledger, the exactly-once " +
      "continuation, the end-of-window reconciliation) is only provable over REAL SQL. Re-run with the " +
      "variable set to drive the crown.",
  );
}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

/** The REAL SQL operation the crown's recorded stage-economics bindings ride. */
const STAGE_BASIS_OPERATION = "val-051.recorded-stage-economics";
/** The REAL SQL operation the crown's VAL-049 audit-anchor bindings ride. */
const AUDIT_ANCHOR_OPERATION = "val-051.recorded-audit-anchor";
/** The REAL SQL operation the crown's committed window records ride. */
const WINDOW_RECORD_OPERATION = "val-051.window-record";
/** The REAL recorder's durable identity (the verification_results rows' recorded_by). */
const RECORDED_BY = "val-051-crown";

// ---------------------------------------------------------------------------
// The pg adapter (the house harness's provider-neutral DatabasePort)
// ---------------------------------------------------------------------------

class PgTransaction implements Transaction {
  constructor(private readonly client: PoolClient) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    const result = await this.client.query(query.sql, query.parameters as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }
}

class PgPort implements DatabasePort {
  constructor(private readonly pool: Pool) {}

  async execute<T = Record<string, unknown>>(query: Query): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(query.sql, query.parameters as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PgTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// The durable-record machinery over the REAL platform path
// ---------------------------------------------------------------------------

const generateId = createUuidv7Generator();

/** The idempotency key of one row's committed window record. */
const windowRecordKeyOf = (rowId: string): string => `val-051-crown-${rowId}:window-record`;
/** The idempotency key of one (journey row, stage) recorded-basis record. */
const stageBasisKeyOf = (journeyRowId: string, stage: string): string => `${journeyRowId}:${stage}`;

/**
 * Commit one durable record READ-ONLY through the platform's own
 * idempotency-record arbitration: an identical re-commit REPLAYS, a
 * different-content commit under a recorded key is REFUSED (the
 * frozen-input discipline — the recorded basis and the committed
 * window records are never re-priced, never rewritten).
 */
async function arbitrateRecord(
  db: DatabasePort,
  world: ApiPgWorld,
  operation: string,
  key: string,
  fingerprint: string,
  outcome: Record<string, unknown>,
): Promise<{ readonly accepted: boolean; readonly replayed: boolean; readonly refused: boolean }> {
  return db.transaction(async (tx: Transaction) => {
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
        JSON.stringify(outcome),
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
    const recorded = existing.rows[0]?.request_fingerprint;
    if (recorded === fingerprint) {
      return { accepted: false, replayed: true, refused: false };
    }
    // The recorded basis is a frozen input: a different-content commit
    // under a recorded key is REFUSED.
    return { accepted: false, replayed: false, refused: true };
  });
}

/** One journey stage's recorded basis as served back over FRESH SQL reads. */
interface ServedStageBasis {
  readonly costMicroUsd: string;
  readonly latencyMs: number;
  readonly basisDigest: string;
  readonly basisAuditRowId: string;
  readonly recordedAttempts: number;
  readonly recordedResolved: number;
}

/** The recorded stage economics of one (journey row, stage) over a FRESH SQL read. */
async function servedBasisOf(
  db: DatabasePort,
  world: ApiPgWorld,
  journeyRowId: string,
  stage: string,
): Promise<ServedStageBasis | null> {
  const result = await db.execute<{ durable_outcome: ServedStageBasis }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
    parameters: [world.applicationId, STAGE_BASIS_OPERATION, stageBasisKeyOf(journeyRowId, stage)],
  });
  return result.rows[0]?.durable_outcome ?? null;
}

/** One VAL-049 audit anchor as served back over a FRESH SQL read. */
async function servedAnchorOf(
  db: DatabasePort,
  world: ApiPgWorld,
  auditRowId: string,
): Promise<{ readonly anchorDigest: string } | null> {
  const result = await db.execute<{ durable_outcome: { anchorDigest: string } }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
    parameters: [world.applicationId, AUDIT_ANCHOR_OPERATION, auditRowId],
  });
  return result.rows[0]?.durable_outcome ?? null;
}

/** The committed window record of one row over a FRESH SQL read (the observation lane's report). */
async function servedWindowRecordOf(
  db: DatabasePort,
  world: ApiPgWorld,
  rowId: string,
): Promise<PilotWindowObservation | null> {
  const result = await db.execute<{ durable_outcome: PilotWindowObservation }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
    parameters: [world.applicationId, WINDOW_RECORD_OPERATION, windowRecordKeyOf(rowId)],
  });
  return result.rows[0]?.durable_outcome ?? null;
}

/**
 * Seed the whole RECORDED BASIS READ-ONLY over REAL SQL: every journey
 * stage's recorded economics (the carried VAL-049 cost basis with its
 * audit anchor id and its recorded attempt shape) plus every carried
 * VAL-049 audit anchor digest, each committed through the platform's
 * own arbitration and each immediately re-committed IDENTICALLY (the
 * replay proof). A second invocation of this function re-commits
 * everything identically — the freeze-integrity proof (all REPLAY,
 * zero new commits, zero refusals).
 */
async function seedPilotRecordedBasis(
  db: DatabasePort,
  world: ApiPgWorld,
): Promise<{
  readonly stageCommitted: number;
  readonly stageReplayed: number;
  readonly anchorCommitted: number;
  readonly anchorReplayed: number;
  readonly refused: number;
}> {
  let stageCommitted = 0;
  let stageReplayed = 0;
  let anchorCommitted = 0;
  let anchorReplayed = 0;
  let refused = 0;
  for (const [journeyRowId, replay] of PILOT_RECORDED_JOURNEY_REPLAYS) {
    for (const fact of replay.stages) {
      const outcome = {
        costMicroUsd: fact.economics.costMicroUsd,
        latencyMs: fact.economics.latencyMs,
        basisDigest: fact.economics.basisDigest,
        basisAuditRowId: fact.economics.basisAuditRowId,
        recordedAttempts: fact.recordedAttempts,
        recordedResolved: fact.recordedResolved,
      };
      const fingerprint = economicDigestOf({
        journeyRowId,
        stage: fact.stage,
        economics: outcome,
      });
      const first = await arbitrateRecord(
        db,
        world,
        STAGE_BASIS_OPERATION,
        stageBasisKeyOf(journeyRowId, fact.stage),
        fingerprint,
        outcome,
      );
      if (first.accepted) {
        stageCommitted += 1;
      }
      const identical = await arbitrateRecord(
        db,
        world,
        STAGE_BASIS_OPERATION,
        stageBasisKeyOf(journeyRowId, fact.stage),
        fingerprint,
        outcome,
      );
      if (identical.replayed) {
        stageReplayed += 1;
      }
      if (identical.refused) {
        refused += 1;
      }
    }
  }
  const anchors = carriedAuditBasisDigests();
  for (const auditRowId of PILOT_CARRIED_AUDIT_ROW_IDS) {
    const anchorDigest = anchors.get(auditRowId);
    if (anchorDigest === undefined) {
      throw new Error(`the engine's own resolution holds no anchor digest for ${auditRowId}`);
    }
    const outcome = { anchorDigest };
    const fingerprint = economicDigestOf({ auditRowId, anchorDigest });
    const first = await arbitrateRecord(
      db,
      world,
      AUDIT_ANCHOR_OPERATION,
      auditRowId,
      fingerprint,
      outcome,
    );
    if (first.accepted) {
      anchorCommitted += 1;
    }
    const identical = await arbitrateRecord(
      db,
      world,
      AUDIT_ANCHOR_OPERATION,
      auditRowId,
      fingerprint,
      outcome,
    );
    if (identical.replayed) {
      anchorReplayed += 1;
    }
    if (identical.refused) {
      refused += 1;
    }
  }
  return { stageCommitted, stageReplayed, anchorCommitted, anchorReplayed, refused };
}

/**
 * Commit one row's window record (the observation lane's report) through
 * the platform's own arbitration — READ-ONLY: the identical re-commit on
 * a re-drive REPLAYS, a different-content commit under the recorded key
 * is REFUSED.
 */
async function commitWindowRecord(
  db: DatabasePort,
  world: ApiPgWorld,
  row: PilotCorpusRow,
): Promise<{ readonly accepted: boolean; readonly replayed: boolean; readonly refused: boolean }> {
  const report = pilotWindowRecordFor(row);
  if (report === null) {
    throw new Error(`row ${row.rowId} holds no derivation-level window record to commit`);
  }
  return arbitrateRecord(
    db,
    world,
    WINDOW_RECORD_OPERATION,
    windowRecordKeyOf(row.rowId),
    economicDigestOf({ rowId: row.rowId, windowRecord: report }),
    report as unknown as Record<string, unknown>,
  );
}

// ---------------------------------------------------------------------------
// The durable window landing over the REAL platform path
// ---------------------------------------------------------------------------

/** One segment step event as it lands on the durable ledger. */
interface SegmentEventRow {
  readonly payload: {
    readonly family?: string;
    readonly shift?: number;
    readonly stage?: string;
    readonly attempt?: number;
    readonly resolved?: boolean;
  };
  readonly application_id: string;
}

/** The row's segment step events over the given executions (REAL SQL reads). */
async function segmentEventsOf(
  db: DatabasePort,
  executionIds: readonly string[],
): Promise<readonly SegmentEventRow[]> {
  if (executionIds.length === 0) {
    return [];
  }
  const result = await db.execute<SegmentEventRow>({
    sql: `SELECT e.payload, x.application_id::text AS application_id
          FROM executions.execution_events e
          JOIN executions.executions x ON e.execution_id = x.id
          WHERE e.execution_id = ANY($1::uuid[])
            AND e.payload->>'shift' IS NOT NULL AND e.payload->>'stage' IS NOT NULL
          ORDER BY e.execution_id, e.sequence`,
    parameters: [executionIds],
  });
  return result.rows.filter(
    (row) =>
      typeof row.payload.shift === "number" &&
      typeof row.payload.stage === "string" &&
      typeof row.payload.attempt === "number" &&
      typeof row.payload.resolved === "boolean",
  );
}

/**
 * Re-derive the pilot window observation AT THE BOUNDARY over the DURABLE
 * LEDGER (never trusting the platform's own claim): the structural
 * facts (which shifts landed, how many attempts each stage landed, which
 * application executed them) from the durable step events; the economics
 * from the SQL-SERVED recorded basis (the declared divergence factors
 * applied where declared, the extra attempts' cost carried honestly);
 * the report parts (the claimed drift classifications, the incident log,
 * the continuation records, the append-only ledger, the reported totals)
 * from the COMMITTED window record served over a FRESH SQL read.
 */
async function observationOverDurableLedger(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly row: PilotCorpusRow;
  readonly executionIds: readonly string[];
}): Promise<PilotWindowObservation> {
  const { db, world, row } = options;
  const report = await servedWindowRecordOf(db, world, row.rowId);
  if (report === null) {
    throw new Error(`no committed window record served for ${row.rowId}`);
  }
  const events = await segmentEventsOf(db, options.executionIds);
  const driftFactorsOf = (shift: number) =>
    row.driftFactors.find((entry) => entry.shift === shift)?.factors ?? [];

  const shifts: ObservedShiftRecord[] = [];
  for (const scheduled of row.schedule.shifts) {
    const shiftEvents = events.filter((event) => event.payload.shift === scheduled.shift);
    if (shiftEvents.length === 0) {
      continue; // the dropped shifts (their events never landed durably)
    }
    const segments: ObservedShiftSegment[] = [];
    for (const segment of scheduled.segments) {
      const basis = await servedBasisOf(db, world, scheduled.journeyRowId, segment.stage);
      if (basis === null) {
        throw new Error(`no recorded basis served for ${scheduled.journeyRowId}:${segment.stage}`);
      }
      const stageEvents = shiftEvents.filter((event) => event.payload.stage === segment.stage);
      const attempts = stageEvents.length;
      if (attempts === 0) {
        continue; // the omitted segment (the window-honesty oracle's catch)
      }
      const resolved = stageEvents.filter((event) => event.payload.resolved === true).length;
      const foreign = stageEvents.some((event) => event.application_id !== world.applicationId);
      // The extra attempts' economics carried honestly (the double-driven
      // resume's third attempt — the recorded per-attempt basis, never a
      // re-price): exactly the corpus's own corruption arithmetic.
      const extra = Math.max(0, attempts - basis.recordedAttempts);
      const perAttemptCost = BigInt(basis.costMicroUsd) / BigInt(basis.recordedAttempts);
      const perAttemptLatency = Math.trunc(basis.latencyMs / basis.recordedAttempts);
      let cost = BigInt(basis.costMicroUsd) + BigInt(extra) * perAttemptCost;
      let latency = basis.latencyMs + extra * perAttemptLatency;
      const factor =
        driftFactorsOf(scheduled.shift).find((entry) => entry.stage === segment.stage) ?? null;
      if (factor !== null) {
        cost = cost + (cost * BigInt(factor.costDriftPct)) / 100n;
        latency = Math.max(0, latency + Math.trunc((latency * factor.latencyDriftPct) / 100));
      }
      segments.push({
        shift: scheduled.shift,
        stage: segment.stage,
        attempts,
        resolved,
        costMicroUsd: cost.toString(),
        latencyMs: latency,
        basisDigest: basis.basisDigest,
        applicationId: foreign ? FOREIGN_APPLICATION_ID : PILOT_CUSTOMER_APPLICATION_ID,
      });
    }
    // The shift's reported totals: the committed report's own (the
    // observation lane's record — the oracles re-derive against it,
    // never trusting it).
    const reportedShift = report.shifts.find((entry) => entry.shift === scheduled.shift);
    if (reportedShift === undefined) {
      throw new Error(
        `the committed window record holds no reported total for shift ${scheduled.shift}`,
      );
    }
    shifts.push({
      shift: scheduled.shift,
      journeyRowId: scheduled.journeyRowId,
      segments,
      reportedCostMicroUsd: reportedShift.reportedCostMicroUsd,
      reportedLatencyMs: reportedShift.reportedLatencyMs,
    });
  }
  return {
    rowId: row.rowId,
    basis: report.basis,
    shifts,
    incidents: report.incidents,
    claimedDrift: report.claimedDrift,
    continuations: report.continuations,
    ledger: report.ledger,
    reported: report.reported,
    windowDigest: windowRecordDigestOf({ rowId: row.rowId, basis: report.basis, shifts }),
    usage: report.usage,
  };
}

/** Drive one landed execution through the REAL state machine to `start`. */
async function driveWindowExecutionToStart(options: {
  readonly world: ApiPgWorld;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly armDecision: Record<string, unknown>;
}): Promise<void> {
  const { world, executionId } = options;
  const scope = {
    actorId: world.actorId,
    applicationId: options.applicationId,
    tenantId: options.tenantId,
    executionId,
  };
  const key = (tag: string) => `val-051-${executionId}:${tag}`;
  await world.executions.transition({ ...scope, command: "authorize" }, key("authorize"));
  await world.executions.transition(
    { ...scope, command: "plan", reason: "val-051-pilot-window-plan" },
    key("plan"),
  );
  await world.executions.recordPlanningDecision(
    {
      applicationId: options.applicationId,
      executionId,
      tenantId: options.tenantId,
      actorId: world.actorId,
      decisionId: generateId(),
      planId: generateId(),
      payload: {
        candidates: [
          {
            strategyId: "val-051-pilot-window",
            plan: {
              strategyClass: "production-pilot",
              modelCalls: 0,
              steps: [{ routeRef: { provider: "pilot-ledger", model: "recorded-pilot-replay" } }],
            },
          },
        ],
        selectedStrategyId: "val-051-pilot-window",
        armDecision: options.armDecision,
      },
    },
    key("decision"),
  );
  await world.executions.transition(
    { ...scope, command: "queue", reason: "val-051-pilot-window-queue" },
    key("queue"),
  );
  await world.executions.transition(
    { ...scope, command: "start", reason: "val-051-pilot-window-start" },
    key("start"),
  );
}

/** One landed row's durable surface as the crown drove it. */
interface LandedPilotRow {
  readonly result: PilotRowResult;
  readonly observation: PilotWindowObservation;
  readonly windowExecutionId: string;
  readonly executionIds: readonly string[];
  readonly observedStatus: string;
  readonly windowRecordCommitted: boolean;
  readonly windowRecordReplayed: boolean;
}

/**
 * Land one offline corpus row's pilot window over the REAL platform
 * path: the window record committed READ-ONLY through the arbitration;
 * the window submitted through the public HTTP create boundary under
 * the app's OWN submission key; the shifts' per-stage attempts recorded
 * as durable step events carrying the RECORDED basis digest references
 * (the controlled denaturation mirrors the offline probe shapes — the
 * durable discrimination battery); the observation re-derived over the
 * durable ledger; the eight PURE oracles settling the row; the criteria
 * sealed through the REAL validation recorder onto the terminal
 * transition; the durable terminal read back over REAL HTTP.
 */
async function landPilotRowOverRealPlatform(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: PilotCorpusRow;
  readonly runSuffix: string;
}): Promise<LandedPilotRow> {
  const { db, world, row } = options;
  const client = createZeckClient({
    baseUrl: options.address,
    token: world.bearerToken,
    applicationId: world.applicationId,
    fetchImpl: globalThis.fetch,
  });
  const taskIndex = PILOT_ROW_IDS.indexOf(row.rowId);
  if (taskIndex < 0) {
    throw new Error(`row ${row.rowId} is not in the pinned corpus slice`);
  }
  const probe = row.probe?.kind ?? null;
  // The durable denaturation targets (the controlled fakes):
  const droppedShifts =
    probe === "cherry-picked-window"
      ? row.driftFactors.map((entry) => entry.shift)
      : probe === "dropped-shift"
        ? [Math.floor(row.window.declaredShifts / 2)]
        : [];
  const leakShift = probe === "boundary-leak" ? row.window.declaredShifts - 2 : null;

  // (1) the window record committed READ-ONLY through the arbitration.
  const committed = await commitWindowRecord(db, world, row);
  if (committed.refused) {
    throw new Error(`the window record of ${row.rowId} was refused at commit`);
  }

  // (2) the window submission through the public HTTP create boundary
  // under the app's OWN submission key (one submission per row).
  const receipt = (
    await client.createExecution(
      { applicationId: world.applicationId, task: taskBodyFor({ row }) },
      submissionKey({ runSuffix: options.runSuffix, taskIndex }),
    )
  ).receipt;
  const windowExecutionId = receipt.executionId;

  // (3) the durable planning decision (BEFORE any input is consulted)
  // then the canonical transitions to `start`.
  await driveWindowExecutionToStart({
    world,
    executionId: windowExecutionId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    armDecision: {
      rowId: row.rowId,
      windowDigest: pilotWindowDigestOf(row.window),
      scheduleDigest: scheduleDigestOf({ shifts: row.schedule.shifts }),
    },
  });

  const foreignExecutionIds: string[] = [];
  for (const scheduled of row.schedule.shifts) {
    const shift = scheduled.shift;
    if (droppedShifts.includes(shift)) {
      continue; // the cherry-picked / dropped durable shape: never lands
    }
    // The boundary-leak durable shape: the leak shift's every stage
    // lands durably under ANOTHER customer's application identity.
    let executionId = windowExecutionId;
    let applicationId = world.applicationId;
    let tenantId = world.tenantId;
    if (leakShift === shift) {
      const leakReceipt = await world.executions.createExecution(
        {
          applicationId: world.otherApplicationId,
          task: {
            kind: PILOT_TASK_KIND,
            rowId: row.rowId,
            pilot: { shift, leak: true },
          },
        },
        `val-051-crown-${row.rowId}:leak-shift`,
        { actorId: world.actorId, tenantId: world.otherTenantId },
      );
      executionId = leakReceipt.executionId;
      applicationId = world.otherApplicationId;
      tenantId = world.otherTenantId;
      foreignExecutionIds.push(executionId);
      await driveWindowExecutionToStart({
        world,
        executionId,
        applicationId,
        tenantId,
        armDecision: {
          rowId: row.rowId,
          windowDigest: pilotWindowDigestOf(row.window),
          scheduleDigest: scheduleDigestOf({ shifts: row.schedule.shifts }),
          leakedShift: shift,
        },
      });
    }
    let ordinal = 0;
    for (const segment of scheduled.segments) {
      const basis = await servedBasisOf(db, world, scheduled.journeyRowId, segment.stage);
      if (basis === null) {
        throw new Error(`no recorded basis served for ${scheduled.journeyRowId}:${segment.stage}`);
      }
      const attempts =
        basis.recordedAttempts +
        (probe === "double-driven-resume" && scheduled.failureStage === segment.stage ? 1 : 0);
      const factor =
        row.driftFactors
          .find((entry) => entry.shift === shift)
          ?.factors.find((entry) => entry.stage === segment.stage) ?? null;
      const resolvedCount = Math.max(0, basis.recordedResolved - (factor?.resolvedDrift ?? 0));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const resolved = attempt > attempts - resolvedCount;
        ordinal += 1;
        await world.executions.recordStepEvent(
          {
            applicationId,
            executionId,
            actor: { actorId: world.actorId, tenantId },
            command: "agent-action-recorded",
            cause: `val-051-${row.rowId}-s${shift}-${segment.stage}-a${attempt}`,
            reference: {
              kind: "pilot-segment-basis",
              ordinal,
              digest: basis.basisDigest,
            },
            payload: {
              family: "pilot-segment",
              shift,
              stage: segment.stage,
              attempt,
              resolved,
            },
          },
          `val-051-${executionId}:s${shift}:${segment.stage}:a${attempt}`,
        );
      }
    }
    if (foreignExecutionIds.includes(executionId)) {
      // The leaked shift's own execution settles terminal (its events are
      // the leak's durable trail; the boundary oracle catches them).
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId,
          tenantId,
          executionId,
          command: "verify",
          reason: "val-051-pilot-leak-shift-verify",
        },
        `val-051-${executionId}:verify`,
      );
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId,
          tenantId,
          executionId,
          command: "pass",
          verificationResults: [
            {
              criterionId: "pilot-shift-landed",
              strategy: "deterministic",
              status: "PASS",
              recordedBy: RECORDED_BY,
              evidence: [
                `row:${row.rowId}`,
                `shift:${shift}`,
                "landed under the OTHER customer's application (the leak's durable trail)",
              ],
            },
          ],
        },
        `val-051-${executionId}:pass`,
      );
    }
  }

  // (4) the observation re-derived AT THE BOUNDARY over the durable
  // ledger; the eight PURE oracles settle the row.
  const executionIds = [windowExecutionId, ...foreignExecutionIds];
  const observation = await observationOverDurableLedger({ db, world, row, executionIds });
  const result = drivePilotRow({
    rowId: row.rowId,
    window: row.window,
    schedule: row.schedule,
    policy: row.operatingProfile,
    observation,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate }),
  });

  // (5) the criteria sealed through the REAL validation recorder onto
  // the terminal transition (the durable verification_results rows).
  const scope = {
    actorId: world.actorId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    executionId: windowExecutionId,
  };
  await world.executions.transition(
    { ...scope, command: "verify", reason: "val-051-pilot-window-verify" },
    `val-051-${windowExecutionId}:verify`,
  );
  const verificationResults = result.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    strategy: criterion.strategy,
    status: criterion.status,
    recordedBy: RECORDED_BY,
    evidence: [...criterion.evidence],
  }));
  if (result.terminal === "PILOT-COMPLETED") {
    await world.executions.transition(
      { ...scope, command: "pass", verificationResults },
      `val-051-${windowExecutionId}:pass`,
    );
  } else {
    await world.executions.transition(
      {
        ...scope,
        command: "fail",
        reason: `val-051-pilot-window-failed-criteria:${result.failedCriteria.join(",")}`,
        verificationResults,
      },
      `val-051-${windowExecutionId}:fail`,
    );
  }

  // (6) the public read boundary serves the durable terminal back.
  const observed = await client.getExecution(windowExecutionId);
  return {
    result,
    observation,
    windowExecutionId,
    executionIds,
    observedStatus: observed.status,
    windowRecordCommitted: committed.accepted,
    windowRecordReplayed: committed.replayed,
  };
}

/** The REAL recorder's durable seal of one execution, read back over REAL SQL. */
async function verificationRowsOf(
  db: DatabasePort,
  applicationId: string,
  executionId: string,
): Promise<
  readonly {
    readonly criterion_id: string;
    readonly status: string;
    readonly recorded_by: string;
  }[]
> {
  const result = await db.execute<{
    criterion_id: string;
    status: string;
    recorded_by: string;
  }>({
    sql: `SELECT criterion_id, status, recorded_by FROM executions.verification_results
          WHERE application_id = $1 AND execution_id = $2`,
    parameters: [applicationId, executionId],
  });
  return result.rows;
}

/** The row of record by id (throws when unknown). */
const rowOf = (rowId: string): PilotCorpusRow => {
  const row = pilotRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

// ---------------------------------------------------------------------------
// The suite (env-gated; the honest skip names the env var)
// ---------------------------------------------------------------------------

(url ? describe : describe.skip)("VAL-051 production pilot over REAL PostgreSQL", () => {
  let db: DatabasePort | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // The house harness's disposable-DB lifecycle: a fresh database off
    // the admin URL, the shipped migrations applied, dropped on teardown
    // (tests/integration/postgres/harness.ts pattern).
    const databaseName = `zeck_val051_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await admin.end();
    }
    const pool = new Pool({
      connectionString: `${url.replace(/\/[^/]*$/, "")}/${databaseName}`,
      max: 4,
    });
    pool.on("error", () => undefined);
    const port = new PgPort(pool);
    const applied = await applyShippedMigrations(port);
    if (applied.applied.length === 0) {
      throw new Error("expected the shipped migrations to apply on the fresh database");
    }
    db = port;
    cleanup = async () => {
      await pool.end();
      await dropDatabase(url, databaseName);
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  const database = (): DatabasePort => {
    if (db === undefined) {
      throw new Error("the disposable database is not ready");
    }
    return db;
  };

  test("the offline pilot corpus drives every row over the REAL platform path", {
    timeout: 600_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      // -----------------------------------------------------------------
      // The pinned corpus shape (the fixity anchor of the whole crown).
      // -----------------------------------------------------------------
      expect(PILOT_CORPUS_ROWS).toHaveLength(14);
      expect(OFFLINE_CORPUS_ROWS).toHaveLength(13);
      expect(PROBE_CORPUS_ROWS).toHaveLength(7);
      expect(LIVE_CORPUS_ROWS.map((row) => row.rowId)).toEqual(["live-pilot-real-window-slice"]);
      expect(OFFLINE_CORPUS_ROWS.map((row) => row.rowId)).toEqual([
        "pilot-window-full-recorded-portfolio",
        "pilot-shift-resume-exactly-once",
        "pilot-drift-drifting-named",
        "pilot-drift-regressing-reported",
        "pilot-incident-recorded-attributed",
        "pilot-budget-reservations-settled",
        "probe-pilot-cherry-picked-window",
        "probe-pilot-dropped-shift",
        "probe-pilot-double-driven-resume",
        "probe-pilot-drift-normalizing",
        "probe-pilot-incident-hiding",
        "probe-pilot-residual-hiding",
        "probe-pilot-boundary-leak",
      ]);
      expect(PROBE_CORPUS_ROWS.map((row) => row.probe?.kind)).toEqual([
        "cherry-picked-window",
        "dropped-shift",
        "double-driven-resume",
        "drift-normalizing",
        "incident-hiding",
        "residual-hiding",
        "boundary-leak",
      ]);
      const inputDigest = pinnedPilotInputDigest();
      expect(inputDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(pinnedPilotInputDigest()).toBe(inputDigest);

      // -----------------------------------------------------------------
      // The recorded basis committed READ-ONLY into REAL SQL through the
      // platform's own idempotency-record arbitration (replay semantics),
      // then served back over FRESH SQL reads and verified
      // digest-for-digest against the engine's own resolution at
      // verification time.
      // -----------------------------------------------------------------
      const seeded = await seedPilotRecordedBasis(database_, world);
      expect(seeded.stageCommitted).toBe(10);
      expect(seeded.stageReplayed).toBe(10);
      expect(seeded.anchorCommitted).toBe(5);
      expect(seeded.anchorReplayed).toBe(5);
      expect(seeded.refused).toBe(0);
      for (const [journeyRowId] of PILOT_RECORDED_JOURNEY_REPLAYS) {
        const replay = recordedJourneyReplayFor(journeyRowId);
        for (const fact of replay.stages) {
          const served = await servedBasisOf(database_, world, journeyRowId, fact.stage);
          expect(served?.costMicroUsd, `${journeyRowId}:${fact.stage}`).toBe(
            fact.economics.costMicroUsd,
          );
          expect(served?.latencyMs, `${journeyRowId}:${fact.stage}`).toBe(fact.economics.latencyMs);
          expect(served?.basisDigest, `${journeyRowId}:${fact.stage}`).toBe(
            fact.economics.basisDigest,
          );
          expect(served?.basisAuditRowId, `${journeyRowId}:${fact.stage}`).toBe(
            fact.economics.basisAuditRowId,
          );
          expect(served?.recordedAttempts, `${journeyRowId}:${fact.stage}`).toBe(
            fact.recordedAttempts,
          );
          expect(served?.recordedResolved, `${journeyRowId}:${fact.stage}`).toBe(
            fact.recordedResolved,
          );
        }
      }
      const anchors = carriedAuditBasisDigests();
      for (const auditRowId of PILOT_CARRIED_AUDIT_ROW_IDS) {
        const served = await servedAnchorOf(database_, world, auditRowId);
        expect(served?.anchorDigest, auditRowId).toBe(anchors.get(auditRowId));
      }
      // The frozen-input discipline (SQL arbitration): a different-content
      // commit under a recorded key is REFUSED — the recorded basis is
      // never re-priced.
      const tamperedBasis = await arbitrateRecord(
        database_,
        world,
        STAGE_BASIS_OPERATION,
        stageBasisKeyOf("full-journey-recorded-portfolio", "onboarding"),
        economicDigestOf({
          journeyRowId: "full-journey-recorded-portfolio",
          stage: "onboarding",
          economics: { tampered: true },
        }),
        {
          costMicroUsd: "1",
          latencyMs: 1,
          basisDigest: "tampered",
          basisAuditRowId: "tampered",
          recordedAttempts: 1,
          recordedResolved: 1,
        },
      );
      expect(tamperedBasis.refused).toBe(true);
      expect(tamperedBasis.accepted).toBe(false);
      expect(tamperedBasis.replayed).toBe(false);
      const tamperedAnchor = await arbitrateRecord(
        database_,
        world,
        AUDIT_ANCHOR_OPERATION,
        PILOT_CARRIED_AUDIT_ROW_IDS[0] ?? "",
        economicDigestOf({ auditRowId: PILOT_CARRIED_AUDIT_ROW_IDS[0], anchorDigest: "tampered" }),
        { anchorDigest: "tampered" },
      );
      expect(tamperedAnchor.refused).toBe(true);

      // -----------------------------------------------------------------
      // The whole offline corpus driven crown-style over the REAL
      // platform path: every honest row COMPLETED with 8/8 criteria
      // (the pinned verdicts + drift classifications), every probe row
      // FAILED exactly its pinned NAMED criteria, the durable
      // denaturation reproducing the offline controlled fake EXACTLY.
      // -----------------------------------------------------------------
      const landedById = new Map<string, LandedPilotRow>();
      for (const row of OFFLINE_CORPUS_ROWS) {
        const landed = await landPilotRowOverRealPlatform({
          db: database_,
          world,
          address,
          row,
          runSuffix: "crown",
        });
        landedById.set(row.rowId, landed);
        const { result, observation } = landed;
        // The pinned verdict + the digest pins (recomputed, never trusted).
        expect(result.terminal, row.rowId).toBe(row.expected.verdict);
        expect(result.failedCriteria, row.rowId).toEqual([...row.expected.failedCriteria]);
        expect(result.windowDigest, row.rowId).toBe(pilotWindowDigestOf(row.window));
        expect(result.scheduleDigest, row.rowId).toBe(
          scheduleDigestOf({ shifts: row.schedule.shifts }),
        );
        // The eight criteria in the issued AC4 order.
        expect(
          result.criteria.map((criterion) => criterion.criterionId),
          row.rowId,
        ).toEqual([...PILOT_OBSERVATION_FAMILIES]);
        // The durable observation reproduces the engine's own
        // derivation-level record EXACTLY (full-record parity).
        expect(observation, row.rowId).toEqual(pilotWindowRecordFor(row));
        // The REAL recorder's durable seal, read back over REAL SQL.
        const sealed = await verificationRowsOf(
          database_,
          world.applicationId,
          landed.windowExecutionId,
        );
        expect(sealed, row.rowId).toHaveLength(8);
        expect(sealed.map((entry) => entry.criterion_id).sort(), row.rowId).toEqual(
          [...PILOT_OBSERVATION_FAMILIES].sort(),
        );
        expect(
          sealed.every((entry) => entry.recorded_by === RECORDED_BY),
          row.rowId,
        ).toBe(true);
        expect(
          sealed
            .filter((entry) => entry.status === "FAIL")
            .map((entry) => entry.criterion_id)
            .sort(),
          row.rowId,
        ).toEqual([...row.expected.failedCriteria].sort());
        // The public read boundary serves the durable terminal.
        expect(landed.observedStatus, row.rowId).toBe(
          row.expected.verdict === "PILOT-COMPLETED" ? "COMPLETED" : "FAILED",
        );
        // The window record was COMMITTED (never a replay on first drive).
        expect(landed.windowRecordCommitted, row.rowId).toBe(true);
        expect(landed.windowRecordReplayed, row.rowId).toBe(false);

        if (row.probe === undefined) {
          // THE HONEST ROWS: PILOT-COMPLETED with all EIGHT criteria PASS.
          for (const criterion of result.criteria) {
            expect(criterion.status, `${row.rowId}/${criterion.criterionId}`).toBe("PASS");
            expect(criterion.strategy, `${row.rowId}/${criterion.criterionId}`).toBe(
              "deterministic",
            );
          }
          expect(result.notRun, row.rowId).toBe(false);
          expect(result.reason, row.rowId).toBeNull();
          // The honest drift classifications carried in the criteria's
          // own evidence (the drifting-named and regressing-reported rows).
          const driftEvidence =
            result.criteria
              .find((criterion) => criterion.criterionId === "drift-classification-honesty")
              ?.evidence.join(" ") ?? "";
          for (const finding of row.expected.driftFindings) {
            expect(driftEvidence, row.rowId).toContain(
              `derived:shift ${finding.shift} ${finding.stage} → ${finding.classification}`,
            );
            if (finding.mechanism !== null) {
              expect(driftEvidence, row.rowId).toContain(`via ${finding.mechanism}`);
            }
          }
        } else {
          // THE SEVEN PROBE ROWS: PILOT-FAILED with exactly the pinned
          // NAMED criteria, the mechanism NAMED in the evidence.
          const probe = row.probe.kind;
          const namedEvidenceOf = (criterionId: string): string =>
            result.criteria
              .find((criterion) => criterion.criterionId === criterionId)
              ?.evidence.join(" ") ?? "";
          expect(result.failedCriteria, row.rowId).toEqual([...PROBE_FAILED_CRITERIA_OF[probe]]);
          if (probe === "cherry-picked-window") {
            expect(namedEvidenceOf("window-honesty")).toContain("omitted-shift:4..5");
            expect(namedEvidenceOf("window-honesty")).toContain(
              "cherry-picked-sub-window:shifts 0..3 of 0..5",
            );
            expect(namedEvidenceOf("schedule-completeness")).toContain("missed-shift:4");
            // The DURABLE shape: the anomalous shifts' events never landed.
            const events = await segmentEventsOf(database_, landed.executionIds);
            expect(
              events.filter((event) => event.payload.shift === 4 || event.payload.shift === 5),
            ).toEqual([]);
            expect(observation.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 3]);
          }
          if (probe === "dropped-shift") {
            expect(namedEvidenceOf("schedule-completeness")).toContain("missed-shift:3");
            expect(namedEvidenceOf("window-honesty")).toContain("omitted-shift:3");
            const events = await segmentEventsOf(database_, landed.executionIds);
            expect(events.filter((event) => event.payload.shift === 3)).toEqual([]);
            expect(observation.shifts.map((shift) => shift.shift)).toEqual([0, 1, 2, 4, 5]);
          }
          if (probe === "double-driven-resume") {
            expect(namedEvidenceOf("continuation-exactly-once")).toContain(
              "shift 3 daily-usage:attempts=3,declared=2",
            );
            expect(namedEvidenceOf("continuation-exactly-once")).toContain(
              "double-driven-resume:shift 3 daily-usage (resumes=2, expected exactly 1)",
            );
            // The DURABLE shape: three durable attempts for the failed stage.
            const events = await segmentEventsOf(database_, landed.executionIds);
            expect(
              events.filter(
                (event) => event.payload.shift === 3 && event.payload.stage === "daily-usage",
              ),
            ).toHaveLength(3);
            const segment = observation.shifts
              .find((shift) => shift.shift === 3)
              ?.segments.find((entry) => entry.stage === "daily-usage");
            expect(segment?.attempts).toBe(3);
            expect(segment?.costMicroUsd).toBe("28800");
          }
          if (probe === "drift-normalizing") {
            expect(namedEvidenceOf("drift-classification-honesty")).toContain(
              "hidden-regression:shift 5 daily-usage",
            );
            // The DURABLE record carries the real drifted economics while
            // the committed claim says within-declared-bounds.
            const segment = observation.shifts
              .find((shift) => shift.shift === 5)
              ?.segments.find((entry) => entry.stage === "daily-usage");
            expect(segment?.costMicroUsd).toBe("12480");
            const claim = observation.claimedDrift.find(
              (entry) => entry.shift === 5 && entry.stage === "daily-usage",
            );
            expect(claim?.claimed).toBe("within-declared-bounds");
          }
          if (probe === "incident-hiding") {
            expect(namedEvidenceOf("incident-honesty")).toContain(
              "hidden-incident:shift 2 daily-usage",
            );
            // The DURABLE timeline holds the failure (two attempts landed)
            // while the committed log omits the incident.
            const events = await segmentEventsOf(database_, landed.executionIds);
            expect(
              events.filter(
                (event) => event.payload.shift === 2 && event.payload.stage === "daily-usage",
              ),
            ).toHaveLength(2);
            expect(observation.incidents.filter((record) => record.shift === 2)).toEqual([]);
          }
          if (probe === "residual-hiding") {
            expect(namedEvidenceOf("end-of-window-reconciliation")).toContain(
              "window-total-residual:reported 79800microUsd",
            );
            expect(namedEvidenceOf("end-of-window-reconciliation")).toContain(
              "residual -1200microUsd — both sides named",
            );
            const observedTotal = observation.shifts.reduce(
              (total, shift) => total + BigInt(shift.reportedCostMicroUsd),
              0n,
            );
            expect(observation.reported.totalCostMicroUsd).toBe("79800");
            expect(observedTotal).toBe(81000n);
          }
          if (probe === "boundary-leak") {
            expect(namedEvidenceOf("customer-boundary-integrity")).toContain(
              `foreign-application:shift 4 onboarding (executed under ${FOREIGN_APPLICATION_ID}`,
            );
            // The DURABLE leak: the shift's execution row sits under the
            // OTHER customer's application in REAL SQL.
            const leaked = await database_.execute<{ c: number }>({
              sql: `SELECT count(*)::int AS c FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2
                      AND application_id = $3 AND task->'pilot'->>'leak' = 'true'`,
              parameters: [PILOT_TASK_KIND, row.rowId, world.otherApplicationId],
            });
            expect(leaked.rows[0]?.c ?? 0, row.rowId).toBe(1);
            const segment = observation.shifts
              .find((shift) => shift.shift === 4)
              ?.segments.find((entry) => entry.stage === "onboarding");
            expect(segment?.applicationId).toBe(FOREIGN_APPLICATION_ID);
          }
        }

        // The per-row durable exactness: the row's executions are exactly
        // the expected durable surface (zero phantoms), zero orphan
        // events, gapless event sequences.
        const rowExecutions = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions
                WHERE task->>'kind' = $1 AND task->>'rowId' = $2`,
          parameters: [PILOT_TASK_KIND, row.rowId],
        });
        expect(rowExecutions.rows[0]?.c ?? 0, row.rowId).toBe(
          row.probe?.kind === "boundary-leak" ? 2 : 1,
        );
        const orphans = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.execution_events e
                  LEFT JOIN executions.executions x ON e.execution_id = x.id
                  WHERE e.application_id = $1 AND x.id IS NULL`,
          parameters: [world.applicationId],
        });
        expect(orphans.rows[0]?.c ?? 0, row.rowId).toBe(0);
        const sequences = await database_.execute<{
          execution_id: string;
          sequence: number;
        }>({
          sql: `SELECT execution_id::text AS execution_id, sequence FROM executions.execution_events
                WHERE execution_id = ANY($1::uuid[]) ORDER BY execution_id, sequence`,
          parameters: [landed.executionIds],
        });
        const byExecution = new Map<string, number[]>();
        for (const record of sequences.rows) {
          const list = byExecution.get(record.execution_id) ?? [];
          list.push(record.sequence);
          byExecution.set(record.execution_id, list);
        }
        expect(byExecution.size, row.rowId).toBe(landed.executionIds.length);
        for (const [executionId, list] of byExecution) {
          expect(list, `${row.rowId}/${executionId}`).toEqual(
            Array.from({ length: list.length }, (_, index) => index + 1),
          );
        }
      }

      // -----------------------------------------------------------------
      // The REAL idempotency ledger's own replay semantics over REAL HTTP:
      // the identical re-submission under the app's submission key
      // REPLAYS (never a second durable execution); a different-content
      // commit under the recorded key THROWS (the frozen-input
      // discipline at the public boundary).
      // -----------------------------------------------------------------
      const client = createZeckClient({
        baseUrl: address,
        token: world.bearerToken,
        applicationId: world.applicationId,
        fetchImpl: globalThis.fetch,
      });
      const headlineRow = rowOf("pilot-window-full-recorded-portfolio");
      const headline = landedById.get("pilot-window-full-recorded-portfolio");
      if (headline === undefined) {
        throw new Error("the headline row never landed");
      }
      const replay = (
        await client.createExecution(
          { applicationId: world.applicationId, task: taskBodyFor({ row: headlineRow }) },
          submissionKey({ runSuffix: "crown", taskIndex: 0 }),
        )
      ).receipt;
      expect(replay.replayed).toBe(true);
      expect(replay.executionId).toBe(headline.windowExecutionId);
      expect(replay.status).toBe("COMPLETED");
      await expect(
        client.createExecution(
          {
            applicationId: world.applicationId,
            task: { ...taskBodyFor({ row: headlineRow }), tampered: true },
          },
          submissionKey({ runSuffix: "crown", taskIndex: 0 }),
        ),
      ).rejects.toThrow(/different request fingerprint/);

      // -----------------------------------------------------------------
      // Trajectory determinism: a headline re-drive over a FRESH
      // submission reproduces its pilot window EXACTLY — the same
      // observation digests, the same criteria statuses, the committed
      // window record REPLAYING under its recorded key.
      // -----------------------------------------------------------------
      const reDrive = await landPilotRowOverRealPlatform({
        db: database_,
        world,
        address,
        row: headlineRow,
        runSuffix: `redrive-${generateId()}`,
      });
      expect(reDrive.result.terminal).toBe("PILOT-COMPLETED");
      expect(reDrive.result.failedCriteria).toEqual([]);
      expect(reDrive.result.criteria.map((criterion) => criterion.status)).toEqual(
        headline.result.criteria.map((criterion) => criterion.status),
      );
      expect(reDrive.observation).toEqual(headline.observation);
      expect(reDrive.observation.windowDigest).toBe(headline.observation.windowDigest);
      expect(reDrive.result.windowDigest).toBe(headline.result.windowDigest);
      expect(reDrive.result.scheduleDigest).toBe(headline.result.scheduleDigest);
      expect(reDrive.observedStatus).toBe("COMPLETED");
      expect(reDrive.windowRecordCommitted).toBe(false);
      expect(reDrive.windowRecordReplayed).toBe(true);
      expect(reDrive.windowExecutionId).not.toBe(headline.windowExecutionId);

      // -----------------------------------------------------------------
      // Freeze integrity after the battery: every recorded basis record
      // re-commits identically (all REPLAY, zero new commits, zero
      // refusals); a different-content commit under a recorded
      // window-record key is REFUSED; the live row never held an
      // offline window record (never fabricated).
      // -----------------------------------------------------------------
      const refrozen = await seedPilotRecordedBasis(database_, world);
      expect(refrozen.stageCommitted).toBe(0);
      expect(refrozen.stageReplayed).toBe(10);
      expect(refrozen.anchorCommitted).toBe(0);
      expect(refrozen.anchorReplayed).toBe(5);
      expect(refrozen.refused).toBe(0);
      const tamperedReport = await arbitrateRecord(
        database_,
        world,
        WINDOW_RECORD_OPERATION,
        windowRecordKeyOf("pilot-window-full-recorded-portfolio"),
        economicDigestOf({
          rowId: "pilot-window-full-recorded-portfolio",
          windowRecord: { tampered: true },
        }),
        { tampered: true },
      );
      expect(tamperedReport.refused).toBe(true);
      expect(tamperedReport.accepted).toBe(false);
      expect(pilotWindowRecordFor(rowOf("live-pilot-real-window-slice"))).toBeNull();
      const liveWindowRecords = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE operation_name = $1 AND idempotency_key = $2`,
        parameters: [WINDOW_RECORD_OPERATION, windowRecordKeyOf("live-pilot-real-window-slice")],
      });
      expect(liveWindowRecords.rows[0]?.c ?? 0).toBe(0);

      // -----------------------------------------------------------------
      // The ledger exactly-once counts (durable executions +
      // idempotency records — zero phantoms, zero drift, zero orphans).
      // -----------------------------------------------------------------
      const executionCounts = await database_.execute<{
        row_id: string;
        c: number;
      }>({
        sql: `SELECT task->>'rowId' AS row_id, count(*)::int AS c FROM executions.executions
              WHERE task->>'kind' = $1 GROUP BY 1 ORDER BY 1`,
        parameters: [PILOT_TASK_KIND],
      });
      expect(executionCounts.rows.map((record) => record.row_id)).toEqual(
        [...OFFLINE_CORPUS_ROWS.map((row) => row.rowId)].sort(),
      );
      const expectedExecutionCounts: Readonly<Record<string, number>> = {
        "pilot-window-full-recorded-portfolio": 2, // the window + the FRESH re-drive
        "probe-pilot-boundary-leak": 2, // the window + the leaked shift's execution
      };
      for (const record of executionCounts.rows) {
        expect(record.c, record.row_id).toBe(expectedExecutionCounts[record.row_id] ?? 1);
      }
      const createRecords = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE operation_name = 'executions.create' AND idempotency_key LIKE 'val-051-%'`,
        parameters: [],
      });
      expect(createRecords.rows[0]?.c ?? 0).toBe(15);
      const operationCounts = await database_.execute<{
        operation_name: string;
        c: number;
      }>({
        sql: `SELECT operation_name, count(*)::int AS c FROM platform.idempotency_records
              WHERE operation_name IN ($1, $2, $3) GROUP BY 1 ORDER BY 1`,
        parameters: [STAGE_BASIS_OPERATION, AUDIT_ANCHOR_OPERATION, WINDOW_RECORD_OPERATION],
      });
      expect(operationCounts.rows.map((record) => [record.operation_name, record.c])).toEqual([
        [AUDIT_ANCHOR_OPERATION, 5],
        [STAGE_BASIS_OPERATION, 10],
        [WINDOW_RECORD_OPERATION, 13],
      ]);
      const globalOrphans = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.execution_events e
                LEFT JOIN executions.executions x ON e.execution_id = x.id
                WHERE x.id IS NULL`,
        parameters: [],
      });
      expect(globalOrphans.rows[0]?.c ?? 0).toBe(0);
      const crownSeals = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.verification_results v
              JOIN executions.executions x ON v.execution_id = x.id
              WHERE x.task->>'kind' = $1`,
        parameters: [PILOT_TASK_KIND],
      });
      expect(crownSeals.rows[0]?.c ?? 0).toBe(113); // 13 rows × 8 + the leak shift + the re-drive
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live pilot rail drives one REAL slice over the pinned OpenRouter rail", {
    timeout: 600_000,
  }, async () => {
    // The env-gated live rows (exactly ONE live row in the pinned corpus).
    const liveRows = PILOT_CORPUS_ROWS.filter((row) => row.needsDispatch);
    expect(liveRows.map((row) => row.rowId)).toEqual(["live-pilot-real-window-slice"]);
    const liveRow = liveRows[0];
    if (liveRow === undefined) {
      throw new Error("the pinned corpus holds no live row");
    }
    if (OPENROUTER_KEY.length === 0) {
      // -----------------------------------------------------------------
      // The honest NOT-RUN boundary (the env var NAMED, never a fake
      // success — the gate-closed invariants asserted below).
      // -----------------------------------------------------------------
      console.warn(
        "[VAL-051] OPENROUTER_API_KEY absent — the REAL live pilot slice is a NOT RUN boundary " +
          "(recorded honestly; no fake success is asserted). The offline corpus above covers the " +
          "complete pilot machinery over the RECORDED basis without credentials. Required access: " +
          "an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the " +
          "pinned chat model meta-llama/llama-3.3-70b-instruct on the ONE pinned rail — the REAL " +
          "live pilot slice demands 3 shifts × 2 REAL dispatches SUSTAINED across the declared " +
          "live window at 1500ms on / 500ms off pacing (never a burst), every dispatch recorded " +
          "through the REAL recorder with honest MEASURED economics, live incidents classified " +
          "through the REAL taxonomy, and the verdict DERIVED from the measured facts (a measured " +
          "gap beyond the declared tolerance classified honestly — noise is never signal, never " +
          "normalized, never fabricated). This live lane is reserved for the operator/session-B " +
          "live review (the Lead's credential lane; the offline crown above never re-measures).",
      );
      // The gate is honestly closed for every live row.
      expect(liveGateOpen(liveRow, process.env)).toBe(false);
      // The live row holds NO offline window record (an offline
      // fabrication would be a fake measurement, never).
      expect(pilotWindowRecordFor(liveRow)).toBeNull();
      // The closed-gate driver: NOT-RUN with the env var NAMED.
      const closed = drivePilotRow({
        rowId: liveRow.rowId,
        window: liveRow.window,
        schedule: liveRow.schedule,
        policy: liveRow.operatingProfile,
        observation: null,
        ...(liveRow.liveGate === undefined ? {} : { liveGate: liveRow.liveGate }),
      });
      expect(closed.terminal).toBe("NOT-RUN");
      expect(closed.notRun).toBe(true);
      expect(closed.reason).toContain("OPENROUTER_API_KEY");
      expect(closed.criteria).toHaveLength(1);
      expect(closed.criteria[0]?.criterionId).toBe("live-gate-honesty");
      expect(closed.criteria[0]?.status).toBe("PASS");
      expect(closed.criteria[0]?.evidence.join(" ")).toContain("gate:OPENROUTER_API_KEY");
      expect(closed.criteria[0]?.evidence.join(" ")).toContain(
        `plan-digest:${livePilotPlanDigestOf()}`,
      );
      // The pinned live plan stays deterministic whether or not the gate
      // ever opens (the gate-closed invariant's own pin).
      expect(LIVE_PILOT_PLAN.shifts).toBe(3);
      expect(LIVE_PILOT_PLAN.dispatchesPerShift).toBe(2);
      expect(LIVE_PILOT_PLAN.liveDispatches).toBe(6);
      expect(LIVE_PILOT_PLAN.pacing.onMs).toBe(1500);
      expect(LIVE_PILOT_PLAN.pacing.offMs).toBe(500);
      expect(LIVE_PILOT_PLAN.rail.provider).toBe("openrouter");
      expect(LIVE_PILOT_PLAN.rail.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(LIVE_PILOT_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
      expect(LIVE_PILOT_PLAN.rail.maxTokens).toBe(32);
      expect(LIVE_PILOT_PLAN.rail.priceRevision).toBe("rev-001");
      expect(LIVE_PILOT_PLAN.envVar).toBe("OPENROUTER_API_KEY");
      expect(livePilotPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
      expect(livePilotPlanDigestOf()).toBe(livePilotPlanDigestOf());
      // Never a fake success: the honest NOT-RUN is the verified outcome.
      expect(liveRow.expected.verdict).toBe("NOT-RUN");
      expect(true).toBe(true);
      return;
    }

    // -------------------------------------------------------------------
    // The gate is OPEN (the Lead's credential): 3 shifts × 2 REAL
    // dispatches SUSTAINED across the declared live window on the ONE
    // pinned rail, every dispatch recorded through the REAL recorder,
    // the verdict DERIVED from the measured facts.
    // -------------------------------------------------------------------
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const generateLiveId = createUuidv7Generator();
    const rails = createRealAccountingRails();
    try {
      // The recorded basis (digest-verified at run time — the live
      // slice's classification reference).
      const seeded = await seedPilotRecordedBasis(database_, world);
      expect(seeded.stageCommitted + seeded.stageReplayed).toBe(20);

      /** Price ONE measured dispatch onto the canonical micro-USD basis. */
      const priceTokensAt = (tokens: number, tier: "input" | "output"): bigint => {
        const manifest = manifestRevisionOf(LIVE_PILOT_PLAN.rail.priceRevision);
        const entry =
          manifest === null
            ? null
            : resolveListPrice(
                manifest,
                LIVE_PILOT_PLAN.rail.provider,
                LIVE_PILOT_PLAN.rail.model,
                tier,
              );
        if (entry === null) {
          throw new Error(
            `the pinned model manifest holds no ${tier} price for ${LIVE_PILOT_PLAN.rail.model}`,
          );
        }
        const price = parseDecimal(entry.price);
        if (price === null) {
          throw new Error("the pinned list price failed to parse as a decimal");
        }
        return divRoundHalfUp(BigInt(tokens) * price.digits, 10n ** BigInt(price.scale));
      };

      // The live window submission over the REAL public path.
      const runSuffix = `live-${generateLiveId()}`;
      const taskIndex = PILOT_ROW_IDS.indexOf(liveRow.rowId);
      const client = createZeckClient({
        baseUrl: address,
        token: world.bearerToken,
        applicationId: world.applicationId,
        fetchImpl: globalThis.fetch,
      });
      const receipt = (
        await client.createExecution(
          { applicationId: world.applicationId, task: taskBodyFor({ row: liveRow }) },
          submissionKey({ runSuffix, taskIndex }),
        )
      ).receipt;
      await driveWindowExecutionToStart({
        world,
        executionId: receipt.executionId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        armDecision: {
          rowId: liveRow.rowId,
          windowDigest: pilotWindowDigestOf(liveRow.window),
          scheduleDigest: scheduleDigestOf({ shifts: liveRow.schedule.shifts }),
          liveRail: LIVE_PILOT_PLAN.rail.endpoint,
        },
      });

      // The sustained live dispatch lane: 3 shifts × 2 REAL dispatches,
      // paced 500ms off between dispatches (never a burst), the on-phase
      // each dispatch's own MEASURED wallclock (never fabricated).
      interface DispatchFact {
        readonly shift: number;
        readonly ordinal: number;
        readonly resolved: boolean;
        readonly contentLanded: boolean;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly costMicroUsd: string;
        readonly latencyMs: number;
        readonly attributionClass: AttributionClass;
      }
      const dispatches: DispatchFact[] = [];
      const liveIncidents: {
        readonly shift: number;
        readonly stage: JourneyStageKind;
        readonly attributionClass: AttributionClass;
        readonly magnitudeMicroUsd: string;
        readonly dispositionKind: IncidentDispositionKind;
      }[] = [];
      const sealedRunIds: string[] = [];
      const metadata = {
        program: "zeck-validation",
        workOrder: "VAL-051",
        baseRevision: "val-051-production-pilot-crown",
        applicationRevision: "val-051-production-pilot-crown",
        corpusRevision: "val-051-production-pilot-v1",
        integrationSurface: "pilot:live-measured-slice",
        environment: {
          runtime: `node ${process.version}`,
          toolchain: "vitest",
          database: "postgresql",
          configuration: { suite: "val-051-production-pilot", row: liveRow.rowId },
        },
        observedAt: new Date().toISOString(),
      };
      let dispatchOrdinal = 0;
      for (let shift = 0; shift < LIVE_PILOT_PLAN.shifts; shift += 1) {
        for (let within = 0; within < LIVE_PILOT_PLAN.dispatchesPerShift; within += 1) {
          if (dispatchOrdinal > 0) {
            await new Promise((resolve) => setTimeout(resolve, LIVE_PILOT_PLAN.pacing.offMs));
          }
          dispatchOrdinal += 1;
          const startedAt = Date.now();
          let resolved = false;
          let contentLanded = false;
          let inputTokens = 0;
          let outputTokens = 0;
          let attributionClass: AttributionClass = "empty-completion";
          try {
            const response = await fetch(LIVE_PILOT_PLAN.rail.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: LIVE_PILOT_PLAN.rail.model,
                max_tokens: LIVE_PILOT_PLAN.rail.maxTokens,
                messages: [
                  {
                    role: "user",
                    content: `Reply with the single word: ok (live pilot dispatch ${dispatchOrdinal})`,
                  },
                ],
              }),
            });
            // The provider envelope's usage tokens WIN over raw HTTP
            // observations; the empty-completion 200 is an honest
            // non-error (VAL-014 rule) — priced, counted, resolved only
            // when content actually landed.
            const payload = (await response.json()) as {
              readonly choices?: readonly {
                readonly message?: { readonly content?: string };
              }[];
              readonly usage?: {
                readonly prompt_tokens?: number;
                readonly completion_tokens?: number;
              };
            };
            const content = payload.choices?.[0]?.message?.content ?? "";
            inputTokens = payload.usage?.prompt_tokens ?? 0;
            outputTokens = payload.usage?.completion_tokens ?? 0;
            contentLanded = content.length > 0;
            resolved = response.ok && contentLanded;
            attributionClass = response.ok
              ? "empty-completion"
              : classifyProviderEnvelope(
                  response.status,
                  payload as unknown as Record<string, unknown>,
                ).attributionClass;
          } catch (error) {
            attributionClass = classifyTransportError(error).attributionClass;
          }
          const costMicroUsd = (
            priceTokensAt(inputTokens, "input") + priceTokensAt(outputTokens, "output")
          ).toString();
          const latencyMs = Math.max(1, Date.now() - startedAt);
          dispatches.push({
            shift,
            ordinal: dispatchOrdinal,
            resolved,
            contentLanded,
            inputTokens,
            outputTokens,
            costMicroUsd,
            latencyMs,
            attributionClass,
          });
          if (!resolved) {
            liveIncidents.push({
              shift,
              stage: "daily-usage",
              attributionClass,
              magnitudeMicroUsd: costMicroUsd,
              dispositionKind: isRetryableAttributionClass(attributionClass)
                ? "bounded-retry"
                : "accepted-risk",
            });
          }
          // Every dispatch recorded through the REAL recorder with honest
          // measured economics (the sealed run record's own digest).
          const sealed = rails.sealRound({
            metadata,
            corpusTaskId: `val-051:${liveRow.rowId}:dispatch-${dispatchOrdinal}`,
            environmentIdentity: `val-051-live-${liveRow.rowId}`,
            events: [],
            environment: [],
            latency: [
              {
                phase: "total",
                source: "harness-wallclock",
                milliseconds: latencyMs,
              },
            ],
            cost: [
              {
                kind: "measured",
                amountMicroUsd: costMicroUsd,
                source: `openrouter:${LIVE_PILOT_PLAN.rail.model}@${LIVE_PILOT_PLAN.rail.priceRevision}`,
                scope: "direct-execution",
              },
            ],
            sealedAt: new Date().toISOString(),
          });
          sealedRunIds.push(sealed.runId);
          // The dispatch's durable trail on the live window execution
          // (the recorded basis digest reference of the dispatched stage).
          const dailyUsageBasis = await servedBasisOf(
            database_,
            world,
            liveRow.schedule.shifts[shift]?.journeyRowId ?? "",
            "daily-usage",
          );
          if (dailyUsageBasis === null) {
            throw new Error("no recorded daily-usage basis served for the live slice");
          }
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId: receipt.executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command: "agent-action-recorded",
              cause: `val-051-live-s${shift}-daily-usage-a${within + 1}`,
              reference: {
                kind: "pilot-live-dispatch",
                ordinal: dispatchOrdinal,
                digest: dailyUsageBasis.basisDigest,
              },
              payload: {
                family: "pilot-segment",
                shift,
                stage: "daily-usage",
                attempt: within + 1,
                resolved,
              },
            },
            `val-051-${receipt.executionId}:live:s${shift}:daily-usage:a${within + 1}`,
          );
        }
      }
      expect(dispatches).toHaveLength(LIVE_PILOT_PLAN.liveDispatches);
      expect(sealedRunIds).toHaveLength(LIVE_PILOT_PLAN.liveDispatches);
      for (const runId of sealedRunIds) {
        expect(runId).toMatch(/^val-run-[0-9a-f]{64}$/);
      }
      // The recorded (non-dispatched) stages' durable trail: the
      // re-measurement ban honored — they replay the RECORDED basis,
      // never re-measured.
      for (const scheduled of liveRow.schedule.shifts) {
        for (const segment of scheduled.segments) {
          if (segment.stage === "daily-usage") {
            continue;
          }
          const basis = await servedBasisOf(
            database_,
            world,
            scheduled.journeyRowId,
            segment.stage,
          );
          if (basis === null) {
            throw new Error(
              `no recorded basis served for ${scheduled.journeyRowId}:${segment.stage}`,
            );
          }
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId: receipt.executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command: "agent-action-recorded",
              cause: `val-051-live-s${scheduled.shift}-${segment.stage}-a1`,
              reference: {
                kind: "pilot-segment-basis",
                ordinal: scheduled.shift * scheduled.segments.length,
                digest: basis.basisDigest,
              },
              payload: {
                family: "pilot-segment",
                shift: scheduled.shift,
                stage: segment.stage,
                attempt: 1,
                resolved: true,
              },
            },
            `val-051-${receipt.executionId}:live:s${scheduled.shift}:${segment.stage}:a1`,
          );
        }
      }

      // The MEASURED window record (the live lane's own observation —
      // measured where dispatched, the recorded basis where recorded).
      const measuredShifts: ObservedShiftRecord[] = [];
      for (const scheduled of liveRow.schedule.shifts) {
        const shiftDispatches = dispatches.filter((dispatch) => dispatch.shift === scheduled.shift);
        const segments: ObservedShiftSegment[] = [];
        for (const segment of scheduled.segments) {
          const basis = await servedBasisOf(
            database_,
            world,
            scheduled.journeyRowId,
            segment.stage,
          );
          if (basis === null) {
            throw new Error(
              `no recorded basis served for ${scheduled.journeyRowId}:${segment.stage}`,
            );
          }
          if (segment.stage === "daily-usage") {
            segments.push({
              shift: scheduled.shift,
              stage: segment.stage,
              attempts: shiftDispatches.length,
              resolved: shiftDispatches.filter((dispatch) => dispatch.resolved).length,
              costMicroUsd: shiftDispatches
                .reduce((total, dispatch) => total + BigInt(dispatch.costMicroUsd), 0n)
                .toString(),
              latencyMs: shiftDispatches.reduce((total, dispatch) => total + dispatch.latencyMs, 0),
              basisDigest: basis.basisDigest,
              applicationId: PILOT_CUSTOMER_APPLICATION_ID,
            });
            continue;
          }
          segments.push({
            shift: scheduled.shift,
            stage: segment.stage,
            attempts: basis.recordedAttempts,
            resolved: basis.recordedResolved,
            costMicroUsd: basis.costMicroUsd,
            latencyMs: basis.latencyMs,
            basisDigest: basis.basisDigest,
            applicationId: PILOT_CUSTOMER_APPLICATION_ID,
          });
        }
        measuredShifts.push({
          shift: scheduled.shift,
          journeyRowId: scheduled.journeyRowId,
          segments,
          reportedCostMicroUsd: segments
            .reduce((total, segment) => total + BigInt(segment.costMicroUsd), 0n)
            .toString(),
          reportedLatencyMs: segments.reduce((total, segment) => total + segment.latencyMs, 0),
        });
      }
      const drifts = deriveWindowDrift({
        window: liveRow.window,
        schedule: liveRow.schedule,
        observation: {
          rowId: liveRow.rowId,
          basis: "measured-live",
          shifts: measuredShifts,
          incidents: [],
          claimedDrift: [],
          continuations: [],
          ledger: [],
          reported: { totalCostMicroUsd: "0", totalLatencyMs: 0 },
          windowDigest: "",
          usage: null,
        },
      });
      const claimedDrift: ClaimedDriftClassification[] = drifts.map((drift) => ({
        shift: drift.shift,
        stage: drift.stage,
        claimed: drift.classification,
        mechanism: drift.mechanism,
      }));
      const ledgerWriter = createWindowLedger(liveRow.operatingProfile);
      for (const shift of measuredShifts) {
        const reservationId = `val-051-live-${liveRow.rowId}-shift${shift.shift}`;
        const admitted = ledgerWriter.reserve({
          shift: shift.shift,
          reservationId,
          amountMicroUsd: shift.reportedCostMicroUsd,
        });
        if (!admitted.admitted) {
          throw new Error("the declared live window budget refused a scheduled shift");
        }
        ledgerWriter.spend({ reservationId, amountMicroUsd: shift.reportedCostMicroUsd });
        ledgerWriter.settle({ reservationId, settledMicroUsd: shift.reportedCostMicroUsd });
      }
      const incidents = liveIncidents.map((incident) => ({
        shift: incident.shift,
        stage: incident.stage,
        attributionClass: incident.attributionClass,
        magnitudeMicroUsd: incident.magnitudeMicroUsd,
        disposition: {
          kind: incident.dispositionKind,
          detailDigest: economicDigestOf({
            rowId: liveRow.rowId,
            shift: incident.shift,
            stage: incident.stage,
            attributionClass: incident.attributionClass,
            disposition: incident.dispositionKind,
            magnitudeMicroUsd: incident.magnitudeMicroUsd,
          }),
        },
      }));
      const measuredObservation: PilotWindowObservation = {
        rowId: liveRow.rowId,
        basis: "measured-live",
        shifts: measuredShifts,
        incidents,
        claimedDrift,
        continuations: [],
        ledger: ledgerWriter.lines(),
        reported: {
          totalCostMicroUsd: measuredShifts
            .reduce((total, shift) => total + BigInt(shift.reportedCostMicroUsd), 0n)
            .toString(),
          totalLatencyMs: measuredShifts.reduce(
            (total, shift) => total + shift.reportedLatencyMs,
            0,
          ),
        },
        windowDigest: windowRecordDigestOf({
          rowId: liveRow.rowId,
          basis: "measured-live",
          shifts: measuredShifts,
        }),
        usage: {
          inputTokens: dispatches.reduce((total, dispatch) => total + dispatch.inputTokens, 0),
          outputTokens: dispatches.reduce((total, dispatch) => total + dispatch.outputTokens, 0),
        },
      };
      // Every live incident attributed through the imported taxonomy
      // with a disposition honoring the class's retryability discipline.
      for (const incident of measuredObservation.incidents) {
        expect(isKnownAttributionClass(incident.attributionClass)).toBe(true);
      }

      // The verdict DERIVED from the measured facts (never pinned).
      const result = drivePilotRow({
        rowId: liveRow.rowId,
        window: liveRow.window,
        schedule: liveRow.schedule,
        policy: liveRow.operatingProfile,
        observation: measuredObservation,
        ...(liveRow.liveGate === undefined ? {} : { liveGate: liveRow.liveGate }),
      });
      expect(result.notRun).toBe(false);
      expect(result.criteria.map((criterion) => criterion.criterionId)).toEqual([
        ...PILOT_OBSERVATION_FAMILIES,
      ]);
      // The claimed classifications equal the derived ones (honest
      // recording — never a normalization, never a fabrication).
      const rederived = deriveWindowDrift({
        window: liveRow.window,
        schedule: liveRow.schedule,
        observation: measuredObservation,
      });
      expect(claimedDrift).toEqual(
        rederived.map((drift) => ({
          shift: drift.shift,
          stage: drift.stage,
          claimed: drift.classification,
          mechanism: drift.mechanism,
        })),
      );
      // The measured usage landed (the live rail's own currency).
      expect((measuredObservation.usage?.inputTokens ?? 0) > 0).toBe(true);

      // The verdict sealed through the REAL validation recorder onto the
      // terminal transition; the public read boundary serves the durable
      // terminal back (observedTerminal === terminal, whatever derived).
      const scope = {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId: receipt.executionId,
      };
      await world.executions.transition(
        { ...scope, command: "verify", reason: "val-051-live-window-verify" },
        `val-051-${receipt.executionId}:verify`,
      );
      const verificationResults = result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: RECORDED_BY,
        evidence: [...criterion.evidence],
      }));
      if (result.terminal === "PILOT-COMPLETED") {
        await world.executions.transition(
          { ...scope, command: "pass", verificationResults },
          `val-051-${receipt.executionId}:pass`,
        );
      } else {
        await world.executions.transition(
          {
            ...scope,
            command: "fail",
            reason: `val-051-live-window-failed-criteria:${result.failedCriteria.join(",")}`,
            verificationResults,
          },
          `val-051-${receipt.executionId}:fail`,
        );
      }
      const observed = await client.getExecution(receipt.executionId);
      expect(observed.status).toBe(result.terminal === "PILOT-COMPLETED" ? "COMPLETED" : "FAILED");
      const sealed = await verificationRowsOf(database_, world.applicationId, receipt.executionId);
      expect(sealed).toHaveLength(8);
      expect(sealed.every((entry) => entry.recorded_by === RECORDED_BY)).toBe(true);
      const measuredTotal = dispatches.reduce(
        (total, dispatch) => total + BigInt(dispatch.costMicroUsd),
        0n,
      );
      console.info(
        `[VAL-051] LIVE ${liveRow.rowId} -> ${result.terminal} ` +
          `(${LIVE_PILOT_PLAN.liveDispatches} REAL dispatches over the pinned rail, ` +
          `measured ${measuredTotal.toString()}microUsd, ` +
          `usage ${measuredObservation.usage?.inputTokens ?? 0}+${measuredObservation.usage?.outputTokens ?? 0} tokens, ` +
          `failed criteria: [${result.failedCriteria.join(",")}] — the verdict derived from the measured facts).`,
      );
    } finally {
      await world.server.app.close();
    }
  });
});
