/**
 * The savings-attribution corpus (VAL-045).
 *
 * The pinned attribution rows: per row the WORKLOAD FAMILY, the
 * family's recorded economics + lifecycle history (the RECORDED
 * incumbent baselines per VAL-044's adjusted model, the accounting
 * ledger entries, the per-generation recorded savings totals, the
 * promotion generations VAL-036's maturity curves hold, and the
 * maturity reports — the READ-ONLY input the attribution attributes
 * from), and the EXPECTED attribution split (the per-mechanism
 * attributed savings + the honest unattributed residual — the honest
 * oracle).
 *
 * The rows cover the honest attribution vocabulary — one family with
 * ALL FOUR mechanisms attributed plus a residual (reuse / cache /
 * competence / deterministicization), one family with a LARGE honest
 * residual (most savings honestly unattributed), one CACHE-dominant
 * family, one REUSE-dominant family, one DETERMINISTICIZATION-dominant
 * family — the probe rows (whose ADVERSARIAL variants FAIL in the
 * phase-2 discrimination suites: uncited-claim, double-count,
 * forced-residual, swapped-baseline, gapped-series — pinned here,
 * driven there), the two honest-refusal rows (an unrecorded family; a
 * family whose history holds no recorded savings), and ONE env-gated
 * LIVE row (the REAL measured round; honestly NOT RUN when the
 * credential is absent).
 */

import type {
  FamilyLifecycleRecord,
  MaturityReportRecord,
  PromotionGenerationRecord,
} from "../../platform/determinization-maturity";
import {
  canonicalCurveSeriesOf,
  canonicalSavingsAttributionOf,
  curvePointDigestOf,
} from "../../platform/determinization-maturity";
import type { CandidateKind } from "../../platform/learning-discovery";
import { longitudinalDigestOf } from "../../platform/longitudinal-baseline";
import type {
  AttributionClaim,
  AttributionCorpusRow,
  AttributionLedgerEntry,
  AttributionProbeKind,
  FamilyAttributionSplit,
  IncumbentBaselineRecord,
  RecordedSavingsTotalRecord,
} from "../../platform/savings-attribution";
import {
  attributionInputDigestOf,
  canonicalAttributionSplitOf,
} from "../../platform/savings-attribution";

// ---------------------------------------------------------------------------
// The pinned recorded economics + history (the read-only input per family)
// ---------------------------------------------------------------------------

/** ONE family's pinned recorded economics + history (the read-only input). */
export interface FamilyEconomicsPin {
  readonly familyId: string;
  readonly description: string;
  /** The family's recorded promoted-candidate lifecycle records. */
  readonly lifecycleRecords: readonly FamilyLifecycleRecord[];
  /** The family's recorded promotion generations (VAL-036's maturity curves). */
  readonly generations: readonly PromotionGenerationRecord[];
  /** The family's recorded accounting ledger entries (the attribution's savings basis). */
  readonly ledgerEntries: readonly AttributionLedgerEntry[];
  /** The family's recorded incumbent baselines (VAL-044's adjusted model). */
  readonly baselines: readonly IncumbentBaselineRecord[];
  /** The family's recorded per-generation savings totals (the residual basis). */
  readonly recordedTotals: readonly RecordedSavingsTotalRecord[];
  /** The family's recorded maturity reports (VAL-036's append-only artifacts). */
  readonly maturityReports: readonly MaturityReportRecord[];
}

/** The promoted walk's evidence digest (the canonical landing basis). */
function promotedEvidenceOf(proposalId: string, generation: number): string {
  return longitudinalDigestOf(["val045-promoted-evidence", proposalId, generation]);
}

/**
 * Build ONE family's recorded economics + history from its pinned
 * shape (PURE): the lifecycle records (one promoted candidate per
 * promotion, its mechanism and evidence digest), the promotion
 * generations (the maturity curves' per-generation measured facts),
 * the accounting ledger entries (the per-mechanism measured savings —
 * each entry's number EQUALS its baseline's own counterfactual:
 * incumbent adjusted cost minus replacement adjusted cost), the
 * incumbent baselines (VAL-044's adjusted model), the recorded
 * per-generation savings totals (the residual basis: the totals
 * EXCEED the attributed sums wherever the family holds honest
 * unattributed savings) and the family's recorded maturity report
 * (VAL-036's artifact the attribution links to).
 */
function familyEconomics(input: {
  readonly familyId: string;
  readonly description: string;
  /** The per-generation mechanisms + displaced calls: [generation, mechanism, displacedCalls]. */
  readonly promotions: readonly (readonly [number, CandidateKind, number])[];
  /** The per-generation measured facts: [generation, baseline, displaced, costMicroUsd, latencyMs]. */
  readonly generationFacts: readonly (readonly [number, number, number, number, number])[];
  /** The per-mechanism measured savings: [generation, mechanism, microUsd, latencyDeltaMs]. */
  readonly savings: readonly (readonly [number, CandidateKind, number, number])[];
  /** The recorded incumbent baselines: [generation, mechanism, incumbentAdjusted, replacementAdjusted]. */
  readonly baselines: readonly (readonly [number, CandidateKind, number, number])[];
  /** The recorded per-generation savings totals: [generation, totalMicroUsd]. */
  readonly totals: readonly (readonly [number, number])[];
}): FamilyEconomicsPin {
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
  const ledgerEntries: AttributionLedgerEntry[] = input.savings.map(
    ([generation, mechanism, microUsd, latencyDeltaMs]) => ({
      familyId: input.familyId,
      generation,
      mechanism,
      entryId: `led-${input.familyId}-g${generation}-${mechanism}`,
      microUsd,
      latencyDeltaMs,
    }),
  );
  const baselines: IncumbentBaselineRecord[] = input.baselines.map(
    ([generation, mechanism, incumbentAdjusted, replacementAdjusted]) => ({
      familyId: input.familyId,
      generation,
      mechanism,
      incumbentAdjustedCostMicroUsd: incumbentAdjusted,
      replacementAdjustedCostMicroUsd: replacementAdjusted,
      measured: true,
    }),
  );
  const recordedTotals: RecordedSavingsTotalRecord[] = input.totals.map(
    ([generation, totalMicroUsd]) => ({
      familyId: input.familyId,
      generation,
      totalMicroUsd,
    }),
  );
  // The family's recorded maturity report (VAL-036's artifact — the
  // generation-series linkage's record side), reconstructed from the
  // same recorded facts.
  const accountingForMaturity = ledgerEntries.map((entry) => ({
    familyId: entry.familyId,
    generation: entry.generation,
    mechanism: entry.mechanism,
    microUsd: entry.microUsd,
    latencyDeltaMs: entry.latencyDeltaMs,
  }));
  const maturitySavings = canonicalSavingsAttributionOf(accountingForMaturity);
  const curvePointDigests = canonicalCurveSeriesOf(input.familyId, generations).map((point) =>
    curvePointDigestOf(point),
  );
  const citationDigest = longitudinalDigestOf([
    "val045-maturity-citation",
    input.familyId,
    curvePointDigests.join(","),
    maturitySavings.totalMicroUsd,
  ]);
  const maturityReport: MaturityReportRecord = {
    familyId: input.familyId,
    classification: "variable-resilient",
    curvePointDigests,
    savings: maturitySavings,
    citationDigest,
    ordinal: 1,
  };
  return {
    familyId: input.familyId,
    description: input.description,
    lifecycleRecords,
    generations,
    ledgerEntries,
    baselines,
    recordedTotals,
    maturityReports: [maturityReport],
  };
}

/** The phantom family's identity (never a recorded member). */
export const PHANTOM_FAMILY_ID = "phantom-family";

/**
 * The corpus's pinned family economics (the read-only recorded input
 * VAL-036's maturity world + VAL-044's adjusted-cost model produced,
 * pre-seeded for the offline corpus):
 *
 *   * `rag-retrieval` — ALL FOUR mechanisms attributed across three
 *     generations (reuse / cache / competence / deterministicization)
 *     plus an honest residual in every generation;
 *   * `text-summarization` — a LARGE honest residual (the attributed
 *     share under a quarter of the recorded savings — most savings
 *     honestly unattributed, never forced);
 *   * `code-search` — CACHE-dominant (the stable input→output
 *     transforms carry most of the attributed savings);
 *   * `invoice-extraction` — REUSE-dominant (the cross-workload shape
 *     candidates carry most of the attributed savings);
 *   * `translation-glossary` — DETERMINISTICIZATION-dominant (the
 *     displaced model rounds carry most of the attributed savings);
 *   * `tool-routing` — a lifecycle history whose savings were never
 *     recorded (the honest `no-savings-recorded` refusal);
 *   * `phantom-family` — nothing recorded at all (the honest
 *     `family-unrecorded` refusal).
 */
export const FAMILY_ECONOMICS: readonly FamilyEconomicsPin[] = [
  familyEconomics({
    familyId: "rag-retrieval",
    description:
      "the RAG retrieval family — all four mechanisms attributed across three generations, plus an honest residual",
    promotions: [
      [1, "deterministicization", 12],
      [1, "reuse", 3],
      [2, "cache", 8],
      [2, "deterministicization", 4],
      [3, "competence", 5],
      [3, "reuse", 4],
    ],
    generationFacts: [
      [1, 15, 15, 300, 900],
      [2, 12, 12, 240, 800],
      [3, 9, 9, 180, 700],
    ],
    savings: [
      [1, "deterministicization", 120, 40],
      [1, "reuse", 30, 10],
      [2, "cache", 100, 30],
      [2, "deterministicization", 40, 12],
      [3, "competence", 60, 18],
      [3, "reuse", 50, 15],
    ],
    baselines: [
      [1, "deterministicization", 200, 80],
      [1, "reuse", 60, 30],
      [2, "cache", 160, 60],
      [2, "deterministicization", 100, 60],
      [3, "competence", 110, 50],
      [3, "reuse", 90, 40],
    ],
    totals: [
      [1, 180],
      [2, 170],
      [3, 145],
    ],
  }),
  familyEconomics({
    familyId: "text-summarization",
    description:
      "the text-summarization family — a large honest residual (most savings unattributed, never forced)",
    promotions: [
      [1, "cache", 4],
      [2, "cache", 5],
    ],
    generationFacts: [
      [1, 10, 4, 260, 870],
      [2, 10, 5, 240, 840],
    ],
    savings: [
      [1, "cache", 40, 12],
      [2, "cache", 50, 15],
    ],
    baselines: [
      [1, "cache", 90, 50],
      [2, "cache", 105, 55],
    ],
    totals: [
      [1, 200],
      [2, 210],
    ],
  }),
  familyEconomics({
    familyId: "code-search",
    description: "the code-search family — cache-dominant attribution across three generations",
    promotions: [
      [1, "cache", 9],
      [2, "cache", 11],
      [3, "cache", 13],
      [3, "deterministicization", 2],
    ],
    generationFacts: [
      [1, 10, 9, 220, 760],
      [2, 12, 11, 200, 720],
      [3, 15, 15, 170, 660],
    ],
    savings: [
      [1, "cache", 90, 25],
      [2, "cache", 110, 32],
      [3, "cache", 130, 38],
      [3, "deterministicization", 20, 6],
    ],
    baselines: [
      [1, "cache", 150, 60],
      [2, "cache", 180, 70],
      [3, "cache", 210, 80],
      [3, "deterministicization", 50, 30],
    ],
    totals: [
      [1, 100],
      [2, 120],
      [3, 155],
    ],
  }),
  familyEconomics({
    familyId: "invoice-extraction",
    description:
      "the invoice-extraction family — reuse-dominant attribution across three generations",
    promotions: [
      [1, "reuse", 7],
      [2, "reuse", 9],
      [3, "reuse", 11],
      [3, "competence", 2],
    ],
    generationFacts: [
      [1, 8, 7, 210, 740],
      [2, 10, 9, 190, 700],
      [3, 13, 13, 160, 640],
    ],
    savings: [
      [1, "reuse", 70, 20],
      [2, "reuse", 95, 28],
      [3, "reuse", 115, 34],
      [3, "competence", 15, 5],
    ],
    baselines: [
      [1, "reuse", 120, 50],
      [2, "reuse", 155, 60],
      [3, "reuse", 185, 70],
      [3, "competence", 35, 20],
    ],
    totals: [
      [1, 80],
      [2, 105],
      [3, 140],
    ],
  }),
  familyEconomics({
    familyId: "translation-glossary",
    description:
      "the translation-glossary family — deterministicization-dominant attribution across three generations",
    promotions: [
      [1, "deterministicization", 10],
      [2, "deterministicization", 12],
      [3, "deterministicization", 14],
    ],
    generationFacts: [
      [1, 10, 10, 230, 780],
      [2, 12, 12, 200, 730],
      [3, 14, 14, 170, 670],
    ],
    savings: [
      [1, "deterministicization", 85, 26],
      [2, "deterministicization", 105, 31],
      [3, "deterministicization", 125, 37],
    ],
    baselines: [
      [1, "deterministicization", 145, 60],
      [2, "deterministicization", 175, 70],
      [3, "deterministicization", 205, 80],
    ],
    totals: [
      [1, 95],
      [2, 115],
      [3, 140],
    ],
  }),
  familyEconomics({
    familyId: "tool-routing",
    description:
      "the tool-routing family — promoted candidates + generations recorded, savings never recorded",
    promotions: [[1, "competence", 4]],
    generationFacts: [
      [1, 6, 4, 200, 800],
      [2, 6, 2, 210, 820],
    ],
    savings: [],
    baselines: [],
    totals: [],
  }),
];

/** The pinned economics lookup (PURE). */
export function familyEconomicsById(familyId: string): FamilyEconomicsPin | null {
  return FAMILY_ECONOMICS.find((economics) => economics.familyId === familyId) ?? null;
}

/** The read-only input digest over the full pinned economics (PURE). */
export function pinnedAttributionInputDigest(): string {
  return attributionInputDigestOf({
    familyIds: FAMILY_ECONOMICS.map((economics) => economics.familyId).sort(),
    lifecycleRecordCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.lifecycleRecords.length,
      0,
    ),
    generationRecordCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.generations.length,
      0,
    ),
    accountingEntryCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.ledgerEntries.length,
      0,
    ),
    baselineCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.baselines.length,
      0,
    ),
    recordedTotalCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.recordedTotals.length,
      0,
    ),
    maturityReportCount: FAMILY_ECONOMICS.reduce(
      (total, economics) => total + economics.maturityReports.length,
      0,
    ),
    registryProposalIds: FAMILY_ECONOMICS.flatMap((economics) =>
      economics.lifecycleRecords.map((record) => record.proposalId),
    ).sort(),
  });
}

// ---------------------------------------------------------------------------
// The row builder (the honest oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * Build ONE attribution row over a pinned family economics: the
 * declared split is the CANONICAL honest attribution (one claim per
 * recorded ledger entry — each citing its entry, its generation's
 * lifecycle records of the same mechanism and its RECORDED incumbent
 * baseline — plus the honest residual per generation) and the expected
 * outcome is the honest oracle (attribution-established over a
 * recorded family with savings; the honest refusal over the phantom /
 * savings-less families; the live row's measured round when the gate
 * is open).
 */
function attributionRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly familyId: string;
  readonly probe?: { readonly kind: AttributionProbeKind };
  readonly needsDispatch?: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}): AttributionCorpusRow {
  const economics = familyEconomicsById(input.familyId);
  const familyUnrecorded = economics === null;
  const noSavings =
    economics !== null &&
    economics.generations.length > 0 &&
    economics.ledgerEntries.length === 0 &&
    economics.recordedTotals.length === 0;
  const split: FamilyAttributionSplit = familyUnrecorded
    ? { claims: [], residual: [] }
    : canonicalAttributionSplitOf({
        familyId: input.familyId,
        ledgerEntries: economics.ledgerEntries,
        lifecycleRecords: economics.lifecycleRecords,
        baselines: economics.baselines,
        recordedTotals: economics.recordedTotals,
      });
  const live = input.needsDispatch === true;
  return {
    rowId: input.rowId,
    description: input.description,
    familyId: input.familyId,
    split,
    expected: {
      verdict: familyUnrecorded || noSavings ? "no-evidence-honest" : "attribution-established",
      refusalReason: familyUnrecorded
        ? "family-unrecorded"
        : noSavings
          ? "no-savings-recorded"
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

/** The savings-attribution task kind (the corpus's pinned grammar). */
export const SAVINGS_ATTRIBUTION_TASK_KIND = "savings-attribution.mechanism-split.v1";

/** The offline corpus rows (every row honest; the probes pin their adversarial kind). */
export const OFFLINE_CORPUS_ROWS: readonly AttributionCorpusRow[] = [
  attributionRow({
    rowId: "rag-retrieval-all-mechanisms-attributed",
    description:
      "the RAG retrieval family — all four mechanisms attributed (reuse/cache/competence/deterministicization) across three generations plus an honest residual in every generation",
    familyId: "rag-retrieval",
  }),
  attributionRow({
    rowId: "text-summarization-large-honest-residual",
    description:
      "the text-summarization family — a large honest residual (320 of 410 micro-USD unattributed, reported, never forced into a mechanism)",
    familyId: "text-summarization",
  }),
  attributionRow({
    rowId: "code-search-cache-dominant",
    description:
      "the code-search family — cache-dominant attribution (330 of 375 attributed micro-USD from the stable input→output transforms)",
    familyId: "code-search",
  }),
  attributionRow({
    rowId: "invoice-extraction-reuse-dominant",
    description:
      "the invoice-extraction family — reuse-dominant attribution (280 of 325 attributed micro-USD from the cross-workload shape candidates)",
    familyId: "invoice-extraction",
  }),
  attributionRow({
    rowId: "translation-glossary-deterministicization-dominant",
    description:
      "the translation-glossary family — deterministicization-dominant attribution (315 of 350 attributed micro-USD from the displaced model rounds)",
    familyId: "translation-glossary",
  }),
  attributionRow({
    rowId: "probe-uncited-claim",
    description:
      "the uncited-claim probe over the RAG family — the honest row cites its full population; the phase-2 adversarial variant drops a recorded member (or cites a phantom) and FAILs",
    familyId: "rag-retrieval",
    probe: { kind: "uncited-claim" },
  }),
  attributionRow({
    rowId: "probe-double-count",
    description:
      "the double-count probe over the code-search family — the honest row attributes each ledger entry to exactly one mechanism; the phase-2 adversarial variant cites one entry from two claims and FAILs with both named",
    familyId: "code-search",
    probe: { kind: "double-count" },
  }),
  attributionRow({
    rowId: "probe-forced-residual",
    description:
      "the forced-residual probe over the text-summarization family — the honest row reports its large residual; the phase-2 adversarial variant forces the residual into a mechanism (a claim exceeding its evidence) and FAILs",
    familyId: "text-summarization",
    probe: { kind: "forced-residual" },
  }),
  attributionRow({
    rowId: "probe-swapped-baseline",
    description:
      "the swapped-baseline probe over the invoice-extraction family — the honest row measures each claim against its own recorded incumbent baseline; the phase-2 adversarial variant cites another generation's baseline and FAILs with both sides named",
    familyId: "invoice-extraction",
    probe: { kind: "swapped-baseline" },
  }),
  attributionRow({
    rowId: "probe-gapped-series",
    description:
      "the gapped-series probe over the translation-glossary family — the honest row's generation series matches VAL-036's recorded curves; the phase-2 adversarial variant drops a generation and FAILs",
    familyId: "translation-glossary",
    probe: { kind: "gapped-series" },
  }),
  attributionRow({
    rowId: "unrecorded-family-attribution-refusal",
    description:
      "the PHANTOM family — nothing recorded: the honest refusal (family-unrecorded), nothing attributed, nothing landed",
    familyId: PHANTOM_FAMILY_ID,
  }),
  attributionRow({
    rowId: "no-savings-family-attribution-refusal",
    description:
      "the tool-routing family — lifecycle + generations recorded but the savings never recorded: the honest refusal (no-savings-recorded), never a fabricated split",
    familyId: "tool-routing",
  }),
];

/** The env-gated LIVE corpus row (the REAL measured round). */
export const LIVE_CORPUS_ROWS: readonly AttributionCorpusRow[] = [
  attributionRow({
    rowId: "rag-retrieval-attribution-live",
    description:
      "the LIVE attribution row over the RAG family — the REAL measured round through the model gateway when the credential is present (honestly NOT RUN otherwise)",
    familyId: "rag-retrieval",
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement: "the REAL model gateway dispatch (the measured round)",
    },
  }),
];

/** The full pinned corpus (offline + live). */
export const SAVINGS_ATTRIBUTION_CORPUS: readonly AttributionCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** The corpus row ids (the pinned membership). */
export const SAVINGS_ATTRIBUTION_ROW_IDS: readonly string[] = SAVINGS_ATTRIBUTION_CORPUS.map(
  (row) => row.rowId,
);

/** The corpus row lookup (PURE). */
export function attributionRowById(rowId: string): AttributionCorpusRow | null {
  return SAVINGS_ATTRIBUTION_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

/**
 * The row's declared per-mechanism attributed totals + residual
 * (PURE — the expected split's summary, the config.json basis).
 */
export function declaredSplitTotalsOf(row: AttributionCorpusRow): {
  readonly attributed: Readonly<Record<CandidateKind, number>>;
  readonly attributedTotalMicroUsd: number;
  readonly residualMicroUsd: number;
} {
  const attributed = { reuse: 0, cache: 0, competence: 0, deterministicization: 0 } as Record<
    CandidateKind,
    number
  >;
  for (const claim of row.split.claims) {
    attributed[claim.mechanism] += claim.claimedMicroUsd;
  }
  const attributedTotalMicroUsd =
    attributed.reuse + attributed.cache + attributed.competence + attributed.deterministicization;
  const residualMicroUsd = row.split.residual
    .filter((claim) => claim.reported)
    .reduce((total, claim) => total + claim.residualMicroUsd, 0);
  return { attributed, attributedTotalMicroUsd, residualMicroUsd };
}

/**
 * The row's declared per-generation claims lookup (PURE — the probe
 * builders' + the tests' convenience).
 */
export function declaredClaimsByGeneration(
  row: AttributionCorpusRow,
  generation: number,
): readonly AttributionClaim[] {
  return row.split.claims.filter((claim) => claim.generation === generation);
}

/**
 * Whether the live row's gate is OPEN (the credential is present in
 * the environment — the row runs its REAL measured round; honestly
 * NOT RUN otherwise, never fabricated).
 */
export function liveGateOpen(row: AttributionCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return false;
  }
  return row.liveGate.envVars.every((envVar) => (env[envVar] ?? "").length > 0);
}

/** The attribution submission key (one idempotency key per row per run). */
export function attributionSubmissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-045-savings-attribution-${options.taskIndex}-${options.runSuffix}`;
}

/** The attribution task body (the pinned task grammar). */
export function attributionTaskBodyFor(options: {
  readonly rowId: string;
  readonly familyId: string;
}): { readonly kind: string; readonly rowId: string; readonly familyId: string } {
  return {
    kind: SAVINGS_ATTRIBUTION_TASK_KIND,
    rowId: options.rowId,
    familyId: options.familyId,
  };
}
