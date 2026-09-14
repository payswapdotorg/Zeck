/**
 * VAL-052 — the integration crown: the FINAL REPORT / RELEASE-GATE
 * durable surface over REAL PostgreSQL (env-gated on ZECK_PG_TEST_URL).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - REAL PostgreSQL 16 (a per-run disposable database created off the
 *     admin database named by ZECK_PG_TEST_URL, the shipped migrations
 *     applied, dropped on teardown — the house harness's disposable-DB
 *     lifecycle, inlined at the env gate this work order demands; NO
 *     new migrations — the existing idempotency/executions schema
 *     suffices);
 *   - the RECORDED EVIDENCE BASIS — the governed program state (the
 *     asOf of record + every registered work order's title, completion
 *     status and merge/finalize record) and every evidence document's
 *     registered location + content digest — committed READ-ONLY into
 *     REAL SQL through the platform's own idempotency-record
 *     arbitration: an identical re-commit REPLAYS, a different-content
 *     commit under a recorded key is REFUSED (the recorded basis is a
 *     frozen input), then served back over FRESH SQL reads;
 *   - the customer side rides the REAL SDK client over REAL HTTP
 *     (globalThis.fetch — the same public wire the application's
 *     harness rides): every corpus row's report task (REFERENCES ONLY —
 *     the row id, the program slice, the verification families, the
 *     registry counts) is submitted through the public create boundary
 *     under its OWN idempotency key;
 *   - the REAL executions state machine drives every landed execution
 *     through the canonical transitions (authorize → plan → [durable
 *     planning decision] → queue → start → [step event carrying the
 *     report package's DIGEST reference — payload bytes never land] →
 *     verify → pass/fail);
 *   - the THIRTEEN mechanical oracles are re-derived AT THE BOUNDARY
 *     over the DURABLE BASIS: the report package derives purely from
 *     REAL SQL reads (the SQL-served governed state + the SQL-served
 *     evidence-document resolutions) and the release-gate verdict
 *     adjudicates against the same SQL-served truth — never trusting
 *     the platform's own claim — and the honest durable report
 *     reproduces the offline pure derivation EXACTLY (digest parity:
 *     the boundary package matches the offline derivation
 *     digest-for-digest and the boundary verdict equals the offline
 *     verdict).
 *
 * The durable discriminations: the seven adversarial durable shapes (a
 * missing work order — the platform's report view omits a registered
 * work order whose truth record IS durable in SQL; a deleted evidence
 * document — a denatured evidence record committed under the probe
 * namespace while the honest basis record resolves; a reasonless NOT
 * RUN boundary — the boundary row served without its gating env var; a
 * protocol-stripped finding — the finding served with its seven-part
 * protocol emptied; a phantom coverage claim — a never-registered work
 * order cited with NO truth record in SQL; a silently dropped
 * incomplete work order — the deadline accounting served without the
 * incomplete work order its own truth record names; a self-declared
 * acceptance — the in-flight work order's acceptance served as
 * self-declared) are each DETECTED over the durable basis by the NAMED
 * oracle with the mechanism named in evidence AND the durable SQL
 * evidence pinned (truth records present/absent, the denatured record,
 * the step-event package digest).
 *
 * The live rail (AC3) rides the env-gated live driver (the
 * review-fix): the ONE live gate-confirmation slice demands the
 * operator-authorized rail (OPENROUTER_API_KEY) — off-key the row is
 * an honest NOT RUN (the env var NAMED, ZERO dispatches, ZERO durable
 * submissions, the gate pinned over REAL SQL); on-key ONE REAL
 * dispatch on the pinned rail lands through the REAL platform path
 * (the public create boundary, the REAL state machine, the REAL
 * recorder) with the dispatch usage MEASURED and priced at the
 * pinned manifest list prices, the measured facts bounds-checked
 * against the recorded live-window bounds, and the THIRTEEN oracles
 * re-derived over the durable basis (offline digest parity). This
 * crown never fabricates a live confirmation.
 *
 * STATE-AGNOSTIC: every governed-state count derives at run time over
 * the same file the app reads (46 registered work orders is the one
 * FIXED invariant), so the crown stays green across the VAL-052
 * finalize; the silent-omission durable shape is VACUOUS once nothing
 * is incomplete (its pinned FAILED verdict is honestly contradicted by
 * the derived COMPLETED).
 *
 * Honest skip: without ZECK_PG_TEST_URL the suite SKIPS (never fails,
 * never fake-passes) with the env var NAMED.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import {
  manifestRevisionOf,
  parseDecimal,
  resolveListPrice,
} from "../../../benchmarks/validation/apps/economic-baseline/pricing";
import { divRoundHalfUp } from "../../../benchmarks/validation/apps/economic-substrate-runtime/pricing";
import type { ReportProbeKind } from "../../../benchmarks/validation/apps/final-report/corpus";
import {
  FINAL_REPORT_ROW_IDS,
  finalReportRowById,
  GOVERNED_PROGRAM_STATE_PATH,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OPERATOR_DEADLINE_UTC,
  PROBE_FAILED_CRITERIA_OF,
  registeredEvidencePathOf,
  reportTaskBodyFor,
} from "../../../benchmarks/validation/apps/final-report/corpus";
import type {
  ReportPackage,
  ReportWorld,
} from "../../../benchmarks/validation/apps/final-report/driver";
import {
  deriveReleaseGateVerdict,
  LIVE_REPORT_PLAN,
  liveReportPlanDigestOf,
  loadRealReportWorld,
  reportPackageFor,
  verifyFinalReportIntegrity,
} from "../../../benchmarks/validation/apps/final-report/driver";
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
    "[val-052-final-report] SKIPPED: ZECK_PG_TEST_URL is not set — the integration crown demands REAL PostgreSQL " +
      "(e.g. ZECK_PG_TEST_URL='postgres://val@127.0.0.1:5433/postgres'); the final report's durable surface " +
      "(the consolidated-evidence-inventory basis served READ-ONLY over REAL SQL, the release-gate verdict " +
      "re-derived at the boundary with offline digest parity) is only provable over REAL SQL. Re-run with the " +
      "variable set to drive the crown.",
  );
}

/** The operator-authorized live-rail credential (absent = the live row is an honest NOT RUN). */
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

// ---------------------------------------------------------------------------
// The state-agnostic derivation basis (the SAME governed-state file the
// app reads — READ-ONLY; only the TOTAL registered count 46 is a FIXED
// invariant, every count below derives at run time)
// ---------------------------------------------------------------------------

const stateFile = JSON.parse(
  readFileSync(join(process.cwd(), GOVERNED_PROGRAM_STATE_PATH), "utf8"),
) as {
  readonly asOf: string;
  readonly program: string;
  readonly status: string;
  readonly schemaVersion: number;
  readonly workOrders: Readonly<
    Record<
      string,
      {
        readonly status: string;
        readonly title: string;
        readonly mergedAs?: { readonly pr: number; readonly mergeCommit: string };
      }
    >
  >;
};
const registeredIds = Object.keys(stateFile.workOrders);
const completeIds = registeredIds.filter((id) => stateFile.workOrders[id]?.status === "complete");
const incompleteOfWorkOrder = registeredIds
  .filter((id) => stateFile.workOrders[id]?.status !== "complete")
  .map((id) => ({ workOrderId: id, status: stateFile.workOrders[id]?.status ?? "unknown" }));
const prMergeIds = registeredIds.filter((id) => stateFile.workOrders[id]?.mergedAs !== undefined);
const finalizeIds = completeIds.filter((id) => stateFile.workOrders[id]?.mergedAs === undefined);
const asOf = stateFile.asOf;
const val052Status = stateFile.workOrders["VAL-052"]?.status ?? "unregistered";
/** The silent-omission durable shape is dishonest exactly while work orders remain incomplete. */
const silentOmissionVacuous = incompleteOfWorkOrder.length === 0;

/** The row of record by id (throws when unknown). */
const rowOf = (rowId: string) => {
  const row = finalReportRowById(rowId);
  if (row === null) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

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
// The durable report machinery over the REAL platform path
// ---------------------------------------------------------------------------

const generateId = createUuidv7Generator();

/** The durable task vocabulary of the crown's report executions. */
const REPORT_TASK_KIND = "final-report.release-gate.v1";

/** The REAL SQL operations the crown's read-only evidence basis rides. */
const REPORT_BASIS_OPERATION = "val-052.report-inventory-basis";
const DEPENDENCY_BASIS_OPERATION = "val-052.report-dependency-basis";
const PROGRAM_HEADER_OPERATION = "val-052.program-state-header";
const DENATURED_EVIDENCE_OPERATION = "val-052.denatured-evidence-basis";

/** One work order's recorded evidence-basis entry (the durable outcome). */
interface ServedBasisEntry {
  readonly workOrderId: string;
  readonly title: string;
  readonly status: string;
  readonly registeredPath: string;
  readonly resolved: boolean;
  readonly contentDigest: string | null;
  readonly pr: number | null;
  readonly mergeCommit: string | null;
}

/** The program header (the asOf + the pinned operator deadline). */
interface ServedProgramHeader {
  readonly asOf: string;
  readonly program: string;
  readonly status: string;
  readonly schemaVersion: number;
  readonly operatorDeadline: string;
}

/** Commit one read-only record through the platform's own arbitration. */
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
    // The recorded evidence basis is frozen: a different-content commit
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

/**
 * Seed the RECORDED EVIDENCE BASIS over REAL SQL (READ-ONLY data
 * committed through the platform's own arbitration — the governed
 * program state, the dependency map and every evidence document's
 * registered resolution): one inventory-basis record per registered
 * work order, one dependency record each and the program header, each
 * identically re-committed so the replay arbitration is exercised per
 * record.
 */
async function seedReportEvidenceBasis(
  db: DatabasePort,
  world: ApiPgWorld,
): Promise<{
  readonly committed: number;
  readonly replayed: number;
  readonly refused: number;
}> {
  let committed = 0;
  let replayed = 0;
  let refused = 0;
  for (const workOrderId of registeredIds) {
    const registered = stateFile.workOrders[workOrderId];
    if (registered === undefined) {
      throw new Error(`no registered record for ${workOrderId}`);
    }
    const registeredPath = registeredEvidencePathOf(workOrderId);
    const absolute = join(process.cwd(), registeredPath);
    const resolved = existsSync(absolute);
    const contentDigest = resolved ? economicDigestOf(readFileSync(absolute, "utf8")) : null;
    const outcome: ServedBasisEntry = {
      workOrderId,
      title: registered.title,
      status: registered.status,
      registeredPath,
      resolved,
      contentDigest,
      pr: registered.mergedAs?.pr ?? null,
      mergeCommit: registered.mergedAs?.mergeCommit ?? null,
    };
    const fingerprint = economicDigestOf({ workOrderId, basis: outcome });
    const first = await arbitrateDurableRecord(
      db,
      world,
      REPORT_BASIS_OPERATION,
      workOrderId,
      fingerprint,
      outcome as unknown as Record<string, unknown>,
    );
    if (first.accepted) {
      committed += 1;
    }
    const identical = await arbitrateDurableRecord(
      db,
      world,
      REPORT_BASIS_OPERATION,
      workOrderId,
      fingerprint,
      outcome as unknown as Record<string, unknown>,
    );
    if (identical.replayed) {
      replayed += 1;
    }
    if (identical.refused) {
      refused += 1;
    }
  }
  // The dependency map of record (one durable record per work order).
  const dependencyFile = JSON.parse(
    readFileSync(join(process.cwd(), "spec/validation-state/dependency-state.json"), "utf8"),
  ) as { readonly dependencies: Readonly<Record<string, readonly string[]>> };
  for (const workOrderId of registeredIds) {
    const dependsOn = dependencyFile.dependencies[workOrderId] ?? [];
    await arbitrateDurableRecord(
      db,
      world,
      DEPENDENCY_BASIS_OPERATION,
      workOrderId,
      economicDigestOf({ workOrderId, dependsOn }),
      { workOrderId, dependsOn },
    );
  }
  // The program header (the asOf of record + the pinned deadline).
  const header: ServedProgramHeader = {
    asOf,
    program: stateFile.program,
    status: stateFile.status,
    schemaVersion: stateFile.schemaVersion,
    operatorDeadline: OPERATOR_DEADLINE_UTC,
  };
  await arbitrateDurableRecord(
    db,
    world,
    PROGRAM_HEADER_OPERATION,
    "header",
    economicDigestOf({ header }),
    header as unknown as Record<string, unknown>,
  );
  return { committed, replayed, refused };
}

/**
 * The REPORT WORLD served over FRESH SQL reads (the durable basis of
 * record): the governed program state, the dependency state and the
 * evidence-document resolver — every value from REAL SQL, never the
 * seed-time objects. The `deleted-evidence-document` denaturation
 * substitutes VAL-033's resolution with the probe-row-namespaced
 * denatured record (the document that does not resolve).
 */
async function reportWorldOverDurableBasis(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly denaturedEvidence?: boolean;
}): Promise<ReportWorld> {
  const { db, world } = options;
  const basisRows = await db.execute<{ durable_outcome: ServedBasisEntry }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY idempotency_key ASC`,
    parameters: [world.applicationId, REPORT_BASIS_OPERATION],
  });
  const entries = new Map(
    basisRows.rows.map((row) => [row.durable_outcome.workOrderId, row.durable_outcome]),
  );
  if (entries.size !== registeredIds.length) {
    throw new Error(
      `the durable basis serves ${entries.size} records (expected ${registeredIds.length})`,
    );
  }
  if (options.denaturedEvidence === true) {
    const denatured = await durableOutcomeOf<ServedBasisEntry>(
      db,
      world,
      DENATURED_EVIDENCE_OPERATION,
      "probe-deleted-evidence-document:VAL-033",
    );
    if (denatured === null) {
      throw new Error("the denatured evidence record was never committed");
    }
    entries.set("VAL-033", denatured);
  }
  const header = await durableOutcomeOf<ServedProgramHeader>(
    db,
    world,
    PROGRAM_HEADER_OPERATION,
    "header",
  );
  if (header === null) {
    throw new Error("the program header was never committed");
  }
  const dependencyRows = await db.execute<{
    durable_outcome: { workOrderId: string; dependsOn: readonly string[] };
  }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY idempotency_key ASC`,
    parameters: [world.applicationId, DEPENDENCY_BASIS_OPERATION],
  });
  const dependencies: Record<string, readonly string[]> = {};
  for (const row of dependencyRows.rows) {
    dependencies[row.durable_outcome.workOrderId] = row.durable_outcome.dependsOn;
  }
  const workOrders: Record<
    string,
    { status: string; title: string; mergedAs?: { pr: number; mergeCommit: string } }
  > = {};
  for (const [workOrderId, entry] of entries) {
    workOrders[workOrderId] = {
      status: entry.status,
      title: entry.title,
      ...(entry.pr === null || entry.mergeCommit === null
        ? {}
        : { mergedAs: { pr: entry.pr, mergeCommit: entry.mergeCommit } }),
    };
  }
  return {
    programState: {
      schemaVersion: header.schemaVersion,
      program: header.program,
      status: header.status,
      asOf: header.asOf,
      workOrders,
    },
    dependencyState: {
      schemaVersion: 1,
      program: header.program,
      dependencies,
    },
    evidenceDocOf: (workOrderId: string) => {
      const entry = entries.get(workOrderId);
      if (entry === undefined) {
        return {
          workOrderId,
          registeredPath: registeredEvidencePathOf(workOrderId),
          exists: false,
          contentDigest: null,
        };
      }
      return {
        workOrderId,
        registeredPath: entry.registeredPath,
        exists: entry.resolved,
        contentDigest: entry.contentDigest,
      };
    },
    reportTimestamp: header.asOf,
    operatorDeadline: header.operatorDeadline,
  };
}

/**
 * Drive one landed report execution through the REAL state machine to
 * its terminal (the step event carries the report package's DIGEST
 * reference — payload bytes never land).
 */
async function driveReportExecutionToTerminal(options: {
  readonly world: ApiPgWorld;
  readonly executionId: string;
  readonly rowId: string;
  readonly packageDigest: string;
  readonly terminal: "pass" | "fail";
}): Promise<void> {
  const { world, executionId } = options;
  const scope = {
    actorId: world.actorId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    executionId,
  };
  const key = (tag: string) => `val-052-${executionId}-${tag}`;
  await world.executions.transition({ ...scope, command: "authorize" }, key("authorize"));
  await world.executions.transition(
    { ...scope, command: "plan", reason: "val-052-final-report-plan" },
    key("plan"),
  );
  await world.executions.recordPlanningDecision(
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
            strategyId: "val-052-final-report",
            plan: {
              strategyClass: "final-report",
              modelCalls: 0,
              steps: [
                { routeRef: { provider: "report-ledger", model: "recorded-report-derivation" } },
              ],
            },
          },
        ],
        selectedStrategyId: "val-052-final-report",
        armDecision: { rowId: options.rowId, packageDigest: options.packageDigest },
      },
    },
    key("decision"),
  );
  await world.executions.transition(
    { ...scope, command: "queue", reason: "val-052-final-report-queue" },
    key("queue"),
  );
  await world.executions.transition(
    { ...scope, command: "start", reason: "val-052-final-report-start" },
    key("start"),
  );
  await world.executions.recordStepEvent(
    {
      applicationId: world.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: world.tenantId },
      command: "agent-action-recorded",
      cause: `val-052-${options.rowId}`,
      reference: {
        kind: "final-report-package",
        rowId: options.rowId,
        digest: options.packageDigest,
      },
      payload: { kind: "final-report-package", rowId: options.rowId },
    },
    key("step-1"),
  );
  await world.executions.transition(
    { ...scope, command: "verify", reason: "val-052-final-report-verify" },
    key("verify"),
  );
  const evidence = [
    `row:${options.rowId}`,
    `package-digest:${options.packageDigest}`,
    "basis:recorded-governed-state-served-over-real-sql",
  ];
  if (options.terminal === "pass") {
    await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "final-report-verified",
            strategy: "deterministic",
            status: "PASS",
            recordedBy: "val-052-crown",
            evidence,
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
        reason: "val-052-final-report-dishonest-shape",
        verificationResults: [
          {
            criterionId: "final-report-verified",
            strategy: "deterministic",
            status: "FAIL",
            recordedBy: "val-052-crown",
            evidence,
          },
        ],
      },
      key("fail"),
    );
  }
}

/**
 * Drive one LIVE gate-confirmation execution through the REAL state
 * machine to its terminal (the env-gated live row only): the REAL
 * dispatch on the pinned rail runs INSIDE the execution's RUNNING
 * window (the dispatch callback), its MEASURED facts recorded through
 * the REAL recorder as an additional digest-only step event (the
 * report package's digest reference plus the live-dispatch reference —
 * payload bytes never land), and the terminal's verification evidence
 * NAMES the live dispatch digest.
 */
async function driveLiveReportExecutionToTerminal(options: {
  readonly world: ApiPgWorld;
  readonly executionId: string;
  readonly rowId: string;
  readonly packageDigest: string;
  readonly terminal: "pass" | "fail";
  /** The live confirmation's REAL dispatch on the pinned rail (run while the execution is RUNNING). */
  readonly dispatch: () => Promise<string>;
}): Promise<void> {
  const { world, executionId } = options;
  const scope = {
    actorId: world.actorId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    executionId,
  };
  const key = (tag: string) => `val-052-live-${executionId}-${tag}`;
  await world.executions.transition({ ...scope, command: "authorize" }, key("authorize"));
  await world.executions.transition(
    { ...scope, command: "plan", reason: "val-052-live-report-confirmation-plan" },
    key("plan"),
  );
  await world.executions.recordPlanningDecision(
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
            strategyId: "val-052-live-report-confirmation",
            plan: {
              strategyClass: "final-report-live",
              modelCalls: 0,
              steps: [
                {
                  routeRef: {
                    provider: LIVE_REPORT_PLAN.rail.provider,
                    model: LIVE_REPORT_PLAN.rail.model,
                  },
                },
              ],
            },
          },
        ],
        selectedStrategyId: "val-052-live-report-confirmation",
        armDecision: {
          rowId: options.rowId,
          packageDigest: options.packageDigest,
          rail: LIVE_REPORT_PLAN.rail.endpoint,
        },
      },
    },
    key("decision"),
  );
  await world.executions.transition(
    { ...scope, command: "queue", reason: "val-052-live-report-confirmation-queue" },
    key("queue"),
  );
  await world.executions.transition(
    { ...scope, command: "start", reason: "val-052-live-report-confirmation-start" },
    key("start"),
  );
  // The live confirmation's REAL dispatch on the pinned rail runs
  // inside the RUNNING window (the measured facts return as a digest).
  const liveDispatchDigest = await options.dispatch();
  // The report package's DIGEST reference (payload bytes never land).
  await world.executions.recordStepEvent(
    {
      applicationId: world.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: world.tenantId },
      command: "agent-action-recorded",
      cause: `val-052-live-${options.rowId}`,
      reference: {
        kind: "final-report-package",
        rowId: options.rowId,
        digest: options.packageDigest,
      },
      payload: { kind: "final-report-package", rowId: options.rowId },
    },
    key("step-1"),
  );
  // The live dispatch's MEASURED facts recorded through the REAL
  // recorder (digest-only — the measured usage, its pinned-price cost
  // and its wallclock ride the digest; payload bytes never land).
  await world.executions.recordStepEvent(
    {
      applicationId: world.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: world.tenantId },
      command: "agent-action-recorded",
      cause: `val-052-live-dispatch-${options.rowId}`,
      reference: {
        kind: "live-dispatch-usage",
        ordinal: 1,
        digest: liveDispatchDigest,
      },
      payload: { kind: "live-dispatch-usage", ordinal: 1 },
    },
    key("live-step-1"),
  );
  await world.executions.transition(
    { ...scope, command: "verify", reason: "val-052-live-report-confirmation-verify" },
    key("verify"),
  );
  const evidence = [
    `row:${options.rowId}`,
    `package-digest:${options.packageDigest}`,
    "basis:recorded-governed-state-served-over-real-sql",
    `live-dispatch:${liveDispatchDigest}`,
  ];
  if (options.terminal === "pass") {
    await world.executions.transition(
      {
        ...scope,
        command: "pass",
        verificationResults: [
          {
            criterionId: "final-report-verified",
            strategy: "deterministic",
            status: "PASS",
            recordedBy: "val-052-live-crown",
            evidence,
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
        reason: "val-052-live-report-confirmation-dishonest-shape",
        verificationResults: [
          {
            criterionId: "final-report-verified",
            strategy: "deterministic",
            status: "FAIL",
            recordedBy: "val-052-live-crown",
            evidence,
          },
        ],
      },
      key("fail"),
    );
  }
}

/**
 * Land one corpus row's report submission through the REAL public
 * platform path (the SDK client over REAL HTTP → the public create
 * boundary under the row's OWN idempotency key → the REAL state
 * machine to its terminal), recording the boundary package's digest
 * reference in the step event.
 */
async function landReportRowOverRealPlatform(options: {
  readonly db: DatabasePort;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly rowId: string;
  /** The boundary package the platform's report view serves (denatured per the probe). */
  readonly report: ReportPackage;
  readonly terminal: "pass" | "fail";
}): Promise<{ readonly executionId: string; readonly replayed: boolean }> {
  const { db, world, report } = options;
  const row = rowOf(options.rowId);
  const client = createZeckClient({
    baseUrl: options.address,
    token: world.bearerToken,
    applicationId: world.applicationId,
    fetchImpl: globalThis.fetch,
  });
  const receipt = (
    await client.createExecution(
      { applicationId: world.applicationId, task: reportTaskBodyFor({ row }) },
      `val-052-crown-${options.rowId}`,
    )
  ).receipt;
  await driveReportExecutionToTerminal({
    world,
    executionId: receipt.executionId,
    rowId: options.rowId,
    packageDigest: report.packageDigest,
    terminal: options.terminal,
  });
  // The durable execution row (REAL SQL) — the report task kind of record.
  const landed = await db.execute<{ id: string; status: string; kind: string }>({
    sql: `SELECT id::text AS id, status, task->>'kind' AS kind FROM executions.executions
          WHERE application_id = $1 AND task->>'rowId' = $2`,
    parameters: [world.applicationId, options.rowId],
  });
  if (landed.rows.length !== 1) {
    throw new Error(`expected exactly one durable execution for ${options.rowId}`);
  }
  if (landed.rows[0]?.kind !== REPORT_TASK_KIND) {
    throw new Error(`the durable execution for ${options.rowId} is not a report task`);
  }
  return { executionId: receipt.executionId, replayed: receipt.replayed };
}

/** The package-digest reference recorded in one row's step event (REAL SQL). */
async function recordedPackageDigestOf(
  db: DatabasePort,
  world: ApiPgWorld,
  rowId: string,
): Promise<string | null> {
  const result = await db.execute<{ digest: string | null }>({
    sql: `SELECT reference->>'digest' AS digest FROM executions.execution_events e
          JOIN executions.executions x ON e.execution_id = x.id
          WHERE x.application_id = $1 AND x.task->>'rowId' = $2
            AND e.command = 'agent-action-recorded'`,
    parameters: [world.applicationId, rowId],
  });
  return result.rows[0]?.digest ?? null;
}

// ---------------------------------------------------------------------------
// The suite (env-gated; the honest skip names the env var)
// ---------------------------------------------------------------------------

(url ? describe : describe.skip)("VAL-052 final report over REAL PostgreSQL", () => {
  let db: DatabasePort | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // The house harness's disposable-DB lifecycle: a fresh database
    // off the admin URL, the shipped migrations applied, dropped on
    // teardown (tests/integration/postgres/harness.ts pattern).
    const databaseName = `zeck_val052_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

  test("the honest durable report basis lands over the REAL platform path and the THIRTEEN oracles re-derive ALL-PASS over the durable basis (offline digest parity)", {
    timeout: 300_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      // The RECORDED EVIDENCE BASIS committed READ-ONLY over REAL SQL
      // (identical re-commit REPLAYS per record, nothing refused).
      const seeded = await seedReportEvidenceBasis(database_, world);
      expect(seeded.committed).toBe(registeredIds.length);
      expect(seeded.replayed).toBe(registeredIds.length);
      expect(seeded.refused).toBe(0);

      const honestRowIds = [
        "inventory-consolidated-governed-state",
        "release-gate-nine-conditions",
        "program-coverage-and-disclosures",
        "deadline-remainder-honest",
        "acceptance-chain-carried",
      ];
      const offlineWorld = loadRealReportWorld();
      for (const rowId of honestRowIds) {
        const row = rowOf(rowId);
        // The boundary re-derivation: the report package derives over
        // the DURABLE basis (FRESH SQL reads), never the seed objects.
        const durableWorld = await reportWorldOverDurableBasis({ db: database_, world });
        const boundaryReport = reportPackageFor(row, durableWorld);
        const offlineReport = reportPackageFor(row, offlineWorld);
        // The durable surface reproduces the offline pure derivation
        // EXACTLY (digest parity — digest-for-digest, the whole
        // package bit-stable).
        expect(boundaryReport.packageDigest, rowId).toBe(offlineReport.packageDigest);
        expect(JSON.stringify(boundaryReport), rowId).toBe(JSON.stringify(offlineReport));

        const landed = await landReportRowOverRealPlatform({
          db: database_,
          world,
          address,
          rowId,
          report: boundaryReport,
          terminal: "pass",
        });
        expect(landed.replayed, rowId).toBe(false);
        // The durable execution row is COMPLETED in REAL SQL.
        const status = await database_.execute<{ status: string }>({
          sql: `SELECT status FROM executions.executions WHERE id = $1`,
          parameters: [landed.executionId],
        });
        expect(status.rows[0]?.status, rowId).toBe("COMPLETED");
        // The step event carries the package DIGEST reference (the
        // offline derivation's digest — payload bytes never land).
        expect(await recordedPackageDigestOf(database_, world, rowId), rowId).toBe(
          offlineReport.packageDigest,
        );

        // The THIRTEEN oracles re-derived AT THE BOUNDARY over the
        // durable basis — ALL PASS, and the boundary verdict equals
        // the offline verdict.
        const criteria = verifyFinalReportIntegrity({
          row,
          world: durableWorld,
          report: boundaryReport,
        });
        const failed = criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${rowId}: ${JSON.stringify(failed)}`).toEqual([]);
        expect(criteria).toHaveLength(13);
        expect(
          deriveReleaseGateVerdict({ row, world: durableWorld, report: boundaryReport }),
        ).toEqual(deriveReleaseGateVerdict({ row, world: offlineWorld, report: offlineReport }));
        expect(
          deriveReleaseGateVerdict({ row, world: durableWorld, report: boundaryReport }).verdict,
        ).toBe("COMPLETED");
      }

      // The consolidated inventory re-derived over the durable basis
      // reconciles against the governed state of record (the counts
      // DERIVE at run time; 46 registered is the FIXED invariant).
      const durableWorld = await reportWorldOverDurableBasis({ db: database_, world });
      const completeness = verifyFinalReportIntegrity({
        row: rowOf("inventory-consolidated-governed-state"),
        world: durableWorld,
        report: reportPackageFor(rowOf("inventory-consolidated-governed-state"), durableWorld),
      }).find((criterion) => criterion.criterionId === "inventory-completeness");
      expect(completeness?.status).toBe("PASS");
      expect(completeness?.evidence).toContain(`registered-work-orders:${registeredIds.length}`);
      expect(completeness?.evidence).toContain(`inventoried-work-orders:${registeredIds.length}`);
      expect(registeredIds).toHaveLength(46);
      const registration = verifyFinalReportIntegrity({
        row: rowOf("inventory-consolidated-governed-state"),
        world: durableWorld,
        report: reportPackageFor(rowOf("inventory-consolidated-governed-state"), durableWorld),
      }).find((criterion) => criterion.criterionId === "inventory-registration");
      expect(registration?.evidence).toContain(`complete:${completeIds.length}`);
      expect(registration?.evidence).toContain(`not-complete:${incompleteOfWorkOrder.length}`);
      const acceptance = verifyFinalReportIntegrity({
        row: rowOf("inventory-consolidated-governed-state"),
        world: durableWorld,
        report: reportPackageFor(rowOf("inventory-consolidated-governed-state"), durableWorld),
      }).find((criterion) => criterion.criterionId === "acceptance-chain-honesty");
      expect(acceptance?.evidence).toContain(`carried-by-pr-merge:${prMergeIds.length}`);
      expect(acceptance?.evidence).toContain(
        `carried-by-program-state-finalize:${finalizeIds.length}`,
      );

      // The idempotent re-issue: the first honest row's IDENTICAL
      // request under the SAME key REPLAYS over REAL HTTP (never a
      // second durable execution, never a second idempotency record).
      const before = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      const client = createZeckClient({
        baseUrl: address,
        token: world.bearerToken,
        applicationId: world.applicationId,
        fetchImpl: globalThis.fetch,
      });
      const replay = (
        await client.createExecution(
          {
            applicationId: world.applicationId,
            task: reportTaskBodyFor({ row: rowOf("inventory-consolidated-governed-state") }),
          },
          "val-052-crown-inventory-consolidated-governed-state",
        )
      ).receipt;
      expect(replay.replayed).toBe(true);
      const after = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(after.rows[0]?.c ?? 0).toBe(before.rows[0]?.c ?? 0);

      // No orphan events: every execution event joins its execution.
      const orphans = await database_.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.execution_events e
                  LEFT JOIN executions.executions x ON e.execution_id = x.id
                  WHERE e.application_id = $1 AND x.id IS NULL`,
        parameters: [world.applicationId],
      });
      expect(orphans.rows[0]?.c ?? 0).toBe(0);
    } finally {
      await world.server.app.close();
    }
  });

  test("the seven adversarial durable shapes are DETECTED by the NAMED oracles over the durable basis (each reproducing the offline controlled fake digest-for-digest)", {
    timeout: 300_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      await seedReportEvidenceBasis(database_, world);
      // The deleted-evidence durable shape: the denatured evidence
      // record (VAL-033's document does not resolve) committed under
      // the probe row's namespace while the HONEST basis record stays
      // durable and resolving.
      const honestVal033 = await durableOutcomeOf<ServedBasisEntry>(
        database_,
        world,
        REPORT_BASIS_OPERATION,
        "VAL-033",
      );
      if (honestVal033 === null) {
        throw new Error("the honest VAL-033 basis record was never committed");
      }
      expect(honestVal033.resolved).toBe(true);
      await arbitrateDurableRecord(
        database_,
        world,
        DENATURED_EVIDENCE_OPERATION,
        "probe-deleted-evidence-document:VAL-033",
        economicDigestOf({
          workOrderId: "VAL-033",
          denatured: { registeredPath: honestVal033.registeredPath, resolved: false },
        }),
        {
          workOrderId: "VAL-033",
          title: honestVal033.title,
          status: honestVal033.status,
          registeredPath: honestVal033.registeredPath,
          resolved: false,
          contentDigest: null,
          pr: honestVal033.pr,
          mergeCommit: honestVal033.mergeCommit,
        },
      );

      const offlineWorld = loadRealReportWorld();
      const probeRowIds = FINAL_REPORT_ROW_IDS.filter((rowId) => rowId.startsWith("probe-"));
      expect(probeRowIds).toHaveLength(7);
      for (const rowId of probeRowIds) {
        const row = rowOf(rowId);
        const probe = row.probe?.kind as ReportProbeKind;
        const vacuous = probe === "silent-omission" && silentOmissionVacuous;
        // The platform's report view over the durable basis,
        // denatured per the probe EXACTLY as the offline controlled
        // fake (the deleted-evidence shape reads the denatured record
        // through the world itself).
        const durableWorld = await reportWorldOverDurableBasis({
          db: database_,
          world,
          ...(probe === "deleted-evidence-document" ? { denaturedEvidence: true } : {}),
        });
        const boundaryReport =
          probe === "deleted-evidence-document"
            ? reportPackageFor(row, durableWorld)
            : reportPackageFor(row, durableWorld, { probe });
        const offlineReport =
          probe === "deleted-evidence-document"
            ? reportPackageFor(row, offlineWorld)
            : reportPackageFor(row, offlineWorld, { probe });
        // Digest parity: the durable denaturation reproduces the
        // offline controlled fake EXACTLY.
        expect(boundaryReport.packageDigest, probe).toBe(offlineReport.packageDigest);

        await landReportRowOverRealPlatform({
          db: database_,
          world,
          address,
          rowId,
          report: boundaryReport,
          terminal: vacuous ? "pass" : "fail",
        });
        // The durable execution row carries the corpus-pinned terminal.
        const status = await database_.execute<{ status: string }>({
          sql: `SELECT status FROM executions.executions
                  WHERE application_id = $1 AND task->>'rowId' = $2`,
          parameters: [world.applicationId, rowId],
        });
        expect(status.rows[0]?.status, probe).toBe(vacuous ? "COMPLETED" : "FAILED");

        // The TRUTH the oracle adjudicates against: the HONEST durable
        // basis (all records committed honestly).
        const honestDurableWorld = await reportWorldOverDurableBasis({
          db: database_,
          world,
        });
        const criteria = verifyFinalReportIntegrity({
          row,
          world: honestDurableWorld,
          report: boundaryReport,
        });
        const failed = criteria
          .filter((criterion) => criterion.status === "FAIL")
          .map((criterion) => criterion.criterionId)
          .sort();
        const evidenceOf = (criterionId: string): string =>
          criteria.find((criterion) => criterion.criterionId === criterionId)?.evidence.join(" ") ??
          "";

        if (vacuous) {
          // Post-finalize VACUITY: nothing is incomplete, so the empty
          // incomplete list IS the honest derivation — the pinned
          // FAILED verdict is honestly contradicted by the derived
          // COMPLETED (never a fabricated failure).
          expect(failed, probe).toEqual([]);
          expect(
            deriveReleaseGateVerdict({ row, world: honestDurableWorld, report: boundaryReport })
              .verdict,
            probe,
          ).toBe("COMPLETED");
        } else {
          expect(failed, probe).toEqual([...PROBE_FAILED_CRITERIA_OF[probe]].sort());
          expect(
            deriveReleaseGateVerdict({ row, world: honestDurableWorld, report: boundaryReport })
              .verdict,
            probe,
          ).toBe("FAILED");
        }

        // The mechanism NAMED in the boundary-re-derived evidence.
        if (probe === "missing-work-order") {
          expect(evidenceOf("inventory-completeness")).toContain(
            "omitted-work-order:VAL-031 (registered complete, never inventoried)",
          );
          // The durable SQL evidence: the TRUTH record for VAL-031 IS
          // durable in SQL while the report's inventory omits it.
          const truth = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = 'VAL-031'`,
            parameters: [world.applicationId, REPORT_BASIS_OPERATION],
          });
          expect(truth.rows[0]?.c ?? 0, probe).toBe(1);
          expect(boundaryReport.inventory.length, probe).toBe(registeredIds.length - 1);
        }
        if (probe === "deleted-evidence-document") {
          expect(evidenceOf("inventory-evidence-resolution")).toContain(
            "unresolved-evidence-document:VAL-033 (docs/work-items/VAL-033.md does not resolve)",
          );
          // The durable SQL evidence: BOTH records are durable — the
          // honest basis record resolving AND the denatured record
          // under the probe namespace not resolving.
          const denatured = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2
                      AND idempotency_key = 'probe-deleted-evidence-document:VAL-033'`,
            parameters: [world.applicationId, DENATURED_EVIDENCE_OPERATION],
          });
          expect(denatured.rows[0]?.c ?? 0, probe).toBe(1);
        }
        if (probe === "boundary-without-env-var") {
          expect(evidenceOf("gate-not-run-disclosure")).toContain(
            "reasonless-not-run-boundary:live-journey-slice (no gating env var named)",
          );
          expect(
            boundaryReport.notRunBoundaries.find(
              (boundary) => boundary.scope === "live-journey-slice",
            )?.envVar,
            probe,
          ).toBe("");
        }
        if (probe === "protocol-stripped-finding") {
          expect(evidenceOf("gate-findings-protocol")).toContain(
            "protocol-stripped-finding:F-01-live-rail-credential-custody",
          );
          expect(evidenceOf("gate-findings-protocol")).toContain(
            "hidden-residual-risk:F-01-live-rail-credential-custody (no residual risk named)",
          );
        }
        if (probe === "phantom-coverage") {
          expect(evidenceOf("inventory-completeness")).toContain(
            "phantom-inventory-entry:VAL-027 (not a registered work order of the governed state)",
          );
          expect(evidenceOf("gate-category-coverage")).toContain(
            "phantom-coverage:ambient-voice-translation→VAL-027 (VAL-027 is not a registered work order)",
          );
          // The durable SQL evidence: the phantom work order has NO
          // truth record in REAL SQL.
          const phantom = await database_.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = 'VAL-027'`,
            parameters: [world.applicationId, REPORT_BASIS_OPERATION],
          });
          expect(phantom.rows[0]?.c ?? 0, probe).toBe(0);
        }
        if (probe === "silent-omission") {
          // The durable SQL evidence: the TRUTH record for the
          // incomplete work order IS durable in SQL with its recorded
          // status, whether or not the report names it.
          const truth = await database_.execute<{ status: string }>({
            sql: `SELECT durable_outcome->>'status' AS status FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = 'VAL-052'`,
            parameters: [world.applicationId, REPORT_BASIS_OPERATION],
          });
          expect(truth.rows[0]?.status, probe).toBe(val052Status);
          expect(boundaryReport.deadline.incomplete, probe).toEqual([]);
          if (!vacuous) {
            for (const item of incompleteOfWorkOrder) {
              expect(evidenceOf("deadline-remainder-honesty")).toContain(
                `silently-dropped-incomplete:${item.workOrderId} (status ${item.status} at report time, never named)`,
              );
            }
          }
        }
        if (probe === "self-declared-acceptance") {
          expect(evidenceOf("acceptance-chain-honesty")).toContain(
            "self-declared-acceptance:VAL-052 (the Architect's acceptance is carried by the authority chain",
          );
          expect(
            boundaryReport.inventory.find((entry) => entry.workOrderId === "VAL-052")
              ?.acceptanceCarrier,
            probe,
          ).toBe("self-declared");
        }

        // The denaturation is DURABLE: the step event's recorded
        // package digest differs from the honest derivation's digest
        // (the offline HONEST row's digest) — except the vacuous
        // shape, whose denaturation coincides with the honest
        // derivation.
        const honestOffline = reportPackageFor(
          rowOf("inventory-consolidated-governed-state"),
          offlineWorld,
        );
        const recorded = await recordedPackageDigestOf(database_, world, rowId);
        expect(recorded, probe).toBe(boundaryReport.packageDigest);
        if (!vacuous) {
          expect(boundaryReport.packageDigest === honestOffline.packageDigest, probe).toBe(false);
        }
      }
    } finally {
      await world.server.app.close();
    }
  });

  test("the governed evidence basis is a FROZEN read-only input over REAL SQL, digest-for-digest equal to the governed state of record, and the live rail stays honestly NOT RUN", {
    timeout: 120_000,
  }, async () => {
    const database_ = database();
    const world = await seedApiPgWorld(database_);
    try {
      await seedReportEvidenceBasis(database_, world);

      // A different-content commit under a recorded key is REFUSED
      // (the recorded basis is a frozen input — never re-derived).
      for (const workOrderId of registeredIds) {
        const tampered = await arbitrateDurableRecord(
          database_,
          world,
          REPORT_BASIS_OPERATION,
          workOrderId,
          economicDigestOf({ workOrderId, tampered: true }),
          {
            workOrderId,
            title: "tampered",
            status: "complete",
            registeredPath: "docs/wrong-place.md",
            resolved: false,
            contentDigest: null,
            pr: null,
            mergeCommit: null,
          },
        );
        expect(tampered.refused, workOrderId).toBe(true);
        expect(tampered.accepted, workOrderId).toBe(false);
        expect(tampered.replayed, workOrderId).toBe(false);
      }

      // The SQL-served basis equals the governed state of record
      // DIGEST-FOR-DIGEST (title, status, registered location,
      // content digest, merge record).
      for (const workOrderId of registeredIds) {
        const registered = stateFile.workOrders[workOrderId];
        const served = await durableOutcomeOf<ServedBasisEntry>(
          database_,
          world,
          REPORT_BASIS_OPERATION,
          workOrderId,
        );
        expect(served?.title, workOrderId).toBe(registered?.title);
        expect(served?.status, workOrderId).toBe(registered?.status);
        expect(served?.registeredPath, workOrderId).toBe(registeredEvidencePathOf(workOrderId));
        expect(served?.pr, workOrderId).toBe(registered?.mergedAs?.pr ?? null);
        expect(served?.mergeCommit, workOrderId).toBe(registered?.mergedAs?.mergeCommit ?? null);
        const absolute = join(process.cwd(), registeredEvidencePathOf(workOrderId));
        expect(served?.resolved, workOrderId).toBe(existsSync(absolute));
        expect(served?.contentDigest, workOrderId).toBe(
          existsSync(absolute) ? economicDigestOf(readFileSync(absolute, "utf8")) : null,
        );
      }

      // The SQL-served program header: the asOf of record + the
      // pinned operator deadline (never a wall clock).
      const header = await durableOutcomeOf<ServedProgramHeader>(
        database_,
        world,
        PROGRAM_HEADER_OPERATION,
        "header",
      );
      expect(header?.asOf).toBe(asOf);
      expect(header?.operatorDeadline).toBe(OPERATOR_DEADLINE_UTC);

      // The basis records are digest-only (no evidence payload bytes
      // ever land — content digests and registry facts only).
      const basisRows = await database_.execute<{ durable_outcome: unknown }>({
        sql: `SELECT durable_outcome FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, REPORT_BASIS_OPERATION],
      });
      expect(basisRows.rows.length).toBe(registeredIds.length);
      for (const basisRow of basisRows.rows) {
        const outcome = basisRow.durable_outcome as Record<string, unknown>;
        expect(Object.keys(outcome).sort()).toEqual([
          "contentDigest",
          "mergeCommit",
          "pr",
          "registeredPath",
          "resolved",
          "status",
          "title",
          "workOrderId",
        ]);
      }

      // The live rail stays honestly NOT RUN over the crown: the live
      // row demands OPENROUTER_API_KEY (the env var NAMED) and lands
      // ZERO durable submissions over REAL SQL.
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

  test("the REAL live rail drives ONE REAL live gate-confirmation dispatch over the pinned OpenRouter rail (the live row's plan)", {
    timeout: 480_000,
  }, async () => {
    // The env-gated live rows (offline rows first, live rows last in
    // the pinned corpus — exactly ONE live gate-confirmation slice).
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
        "[VAL-052] OPENROUTER_API_KEY absent — the REAL live gate-confirmation slice is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers the complete report machinery over the RECORDED governed basis without " +
          "credentials. Required access: an operator-authorized OpenRouter credential (env " +
          "OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct " +
          "on the pinned rail — the REAL live confirmation demands ONE REAL dispatch (BYOK, " +
          "measured usage, max_tokens 32 pinned explicitly, temperature unset per the " +
          "provider's documented default, every priced token at the pinned manifest revision " +
          "rev-001) through the REAL platform path (the public create boundary, the REAL " +
          "state machine, the REAL recorder), the measured facts bounds-checked against the " +
          "recorded live-window bounds and the THIRTEEN oracles re-derived over the durable " +
          "basis. This live lane is reserved for the operator/session-B live review (the " +
          "offline rows above never re-measure; the live row is the only place new " +
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
      expect(liveRow.expected.verdict).toBe("NOT-RUN");
      expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
      expect(liveGateOpen(liveRow, {})).toBe(false);
      expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
      expect(liveReportPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
      expect(liveReportPlanDigestOf()).toBe(liveReportPlanDigestOf());
      expect(LIVE_REPORT_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
      expect(LIVE_REPORT_PLAN.rail.maxTokens).toBe(32);
      expect(LIVE_REPORT_PLAN.dispatches).toBe(1);
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
      const manifest = manifestRevisionOf(LIVE_REPORT_PLAN.rail.priceRevision);
      const entry =
        manifest === null
          ? null
          : resolveListPrice(
              manifest,
              LIVE_REPORT_PLAN.rail.provider,
              LIVE_REPORT_PLAN.rail.model,
              tier,
            );
      if (entry === null) {
        throw new Error(
          `the pinned model manifest holds no ${tier} price for ${LIVE_REPORT_PLAN.rail.model}`,
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

        // The RECORDED evidence basis committed READ-ONLY through the
        // platform's own arbitration (committed then identically
        // re-committed — the replay arbitration exercised per record).
        const seeded = await seedReportEvidenceBasis(database_, world);
        expect(seeded.committed).toBe(registeredIds.length);
        expect(seeded.replayed).toBe(registeredIds.length);
        expect(seeded.refused).toBe(0);

        // The live row's report package derives over the DURABLE basis
        // (FRESH SQL reads) with OFFLINE DIGEST PARITY — the live
        // confirmation rides the same recorded-basis machinery (the
        // recorded basis is never re-priced, never re-adjudicated).
        const durableWorld = await reportWorldOverDurableBasis({ db: database_, world });
        const offlineWorld = loadRealReportWorld();
        const boundaryReport = reportPackageFor(row, durableWorld);
        const offlineReport = reportPackageFor(row, offlineWorld);
        expect(boundaryReport.packageDigest, row.rowId).toBe(offlineReport.packageDigest);
        expect(JSON.stringify(boundaryReport), row.rowId).toBe(JSON.stringify(offlineReport));

        const client = createZeckClient({
          baseUrl: address,
          token: world.bearerToken,
          applicationId: world.applicationId,
          fetchImpl: globalThis.fetch,
        });

        // ---- the REAL live gate confirmation: ONE REAL dispatch on the
        // pinned rail, its execution landed over the REAL platform path
        // with the dispatch recorded through the REAL recorder ----
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalMeasuredCost = 0n;
        let successfulDispatches = 0;
        const measuredDispatches: {
          readonly inputTokens: number;
          readonly outputTokens: number;
        }[] = [];
        const dispatchDigests: string[] = [];
        const receipt = (
          await client.createExecution(
            { applicationId: world.applicationId, task: reportTaskBodyFor({ row }) },
            `val-052-live-crown-${row.rowId}`,
          )
        ).receipt;
        expect(receipt.replayed).toBe(false);
        await driveLiveReportExecutionToTerminal({
          world,
          executionId: receipt.executionId,
          rowId: row.rowId,
          packageDigest: boundaryReport.packageDigest,
          terminal: "pass",
          dispatch: async () => {
            // Provider-side pacing before the live dispatch.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            dispatches += 1;
            const startedAt = Date.now();
            const response = await fetch(LIVE_REPORT_PLAN.rail.endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: LIVE_REPORT_PLAN.rail.model,
                max_tokens: LIVE_REPORT_PLAN.rail.maxTokens,
                messages: [
                  {
                    role: "user",
                    content: `Reply with the single word: ok (final-report gate confirmation dispatch ${dispatches})`,
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
            measuredDispatches.push({ inputTokens, outputTokens });
            const digest = economicDigestOf({
              rowId: row.rowId,
              dispatch: dispatches,
              inputTokens,
              outputTokens,
              measuredCostMicroUsd: measuredCost.toString(),
              wallclockMs,
              planDigest: liveReportPlanDigestOf(),
            });
            dispatchDigests.push(digest);
            return digest;
          },
        });

        // A REAL dispatch happened on the pinned rail — the live
        // slice's own usage MEASURED (never estimated, never
        // fabricated) and the measured facts bounds-checked against
        // the recorded live-window bounds: the provider's completion
        // stays inside the pinned max_tokens request bound (a
        // completion beyond the pinned bound means the rail mis-served
        // the pinned request — the measured slice FAILs NAMED).
        expect(dispatches).toBe(LIVE_REPORT_PLAN.dispatches);
        expect(totalInputTokens + totalOutputTokens).toBeGreaterThan(0);
        for (const measured of measuredDispatches) {
          expect(measured.outputTokens).toBeLessThanOrEqual(LIVE_REPORT_PLAN.rail.maxTokens);
        }
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

        // The THIRTEEN oracles re-derived AT THE BOUNDARY over the
        // durable basis — ALL PASS — and the boundary verdict equals
        // the offline verdict (the verdict derives over the RECORDED
        // governed basis; the live dispatch confirms the platform path
        // end-to-end — it never re-prices or re-adjudicates the
        // recorded basis, and the recorded verdicts stay untouched).
        const criteria = verifyFinalReportIntegrity({
          row,
          world: durableWorld,
          report: boundaryReport,
        });
        const failed = criteria.filter((criterion) => criterion.status === "FAIL");
        expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
        expect(criteria).toHaveLength(13);
        const verdict = deriveReleaseGateVerdict({
          row,
          world: durableWorld,
          report: boundaryReport,
        });
        expect(verdict.verdict).toBe("COMPLETED");
        expect(verdict.failedCriteria).toEqual([]);
        expect(verdict).toEqual(
          deriveReleaseGateVerdict({ row, world: offlineWorld, report: offlineReport }),
        );

        // The live dispatch recorded through the REAL recorder: ONE
        // live-dispatch step event, DIGEST-ONLY (the measured facts
        // ride the digest; payload bytes never land).
        const recordedDispatches = await database_.execute<{
          readonly reference: { readonly kind?: string; readonly digest?: string };
          readonly payload: Record<string, unknown>;
        }>({
          sql: `SELECT e.reference, e.payload FROM executions.execution_events e
                  JOIN executions.executions x ON e.execution_id = x.id
                  WHERE x.task->>'kind' = $1 AND x.task->>'rowId' = $2
                    AND e.command = 'agent-action-recorded'
                    AND e.payload->>'kind' = 'live-dispatch-usage'`,
          parameters: [REPORT_TASK_KIND, row.rowId],
        });
        expect(recordedDispatches.rows.length).toBe(LIVE_REPORT_PLAN.dispatches);
        const recordedDigests = recordedDispatches.rows.map((event) => event.reference.digest);
        for (const event of recordedDispatches.rows) {
          expect(event.reference.kind).toBe("live-dispatch-usage");
          expect(event.reference.digest).toMatch(/^[0-9a-f]{8}$/);
          expect(Object.keys(event.payload).sort()).toEqual(["kind", "ordinal"]);
        }
        for (const digest of dispatchDigests) {
          expect(recordedDigests).toContain(digest);
        }

        // The live confirmation's durable surface: ONE terminal report
        // execution under the report's own customer identity over REAL
        // SQL (the public read boundary serves the same truth).
        const durable = await database_.execute<{
          id: string;
          status: string;
          application_id: string;
        }>({
          sql: `SELECT id::text AS id, status, application_id::text AS application_id
                  FROM executions.executions
                  WHERE task->>'kind' = $1 AND task->>'rowId' = $2
                  ORDER BY created_at ASC, id ASC`,
          parameters: [REPORT_TASK_KIND, row.rowId],
        });
        expect(durable.rows.length).toBe(1);
        expect(durable.rows[0]?.status).toBe("COMPLETED");
        expect(durable.rows[0]?.application_id).toBe(world.applicationId);
        const firstTerminal = await client.getExecution(durable.rows[0]?.id ?? "");
        expect(firstTerminal.status).toBe("COMPLETED");

        drivenLive.push(
          `${row.rowId} -> ${verdict.verdict} dispatches=${dispatches} ` +
            `measuredUsage=${totalInputTokens}+${totalOutputTokens}tokens ` +
            `measured=${totalMeasuredCost.toString()}µ$ successful=${successfulDispatches}`,
        );
        console.info(`[VAL-052]   LIVE ${row.rowId} -> ${verdict.verdict} ${drivenLive.at(-1)}`);
      }

      console.info(
        `[VAL-052] LIVE rail summary: ${drivenLive.length} REAL live gate-confirmation slice(s) driven over ` +
          `the pinned OpenRouter rail (ONE REAL dispatch each, measured usage priced at the pinned ` +
          `manifest revision, the measured facts bounds-checked against the recorded live-window ` +
          `bounds, the execution landed through the REAL platform path — the public create ` +
          `boundary, the REAL state machine, the REAL recorder — and the THIRTEEN oracles ` +
          `re-derived over the durable basis with offline digest parity; the recorded verdicts ` +
          `stay untouched — the live lane measures fresh facts, it never re-adjudicates them).`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-052] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live confirmation happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(drivenLive.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
