/**
 * The determinization-maturity corpus (VAL-036).
 *
 * The pinned maturity-analysis rows: per row the WORKLOAD FAMILY, the
 * family's recorded generation series (the promotion generations +
 * lifecycle + accounting evidence the analysis cites — the read-only
 * input), and the EXPECTED maturity classification + curve facts
 * (the honest oracle). The corpus pins the FULL evidence population
 * per family: the promoted lifecycle records (VAL-032..035's walks
 * landing at `promoted`), the per-generation MEASURED facts (the
 * model-call counts, cost/latency, the per-mechanism displacement
 * counts) and the accounting ledger entries (the per-mechanism
 * measured savings).
 *
 * The rows cover the honest classification vocabulary — one
 * DETERMINIZED-STABLE family (full displacement + zero model-call
 * variance across the stability window), one DETERMINIZING-TRENDING
 * family (monotone displacement growth), one VARIABLE-RESILIENT
 * family (recurring variance, reported honestly), one
 * IMMATURE-INSUFFICIENT-EVIDENCE family (fewer than the minimum
 * generations — the honest verdict, never stretched into a trend) —
 * the probe rows (whose ADVERSARIAL variants FAIL in the phase-2
 * discrimination suites: uncited-claim, gapped-series,
 * misclassified-family, unreconciled-savings,
 * insufficient-evidence-trend — pinned here, driven there), the two
 * honest-refusal rows (an unrecorded family; a family whose history
 * holds no generations), and ONE env-gated LIVE row (the REAL
 * measured round; honestly NOT RUN when the credential is absent).
 */

import type {
  AccountingLedgerEntry,
  CurvePointShape,
  FamilyLifecycleRecord,
  MaturityClassification,
  MaturityCorpusRow,
  MaturityEvidenceCitation,
  MaturityProbeKind,
  PromotionGenerationRecord,
  SavingsAttribution,
} from "../../platform/determinization-maturity";
import {
  canonicalCurveSeriesOf,
  canonicalMaturityCitationOf,
  canonicalSavingsAttributionOf,
  maturityInputDigestOf,
  observedMaturityClassificationOf,
} from "../../platform/determinization-maturity";
import type { CandidateKind } from "../../platform/learning-discovery";
import { longitudinalDigestOf } from "../../platform/longitudinal-baseline";

// ---------------------------------------------------------------------------
// The pinned recorded history (the read-only input per family)
// ---------------------------------------------------------------------------

/** ONE family's pinned recorded history (the read-only input). */
export interface FamilyHistoryPin {
  readonly familyId: string;
  readonly description: string;
  /** The family's recorded promoted-candidate lifecycle records. */
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (the measured series). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The family's recorded accounting ledger entries (the savings basis). */
  readonly accountingEntries: readonly AccountingLedgerEntry[];
}

/** The promoted walk's evidence digest (the canonical landing basis). */
function promotedEvidenceOf(proposalId: string, generation: number): string {
  return longitudinalDigestOf(["val036-promoted-evidence", proposalId, generation]);
}

/**
 * Build ONE family's recorded history from its pinned shape (PURE):
 * the lifecycle records (one promoted candidate per generation, its
 * mechanism and evidence digest), the promotion generations (the
 * per-generation baseline/displaced model calls, the MEASURED
 * cost/latency and the per-mechanism displacement counts), and the
 * accounting ledger entries (the per-mechanism measured savings per
 * generation — the numbers every claimed savings must reconcile
 * against).
 */
function familyHistory(input: {
  readonly familyId: string;
  readonly description: string;
  /** The per-generation mechanisms + displaced calls: [generation, mechanism, displacedCalls]. */
  readonly promotions: readonly (readonly [number, CandidateKind, number])[];
  /** The per-generation measured facts: [generation, baseline, displaced, costMicroUsd, latencyMs]. */
  readonly generationFacts: readonly (readonly [number, number, number, number, number])[];
  /** The per-mechanism measured savings: [generation, mechanism, microUsd, latencyDeltaMs]. */
  readonly savings: readonly (readonly [number, CandidateKind, number, number])[];
}): FamilyHistoryPin {
  const lifecycleRecords: FamilyLifecycleRecord[] = input.promotions.map(
    ([generation, kind, displaced], index) => {
      const proposalId = `cand-learning-discovery-${longitudinalDigestOf([
        input.familyId,
        generation,
        kind,
        displaced,
        index,
      ])}`;
      return {
        familyId: input.familyId,
        proposalId,
        kind,
        generation,
        evidenceDigest: promotedEvidenceOf(proposalId, generation),
      };
    },
  );
  const generations: PromotionGenerationRecord[] = input.generationFacts.map(
    ([generation, baseline, displaced, costMicroUsd, latencyMs]) => {
      const perMechanism = { reuse: 0, cache: 0, competence: 0, deterministicization: 0 } as Record<
        CandidateKind,
        number
      >;
      for (const [promotionGeneration, kind, promotionDisplaced] of input.promotions) {
        if (promotionGeneration === generation) {
          perMechanism[kind] += promotionDisplaced;
        }
      }
      return {
        familyId: input.familyId,
        generation,
        baselineModelCalls: baseline,
        displacedModelCalls: displaced,
        measuredCostMicroUsd: costMicroUsd,
        measuredLatencyMs: latencyMs,
        perMechanismDisplacements: perMechanism,
        measured: true,
        lifecycleProposalIds: lifecycleRecords
          .filter((record) => record.generation === generation)
          .map((record) => record.proposalId),
      };
    },
  );
  const accountingEntries: AccountingLedgerEntry[] = input.savings.map(
    ([generation, mechanism, microUsd, latencyDeltaMs]) => ({
      familyId: input.familyId,
      generation,
      mechanism,
      microUsd,
      latencyDeltaMs,
    }),
  );
  return {
    familyId: input.familyId,
    description: input.description,
    lifecycleRecords,
    generations,
    accountingEntries,
  };
}

/** The phantom family's identity (never a recorded member). */
export const PHANTOM_FAMILY_ID = "phantom-family";

/**
 * The corpus's pinned family histories (the read-only recorded input
 * VAL-032..035 produced, pre-seeded for the offline corpus):
 *
 *   * `rag-retrieval` — DETERMINIZED-STABLE: four generations of
 *     full displacement with zero model-call variance across the
 *     stability window (g3, g4 both displace their whole baseline);
 *   * `text-summarization` — DETERMINIZING-TRENDING: four
 *     generations of monotone displacement growth (2 → 4 → 6 → 8);
 *   * `order-settlement` — VARIABLE-RESILIENT: four generations of
 *     recurring variance (5 → 3 → 6 → 2 — never monotone, never
 *     stable);
 *   * `support-triage` — IMMATURE-INSUFFICIENT-EVIDENCE: two
 *     generations only (below the pinned minimum — the honest
 *     verdict, never stretched into a trend);
 *   * `tool-routing` — a lifecycle history whose generations were
 *     never recorded (the honest `no-generations-recorded` refusal);
 *   * `phantom-family` — nothing recorded at all (the honest
 *     `family-unrecorded` refusal).
 */
export const FAMILY_HISTORIES: readonly FamilyHistoryPin[] = [
  familyHistory({
    familyId: "rag-retrieval",
    description: "the RAG retrieval family — determinized to a stable promoted state",
    promotions: [
      [1, "deterministicization", 12],
      [2, "cache", 12],
      [3, "deterministicization", 10],
      [4, "deterministicization", 10],
    ],
    generationFacts: [
      [1, 12, 12, 240, 900],
      [2, 12, 12, 200, 820],
      [3, 10, 10, 160, 700],
      [4, 10, 10, 150, 680],
    ],
    savings: [
      [1, "deterministicization", 120, 40],
      [2, "cache", 100, 30],
      [3, "deterministicization", 80, 20],
      [4, "deterministicization", 75, 20],
    ],
  }),
  familyHistory({
    familyId: "text-summarization",
    description: "the text-summarization family — still determinizing, trending",
    promotions: [
      [1, "competence", 2],
      [2, "deterministicization", 4],
      [3, "reuse", 6],
      [4, "deterministicization", 8],
    ],
    generationFacts: [
      [1, 10, 2, 300, 950],
      [2, 10, 4, 260, 870],
      [3, 10, 6, 220, 790],
      [4, 10, 8, 180, 700],
    ],
    savings: [
      [1, "competence", 60, 20],
      [2, "deterministicization", 80, 25],
      [3, "reuse", 100, 35],
      [4, "deterministicization", 120, 40],
    ],
  }),
  familyHistory({
    familyId: "order-settlement",
    description: "the order-settlement family — honestly variable across generations",
    promotions: [
      [1, "cache", 5],
      [2, "cache", 3],
      [3, "deterministicization", 6],
      [4, "competence", 2],
    ],
    generationFacts: [
      [1, 10, 5, 400, 1100],
      [2, 10, 3, 420, 1150],
      [3, 10, 6, 380, 1040],
      [4, 10, 2, 440, 1180],
    ],
    savings: [
      [1, "cache", 50, 15],
      [2, "cache", 30, 10],
      [3, "deterministicization", 60, 18],
      [4, "competence", 20, 6],
    ],
  }),
  familyHistory({
    familyId: "support-triage",
    description: "the support-triage family — two generations only (honestly immature)",
    promotions: [
      [1, "competence", 3],
      [2, "reuse", 4],
    ],
    generationFacts: [
      [1, 8, 3, 200, 800],
      [2, 8, 4, 190, 780],
    ],
    savings: [
      [1, "competence", 40, 12],
      [2, "reuse", 45, 14],
    ],
  }),
  familyHistory({
    familyId: "tool-routing",
    description:
      "the tool-routing family — promoted candidates recorded, generations never measured",
    promotions: [[1, "competence", 4]],
    generationFacts: [],
    savings: [],
  }),
];

/** The pinned history lookup (PURE). */
export function familyHistoryById(familyId: string): FamilyHistoryPin | null {
  return FAMILY_HISTORIES.find((history) => history.familyId === familyId) ?? null;
}

/** The read-only input digest over the full pinned history (PURE). */
export function pinnedMaturityInputDigest(): string {
  return maturityInputDigestOf({
    familyIds: FAMILY_HISTORIES.map((history) => history.familyId).sort(),
    lifecycleRecordCount: FAMILY_HISTORIES.reduce(
      (total, history) => total + history.lifecycleRecords.length,
      0,
    ),
    generationRecordCount: FAMILY_HISTORIES.reduce(
      (total, history) => total + history.generations.length,
      0,
    ),
    accountingEntryCount: FAMILY_HISTORIES.reduce(
      (total, history) => total + history.accountingEntries.length,
      0,
    ),
    registryProposalIds: FAMILY_HISTORIES.flatMap((history) =>
      history.lifecycleRecords.map((record) => record.proposalId),
    ).sort(),
  });
}

// ---------------------------------------------------------------------------
// The row builder (the honest oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build ONE maturity row over a pinned family history: the claim is
 * the CANONICAL honest analysis (the full-population citation, the
 * canonical recorded-only curve series, the observed classification,
 * the canonical per-mechanism savings) and the expected outcome is
 * the honest oracle (maturity-established over a recorded family;
 * the honest refusal over the phantom / generation-less families;
 * the live row's measured round when the gate is open).
 */
function maturityRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly familyId: string;
  readonly probe?: { readonly kind: MaturityProbeKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}): MaturityCorpusRow {
  const history = familyHistoryById(input.familyId);
  const familyUnrecorded = history === null;
  const noGenerations = history !== null && history.generations.length === 0;
  const citation: MaturityEvidenceCitation = familyUnrecorded
    ? { lifecycleProposalIds: [], generationDigests: [], accountingEntryDigests: [] }
    : canonicalMaturityCitationOf({
        lifecycleRecords: history.lifecycleRecords,
        generations: history.generations,
        accountingEntries: history.accountingEntries,
      });
  const curveSeries: readonly CurvePointShape[] =
    familyUnrecorded || noGenerations
      ? []
      : canonicalCurveSeriesOf(input.familyId, history.generations);
  const claimedClassification: MaturityClassification =
    familyUnrecorded || noGenerations
      ? "immature-insufficient-evidence"
      : observedMaturityClassificationOf(history.generations);
  const claimedSavings: SavingsAttribution = familyUnrecorded
    ? {
        totalMicroUsd: 0,
        perMechanism: { reuse: 0, cache: 0, competence: 0, deterministicization: 0 },
      }
    : canonicalSavingsAttributionOf(history.accountingEntries);
  const live = input.needsDispatch === true;
  return {
    rowId: input.rowId,
    description: input.description,
    familyId: input.familyId,
    citation,
    curveSeries,
    claimedClassification,
    claimedSavings,
    expected: {
      verdict: familyUnrecorded || noGenerations ? "immaturity-honest" : "maturity-established",
      refusalReason: familyUnrecorded
        ? "family-unrecorded"
        : noGenerations
          ? "no-generations-recorded"
          : null,
      terminal: "COMPLETED",
      modelCalls: live ? 1 : 0,
    },
    ...(input.probe === undefined ? {} : { probe: input.probe }),
    ...(input.needsDispatch === undefined ? {} : { needsDispatch: input.needsDispatch }),
    ...(input.liveGate === undefined ? {} : { liveGate: input.liveGate }),
  };
}

// ---------------------------------------------------------------------------
// The pinned corpus
// ---------------------------------------------------------------------------

/** The determinization-maturity task kind (the corpus's pinned grammar). */
export const DETERMINIZATION_MATURITY_TASK_KIND = "determinization-maturity.learning-curve.v1";

/** The offline corpus rows (every row honest; the probes pin their adversarial kind). */
export const OFFLINE_CORPUS_ROWS: readonly MaturityCorpusRow[] = [
  maturityRow({
    rowId: "rag-retrieval-determinized-stable",
    description:
      "the RAG retrieval family — four generations of full displacement, zero model-call variance across the stability window: determinized-stable",
    familyId: "rag-retrieval",
  }),
  maturityRow({
    rowId: "text-summarization-determinizing-trending",
    description:
      "the text-summarization family — monotone displacement growth across four generations: determinizing-trending",
    familyId: "text-summarization",
  }),
  maturityRow({
    rowId: "order-settlement-variable-resilient",
    description:
      "the order-settlement family — recurring variance across four generations (5→3→6→2): variable-resilient, reported honestly",
    familyId: "order-settlement",
  }),
  maturityRow({
    rowId: "support-triage-immature-insufficient-evidence",
    description:
      "the support-triage family — two generations only, below the pinned minimum: immature-insufficient-evidence (never stretched into a trend)",
    familyId: "support-triage",
  }),
  maturityRow({
    rowId: "probe-uncited-claim",
    description:
      "the uncited-claim probe over the RAG family — the honest row cites its full population; the phase-2 adversarial variant drops a recorded member and FAILs",
    familyId: "rag-retrieval",
    probe: { kind: "uncited-claim" },
  }),
  maturityRow({
    rowId: "probe-gapped-series",
    description:
      "the gapped-series probe over the text-summarization family — the honest row's series is gapless; the phase-2 adversarial variant drops a generation (or extrapolates a point) and FAILs",
    familyId: "text-summarization",
    probe: { kind: "gapped-series" },
  }),
  maturityRow({
    rowId: "probe-misclassified-family",
    description:
      "the misclassified-family probe over the order-settlement family — the honest row claims variable-resilient (the observed data); the phase-2 adversarial variant claims determinized-stable and FAILs",
    familyId: "order-settlement",
    probe: { kind: "misclassified-family" },
  }),
  maturityRow({
    rowId: "probe-unreconciled-savings",
    description:
      "the unreconciled-savings probe over the RAG family — the honest row's per-mechanism savings match the ledgers; the phase-2 adversarial variants (aggregate-only; a mismatched number) FAIL",
    familyId: "rag-retrieval",
    probe: { kind: "unreconciled-savings" },
  }),
  maturityRow({
    rowId: "probe-insufficient-evidence-trend",
    description:
      "the insufficient-evidence-trend probe over the support-triage family — the honest row claims immature-insufficient-evidence; the phase-2 adversarial variant claims a trend and FAILs",
    familyId: "support-triage",
    probe: { kind: "insufficient-evidence-trend" },
  }),
  maturityRow({
    rowId: "unrecorded-family-maturity-refusal",
    description:
      "the PHANTOM family — nothing recorded: the honest refusal (family-unrecorded), nothing analyzed, nothing landed",
    familyId: PHANTOM_FAMILY_ID,
  }),
  maturityRow({
    rowId: "no-generations-family-maturity-refusal",
    description:
      "the tool-routing family — promoted candidates recorded but the generations never measured: the honest refusal (no-generations-recorded)",
    familyId: "tool-routing",
  }),
];

/** The env-gated LIVE corpus row (the REAL measured round). */
export const LIVE_CORPUS_ROWS: readonly MaturityCorpusRow[] = [
  maturityRow({
    rowId: "rag-retrieval-maturity-live",
    description:
      "the LIVE maturity row over the RAG family — the REAL measured round through the model gateway when the credential is present (honestly NOT RUN otherwise)",
    familyId: "rag-retrieval",
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement: "the REAL model gateway dispatch (the measured round)",
    },
  }),
];

/** The full pinned corpus (offline + live). */
export const DETERMINIZATION_MATURITY_CORPUS: readonly MaturityCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The corpus row ids (the pinned membership). */
export const DETERMINIZATION_MATURITY_ROW_IDS: readonly string[] =
  DETERMINIZATION_MATURITY_CORPUS.map((row) => row.rowId);

/** The corpus row lookup (PURE). */
export function maturityRowById(rowId: string): MaturityCorpusRow | null {
  return DETERMINIZATION_MATURITY_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * Whether the live row's gate is OPEN (the credential is present in
 * the environment — the row runs its REAL measured round; honestly
 * NOT RUN otherwise, never fabricated).
 */
export function liveGateOpen(row: MaturityCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return false;
  }
  return row.liveGate.envVars.every((envVar) => (env[envVar] ?? "").length > 0);
}

/** The maturity submission key (one idempotency key per row per run). */
export function maturitySubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-036-determinization-maturity-${options.taskIndex}-${options.runSuffix}`;
}

/** The maturity task body (the pinned task grammar). */
export function maturityTaskBodyFor(options: {
  readonly rowId: string;
  readonly familyId: string;
}): { readonly kind: string; readonly rowId: string; readonly familyId: string } {
  return {
    kind: DETERMINIZATION_MATURITY_TASK_KIND,
    rowId: options.rowId,
    familyId: options.familyId,
  };
}
