/**
 * VAL-045 acceptance criteria 3 + 5 + 7 — the REAL end-to-end
 * integration crown: the offline attribution corpus driven over the
 * REAL platform path over REAL PostgreSQL.
 *
 * Test 1 (the offline corpus): every row's attribution analysis end to
 * end — the customer application riding the REAL public SDK wire (ONE
 * attribution submission per row landing its OWN durable execution
 * under its OWN idempotency key → the completion poll → the result
 * read → the events read), the RECORDED ECONOMICS + LIFECYCLE HISTORY
 * (VAL-044's adjusted-cost incumbent baselines + the recorded savings
 * totals + VAL-030..036's lifecycle records, promotion generations,
 * accounting ledgers and maturity reports, pre-seeded) served READ-ONLY
 * from REAL SQL through the platform slice's analysis port (the facts
 * digest snapshotted from FRESH SQL reads before and after every run —
 * the recorded history is a frozen input; a different-content commit
 * under a recorded key THROWS), the mechanically derived attribution
 * verdict (every leg of `deriveAttributionRowCriteria`: the citation
 * completeness, the no-double-count, the residual honesty, the
 * reconciliation identity, the counterfactual fidelity, the
 * generation-series integrity, the honesty), the trustworthy
 * analysis's ATTRIBUTION REPORT (the per-mechanism attributed split +
 * the honest unattributed residual) appended to the append-only report
 * ledger over REAL SQL (the identical re-drive REPLAYS, an impostor
 * report is REFUSED), the honest refusals appending NOTHING, the
 * attribution trajectory flush through the REAL recorder path, the
 * measured latencies, the honest none-reported offline usage, and the
 * app's honest observations over the public wire.
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
import { runSavingsAttributionApp } from "../../../benchmarks/validation/apps/savings-attribution/application";
import {
  attributionSubmissionKey,
  attributionTaskBodyFor,
  declaredSplitTotalsOf,
  FAMILY_ECONOMICS,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  SAVINGS_ATTRIBUTION_CORPUS,
} from "../../../benchmarks/validation/apps/savings-attribution/corpus";
import type {
  FamilyLifecycleRecord,
  MaturityReportRecord,
  PromotionGenerationRecord,
} from "../../../benchmarks/validation/platform/determinization-maturity";
import {
  familyLifecycleDigestOf,
  generationRecordDigestOf,
  maturityReportDigestOf,
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
import type {
  AttributionAnalysisFacts,
  AttributionAnalysisPort,
  AttributionCorpusRow,
  AttributionLedgerEntry,
  AttributionReportPort,
  AttributionRunResult,
  SavingsAttributionReportRecord,
} from "../../../benchmarks/validation/platform/savings-attribution";
import {
  attributionCitationDigestOf,
  attributionClaimDigestOf,
  attributionEntryDigestOf,
  attributionInputDigestOf,
  attributionTrajectoryStepsOf,
  canonicalAttributionCitationOf,
  driveAttributionAnalysis,
  incumbentBaselineDigestOf,
  recordedSavingsTotalDigestOf,
  residualClaimDigestOf,
  savingsAttributionReportDigestOf,
} from "../../../benchmarks/validation/platform/savings-attribution";
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
const MODEL = process.env.ZECK_VAL_045_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-045|savings-attribution|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const LIFECYCLE_HISTORY_OPERATION = "val-045.lifecycle-history";
const GENERATION_HISTORY_OPERATION = "val-045.generation-history";
const ACCOUNTING_HISTORY_OPERATION = "val-045.accounting-history";
const BASELINE_HISTORY_OPERATION = "val-045.baseline-history";
const TOTAL_HISTORY_OPERATION = "val-045.total-history";
const MATURITY_REPORT_OPERATION = "val-045.maturity-report-history";
const ATTRIBUTION_REPORT_OPERATION = "val-045.attribution-reports";

/** The attribution task kind (the landed execution's task grammar). */
const ATTRIBUTION_TASK_KIND = "savings-attribution.mechanism-split.v1";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly familyId: string;
  readonly attributedTotalMicroUsd: number;
  readonly residualMicroUsd: number;
  readonly reportLanded: string;
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
  readonly outcome: Awaited<ReturnType<typeof runSavingsAttributionApp>>;
}

/** ONE recorded incumbent baseline's durable shape (the SQL-loaded form). */
interface SqlBaselineRecord {
  readonly familyId: string;
  readonly generation: number;
  readonly mechanism: CandidateKind;
  readonly incumbentAdjustedCostMicroUsd: number;
  readonly replacementAdjustedCostMicroUsd: number;
  readonly measured: boolean;
}

/** ONE recorded savings total's durable shape (the SQL-loaded form). */
interface SqlTotalRecord {
  readonly familyId: string;
  readonly generation: number;
  readonly totalMicroUsd: number;
}

/** ONE durable attribution report's read-back shape (the SQL truth). */
type SqlAttributionReport = Omit<SavingsAttributionReportRecord, "ordinal"> & {
  readonly ordinal: number;
};

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's attribution ports)
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
        "different content — the recorded economics + lifecycle history is a read-only input",
    );
  }
}

/** The JSONB row-shape guards (honest on unknowns). */
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

type SqlRow = {
  readonly idempotency_key: string;
  readonly durable_outcome: Record<string, unknown>;
};

/** The REAL SQL recorded economics + history (the read-only input, pre-seeded). */
async function seedRealAttributionHistory(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  readonly analysis: AttributionAnalysisPort;
  readonly refreshFacts: () => Promise<AttributionAnalysisFacts>;
}> {
  const generateId = createUuidv7Generator();
  for (const economics of FAMILY_ECONOMICS) {
    for (const [index, record] of economics.lifecycleRecords.entries()) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        LIFECYCLE_HISTORY_OPERATION,
        `${economics.familyId}::lifecycle-${index + 1}`,
        familyLifecycleDigestOf(record),
        { ...record },
      );
    }
    for (const generation of economics.generations) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        GENERATION_HISTORY_OPERATION,
        `${economics.familyId}::generation-${generation.generation}`,
        generationRecordDigestOf(generation),
        { ...generation, perMechanismDisplacements: { ...generation.perMechanismDisplacements } },
      );
    }
    for (const [index, entry] of economics.ledgerEntries.entries()) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        ACCOUNTING_HISTORY_OPERATION,
        `${economics.familyId}::entry-${index + 1}`,
        attributionEntryDigestOf(entry),
        { ...entry },
      );
    }
    for (const [index, baseline] of economics.baselines.entries()) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        BASELINE_HISTORY_OPERATION,
        `${economics.familyId}::baseline-${index + 1}`,
        incumbentBaselineDigestOf(baseline),
        { ...baseline },
      );
    }
    for (const total of economics.recordedTotals) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        TOTAL_HISTORY_OPERATION,
        `${economics.familyId}::total-${total.generation}`,
        recordedSavingsTotalDigestOf(total),
        { ...total },
      );
    }
    for (const report of economics.maturityReports) {
      await commitReadOnly(
        ctx,
        world,
        generateId,
        MATURITY_REPORT_OPERATION,
        `${economics.familyId}::maturity-report`,
        maturityReportDigestOf(report),
        {
          familyId: report.familyId,
          classification: report.classification,
          curvePointDigests: [...report.curvePointDigests],
          savings: {
            totalMicroUsd: report.savings.totalMicroUsd,
            perMechanism:
              report.savings.perMechanism === null ? null : { ...report.savings.perMechanism },
          },
          citationDigest: report.citationDigest,
          ordinal: report.ordinal,
        },
      );
    }
  }

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
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const proposalId = asString(outcome.proposalId);
      const kind = asString(outcome.kind);
      const generation = asNumber(outcome.generation);
      const evidenceDigest = asString(outcome.evidenceDigest);
      if (
        familyId === null ||
        proposalId === null ||
        kind === null ||
        generation === null ||
        evidenceDigest === null
      ) {
        return [];
      }
      return [
        {
          familyId,
          proposalId,
          kind: kind as CandidateKind,
          generation,
          evidenceDigest,
        },
      ];
    });

  const parseGenerations = (rows: readonly SqlRow[]): PromotionGenerationRecord[] =>
    rows.flatMap((row) => {
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const generation = asNumber(outcome.generation);
      const baselineModelCalls = asNumber(outcome.baselineModelCalls);
      const displacedModelCalls = asNumber(outcome.displacedModelCalls);
      const measuredCostMicroUsd = asNumber(outcome.measuredCostMicroUsd);
      const measuredLatencyMs = asNumber(outcome.measuredLatencyMs);
      const measured = asBoolean(outcome.measured);
      const perMechanism =
        outcome.perMechanismDisplacements === null ||
        outcome.perMechanismDisplacements === undefined ||
        typeof outcome.perMechanismDisplacements !== "object"
          ? null
          : (outcome.perMechanismDisplacements as Record<string, unknown>);
      const lifecycleProposalIds = Array.isArray(outcome.lifecycleProposalIds)
        ? (outcome.lifecycleProposalIds as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : null;
      if (
        familyId === null ||
        generation === null ||
        baselineModelCalls === null ||
        displacedModelCalls === null ||
        measuredCostMicroUsd === null ||
        measuredLatencyMs === null ||
        measured === null ||
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
          familyId,
          generation,
          baselineModelCalls,
          displacedModelCalls,
          measuredCostMicroUsd,
          measuredLatencyMs,
          perMechanismDisplacements: {
            reuse: mechanisms.reuse as number,
            cache: mechanisms.cache as number,
            competence: mechanisms.competence as number,
            deterministicization: mechanisms.deterministicization as number,
          },
          measured,
          lifecycleProposalIds,
        },
      ];
    });

  const parseAccounting = (rows: readonly SqlRow[]): AttributionLedgerEntry[] =>
    rows.flatMap((row) => {
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const generation = asNumber(outcome.generation);
      const mechanism = asString(outcome.mechanism);
      const entryId = asString(outcome.entryId);
      const microUsd = asNumber(outcome.microUsd);
      const latencyDeltaMs = asNumber(outcome.latencyDeltaMs);
      if (
        familyId === null ||
        generation === null ||
        mechanism === null ||
        entryId === null ||
        microUsd === null ||
        latencyDeltaMs === null
      ) {
        return [];
      }
      return [
        {
          familyId,
          generation,
          mechanism: mechanism as CandidateKind,
          entryId,
          microUsd,
          latencyDeltaMs,
        },
      ];
    });

  const parseBaselines = (rows: readonly SqlRow[]): SqlBaselineRecord[] =>
    rows.flatMap((row) => {
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const generation = asNumber(outcome.generation);
      const mechanism = asString(outcome.mechanism);
      const incumbent = asNumber(outcome.incumbentAdjustedCostMicroUsd);
      const replacement = asNumber(outcome.replacementAdjustedCostMicroUsd);
      const measured = asBoolean(outcome.measured);
      if (
        familyId === null ||
        generation === null ||
        mechanism === null ||
        incumbent === null ||
        replacement === null ||
        measured === null
      ) {
        return [];
      }
      return [
        {
          familyId,
          generation,
          mechanism: mechanism as CandidateKind,
          incumbentAdjustedCostMicroUsd: incumbent,
          replacementAdjustedCostMicroUsd: replacement,
          measured,
        },
      ];
    });

  const parseTotals = (rows: readonly SqlRow[]): SqlTotalRecord[] =>
    rows.flatMap((row) => {
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const generation = asNumber(outcome.generation);
      const totalMicroUsd = asNumber(outcome.totalMicroUsd);
      if (familyId === null || generation === null || totalMicroUsd === null) {
        return [];
      }
      return [{ familyId, generation, totalMicroUsd }];
    });

  const parseMaturityReports = (rows: readonly SqlRow[]): MaturityReportRecord[] =>
    rows.flatMap((row) => {
      const outcome = row.durable_outcome;
      const familyId = asString(outcome.familyId);
      const classification = asString(outcome.classification);
      const citationDigest = asString(outcome.citationDigest);
      const ordinal = asNumber(outcome.ordinal);
      const curvePointDigests = Array.isArray(outcome.curvePointDigests)
        ? (outcome.curvePointDigests as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : null;
      const savings =
        outcome.savings === null ||
        outcome.savings === undefined ||
        typeof outcome.savings !== "object"
          ? null
          : (outcome.savings as Record<string, unknown>);
      if (
        familyId === null ||
        classification === null ||
        citationDigest === null ||
        ordinal === null ||
        curvePointDigests === null ||
        savings === null ||
        asNumber(savings.totalMicroUsd) === null
      ) {
        return [];
      }
      return [
        {
          familyId,
          classification: classification as MaturityReportRecord["classification"],
          curvePointDigests,
          savings: {
            totalMicroUsd: savings.totalMicroUsd as number,
            perMechanism:
              savings.perMechanism === null ||
              savings.perMechanism === undefined ||
              typeof savings.perMechanism !== "object"
                ? null
                : (savings.perMechanism as Record<CandidateKind, number>),
          },
          citationDigest,
          ordinal,
        },
      ];
    });

  // The read-through snapshot: loaded from the REAL durable rows once,
  // served synchronously through the port contract.
  const loadSnapshot = async () => {
    const [lifecycleRows, generationRows, accountingRows, baselineRows, totalRows, reportRows] =
      await Promise.all([
        readRows(LIFECYCLE_HISTORY_OPERATION),
        readRows(GENERATION_HISTORY_OPERATION),
        readRows(ACCOUNTING_HISTORY_OPERATION),
        readRows(BASELINE_HISTORY_OPERATION),
        readRows(TOTAL_HISTORY_OPERATION),
        readRows(MATURITY_REPORT_OPERATION),
      ]);
    return {
      lifecycle: parseLifecycle(lifecycleRows),
      generations: parseGenerations(generationRows),
      accounting: parseAccounting(accountingRows),
      baselines: parseBaselines(baselineRows),
      totals: parseTotals(totalRows),
      reports: parseMaturityReports(reportRows),
    };
  };
  const group = <T extends { readonly familyId: string }>(members: readonly T[]) => {
    const byFamily = new Map<string, T[]>();
    for (const member of members) {
      const list = byFamily.get(member.familyId) ?? [];
      list.push(member);
      byFamily.set(member.familyId, list);
    }
    return byFamily;
  };
  const snapshot = await loadSnapshot();
  const lifecycleByFamily = group(snapshot.lifecycle);
  const generationsByFamily = group(snapshot.generations);
  const accountingByFamily = group(snapshot.accounting);
  const baselinesByFamily = group(snapshot.baselines);
  const totalsByFamily = group(snapshot.totals);
  const reportsByFamily = group(snapshot.reports);

  const factsOf = (members: {
    readonly lifecycle: readonly FamilyLifecycleRecord[];
    readonly generations: readonly PromotionGenerationRecord[];
    readonly accounting: readonly AttributionLedgerEntry[];
    readonly baselines: readonly SqlBaselineRecord[];
    readonly totals: readonly SqlTotalRecord[];
    readonly reports: readonly MaturityReportRecord[];
  }): AttributionAnalysisFacts => {
    const familyIds = new Set<string>();
    for (const record of members.lifecycle) {
      familyIds.add(record.familyId);
    }
    for (const generation of members.generations) {
      familyIds.add(generation.familyId);
    }
    return {
      familyIds: [...familyIds].sort(),
      lifecycleRecordCount: members.lifecycle.length,
      generationRecordCount: members.generations.length,
      accountingEntryCount: members.accounting.length,
      baselineCount: members.baselines.length,
      recordedTotalCount: members.totals.length,
      maturityReportCount: members.reports.length,
      registryProposalIds: members.lifecycle.map((record) => record.proposalId).sort(),
    };
  };
  let snapshotFacts = factsOf(snapshot);

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
      baselinesFor: (familyId: string) =>
        (baselinesByFamily.get(familyId) ?? []).map((baseline) => ({ ...baseline })),
      recordedTotalsFor: (familyId: string) =>
        (totalsByFamily.get(familyId) ?? []).map((total) => ({ ...total })),
      maturityReportsFor: (familyId: string) =>
        (reportsByFamily.get(familyId) ?? []).map((report) => ({
          ...report,
          curvePointDigests: [...report.curvePointDigests],
          savings: {
            totalMicroUsd: report.savings.totalMicroUsd,
            perMechanism:
              report.savings.perMechanism === null ? null : { ...report.savings.perMechanism },
          },
        })),
      proposalFor: (proposalId: string) => {
        const record = snapshot.lifecycle.find((member) => member.proposalId === proposalId);
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
      const fresh = await loadSnapshot();
      snapshotFacts = factsOf(fresh);
      return snapshotFacts;
    },
  };
}

/** The REAL SQL read-back of the durable attribution reports (the truth). */
async function readAttributionReports(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<readonly SqlAttributionReport[]> {
  const rows = await ctx.port.execute<{
    idempotency_key: string;
    durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, ATTRIBUTION_REPORT_OPERATION],
  });
  return rows.rows.flatMap((sqlRow) => {
    const outcome = sqlRow.durable_outcome;
    const familyId = asString(outcome.familyId);
    const residualMicroUsd = asNumber(outcome.residualMicroUsd);
    const claimedTotalMicroUsd = asNumber(outcome.claimedTotalMicroUsd);
    const citationDigest = asString(outcome.citationDigest);
    const maturityReportDigest = asString(outcome.maturityReportDigest);
    const ordinal = asNumber(outcome.ordinal);
    const attributed =
      outcome.attributed === null ||
      outcome.attributed === undefined ||
      typeof outcome.attributed !== "object"
        ? null
        : (outcome.attributed as Record<string, unknown>);
    const claimDigests = Array.isArray(outcome.claimDigests)
      ? (outcome.claimDigests as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    const residualDigests = Array.isArray(outcome.residualDigests)
      ? (outcome.residualDigests as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    if (
      familyId === null ||
      residualMicroUsd === null ||
      claimedTotalMicroUsd === null ||
      citationDigest === null ||
      maturityReportDigest === null ||
      ordinal === null ||
      attributed === null ||
      claimDigests === null ||
      residualDigests === null ||
      asNumber(attributed.reuse) === null ||
      asNumber(attributed.cache) === null ||
      asNumber(attributed.competence) === null ||
      asNumber(attributed.deterministicization) === null
    ) {
      return [];
    }
    return [
      {
        familyId,
        attributed: {
          reuse: attributed.reuse as number,
          cache: attributed.cache as number,
          competence: attributed.competence as number,
          deterministicization: attributed.deterministicization as number,
        },
        residualMicroUsd,
        claimedTotalMicroUsd,
        claimDigests,
        residualDigests,
        citationDigest,
        maturityReportDigest,
        ordinal,
      },
    ];
  });
}

/**
 * The REAL per-run attribution report ledger (APPEND-ONLY over REAL
 * SQL): the report's canonical payload-free digest as the request
 * fingerprint under the family's key — an identical re-append REPLAYS
 * (idempotent), a different report under the same familyId is REFUSED.
 * The synchronous read view rides an in-memory mirror; the SQL
 * read-back is the durable truth.
 */
function createRealAttributionReportLedger(
  ctx: PgContext,
  world: ApiPgWorld,
): AttributionReportPort {
  const generateId = createUuidv7Generator();
  const mirror = new Map<string, SavingsAttributionReportRecord>();
  return {
    append: async (record) => {
      const ordinal = mirror.size + 1;
      const fingerprint = savingsAttributionReportDigestOf(record);
      const receipt = await arbitrate(
        ctx,
        world,
        generateId,
        ATTRIBUTION_REPORT_OPERATION,
        `${record.familyId}::attribution-report`,
        fingerprint,
        {
          familyId: record.familyId,
          attributed: { ...record.attributed },
          residualMicroUsd: record.residualMicroUsd,
          claimedTotalMicroUsd: record.claimedTotalMicroUsd,
          claimDigests: [...record.claimDigests],
          residualDigests: [...record.residualDigests],
          citationDigest: record.citationDigest,
          maturityReportDigest: record.maturityReportDigest,
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
  row: AttributionCorpusRow,
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
        reason: `val-045-${command}`,
      },
      `val-045-${executionId}-${command}-${transitionCounter.count}`,
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
            strategyId: "val-045-attribution",
            plan: {
              strategyClass: "savings-attribution",
              // The attribution run's OWN dispatch demand — the route
              // read surfaces it at the customer boundary (zero
              // offline; the live row's ONE REAL measured round).
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
        selectedStrategyId: "val-045-attribution",
      },
    },
    `val-045-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/** The verification boundary + the terminal for ONE attribution run's landed execution. */
async function completeAttributionExecution(
  world: ApiPgWorld,
  executionId: string,
  result: AttributionRunResult,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-045-verify",
    },
    `val-045-${executionId}-verify`,
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
          ? "val-045-verified"
          : `val-045-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-045-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-045-${executionId}-${verdict}`,
  );
}

/** Await the row's landed attribution execution (the app's submission over the public wire). */
async function awaitLandedAttributionExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: AttributionCorpusRow,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY id ASC`,
      parameters: [world.applicationId, ATTRIBUTION_TASK_KIND, row.rowId, [...driven]],
    });
    if (rows.rows.length >= 1) {
      if (rows.rows.length !== 1) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its attribution run ` +
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
    `no landed attribution execution for row ${row.rowId} after 120s (expected 1 durable execution)`,
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
        return { satisfied: true, catalogRevision: "val-045", satisfactions: [] };
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
      label: "val-045-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-045-conn-${generateId().slice(-8)}`,
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
            "You are the attribution-confirmation supervisor of a governed validation execution.",
            "You receive the savings-attribution run's measured confirmation request and decide",
            "whether the family's attribution analysis may append its report. Answer with the",
            "single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Savings-attribution confirmation round (golden:live-confirmation, round ${round}, ` +
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

/** Map one attribution trajectory step onto the recorded step-event journal shape. */
function trajectoryStepRecordOf(
  rowId: string,
  step: { readonly kind: string; readonly detail: string },
  ordinal: number,
): TrajectoryStepRecord {
  const kind: TrajectoryStepKind = step.kind.startsWith("attribution:report")
    ? "effect"
    : step.kind.startsWith("attribution:no-evidence")
      ? "verification"
      : "dispatch";
  const detail = `${step.kind}:${step.detail}`;
  return { ordinal, kind, detail, digest: longitudinalDigestOf([rowId, step.kind, step.detail]) };
}

/**
 * Drive one corpus row's attribution run crown-style: the app rides the
 * public wire (ONE attribution submission → the completion poll → the
 * result read → the events read) while the crown waits for the landed
 * execution and drives the REAL lifecycle around the analysis (the
 * prologue transitions → the attribution analysis through the platform
 * driver with the REAL SQL read-only analysis port and the REAL SQL
 * append-only report ledger → the recorded-economics digest snapshots
 * before and after from FRESH SQL reads → the attribution trajectory
 * flush through the REAL recorder path → the verification boundary +
 * the mechanically derived terminal).
 */
async function driveCrownAttribution(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: AttributionCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly analysis: AttributionAnalysisPort;
  readonly refreshFacts: () => Promise<AttributionAnalysisFacts>;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
  /** Whether this run is the FIRST analysis of its family in the corpus (a fresh report append). */
  readonly freshReport: boolean;
}): Promise<{
  readonly executionId: string;
  readonly result: AttributionRunResult;
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
  const appPromise: Promise<AppOutcome> = runSavingsAttributionApp({
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
      configuration: { suite: "val-045-savings-attribution" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed attribution execution (the app's submission through the
  // public wire — ONE durable execution per row).
  const executionId = await awaitLandedAttributionExecution(
    options.ctx,
    world,
    options.driven,
    row,
  );

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the attribution analysis drives over the REAL
  // state machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The recorded-economics read-only snapshot BEFORE the analysis (a
  // FRESH REAL SQL read — the read-only proof's basis).
  const factsDigestBefore = attributionInputDigestOf(await options.refreshFacts());

  // The attribution analysis through the platform driver with the REAL
  // SQL read-only analysis port and the REAL SQL append-only report
  // ledger.
  const reportLedger = createRealAttributionReportLedger(options.ctx, world);
  const result = await driveAttributionAnalysis({
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

  // The recorded-economics read-only snapshot AFTER the analysis (a
  // FRESH REAL SQL read — the read-only proof over REAL SQL).
  const factsDigestAfter = attributionInputDigestOf(await options.refreshFacts());

  // The attribution trajectory flush through the REAL recorder path:
  // the run's canonical attribution steps journal into its landed
  // execution while the execution is RUNNING — the step events project
  // back onto the pinned attribution trajectory (verified below over
  // REAL SQL).
  const steps = attributionTrajectoryStepsOf({
    rowId: row.rowId,
    verdict: result.verdict,
    claimCount: row.split.claims.length,
    reportAppended: result.verdict === "attribution-established",
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
        cause: `val-045-${step.kind}-${step.ordinal}`,
        reference: {
          kind: step.kind,
          ordinal: step.ordinal,
          detail: step.detail,
          digest: step.digest,
        },
        payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
      },
      `val-045-${executionId}-${step.kind}-${step.ordinal}`,
    );
  }

  // The verification boundary + the mechanically derived terminal.
  await completeAttributionExecution(world, executionId, result);

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
 * Verify one row's crown outcome mechanically: the platform's
 * attribution verdict (the terminal, every criterion, the citation /
 * no-double-count / residual-honesty / reconciliation / counterfactual
 * / series / honesty legs, the report landing, the read-only input
 * proof over FRESH REAL SQL reads), the REAL journal projection (the
 * attribution trajectory reproduction through the REAL recorder path —
 * the projected digest IS the canonical steps' digest, the ordinals
 * and sequences gapless), the durable terminal, the REAL SQL report
 * ledger (the report's per-mechanism attributed split + honest
 * residual + claimed total + claim/residual digests + citation digest +
 * linked maturity-report digest — one per analyzed family), and the
 * app's honest observations over the public wire.
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: AttributionCorpusRow;
  readonly executionId: string;
  readonly result: AttributionRunResult;
  readonly appSettled: AppOutcome;
  readonly factsDigestBefore: string;
  readonly factsDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
  readonly freshReport: boolean;
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;
  const declared = declaredSplitTotalsOf(row);

  // ---- the honest attribution contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-045][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-045][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
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
    // Every leg of the honest attribution: fully cited, undoubled,
    // residual-honest, reconciled, counterfactually faithful,
    // series-integral, measured.
    expect(result.citation?.complete, `${row.rowId} citation complete`).toBe(true);
    expect(result.noDoubleCount?.undoubled, `${row.rowId} undoubled`).toBe(true);
    expect(result.residualHonesty?.honest, `${row.rowId} residual honest`).toBe(true);
    expect(result.reconciliation?.reconciled, `${row.rowId} reconciled`).toBe(true);
    expect(result.counterfactual?.faithful, `${row.rowId} counterfactual faithful`).toBe(true);
    expect(result.generationSeries?.integral, `${row.rowId} series integral`).toBe(true);
    expect(result.honesty?.honest, `${row.rowId} honest`).toBe(true);
    expect(result.reportLanded?.accepted, `${row.rowId} report landed`).toBe(true);
    expect(
      result.reportLanded?.replayed,
      `${row.rowId} ${options.freshReport ? "fresh report" : "identical re-append REPLAYS"}`,
    ).toBe(!options.freshReport);
    expect(result.reportsAppended, `${row.rowId} one report`).toBe(1);
    // The per-mechanism split + honest residual + claimed total are the
    // declared honest oracle's arithmetic.
    expect(result.reconciliation?.attributedByMechanism, `${row.rowId} attributed split`).toEqual(
      declared.attributed,
    );
    expect(result.reconciliation?.residualTotalMicroUsd, `${row.rowId} residual total`).toBe(
      declared.residualMicroUsd,
    );
    expect(result.reconciliation?.recordedTotalMicroUsd, `${row.rowId} recorded total`).toBe(
      declared.attributedTotalMicroUsd + declared.residualMicroUsd,
    );
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

  // ---- the recorded-economics read-only proof over FRESH REAL SQL reads ----
  expect(options.factsDigestAfter, `${row.rowId} recorded economics digest after`).toBe(
    options.factsDigestBefore,
  );
  expect(
    result.criteria.find((c) => c.criterionId === "attribution-input-read-only")?.status,
    `${row.rowId} read-only leg`,
  ).toBe("PASS");

  // ---- the REAL SQL report ledger (the durable truth) ----
  const reports = await readAttributionReports(ctx, world);
  const familyReports = reports.filter((report) => report.familyId === row.familyId);
  if (row.expected.verdict === "attribution-established") {
    expect(familyReports, `${row.rowId} one durable report per family`).toHaveLength(1);
    const report = familyReports[0];
    const economics = FAMILY_ECONOMICS.find((member) => member.familyId === row.familyId);
    expect(report?.attributed, `${row.rowId} report attributed split`).toEqual(declared.attributed);
    expect(report?.residualMicroUsd, `${row.rowId} report honest residual`).toBe(
      declared.residualMicroUsd,
    );
    expect(report?.claimedTotalMicroUsd, `${row.rowId} report claimed total`).toBe(
      declared.attributedTotalMicroUsd + declared.residualMicroUsd,
    );
    expect(report?.claimDigests, `${row.rowId} report claim digests`).toEqual(
      row.split.claims.map((claim) => attributionClaimDigestOf(claim)),
    );
    expect(report?.residualDigests, `${row.rowId} report residual digests`).toEqual(
      row.split.residual.map((claim) => residualClaimDigestOf(claim)),
    );
    expect(report?.citationDigest, `${row.rowId} report citation digest`).toBe(
      attributionCitationDigestOf(
        canonicalAttributionCitationOf({
          ledgerEntries: economics?.ledgerEntries ?? [],
          lifecycleRecords: economics?.lifecycleRecords ?? [],
          baselines: economics?.baselines ?? [],
          recordedTotals: economics?.recordedTotals ?? [],
        }),
      ),
    );
    const linkedMaturityReport = economics?.maturityReports[0];
    if (linkedMaturityReport === undefined) {
      throw new Error(`the family ${row.familyId} holds no recorded maturity report`);
    }
    expect(report?.maturityReportDigest, `${row.rowId} linked maturity report`).toBe(
      maturityReportDigestOf(linkedMaturityReport),
    );
    expect(report?.ordinal, `${row.rowId} report append order`).toBe(1);
  }

  // ---- the REAL journal projection (the attribution trajectory) ----
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
  expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal attribution digest`).toBe(
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
  expect(app.evidence.workOrder, `${row.rowId} app work order`).toBe("VAL-045");
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
  // The per-mechanism attributed split + the honest residual + the
  // claimed total are verified over the DURABLE truth below (the REAL
  // SQL report ledger) and over the driver's reconciliation legs —
  // the REAL public result read surfaces the route, the verification
  // statuses and the honest usage (the domain-specific read-backs are
  // the fake-world boundary's surface, proven in the unit +
  // discrimination suites).
  // The app re-derived the attribution trajectory digest over the
  // public journal.
  expect(app.trajectoryDigest, `${row.rowId} app trajectory digest`).not.toBeNull();
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

definePgSuite("VAL-045 savings attribution over the real platform path", (ctx) => {
  test("the offline attribution corpus drives the attribution analysis end to end over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const offlineRows = OFFLINE_CORPUS_ROWS;
      const analyzedFamilies = new Set<string>();
      // The REAL SQL recorded economics + lifecycle history (the
      // read-only input VAL-044's adjusted-cost model + VAL-030..036's
      // records produced, pre-seeded) and the REAL SQL analysis port
      // over it.
      const { analysis, refreshFacts } = await seedRealAttributionHistory(ctx, world);

      // The read-only bases over FRESH REAL SQL reads: the recorded
      // economics + history's own facts digest and its durable row
      // counts.
      const initialFacts = await refreshFacts();
      const initialFactsDigest = attributionInputDigestOf(initialFacts);
      const rowCountOf = async (operation: string): Promise<number> =>
        Number(
          (
            await ctx.port.execute<{ c: number }>({
              sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                    WHERE application_id = $1 AND operation_name = $2`,
              parameters: [world.applicationId, operation],
            })
          ).rows[0]?.c ?? 0,
        );
      const initialLifecycleRows = await rowCountOf(LIFECYCLE_HISTORY_OPERATION);
      const initialGenerationRows = await rowCountOf(GENERATION_HISTORY_OPERATION);
      const initialAccountingRows = await rowCountOf(ACCOUNTING_HISTORY_OPERATION);
      const initialBaselineRows = await rowCountOf(BASELINE_HISTORY_OPERATION);
      const initialTotalRows = await rowCountOf(TOTAL_HISTORY_OPERATION);
      const initialReportRows = await rowCountOf(MATURITY_REPORT_OPERATION);
      // The recorded history serves EXACTLY the pinned family facts.
      const expectedLifecycleRecords = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.lifecycleRecords.length,
        0,
      );
      const expectedGenerationRecords = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.generations.length,
        0,
      );
      const expectedAccountingEntries = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.ledgerEntries.length,
        0,
      );
      const expectedBaselines = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.baselines.length,
        0,
      );
      const expectedTotals = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.recordedTotals.length,
        0,
      );
      const expectedMaturityReports = FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.maturityReports.length,
        0,
      );
      expect(initialLifecycleRows).toBe(expectedLifecycleRecords);
      expect(initialGenerationRows).toBe(expectedGenerationRecords);
      expect(initialAccountingRows).toBe(expectedAccountingEntries);
      expect(initialBaselineRows).toBe(expectedBaselines);
      expect(initialTotalRows).toBe(expectedTotals);
      expect(initialReportRows).toBe(expectedMaturityReports);
      expect(initialFacts.familyIds).toEqual(
        FAMILY_ECONOMICS.map((economics) => economics.familyId).sort(),
      );

      for (const row of offlineRows) {
        const generateId = createUuidv7Generator();
        const runSuffix = `it-${generateId().slice(-8)}`;
        // The ABSOLUTE corpus index (the val-032 live-index lesson: the
        // app selects its row by the FULL-corpus index).
        const taskIndex = SAVINGS_ATTRIBUTION_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        const appKey = attributionSubmissionKey({ runSuffix, taskIndex });
        const appBody = attributionTaskBodyFor({
          rowId: row.rowId,
          familyId: row.familyId,
        });
        // The first analysis of a family appends its report FRESH; the
        // later honest rows over the same family re-append the
        // IDENTICAL report (an append-only REPLAY, never a new row).
        // The honest-refusal families never append (nothing to report).
        const freshReport =
          row.expected.verdict === "attribution-established" && !analyzedFamilies.has(row.familyId);
        if (row.expected.verdict === "attribution-established") {
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
        } = await driveCrownAttribution({
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
        // attribution submission key (no ledger drift — the submission
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
          attributedTotalMicroUsd: result.reconciliation?.attributedTotalMicroUsd ?? 0,
          residualMicroUsd: result.reconciliation?.residualTotalMicroUsd ?? 0,
          reportLanded:
            result.refusal !== null
              ? "nothing-appended"
              : `accepted:${String(result.reportLanded?.accepted)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-045]   ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `family=${runFacts[runFacts.length - 1]?.familyId} ` +
            `attributed=${runFacts[runFacts.length - 1]?.attributedTotalMicroUsd}u$ ` +
            `residual=${runFacts[runFacts.length - 1]?.residualMicroUsd}u$ ` +
            `report=${runFacts[runFacts.length - 1]?.reportLanded} ` +
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
      // attribution row (every run landed its OWN).
      const execCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

      // The idempotency ledger: exactly ONE create arbitration per
      // attribution submission key (no ledger drift).
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

      // The recorded economics + history over REAL SQL is UNCHANGED
      // after the whole corpus (the read-only input — identical facts
      // digest, identical durable row counts).
      const finalFacts = await refreshFacts();
      expect(attributionInputDigestOf(finalFacts), "the recorded economics is unchanged").toBe(
        initialFactsDigest,
      );
      expect(await rowCountOf(LIFECYCLE_HISTORY_OPERATION)).toBe(expectedLifecycleRecords);
      expect(await rowCountOf(GENERATION_HISTORY_OPERATION)).toBe(expectedGenerationRecords);
      expect(await rowCountOf(ACCOUNTING_HISTORY_OPERATION)).toBe(expectedAccountingEntries);
      expect(await rowCountOf(BASELINE_HISTORY_OPERATION)).toBe(expectedBaselines);
      expect(await rowCountOf(TOTAL_HISTORY_OPERATION)).toBe(expectedTotals);
      expect(await rowCountOf(MATURITY_REPORT_OPERATION)).toBe(expectedMaturityReports);

      // The recorded economics is append-only over REAL SQL: a
      // different-content commit under a recorded key THROWS (the
      // read-only input).
      const ragBaseline = FAMILY_ECONOMICS[0]?.baselines[0];
      if (ragBaseline === undefined) {
        throw new Error("the RAG family economics hold no baselines");
      }
      await expect(
        commitReadOnly(
          ctx,
          world,
          createUuidv7Generator(),
          BASELINE_HISTORY_OPERATION,
          "rag-retrieval::baseline-1",
          incumbentBaselineDigestOf({
            ...ragBaseline,
            incumbentAdjustedCostMicroUsd: ragBaseline.incumbentAdjustedCostMicroUsd + 1,
          }),
          {
            ...ragBaseline,
            incumbentAdjustedCostMicroUsd: ragBaseline.incumbentAdjustedCostMicroUsd + 1,
          },
        ),
      ).rejects.toThrow("append-only violation");
      expect(await rowCountOf(BASELINE_HISTORY_OPERATION)).toBe(expectedBaselines);

      // The attribution report ledger over REAL SQL: exactly ONE
      // durable report per ANALYZED family (the established rows over a
      // family re-append the IDENTICAL report — replays, never new
      // rows); the refusal families hold none.
      const reports = await readAttributionReports(ctx, world);
      expect(new Set(reports.map((report) => report.familyId))).toEqual(analyzedFamilies);
      expect(reports).toHaveLength(analyzedFamilies.size);
      // The durable reports carry the honest residuals (the
      // large-honest-residual family's 320u$ among them, never forced).
      const textReport = reports.find((report) => report.familyId === "text-summarization");
      expect(textReport?.residualMicroUsd).toBe(320);
      expect(textReport?.attributed).toEqual({
        reuse: 0,
        cache: 90,
        competence: 0,
        deterministicization: 0,
      });

      // The report ledger is append-only exactly-once over REAL SQL:
      // the re-drive of an already-recorded analysis REPLAYS the
      // immutable report (never a new row), and a DIFFERENT report
      // under a recorded family is REFUSED.
      const replayRow = offlineRows.find(
        (row) => row.rowId === "rag-retrieval-all-mechanisms-attributed",
      ) as AttributionCorpusRow;
      const replayLedger = createRealAttributionReportLedger(ctx, world);
      const replayedRun = await driveAttributionAnalysis({
        row: replayRow,
        analysis,
        reportLedger: replayLedger,
        now: () => new Date(),
      });
      expect(replayedRun.terminal).toBe("COMPLETED");
      expect(replayedRun.reportLanded?.accepted, "the re-drive replays the report").toBe(true);
      expect(replayedRun.reportLanded?.replayed, "the re-drive REPLAYS (exactly-once)").toBe(true);
      const reportsAfterReplay = await readAttributionReports(ctx, world);
      expect(reportsAfterReplay).toHaveLength(analyzedFamilies.size);
      const recordedReplay = reportsAfterReplay.find(
        (report) => report.familyId === "rag-retrieval",
      );
      const impostor = await replayLedger.append({
        familyId: "rag-retrieval",
        attributed: {
          ...(recordedReplay?.attributed ?? {
            reuse: 0,
            cache: 0,
            competence: 0,
            deterministicization: 0,
          }),
          cache: (recordedReplay?.attributed.cache ?? 0) + 95,
        },
        residualMicroUsd: 0,
        claimedTotalMicroUsd: recordedReplay?.claimedTotalMicroUsd ?? 0,
        claimDigests: [...(recordedReplay?.claimDigests ?? [])],
        residualDigests: [...(recordedReplay?.residualDigests ?? [])],
        citationDigest: recordedReplay?.citationDigest ?? "",
        maturityReportDigest: recordedReplay?.maturityReportDigest ?? null,
      });
      expect(impostor, "an impostor report is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const reportsAfterImpostor = await readAttributionReports(ctx, world);
      expect(reportsAfterImpostor).toHaveLength(analyzedFamilies.size);

      // The honest terminals + verdicts distribution (the pinned
      // oracle over the REAL platform path).
      const established = runFacts.filter((fact) => fact.verdict === "attribution-established");
      const refusals = runFacts.filter((fact) => fact.verdict === "no-evidence-honest");
      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED");
      expect(established).toHaveLength(10);
      expect(refusals).toHaveLength(2);
      expect(completed).toHaveLength(runFacts.length);
      console.info(
        `[VAL-045] OFFLINE corpus summary: ${completed.length} COMPLETED of ${runFacts.length} driven ` +
          `attribution analyses (${established.length} attribution-established — five honest split shapes ` +
          `(all-mechanisms 400u$ attributed + 95u$ residual; large-honest-residual 90u$ + 320u$; ` +
          `cache-dominant; reuse-dominant; deterministicization-dominant) + five honest probe re-drives / ` +
          `${refusals.length} honest refusals — every refusal a COMPLETED run appending nothing); ` +
          `${initialLifecycleRows} lifecycle records + ${initialGenerationRows} promotion generations + ` +
          `${initialAccountingRows} accounting entries + ${initialBaselineRows} incumbent baselines + ` +
          `${initialTotalRows} recorded totals + ${initialReportRows} maturity reports served READ-ONLY ` +
          `from REAL SQL as the recorded economics + history (the facts digest IDENTICAL after the whole ` +
          `corpus; a different-content commit under a recorded key THROWS); ${reports.length} durable ` +
          `attribution reports appended over REAL SQL (one per analyzed family — per-mechanism splits + ` +
          `honest residuals; the report ledger is append-only: the re-drive REPLAYS, the impostor is ` +
          `REFUSED); ${drivenRows} durable executions, one per run — no phantoms, no ledger drift, zero ` +
          `orphan events; every attribution trajectory reproduced through the REAL recorder path (the ` +
          `projected digest IS the canonical steps' digest, journals gapless); usage honestly ` +
          `none-reported offline; latency measured, never estimated; digests only, payload bytes never ` +
          `journaled.`,
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the attribution run with a REAL measured round", {
    timeout: 600_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-045] OPENROUTER_API_KEY absent — the REAL live attribution row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every citation/double-count/residual/counterfactual/series/refusal path without " +
          "credentials. Required access: an operator-authorized OpenRouter credential (env " +
          "OPENROUTER_API_KEY) covering the default chat model — the live attribution run demands " +
          "ONE REAL measured model round through the REAL platform model gateway (measured usage, " +
          "never estimated, never fabricated) before the family's attribution report appends over " +
          "REAL SQL.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const liveRows = LIVE_CORPUS_ROWS;
      const { analysis, refreshFacts } = await seedRealAttributionHistory(ctx, world);

      // ONE live dispatch binding for ALL live rows (the VAL-025 review
      // lesson): the connection and its sealed credential envelope are
      // registered ONCE and shared.
      let liveDispatch: ControlDispatch | undefined;
      for (const row of liveRows) {
        // The ABSOLUTE corpus index (the val-032 live-index lesson).
        const taskIndex = SAVINGS_ATTRIBUTION_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement}`,
          );
          continue;
        }
        // Provider-side pacing before the live attribution run.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `live-${generateId().slice(-8)}`;
        if (liveDispatch === undefined) {
          liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
        }
        const dispatch: ControlDispatch = liveDispatch;
        const appKey = attributionSubmissionKey({ runSuffix, taskIndex });
        const appBody = attributionTaskBodyFor({
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
        } = await driveCrownAttribution({
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
          attributedTotalMicroUsd: result.reconciliation?.attributedTotalMicroUsd ?? 0,
          residualMicroUsd: result.reconciliation?.residualTotalMicroUsd ?? 0,
          reportLanded: `accepted:${String(result.reportLanded?.accepted)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-045]   LIVE ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `family=${runFacts[runFacts.length - 1]?.familyId} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `usage=${runFacts[runFacts.length - 1]?.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-045] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `attribution runs over the REAL OpenRouter rail (model ${MODEL}); ONE REAL measured model ` +
          `round per run (measured usage, BYOK — never estimated); digests only, payload bytes ` +
          `never journaled.`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-045] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
