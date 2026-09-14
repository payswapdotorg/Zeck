/**
 * The economic-competitive-benchmark corpus (VAL-048, AC1): the
 * declared rows of the CROSS-WORKLOAD COMPETITIVE BENCHMARK — the
 * synthesis comparing Zeck's RECORDED economics against the
 * alternatives across the complete recorded workload portfolio.
 *
 * Every row declares, per the work order's AC1: the RECORDED input
 * digests (the VAL-040 Zeck rows + the VAL-041 direct controls + the
 * VAL-042 optimized baseline runs + the VAL-043 competing runs — the
 * pre-registered arm set; the VAL-044 adjusted-cost records — the
 * adjusted basis references; the VAL-045 attribution + the VAL-047
 * curves — the Zeck longitudinal context; the VAL-046 substrate
 * windows — the substrate disclosure), the WORKLOAD CLASS (the
 * pre-registered competitive cohort), the COMPARISON FAMILY under
 * test (quality-adjusted-ranking | latency-adjusted-ranking |
 * failure-adjusted-ranking | portfolio-weighted-aggregate) and the
 * EXPECTED VERDICT (win/loss/tie on the adjusted basis with honest
 * statistical confidence — never a narrative).
 *
 * THE RECORDED COMPETITIVE COHORTS (the pre-registered workload
 * classes — the recorded evidence's own pairing structure: same
 * workload, same acceptance gate, same recorded window; the declared
 * workload portfolio IS the recorded portfolio):
 *
 *   * `fixed-quality-confirmation` — the 8-round threshold-0.75
 *     headline cohort: all four arms' recorded fixed-quality windows
 *     on the same openrouter/rev-001 rail and the same golden
 *     confirmation gate;
 *   * `zero-resolved-honest` — the 6-round null cohort (nothing
 *     resolves anywhere: the honest incomparability class);
 *   * `budget-stop-prefix` — the 8-pre-registered → 3-executed honest
 *     stop cohort (the starved class reported UNDER-POWERED, never
 *     silently dropped);
 *   * `live-real-dispatch` — the env-gated live class (one REAL
 *     cross-workload comparison slice with live dispatches).
 *
 * The offline rows are deterministically reproducible (the RECORDED
 * corpora + the pinned manifests — zero credentials, zero network,
 * zero re-measurement): seven honest rows (the three ranking families
 * over the headline cohort; the two honest null verdicts over the
 * zero cohort; the honest under-powered refusal over the stop cohort;
 * the portfolio-weighted aggregate with EXPLICIT weights 0.5 / 0.25 /
 * 0.25 — declared, sum-checked, never buried) PLUS the six adversarial
 * PROBE rows (the subset-cherry-picking, the unit-pooling, the
 * cost-basis-switching, the unpaired-statistics claim, the confidence
 * inflation and the sample-starvation — each FAILing its named
 * criterion honestly) and the env-gated LIVE row. The honest verdicts
 * are pinned at module load by running the SAME derivations the
 * driver runs at verification time — the expected outcome IS the
 * mechanically derived one.
 */

import { ADJUSTED_CORPUS } from "../economic-adjusted-cost/corpus";
import type { AdjustedCorpusRow } from "../economic-adjusted-cost/driver";
import { ECONOMIC_CORPUS } from "../economic-baseline/corpus";
import { economicDigestOf } from "../economic-baseline/driver";
import { COMPETING_CORPUS } from "../economic-controls-competing/corpus";
import { DIRECT_CORPUS } from "../economic-controls-direct/corpus";
import { OPTIMIZED_CORPUS } from "../economic-controls-optimized/corpus";
import {
  LONGITUDINAL_LEDGERS,
  pinnedCurveInputDigest,
  pointReferenceOf,
} from "../economic-longitudinal-curve/corpus";
import { windowReferenceOf } from "../economic-substrate-runtime/corpus";
import type {
  AdjustedBasisReference,
  CompetitiveArmReference,
  CompetitiveClaim,
  CompetitiveCorpusRow,
  CompetitorArmKind,
  DeclaredPortfolioWeight,
  LongitudinalContextReference,
  MultipleComparisonPolicy,
  RecordedCompetitiveArm,
} from "./driver";
import {
  DEFAULT_MINIMUM_DISTINCT_ARMS,
  DEFAULT_MINIMUM_PAIRED_ROUNDS,
  deriveCompetitiveSynthesis,
  familyAdjustedPerResolvedMicroUsd,
  liveCompetitiveArmDigestOf,
  recordedCompetitiveArmOf,
  recordedCompetitiveDigestOf,
} from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const COMPETITIVE_TASK_KIND = "economic-competitive-benchmark.experiment.v1";

/** The corpus version the synthesis carries. */
export const COMPETITIVE_CORPUS_VERSION = "val-048-competitive-benchmark-v1";

// ---------------------------------------------------------------------------
// The arm-reference builders (digest references to the RECORDED corpora)
// ---------------------------------------------------------------------------

/** One recorded arm corpus (kind → corpus) — imported, never copied. */
const ARM_CORPORA: Readonly<
  Record<
    CompetitorArmKind,
    readonly {
      readonly rowId: string;
      readonly arm: {
        readonly armId: string;
        readonly priceRevision: string;
        readonly corpusSlice: readonly string[];
        readonly integrationSurface: string;
      };
      readonly frozenPortfolio?: { readonly appId: string };
    }[]
  >
> = {
  zeck: ECONOMIC_CORPUS,
  direct: DIRECT_CORPUS,
  optimized: OPTIMIZED_CORPUS,
  competing: COMPETING_CORPUS,
};

/** The arm's own recorded workload-class disclosure (never trusted — disclosed). */
function armWorkloadClassOf(armKind: CompetitorArmKind, corpusRowId: string): string {
  const corpus = ARM_CORPORA[armKind];
  const row = corpus.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    throw new Error(`the ${armKind} corpus declares no recorded row ${corpusRowId}`);
  }
  if (row.frozenPortfolio !== undefined) {
    return row.frozenPortfolio.appId;
  }
  return `sdk:${row.arm.integrationSurface}`;
}

/**
 * The digest reference for one RECORDED arm corpus row (PURE): the
 * arm's own pinned price revision + the content digest of its
 * RECORDED competitive facts, re-derived from the imported corpus
 * through the driver's extractor (the same derivation the
 * input-integrity oracle runs at verification time).
 */
export function armReferenceOf(
  armKind: CompetitorArmKind,
  corpusRowId: string,
): CompetitiveArmReference {
  const corpus = ARM_CORPORA[armKind];
  const row = corpus.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    throw new Error(`the ${armKind} corpus declares no recorded row ${corpusRowId}`);
  }
  const preliminary: CompetitiveArmReference = {
    armKind,
    corpusRowId,
    recordedDigest: "",
    priceRevision: row.arm.priceRevision,
    workloadClass: armWorkloadClassOf(armKind, corpusRowId),
  };
  const resolved = recordedCompetitiveArmOf(preliminary);
  if (resolved === null) {
    throw new Error(`the recorded facts of ${armKind}:${corpusRowId} failed to re-derive`);
  }
  return {
    armKind,
    corpusRowId,
    recordedDigest: recordedCompetitiveDigestOf({
      armKind,
      corpusRowId,
      facts: resolved.arm.facts,
    }),
    priceRevision: row.arm.priceRevision,
    workloadClass: armWorkloadClassOf(armKind, corpusRowId),
  };
}

/** The live-arm declaration reference (the measured lane's digest). */
export function liveArmReferenceOf(
  armKind: CompetitorArmKind,
  corpusRowId: string,
): CompetitiveArmReference {
  const corpus = ARM_CORPORA[armKind];
  const row = corpus.find((candidate) => candidate.rowId === corpusRowId);
  if (row === undefined) {
    throw new Error(`the ${armKind} corpus declares no live row ${corpusRowId}`);
  }
  return {
    armKind,
    corpusRowId,
    recordedDigest: liveCompetitiveArmDigestOf({
      armKind,
      corpusRowId,
      armId: row.arm.armId,
      sliceSize: row.arm.corpusSlice.length,
    }),
    priceRevision: row.arm.priceRevision,
    workloadClass: armWorkloadClassOf(armKind, corpusRowId),
    live: true,
  };
}

// ---------------------------------------------------------------------------
// The pre-registered competitive cohorts (the recorded portfolio)
// ---------------------------------------------------------------------------

/** One pre-registered competitive cohort (the recorded pairing). */
export interface CompetitiveCohort {
  readonly workloadClass: string;
  readonly description: string;
  /** The cohort's recorded acceptance-gate + window disclosure. */
  readonly gate: {
    readonly kind: "fixed-quality" | "fixed-cost";
    readonly windowRounds: number;
    readonly executedRounds: number;
    readonly resolutionThreshold: number | null;
  };
  readonly armSet: readonly CompetitiveArmReference[];
}

/** The HEADLINE cohort: the 8-round threshold-0.75 fixed-quality confirmation class. */
export const HEADLINE_COHORT: CompetitiveCohort = {
  workloadClass: "fixed-quality-confirmation",
  description:
    "the fixed-quality-confirmation cohort — the four arms' recorded 8-round threshold-0.75 windows on the same openrouter/rev-001 rail over the same golden confirmation gate (the recorded evidence's own pairing: same workload, same acceptance gate, same recorded window)",
  gate: { kind: "fixed-quality", windowRounds: 8, executedRounds: 8, resolutionThreshold: 0.75 },
  armSet: [
    armReferenceOf("zeck", "fixed-quality-openrouter-usd-metered"),
    armReferenceOf("direct", "fixed-quality-direct-default-rail"),
    armReferenceOf("optimized", "fixed-quality-optimized-routing-cache-amortized"),
    armReferenceOf("competing", "fixed-quality-competitor-default-routing"),
  ],
};

/** The ZERO cohort: the 6-round honest null class. */
export const ZERO_COHORT: CompetitiveCohort = {
  workloadClass: "zero-resolved-honest",
  description:
    "the zero-resolved-honest cohort — the four arms' recorded 6-round zero-resolved windows (nothing resolves anywhere; the honest incomparability class — the cost per successfully resolved outcome is NULL on every arm, never a zero-denominator fabrication)",
  gate: { kind: "fixed-cost", windowRounds: 6, executedRounds: 6, resolutionThreshold: null },
  armSet: [
    armReferenceOf("zeck", "zero-resolved-null-cost-per-resolved"),
    armReferenceOf("direct", "zero-resolved-direct-null-discipline"),
    armReferenceOf("optimized", "zero-resolved-optimized-null-discipline"),
    armReferenceOf("competing", "zero-resolved-competitor-null-discipline"),
  ],
};

/** The STOP cohort: the 8-pre-registered → 3-executed honest stop class. */
export const STOP_COHORT: CompetitiveCohort = {
  workloadClass: "budget-stop-prefix",
  description:
    "the budget-stop-prefix cohort — the four arms' recorded honest budget-stop PREFIX windows (8 pre-registered, 3 executed: the declared stop that is never a post-hoc exclusion — the starved class the benchmark reports UNDER-POWERED, never silently dropped)",
  gate: { kind: "fixed-cost", windowRounds: 8, executedRounds: 3, resolutionThreshold: null },
  armSet: [
    armReferenceOf("zeck", "fixed-cost-budget-exhausted-honest-stop"),
    armReferenceOf("direct", "fixed-cost-direct-budget-exhausted-honest-stop"),
    armReferenceOf("optimized", "fixed-cost-optimized-budget-exhausted-honest-stop"),
    armReferenceOf("competing", "fixed-cost-competitor-budget-exhausted-honest-stop"),
  ],
};

/**
 * The recorded competitive cohorts (the pre-registered workload
 * portfolio — the declared portfolio MUST be this portfolio; a
 * cherry-picked subset FAILs mechanically).
 */
export const RECORDED_COMPETITIVE_COHORTS: readonly CompetitiveCohort[] = [
  HEADLINE_COHORT,
  ZERO_COHORT,
  STOP_COHORT,
];

/** The recorded workload classes (the portfolio-honesty oracle's basis). */
export const RECORDED_COMPETITIVE_CLASSES: readonly string[] = RECORDED_COMPETITIVE_COHORTS.map(
  (cohort) => cohort.workloadClass,
);

/** Look up one recorded cohort by its workload class (PURE). */
export function recordedCohortByClass(workloadClass: string): CompetitiveCohort | null {
  return (
    RECORDED_COMPETITIVE_COHORTS.find((cohort) => cohort.workloadClass === workloadClass) ?? null
  );
}

// ---------------------------------------------------------------------------
// The composed context builders (digest references — never copies)
// ---------------------------------------------------------------------------

/**
 * The digest reference for one RECORDED VAL-044 adjusted-cost record
 * (PURE): binds the record's identity, family, its own pre-registered
 * arm set (the three alternatives' digest references) and its pinned
 * synthesis — the adjusted basis this benchmark composes (never
 * re-run, never re-priced).
 */
export function adjustedRecordReferenceOf(corpusRowId: string): AdjustedBasisReference {
  const row: AdjustedCorpusRow | undefined = ADJUSTED_CORPUS.find(
    (candidate) => candidate.rowId === corpusRowId,
  );
  if (row === undefined) {
    throw new Error(`the VAL-044 adjusted-cost corpus declares no row ${corpusRowId}`);
  }
  return {
    corpusRowId,
    family: row.family,
    recordedDigest: economicDigestOf({
      corpusRowId: row.rowId,
      family: row.family,
      armSet: row.armSet.map((reference) => [
        reference.armLabel,
        reference.corpusRowId,
        reference.recordedDigest,
      ]),
      verdict: row.expected.verdict,
      synthesis:
        row.expected.synthesis === undefined
          ? null
          : {
              pooledRuns: row.expected.synthesis.pooledRuns,
              pooledResolved: row.expected.synthesis.pooledResolved,
              measuredCostMicroUsd: row.expected.synthesis.measuredCostMicroUsd,
              estimatedCostMicroUsd: row.expected.synthesis.estimatedCostMicroUsd,
              attainment: row.expected.synthesis.attainment,
              latencyCompliance: row.expected.synthesis.latencyCompliance,
              adjustedCostMicroUsd: row.expected.synthesis.adjustedCostMicroUsd,
              wilson: row.expected.synthesis.wilson,
            },
    }),
  };
}

/**
 * The Zeck longitudinal context (PURE): the RECORDED VAL-047 curve
 * classes' LATEST-generation ledger points (digest references — Zeck's
 * learning trajectory) + the RECORDED VAL-045 attribution input
 * digest — disclosed per row, NEVER mixed into the paired verdict
 * basis (the cost basis of every leg stays the recorded cohort's own
 * pinned window).
 */
function longitudinalContextOf(): LongitudinalContextReference {
  const latest = LONGITUDINAL_LEDGERS.map((ledger) => {
    const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
    const last = sorted[sorted.length - 1];
    if (last === undefined) {
      throw new Error(`the ${ledger.workloadClass} ledger holds no points`);
    }
    const reference = pointReferenceOf(ledger.workloadClass, last.generation);
    return {
      workloadClass: ledger.workloadClass,
      generation: last.generation,
      recordedDigest: reference.recordedDigest,
    };
  });
  const attributionDigest = pinnedCurveInputDigest();
  const contextDigest = economicDigestOf({
    curveClasses: LONGITUDINAL_LEDGERS.map((ledger) => ledger.workloadClass),
    latestPointReferences: latest.map((entry) => [
      entry.workloadClass,
      entry.generation,
      entry.recordedDigest,
    ]),
    attributionDigest,
  });
  return {
    curveClasses: LONGITUDINAL_LEDGERS.map((ledger) => ledger.workloadClass),
    latestPointReferences: latest,
    attributionDigest,
    contextDigest,
  };
}

/** The corpus-level Zeck longitudinal context (the shared disclosure). */
const LONGITUDINAL_CONTEXT: LongitudinalContextReference = longitudinalContextOf();

/** The per-cohort substrate disclosures (the VAL-046 windows behind the alternatives' runs). */
const SUBSTRATE_CONTEXTS: Readonly<
  Record<string, readonly ReturnType<typeof windowReferenceOf>[]>
> = {
  "fixed-quality-confirmation": [
    windowReferenceOf("window-warm-fleet-a-headline"),
    windowReferenceOf("window-reserved-fleet-c-headline"),
    windowReferenceOf("window-cold-fleet-b-headline"),
  ],
  "zero-resolved-honest": [
    windowReferenceOf("window-warm-fleet-a-zero"),
    windowReferenceOf("window-cold-fleet-b-zero"),
    windowReferenceOf("window-eu-warm-fleet-d-zero"),
  ],
  "budget-stop-prefix": [
    windowReferenceOf("window-warm-fleet-a-stop"),
    windowReferenceOf("window-reserved-fleet-c-stop"),
    windowReferenceOf("window-cold-fleet-b-stop"),
  ],
  "live-real-dispatch": [],
};

// ---------------------------------------------------------------------------
// The honest input resolution (the driver's canonical input basis)
// ---------------------------------------------------------------------------

/**
 * The honest resolved arm inputs of one arm set (PURE): every
 * reference resolves through the driver's extractor into the FULL
 * recorded facts — the bundle the input-integrity oracle verifies
 * field-by-field against the same corpus derivation.
 */
export function honestCompetitiveInputsOf(
  armSet: readonly CompetitiveArmReference[],
): readonly RecordedCompetitiveArm[] {
  return armSet.map((reference) => {
    const resolved = recordedCompetitiveArmOf(reference);
    if (resolved === null) {
      throw new Error(
        `the recorded facts of ${reference.armKind}:${reference.corpusRowId} failed to re-derive`,
      );
    }
    return resolved.arm;
  });
}

/**
 * The cost-basis-switching probe's claimed comparison (the dishonest
 * shape, derived at pin time over the HONEST inputs): the zeck side
 * rides the row's quality-adjusted basis while the direct side carries
 * its RAW measured window total — the mid-comparison basis switch the
 * cost-basis-integrity oracle catches with both sides named.
 */
const BASIS_SWITCH_INPUTS = honestCompetitiveInputsOf(HEADLINE_COHORT.armSet);
const BASIS_SWITCH_ZECK = BASIS_SWITCH_INPUTS.find((arm) => arm.reference.armKind === "zeck");
const BASIS_SWITCH_DIRECT = BASIS_SWITCH_INPUTS.find((arm) => arm.reference.armKind === "direct");
const BASIS_SWITCH_CLAIM: CompetitiveClaim = {
  verdict: "zeck-wins-significant",
  comparison: {
    zeckSide: {
      basis: "quality-adjusted-per-resolved",
      valueMicroUsd:
        (BASIS_SWITCH_ZECK === undefined
          ? null
          : familyAdjustedPerResolvedMicroUsd({
              family: "quality-adjusted-ranking",
              facts: BASIS_SWITCH_ZECK.facts,
            })) ?? "0",
    },
    alternativeSide: {
      armKind: "direct",
      basis: "unadjusted-measured-total",
      valueMicroUsd: BASIS_SWITCH_DIRECT?.facts.measuredCostMicroUsd ?? "0",
    },
  },
};

// ---------------------------------------------------------------------------
// The row builder (the honest oracle's derivation)
// ---------------------------------------------------------------------------

/** The Bonferroni policy over one row's pairwise family (PURE). */
function policyOf(armSet: readonly CompetitiveArmReference[]): MultipleComparisonPolicy {
  const familySize = Math.max(1, armSet.filter((ref) => ref.armKind !== "zeck").length);
  return {
    method: "bonferroni",
    familyWiseLevel: 0.05,
    familySize,
    perComparisonLevel: 0.05 / familySize,
  };
}

/**
 * Build one offline competitive row with its PINNED expected
 * competitive outcome: the REAL derivations (the honest recorded arm
 * inputs + the pairwise paired sign tests + the Wilson intervals +
 * the enforced minimums + the family verdict) run over the declared
 * arm set at module load — exactly what the driver's own comparison
 * derivation must reproduce at run time.
 */
function competitiveRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly family: CompetitiveCorpusRow["family"];
  readonly workloadClass: string;
  readonly armSet: readonly CompetitiveArmReference[];
  readonly adjustedBasisReferences: readonly AdjustedBasisReference[];
  readonly minimumPairedRounds?: number;
  readonly minimumDistinctArms?: number;
  readonly latencyBudgetMs?: number;
  readonly declaredWeights?: readonly DeclaredPortfolioWeight[];
  readonly verdict?: CompetitiveCorpusRow["expected"]["verdict"];
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly adversarial?: CompetitiveCorpusRow["adversarial"];
  readonly claimed?: CompetitiveClaim;
  readonly pinSynthesis?: boolean;
}): CompetitiveCorpusRow {
  const armSet = input.armSet;
  const row: CompetitiveCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    family: input.family,
    workloadClass: input.workloadClass,
    armSet,
    adjustedBasisReferences: input.adjustedBasisReferences,
    longitudinalContext: LONGITUDINAL_CONTEXT,
    substrateContext: SUBSTRATE_CONTEXTS[input.workloadClass] ?? [],
    minimumPairedRounds: input.minimumPairedRounds ?? DEFAULT_MINIMUM_PAIRED_ROUNDS,
    minimumDistinctArms: input.minimumDistinctArms ?? DEFAULT_MINIMUM_DISTINCT_ARMS,
    multipleComparison: policyOf(armSet),
    ...(input.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: input.latencyBudgetMs }),
    ...(input.declaredWeights === undefined ? {} : { declaredWeights: input.declaredWeights }),
    needsDispatch: false,
    ...(input.adversarial === undefined ? {} : { adversarial: input.adversarial }),
    ...(input.claimed === undefined ? {} : { claimed: input.claimed }),
    expected: {
      terminal: input.terminal ?? "COMPLETED",
      verdict: input.verdict ?? "statistical-tie",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
  if ((input.pinSynthesis ?? true) && input.adversarial === undefined) {
    const derived = deriveCompetitiveSynthesis({
      row,
      arms: honestCompetitiveInputsOf(armSet),
    });
    return {
      ...row,
      expected: {
        ...row.expected,
        verdict: input.verdict ?? derived.verdict,
        synthesis: derived.synthesis,
      },
    };
  }
  return row;
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The honest offline rows (each family + class covered honestly). */
export const OFFLINE_CONTROL_ROWS: readonly CompetitiveCorpusRow[] = [
  competitiveRow({
    rowId: "confirmation-fixed-quality-quality-adjusted-ranking",
    description:
      "The headline QUALITY-ADJUSTED RANKING over the fixed-quality-confirmation cohort: the four arms' recorded 8-round windows (the VAL-040 Zeck sdk row + the VAL-041 direct control + the VAL-042 optimized baseline + the VAL-043 competing stack — digest-referenced, never copied) ranked on the quality-adjusted cost per successfully resolved outcome (the verified-attainment-normalized basis, attainment RECOMPUTED from the recorded runs), with the exact PAIRED sign test over the round-for-round blocks, the Wilson 95% interval, the Bonferroni family-wise policy (3 pairwise comparisons, per-comparison level 0.05/3) and the enforced minimum of 5 paired blocks. The VAL-044 quality-adjusted record composes the alternatives' adjusted basis (digest-referenced); the VAL-045/047 curve context and the VAL-046 substrate windows are disclosed, never mixed. Expected verdict: the mechanically derived one.",
    family: "quality-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
  }),
  competitiveRow({
    rowId: "confirmation-fixed-quality-latency-adjusted-ranking",
    description:
      "The headline LATENCY-ADJUSTED RANKING over the fixed-quality-confirmation cohort: the same four recorded arms ranked on the latency-compliance-weighted cost per resolved outcome against the pinned 1000ms budget — every recorded round's OWN latency weighed (a block exceeding the budget carries its overage-weighted cost; a latency-omitting comparison FAILs mechanically). The paired sign test, the Wilson interval, the Bonferroni policy and the enforced minimum apply as on the quality family. Expected verdict: the mechanically derived one.",
    family: "latency-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("latency-adjusted-three-arm-synthesis")],
    latencyBudgetMs: 1000,
  }),
  competitiveRow({
    rowId: "confirmation-fixed-quality-failure-adjusted-ranking",
    description:
      "The headline FAILURE-ADJUSTED RANKING over the fixed-quality-confirmation cohort: the same four recorded arms ranked on the fully-amortized cost per successfully resolved outcome — every failed attempt's cost and every failed round's cost counted IN (the direct arm's retry overhead, the optimized arm's retry-amortized rounds, the competing arm's gateway-aggregate internal retries all in the measured totals; a dropped failure cost FAILs the failure-completeness oracle named). Expected verdict: the mechanically derived one.",
    family: "failure-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("failure-adjusted-three-arm-synthesis")],
  }),
  competitiveRow({
    rowId: "zero-resolved-quality-adjusted-null-basis",
    description:
      "The honest NULL-BASIS quality-adjusted verdict over the zero-resolved-honest cohort: the four arms' recorded 6-round zero-resolved windows — NOTHING resolves anywhere, so the quality-adjusted cost per resolved outcome is NULL on every arm (never a zero-denominator fabrication) while the measured cost of the failed rounds is still carried honestly and the Wilson [0, high] intervals ride on the comparison. The honest incomparability IS the verified outcome.",
    family: "quality-adjusted-ranking",
    workloadClass: ZERO_COHORT.workloadClass,
    armSet: ZERO_COHORT.armSet,
    adjustedBasisReferences: [
      adjustedRecordReferenceOf("quality-adjusted-null-attainment-incomparable"),
    ],
    minimumPairedRounds: 3,
  }),
  competitiveRow({
    rowId: "zero-resolved-failure-adjusted-null-basis",
    description:
      "The honest NULL-BASIS failure-adjusted verdict over the zero-resolved-honest cohort: the fully-amortized cost per successfully resolved outcome is NULL when nothing resolved (never zero, never estimate-backed) while the measured cost of the failed rounds is still carried — the roadmap's NULL discipline composed into the cross-workload competitive verdict.",
    family: "failure-adjusted-ranking",
    workloadClass: ZERO_COHORT.workloadClass,
    armSet: ZERO_COHORT.armSet,
    adjustedBasisReferences: [
      adjustedRecordReferenceOf("failure-adjusted-null-resolved-incomparable"),
    ],
    minimumPairedRounds: 3,
  }),
  competitiveRow({
    rowId: "budget-stop-prefix-quality-adjusted-underpowered",
    description:
      "The honest UNDER-POWERED verdict over the budget-stop-prefix cohort: the four arms' recorded honest budget-stop PREFIX windows hold only 3 paired blocks against the pre-registered minimum of 5 — the samples cannot support a win/loss/tie verdict, so the comparison is reported UNDER-POWERED (never silently dropped, never a starved-sample verdict). The honest refusal IS the verified outcome.",
    family: "quality-adjusted-ranking",
    workloadClass: STOP_COHORT.workloadClass,
    armSet: STOP_COHORT.armSet,
    adjustedBasisReferences: [
      adjustedRecordReferenceOf("quality-adjusted-below-minimum-honest-refusal"),
    ],
    minimumPairedRounds: 5,
  }),
  competitiveRow({
    rowId: "cross-workload-portfolio-weighted-aggregate",
    description:
      "The PORTFOLIO-WEIGHTED AGGREGATE over the complete recorded workload portfolio: the three recorded classes weighted EXPLICITLY (fixed-quality-confirmation 0.5; zero-resolved-honest 0.25; budget-stop-prefix 0.25 — declared, sum-checked to 1, never buried), each class's own pre-registered arm set + minimum carried on its weight, the per-class verdicts derived over the SAME machinery and the aggregate verdict the weighted aggregation of them. The row's own arm set is the headline cohort's reference window (disclosed); every omitted class would FAIL the portfolio-honesty oracle named.",
    family: "portfolio-weighted-aggregate",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [
      adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis"),
      adjustedRecordReferenceOf("latency-adjusted-three-arm-synthesis"),
      adjustedRecordReferenceOf("failure-adjusted-three-arm-synthesis"),
      adjustedRecordReferenceOf("quality-adjusted-null-attainment-incomparable"),
      adjustedRecordReferenceOf("failure-adjusted-null-resolved-incomparable"),
      adjustedRecordReferenceOf("quality-adjusted-below-minimum-honest-refusal"),
    ],
    declaredWeights: [
      {
        workloadClass: HEADLINE_COHORT.workloadClass,
        weight: 0.5,
        minimumPairedRounds: 5,
        armSet: HEADLINE_COHORT.armSet,
      },
      {
        workloadClass: ZERO_COHORT.workloadClass,
        weight: 0.25,
        minimumPairedRounds: 3,
        armSet: ZERO_COHORT.armSet,
      },
      {
        workloadClass: STOP_COHORT.workloadClass,
        weight: 0.25,
        minimumPairedRounds: 5,
        armSet: STOP_COHORT.armSet,
      },
    ],
  }),
];

/** The adversarial probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly CompetitiveCorpusRow[] = [
  competitiveRow({
    rowId: "probe-subset-cherry-picking",
    description:
      "The subset-cherry-picking probe: the portfolio aggregate declares ONLY the fixed-quality-confirmation class (weight 1.0) — dropping the zero-resolved-honest and budget-stop-prefix classes the recorded portfolio holds — while claiming the zeck-wins verdict the complete portfolio does not support. The portfolio-honesty oracle FAILs it MECHANICALLY with the omitted classes named (the declared workload portfolio is the recorded portfolio, never a curated subset).",
    family: "portfolio-weighted-aggregate",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
    declaredWeights: [
      {
        workloadClass: HEADLINE_COHORT.workloadClass,
        weight: 1,
        minimumPairedRounds: 5,
        armSet: HEADLINE_COHORT.armSet,
      },
    ],
    adversarial: "subset-cherry-picking",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
  competitiveRow({
    rowId: "probe-unit-pooling",
    description:
      "The unit-pooling probe over the fixed-quality-confirmation cohort: the row's executed arm bundles carry the zero-resolved cohort's rounds APPENDED to the headline cohort's blocks (14 paired blocks over two incomparable windows — different gates, different recorded windows) while claiming the zeck-wins verdict the pooled count inflates. The unit-comparability oracle FAILs it MECHANICALLY with the pooled blocks named (the recorded evidence's blocks pair round-for-round within ONE cohort; pooling incomparable units is refused).",
    family: "quality-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
    adversarial: "unit-pooling",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
  competitiveRow({
    rowId: "probe-cost-basis-switching",
    description:
      "The cost-basis-switching probe over the fixed-quality-confirmation cohort: the row's claimed headline comparison rides the zeck side on the quality-adjusted basis while the direct side carries its RAW measured total (the unadjusted window cost — a 10x deflation manufactured by switching the basis mid-comparison). The cost-basis-integrity oracle FAILs it MECHANICALLY with both sides named (adjusted compared with adjusted ONLY; the claimed values must re-derive).",
    family: "quality-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
    claimed: BASIS_SWITCH_CLAIM,
    adversarial: "cost-basis-switching",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
  competitiveRow({
    rowId: "probe-unpaired-statistics",
    description:
      "The unpaired-statistics probe over the fixed-quality-confirmation cohort: the row claims the zeck-wins verdict citing an UNPAIRED pooled two-sample statistic (p 0.04) over the paired evidence — discarding the round-for-round block structure the recorded evidence holds. The paired-statistics oracle FAILs it MECHANICALLY (an unpaired statistic over paired evidence FAILs named; the derived paired p-values named alongside).",
    family: "quality-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
    claimed: {
      verdict: "zeck-wins-significant",
      statistic: "unpaired-pooled-two-sample",
      pValue: 0.04,
    },
    adversarial: "unpaired-statistics",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
  competitiveRow({
    rowId: "probe-confidence-inflation",
    description:
      "The confidence-inflation probe over the fixed-quality-confirmation cohort: the row claims the zeck-wins verdict citing a paired p of 0.008 that no derived comparison supports (the derived paired p-values are 0.5/0.6875/0.5 — none at or below the declared Bonferroni per-comparison level 0.016667). The multiple-comparison-honesty oracle FAILs it MECHANICALLY (confidence inflated beyond its evidence — the family-wise error control is not optional).",
    family: "quality-adjusted-ranking",
    workloadClass: HEADLINE_COHORT.workloadClass,
    armSet: HEADLINE_COHORT.armSet,
    adjustedBasisReferences: [adjustedRecordReferenceOf("quality-adjusted-three-arm-synthesis")],
    claimed: {
      verdict: "zeck-wins-significant",
      statistic: "paired-sign-test",
      pValue: 0.008,
    },
    adversarial: "confidence-inflation",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
  competitiveRow({
    rowId: "probe-sample-starvation",
    description:
      "The sample-starvation probe over the budget-stop-prefix cohort: the starved class holds only 3 paired blocks against the pre-registered minimum of 5, yet the row CLAIMS the zeck-wins verdict on the starved sample. The minimum-sample-enforcement oracle FAILs it MECHANICALLY (an insufficient-sample verdict claim FAILs named — the honest verdict is the under-powered refusal, never a starved-sample win).",
    family: "quality-adjusted-ranking",
    workloadClass: STOP_COHORT.workloadClass,
    armSet: STOP_COHORT.armSet,
    adjustedBasisReferences: [
      adjustedRecordReferenceOf("quality-adjusted-below-minimum-honest-refusal"),
    ],
    minimumPairedRounds: 5,
    adversarial: "sample-starvation",
    terminal: "FAILED",
    verdict: "zeck-wins-significant",
    pinSynthesis: false,
  }),
];

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly CompetitiveCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; one REAL slice)
// ---------------------------------------------------------------------------

/** The live row's arm set (the primary competitive pair's LIVE declarations). */
function liveArmSetOf(): readonly CompetitiveArmReference[] {
  return [
    liveArmReferenceOf("zeck", "live-fixed-quality-openrouter-real-dispatch"),
    liveArmReferenceOf("direct", "live-fixed-quality-direct-real-dispatch"),
  ];
}

/** The live rows (env-gated on the authorized rail; one REAL competitive slice). */
export const LIVE_CORPUS_ROWS: readonly CompetitiveCorpusRow[] = [
  {
    rowId: "live-competitive-real-dispatch-slice",
    description:
      "A REAL cross-workload competitive slice (env-gated): the PRIMARY competitive pair's live windows — the Zeck live row (VAL-040's live-fixed-quality window over the sdk surface) vs the direct-provider live row (VAL-041's live window) — each driven by REAL dispatches on the ONE pinned OpenRouter rail (BYOK, measured usage, every priced input at the pinned manifest revision rev-001, max_tokens 32 pinned explicitly, temperature unset per the provider's documented default, the empty-completion 200 counted as honest success per the VAL-014 rule, the provider envelope's usage tokens winning over any raw HTTP observation). The comparison is computed over MEASURED facts with the verdict recorded through the REAL recorder with honest economics — 4 paired blocks cannot reach the declared per-comparison level, so the honest a-priori verdict is the statistical tie (disclosed now, derived over whatever the measured slice actually yields). The optimized and competing LIVE windows remain declared in their own corpora for the operator's live review (referenced honestly — never fabricated here). Without the credential the row is honestly NOT RUN (never fabricated).",
    family: "quality-adjusted-ranking",
    workloadClass: "live-real-dispatch",
    armSet: liveArmSetOf(),
    adjustedBasisReferences: [adjustedRecordReferenceOf("live-adjusted-synthesis-real-comparison")],
    longitudinalContext: LONGITUDINAL_CONTEXT,
    substrateContext: [],
    minimumPairedRounds: 3,
    minimumDistinctArms: 2,
    multipleComparison: policyOf(liveArmSetOf()),
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL competitive slice demands REAL workload dispatches on the pinned rail (BYOK, measured usage, max_tokens 32 pinned explicitly, temperature unset per the provider's documented default)",
    },
    expected: {
      terminal: "COMPLETED",
      verdict: "statistical-tie",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const COMPETITIVE_CORPUS: readonly CompetitiveCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: CompetitiveCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

// ---------------------------------------------------------------------------
// The submission keys + task bodies (the app's fingerprint discipline)
// ---------------------------------------------------------------------------

/** The app's idempotency key for one row's submission. */
export function submissionKey(options: {
  readonly runSuffix: string;
  readonly taskIndex: number;
}): string {
  return `val-048-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY — the
 * row, the family, the workload class, the pre-registered arm set
 * (digest references), the adjusted-basis references, the curve
 * context digest, the substrate window ids, the minimums, the
 * multiple-comparison policy, the Wilson level and the expected
 * verdict. Never a price, never a recorded result copy (the platform
 * resolves the recorded corpora and the manifests through their
 * registries).
 */
export function taskBodyFor(options: {
  readonly row: CompetitiveCorpusRow;
}): Record<string, unknown> {
  const { row } = options;
  return {
    kind: COMPETITIVE_TASK_KIND,
    rowId: row.rowId,
    family: row.family,
    workloadClass: row.workloadClass,
    preRegisteredArmSet: row.armSet.map((reference) => ({
      armKind: reference.armKind,
      corpusRowId: reference.corpusRowId,
      recordedDigest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
      workloadClass: reference.workloadClass,
    })),
    adjustedBasisReferences: row.adjustedBasisReferences.map((reference) => ({
      corpusRowId: reference.corpusRowId,
      family: reference.family,
      recordedDigest: reference.recordedDigest,
    })),
    longitudinalContextDigest: row.longitudinalContext.contextDigest,
    substrateWindows: row.substrateContext.map((reference) => reference.windowId),
    minimumPairedRounds: row.minimumPairedRounds,
    minimumDistinctArms: row.minimumDistinctArms,
    multipleComparisonPolicy: {
      method: row.multipleComparison.method,
      familyWiseLevel: row.multipleComparison.familyWiseLevel,
      familySize: row.multipleComparison.familySize,
    },
    ...(row.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: row.latencyBudgetMs }),
    ...(row.declaredWeights === undefined
      ? {}
      : {
          declaredWeights: row.declaredWeights.map((entry) => ({
            workloadClass: entry.workloadClass,
            weight: entry.weight,
          })),
        }),
    wilsonConfidenceLevel: 0.95,
    expectedVerdict: row.expected.verdict,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const COMPETITIVE_ROW_IDS: readonly string[] = COMPETITIVE_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function competitiveRowById(rowId: string): CompetitiveCorpusRow | null {
  return COMPETITIVE_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

// ---------------------------------------------------------------------------
// The corpus fingerprint (the deterministic-corpus digest)
// ---------------------------------------------------------------------------

/**
 * The corpus's input digest over the full pinned recorded basis (PURE
 * — the deterministic-corpus fingerprint the config carries): every
 * recorded arm digest + every adjusted-basis record digest + the
 * longitudinal context digest, in corpus order.
 */
export function pinnedCompetitiveInputDigest(): string {
  return economicDigestOf({
    corpus: COMPETITIVE_CORPUS_VERSION,
    arms: COMPETITIVE_CORPUS.flatMap((row) =>
      row.armSet.map((reference) => [
        row.rowId,
        reference.armKind,
        reference.corpusRowId,
        reference.recordedDigest,
      ]),
    ),
    adjustedBasis: COMPETITIVE_CORPUS.flatMap((row) =>
      row.adjustedBasisReferences.map((reference) => [
        row.rowId,
        reference.corpusRowId,
        reference.recordedDigest,
      ]),
    ),
    longitudinalContext: LONGITUDINAL_CONTEXT.contextDigest,
  });
}
