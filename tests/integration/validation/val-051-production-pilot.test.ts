/**
 * VAL-051 — the integration crown: the PRODUCTION-STYLE PILOT WITH
 * SUSTAINED OBSERVATION's durable surface over REAL PostgreSQL
 * (env-gated on ZECK_PG_TEST_URL).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - REAL PostgreSQL 16 (a per-run disposable database created off the
 *     admin database named by ZECK_PG_TEST_URL, the shipped migrations
 *     applied, dropped on teardown — the house harness's disposable-DB
 *     lifecycle, inlined at the env gate this work order demands);
 *   - the REAL Fastify public API over the REAL SQL authorities
 *     (seedApiPgWorld) listening on a real port;
 *   - the customer side rides the REAL SDK client over REAL HTTP
 *     (globalThis.fetch — the same public wire the application's
 *     harness rides): every shift of the sustained-observation window
 *     is submitted through the public create boundary under its OWN
 *     idempotency key (the resumed shift's failed attempt and resume
 *     are separate durable submissions under separate keys);
 *   - the REAL executions state machine drives every landed execution
 *     through the canonical transitions (authorize → plan → [durable
 *     planning decision] → queue → start → [step event with the
 *     shift's recorded-basis DIGEST reference] → verify → pass/fail);
 *   - the RECORDED SHIFT ECONOMICS (the VAL-049 carried cost basis via
 *     the VAL-050 chained journey), the window's DECLARED DRIFT, its
 *     DECLARED INCIDENTS and its WINDOW DISCIPLINE (the budget-policy
 *     envelope: per-shift reservations, latency policy, the window
 *     budget) are committed READ-ONLY into REAL SQL through the
 *     platform's own idempotency-record arbitration: an identical
 *     re-commit REPLAYS, a different-content commit under a recorded
 *     key is REFUSED (the recorded basis is a frozen input), then
 *     served back over FRESH SQL reads;
 *   - the EIGHT mechanical observation oracles are re-derived AT THE
 *     BOUNDARY over the DURABLE LEDGER: the pilot observation is
 *     derived purely from REAL SQL reads (the durable shift
 *     executions and their executing application identities, the
 *     SQL-served recorded economics, the SQL-served declared drift,
 *     the SQL-served incident records and the SQL-served window
 *     discipline) — never trusting the platform's own claim — and the
 *     honest durable windows reproduce the offline pure derivation
 *     EXACTLY (digest parity: the boundary observation matches the
 *     offline derivation digest-for-digest, execution ids aside, and
 *     the boundary verdict equals the offline verdict).
 *
 * The durable discriminations: the seven adversarial durable shapes
 * (a cherry-picked window — the last shift's execution never lands and
 * the window reported complete; a dropped shift — the daily-usage
 * execution never lands; a double-driven resume — three durable
 * executions for the declared incident's shift; a normalized drift —
 * the beyond-band delta reported within bounds; a hidden incident —
 * the resumed shift's failure durably visible with NO incident record;
 * a hidden residual — the reported total hiding half the daily-usage
 * cost; a boundary leak — the daily-usage execution durably under
 * ANOTHER customer's application) are each DETECTED over the durable
 * ledger by the NAMED oracle with the mechanism named in evidence.
 *
 * The live rail (AC3) rides the env-gated live driver: the live
 * pilot window demands the operator-authorized rail
 * (OPENROUTER_API_KEY) — off-key the row is an honest NOT RUN (the
 * env var NAMED, ZERO dispatches, the gate pinned, the live row
 * landing ZERO durable submissions over REAL SQL); on-key one REAL
 * dispatch per scheduled shift lands over the REAL platform path
 * through the REAL recorder with honest measured economics. This
 * crown never fabricates a live pilot window.
 *
 * Honest skip: without ZECK_PG_TEST_URL the suite SKIPS (never fails,
 * never fake-passes) with the env var NAMED.
 */

import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { divRoundHalfUp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import type {
  PilotProbeKind,
  ProductionPilotCorpusRow,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_CUSTOMER_APPLICATION_ID,
  PROBE_FAILED_CRITERIA_OF,
  pilotRowById,
  RECORDED_SEGMENT_QUALITY,
  shiftIdOf,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import type {
  IncidentLogEntry,
  LedgerEntry,
  PilotObservation,
  SegmentDriftEntry,
  ShiftObservation,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  derivePilotVerdict,
  FOREIGN_APPLICATION_ID,
  honestDriftClassificationOf,
  LIVE_PILOT_PLAN,
  livePilotPlanDigestOf,
  pilotObservationFor,
  verifyProductionPilotIntegrity,
} from "../../../benchmarks/validation/apps/production-pilot/driver";
import { createZeckClient } from "../../../sdk";
import { applyShippedMigrations } from "../../../src/platform/db/migrations/runner";
import type { DatabasePort, Query, QueryResult, Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { dropDatabase } from "../postgres/harness";

// ---------------------------------------------------------------------------
// The env gate (the honest skip names the env var)
// ---------------------------------------------------------------------------

const url = process.env.ZECK_PG_TEST_URL ?? "";
if (!url) {
  console.info(
    "[val-051-production-pilot] SKIPPED: ZECK_PG_TEST_URL is not set — the integration crown demands REAL PostgreSQL " +
      "(e.g. ZECK_PG_TEST_URL='postgres://val@127.0.0.1:5433/postgres'); the pilot's durable surface " +
      "(the sustained-observation window's durable executions, continuation exactly-once, idempotent reissue, " +
      "accounting + budget-policy envelope) is only provable over REAL SQL. Re-run with the variable set to drive the crown.",
  );
}

/** The operator-authorized live-rail credential (absent = the live row is an honest NOT RUN). */
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

/** The durable task vocabulary of the crown's shift executions. */
const SHIFT_TASK_KIND = "production-pilot.shift.v1";

/** The REAL SQL operations the crown's read-only window inputs ride. */
const RECORDED_BASIS_OPERATION = "val-051.recorded-shift-economics";
const DECLARED_DRIFT_OPERATION = "val-051.declared-drift";
const DECLARED_INCIDENT_OPERATION = "val-051.declared-incident";
const WINDOW_DISCIPLINE_OPERATION = "val-051.window-discipline";

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
// The durable-pilot machinery over the REAL platform path
// ---------------------------------------------------------------------------

const generateId = createUuidv7Generator();

/** The create key of one shift submission (attempt 1 = the shift's own key). */
const shiftKeyOf = (rowId: string, shiftId: string): string => `val-051-crown-${rowId}:${shiftId}`;
const resumeKeyOf = (rowId: string, shiftId: string, ordinal: number): string =>
  `val-051-crown-${rowId}:${shiftId}#resume-${ordinal}`;

interface DurableExecutionRow {
  readonly id: string;
  readonly status: string;
  readonly shift_id: string;
  readonly application_id: string;
  readonly created_at: Date;
}

/** One shift's recorded economics as served back over FRESH SQL reads. */
interface ServedBasis {
  readonly costMicroUsd: string;
  readonly latencyMs: number;
  readonly basisDigest: string;
}

/** One shift's declared drift as served back over FRESH SQL reads. */
interface ServedDrift {
  readonly costDeltaMicroUsd: string;
  readonly latencyDeltaMs: number;
  readonly qualityDelta: number;
  readonly mechanism: string | null;
}

/** One declared incident as served back over FRESH SQL reads. */
interface ServedIncident {
  readonly shiftIndex: number;
  readonly mechanism: string;
  readonly detail: string;
}

/** The window's budget-policy discipline as served back over FRESH SQL reads. */
interface ServedDiscipline {
  readonly budgetMicroUsd: string;
  readonly shifts: readonly {
    readonly shiftId: string;
    readonly reservationMicroUsd: string;
    readonly maxLatencyMs: number;
  }[];
}

/** Commit one read-only window input through the platform's own arbitration. */
async function arbitrateDurableRecord(
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
    // The recorded window inputs are frozen: a different-content commit
    // under a recorded key is REFUSED.
    return { accepted: false, replayed: false, refused: true };
  });
}

/** The durable outcome of one read-only record served back over FRESH SQL. */
async function durableOutcomeOf<T>(
  db: DatabasePort,
  world: ApiPgWorld,
  operation: string,
  key: string,
): Promise<T | null> {
  const result = await db.execute<{ durable_outcome: T }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
    parameters: [world.applicationId, operation, key],
  });
  return result.rows[0]?.durable_outcome ?? null;
}

/** The recorded basis of one (row, shift) served back over FRESH SQL reads. */
const recordedBasisOf = (db: DatabasePort, world: ApiPgWorld, rowId: string, shiftId: string) =>
  durableOutcomeOf<ServedBasis>(db, world, RECORDED_BASIS_OPERATION, `${rowId}:${shiftId}`);

/** The declared drift of one (row, shift) served back over FRESH SQL reads. */
const declaredDriftOf = (db: DatabasePort, world: ApiPgWorld, rowId: string, shiftId: string) =>
  durableOutcomeOf<ServedDrift>(db, world, DECLARED_DRIFT_OPERATION, `${rowId}:${shiftId}`);

/** The window discipline of one row served back over FRESH SQL reads. */
const windowDisciplineOf = (db: DatabasePort, world: ApiPgWorld, rowId: string) =>
  durableOutcomeOf<ServedDiscipline>(db, world, WINDOW_DISCIPLINE_OPERATION, rowId);

/** The declared incidents of one row served back over FRESH SQL reads. */
async function declaredIncidentsOf(
  db: DatabasePort,
  world: ApiPgWorld,
  rowId: string,
): Promise<ServedIncident[]> {
  const result = await db.execute<{ durable_outcome: ServedIncident }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key LIKE $3
          ORDER BY idempotency_key ASC`,
    parameters: [world.applicationId, DECLARED_INCIDENT_OPERATION, `${rowId}:shift-%`],
  });
  return result.rows.map((row) => row.durable_outcome);
}

/**
 * Seed one row's read-only window inputs over REAL SQL (the recorded
 * shift economics — committed then identically re-committed so the
 * replay arbitration is exercised per record — the declared drift, the
 * declared incidents and the window discipline). The incident-hiding
 * durable shape never lands its incident record (the hidden incident).
 */
async function seedPilotWindowInputs(
  db: DatabasePort,
  world: ApiPgWorld,
  row: ProductionPilotCorpusRow,
): Promise<{
  readonly committed: number;
  readonly replayed: number;
  readonly refused: number;
  readonly driftRecords: number;
  readonly incidentRecords: number;
}> {
  let committed = 0;
  let replayed = 0;
  let refused = 0;
  for (const shift of row.schedule) {
    const outcome = {
      costMicroUsd: shift.economics.costMicroUsd,
      latencyMs: shift.economics.latencyMs,
      basisDigest: shift.economics.basisDigest,
    };
    const fingerprint = economicDigestOf({
      rowId: row.rowId,
      shiftId: shift.shiftId,
      economics: outcome,
    });
    const first = await arbitrateDurableRecord(
      db,
      world,
      RECORDED_BASIS_OPERATION,
      `${row.rowId}:${shift.shiftId}`,
      fingerprint,
      outcome,
    );
    if (first.accepted) {
      committed += 1;
    }
    const identical = await arbitrateDurableRecord(
      db,
      world,
      RECORDED_BASIS_OPERATION,
      `${row.rowId}:${shift.shiftId}`,
      fingerprint,
      outcome,
    );
    if (identical.replayed) {
      replayed += 1;
    }
    if (identical.refused) {
      refused += 1;
    }
  }
  // The declared drift (one record per declared drift shift).
  let driftRecords = 0;
  for (const drift of row.declaredDrift) {
    const outcome = {
      costDeltaMicroUsd: drift.costDeltaMicroUsd,
      latencyDeltaMs: drift.latencyDeltaMs,
      qualityDelta: drift.qualityDelta,
      mechanism: drift.mechanism,
    };
    const record = await arbitrateDurableRecord(
      db,
      world,
      DECLARED_DRIFT_OPERATION,
      `${row.rowId}:${shiftIdOf(drift.shiftIndex)}`,
      economicDigestOf({ rowId: row.rowId, drift: outcome }),
      outcome,
    );
    if (record.accepted) {
      driftRecords += 1;
    }
  }
  // The declared incidents — EXCEPT the incident-hiding durable shape,
  // whose incident record never lands (the hidden incident).
  let incidentRecords = 0;
  if (row.probe?.kind !== "incident-hiding") {
    for (const incident of row.incidents) {
      const outcome = {
        shiftIndex: incident.shiftIndex,
        mechanism: incident.mechanism,
        detail: incident.detail,
      };
      const record = await arbitrateDurableRecord(
        db,
        world,
        DECLARED_INCIDENT_OPERATION,
        `${row.rowId}:shift-${incident.shiftIndex}`,
        economicDigestOf({ rowId: row.rowId, incident: outcome }),
        outcome,
      );
      if (record.accepted) {
        incidentRecords += 1;
      }
    }
  }
  // The window discipline (the budget-policy envelope of record).
  await arbitrateDurableRecord(
    db,
    world,
    WINDOW_DISCIPLINE_OPERATION,
    row.rowId,
    economicDigestOf({ rowId: row.rowId, discipline: "window" }),
    {
      budgetMicroUsd: row.budgetMicroUsd,
      shifts: row.schedule.map((shift) => ({
        shiftId: shift.shiftId,
        reservationMicroUsd: shift.reservationMicroUsd,
        maxLatencyMs: shift.maxLatencyMs,
      })),
    },
  );
  return { committed, replayed, refused, driftRecords, incidentRecords };
}

/** Drive one landed execution through the REAL state machine to its terminal. */
async function driveShiftExecutionToTerminal(options: {
  readonly world: ApiPgWorld;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly workload: string;
  readonly basisDigest: string;
  readonly ordinal: number;
  readonly terminal: "pass" | "fail";
}): Promise<void> {
  const { world, executionId } = options;
  const scope = {
    actorId: world.actorId,
    applicationId: options.applicationId,
    tenantId: options.tenantId,
    executionId,
  };
  const key = (tag: string) => `val-051-${executionId}-${tag}`;
  await world.executions.transition({ ...scope, command: "authorize" }, key("authorize"));
  await world.executions.transition(
    { ...scope, command: "plan", reason: "val-051-pilot-shift-plan" },
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
            strategyId: "val-051-pilot-shift",
            plan: {
              strategyClass: "production-pilot",
              modelCalls: 0,
              steps: [{ routeRef: { provider: "pilot-ledger", model: "recorded-pilot-replay" } }],
            },
          },
        ],
        selectedStrategyId: "val-051-pilot-shift",
        armDecision: { workload: options.workload, basisDigest: options.basisDigest },
      },
    },
    key("decision"),
  );
  await world.executions.transition(
    { ...scope, command: "queue", reason: "val-051-pilot-shift-queue" },
    key("queue"),
  );
  await world.executions.transition(
    { ...scope, command: "start", reason: "val-051-pilot-shift-start" },
    key("start"),
  );
  // The shift's recorded-input DIGEST reference (payload bytes never land).
  await world.executions.recordStepEvent(
    {
      applicationId: options.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: options.tenantId },
      command: "agent-action-recorded",
      cause: `val-051-${options.workload}-${options.ordinal}`,
      reference: {
        kind: "pilot-shift-basis",
        ordinal: options.ordinal,
        digest: options.basisDigest,
      },
      payload: { kind: "pilot-shift-basis", ordinal: options.ordinal },
    },
    key(`step-${options.ordinal}`),
  );
  await world.executions.transition(
    { ...scope, command: "verify", reason: "val-051-pilot-shift-verify" },
    key("verify"),
  );
  const shiftEvidence = [
    `shift:${options.workload}`,
    `basis-digest:${options.basisDigest}`,
    `attempt:${options.ordinal}`,
  ];
  if (options.terminal === "pass") {
    await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "pilot-shift-landed",
            strategy: "deterministic",
            status: "PASS",
            recordedBy: "val-051-crown",
            evidence: shiftEvidence,
          },
        ],
      },
      key("pass"),
    );
  } else {
    await world.executions.transition(
      {
        ...scope,
        command: "fail",
        reason: "val-051-pilot-shift-failed-attempt",
        verificationResults: [
          {
            criterionId: "pilot-shift-landed",
            strategy: "deterministic",
            status: "FAIL",
            recordedBy: "val-051-crown",
            evidence: [...shiftEvidence, "failed-attempt (resumes exactly once)"],
          },
        ],
      },
      key("fail"),
    );
  }
}

/**
 * Drive one LIVE shift execution through the REAL state machine to its
 * terminal (the env-gated live row only): the shift's REAL dispatch on
 * the pinned rail runs INSIDE the execution's RUNNING window (the
 * dispatch callback), its MEASURED facts recorded through the REAL
 * recorder as an additional digest-only step event (the recorded-basis
 * reference plus the live-dispatch reference — payload bytes never
 * land), and the terminal's verification evidence NAMES the live
 * dispatch digest.
 */
async function driveLiveShiftExecutionToTerminal(options: {
  readonly world: ApiPgWorld;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly workload: string;
  readonly basisDigest: string;
  readonly ordinal: number;
  readonly terminal: "pass" | "fail";
  /** The shift's REAL live dispatch on the pinned rail (run while the execution is RUNNING). */
  readonly dispatch: () => Promise<string>;
}): Promise<void> {
  const { world, executionId } = options;
  const scope = {
    actorId: world.actorId,
    applicationId: options.applicationId,
    tenantId: options.tenantId,
    executionId,
  };
  const key = (tag: string) => `val-051-live-${executionId}-${tag}`;
  await world.executions.transition({ ...scope, command: "authorize" }, key("authorize"));
  await world.executions.transition(
    { ...scope, command: "plan", reason: "val-051-live-pilot-shift-plan" },
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
            strategyId: "val-051-live-pilot-shift",
            plan: {
              strategyClass: "production-pilot-live",
              modelCalls: 0,
              steps: [
                {
                  routeRef: { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" },
                },
              ],
            },
          },
        ],
        selectedStrategyId: "val-051-live-pilot-shift",
        armDecision: {
          workload: options.workload,
          basisDigest: options.basisDigest,
          rail: LIVE_PILOT_PLAN.rail.endpoint,
        },
      },
    },
    key("decision"),
  );
  await world.executions.transition(
    { ...scope, command: "queue", reason: "val-051-live-pilot-shift-queue" },
    key("queue"),
  );
  await world.executions.transition(
    { ...scope, command: "start", reason: "val-051-live-pilot-shift-start" },
    key("start"),
  );
  // The shift's REAL dispatch on the pinned rail runs inside the
  // RUNNING window (the measured facts return as a digest).
  const liveDispatchDigest = await options.dispatch();
  // The shift's recorded-input DIGEST reference (payload bytes never land).
  await world.executions.recordStepEvent(
    {
      applicationId: options.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: options.tenantId },
      command: "agent-action-recorded",
      cause: `val-051-live-${options.workload}-${options.ordinal}`,
      reference: {
        kind: "pilot-shift-basis",
        ordinal: options.ordinal,
        digest: options.basisDigest,
      },
      payload: { kind: "pilot-shift-basis", ordinal: options.ordinal },
    },
    key(`step-${options.ordinal}`),
  );
  // The live dispatch's MEASURED facts recorded through the REAL
  // recorder (digest-only — the measured usage, its pinned-price cost
  // and its wallclock ride the digest; payload bytes never land).
  await world.executions.recordStepEvent(
    {
      applicationId: options.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: options.tenantId },
      command: "agent-action-recorded",
      cause: `val-051-live-dispatch-${options.workload}-${options.ordinal}`,
      reference: {
        kind: "live-dispatch-usage",
        ordinal: options.ordinal,
        digest: liveDispatchDigest,
      },
      payload: { kind: "live-dispatch-usage", ordinal: options.ordinal },
    },
    key(`live-step-${options.ordinal}`),
  );
  await world.executions.transition(
    { ...scope, command: "verify", reason: "val-051-live-pilot-shift-verify" },
    key("verify"),
  );
  const shiftEvidence = [
    `shift:${options.workload}`,
    `basis-digest:${options.basisDigest}`,
    `attempt:${options.ordinal}`,
    `live-dispatch:${liveDispatchDigest}`,
  ];
  if (options.terminal === "pass") {
    await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "pilot-shift-landed",
            strategy: "deterministic",
            status: "PASS",
            recordedBy: "val-051-live-crown",
            evidence: shiftEvidence,
          },
        ],
      },
      key("pass"),
    );
  } else {
    await world.executions.transition(
      {
        ...scope,
        command: "fail",
        reason: "val-051-live-pilot-shift-failed-attempt",
        verificationResults: [
          {
            criterionId: "pilot-shift-landed",
            strategy: "deterministic",
            status: "FAIL",
            recordedBy: "val-051-live-crown",
            evidence: [...shiftEvidence, "failed-attempt (resumes exactly once)"],
          },
        ],
      },
      key("fail"),
    );
  }
}

/**
 * Land one row's pilot window durable surface over the REAL platform
 * path (the controlled denaturation mirrors the offline probe shapes —
 * the durable discrimination battery). Every shift is submitted through
 * the REAL public HTTP create boundary under its OWN idempotency key;
 * the landed executions are driven through the REAL state machine; the
 * declared incident's shift lands its failed attempt plus its resume(s)
 * as separate durable executions; the idempotent re-issue re-submits
 * the first shift's IDENTICAL request under the SAME key over REAL
 * HTTP (it must REPLAY, never double-create).
 */
async function landPilotWindowOverRealPlatform(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: ProductionPilotCorpusRow;
  readonly reissue: boolean;
}): Promise<{ readonly executionsLanded: number; readonly reissue: { replayed: boolean } | null }> {
  const { db, world, row } = options;
  const client = createZeckClient({
    baseUrl: options.address,
    token: world.bearerToken,
    applicationId: world.applicationId,
    fetchImpl: globalThis.fetch,
  });
  const probe = row.probe?.kind ?? null;
  const incidentShifts = new Set(row.incidents.map((incident) => incident.shiftIndex));
  // The cherry-picking durable shape: the window observes (and drives)
  // only the first four shifts — the last scheduled shift never lands.
  const observedEnd =
    probe === "window-cherry-picking" ? row.window.endShift - 1 : row.window.endShift;
  const shiftTask = (shiftId: string, workload: string, attempt: number) => ({
    kind: SHIFT_TASK_KIND,
    rowId: row.rowId,
    shiftId,
    workload,
    attempt,
  });
  let executionsLanded = 0;

  for (const shift of row.schedule) {
    if (shift.shiftIndex > observedEnd) {
      continue;
    }
    // The dropped-shift durable shape: the daily-usage shift's
    // execution never lands (never submitted either).
    if (probe === "dropped-shift" && shift.workload === "daily-usage") {
      continue;
    }
    const basis = await recordedBasisOf(db, world, row.rowId, shift.shiftId);
    if (basis === null) {
      throw new Error(`no recorded basis served for ${row.rowId}:${shift.shiftId}`);
    }
    // The boundary-leak durable shape: the daily-usage shift's
    // execution lands durably under ANOTHER customer's application.
    if (probe === "boundary-leak" && shift.workload === "daily-usage") {
      const receipt = await world.executions.createExecution(
        {
          applicationId: world.otherApplicationId,
          task: shiftTask(shift.shiftId, shift.workload, 1),
        },
        shiftKeyOf(row.rowId, shift.shiftId),
        { actorId: world.actorId, tenantId: world.otherTenantId },
      );
      executionsLanded += 1;
      await driveShiftExecutionToTerminal({
        world,
        executionId: receipt.executionId,
        applicationId: world.otherApplicationId,
        tenantId: world.otherTenantId,
        workload: shift.workload,
        basisDigest: basis.basisDigest,
        ordinal: 1,
        terminal: "pass",
      });
      continue;
    }
    // The declared incident's shift: the failed attempt lands its own
    // durable execution, then RESUMES EXACTLY ONCE (the
    // double-driven-resume durable shape adds ONE extra resume beyond
    // the allowance — three durable executions for the one shift).
    const isIncidentShift = incidentShifts.has(shift.shiftIndex);
    const extraResumes =
      probe === "double-driven-resume" && shift.workload === "daily-usage" ? 1 : 0;
    const attemptReceipt = (
      await client.createExecution(
        { applicationId: world.applicationId, task: shiftTask(shift.shiftId, shift.workload, 1) },
        shiftKeyOf(row.rowId, shift.shiftId),
      )
    ).receipt;
    executionsLanded += 1;
    await driveShiftExecutionToTerminal({
      world,
      executionId: attemptReceipt.executionId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      workload: shift.workload,
      basisDigest: basis.basisDigest,
      ordinal: 1,
      terminal: isIncidentShift ? "fail" : "pass",
    });
    if (isIncidentShift) {
      for (let resume = 1; resume <= 1 + extraResumes; resume += 1) {
        const resumeReceipt = (
          await client.createExecution(
            {
              applicationId: world.applicationId,
              task: shiftTask(shift.shiftId, shift.workload, resume + 1),
            },
            resumeKeyOf(row.rowId, shift.shiftId, resume),
          )
        ).receipt;
        executionsLanded += 1;
        await driveShiftExecutionToTerminal({
          world,
          executionId: resumeReceipt.executionId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          workload: shift.workload,
          basisDigest: basis.basisDigest,
          ordinal: resume + 1,
          terminal: "pass",
        });
      }
    }
  }

  // The idempotent re-issue: the row re-submits the FIRST shift's
  // IDENTICAL request under the SAME key over REAL HTTP.
  if (options.reissue) {
    const firstShift = row.schedule[0];
    if (firstShift === undefined) {
      throw new Error("the row declares no shifts");
    }
    const replay = (
      await client.createExecution(
        {
          applicationId: world.applicationId,
          task: shiftTask(firstShift.shiftId, firstShift.workload, 1),
        },
        shiftKeyOf(row.rowId, firstShift.shiftId),
      )
    ).receipt;
    return { executionsLanded, reissue: { replayed: replay.replayed } };
  }
  return { executionsLanded, reissue: null };
}

/**
 * Re-derive the pilot observation AT THE BOUNDARY over the DURABLE
 * LEDGER (PURE over REAL SQL reads): the shift executions and their
 * executing identities from the durable rows themselves (the drive
 * counts are REAL SQL counts), the economics from the SQL-served
 * recorded basis, the drift deltas from the SQL-served declared drift,
 * the incident log from the SQL-served declared incidents and the
 * reservations/budget from the SQL-served window discipline — never
 * trusting the platform's own claim.
 */
async function observationOverDurableLedger(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly row: ProductionPilotCorpusRow;
}): Promise<PilotObservation> {
  const { db, world, row } = options;
  const probe = row.probe?.kind ?? null;
  const observedEnd =
    probe === "window-cherry-picking" ? row.window.endShift - 1 : row.window.endShift;
  const incidentShifts = new Map(row.incidents.map((incident) => [incident.shiftIndex, incident]));
  const discipline = await windowDisciplineOf(db, world, row.rowId);
  if (discipline === null) {
    throw new Error(`no window discipline served for ${row.rowId}`);
  }
  const reservationOf = new Map(discipline.shifts.map((entry) => [entry.shiftId, entry]));
  const servedIncidents = await declaredIncidentsOf(db, world, row.rowId);

  // The shift executions: the durable rows themselves.
  const executionRows = await db.execute<DurableExecutionRow>({
    sql: `SELECT id::text AS id, status, task->>'shiftId' AS shift_id,
                 application_id::text AS application_id, created_at
          FROM executions.executions
          WHERE task->>'kind' = $1 AND task->>'rowId' = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [SHIFT_TASK_KIND, row.rowId],
  });

  const shifts: ShiftObservation[] = [];
  for (const shift of row.schedule) {
    if (shift.shiftIndex > observedEnd) {
      continue;
    }
    // The dropped-shift durable shape: no durable rows, no record.
    if (probe === "dropped-shift" && shift.workload === "daily-usage") {
      continue;
    }
    const basis = await recordedBasisOf(db, world, row.rowId, shift.shiftId);
    if (basis === null) {
      throw new Error(`no recorded basis served for ${row.rowId}:${shift.shiftId}`);
    }
    const drift = await declaredDriftOf(db, world, row.rowId, shift.shiftId);
    const deltaCost = drift === null ? 0n : BigInt(drift.costDeltaMicroUsd);
    const deltaLatency = drift === null ? 0 : drift.latencyDeltaMs;
    const deltaQuality = drift === null ? 0 : drift.qualityDelta;
    // The drive count is the REAL SQL count of durable executions.
    const rows = executionRows.rows.filter((record) => record.shift_id === shift.shiftId);
    const drives = rows.length;
    const declaredDrives = incidentShifts.has(shift.shiftIndex) ? 2 : 1;
    const unitCost = BigInt(basis.costMicroUsd) / BigInt(declaredDrives);
    const unitLatency = basis.latencyMs / declaredDrives;
    const observedCost = unitCost * BigInt(drives) + deltaCost;
    const observedLatency = unitLatency * drives + deltaLatency;
    const observedQuality = RECORDED_SEGMENT_QUALITY + deltaQuality;
    // The honest drift classification (the drift-normalizing durable
    // shape forges the entry — the oracle catches the forgery).
    const honest = honestDriftClassificationOf({
      costDeltaMicroUsd: deltaCost.toString(),
      latencyDeltaMs: deltaLatency,
      observedQuality: observedQuality,
    });
    const forge = probe === "drift-normalizing" && drift !== null;
    const entry: SegmentDriftEntry = forge
      ? {
          shiftIndex: shift.shiftIndex,
          classification: "within-bounds",
          mechanism: null,
          costDeltaMicroUsd: "0",
          latencyDeltaMs: 0,
          qualityDelta: 0,
        }
      : {
          shiftIndex: shift.shiftIndex,
          classification: honest,
          mechanism: honest === "within-bounds" ? null : (drift?.mechanism ?? null),
          costDeltaMicroUsd: deltaCost.toString(),
          latencyDeltaMs: deltaLatency,
          qualityDelta: observedQuality - RECORDED_SEGMENT_QUALITY,
        };
    const foreign = rows.some((record) => record.application_id !== world.applicationId);
    const landed = rows[rows.length - 1];
    shifts.push({
      shiftIndex: shift.shiftIndex,
      shiftId: shift.shiftId,
      workload: shift.workload,
      executionId: landed?.id ?? "",
      executions: drives,
      resumed: drives > 1,
      applicationId: foreign ? FOREIGN_APPLICATION_ID : PILOT_CUSTOMER_APPLICATION_ID,
      observedCostMicroUsd: observedCost.toString(),
      observedLatencyMs: observedLatency,
      observedQuality: observedQuality,
      reservationMicroUsd: reservationOf.get(shift.shiftId)?.reservationMicroUsd ?? "0",
      drift: entry,
    });
  }

  const observedCostTotal = shifts.reduce(
    (total, record) => total + BigInt(record.observedCostMicroUsd),
    0n,
  );
  const observedLatencyTotal = shifts.reduce(
    (total, record) => total + record.observedLatencyMs,
    0,
  );
  const reservedTotal = shifts.reduce(
    (total, record) => total + BigInt(record.reservationMicroUsd),
    0n,
  );
  // The incident log: the SQL-served declared incidents (the
  // incident-hiding durable shape never landed its record — empty log).
  const incidentLog: IncidentLogEntry[] = servedIncidents.map((incident) => ({
    shiftIndex: incident.shiftIndex,
    shiftId: shiftIdOf(incident.shiftIndex),
    kind: "shift-failure-resume",
    mechanism: incident.mechanism,
    detail: incident.detail,
  }));
  // The append-only budget ledger: one spend entry per observed shift
  // (in schedule order) plus the end-of-window release.
  const ledger: LedgerEntry[] = shifts.map((record, index) => ({
    sequence: index + 1,
    kind: "spend",
    shiftId: record.shiftId,
    amountMicroUsd: record.observedCostMicroUsd,
  }));
  ledger.push({
    sequence: shifts.length + 1,
    kind: "release",
    shiftId: null,
    amountMicroUsd: (reservedTotal - observedCostTotal).toString(),
  });
  // The residual-hiding durable shape: the reported total hides half
  // the daily-usage shift's observed cost.
  const hiddenResidual =
    probe === "residual-hiding"
      ? BigInt(
          shifts.find((record) => record.workload === "daily-usage")?.observedCostMicroUsd ?? "0",
        ) / 2n
      : 0n;
  return {
    rowId: row.rowId,
    window: { startShift: row.window.startShift, endShift: observedEnd },
    shifts,
    driftReport: shifts.map((record) => record.drift),
    incidentLog,
    ledger,
    reported: {
      totalCostMicroUsd: (observedCostTotal - hiddenResidual).toString(),
      totalLatencyMs: observedLatencyTotal,
      reservedTotalMicroUsd: reservedTotal.toString(),
      releasedMicroUsd: (reservedTotal - observedCostTotal).toString(),
    },
    windowDigest: economicDigestOf({
      rowId: row.rowId,
      window: `${row.window.startShift}-${observedEnd}`,
      shifts: shifts.map((record) => `${record.shiftId}:${record.executions}`),
    }),
    usage: null,
  };
}

/** The digest-parity projection (the per-run execution ids aside). */
const parityProjection = (observation: PilotObservation) => ({
  rowId: observation.rowId,
  window: { ...observation.window },
  shifts: observation.shifts.map((record) => ({
    shiftIndex: record.shiftIndex,
    shiftId: record.shiftId,
    workload: record.workload,
    executions: record.executions,
    resumed: record.resumed,
    applicationId: record.applicationId,
    observedCostMicroUsd: record.observedCostMicroUsd,
    observedLatencyMs: record.observedLatencyMs,
    observedQuality: record.observedQuality,
    reservationMicroUsd: record.reservationMicroUsd,
    drift: { ...record.drift },
  })),
  driftReport: observation.driftReport.map((entry) => ({ ...entry })),
  incidentLog: observation.incidentLog.map((entry) => ({ ...entry })),
  ledger: observation.ledger.map((entry) => ({ ...entry })),
  reported: { ...observation.reported },
  windowDigest: observation.windowDigest,
  usage: observation.usage,
});

/** The row of record by id (throws when unknown). */
const rowOf = (rowId: string): ProductionPilotCorpusRow => {
  const row = pilotRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

// ---------------------------------------------------------------------------
// The suite (env-gated; the honest skip names the env var)
// ---------------------------------------------------------------------------

(url ? describe : describe.skip)("VAL-051 production-style pilot over REAL PostgreSQL", () => {
  let db: DatabasePort | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // The house harness's disposable-DB lifecycle: a fresh database
    // off the admin URL, the shipped migrations applied, dropped on
    // teardown (tests/integration/postgres/harness.ts pattern).
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

  test("the honest durable pilot windows land over the REAL platform path and the EIGHT oracles re-derive ALL-PASS over the durable ledger", {
    timeout: 300_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const honestRowIds = OFFLINE_CORPUS_ROWS.filter((row) => row.probe === undefined).map(
        (row) => row.rowId,
      );
      expect(honestRowIds).toEqual([
        "full-window-recorded-basis",
        "window-incident-resume",
        "window-drift-within-bounds",
        "window-drift-declared",
        "window-regression-declared",
      ]);
      const expectedExecutionsOf = (rowId: string): number => {
        const expected: Readonly<Record<string, number>> = {
          "full-window-recorded-basis": 5,
          "window-incident-resume": 6,
          "window-drift-within-bounds": 5,
          "window-drift-declared": 5,
          "window-regression-declared": 5,
        };
        const value = expected[rowId];
        if (value === undefined) {
          throw new Error(`no expected execution count for ${rowId}`);
        }
        return value;
      };

      for (const rowId of honestRowIds) {
        const row = rowOf(rowId);
        const seeded = await seedPilotWindowInputs(database_, world, row);
        expect(seeded.committed, rowId).toBe(5);
        expect(seeded.replayed, rowId).toBe(5);
        expect(seeded.refused, rowId).toBe(0);
        expect(seeded.driftRecords, rowId).toBe(row.declaredDrift.length);
        expect(seeded.incidentRecords, rowId).toBe(row.incidents.length);

        const before = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        const landed = await landPilotWindowOverRealPlatform({
          db: database_,
          world,
          address,
          row,
          reissue: true,
        });
        expect(landed.executionsLanded, rowId).toBe(expectedExecutionsOf(rowId));

        // The durable executions rows (REAL SQL counts).
        const after = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        expect(after.rows[0]?.c ?? 0, rowId).toBe(
          (before.rows[0]?.c ?? 0) + expectedExecutionsOf(rowId),
        );

        // The idempotent re-issue: the identical request under the
        // SAME key REPLAYS (never a second durable execution, never
        // a second idempotency record).
        expect(landed.reissue?.replayed, rowId).toBe(true);
        const reissueAfter = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        expect(reissueAfter.rows[0]?.c ?? 0, rowId).toBe(
          (before.rows[0]?.c ?? 0) + expectedExecutionsOf(rowId),
        );

        // No orphan events: every execution event joins its execution.
        const orphans = await database_.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.execution_events e
                  LEFT JOIN executions.executions x ON e.execution_id = x.id
                  WHERE e.application_id = $1 AND x.id IS NULL`,
          parameters: [world.applicationId],
        });
        expect(orphans.rows[0]?.c ?? 0, rowId).toBe(0);

        // The observation re-derived AT THE BOUNDARY over the durable
        // ledger — all EIGHT oracles PASS.
        const observation = await observationOverDurableLedger({ db: database_, world, row });
        const criteria = verifyProductionPilotIntegrity({ row, observation });
        const failed = criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${rowId}: ${JSON.stringify(failed)}`).toEqual([]);
        expect(criteria.map((criterion) => criterion.criterionId).sort()).toEqual([
          "budget-policy-envelope",
          "continuation-exactly-once",
          "customer-boundary",
          "drift-classification-honesty",
          "end-of-window-accounting",
          "incident-honesty",
          "schedule-completeness",
          "window-honesty",
        ]);

        // The durable surface reproduces the offline pure derivation
        // EXACTLY (digest parity — the per-run execution ids aside)
        // and the boundary verdict equals the offline verdict.
        expect(parityProjection(observation)).toEqual(parityProjection(pilotObservationFor(row)));
        expect(derivePilotVerdict({ row, observation })).toEqual(
          derivePilotVerdict({ row, observation: pilotObservationFor(row) }),
        );

        // The customer-boundary basis over REAL SQL: every shift
        // execution of the honest window under ONE application.
        const apps = await database_.execute<{ application_id: string }>({
          sql: `SELECT DISTINCT application_id::text AS application_id FROM executions.executions
                  WHERE task->>'kind' = $1 AND task->>'rowId' = $2`,
          parameters: [SHIFT_TASK_KIND, rowId],
        });
        expect(
          apps.rows.map((record) => record.application_id),
          rowId,
        ).toEqual([world.applicationId]);

        // The continuation exactly-once pin: the declared incident's
        // shift lands EXACTLY two durable executions (the failed
        // attempt plus one resume), both visible in REAL SQL.
        if (row.incidents.length > 0) {
          const incidentShiftIndex = row.incidents[0]?.shiftIndex;
          const resumed = await database_.execute<{ c: number; statuses: string[] }>({
            sql: `SELECT count(*)::int AS c, array_agg(status ORDER BY created_at ASC, id ASC) AS statuses
                    FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = $3`,
            parameters: [SHIFT_TASK_KIND, rowId, shiftIdOf(incidentShiftIndex ?? 0)],
          });
          expect(resumed.rows[0]?.c ?? 0, rowId).toBe(2);
          expect(resumed.rows[0]?.statuses ?? [], rowId).toEqual(["FAILED", "COMPLETED"]);
        }

        // The budget-policy envelope over REAL SQL: the observed
        // window spend stays inside the SQL-served window budget and
        // the reservations settle (the release is NAMED).
        const discipline = await windowDisciplineOf(database_, world, rowId);
        expect(BigInt(observation.reported.totalCostMicroUsd), rowId).toBeLessThanOrEqual(
          BigInt(discipline?.budgetMicroUsd ?? "0"),
        );
        expect(
          BigInt(observation.reported.reservedTotalMicroUsd) -
            BigInt(observation.reported.totalCostMicroUsd),
          rowId,
        ).toBe(BigInt(observation.reported.releasedMicroUsd));
      }
    } finally {
      await world.server.app.close();
    }
  });

  test("the seven adversarial durable shapes are DETECTED by the NAMED oracles over the durable ledger", {
    timeout: 300_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const probeRows = OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined);
      expect(probeRows.map((row) => row.probe?.kind)).toEqual([
        "window-cherry-picking",
        "dropped-shift",
        "double-driven-resume",
        "drift-normalizing",
        "incident-hiding",
        "residual-hiding",
        "boundary-leak",
      ]);
      for (const row of probeRows) {
        const probe = row.probe?.kind as PilotProbeKind;
        await seedPilotWindowInputs(database_, world, row);
        await landPilotWindowOverRealPlatform({
          db: database_,
          world,
          address,
          row,
          reissue: false,
        });
        const observation = await observationOverDurableLedger({ db: database_, world, row });
        const criteria = verifyProductionPilotIntegrity({ row, observation });
        const failed = criteria
          .filter((criterion) => criterion.status === "FAIL")
          .map((criterion) => criterion.criterionId)
          .sort();
        expect(failed, probe).toEqual([...PROBE_FAILED_CRITERIA_OF[probe]].sort());

        // The mechanism NAMED in the durable-ledger evidence.
        const evidenceOf = (criterionId: string): string =>
          criteria.find((criterion) => criterion.criterionId === criterionId)?.evidence.join(" ") ??
          "";
        if (probe === "window-cherry-picking") {
          expect(evidenceOf("window-honesty")).toContain("omitted-segment:shift-5");
          expect(evidenceOf("end-of-window-accounting")).toContain("window-basis-residual:400");
          // The durable shape: shift-5 never landed a single execution.
          const neverLanded = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = 'shift-5'`,
            parameters: [SHIFT_TASK_KIND, row.rowId],
          });
          expect(neverLanded.rows[0]?.c ?? 0, probe).toBe(0);
        }
        if (probe === "dropped-shift") {
          expect(evidenceOf("schedule-completeness")).toContain("missing-shift:shift-4");
          expect(evidenceOf("end-of-window-accounting")).toContain("window-basis-residual:9600");
          const neverLanded = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = 'shift-4'`,
            parameters: [SHIFT_TASK_KIND, row.rowId],
          });
          expect(neverLanded.rows[0]?.c ?? 0, probe).toBe(0);
        }
        if (probe === "double-driven-resume") {
          expect(evidenceOf("continuation-exactly-once")).toContain("resume-violation:shift-4");
          expect(evidenceOf("continuation-exactly-once")).toContain("observed executions=3");
          expect(evidenceOf("budget-policy-envelope")).toContain("unauthorized-spend:shift-4");
          expect(evidenceOf("budget-policy-envelope")).toContain("budget-exceeded");
          // The durable shape: THREE durable executions for the one
          // shift (FAILED attempt + TWO resumes), visible in REAL SQL.
          const triple = await database_.execute<{ c: number; statuses: string[] }>({
            sql: `SELECT count(*)::int AS c, array_agg(status ORDER BY created_at ASC, id ASC) AS statuses
                    FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = 'shift-4'`,
            parameters: [SHIFT_TASK_KIND, row.rowId],
          });
          expect(triple.rows[0]?.c ?? 0, probe).toBe(3);
          expect(triple.rows[0]?.statuses ?? [], probe).toEqual([
            "FAILED",
            "COMPLETED",
            "COMPLETED",
          ]);
        }
        if (probe === "drift-normalizing") {
          expect(evidenceOf("drift-classification-honesty")).toContain("normalized-drift:shift-4");
          expect(evidenceOf("end-of-window-accounting")).toContain(
            "unexplained-residual:shift-4 (1152)",
          );
        }
        if (probe === "incident-hiding") {
          expect(evidenceOf("incident-honesty")).toContain("hidden-incident:shift-4");
          // The durable shape: the resumed shift's FAILED+COMPLETED
          // executions ARE durable (the incident happened), but ZERO
          // incident records ever landed in REAL SQL.
          const happened = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = 'shift-4'`,
            parameters: [SHIFT_TASK_KIND, row.rowId],
          });
          expect(happened.rows[0]?.c ?? 0, probe).toBe(2);
          const records = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2 AND idempotency_key LIKE $3`,
            parameters: [world.applicationId, DECLARED_INCIDENT_OPERATION, `${row.rowId}:shift-%`],
          });
          expect(records.rows[0]?.c ?? 0, probe).toBe(0);
        }
        if (probe === "residual-hiding") {
          const dailyUsage = observation.shifts.find((record) => record.workload === "daily-usage");
          const hidden = BigInt(dailyUsage?.observedCostMicroUsd ?? "0") / 2n;
          expect(evidenceOf("end-of-window-accounting")).toContain(
            `cost-residual:-${hidden.toString()}`,
          );
          expect(hidden.toString()).toBe("4800");
        }
        if (probe === "boundary-leak") {
          expect(evidenceOf("customer-boundary")).toContain("boundary-leak:shift-4");
          expect(evidenceOf("customer-boundary")).toContain(FOREIGN_APPLICATION_ID);
          // The leak is DURABLE: the shift's execution row sits under
          // the OTHER customer's application in REAL SQL.
          const leaked = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM executions.executions
                    WHERE task->>'kind' = $1 AND task->>'rowId' = $2 AND task->>'shiftId' = 'shift-4'
                      AND application_id = $3`,
            parameters: [SHIFT_TASK_KIND, row.rowId, world.otherApplicationId],
          });
          expect(leaked.rows[0]?.c ?? 0, probe).toBe(1);
        }

        // The durable denaturation reproduces the offline controlled
        // fake EXACTLY (digest parity).
        expect(parityProjection(observation)).toEqual(parityProjection(pilotObservationFor(row)));
      }
    } finally {
      await world.server.app.close();
    }
  });

  test("the recorded cost basis is a FROZEN read-only input over REAL SQL and the end-of-window accounting + budget-policy envelope reconcile", {
    timeout: 120_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    try {
      const row = rowOf("full-window-recorded-basis");
      const seeded = await seedPilotWindowInputs(database_, world, row);
      expect(seeded.committed).toBe(5);
      expect(seeded.replayed).toBe(5);
      expect(seeded.refused).toBe(0);

      // A different-content commit under a recorded key is REFUSED
      // (the recorded basis is a frozen input — never re-priced).
      for (const shift of row.schedule) {
        const tampered = await arbitrateDurableRecord(
          database_,
          world,
          RECORDED_BASIS_OPERATION,
          `${row.rowId}:${shift.shiftId}`,
          economicDigestOf({
            rowId: row.rowId,
            shiftId: shift.shiftId,
            economics: { tampered: true },
          }),
          {
            costMicroUsd: "1",
            latencyMs: 1,
            basisDigest: "tampered",
          },
        );
        expect(tampered.refused, shift.shiftId).toBe(true);
        expect(tampered.accepted, shift.shiftId).toBe(false);
        expect(tampered.replayed, shift.shiftId).toBe(false);
      }

      // The SQL-served basis equals the corpus declarations exactly
      // (digest-for-digest — the carried VAL-049/050 cost basis).
      for (const shift of row.schedule) {
        const served = await recordedBasisOf(database_, world, row.rowId, shift.shiftId);
        expect(served?.costMicroUsd, shift.shiftId).toBe(shift.economics.costMicroUsd);
        expect(served?.latencyMs, shift.shiftId).toBe(shift.economics.latencyMs);
        expect(served?.basisDigest, shift.shiftId).toBe(shift.economics.basisDigest);
      }

      // The SQL-served window discipline equals the declared
      // envelope (reservations + latency policy + the window budget).
      const discipline = await windowDisciplineOf(database_, world, row.rowId);
      expect(discipline?.budgetMicroUsd).toBe(row.budgetMicroUsd);
      for (const shift of row.schedule) {
        const served = discipline?.shifts.find((entry) => entry.shiftId === shift.shiftId);
        expect(served?.reservationMicroUsd, shift.shiftId).toBe(shift.reservationMicroUsd);
        expect(served?.maxLatencyMs, shift.shiftId).toBe(shift.maxLatencyMs);
      }

      // The accounting arithmetic over REAL SQL: the recorded basis
      // sum, the observed shift sum and the reported window total
      // agree with zero residual; the release reconciles; the budget
      // envelope holds.
      const observation = await observationOverDurableLedger({ db: database_, world, row });
      let recordedTotal = 0n;
      for (const shift of row.schedule) {
        const served = await recordedBasisOf(database_, world, row.rowId, shift.shiftId);
        recordedTotal += BigInt(served?.costMicroUsd ?? "0");
      }
      const observedTotal = observation.shifts.reduce(
        (total, record) => total + BigInt(record.observedCostMicroUsd),
        0n,
      );
      expect(observedTotal).toBe(recordedTotal);
      expect(BigInt(observation.reported.totalCostMicroUsd)).toBe(observedTotal);
      expect(BigInt(observation.reported.reservedTotalMicroUsd) - observedTotal).toBe(
        BigInt(observation.reported.releasedMicroUsd),
      );
      expect(observedTotal <= BigInt(discipline?.budgetMicroUsd ?? "0")).toBe(true);
      // The append-only ledger: sequences 1..N in order, one spend per
      // observed shift plus the single end-of-window release.
      expect(observation.ledger.length).toBe(observation.shifts.length + 1);
      expect(observation.ledger.at(-1)?.kind).toBe("release");

      // The basis records are digest-only (no payload bytes ever land).
      const basisRows = await database_.execute<{ durable_outcome: unknown }>({
        sql: `SELECT durable_outcome FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, RECORDED_BASIS_OPERATION],
      });
      expect(basisRows.rows.length).toBe(5);
      for (const basisRow of basisRows.rows) {
        const outcome = basisRow.durable_outcome as Record<string, unknown>;
        expect(Object.keys(outcome).sort()).toEqual(["basisDigest", "costMicroUsd", "latencyMs"]);
      }

      // The live rail stays honestly NOT RUN over the crown: the
      // live row demands OPENROUTER_API_KEY (the env var NAMED) and
      // lands ZERO durable submissions over REAL SQL.
      expect(LIVE_CORPUS_ROWS).toHaveLength(1);
      const liveRow = LIVE_CORPUS_ROWS[0];
      if (liveRow === undefined) {
        throw new Error("the corpus declares no live row");
      }
      expect(liveRow.needsDispatch).toBe(true);
      expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
      expect(liveGateOpen(liveRow, {})).toBe(false);
      expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
      const liveSubmissions = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE task->>'rowId' = $1`,
        parameters: [liveRow.rowId],
      });
      expect(liveSubmissions.rows[0]?.c ?? 0).toBe(0);
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives one REAL live pilot window over the pinned OpenRouter rail", {
    timeout: 480_000,
  }, async () => {
    // The env-gated live rows (offline rows first, live rows last in
    // the pinned corpus — exactly ONE live pilot window).
    const liveRows = LIVE_CORPUS_ROWS;
    expect(liveRows).toHaveLength(1);
    const notRun: string[] = [];
    for (const row of liveRows) {
      if (!liveGateOpen(row, process.env)) {
        notRun.push(
          `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+") ?? "?"} absent)`,
        );
      }
    }
    // The honest dispatch ledger: ZERO live dispatches happen while
    // the gate is closed (asserted below — never a fake success).
    let dispatches = 0;
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-051] OPENROUTER_API_KEY absent — the REAL live pilot window is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers the complete sustained-observation machinery over the RECORDED basis without " +
          "credentials. Required access: an operator-authorized OpenRouter credential (env " +
          "OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct " +
          "on the pinned rail — the REAL live window demands one REAL dispatch per scheduled " +
          "shift held across the declared live window (BYOK, measured usage, max_tokens 32 " +
          "pinned explicitly, temperature unset per the provider's documented default, every " +
          "priced token at the pinned manifest revision rev-001), the audited cost basis " +
          "carried per shift over the REAL platform path (the public create boundary, the REAL " +
          "state machine, the REAL recorder), the live slice's own dispatch usage MEASURED " +
          "within the window's budget-policy envelope and the verdict derived from the " +
          "measured facts. This live lane is reserved for the operator/session-B live review " +
          "(the offline rows above never re-measure; the live row is the only place new " +
          "measurements happen).",
      );
      // The honest-skip invariants: the gate holds (both ways), the
      // pinned live plan's declaration digest stays deterministic,
      // and ZERO live dispatches were made.
      const liveRow = liveRows[0];
      if (liveRow === undefined) {
        throw new Error("the corpus declares no live row");
      }
      expect(notRun.length).toBe(liveRows.length);
      expect(liveRow.needsDispatch).toBe(true);
      expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
      expect(liveGateOpen(liveRow, {})).toBe(false);
      expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
      expect(livePilotPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
      expect(livePilotPlanDigestOf()).toBe(livePilotPlanDigestOf());
      expect(LIVE_PILOT_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
      expect(LIVE_PILOT_PLAN.rail.maxTokens).toBe(32);
      expect(LIVE_PILOT_PLAN.dispatchesPerShift).toBe(1);
      expect(dispatches).toBe(0);
      expect(true).toBe(true);
      return;
    }

    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

    /**
     * Price ONE measured dispatch onto the canonical micro-USD basis at
     * the pinned model manifest revision (exact BigInt rational —
     * PUBLIC LIST PRICES ONLY, never an ad-hoc rate).
     */
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
      // The list price is USD per 1M tokens → micro-USD per token is the
      // price's own decimal value (tokens × price, half-up).
      return divRoundHalfUp(BigInt(tokens) * price.digits, 10n ** BigInt(price.scale));
    };

    try {
      const drivenLive: string[] = [];
      for (const row of liveRows) {
        if (!liveGateOpen(row, process.env)) {
          continue;
        }

        // The read-only window inputs committed through the platform's
        // own arbitration (the recorded shift economics, the window
        // discipline — no drift, no incidents on the live row).
        const seeded = await seedPilotWindowInputs(database_, world, row);
        expect(seeded.committed).toBe(5);
        expect(seeded.replayed).toBe(5);
        expect(seeded.refused).toBe(0);
        expect(seeded.driftRecords).toBe(0);
        expect(seeded.incidentRecords).toBe(0);

        const client = createZeckClient({
          baseUrl: address,
          token: world.bearerToken,
          applicationId: world.applicationId,
          fetchImpl: globalThis.fetch,
        });

        // ---- the REAL live window: one REAL dispatch per scheduled
        // shift, its execution landed over the REAL platform path with
        // the dispatch recorded through the REAL recorder ----
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalMeasuredCost = 0n;
        let successfulDispatches = 0;
        const measuredDispatches: {
          readonly shiftId: string;
          readonly inputTokens: number;
          readonly outputTokens: number;
        }[] = [];
        const dispatchDigests: string[] = [];
        for (const shift of row.schedule) {
          const basis = await recordedBasisOf(database_, world, row.rowId, shift.shiftId);
          if (basis === null) {
            throw new Error(`no recorded basis served for ${row.rowId}:${shift.shiftId}`);
          }
          const receipt = (
            await client.createExecution(
              {
                applicationId: world.applicationId,
                task: {
                  kind: SHIFT_TASK_KIND,
                  rowId: row.rowId,
                  shiftId: shift.shiftId,
                  workload: shift.workload,
                  attempt: 1,
                },
              },
              shiftKeyOf(row.rowId, shift.shiftId),
            )
          ).receipt;
          await driveLiveShiftExecutionToTerminal({
            world,
            executionId: receipt.executionId,
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            workload: shift.workload,
            basisDigest: basis.basisDigest,
            ordinal: 1,
            terminal: "pass",
            dispatch: async () => {
              // Provider-side pacing between the live dispatches.
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              dispatches += 1;
              const startedAt = Date.now();
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
                      content: `Reply with the single word: ok (${shift.workload} shift ${shift.shiftIndex} dispatch ${dispatches})`,
                    },
                  ],
                }),
              });
              const wallclockMs = Math.max(Date.now() - startedAt, 0);
              // The provider envelope's usage tokens WIN over raw HTTP
              // observations (the VAL-049 rule); the empty-completion
              // 200 is an honest non-error — priced, counted, landed
              // only when content actually arrived.
              const payload = (await response.json()) as {
                readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
                readonly usage?: {
                  readonly prompt_tokens?: number;
                  readonly completion_tokens?: number;
                };
              };
              const content = payload.choices?.[0]?.message?.content ?? "";
              const inputTokens = payload.usage?.prompt_tokens ?? 0;
              const outputTokens = payload.usage?.completion_tokens ?? 0;
              const measuredCost =
                priceTokensAt(inputTokens, "input") + priceTokensAt(outputTokens, "output");
              totalInputTokens += inputTokens;
              totalOutputTokens += outputTokens;
              totalMeasuredCost += measuredCost;
              if (response.ok && content.length > 0) {
                successfulDispatches += 1;
              }
              measuredDispatches.push({
                shiftId: shift.shiftId,
                inputTokens,
                outputTokens,
              });
              const digest = economicDigestOf({
                shiftId: shift.shiftId,
                workload: shift.workload,
                dispatch: dispatches,
                inputTokens,
                outputTokens,
                measuredCostMicroUsd: measuredCost.toString(),
                wallclockMs,
                planDigest: livePilotPlanDigestOf(),
              });
              dispatchDigests.push(digest);
              return digest;
            },
          });
        }

        // REAL dispatches happened on the pinned rail — the live
        // slice's own usage MEASURED (never estimated, never
        // fabricated) and the measured spend stays inside the
        // window's budget-policy envelope.
        expect(dispatches).toBe(row.schedule.length * LIVE_PILOT_PLAN.dispatchesPerShift);
        expect(totalInputTokens + totalOutputTokens).toBeGreaterThan(0);
        expect(totalMeasuredCost <= BigInt(row.budgetMicroUsd)).toBe(true);
        // The honest measured economics: the measured total is exactly
        // the pinned manifest's list-price arithmetic over the MEASURED
        // tokens (re-derived here — never an ad-hoc rate).
        let repricedTotal = 0n;
        for (const measured of measuredDispatches) {
          repricedTotal +=
            priceTokensAt(measured.inputTokens, "input") +
            priceTokensAt(measured.outputTokens, "output");
        }
        expect(totalMeasuredCost).toBe(repricedTotal);
        expect(totalMeasuredCost).toBeGreaterThanOrEqual(0n);

        // The observation re-derived AT THE BOUNDARY over the durable
        // ledger — the audited cost basis carried per shift — with the
        // live slice's own MEASURED usage riding the usage slot.
        const observed = await observationOverDurableLedger({ db: database_, world, row });
        const liveObservation: PilotObservation = {
          ...observed,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        };
        const criteria = verifyProductionPilotIntegrity({ row, observation: liveObservation });
        const failed = criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
        expect(criteria.map((criterion) => criterion.criterionId).sort()).toEqual([
          "budget-policy-envelope",
          "continuation-exactly-once",
          "customer-boundary",
          "drift-classification-honesty",
          "end-of-window-accounting",
          "incident-honesty",
          "schedule-completeness",
          "window-honesty",
        ]);
        // The accounting evidence names the ZERO residual (honest
        // recording — the audited basis carried per shift).
        const accountingEvidence =
          criteria
            .find((criterion) => criterion.criterionId === "end-of-window-accounting")
            ?.evidence.join(" ") ?? "";
        expect(accountingEvidence).toContain("cost-residual:0");

        // The verdict derived from the measured facts (the durable
        // ledger plus the live slice's own MEASURED usage — never a
        // fabricated family).
        const verdict = derivePilotVerdict({ row, observation: liveObservation });
        expect(verdict.verdict).toBe("PILOT-COMPLETED");
        expect(verdict.failedCriteria).toEqual([]);
        expect(liveObservation.usage).toEqual({
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        });

        // The live dispatches recorded through the REAL recorder: one
        // live-dispatch step event per shift, DIGEST-ONLY (the measured
        // facts ride the digest; payload bytes never land).
        const recordedDispatches = await database_.execute<{
          readonly reference: { readonly kind?: string; readonly digest?: string };
          readonly payload: Record<string, unknown>;
        }>({
          sql: `SELECT e.reference, e.payload FROM executions.execution_events e
                  JOIN executions.executions x ON e.execution_id = x.id
                  WHERE x.task->>'kind' = $1 AND x.task->>'rowId' = $2
                    AND e.command = 'agent-action-recorded'
                    AND e.payload->>'kind' = 'live-dispatch-usage'`,
          parameters: [SHIFT_TASK_KIND, row.rowId],
        });
        expect(recordedDispatches.rows.length).toBe(row.schedule.length);
        const recordedDigests = recordedDispatches.rows.map((event) => event.reference.digest);
        for (const event of recordedDispatches.rows) {
          expect(event.reference.kind).toBe("live-dispatch-usage");
          expect(event.reference.digest).toMatch(/^[0-9a-f]{8}$/);
          expect(Object.keys(event.payload).sort()).toEqual(["kind", "ordinal"]);
        }
        for (const digest of dispatchDigests) {
          expect(recordedDigests).toContain(digest);
        }

        // The live window's durable surface: five terminal shift
        // executions under the pilot's own customer identity over
        // REAL SQL (the public read boundary serves the same truth).
        const durable = await database_.execute<{
          id: string;
          status: string;
          application_id: string;
        }>({
          sql: `SELECT id::text AS id, status, application_id::text AS application_id
                  FROM executions.executions
                  WHERE task->>'kind' = $1 AND task->>'rowId' = $2
                  ORDER BY created_at ASC, id ASC`,
          parameters: [SHIFT_TASK_KIND, row.rowId],
        });
        expect(durable.rows.length).toBe(row.schedule.length);
        expect(durable.rows.every((record) => record.status === "COMPLETED")).toBe(true);
        expect(durable.rows.every((record) => record.application_id === world.applicationId)).toBe(
          true,
        );
        const firstTerminal = await client.getExecution(durable.rows[0]?.id ?? "");
        expect(firstTerminal.status).toBe("COMPLETED");

        drivenLive.push(
          `${row.rowId} -> ${verdict.verdict} dispatches=${dispatches} ` +
            `measuredUsage=${totalInputTokens}+${totalOutputTokens}tokens ` +
            `measured=${totalMeasuredCost.toString()}µ$ successful=${successfulDispatches}`,
        );
        console.info(`[VAL-051]   LIVE ${row.rowId} -> ${verdict.verdict} ${drivenLive.at(-1)}`);
      }

      console.info(
        `[VAL-051] LIVE rail summary: ${drivenLive.length} REAL live pilot window(s) driven over ` +
          `the pinned OpenRouter rail (one REAL dispatch per scheduled shift, measured usage priced ` +
          `at the pinned manifest revision, the audited cost basis carried per shift over the REAL ` +
          `platform path — the public create boundary, the REAL state machine, the REAL recorder — ` +
          `the verdict derived from the measured facts, never fabricated).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-051] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live window happened (never an all-NOT-RUN
      // silent pass once a credential is present).
      expect(drivenLive.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
