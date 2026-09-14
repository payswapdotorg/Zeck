/**
 * VAL-036 acceptance criteria 3 + 5 + 7 — the REAL end-to-end
 * integration crown: the offline maturity corpus driven over the REAL
 * platform path over REAL PostgreSQL.
 *
 * Test 1 (the offline corpus): every row's maturity analysis end to end
 * — the customer application riding the REAL public SDK wire (ONE
 * maturity submission per row landing its OWN durable execution under
 * its OWN idempotency key → the completion poll → the result read →
 * the events read), the RECORDED LIFECYCLE HISTORY + ACCOUNTING
 * (VAL-032..035's recorded facts, pre-seeded) served READ-ONLY from
 * REAL SQL through the platform slice's analysis port (the facts
 * digest snapshotted from FRESH SQL reads before and after every run —
 * the recorded history is a frozen input; a different-content commit
 * under a recorded key THROWS), the mechanically derived maturity
 * verdict + curve facts + savings reconciliation per row (every leg of
 * `deriveMaturityRowCriteria`), the trustworthy analysis's MATURITY
 * REPORT appended to the append-only report ledger over REAL SQL (the
 * identical re-drive REPLAYS, an impostor report is REFUSED), the
 * honest refusals appending NOTHING, the maturity trajectory flush
 * through the REAL recorder path, the measured latencies, the honest
 * none-reported offline usage, and the app's honest observations over
 * the public wire.
 *
 * Test 2 (the live rail): the env-gated REAL measured round through
 * the REAL platform model gateway — an absent OPENROUTER_API_KEY is an
 * honest NOT RUN boundary (logged, skipped, never fabricated); the
 * live-path code (the REAL model gateway dispatch, measured usage) is
 * fully wired for when the credential lands.
 *
 * Digest-only assertions everywhere (payload bytes never journaled);
 * no credentials in the repository, logs or reports.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runDeterminizationMaturityApp } from "../../../benchmarks/validation/apps/determinization-maturity/application";
import {
  DETERMINIZATION_MATURITY_CORPUS,
  FAMILY_HISTORIES,
  liveGateOpen,
  maturitySubmissionKey,
  maturityTaskBodyFor,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/determinization-maturity/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type {
  AccountingLedgerEntry,
  FamilyLifecycleRecord,
  MaturityAnalysisFacts,
  MaturityAnalysisPort,
  MaturityCorpusRow,
  MaturityReportPort,
  MaturityReportRecord,
  MaturityRunResult,
  PromotionGenerationRecord,
} from "../../../benchmarks/validation/platform/determinization-maturity";
import {
  accountingEntryDigestOf,
  curvePointDigestOf,
  driveMaturityAnalysis,
  familyLifecycleDigestOf,
  generationRecordDigestOf,
  maturityCitationDigestOf,
  maturityInputDigestOf,
  maturityReportDigestOf,
  maturityTrajectoryStepsOf,
} from "../../../benchmarks/validation/platform/determinization-maturity";
import type { CandidateKind } from "../../../benchmarks/validation/platform/learning-discovery";
import type {
  ControlDispatch,
  TrajectoryStepKind,
  TrajectoryStepRecord,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import {
  longitudinalDigestOf,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
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
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.ZECK_VAL_036_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-036|determinization-maturity|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const LIFECYCLE_HISTORY_OPERATION = "val-036.lifecycle-history";
const GENERATION_HISTORY_OPERATION = "val-036.generation-history";
const ACCOUNTING_HISTORY_OPERATION = "val-036.accounting-history";
const MATURITY_REPORT_OPERATION = "val-036.maturity-reports";

/** The maturity task kind (the landed execution's task grammar). */
const MATURITY_TASK_KIND = "determinization-maturity.learning-curve.v1";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly familyId: string;
  readonly classification: string;
  readonly generations: number;
  readonly reportLanded: string;
  readonly savingsTotalMicroUsd: number;
  readonly modelCalls: string;
  readonly latencyMs: number;
  readonly appSubmissionLatencyMs: number;
  readonly appTerminal: string | null;
  readonly usage: string;
  readonly keysDigest: string;
  readonly bodyDigest: string;
}

/** The app's own outcome (the settled app promise's payload). */
interface AppOutcome {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<typeof runDeterminizationMaturityApp>>;
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's maturity ports)
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
): Promise<void> {
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
        "different content — the recorded lifecycle history is a read-only input",
    );
  }
}

/**
 * The REAL SQL recorded lifecycle history + accounting (VAL-032..035's
 * read-only input, pre-seeded): every family's lifecycle records
 * (keyed by the family + the record's 1-based POSITION within it — the
 * val-032 position-key lesson), promotion generations (keyed by the
 * family + the 1-based generation ordinal) and accounting ledger
 * entries (keyed by the family + the entry's 1-based POSITION within
 * the family's ledger — restarts never re-key) are committed through
 * the REAL unique-index arbitration with the record's canonical
 * payload-free digest as the request fingerprint. The port serves the
 * recorded facts read-only from a SQL-loaded snapshot; every read-only
 * proof re-reads FRESH SQL rows (refreshFacts).
 */
async function seedRealMaturityHistory(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly analysis: MaturityAnalysisPort;
  readonly refreshFacts: () => Promise<MaturityAnalysisFacts>;
}> {
  const generateId = createUuidv7Generator();
  for (const history of FAMILY_HISTORIES) {
    for (const [index, record] of history.lifecycleRecords.entries()) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        LIFECYCLE_HISTORY_OPERATION,
        `${history.familyId}::lifecycle-${index + 1}`,
        familyLifecycleDigestOf(record),
        { ...record },
      );
    }
    for (const generation of history.generations) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        GENERATION_HISTORY_OPERATION,
        `${history.familyId}::generation-${generation.generation}`,
        generationRecordDigestOf(generation),
        { ...generation, perMechanismDisplacements: { ...generation.perMechanismDisplacements } },
      );
    }
    for (const [index, entry] of history.accountingEntries.entries()) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        ACCOUNTING_HISTORY_OPERATION,
        `${history.familyId}::entry-${index + 1}`,
        accountingEntryDigestOf(entry),
        { ...entry },
      );
    }
  }

  type SqlRow = {
    readonly idempotency_key: string;
    readonly durable_outcome: Record<string, unknown>;
  };
  const readRows = async (operation: string): Promise<readonly SqlRow[]> => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      durable_outcome: Record<string, unknown>;
    }>({
      sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, operation],
    });
    return rows.rows;
  };

  const parseLifecycle = (rows: readonly SqlRow[]): FamilyLifecycleRecord[] =>
    rows.flatMap((row) => {
      const familyId = typeof row.durable_outcome?.familyId === "string";
      const proposalId = typeof row.durable_outcome?.proposalId === "string";
      const kind = typeof row.durable_outcome?.kind === "string";
      const generation = typeof row.durable_outcome?.generation === "number";
      const evidenceDigest = typeof row.durable_outcome?.evidenceDigest === "string";
      if (!familyId || !proposalId || !kind || !generation || !evidenceDigest) {
        return [];
      }
      return [
        {
          familyId: row.durable_outcome.familyId as string,
          proposalId: row.durable_outcome.proposalId as string,
          kind: row.durable_outcome.kind as CandidateKind,
          generation: row.durable_outcome.generation as number,
          evidenceDigest: row.durable_outcome.evidenceDigest as string,
        },
      ];
    });

  const parseGenerations = (rows: readonly SqlRow[]): PromotionGenerationRecord[] =>
    rows.flatMap((row) => {
      const familyId = typeof row.durable_outcome?.familyId === "string";
      const generation = typeof row.durable_outcome?.generation === "number";
      const baselineModelCalls = typeof row.durable_outcome?.baselineModelCalls === "number";
      const displacedModelCalls = typeof row.durable_outcome?.displacedModelCalls === "number";
      const measuredCostMicroUsd = typeof row.durable_outcome?.measuredCostMicroUsd === "number";
      const measuredLatencyMs = typeof row.durable_outcome?.measuredLatencyMs === "number";
      const measured = typeof row.durable_outcome?.measured === "boolean";
      const perMechanism =
        row.durable_outcome?.perMechanismDisplacements === null ||
        row.durable_outcome?.perMechanismDisplacements === undefined
          ? null
          : (row.durable_outcome.perMechanismDisplacements as Record<string, unknown>);
      const lifecycleProposalIds = Array.isArray(row.durable_outcome?.lifecycleProposalIds)
        ? (row.durable_outcome.lifecycleProposalIds as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : null;
      if (
        !familyId ||
        !generation ||
        !baselineModelCalls ||
        !displacedModelCalls ||
        !measuredCostMicroUsd ||
        !measuredLatencyMs ||
        !measured ||
        perMechanism === null ||
        lifecycleProposalIds === null
      ) {
        return [];
      }
      const mechanisms = perMechanism as Record<string, unknown>;
      const numbers = ["reuse", "cache", "competence", "deterministicization"].map(
        (mechanism) => mechanisms[mechanism],
      );
      if (numbers.some((value) => typeof value !== "number")) {
        return [];
      }
      return [
        {
          familyId: row.durable_outcome.familyId as string,
          generation: row.durable_outcome.generation as number,
          baselineModelCalls: row.durable_outcome.baselineModelCalls as number,
          displacedModelCalls: row.durable_outcome.displacedModelCalls as number,
          measuredCostMicroUsd: row.durable_outcome.measuredCostMicroUsd as number,
          measuredLatencyMs: row.durable_outcome.measuredLatencyMs as number,
          perMechanismDisplacements: {
            reuse: mechanisms.reuse as number,
            cache: mechanisms.cache as number,
            competence: mechanisms.competence as number,
            deterministicization: mechanisms.deterministicization as number,
          },
          measured: row.durable_outcome.measured as boolean,
          lifecycleProposalIds,
        },
      ];
    });

  const parseAccounting = (rows: readonly SqlRow[]): AccountingLedgerEntry[] =>
    rows.flatMap((row) => {
      const familyId = typeof row.durable_outcome?.familyId === "string";
      const generation = typeof row.durable_outcome?.generation === "number";
      const mechanism = typeof row.durable_outcome?.mechanism === "string";
      const microUsd = typeof row.durable_outcome?.microUsd === "number";
      const latencyDeltaMs = typeof row.durable_outcome?.latencyDeltaMs === "number";
      if (!familyId || !generation || !mechanism || !microUsd || !latencyDeltaMs) {
        return [];
      }
      return [
        {
          familyId: row.durable_outcome.familyId as string,
          generation: row.durable_outcome.generation as number,
          mechanism: row.durable_outcome.mechanism as CandidateKind,
          microUsd: row.durable_outcome.microUsd as number,
          latencyDeltaMs: row.durable_outcome.latencyDeltaMs as number,
        },
      ];
    });

  // The read-through snapshot: loaded from the REAL durable rows once,
  // served synchronously through the port contract.
  const [lifecycleRows, generationRows, accountingRows] = await Promise.all([
    readRows(LIFECYCLE_HISTORY_OPERATION),
    readRows(GENERATION_HISTORY_OPERATION),
    readRows(ACCOUNTING_HISTORY_OPERATION),
  ]);
  const lifecycle = parseLifecycle(lifecycleRows);
  const generations = parseGenerations(generationRows);
  const accounting = parseAccounting(accountingRows);
  const lifecycleByFamily = new Map<string, FamilyLifecycleRecord[]>();
  for (const record of lifecycle) {
    const members = lifecycleByFamily.get(record.familyId) ?? [];
    members.push(record);
    lifecycleByFamily.set(record.familyId, members);
  }
  const generationsByFamily = new Map<string, PromotionGenerationRecord[]>();
  for (const generation of generations) {
    const members = generationsByFamily.get(generation.familyId) ?? [];
    members.push(generation);
    generationsByFamily.set(generation.familyId, members);
  }
  const accountingByFamily = new Map<string, AccountingLedgerEntry[]>();
  for (const entry of accounting) {
    const members = accountingByFamily.get(entry.familyId) ?? [];
    members.push(entry);
    accountingByFamily.set(entry.familyId, members);
  }
  let snapshotFacts: MaturityAnalysisFacts = {
    familyIds: [...lifecycleByFamily.keys()].sort(),
    lifecycleRecordCount: lifecycle.length,
    generationRecordCount: generations.length,
    accountingEntryCount: accounting.length,
    registryProposalIds: lifecycle.map((record) => record.proposalId).sort(),
  };

  return {
    analysis: {
      lifecycleFor: (familyId: string) =>
        (lifecycleByFamily.get(familyId) ?? []).map((record) => ({ ...record })),
      generationsFor: (familyId: string) =>
        (generationsByFamily.get(familyId) ?? []).map((generation) => ({
          ...generation,
          perMechanismDisplacements: { ...generation.perMechanismDisplacements },
          lifecycleProposalIds: [...generation.lifecycleProposalIds],
        })),
      accountingFor: (familyId: string) =>
        (accountingByFamily.get(familyId) ?? []).map((entry) => ({ ...entry })),
      proposalFor: (proposalId: string) => {
        const record = lifecycle.find((member) => member.proposalId === proposalId);
        return record === undefined
          ? null
          : {
              proposalId,
              kind: record.kind,
              citation: { trajectoryDigests: [], replayIdentities: [] },
              minedStructureDigest: record.evidenceDigest,
              lifecycleStage: "promoted" as const,
            };
      },
      facts: () => snapshotFacts,
    },
    refreshFacts: async () => {
      const [freshLifecycle, freshGenerations, freshAccounting] = await Promise.all([
        readRows(LIFECYCLE_HISTORY_OPERATION),
        readRows(GENERATION_HISTORY_OPERATION),
        readRows(ACCOUNTING_HISTORY_OPERATION),
      ]);
      const lifecycleRecords = parseLifecycle(freshLifecycle);
      const generationRecords = parseGenerations(freshGenerations);
      const accountingEntries = parseAccounting(freshAccounting);
      const familyIds = new Set<string>();
      for (const record of lifecycleRecords) {
        familyIds.add(record.familyId);
      }
      snapshotFacts = {
        familyIds: [...familyIds].sort(),
        lifecycleRecordCount: lifecycleRecords.length,
        generationRecordCount: generationRecords.length,
        accountingEntryCount: accountingEntries.length,
        registryProposalIds: lifecycleRecords.map((record) => record.proposalId).sort(),
      };
      return snapshotFacts;
    },
  };
}

/** The REAL SQL read-back of the durable maturity reports (the truth). */
async function readMaturityReports(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<
  readonly {
    readonly familyId: string;
    readonly classification: string;
    readonly curvePointDigests: readonly string[];
    readonly savings: {
      readonly totalMicroUsd: number;
      readonly perMechanism: Record<string, number> | null;
    };
    readonly citationDigest: string;
    readonly ordinal: number;
  }[]
> {
  const rows = await ctx.port.execute<{
    idempotency_key: string;
    durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, MATURITY_REPORT_OPERATION],
  });
  return rows.rows.flatMap((sqlRow) => {
    const familyId = typeof sqlRow.durable_outcome?.familyId === "string";
    const classification = typeof sqlRow.durable_outcome?.classification === "string";
    const citationDigest = typeof sqlRow.durable_outcome?.citationDigest === "string";
    const ordinal = typeof sqlRow.durable_outcome?.ordinal === "number";
    const curvePointDigests = Array.isArray(sqlRow.durable_outcome?.curvePointDigests)
      ? (sqlRow.durable_outcome.curvePointDigests as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    const savings =
      sqlRow.durable_outcome?.savings === null || sqlRow.durable_outcome?.savings === undefined
        ? null
        : (sqlRow.durable_outcome.savings as Record<string, unknown>);
    if (
      !familyId ||
      !classification ||
      !citationDigest ||
      !ordinal ||
      curvePointDigests === null ||
      savings === null ||
      typeof savings.totalMicroUsd !== "number"
    ) {
      return [];
    }
    const perMechanism =
      savings.perMechanism === null || savings.perMechanism === undefined
        ? null
        : (savings.perMechanism as Record<string, number>);
    return [
      {
        familyId: sqlRow.durable_outcome.familyId as string,
        classification: sqlRow.durable_outcome.classification as string,
        curvePointDigests,
        savings: { totalMicroUsd: savings.totalMicroUsd, perMechanism },
        citationDigest: sqlRow.durable_outcome.citationDigest as string,
        ordinal: sqlRow.durable_outcome.ordinal as number,
      },
    ];
  });
}

/**
 * The REAL per-run maturity report ledger (APPEND-ONLY over REAL SQL):
 * the report's canonical payload-free digest as the request
 * fingerprint under the family's key — an identical re-append REPLAYS
 * (idempotent), a different report under the same familyId is REFUSED.
 * The synchronous read view rides an in-memory mirror; the SQL
 * read-back is the durable truth.
 */
function createRealMaturityReportLedger(ctx: PgContext, world: ApiPgWorld): MaturityReportPort {
  const generateId = createUuidv7Generator();
  const mirror = new Map<string, MaturityReportRecord>();
  return {
    append: async (record) => {
      const ordinal = mirror.size + 1;
      const fingerprint = maturityReportDigestOf(record);
      const receipt = await arbitrate(
        ctx,
        world,
        generateId,
        MATURITY_REPORT_OPERATION,
        `${record.familyId}::maturity-report`,
        fingerprint,
        {
          familyId: record.familyId,
          classification: record.classification,
          curvePointDigests: [...record.curvePointDigests],
          savings: {
            totalMicroUsd: record.savings.totalMicroUsd,
            perMechanism:
              record.savings.perMechanism === null ? null : { ...record.savings.perMechanism },
          },
          citationDigest: record.citationDigest,
          ordinal,
        },
      );
      if (!receipt.refused && !mirror.has(record.familyId)) {
        mirror.set(record.familyId, { ...record, ordinal });
      }
      return receipt;
    },
    reportsFor: (familyId: string) => {
      const record = mirror.get(familyId);
      return record === undefined ? [] : [{ ...record }];
    },
  };
}

// ---------------------------------------------------------------------------
// The REAL lifecycle driving (the landed execution's state machine)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: MaturityCorpusRow,
  generateId: () => string,
): Promise<void> {
  const transitionCounter = { count: 0 };
  const transition = async (command: "authorize" | "plan" | "queue" | "start"): Promise<void> => {
    transitionCounter.count += 1;
    await world.executions.transition(
      {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        command,
        reason: `val-036-${command}`,
      },
      `val-036-${executionId}-${command}-${transitionCounter.count}`,
    );
  };
  await transition("authorize");
  await transition("plan");
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
            strategyId: "val-036-maturity",
            plan: {
              strategyClass: "determinization-maturity",
              // The maturity run's OWN dispatch demand — the route read
              // surfaces it at the customer boundary (zero offline; the
              // live row's ONE REAL measured round).
              modelCalls: row.expected.modelCalls,
              steps: [
                {
                  routeRef: {
                    provider: row.needsDispatch ? "openrouter" : "deterministic-fixture",
                    model: row.needsDispatch ? MODEL : "none",
                  },
                },
              ],
            },
          },
        ],
        selectedStrategyId: "val-036-maturity",
      },
    },
    `val-036-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/** The verification boundary + the terminal for ONE maturity run's landed execution. */
async function completeMaturityExecution(
  world: ApiPgWorld,
  executionId: string,
  result: MaturityRunResult,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-036-verify",
    },
    `val-036-${executionId}-verify`,
  );
  const verdict = result.terminal === "COMPLETED" ? "pass" : "fail";
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: verdict,
      reason:
        verdict === "pass"
          ? "val-036-verified"
          : `val-036-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-036-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-036-${executionId}-${verdict}`,
  );
}

/** Await the row's landed maturity execution (the app's submission over the public wire). */
async function awaitLandedMaturityExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: MaturityCorpusRow,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY id ASC`,
      parameters: [world.applicationId, MATURITY_TASK_KIND, row.rowId, [...driven]],
    });
    if (rows.rows.length >= 1) {
      if (rows.rows.length !== 1) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its maturity run ` +
            `(${rows.rows.length} > 1)`,
        );
      }
      const executionId = rows.rows[0]?.id as string;
      driven.add(executionId);
      return executionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no landed maturity execution for row ${row.rowId} after 120s (expected 1 durable execution)`,
  );
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the REAL model gateway — the live row's seam)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live row's measured seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: ControlDispatch }> {
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
        return { satisfied: true, catalogRevision: "val-036", satisfactions: [] };
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
      label: "val-036-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-036-conn-${generateId().slice(-8)}`,
  );

  const dispatch: ControlDispatch = async ({ round, attempt }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the maturity-confirmation supervisor of a governed validation execution.",
            "You receive the determinization-maturity run's measured confirmation request and",
            "decide whether the family's maturity analysis may append its report. Answer with",
            "the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Determinization-maturity confirmation round (golden:live-confirmation, round ${round}, ` +
            `attempt ${attempt}). Confirm the measured dispatch.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure" as const,
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${response.content
            .join("\n")
            .slice(0, 120)}`,
          latencyMs,
        };
      }
      return { kind: "success" as const, usage, latencyMs };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure" as const,
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

/** Map one maturity trajectory step onto the recorded step-event journal shape. */
function trajectoryStepRecordOf(
  rowId: string,
  step: { readonly kind: string; readonly detail: string },
  ordinal: number,
): TrajectoryStepRecord {
  const kind: TrajectoryStepKind = step.kind.startsWith("maturity:report")
    ? "effect"
    : step.kind.startsWith("maturity:immaturity")
      ? "verification"
      : "dispatch";
  const detail = `${step.kind}:${step.detail}`;
  return { ordinal, kind, detail, digest: longitudinalDigestOf([rowId, step.kind, step.detail]) };
}

/**
 * Drive one corpus row's maturity run crown-style: the app rides the
 * public wire (ONE maturity submission → the completion poll → the
 * result read → the events read) while the crown waits for the landed
 * execution and drives the REAL lifecycle around the analysis (the
 * prologue transitions → the maturity analysis through the platform
 * driver with the REAL SQL read-only analysis port and the REAL SQL
 * append-only report ledger → the recorded-history digest snapshots
 * before and after from FRESH SQL reads → the maturity trajectory
 * flush through the REAL recorder path → the verification boundary +
 * the mechanically derived terminal).
 */
async function driveCrownMaturity(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: MaturityCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly analysis: MaturityAnalysisPort;
  readonly refreshFacts: () => Promise<MaturityAnalysisFacts>;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
  /** Whether this run is the FIRST analysis of its family in the corpus (a fresh report append). */
  readonly freshReport: boolean;
}): Promise<{
  readonly executionId: string;
  readonly result: MaturityRunResult;
  readonly appSettled: AppOutcome;
  readonly factsDigestBefore: string;
  readonly factsDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
  readonly freshReport: boolean;
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runDeterminizationMaturityApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: row.needsDispatch ? 240_000 : 120_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-036-determinization-maturity" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed maturity execution (the app's submission through the
  // public wire — ONE durable execution per row).
  const executionId = await awaitLandedMaturityExecution(options.ctx, world, options.driven, row);

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the maturity analysis drives over the REAL state
  // machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The recorded-history read-only snapshot BEFORE the analysis (a
  // FRESH REAL SQL read — the read-only proof's basis).
  const factsDigestBefore = maturityInputDigestOf(await options.refreshFacts());

  // The maturity analysis through the platform driver with the REAL
  // SQL read-only analysis port and the REAL SQL append-only report
  // ledger.
  const reportLedger = createRealMaturityReportLedger(options.ctx, world);
  const result = await driveMaturityAnalysis({
    row,
    analysis: options.analysis,
    reportLedger,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The recorded-history read-only snapshot AFTER the analysis (a
  // FRESH REAL SQL read — the read-only proof over REAL SQL).
  const factsDigestAfter = maturityInputDigestOf(await options.refreshFacts());

  // The maturity trajectory flush through the REAL recorder path: the
  // run's canonical maturity steps journal into its landed execution
  // while the execution is RUNNING — the step events project back onto
  // the pinned maturity trajectory (verified below over REAL SQL).
  const steps = maturityTrajectoryStepsOf({
    rowId: row.rowId,
    verdict: result.verdict,
    generationCount: row.curveSeries.length,
    reportAppended: result.verdict === "maturity-established",
  });
  const trajectorySteps = steps.map((step, index) =>
    trajectoryStepRecordOf(row.rowId, step, index + 1),
  );
  for (const step of trajectorySteps) {
    await world.executions.recordStepEvent(
      {
        applicationId: world.applicationId,
        executionId,
        actor: { actorId: world.actorId, tenantId: world.tenantId },
        command: "agent-action-recorded",
        cause: `val-036-${step.kind}-${step.ordinal}`,
        reference: {
          kind: step.kind,
          ordinal: step.ordinal,
          detail: step.detail,
          digest: step.digest,
        },
        payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
      },
      `val-036-${executionId}-${step.kind}-${step.ordinal}`,
    );
  }

  // The verification boundary + the mechanically derived terminal.
  await completeMaturityExecution(world, executionId, result);

  const appSettled = await appPromise;
  return {
    executionId,
    result,
    appSettled,
    factsDigestBefore,
    factsDigestAfter,
    trajectorySteps,
    freshReport: options.freshReport,
  };
}

// ---------------------------------------------------------------------------
// The per-row mechanical verification (over the REAL SQL)
// ---------------------------------------------------------------------------

/** Parse one REAL journal step kind (the trajectory vocabulary — honest on unknowns). */
function trajectoryStepKindOf(kind: string): TrajectoryStepKind {
  if (kind === "dispatch" || kind === "effect" || kind === "verification") {
    return kind;
  }
  throw new Error(`the REAL journal holds an unknown trajectory step kind: ${kind}`);
}

/**
 * Verify one row's crown outcome mechanically: the platform's maturity
 * verdict (the terminal, every criterion, the citation / curve /
 * classification / savings / honesty legs, the report landing, the
 * read-only input proof over FRESH REAL SQL reads), the REAL journal
 * projection (the maturity trajectory reproduction through the REAL
 * recorder path — the projected digest IS the canonical steps' digest,
 * the ordinals and sequences gapless), the durable terminal, the REAL
 * SQL report ledger (the report's classification + curve digests +
 * per-mechanism savings + citation digest — one per analyzed family),
 * and the app's honest observations over the public wire.
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: MaturityCorpusRow;
  readonly executionId: string;
  readonly result: MaturityRunResult;
  readonly appSettled: AppOutcome;
  readonly factsDigestBefore: string;
  readonly factsDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
  readonly freshReport: boolean;
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;

  // ---- the honest maturity contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-036][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-036][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
        );
      }
    }
  }
  expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  // The verdict reproduces the pinned oracle.
  expect(result.verdict, `${row.rowId} verdict kind`).toBe(row.expected.verdict);
  expect(result.refusal?.reason ?? null, `${row.rowId} refusal reason`).toBe(
    row.expected.refusalReason,
  );
  if (result.refusal === null) {
    // Every leg of the honest analysis: fully cited, gapless, faithful,
    // reconciled, measured.
    expect(result.citation?.complete, `${row.rowId} citation complete`).toBe(true);
    expect(result.curveIntegrity?.integral, `${row.rowId} curve integral`).toBe(true);
    expect(result.classification?.fidelity, `${row.rowId} classification faithful`).toBe(true);
    expect(result.savingsReconciliation?.reconciled, `${row.rowId} savings reconciled`).toBe(true);
    expect(result.honesty?.honest, `${row.rowId} honest`).toBe(true);
    expect(result.reportLanded?.accepted, `${row.rowId} report landed`).toBe(true);
    expect(
      result.reportLanded?.replayed,
      `${row.rowId} ${options.freshReport ? "fresh report" : "identical re-append REPLAYS"}`,
    ).toBe(!options.freshReport);
    expect(result.reportsAppended, `${row.rowId} one report`).toBe(1);
  } else {
    expect(result.refusalHonesty?.honest, `${row.rowId} refusal honest`).toBe(true);
    expect(result.reportsAppended, `${row.rowId} refusal appends nothing`).toBe(0);
    expect(result.reportLanded, `${row.rowId} refusal lands nothing`).toBeNull();
  }
  // The run made its OWN dispatches; usage honestly none offline.
  expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(row.expected.modelCalls);
  expect(result.latencyMs, `${row.rowId} latency measured`).toBeGreaterThanOrEqual(0);
  if (row.needsDispatch) {
    expect(result.usage === null || result.usage.inputTokens >= 0, `${row.rowId} live usage`).toBe(
      true,
    );
  } else {
    expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
  }

  // ---- the recorded-history read-only proof over FRESH REAL SQL reads ----
  expect(options.factsDigestAfter, `${row.rowId} recorded history digest after`).toBe(
    options.factsDigestBefore,
  );
  expect(
    result.criteria.find((c) => c.criterionId === "maturity-input-read-only")?.status,
    `${row.rowId} read-only leg`,
  ).toBe("PASS");

  // ---- the REAL SQL report ledger (the durable truth) ----
  const reports = await readMaturityReports(ctx, world);
  const familyReports = reports.filter((report) => report.familyId === row.familyId);
  if (row.expected.verdict === "maturity-established") {
    expect(familyReports, `${row.rowId} one durable report per family`).toHaveLength(1);
    const report = familyReports[0];
    expect(report?.classification, `${row.rowId} report classification`).toBe(
      row.claimedClassification,
    );
    expect(report?.citationDigest, `${row.rowId} report citation digest`).toBe(
      maturityCitationDigestOf(row.citation),
    );
    expect(report?.curvePointDigests, `${row.rowId} report curve digests`).toEqual(
      row.curveSeries.map((point) => curvePointDigestOf(point)),
    );
    expect(report?.savings.totalMicroUsd, `${row.rowId} report savings total`).toBe(
      row.claimedSavings.totalMicroUsd,
    );
    expect(report?.savings.perMechanism ?? null, `${row.rowId} report per-mechanism`).toEqual(
      row.claimedSavings.perMechanism,
    );
    expect(report?.ordinal, `${row.rowId} report append order`).toBe(1);
  }

  // ---- the REAL journal projection (the maturity trajectory) ----
  const stepRows = await ctx.port.execute<{
    ordinal: number;
    kind: string;
    detail: string;
    digest: string;
  }>({
    sql: `SELECT (reference->>'ordinal')::int AS ordinal, reference->>'kind' AS kind,
                   reference->>'detail' AS detail, reference->>'digest' AS digest
            FROM executions.execution_events
            WHERE execution_id = $1 AND type = 'execution.agent-action-recorded'
            ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const projection: TrajectoryStepRecord[] = stepRows.rows.map((step) => ({
    ordinal: step.ordinal,
    kind: trajectoryStepKindOf(step.kind),
    detail: step.detail,
    digest: step.digest,
  }));
  expect(projection.length, `${row.rowId} journal steps`).toBe(options.trajectorySteps.length);
  expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal maturity digest`).toBe(
    trajectoryDigestOf(options.trajectorySteps),
  );
  const ordinals = projection.map((step) => step.ordinal);
  expect(
    ordinals.every((ordinal, index) => ordinal === index + 1),
    `${row.rowId} ordinals: ${ordinals.join(",")}`,
  ).toBe(true);
  for (const [index, step] of projection.entries()) {
    expect(step.digest, `${row.rowId} step ${index + 1} digest`).toBe(
      options.trajectorySteps[index]?.digest,
    );
  }

  // ---- the durable terminal + the journal gaplessness ----
  const durable = await world.executions.getExecution(world.applicationId, options.executionId);
  expect(durable?.status, `${row.rowId} durable terminal`).toBe(row.expected.terminal);
  const events = await ctx.port.execute<{ sequence: number }>({
    sql: `SELECT sequence FROM executions.execution_events
          WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const sequences = events.rows.map((eventRow) => eventRow.sequence);
  expect(
    sequences.every((sequence, index) => sequence === index + 1),
    `${row.rowId} journal sequences: ${sequences.join(",")}`,
  ).toBe(true);

  // ---- the app's honest observations over the public wire ----
  expect(validateHarnessEvidence(app.evidence), `${row.rowId} app evidence valid`).toEqual([]);
  expect(app.submission.rejection, `${row.rowId} app submission`).toBeNull();
  expect(app.submission.replayed, `${row.rowId} app created (never a shoulder-in)`).toBe(false);
  expect(app.submission.executionId, `${row.rowId} app landed`).toBe(options.executionId);
  expect(app.observedTerminal, `${row.rowId} app terminal`).toBe(row.expected.terminal);
  expect(app.observedModelCalls, `${row.rowId} app model calls`).toBe(row.expected.modelCalls);
  expect(app.submissionLatencyMs, `${row.rowId} app submission latency measured`).toBeGreaterThan(
    0,
  );
  expect(app.verificationStatuses, `${row.rowId} app verification statuses`).not.toHaveLength(0);
  for (const status of app.verificationStatuses) {
    expect(status, `${row.rowId} app verification status`).toBe("PASS");
  }
  if (row.needsDispatch) {
    expect(app.usage === null || app.usage.inputTokens >= 0, `${row.rowId} app live usage`).toBe(
      true,
    );
  } else {
    expect(app.usage, `${row.rowId} app offline usage none-reported`).toBeNull();
  }
}

/** The app key digest (payload DIGEST only — never the key bytes). */
function keysDigestOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** The app body digest (payload DIGEST only — never the body bytes). */
function bodiesDigestOf(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-036 determinization maturity over the real platform path", (ctx) => {
  test("the offline maturity corpus drives the maturity analysis end to end over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const offlineRows = OFFLINE_CORPUS_ROWS;
      const analyzedFamilies = new Set<string>();
      // The REAL SQL recorded lifecycle history + accounting (the
      // read-only input VAL-032..035 produced, pre-seeded) and the
      // REAL SQL analysis port over it.
      const { analysis, refreshFacts } = await seedRealMaturityHistory(ctx, world);

      // The read-only bases over FRESH REAL SQL reads: the recorded
      // history's own facts digest and its durable row counts.
      const initialFacts = await refreshFacts();
      const initialFactsDigest = maturityInputDigestOf(initialFacts);
      const initialLifecycleRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, LIFECYCLE_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      const initialGenerationRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, GENERATION_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      const initialAccountingRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, ACCOUNTING_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      // The recorded history serves EXACTLY the pinned family facts.
      const expectedLifecycleRecords = FAMILY_HISTORIES.reduce(
        (total, history) => total + history.lifecycleRecords.length,
        0,
      );
      const expectedGenerationRecords = FAMILY_HISTORIES.reduce(
        (total, history) => total + history.generations.length,
        0,
      );
      const expectedAccountingEntries = FAMILY_HISTORIES.reduce(
        (total, history) => total + history.accountingEntries.length,
        0,
      );
      expect(initialLifecycleRows).toBe(expectedLifecycleRecords);
      expect(initialGenerationRows).toBe(expectedGenerationRecords);
      expect(initialAccountingRows).toBe(expectedAccountingEntries);
      expect(initialFacts.familyIds).toEqual(
        FAMILY_HISTORIES.map((history) => history.familyId).sort(),
      );

      for (const row of offlineRows) {
        const generateId = createUuidv7Generator();
        const runSuffix = `it-${generateId().slice(-8)}`;
        // The ABSOLUTE corpus index (the val-032 live-index lesson: the
        // app selects its row by the FULL-corpus index).
        const taskIndex = DETERMINIZATION_MATURITY_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        const appKey = maturitySubmissionKey({ runSuffix, taskIndex });
        const appBody = maturityTaskBodyFor({
          rowId: row.rowId,
          familyId: row.familyId,
        });
        // The first analysis of a family appends its report FRESH; the
        // later honest rows over the same family re-append the
        // IDENTICAL report (an append-only REPLAY, never a new row).
        // The honest-refusal families never append (nothing to report).
        const freshReport =
          row.expected.verdict === "maturity-established" && !analyzedFamilies.has(row.familyId);
        if (row.expected.verdict === "maturity-established") {
          analyzedFamilies.add(row.familyId);
        }
        const {
          executionId,
          result,
          appSettled,
          factsDigestBefore,
          factsDigestAfter,
          trajectorySteps,
          freshReport: rowFreshReport,
        } = await driveCrownMaturity({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          analysis,
          refreshFacts,
          driven,
          freshReport,
        });

        await verifyCrownRow({
          ctx,
          world,
          row,
          executionId,
          result,
          appSettled,
          factsDigestBefore,
          factsDigestAfter,
          trajectorySteps,
          freshReport: rowFreshReport,
        });

        // The app key's ledger record: ONE create arbitration per
        // maturity submission key (no ledger drift — the submission
        // landed its OWN durable execution under its OWN key).
        const keyRecords = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE application_id = $1 AND idempotency_key = $2
                AND operation_name = 'executions.create'`,
          parameters: [world.applicationId, appKey],
        });
        expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);

        const usage =
          result.usage === null
            ? "none-reported"
            : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
              (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: result.verdict,
          familyId: row.familyId,
          classification: row.claimedClassification,
          generations: row.curveSeries.length,
          reportLanded:
            result.refusal !== null
              ? "nothing-appended"
              : `accepted:${String(result.reportLanded?.accepted)}`,
          savingsTotalMicroUsd: row.claimedSavings.totalMicroUsd,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-036]   ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `family=${runFacts[runFacts.length - 1]?.familyId} ` +
            `classification=${runFacts[runFacts.length - 1]?.classification} ` +
            `generations=${runFacts[runFacts.length - 1]?.generations} ` +
            `report=${runFacts[runFacts.length - 1]?.reportLanded} ` +
            `savings=${runFacts[runFacts.length - 1]?.savingsTotalMicroUsd}u$ ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `appSubmission=${runFacts[runFacts.length - 1]?.appSubmissionLatencyMs}ms ` +
            `appTerminal=${runFacts[runFacts.length - 1]?.appTerminal ?? "none"} ` +
            `usage=${runFacts[runFacts.length - 1]?.usage} ` +
            `keysDigest=${runFacts[runFacts.length - 1]?.keysDigest} ` +
            `bodyDigest=${runFacts[runFacts.length - 1]?.bodyDigest}`,
        );
      }

      // ---- the battery-level integrity (the whole offline corpus) ----
      const drivenRows = runFacts.length;
      expect(drivenRows).toBe(offlineRows.length);

      // No phantom executions: exactly ONE durable execution per
      // maturity row (every run landed its OWN).
      const execCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

      // The idempotency ledger: exactly ONE create arbitration per
      // maturity submission key (no ledger drift).
      const keyCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = 'executions.create'`,
        parameters: [world.applicationId],
      });
      expect(Number(keyCount.rows[0]?.c ?? 0), "no ledger drift").toBe(drivenRows);

      // Zero orphan events.
      const orphans = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.execution_events e
            LEFT JOIN executions.executions x ON e.execution_id = x.id
            WHERE e.application_id = $1 AND x.id IS NULL`,
        parameters: [world.applicationId],
      });
      expect(Number(orphans.rows[0]?.c ?? 0), "zero orphan events").toBe(0);

      // The recorded lifecycle history over REAL SQL is UNCHANGED after
      // the whole corpus (the read-only input — identical facts digest,
      // identical durable row counts).
      const finalFacts = await refreshFacts();
      expect(maturityInputDigestOf(finalFacts), "the recorded history is unchanged").toBe(
        initialFactsDigest,
      );
      const finalLifecycleRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, LIFECYCLE_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      const finalGenerationRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, GENERATION_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      const finalAccountingRows = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, ACCOUNTING_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      expect(finalLifecycleRows).toBe(expectedLifecycleRecords);
      expect(finalGenerationRows).toBe(expectedGenerationRecords);
      expect(finalAccountingRows).toBe(expectedAccountingEntries);

      // The recorded history is append-only over REAL SQL: a
      // different-content commit under a recorded key THROWS (the
      // read-only input).
      const ragGeneration = FAMILY_HISTORIES[0]?.generations[0];
      if (ragGeneration === undefined) {
        throw new Error("the RAG family history holds no generations");
      }
      await expect(
        commitReadOnly(
          ctx,
          world,
          createUuidv7Generator(),
          GENERATION_HISTORY_OPERATION,
          `rag-retrieval::generation-${ragGeneration.generation}`,
          generationRecordDigestOf({
            ...ragGeneration,
            displacedModelCalls: ragGeneration.displacedModelCalls + 1,
          }),
          {
            ...ragGeneration,
            displacedModelCalls: ragGeneration.displacedModelCalls + 1,
            perMechanismDisplacements: { ...ragGeneration.perMechanismDisplacements },
          },
        ),
      ).rejects.toThrow("append-only violation");
      const generationRowsAfterImpostor = Number(
        (
          await ctx.port.execute<{ c: number }>({
            sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2`,
            parameters: [world.applicationId, GENERATION_HISTORY_OPERATION],
          })
        ).rows[0]?.c ?? 0,
      );
      expect(generationRowsAfterImpostor).toBe(expectedGenerationRecords);

      // The maturity report ledger over REAL SQL: exactly ONE durable
      // report per ANALYZED family (the established rows over a family
      // re-append the IDENTICAL report — replays, never new rows); the
      // refusal families hold none.
      const reports = await readMaturityReports(ctx, world);
      expect(new Set(reports.map((report) => report.familyId))).toEqual(analyzedFamilies);
      expect(reports).toHaveLength(analyzedFamilies.size);
      const reportClassifications = new Set(reports.map((report) => report.classification));
      for (const classification of [
        "determinized-stable",
        "determinizing-trending",
        "variable-resilient",
        "immature-insufficient-evidence",
      ]) {
        expect(reportClassifications.has(classification), `${classification} reported`).toBe(true);
      }

      // The report ledger is append-only exactly-once over REAL SQL:
      // the re-drive of an already-recorded analysis REPLAYS the
      // immutable report (never a new row), and a DIFFERENT report
      // under a recorded family is REFUSED.
      const replayRow = offlineRows.find(
        (row) => row.rowId === "rag-retrieval-determinized-stable",
      ) as MaturityCorpusRow;
      const replayLedger = createRealMaturityReportLedger(ctx, world);
      const replayedRun = await driveMaturityAnalysis({
        row: replayRow,
        analysis,
        reportLedger: replayLedger,
        now: () => new Date(),
      });
      expect(replayedRun.terminal).toBe("COMPLETED");
      expect(replayedRun.reportLanded?.accepted, "the re-drive replays the report").toBe(true);
      expect(replayedRun.reportLanded?.replayed, "the re-drive REPLAYS (exactly-once)").toBe(true);
      const reportsAfterReplay = await readMaturityReports(ctx, world);
      expect(reportsAfterReplay).toHaveLength(analyzedFamilies.size);
      const impostor = await replayLedger.append({
        familyId: "rag-retrieval",
        classification: "variable-resilient",
        curvePointDigests: replayRow.curveSeries.map((point) => curvePointDigestOf(point)),
        savings: replayRow.claimedSavings,
        citationDigest: maturityCitationDigestOf(replayRow.citation),
      });
      expect(impostor, "an impostor report is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const reportsAfterImpostor = await readMaturityReports(ctx, world);
      expect(reportsAfterImpostor).toHaveLength(analyzedFamilies.size);

      // The honest terminals + verdicts distribution (the pinned
      // oracle over the REAL platform path).
      const established = runFacts.filter((fact) => fact.verdict === "maturity-established");
      const refusals = runFacts.filter((fact) => fact.verdict === "immaturity-honest");
      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED");
      expect(established).toHaveLength(9);
      expect(refusals).toHaveLength(2);
      expect(completed).toHaveLength(runFacts.length);
      console.info(
        `[VAL-036] OFFLINE corpus summary: ${completed.length} COMPLETED of ${runFacts.length} driven ` +
          `maturity analyses (${established.length} maturity-established — the four honest classes ` +
          `(${[...reportClassifications].join(", ")}) with fully cited populations, gapless recorded ` +
          `series, faithful classifications and per-mechanism ledger-matched savings / ` +
          `${refusals.length} honest refusals — every refusal a COMPLETED run appending nothing); ` +
          `${initialLifecycleRows} lifecycle records + ${initialGenerationRows} promotion ` +
          `generations + ${initialAccountingRows} accounting entries served READ-ONLY from REAL ` +
          `SQL as the recorded history (the facts digest IDENTICAL after the whole corpus; a ` +
          `different-content commit under a recorded key THROWS); ${reports.length} durable maturity ` +
          `reports appended over REAL SQL (one per analyzed family — the report ledger is ` +
          `append-only: the re-drive REPLAYS, the impostor is REFUSED); ${drivenRows} durable ` +
          `executions, one per run — no phantoms, no ledger drift, zero orphan events; every ` +
          `maturity trajectory reproduced through the REAL recorder path (the projected digest IS ` +
          `the canonical steps' digest, journals gapless); usage honestly none-reported offline; ` +
          `latency measured, never estimated; digests only, payload bytes never journaled.`,
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the maturity run with a REAL measured round", {
    timeout: 600_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-036] OPENROUTER_API_KEY absent — the REAL live maturity row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every classification/citation/curve/savings/refusal path without credentials. " +
          "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
          "covering the default chat model — the live maturity run demands ONE REAL measured " +
          "model round through the REAL platform model gateway (measured usage, never estimated, " +
          "never fabricated) before the family's maturity report appends over REAL SQL.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const liveRows = DETERMINIZATION_MATURITY_CORPUS.filter((row) => row.liveGate !== undefined);
      const { analysis, refreshFacts } = await seedRealMaturityHistory(ctx, world);

      // ONE live dispatch binding for ALL live rows (the VAL-025 review
      // lesson): the connection and its sealed credential envelope are
      // registered ONCE and shared.
      let liveDispatch: ControlDispatch | undefined;
      for (const row of liveRows) {
        // The ABSOLUTE corpus index (the val-032 live-index lesson).
        const taskIndex = DETERMINIZATION_MATURITY_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement}`,
          );
          continue;
        }
        // Provider-side pacing before the live maturity run.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `live-${generateId().slice(-8)}`;
        if (liveDispatch === undefined) {
          liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
        }
        const dispatch: ControlDispatch = liveDispatch;
        const appKey = maturitySubmissionKey({ runSuffix, taskIndex });
        const appBody = maturityTaskBodyFor({
          rowId: row.rowId,
          familyId: row.familyId,
        });
        const {
          executionId,
          result,
          appSettled,
          factsDigestBefore,
          factsDigestAfter,
          trajectorySteps,
        } = await driveCrownMaturity({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          analysis,
          refreshFacts,
          driven,
          dispatch,
          freshReport: true,
        });

        await verifyCrownRow({
          ctx,
          world,
          row,
          executionId,
          result,
          appSettled,
          factsDigestBefore,
          factsDigestAfter,
          trajectorySteps,
          freshReport: true,
        });

        // The live row's usage is MEASURED (never estimated).
        expect(result.usage?.inputTokens ?? -1, `${row.rowId} live usage measured`).toBeGreaterThan(
          -1,
        );
        expect(result.observedModelCalls, `${row.rowId} one measured round`).toBe(1);

        const usage =
          result.usage === null
            ? "none-reported"
            : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
              (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: result.verdict,
          familyId: row.familyId,
          classification: row.claimedClassification,
          generations: row.curveSeries.length,
          reportLanded: `accepted:${String(result.reportLanded?.accepted)}`,
          savingsTotalMicroUsd: row.claimedSavings.totalMicroUsd,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-036]   LIVE ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `family=${runFacts[runFacts.length - 1]?.familyId} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `usage=${runFacts[runFacts.length - 1]?.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-036] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `maturity runs over the REAL OpenRouter rail (model ${MODEL}); ONE REAL measured model ` +
          `round per run (measured usage, BYOK — never estimated); digests only, payload bytes ` +
          `never journaled.`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-036] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
