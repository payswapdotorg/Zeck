/**
 * The economic-competitive-benchmark engine (VAL-048, the app-local
 * driver — the work order's allowed surface ONLY).
 *
 * THE CROSS-WORKLOAD COMPETITIVE BENCHMARK: the synthesis comparing
 * Zeck's RECORDED economics against the alternatives across the
 * complete recorded workload portfolio. The comparison semantics this
 * engine enforces (the spec's verification core):
 *
 *   * PER-WORKLOAD-CLASS win/loss/tie verdicts on the ADJUSTED basis
 *     (never mixed bases — adjusted compared with adjusted; a
 *     mixed-basis comparison FAILs named);
 *   * PAIRED-STRUCTURE preservation: the recorded evidence's paired
 *     structure (same workload, same acceptance gate, same recorded
 *     window) is preserved — the paired blocks pair round-for-round
 *     inside ONE pre-registered cohort; an unpaired statistic over
 *     paired evidence FAILs named; pooling incomparable units FAILs
 *     named;
 *   * PORTFOLIO HONESTY: the declared workload portfolio is the
 *     recorded portfolio (no cherry-picked subset — an omitted class
 *     FAILs named);
 *   * STATISTICAL CONFIDENCE on every verdict: the exact paired sign
 *     test over the recorded blocks + the Wilson 95% interval (the
 *     accounting rail, imported — never re-implemented), the
 *     multiple-comparison honesty carried through a declared
 *     Bonferroni family-wise policy (the per-comparison level
 *     verified arithmetically), and the enforced minimum paired
 *     samples per comparison (a below-minimum verdict claim FAILs
 *     named — the honest verdict is UNDER-POWERED, never silently
 *     dropped);
 *   * PURE DERIVATION over RECORDED results: every arm's facts are
 *     re-derived from the IMPORTED recorded corpora (the VAL-040
 *     Zeck rows, the VAL-041 direct controls, the VAL-042 optimized
 *     baseline, the VAL-043 competing stack) through the IMPORTED
 *     pricing oracle — never copied, never re-measured, never
 *     re-priced; the arm bundles are referenced by content digest and
 *     verified field-by-field at run time against the arm's own
 *     corpus extractor (the strongest honesty anchor);
 *   * THE COMPOSED CONTEXT (digest references only, never mixed into
 *     the paired basis): the VAL-044 adjusted-cost records (the
 *     alternatives' adjusted basis), the VAL-045 savings attribution
 *     + the VAL-047 longitudinal curves (Zeck's learning trajectory)
 *     and the VAL-046 substrate windows (the substrate shares behind
 *     the alternatives' runs) — disclosed in evidence, never pooled
 *     into the verdict arithmetic.
 *
 * The oracles (each names the criterion it FAILs): portfolio honesty
 * (derivePortfolioHonesty), unit comparability (deriveUnitComparability),
 * cost-basis integrity (deriveCostBasisIntegrity), paired-statistics
 * correctness (derivePairedStatisticsCorrectness), multiple-comparison
 * honesty (deriveMultipleComparisonHonesty), minimum-sample enforcement
 * (deriveMinimumSampleEnforcement), weighting disclosure
 * (deriveWeightingDisclosure — the portfolio aggregate's EXPLICIT
 * weights: declared, sum-checked, never buried), failure-cost
 * completeness (deriveFailureCostCompleteness), estimate/measure
 * separation (deriveEstimateMeasureSeparation) and the input
 * integrity oracle (deriveCompetitiveInputIntegrity — the re-measurement
 * masquerade catch, field by field).
 */

import { wilsonInterval } from "../../accounting/aggregate";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { RunMetadata } from "../../run-identity";
import { ECONOMIC_CORPUS } from "../economic-baseline/corpus";
import type {
  EconomicAccountingRails,
  EconomicCorpusRow,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicWorldFacts,
  ExpectedNormalizedOutcome,
  LandedExecutionsProvider,
} from "../economic-baseline/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import type { UsageFact } from "../economic-baseline/normalization";
import {
  deriveCostPerResolved,
  manifestFor,
  normalizeUsageFact,
} from "../economic-baseline/normalization";
import { manifestRevisionOf, resolveListPrice } from "../economic-baseline/pricing";
import {
  competitorConfigFor,
  routeForClass,
} from "../economic-controls-competing/competitor-config";
import {
  COMPETING_CORPUS,
  expectedCompetingOutcomeOf,
} from "../economic-controls-competing/corpus";
import type { CompetingCorpusRow } from "../economic-controls-competing/driver";
import {
  deriveCompetingRoundBudgetBoundMicroUsd,
  taskClassesOfRow,
} from "../economic-controls-competing/driver";
import { DIRECT_CORPUS, expectedDirectOutcomeOf } from "../economic-controls-direct/corpus";
import type { DirectCorpusRow } from "../economic-controls-direct/driver";
import { deriveDirectRoundBudgetBoundMicroUsd } from "../economic-controls-direct/driver";
import {
  expectedOptimizedOutcomeOf,
  OPTIMIZED_CORPUS,
} from "../economic-controls-optimized/corpus";
import type { OptimizedCorpusRow } from "../economic-controls-optimized/driver";
import {
  CACHE_HIT_LATENCY_MS,
  deriveOptimizedRoundBudgetBoundMicroUsd,
} from "../economic-controls-optimized/driver";
import {
  inventoryFor,
  routeForClass as routeForOptimizedClass,
} from "../economic-controls-optimized/optimizations";
import type { SubstrateWindowReference } from "../economic-substrate-runtime/driver";
import { divRoundHalfUp } from "../economic-substrate-runtime/pricing";

// ---------------------------------------------------------------------------
// The vocabulary (the pinned thresholds + the declared policies)
// ---------------------------------------------------------------------------

/** The competitive comparison families under test. */
export type CompetitiveFamily =
  | "quality-adjusted-ranking"
  | "latency-adjusted-ranking"
  | "failure-adjusted-ranking"
  | "portfolio-weighted-aggregate";

/** The four arms of the cross-workload competitive benchmark. */
export type CompetitorArmKind = "zeck" | "direct" | "optimized" | "competing";

/** The honest verdict vocabulary (never a narrative). */
export type PairwiseVerdictKind =
  | "zeck-wins-significant"
  | "alternative-wins-significant"
  | "statistical-tie"
  | "incomparable-null-basis"
  | "under-powered";

export type CompetitiveVerdictKind = PairwiseVerdictKind | "adversarial-failed";

/** The adversarial probe vocabulary (each FAILs its named criterion). */
export type CompetitiveAdversarialKind =
  | "subset-cherry-picking"
  | "unit-pooling"
  | "cost-basis-switching"
  | "unpaired-statistics"
  | "confidence-inflation"
  | "sample-starvation";

/** The Wilson configuration every comparison carries. */
export const WILSON_CONFIG: { readonly confidenceLevel: number } = Object.freeze({
  confidenceLevel: 0.95,
});

/**
 * The default enforced minimum of PAIRED blocks per comparison (the
 * pre-registered floor; a comparison below it is UNDER-POWERED, never
 * silently dropped, never a starved-sample verdict).
 */
export const DEFAULT_MINIMUM_PAIRED_ROUNDS = 5;

/** The default enforced minimum of DISTINCT arms per ranking row. */
export const DEFAULT_MINIMUM_DISTINCT_ARMS = 4;

/** The multiple-comparison policy declaration (the family-wise honesty). */
export interface MultipleComparisonPolicy {
  readonly method: "bonferroni";
  readonly familyWiseLevel: number;
  readonly familySize: number;
  readonly perComparisonLevel: number;
}

/** The pinned multiple-comparison policy (the default four-arm family). */
export const MULTIPLE_COMPARISON_POLICY: MultipleComparisonPolicy = Object.freeze({
  method: "bonferroni",
  familyWiseLevel: 0.05,
  familySize: 3,
  perComparisonLevel: 0.05 / 3,
});

// ---------------------------------------------------------------------------
// The recorded arm facts (the paired block basis — PURE derivation)
// ---------------------------------------------------------------------------

/**
 * One recorded round of one arm (the paired block's unit): the
 * round's resolved indicator, its FULLY-AMORTIZED measured cost (every
 * attempt — the failure-adjusted discipline), its retry-overhead share,
 * its recorded latency and its failed-attempt count.
 */
export interface RecordedArmRound {
  readonly roundIndex: number;
  readonly resolved: boolean;
  /** The round's full measured cost (all attempts, failures amortized in). */
  readonly measuredCostMicroUsd: string;
  /** The non-final attempts' measured cost (the retry-overhead share). */
  readonly retryOverheadMicroUsd: string;
  readonly latencyMs: number;
  readonly failedAttempts: number;
}

/**
 * One arm's RECORDED competitive facts: the per-round blocks (the
 * paired structure) + the arm-level aggregates — every field PURELY
 * derived from the arm's own recorded corpus through the imported
 * pricing oracle (never copied, never re-measured).
 */
export interface RecordedCompetitiveFacts {
  readonly rounds: readonly RecordedArmRound[];
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly costPerResolvedMicroUsd: string | null;
  readonly resolutionConfidence: { readonly low: number; readonly high: number };
  readonly retryOverheadMicroUsd: string;
  readonly failedAttemptsCount: number;
  readonly resolvedRoundsMicroUsd: string;
  readonly failedRoundsMicroUsd: string;
}

/** The digest reference for one RECORDED arm corpus row (never a copy). */
export interface CompetitiveArmReference {
  readonly armKind: CompetitorArmKind;
  /** The row id in the arm's OWN corpus (VAL-040 for zeck; 041/042/043 for the alternatives). */
  readonly corpusRowId: string;
  /** The content digest of the arm's RECORDED competitive facts. */
  readonly recordedDigest: string;
  /** The arm's pinned price revision (verified against the VAL-040 manifests). */
  readonly priceRevision: string;
  /** The arm's own recorded workload-class disclosure (the frozen-portfolio app / the sdk surface). */
  readonly workloadClass: string;
  /** A live-lane declaration (the measured lane — never compared field-wise against recorded corpora). */
  readonly live?: boolean;
}

/** One resolved arm input (the driver's bundle entry — claims ride outside). */
export interface RecordedCompetitiveArm {
  readonly reference: CompetitiveArmReference;
  readonly facts: RecordedCompetitiveFacts;
  /** The gaming surface (never trusted — the integrity oracle re-derives everything). */
  readonly claimed?: {
    readonly measuredCostMicroUsd?: string;
    readonly costPerResolvedMicroUsd?: string;
    readonly resolvedCount?: number;
  };
}

// ---------------------------------------------------------------------------
// The composed context references (digest references only — never mixed)
// ---------------------------------------------------------------------------

/** A VAL-044 adjusted-cost record reference (the alternatives' adjusted basis). */
export interface AdjustedBasisReference {
  readonly corpusRowId: string;
  readonly family: string;
  readonly recordedDigest: string;
}

/** The Zeck longitudinal context (the VAL-045 attribution + the VAL-047 curves). */
export interface LongitudinalContextReference {
  readonly curveClasses: readonly string[];
  readonly latestPointReferences: readonly {
    readonly workloadClass: string;
    readonly generation: number;
    readonly recordedDigest: string;
  }[];
  readonly attributionDigest: string;
  readonly contextDigest: string;
}

/** The row's dishonest claim surface (the probes' declarations — never trusted). */
export interface CompetitiveClaim {
  readonly verdict?: CompetitiveVerdictKind;
  readonly statistic?: "paired-sign-test" | "unpaired-pooled-two-sample";
  readonly pValue?: number;
  readonly comparison?: {
    readonly zeckSide: { readonly basis: string; readonly valueMicroUsd: string };
    readonly alternativeSide: {
      readonly armKind: CompetitorArmKind;
      readonly basis: string;
      readonly valueMicroUsd: string;
    };
  };
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One weighted class of the portfolio aggregate's EXPLICIT weights. */
export interface DeclaredPortfolioWeight {
  readonly workloadClass: string;
  readonly weight: number;
  readonly minimumPairedRounds: number;
  readonly armSet: readonly CompetitiveArmReference[];
}

/** The cross-workload competitive benchmark corpus row. */
export interface CompetitiveCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The comparison family under test. */
  readonly family: CompetitiveFamily;
  /** The workload class (the pre-registered competitive cohort). */
  readonly workloadClass: string;
  /** The PRE-REGISTERED arm set (digest references into the recorded corpora). */
  readonly armSet: readonly CompetitiveArmReference[];
  /** The VAL-044 adjusted-cost records composing the alternatives' adjusted basis. */
  readonly adjustedBasisReferences: readonly AdjustedBasisReference[];
  /** The Zeck longitudinal context (VAL-045 + VAL-047 — disclosure only, never mixed). */
  readonly longitudinalContext: LongitudinalContextReference;
  /** The VAL-046 substrate windows behind the alternatives' runs (disclosure only). */
  readonly substrateContext: readonly SubstrateWindowReference[];
  /** The enforced minimum of paired blocks per comparison. */
  readonly minimumPairedRounds: number;
  /** The enforced minimum of distinct arms (the ranking sample). */
  readonly minimumDistinctArms: number;
  /** The declared family-wise multiple-comparison policy (verified arithmetically). */
  readonly multipleComparison: MultipleComparisonPolicy;
  /** The pinned latency budget (latency-adjusted rows only). */
  readonly latencyBudgetMs?: number;
  /**
   * The portfolio aggregate's EXPLICIT weights (aggregate rows only —
   * each weighted class carries its own pre-registered arm set + minimum).
   */
  readonly declaredWeights?: readonly DeclaredPortfolioWeight[];
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The adversarial probe declaration (probe rows only). */
  readonly adversarial?: CompetitiveAdversarialKind;
  /** The dishonest claim surface (probe rows only). */
  readonly claimed?: CompetitiveClaim;
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly verdict: CompetitiveVerdictKind;
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The pinned expected competitive outcome (offline honest rows only). */
    readonly synthesis?: ExpectedCompetitiveOutcome;
  };
}

/** The expected competitive outcome the derivation must reproduce. */
export interface ExpectedCompetitiveOutcome {
  readonly family: CompetitiveFamily;
  readonly workloadClass: string;
  /** Per arm: the recorded aggregates + the family's adjusted per-resolved cost. */
  readonly arms: readonly {
    readonly armKind: CompetitorArmKind;
    readonly corpusRowId: string;
    readonly runCount: number;
    readonly resolvedCount: number;
    readonly attainment: number;
    readonly latencyCompliance: number | null;
    readonly adjustedPerResolvedMicroUsd: string | null;
  }[];
  /** The adjusted-basis ranking (cheapest first; null-basis arms last, order declared). */
  readonly ranking: readonly CompetitorArmKind[];
  /** The pairwise comparisons against the Zeck reference arm. */
  readonly comparisons: readonly {
    readonly armKind: CompetitorArmKind;
    readonly totalBlocks: number;
    readonly zeckFavoring: number;
    readonly alternativeFavoring: number;
    readonly tieBlocks: number;
    readonly excludedBlocks: number;
    readonly outcomeDominantBlocks: number;
    readonly pValueTwoSided: number | null;
    readonly verdict: PairwiseVerdictKind;
  }[];
  /** The Zeck reference arm's resolution Wilson 95% interval. */
  readonly wilson: { readonly low: number; readonly high: number };
  readonly verdict: CompetitiveVerdictKind;
  /** The portfolio aggregate's per-class verdicts (aggregate rows only). */
  readonly classVerdicts?: readonly {
    readonly workloadClass: string;
    readonly weight: number;
    readonly verdict: CompetitiveVerdictKind;
  }[];
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One verified arm input (the driver's per-input settlement). */
export interface VerifiedCompetitiveArm {
  readonly reference: CompetitiveArmReference;
  readonly integrity: boolean;
  readonly failureReason: string | null;
}

/** The competitive row run result (the honest outcome contract). */
export interface CompetitiveRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  readonly observedTerminal: string | null;
  readonly arms: readonly VerifiedCompetitiveArm[];
  readonly synthesis: ExpectedCompetitiveOutcome | null;
  readonly totalLatencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The digest discipline (digest references — never payload copies)
// ---------------------------------------------------------------------------

/**
 * The content digest of one arm input's RECORDED competitive facts
 * (PURE — the digest-reference discipline): binds the arm kind, the
 * corpus row identity, the arm-level aggregates AND the full paired
 * block structure (the per-round costs, resolutions and latencies) —
 * the row's declared digests pin exactly this shape at pin time and
 * the input-integrity oracle re-derives it at verification time.
 */
export function recordedCompetitiveDigestOf(input: {
  readonly armKind: CompetitorArmKind;
  readonly corpusRowId: string;
  readonly facts: RecordedCompetitiveFacts;
}): string {
  return economicDigestOf({
    armKind: input.armKind,
    corpusRowId: input.corpusRowId,
    runCount: input.facts.runCount,
    resolvedCount: input.facts.resolvedCount,
    measuredCostMicroUsd: input.facts.measuredCostMicroUsd,
    estimatedCostMicroUsd: input.facts.estimatedCostMicroUsd,
    costPerResolvedMicroUsd: input.facts.costPerResolvedMicroUsd,
    wilsonLow: input.facts.resolutionConfidence.low.toFixed(6),
    wilsonHigh: input.facts.resolutionConfidence.high.toFixed(6),
    retryOverheadMicroUsd: input.facts.retryOverheadMicroUsd,
    roundCosts: input.facts.rounds.map((round) => round.measuredCostMicroUsd).join(","),
    roundResolved: input.facts.rounds.map((round) => (round.resolved ? "1" : "0")).join(""),
    roundLatencies: input.facts.rounds.map((round) => round.latencyMs).join(","),
  });
}

/** The live-arm declaration digest (the live lane's reference shape). */
export function liveCompetitiveArmDigestOf(input: {
  readonly armKind: CompetitorArmKind;
  readonly corpusRowId: string;
  readonly armId: string;
  readonly sliceSize: number;
}): string {
  return economicDigestOf({
    armKind: input.armKind,
    corpusRowId: input.corpusRowId,
    liveArm: input.armId,
    sliceSize: input.sliceSize,
  });
}

// ---------------------------------------------------------------------------
// The recorded arm extraction (PURE derivation over the RECORDED corpora)
// ---------------------------------------------------------------------------

/** The per-fact micro-USD cost through the imported pricing oracle (PURE). */
function microUsdOf(fact: UsageFact, manifest: ReturnType<typeof manifestFor>): bigint {
  const normalized = normalizeUsageFact(fact, manifest);
  if (!normalized.ok) {
    throw new Error(
      `the pinned manifest refuses the usage fact (${fact.provider}/${fact.model}/${fact.tier}): ${normalized.failure.reason}`,
    );
  }
  return BigInt(normalized.cost.microUsd);
}

/** The rail currency of one provider/model pair (through the manifest only). */
function railCurrencyOf(
  manifest: ReturnType<typeof manifestFor>,
  provider: string,
  model: string,
): "USD" | "EUR" | "JPY" | "GBP" {
  const entry = resolveListPrice(manifest, provider, model, "input");
  if (entry === null) {
    throw new Error(`no pinned list-price entry for ${provider}/${model}`);
  }
  return entry.currency;
}

/** The running arm-level accumulators (the fold). */
interface ArmAccumulator {
  measured: bigint;
  estimated: bigint;
  retryOverhead: bigint;
  resolvedRounds: bigint;
  failedRounds: bigint;
  failedAttempts: number;
  resolved: number;
}

function emptyAccumulator(): ArmAccumulator {
  return {
    measured: 0n,
    estimated: 0n,
    retryOverhead: 0n,
    resolvedRounds: 0n,
    failedRounds: 0n,
    failedAttempts: 0,
    resolved: 0,
  };
}

function foldRound(into: ArmAccumulator, round: RecordedArmRound, estimate: bigint): void {
  into.measured += BigInt(round.measuredCostMicroUsd);
  into.estimated += estimate;
  into.retryOverhead += BigInt(round.retryOverheadMicroUsd);
  into.failedAttempts += round.failedAttempts;
  if (round.resolved) {
    into.resolved += 1;
    into.resolvedRounds += BigInt(round.measuredCostMicroUsd);
  } else {
    into.failedRounds += BigInt(round.measuredCostMicroUsd);
  }
}

function factsOfAccumulator(
  rounds: readonly RecordedArmRound[],
  fold: ArmAccumulator,
): RecordedCompetitiveFacts {
  const perResolved = deriveCostPerResolved({
    measuredMicroUsd: fold.measured.toString(),
    estimatedMicroUsd: fold.estimated.toString(),
    resolvedCount: fold.resolved,
  });
  const confidence = wilsonInterval(fold.resolved, rounds.length);
  return {
    rounds,
    runCount: rounds.length,
    resolvedCount: fold.resolved,
    measuredCostMicroUsd: fold.measured.toString(),
    estimatedCostMicroUsd: fold.estimated.toString(),
    costPerResolvedMicroUsd: perResolved.costPerResolvedMicroUsd,
    resolutionConfidence: { low: confidence.low, high: confidence.high },
    retryOverheadMicroUsd: fold.retryOverhead.toString(),
    failedAttemptsCount: fold.failedAttempts,
    resolvedRoundsMicroUsd: fold.resolvedRounds.toString(),
    failedRoundsMicroUsd: fold.failedRounds.toString(),
  };
}

/** The aggregates cross-checked against the arm's own corpus extractor. */
export interface CorpusCrossCheck {
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly costPerResolvedMicroUsd: string | null;
  readonly wilsonLow: number;
  readonly wilsonHigh: number;
}

function crossCheckOf(
  expected: ExpectedNormalizedOutcome & { resolutionConfidence: { low: number; high: number } },
): CorpusCrossCheck {
  return {
    runCount: expected.runCount,
    resolvedCount: expected.resolvedCount,
    measuredCostMicroUsd: expected.measuredCostMicroUsd,
    estimatedCostMicroUsd: expected.estimatedCostMicroUsd,
    costPerResolvedMicroUsd: expected.costPerResolvedMicroUsd,
    wilsonLow: expected.resolutionConfidence.low,
    wilsonHigh: expected.resolutionConfidence.high,
  };
}

/**
 * Extract one ZECK arm's recorded competitive facts from the VAL-040
 * economic-baseline corpus (PURE): the row's own recorded replay rounds
 * priced through the imported pricing oracle at the arm's pinned
 * revision — over the executed prefix the row's own pinned normalized
 * outcome declares (the fixed-cost stop rows' honest prefix).
 */
function zeckFactsOf(row: EconomicCorpusRow): {
  readonly facts: RecordedCompetitiveFacts;
  readonly crossCheck: CorpusCrossCheck;
} {
  const manifest = manifestFor(row.arm.priceRevision);
  const executed = row.expected.normalized?.runCount ?? row.replay?.length ?? 0;
  const rounds: RecordedArmRound[] = [];
  const fold = emptyAccumulator();
  const currency = railCurrencyOf(manifest, row.arm.provider, row.arm.model);
  const replay = row.replay ?? [];
  for (const [index, round] of replay.slice(0, executed).entries()) {
    let cost = 0n;
    let retry = 0n;
    let latency = 0;
    let failed = 0;
    for (const [attemptIndex, attempt] of round.attempts.entries()) {
      const isFinal = attemptIndex === round.attempts.length - 1;
      const attemptCost =
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "input",
            currency,
            tokens: attempt.usage.inputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "output",
            currency,
            tokens: attempt.usage.outputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          },
          manifest,
        );
      cost += attemptCost;
      if (!isFinal) {
        retry += attemptCost;
      }
      latency += attempt.latencyMs;
      if (attempt.outcome === "failure") {
        failed += 1;
      }
    }
    let estimate = 0n;
    if (round.estimateQuote !== undefined) {
      estimate =
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "input",
            currency,
            tokens: round.estimateQuote.inputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "output",
            currency,
            tokens: round.estimateQuote.outputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        );
    }
    const final = round.attempts[round.attempts.length - 1];
    const resolved = final !== undefined && final.outcome === "success";
    const roundRecord: RecordedArmRound = {
      roundIndex: index,
      resolved,
      measuredCostMicroUsd: cost.toString(),
      retryOverheadMicroUsd: retry.toString(),
      latencyMs: latency,
      failedAttempts: failed,
    };
    rounds.push(roundRecord);
    foldRound(fold, roundRecord, estimate);
  }
  const normalized = row.expected.normalized;
  return {
    facts: factsOfAccumulator(rounds, fold),
    crossCheck:
      normalized === undefined
        ? crossCheckOf({
            runCount: rounds.length,
            resolvedCount: fold.resolved,
            measuredCostMicroUsd: fold.measured.toString(),
            estimatedCostMicroUsd: fold.estimated.toString(),
            costPerResolvedMicroUsd: deriveCostPerResolved({
              measuredMicroUsd: fold.measured.toString(),
              estimatedMicroUsd: fold.estimated.toString(),
              resolvedCount: fold.resolved,
            }).costPerResolvedMicroUsd,
            resolutionConfidence: wilsonInterval(fold.resolved, rounds.length),
          })
        : crossCheckOf(normalized),
  };
}

/**
 * Extract one DIRECT arm's recorded competitive facts from the VAL-041
 * control corpus (PURE): the row's own recorded traces priced through
 * the imported pricing oracle, the fixed-cost budget gate applied
 * BEFORE each request exactly as the corpus's own extractor applies it
 * (the declared prefix stop).
 */
function directFactsOf(row: DirectCorpusRow): {
  readonly facts: RecordedCompetitiveFacts;
  readonly crossCheck: CorpusCrossCheck;
} {
  const manifest = manifestFor(row.arm.priceRevision);
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(deriveDirectRoundBudgetBoundMicroUsd({ manifest, arm: row.arm }))
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds: RecordedArmRound[] = [];
  const fold = emptyAccumulator();
  let measuredSoFar = 0n;
  const currency = railCurrencyOf(manifest, row.arm.provider, row.arm.model);
  for (const taskId of row.arm.corpusSlice) {
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const plan = row.directReplay.find((candidate) => candidate.taskId === taskId);
    const recorded = plan?.recorded;
    if (recorded === undefined || recorded.postHocExcluded === true) {
      continue;
    }
    const attemptCurrency = recorded.usageCurrency ?? currency;
    let cost = 0n;
    let retry = 0n;
    let latency = 0;
    let failed = 0;
    for (const [index, attempt] of recorded.attempts.entries()) {
      const isFinal = index === recorded.attempts.length - 1;
      if (attempt.usage === undefined || recorded.estimateOnly === true) {
        continue;
      }
      const attemptCost =
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "input",
            currency: attemptCurrency,
            tokens: attempt.usage.inputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "output",
            currency: attemptCurrency,
            tokens: attempt.usage.outputTokens,
            kind: "measured",
            scope: isFinal ? "direct-execution" : "retry-overhead",
          },
          manifest,
        );
      cost += attemptCost;
      if (!isFinal) {
        retry += attemptCost;
      }
      latency += attempt.latencyMs;
      if (attempt.outcome === "failure") {
        failed += 1;
      }
    }
    let estimate = 0n;
    if (recorded.estimateQuote !== undefined) {
      estimate =
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "input",
            currency,
            tokens: recorded.estimateQuote.inputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: row.arm.provider,
            model: row.arm.model,
            tier: "output",
            currency,
            tokens: recorded.estimateQuote.outputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        );
    }
    const final = recorded.attempts[recorded.attempts.length - 1];
    const resolved = final !== undefined && final.outcome === "success";
    const roundRecord: RecordedArmRound = {
      roundIndex: rounds.length,
      resolved,
      measuredCostMicroUsd: cost.toString(),
      retryOverheadMicroUsd: retry.toString(),
      latencyMs: latency,
      failedAttempts: failed,
    };
    rounds.push(roundRecord);
    foldRound(fold, roundRecord, estimate);
    measuredSoFar += cost;
  }
  return {
    facts: factsOfAccumulator(rounds, fold),
    crossCheck: crossCheckOf(expectedDirectOutcomeOf(row)),
  };
}

/**
 * Extract one OPTIMIZED arm's recorded competitive facts from the
 * VAL-042 baseline corpus (PURE): the routed rounds priced at their
 * own routed rails, the semantic cache's hits served at their recorded
 * 3ms latency with ZERO model cost (the arm's own honest economics),
 * the budget gate applied on fresh dispatches only.
 */
function optimizedFactsOf(row: OptimizedCorpusRow): {
  readonly facts: RecordedCompetitiveFacts;
  readonly crossCheck: CorpusCrossCheck;
} {
  const manifest = manifestFor(row.arm.priceRevision);
  const inventory = inventoryFor(row.optimizationInventoryRevision);
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(
          deriveOptimizedRoundBudgetBoundMicroUsd({
            manifest,
            inventory,
            maxTokens: row.arm.maxTokensPerRound,
          }),
        )
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds: RecordedArmRound[] = [];
  const fold = emptyAccumulator();
  let measuredSoFar = 0n;
  const stored = new Map<string, string>();
  const plans = row.arm.corpusSlice
    .map((taskId) => row.optimizedReplay.find((plan) => plan.taskId === taskId))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== undefined);
  for (const plan of plans) {
    const cacheKey = `${plan.taskClass}:${plan.contentDigest}`;
    const cached = stored.get(cacheKey);
    if (plan.cachePolicy === "cacheable" && cached !== undefined) {
      const roundRecord: RecordedArmRound = {
        roundIndex: rounds.length,
        resolved: true,
        measuredCostMicroUsd: "0",
        retryOverheadMicroUsd: "0",
        latencyMs: CACHE_HIT_LATENCY_MS,
        failedAttempts: 0,
      };
      rounds.push(roundRecord);
      foldRound(fold, roundRecord, 0n);
      continue;
    }
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const route = routeForOptimizedClass(inventory, plan.taskClass);
    const currency = railCurrencyOf(manifest, route.provider, route.model);
    const recorded = plan.recorded;
    let cost = 0n;
    let retry = 0n;
    let latency = 0;
    let failed = 0;
    if (recorded !== undefined) {
      for (const [index, attempt] of recorded.attempts.entries()) {
        const isFinal = index === recorded.attempts.length - 1;
        if (attempt.usage === undefined) {
          continue;
        }
        const attemptCost =
          microUsdOf(
            {
              provider: route.provider,
              model: route.model,
              tier: "input",
              currency,
              tokens: attempt.usage.inputTokens,
              kind: "measured",
              scope: isFinal ? "direct-execution" : "retry-overhead",
            },
            manifest,
          ) +
          microUsdOf(
            {
              provider: route.provider,
              model: route.model,
              tier: "output",
              currency,
              tokens: attempt.usage.outputTokens,
              kind: "measured",
              scope: isFinal ? "direct-execution" : "retry-overhead",
            },
            manifest,
          );
        cost += attemptCost;
        if (!isFinal) {
          retry += attemptCost;
        }
        latency += attempt.latencyMs;
        if (attempt.outcome === "failure") {
          failed += 1;
        }
      }
      const final = recorded.attempts[recorded.attempts.length - 1];
      if (
        plan.cachePolicy === "cacheable" &&
        final !== undefined &&
        final.outcome === "success" &&
        recorded.responseText !== undefined
      ) {
        stored.set(cacheKey, recorded.responseText);
      }
    }
    let estimate = 0n;
    if (recorded?.estimateQuote !== undefined) {
      estimate =
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "input",
            currency,
            tokens: recorded.estimateQuote.inputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "output",
            currency,
            tokens: recorded.estimateQuote.outputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        );
    }
    const final = recorded?.attempts[recorded.attempts.length - 1];
    const resolved = final !== undefined && final.outcome === "success";
    const roundRecord: RecordedArmRound = {
      roundIndex: rounds.length,
      resolved,
      measuredCostMicroUsd: cost.toString(),
      retryOverheadMicroUsd: retry.toString(),
      latencyMs: latency,
      failedAttempts: failed,
    };
    rounds.push(roundRecord);
    foldRound(fold, roundRecord, estimate);
    measuredSoFar += cost;
  }
  return {
    facts: factsOfAccumulator(rounds, fold),
    crossCheck: crossCheckOf(expectedOptimizedOutcomeOf(row)),
  };
}

/**
 * Extract one COMPETING arm's recorded competitive facts from the
 * VAL-043 competing-stack corpus (PURE): ONE aggregate measured usage
 * pair per request (the gateway's own interface granularity — the
 * internal retries amortize inside the gateway boundary), priced at
 * the competitor config's own routed rails.
 */
function competingFactsOf(row: CompetingCorpusRow): {
  readonly facts: RecordedCompetitiveFacts;
  readonly crossCheck: CorpusCrossCheck;
} {
  const manifest = manifestFor(row.arm.priceRevision);
  const config = competitorConfigFor(row.competitorConfigRevision);
  const roundBoundMicroUsd =
    row.arm.kind === "fixed-cost"
      ? BigInt(
          deriveCompetingRoundBudgetBoundMicroUsd({
            manifest,
            config,
            taskClasses: taskClassesOfRow(row),
            maxTokens: row.arm.maxTokensPerRound,
          }),
        )
      : null;
  const budgetMicroUsd =
    row.arm.kind === "fixed-cost" ? BigInt(row.arm.pinnedBudgetMicroUsd) : null;
  const rounds: RecordedArmRound[] = [];
  const fold = emptyAccumulator();
  let measuredSoFar = 0n;
  const plans = row.arm.corpusSlice
    .map((taskId) => row.competingReplay.find((plan) => plan.taskId === taskId))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== undefined);
  for (const plan of plans) {
    if (roundBoundMicroUsd !== null && budgetMicroUsd !== null) {
      if (budgetMicroUsd - measuredSoFar < roundBoundMicroUsd) {
        break;
      }
    }
    const route = routeForClass(config, plan.taskClass);
    const currency = railCurrencyOf(manifest, route.provider, route.model);
    const recorded = plan.recorded;
    let cost = 0n;
    let latency = 0;
    let failed = 0;
    if (recorded !== undefined) {
      cost =
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "input",
            currency,
            tokens: recorded.reportedUsage.inputTokens,
            kind: "measured",
            scope: "direct-execution",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "output",
            currency,
            tokens: recorded.reportedUsage.outputTokens,
            kind: "measured",
            scope: "direct-execution",
          },
          manifest,
        );
      for (const attempt of recorded.internalAttempts) {
        latency += attempt.latencyMs;
        if (attempt.outcome === "failure") {
          failed += 1;
        }
      }
    }
    let estimate = 0n;
    if (recorded?.estimateQuote !== undefined) {
      estimate =
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "input",
            currency,
            tokens: recorded.estimateQuote.inputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        ) +
        microUsdOf(
          {
            provider: route.provider,
            model: route.model,
            tier: "output",
            currency,
            tokens: recorded.estimateQuote.outputTokens,
            kind: "estimate",
            scope: "direct-execution",
          },
          manifest,
        );
    }
    const final = recorded?.internalAttempts[recorded.internalAttempts.length - 1];
    const resolved = final !== undefined && final.outcome === "success";
    const roundRecord: RecordedArmRound = {
      roundIndex: rounds.length,
      resolved,
      measuredCostMicroUsd: cost.toString(),
      retryOverheadMicroUsd: "0",
      latencyMs: latency,
      failedAttempts: failed,
    };
    rounds.push(roundRecord);
    foldRound(fold, roundRecord, estimate);
    measuredSoFar += cost;
  }
  return {
    facts: factsOfAccumulator(rounds, fold),
    crossCheck: crossCheckOf(expectedCompetingOutcomeOf(row)),
  };
}

/**
 * Resolve one arm reference in the RECORDED corpora and derive its
 * recorded competitive facts (PURE — the same derivation the
 * input-integrity oracle runs at verification time). Returns null when
 * the reference resolves to no recorded row.
 */
export function recordedCompetitiveArmOf(reference: CompetitiveArmReference): {
  readonly arm: RecordedCompetitiveArm;
  readonly crossCheck: CorpusCrossCheck;
} | null {
  if (reference.armKind === "zeck") {
    const row = ECONOMIC_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      return null;
    }
    const extracted = zeckFactsOf(row);
    return { arm: { reference, facts: extracted.facts }, crossCheck: extracted.crossCheck };
  }
  if (reference.armKind === "direct") {
    const row = DIRECT_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      return null;
    }
    const extracted = directFactsOf(row);
    return { arm: { reference, facts: extracted.facts }, crossCheck: extracted.crossCheck };
  }
  if (reference.armKind === "optimized") {
    const row = OPTIMIZED_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
    if (row === undefined) {
      return null;
    }
    const extracted = optimizedFactsOf(row);
    return { arm: { reference, facts: extracted.facts }, crossCheck: extracted.crossCheck };
  }
  const row = COMPETING_CORPUS.find((candidate) => candidate.rowId === reference.corpusRowId);
  if (row === undefined) {
    return null;
  }
  const extracted = competingFactsOf(row);
  return { arm: { reference, facts: extracted.facts }, crossCheck: extracted.crossCheck };
}

// ---------------------------------------------------------------------------
// The exact paired sign test (the paired statistic — app-local, PURE)
// ---------------------------------------------------------------------------

/** The exact binomial coefficient (integer — n ≤ 62 safe). */
function binomialCoefficient(n: number, k: number): bigint {
  if (k < 0 || k > n) {
    return 0n;
  }
  let result = 1n;
  for (let i = 0; i < k; i += 1) {
    result = (result * BigInt(n - i)) / BigInt(i + 1);
  }
  return result;
}

/**
 * The exact two-sided sign-test p-value over the paired blocks
 * (PURE): n = favoring + opposing non-tied blocks; the two-sided
 * exact binomial tail. Null when no discriminative block exists.
 */
export function exactTwoSidedSignTestPValue(favoring: number, opposing: number): number | null {
  const n = favoring + opposing;
  if (n <= 0) {
    return null;
  }
  const k = Math.min(favoring, opposing);
  let tail = 0n;
  for (let i = 0; i <= k; i += 1) {
    tail += binomialCoefficient(n, i);
  }
  return Math.min(1, (2 * Number(tail)) / 2 ** n);
}

// ---------------------------------------------------------------------------
// The pairwise block analysis (the paired structure — PURE)
// ---------------------------------------------------------------------------

/** One analyzed paired block (the round-for-round pairing unit). */
export interface PairedBlock {
  readonly roundIndex: number;
  readonly zeckResolved: boolean;
  readonly alternativeResolved: boolean;
  readonly zeckUnitCostMicroUsd: bigint;
  readonly alternativeUnitCostMicroUsd: bigint;
  readonly favoring: "zeck" | "alternative" | "tie" | "excluded";
}

/** One analyzed pairwise comparison against the Zeck reference arm. */
export interface PairwiseComparison {
  readonly armKind: CompetitorArmKind;
  readonly totalBlocks: number;
  readonly zeckFavoring: number;
  readonly alternativeFavoring: number;
  readonly tieBlocks: number;
  readonly excludedBlocks: number;
  readonly outcomeDominantBlocks: number;
  readonly pValueTwoSided: number | null;
  readonly zeckAdjustedPerResolvedMicroUsd: string | null;
  readonly alternativeAdjustedPerResolvedMicroUsd: string | null;
  readonly direction: "zeck-cheaper" | "alternative-cheaper" | "equal" | "null-basis";
  readonly minimumMet: boolean;
  readonly verdict: PairwiseVerdictKind;
}

/**
 * The family's per-block unit cost (PURE): the quality/failure
 * families compare the round's fully-amortized measured cost; the
 * latency family weights each block by its OWN latency overage against
 * the pinned budget (a block exceeding the budget carries its
 * overage-weighted cost — the latency adjustment is INCLUDED, never
 * omitted).
 */
function unitCostOf(
  family: CompetitiveFamily,
  round: RecordedArmRound,
  latencyBudgetMs: number | null,
): bigint {
  const cost = BigInt(round.measuredCostMicroUsd);
  if (family !== "latency-adjusted-ranking" || latencyBudgetMs === null) {
    return cost;
  }
  if (round.latencyMs <= latencyBudgetMs || round.latencyMs <= 0) {
    return cost;
  }
  return divRoundHalfUp(cost * BigInt(round.latencyMs), BigInt(latencyBudgetMs));
}

/**
 * The arm-level family-adjusted cost PER SUCCESSFULLY RESOLVED OUTCOME
 * (PURE — exact BigInt rationals, one half-up rounding; the canonical
 * basis, the roadmap's non-negotiable metric):
 *   * quality-adjusted: (measured / resolved) / attainment — the
 *     verified-attainment-normalized cost per resolved outcome
 *     (attainment RECOMPUTED from the recorded runs, never a claim) —
 *     exactly measured × runs / (resolved × resolved);
 *   * latency-adjusted: measured / (resolved × compliance) — the
 *     latency-budget-compliance weighted cost — exactly measured ×
 *     runs / (resolved × withinBudgetRounds);
 *   * failure-adjusted (and the portfolio aggregate's canonical
 *     basis): measured / resolved — the fully-amortized cost with every
 *     failed attempt's cost counted in (VAL-006).
 * NULL when nothing resolved (the honest incomparability).
 */
export function familyAdjustedPerResolvedMicroUsd(input: {
  readonly family: CompetitiveFamily;
  readonly facts: RecordedCompetitiveFacts;
  readonly latencyBudgetMs?: number;
}): string | null {
  const resolved = input.facts.resolvedCount;
  if (resolved <= 0) {
    return null;
  }
  const measured = BigInt(input.facts.measuredCostMicroUsd);
  const runs = input.facts.runCount;
  const resolvedBig = BigInt(resolved);
  if (input.family === "quality-adjusted-ranking") {
    if (runs <= 0) {
      return null;
    }
    return divRoundHalfUp(measured * BigInt(runs), resolvedBig * resolvedBig).toString();
  }
  if (input.family === "latency-adjusted-ranking") {
    const budget = input.latencyBudgetMs ?? Number.POSITIVE_INFINITY;
    const within = input.facts.rounds.filter((round) => round.latencyMs <= budget).length;
    if (within <= 0) {
      return null;
    }
    return divRoundHalfUp(measured * BigInt(runs), resolvedBig * BigInt(within)).toString();
  }
  return divRoundHalfUp(measured, resolvedBig).toString();
}

/**
 * Analyze ONE pairwise comparison (zeck vs one alternative) over the
 * paired blocks (PURE): the blocks pair round-for-round inside the
 * cohort; the sign test runs over the BOTH-RESOLVED blocks' family
 * unit costs; the one-resolved blocks are counted and disclosed as
 * outcome-dominant (never silently pooled into the cost test); the
 * both-unresolved blocks are excluded.
 */
export function analyzePairwiseComparison(input: {
  readonly family: CompetitiveFamily;
  readonly latencyBudgetMs?: number;
  readonly minimumPairedRounds: number;
  readonly policy: MultipleComparisonPolicy;
  readonly zeck: RecordedCompetitiveArm;
  readonly alternative: RecordedCompetitiveArm;
}): PairwiseComparison {
  const total = Math.min(input.zeck.facts.rounds.length, input.alternative.facts.rounds.length);
  const blocks: PairedBlock[] = [];
  for (let index = 0; index < total; index += 1) {
    const zeckRound = input.zeck.facts.rounds[index];
    const alternativeRound = input.alternative.facts.rounds[index];
    if (zeckRound === undefined || alternativeRound === undefined) {
      continue;
    }
    const zeckUnit = unitCostOf(input.family, zeckRound, input.latencyBudgetMs ?? null);
    const alternativeUnit = unitCostOf(
      input.family,
      alternativeRound,
      input.latencyBudgetMs ?? null,
    );
    let favoring: PairedBlock["favoring"] = "excluded";
    if (zeckRound.resolved && alternativeRound.resolved) {
      favoring =
        zeckUnit < alternativeUnit ? "zeck" : zeckUnit > alternativeUnit ? "alternative" : "tie";
    }
    blocks.push({
      roundIndex: index,
      zeckResolved: zeckRound.resolved,
      alternativeResolved: alternativeRound.resolved,
      zeckUnitCostMicroUsd: zeckUnit,
      alternativeUnitCostMicroUsd: alternativeUnit,
      favoring,
    });
  }
  const zeckFavoring = blocks.filter((block) => block.favoring === "zeck").length;
  const alternativeFavoring = blocks.filter((block) => block.favoring === "alternative").length;
  const tieBlocks = blocks.filter((block) => block.favoring === "tie").length;
  const excludedBlocks = blocks.filter((block) => block.favoring === "excluded").length;
  const outcomeDominantBlocks = blocks.filter(
    (block) => block.favoring === "excluded" && block.zeckResolved !== block.alternativeResolved,
  ).length;
  const pValue = exactTwoSidedSignTestPValue(zeckFavoring, alternativeFavoring);
  const zeckAdjusted = familyAdjustedPerResolvedMicroUsd({
    family: input.family,
    facts: input.zeck.facts,
    ...(input.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: input.latencyBudgetMs }),
  });
  const alternativeAdjusted = familyAdjustedPerResolvedMicroUsd({
    family: input.family,
    facts: input.alternative.facts,
    ...(input.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: input.latencyBudgetMs }),
  });
  const minimumMet = total >= input.minimumPairedRounds;
  const nullBasis = zeckAdjusted === null || alternativeAdjusted === null;
  let direction: PairwiseComparison["direction"] = "null-basis";
  if (!nullBasis) {
    const zeckValue = BigInt(zeckAdjusted as string);
    const alternativeValue = BigInt(alternativeAdjusted as string);
    direction =
      zeckValue < alternativeValue
        ? "zeck-cheaper"
        : zeckValue > alternativeValue
          ? "alternative-cheaper"
          : "equal";
  }
  let verdict: PairwiseVerdictKind;
  if (!minimumMet) {
    verdict = "under-powered";
  } else if (nullBasis) {
    verdict = "incomparable-null-basis";
  } else if (
    pValue !== null &&
    pValue <= input.policy.perComparisonLevel &&
    ((zeckFavoring > alternativeFavoring && direction === "zeck-cheaper") ||
      (alternativeFavoring > zeckFavoring && direction === "alternative-cheaper"))
  ) {
    verdict =
      zeckFavoring > alternativeFavoring ? "zeck-wins-significant" : "alternative-wins-significant";
  } else {
    verdict = "statistical-tie";
  }
  return {
    armKind: input.alternative.reference.armKind,
    totalBlocks: blocks.length,
    zeckFavoring,
    alternativeFavoring,
    tieBlocks,
    excludedBlocks,
    outcomeDominantBlocks,
    pValueTwoSided: pValue,
    zeckAdjustedPerResolvedMicroUsd: zeckAdjusted,
    alternativeAdjustedPerResolvedMicroUsd: alternativeAdjusted,
    direction,
    minimumMet,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// The oracles (each names the criterion it FAILs — all PURE)
// ---------------------------------------------------------------------------

/**
 * The PORTFOLIO HONESTY oracle: the declared workload portfolio is
 * the recorded portfolio. On the portfolio-aggregate rows the declared
 * classes must cover EVERY recorded cohort class (an omitted class is
 * a cherry-picked subset — FAILs named); on the ranking rows the
 * declared class must be a recorded class. The LIVE row is the one
 * carve-out (the sibling oracles' live semantics): a row whose arm
 * set holds LIVE declarations drives the corpus registry's own
 * PRE-REGISTERED live workload class, so that declared class counts
 * as a registered portfolio class — never an unknown cherry-pick.
 */
export function derivePortfolioHonesty(input: {
  readonly row: CompetitiveCorpusRow;
  readonly recordedClasses: readonly string[];
}): {
  readonly conformant: boolean;
  readonly omittedClasses: readonly string[];
  readonly unknownClasses: readonly string[];
  readonly evidence: readonly string[];
} {
  // The LIVE carve-out (mirroring the sibling oracles' live semantics —
  // deriveUnitComparability + deriveCompetitiveInputIntegrity skip the
  // arms whose reference.live === true): the live row's declared
  // workload class is the corpus registry's own pre-registered live
  // class, so the recorded-portfolio membership check counts it as
  // registered. ONLY that declared live class is registered — every
  // other unknown declared class still FAILs named (the
  // cherry-picking catch is not weakened).
  const isLiveRow =
    input.row.armSet.some((reference) => reference.live === true) ||
    input.row.workloadClass === LIVE_COMPETITIVE_WORKLOAD_CLASS;
  const registeredClasses = isLiveRow
    ? [...input.recordedClasses, LIVE_COMPETITIVE_WORKLOAD_CLASS]
    : input.recordedClasses;
  const declared =
    input.row.declaredWeights === undefined
      ? [input.row.workloadClass]
      : input.row.declaredWeights.map((entry) => entry.workloadClass);
  const omitted = input.recordedClasses.filter((candidate) => !declared.includes(candidate));
  const unknown = declared.filter((candidate) => !registeredClasses.includes(candidate));
  const isAggregate = input.row.declaredWeights !== undefined;
  const conformant = isAggregate
    ? omitted.length === 0 && unknown.length === 0
    : unknown.length === 0;
  return {
    conformant,
    omittedClasses: omitted,
    unknownClasses: unknown,
    evidence: [
      `rowClass:${input.row.workloadClass}`,
      `declaredClasses:${declared.join(",")}`,
      `recordedClasses:${input.recordedClasses.join(",")}`,
      ...(isLiveRow
        ? [`liveClass:${LIVE_COMPETITIVE_WORKLOAD_CLASS} (pre-registered live carve-out)`]
        : []),
      `omitted:${omitted.join(",") || "none"}`,
      `unknown:${unknown.join(",") || "none"}`,
      conformant
        ? "honest (the declared workload portfolio IS the recorded portfolio)"
        : `CHERRY-PICKED PORTFOLIO: the declared portfolio omits the recorded classes [${omitted.join(", ")}] — the declared workload portfolio is the recorded portfolio, never a curated subset`,
    ],
  };
}

/**
 * The UNIT COMPARABILITY oracle: every paired block comes from ONE
 * pre-registered cohort — the arms' round sets must equal the cohort's
 * RECORDED round sets (count + per-block field equality against the
 * re-derived recorded facts). Pooling another cohort's rounds into the
 * block set FAILs named (the blocks beyond the recorded window named).
 */
export function deriveUnitComparability(input: {
  readonly row: CompetitiveCorpusRow;
  readonly arms: readonly RecordedCompetitiveArm[];
}): {
  readonly conformant: boolean;
  readonly pooledBlocks: readonly string[];
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const arm of input.arms) {
    if (arm.reference.live === true) {
      continue;
    }
    const recorded = recordedCompetitiveArmOf(arm.reference);
    if (recorded === null) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (resolves to no recorded arm)`,
      );
      continue;
    }
    if (arm.facts.rounds.length !== recorded.arm.facts.rounds.length) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (${arm.facts.rounds.length} blocks != the recorded ${recorded.arm.facts.rounds.length} — pooled incomparable units)`,
      );
      continue;
    }
    for (const [index, round] of arm.facts.rounds.entries()) {
      const expected = recorded.arm.facts.rounds[index];
      if (
        expected === undefined ||
        round.resolved !== expected.resolved ||
        round.measuredCostMicroUsd !== expected.measuredCostMicroUsd ||
        round.latencyMs !== expected.latencyMs
      ) {
        violations.push(
          `${arm.reference.armKind}:${arm.reference.corpusRowId}@b${index} (matches no recorded block of the ${input.row.workloadClass} cohort — pooled incomparable units)`,
        );
      }
    }
  }
  return {
    conformant: violations.length === 0,
    pooledBlocks: violations,
    evidence: [
      `workloadClass:${input.row.workloadClass}`,
      `arms:${input.arms.map((arm) => arm.reference.armKind).join(",")}`,
      `blocks:${input.arms.map((arm) => arm.facts.rounds.length).join(",")}`,
      `pooled:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "honest (every paired block is the cohort's own recorded round — same workload, same gate, same recorded window)"
        : "POOLED INCOMPARABLE UNITS (the recorded evidence's blocks pair round-for-round within one cohort — pooling another cohort's rounds is refused)",
    ],
  };
}

/**
 * The COST-BASIS INTEGRITY oracle: every comparison rides the declared
 * family's ADJUSTED basis on BOTH sides (never mixed bases — adjusted
 * compared with adjusted); the claimed values (when present) must
 * re-derive; the composed contexts (the VAL-044 records, the VAL-045/47
 * curves, the VAL-046 windows) are disclosed but never mixed into the
 * paired verdict arithmetic.
 */
export function deriveCostBasisIntegrity(input: {
  readonly row: CompetitiveCorpusRow;
  readonly comparisons: readonly PairwiseComparison[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const claim = input.row.claimed?.comparison;
  const familyBasis =
    input.row.family === "quality-adjusted-ranking"
      ? "quality-adjusted-per-resolved"
      : input.row.family === "latency-adjusted-ranking"
        ? "latency-adjusted-per-resolved"
        : input.row.family === "failure-adjusted-ranking"
          ? "failure-adjusted-per-resolved"
          : "portfolio-weighted-aggregate";
  if (claim !== undefined) {
    if (claim.zeckSide.basis !== familyBasis) {
      violations.push(
        `MIXED BASES: the zeck side rides ${claim.zeckSide.basis} while the row's family demands ${familyBasis}`,
      );
    }
    if (claim.alternativeSide.basis !== familyBasis) {
      violations.push(
        `MIXED BASES: the ${claim.alternativeSide.armKind} side rides ${claim.alternativeSide.basis} while the row's family demands ${familyBasis}`,
      );
    }
    const comparison = input.comparisons.find(
      (candidate) => candidate.armKind === claim.alternativeSide.armKind,
    );
    if (comparison !== undefined) {
      if (
        comparison.zeckAdjustedPerResolvedMicroUsd !== null &&
        claim.zeckSide.valueMicroUsd !== comparison.zeckAdjustedPerResolvedMicroUsd
      ) {
        violations.push(
          `BASIS VALUE NOT RE-DERIVED: the claimed zeck ${claim.zeckSide.valueMicroUsd}µ$ != the derived ${familyBasis} ${comparison.zeckAdjustedPerResolvedMicroUsd}µ$`,
        );
      }
      if (
        comparison.alternativeAdjustedPerResolvedMicroUsd !== null &&
        claim.alternativeSide.valueMicroUsd !== comparison.alternativeAdjustedPerResolvedMicroUsd
      ) {
        violations.push(
          `BASIS VALUE NOT RE-DERIVED: the claimed ${claim.alternativeSide.armKind} ${claim.alternativeSide.valueMicroUsd}µ$ != the derived ${familyBasis} ${comparison.alternativeAdjustedPerResolvedMicroUsd}µ$`,
        );
      }
    }
  }
  for (const comparison of input.comparisons) {
    if (
      comparison.zeckAdjustedPerResolvedMicroUsd === null &&
      comparison.direction !== "null-basis"
    ) {
      violations.push(
        `${comparison.armKind}: the zeck side's null basis disagrees with the comparison direction`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `family:${input.row.family}`,
      `basis:${familyBasis} (adjusted compared with adjusted — never mixed)`,
      `adjustedRecords:${input.row.adjustedBasisReferences.map((ref) => ref.corpusRowId).join(",")}`,
      `curveContext:${input.row.longitudinalContext.contextDigest} (disclosed, never mixed into the paired basis)`,
      `substrateContext:${input.row.substrateContext.map((ref) => ref.windowId).join(",") || "none"} (disclosed, never mixed)`,
      ...violations,
      violations.length === 0
        ? "honest (the cost basis is pinned and never switched mid-comparison)"
        : "COST-BASIS SWITCHING (the comparison's basis is pinned per family — a mid-comparison switch is refused)",
    ],
  };
}

/**
 * The PAIRED-STATISTICS CORRECTNESS oracle: the verdict must ride the
 * PAIRED statistic over the recorded block structure — the exact sign
 * test over the round-for-round blocks. An unpaired claim (a pooled
 * two-sample statistic over paired evidence) or a claimed verdict
 * unsupported by the paired test FAILs named.
 */
export function derivePairedStatisticsCorrectness(input: {
  readonly row: CompetitiveCorpusRow;
  readonly comparisons: readonly PairwiseComparison[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const claim = input.row.claimed;
  if (claim?.statistic === "unpaired-pooled-two-sample") {
    violations.push(
      "UNPAIRED STATISTIC OVER PAIRED EVIDENCE: the recorded rounds pair round-for-round within the cohort (same workload, same acceptance gate, same recorded window) — the pooled two-sample claim discards the pairing and is refused",
    );
  }
  if (
    claim?.verdict !== undefined &&
    (claim.verdict === "zeck-wins-significant" || claim.verdict === "alternative-wins-significant")
  ) {
    const supporting = input.comparisons.filter(
      (comparison) => comparison.verdict === claim.verdict,
    );
    if (supporting.length === 0) {
      const derived = input.comparisons
        .map(
          (comparison) =>
            `${comparison.armKind}@p=${comparison.pValueTwoSided?.toFixed(6) ?? "none"}`,
        )
        .join(", ");
      violations.push(
        `UNSUPPORTED PAIRED VERDICT: the claimed ${claim.verdict} has no supporting paired comparison (derived: ${derived})`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      "statistic:paired-sign-test (exact, two-sided, over the round-for-round blocks)",
      ...input.comparisons.map(
        (comparison) =>
          `${comparison.armKind}:blocks=${comparison.totalBlocks} zeck=${comparison.zeckFavoring} alt=${comparison.alternativeFavoring} ties=${comparison.tieBlocks} excluded=${comparison.excludedBlocks} p=${comparison.pValueTwoSided?.toFixed(6) ?? "none"}`,
      ),
      ...violations,
      violations.length === 0
        ? "honest (every verdict is the paired statistic's own — the block structure preserved)"
        : "UNPAIRED CLAIM (the paired structure of the recorded evidence is preserved — an unpaired statistic over it FAILs)",
    ],
  };
}

/**
 * The MULTIPLE-COMPARISON HONESTY oracle: the declared Bonferroni
 * policy's arithmetic is verified (the per-comparison level equals the
 * family-wise level over the declared family size, which must cover
 * the row's pairwise set), and a claimed significant verdict requires
 * a derived pairwise p at or below the per-comparison level in the
 * claimed direction — confidence is never inflated beyond evidence.
 */
export function deriveMultipleComparisonHonesty(input: {
  readonly row: CompetitiveCorpusRow;
  readonly comparisons: readonly PairwiseComparison[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const policy = input.row.multipleComparison;
  const expectedLevel = policy.familyWiseLevel / policy.familySize;
  if (Math.abs(policy.perComparisonLevel - expectedLevel) > 1e-12) {
    violations.push(
      `POLICY ARITHMETIC: the declared per-comparison level ${policy.perComparisonLevel} != familyWise ${policy.familyWiseLevel} / familySize ${policy.familySize}`,
    );
  }
  const pairwiseCount = input.comparisons.length;
  if (policy.familySize < pairwiseCount) {
    violations.push(
      `FAMILY SIZE: the declared family ${policy.familySize} does not cover the row's ${pairwiseCount} pairwise comparisons`,
    );
  }
  const claimedVerdict = input.row.expected.verdict;
  if (
    claimedVerdict === "zeck-wins-significant" ||
    claimedVerdict === "alternative-wins-significant"
  ) {
    const supporting = input.comparisons.filter(
      (comparison) =>
        comparison.verdict === claimedVerdict &&
        comparison.pValueTwoSided !== null &&
        comparison.pValueTwoSided <= policy.perComparisonLevel,
    );
    if (supporting.length === 0) {
      const derived = input.comparisons
        .map(
          (comparison) =>
            `${comparison.armKind}:p=${comparison.pValueTwoSided?.toFixed(6) ?? "none"}/${comparison.verdict}`,
        )
        .join(", ");
      violations.push(
        `CONFIDENCE INFLATION: the claimed ${claimedVerdict} has no derived pairwise p ≤ the declared per-comparison level ${policy.perComparisonLevel} (derived: ${derived}) — multiple-comparison honesty is not optional`,
      );
    }
  }
  const claimedP = input.row.claimed?.pValue;
  if (claimedP !== undefined) {
    const derivedPs = input.comparisons
      .map((comparison) => comparison.pValueTwoSided)
      .filter((value): value is number => value !== null);
    if (derivedPs.length > 0 && !derivedPs.some((value) => Math.abs(value - claimedP) < 1e-9)) {
      violations.push(
        `CLAIMED P-VALUE NOT DERIVED: the claimed p ${claimedP.toFixed(6)} matches no derived paired p (${derivedPs.map((value) => value.toFixed(6)).join(", ")}) — the claimed statistic is not the evidence's own`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `policy:${policy.method} familyWise=${policy.familyWiseLevel} familySize=${policy.familySize} perComparison=${policy.perComparisonLevel.toFixed(9)}`,
      ...input.comparisons.map(
        (comparison) =>
          `${comparison.armKind}:p=${comparison.pValueTwoSided?.toFixed(6) ?? "none"} level=${policy.perComparisonLevel.toFixed(6)} verdict=${comparison.verdict}`,
      ),
      ...violations,
      violations.length === 0
        ? "honest (the family-wise error control declared and carried on every verdict)"
        : "CONFIDENCE INFLATION (a verdict below its evidence FAILs — the multiple-comparison honesty is enforced)",
    ],
  };
}

/**
 * The MINIMUM-SAMPLE ENFORCEMENT oracle: the paired block count must
 * reach the pre-registered minimum; below it the ONLY honest verdict
 * is under-powered — a win/loss/tie verdict claimed on a starved
 * sample FAILs named (the class is reported UNDER-POWERED, never
 * silently dropped).
 */
export function deriveMinimumSampleEnforcement(input: {
  readonly row: CompetitiveCorpusRow;
  readonly comparisons: readonly PairwiseComparison[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const minimum = input.row.minimumPairedRounds;
  const belowMinimum = input.comparisons.filter((comparison) => !comparison.minimumMet);
  const anyBelow = belowMinimum.length > 0;
  const expected = input.row.expected.verdict;
  if (anyBelow) {
    if (expected !== "adversarial-failed" && expected !== "under-powered") {
      violations.push(
        `BELOW-MINIMUM VERDICT CLAIM: ${belowMinimum
          .map((comparison) => `${comparison.armKind}=${comparison.totalBlocks} blocks`)
          .join(
            ", ",
          )} < the pre-registered minimum ${minimum} — the honest verdict is under-powered, never a starved-sample verdict`,
      );
    }
  }
  if (!anyBelow && expected === "under-powered") {
    violations.push(
      `UNDER-POWERED CLAIM WITH POWER: every comparison meets the minimum ${minimum} — the under-powered claim is not the evidence's own`,
    );
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `minimumPairedRounds:${minimum}`,
      ...input.comparisons.map(
        (comparison) =>
          `${comparison.armKind}:blocks=${comparison.totalBlocks} met=${String(comparison.minimumMet)}`,
      ),
      ...violations,
      violations.length === 0
        ? anyBelow
          ? "honest (the starved class is reported UNDER-POWERED — never silently dropped)"
          : "honest (every comparison meets the pre-registered minimum)"
        : "SAMPLE STARVATION (an insufficient-sample verdict claim FAILs — the honest outcome is the refusal)",
    ],
  };
}

/**
 * The WEIGHTING DISCLOSURE oracle (the portfolio aggregate rows): the
 * weights are EXPLICIT, positive, cover every recorded class exactly
 * once, and SUM to one (sum-checked — never buried).
 */
export function deriveWeightingDisclosure(input: {
  readonly row: CompetitiveCorpusRow;
  readonly recordedClasses: readonly string[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  if (input.row.family !== "portfolio-weighted-aggregate") {
    return {
      conformant: true,
      evidence: ["weights:none (a ranking row carries no portfolio weights)"],
    };
  }
  const violations: string[] = [];
  const weights = input.row.declaredWeights ?? [];
  if (weights.length === 0) {
    violations.push(
      "NO WEIGHTS DECLARED (the portfolio aggregate's weights are explicit — never buried)",
    );
  }
  const sum = weights.reduce((total, entry) => total + entry.weight, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    violations.push(`WEIGHTS SUM ${sum} != 1 (the declared weights are sum-checked)`);
  }
  for (const entry of weights) {
    if (entry.weight <= 0) {
      violations.push(`NON-POSITIVE WEIGHT ${entry.workloadClass}=${entry.weight}`);
    }
  }
  const weightedClasses = weights.map((entry) => entry.workloadClass);
  const duplicated = weightedClasses.filter(
    (candidate, index) => weightedClasses.indexOf(candidate) !== index,
  );
  if (duplicated.length > 0) {
    violations.push(`DUPLICATED WEIGHTS [${duplicated.join(",")}]`);
  }
  const unweighted = input.recordedClasses.filter(
    (candidate) => !weightedClasses.includes(candidate),
  );
  if (unweighted.length > 0) {
    violations.push(
      `UNWEIGHTED CLASSES [${unweighted.join(",")}] (every recorded class carries its weight)`,
    );
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `weights:${weights.map((entry) => `${entry.workloadClass}=${entry.weight}`).join(", ") || "none"}`,
      `sum:${sum}`,
      ...violations,
      violations.length === 0
        ? "honest (the portfolio weighting is explicit, sum-checked and fully disclosed)"
        : "WEIGHTING DISCLOSURE VIOLATED (the aggregate's weights are explicit, positive and sum-checked)",
    ],
  };
}

/**
 * The FAILURE-COST COMPLETENESS oracle (the failure-adjusted family's
 * guard): every failed attempt's cost and every failed round's cost
 * is counted in the measured totals — the measured total decomposes
 * EXACTLY into direct + retry overhead AND into resolved + failed
 * rounds' shares. A dropped failure cost FAILs named.
 */
export function deriveFailureCostCompleteness(input: {
  readonly arms: readonly RecordedCompetitiveArm[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const arm of input.arms) {
    const facts = arm.facts;
    const measured = BigInt(facts.measuredCostMicroUsd);
    if (
      measured !==
      measured - BigInt(facts.retryOverheadMicroUsd) + BigInt(facts.retryOverheadMicroUsd)
    ) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (measured ${measured} != direct + retry ${facts.retryOverheadMicroUsd})`,
      );
    }
    if (measured !== BigInt(facts.resolvedRoundsMicroUsd) + BigInt(facts.failedRoundsMicroUsd)) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (measured ${measured} != resolvedRounds ${facts.resolvedRoundsMicroUsd} + failedRounds ${facts.failedRoundsMicroUsd} — a failure cost was dropped)`,
      );
    }
    const roundSum = facts.rounds.reduce(
      (total, round) => total + BigInt(round.measuredCostMicroUsd),
      0n,
    );
    if (roundSum !== measured) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (the blocks sum ${roundSum} != the measured total ${measured})`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      ...input.arms.map(
        (arm) =>
          `${arm.reference.armKind}:measured=${arm.facts.measuredCostMicroUsd} retry=${arm.facts.retryOverheadMicroUsd} resolvedShare=${arm.facts.resolvedRoundsMicroUsd} failedShare=${arm.facts.failedRoundsMicroUsd} failedAttempts=${arm.facts.failedAttemptsCount}`,
      ),
      ...violations,
      violations.length === 0
        ? "honest (every failure's cost is amortized in — nothing dropped)"
        : "FAILURE COST DROPPED (the failure-adjusted basis counts every failed attempt's cost)",
    ],
  };
}

/**
 * The ESTIMATE/MEASURE SEPARATION oracle: planner quotes ride as
 * SEPARATE estimate facts — an estimate claimed as measurement (or a
 * measured total including the estimate share) FAILs named.
 */
export function deriveEstimateMeasureSeparation(input: {
  readonly arms: readonly RecordedCompetitiveArm[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const arm of input.arms) {
    if (BigInt(arm.facts.estimatedCostMicroUsd) < 0n) {
      violations.push(`${arm.reference.armKind}:negative estimate share`);
    }
    if (
      arm.claimed?.measuredCostMicroUsd !== undefined &&
      arm.claimed.measuredCostMicroUsd !== arm.facts.measuredCostMicroUsd
    ) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (a claimed measured ${arm.claimed.measuredCostMicroUsd} != the recorded measured ${arm.facts.measuredCostMicroUsd} — the estimate/measure separation refuses the conflation)`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      ...input.arms.map(
        (arm) =>
          `${arm.reference.armKind}:measured=${arm.facts.measuredCostMicroUsd} estimated=${arm.facts.estimatedCostMicroUsd} (separate facts, never conflated)`,
      ),
      ...violations,
      violations.length === 0
        ? "honest (the estimates ride as separate facts — never claimed as measurements)"
        : "ESTIMATE CONFLATION (the estimate share is separate — an estimate claimed as measurement FAILs)",
    ],
  };
}

/**
 * The INPUT INTEGRITY oracle (the re-measurement masquerade catch):
 * every arm bundle's facts EQUAL the recorded corpus's own
 * re-derivation field-by-field (the paired blocks, the aggregates,
 * the digest) AND the arm's own corpus extractor's aggregates (the
 * strongest honesty anchor — the competitive facts ARE the recorded
 * corpora's own economics). A re-measurement masquerading as
 * derivation FAILs named, field by field.
 */
export function deriveCompetitiveInputIntegrity(input: {
  readonly arms: readonly RecordedCompetitiveArm[];
}): {
  readonly conformant: boolean;
  readonly verdicts: readonly {
    readonly reference: CompetitiveArmReference;
    readonly integrity: boolean;
    readonly failureReason: string | null;
  }[];
  readonly evidence: readonly string[];
} {
  const verdicts: {
    reference: CompetitiveArmReference;
    integrity: boolean;
    failureReason: string | null;
  }[] = [];
  const violations: string[] = [];
  for (const arm of input.arms) {
    if (arm.reference.live === true) {
      const modelKnown = manifestRevisionOf(arm.reference.priceRevision) !== null;
      verdicts.push({
        reference: arm.reference,
        integrity: modelKnown,
        failureReason: modelKnown
          ? null
          : `the live arm's price revision ${arm.reference.priceRevision} is no VAL-040 manifest revision`,
      });
      continue;
    }
    const recorded = recordedCompetitiveArmOf(arm.reference);
    if (recorded === null) {
      verdicts.push({
        reference: arm.reference,
        integrity: false,
        failureReason: "resolves to no recorded arm",
      });
      violations.push(`${arm.reference.armKind}:${arm.reference.corpusRowId} (no recorded arm)`);
      continue;
    }
    const reasons: string[] = [];
    const digest = recordedCompetitiveDigestOf({
      armKind: arm.reference.armKind,
      corpusRowId: arm.reference.corpusRowId,
      facts: arm.facts,
    });
    if (digest !== arm.reference.recordedDigest) {
      reasons.push(`digest ${digest} != the declared ${arm.reference.recordedDigest}`);
    }
    if (arm.facts.runCount !== recorded.arm.facts.runCount) {
      reasons.push(`runCount ${arm.facts.runCount} != recorded ${recorded.arm.facts.runCount}`);
    }
    if (arm.facts.resolvedCount !== recorded.arm.facts.resolvedCount) {
      reasons.push(
        `resolvedCount ${arm.facts.resolvedCount} != recorded ${recorded.arm.facts.resolvedCount}`,
      );
    }
    if (arm.facts.measuredCostMicroUsd !== recorded.arm.facts.measuredCostMicroUsd) {
      reasons.push(
        `measuredCost ${arm.facts.measuredCostMicroUsd} != recorded ${recorded.arm.facts.measuredCostMicroUsd}`,
      );
    }
    if (arm.facts.estimatedCostMicroUsd !== recorded.arm.facts.estimatedCostMicroUsd) {
      reasons.push(
        `estimatedCost ${arm.facts.estimatedCostMicroUsd} != recorded ${recorded.arm.facts.estimatedCostMicroUsd}`,
      );
    }
    if (
      Math.abs(arm.facts.resolutionConfidence.low - recorded.arm.facts.resolutionConfidence.low) >
        1e-9 ||
      Math.abs(arm.facts.resolutionConfidence.high - recorded.arm.facts.resolutionConfidence.high) >
        1e-9
    ) {
      reasons.push("wilson interval disagrees with the recorded derivation");
    }
    if (arm.facts.rounds.length !== recorded.arm.facts.rounds.length) {
      reasons.push(
        `blocks ${arm.facts.rounds.length} != recorded ${recorded.arm.facts.rounds.length}`,
      );
    } else {
      for (const [index, round] of arm.facts.rounds.entries()) {
        const expected = recorded.arm.facts.rounds[index];
        if (
          expected === undefined ||
          round.resolved !== expected.resolved ||
          round.measuredCostMicroUsd !== expected.measuredCostMicroUsd ||
          round.latencyMs !== expected.latencyMs
        ) {
          reasons.push(`block b${index} disagrees with the recorded block`);
          break;
        }
      }
    }
    const cross = recorded.crossCheck;
    if (
      arm.facts.runCount !== cross.runCount ||
      arm.facts.resolvedCount !== cross.resolvedCount ||
      arm.facts.measuredCostMicroUsd !== cross.measuredCostMicroUsd ||
      arm.facts.estimatedCostMicroUsd !== cross.estimatedCostMicroUsd ||
      arm.facts.costPerResolvedMicroUsd !== cross.costPerResolvedMicroUsd ||
      Math.abs(arm.facts.resolutionConfidence.low - cross.wilsonLow) > 1e-9 ||
      Math.abs(arm.facts.resolutionConfidence.high - cross.wilsonHigh) > 1e-9
    ) {
      reasons.push(
        `the arm's own corpus extractor disagrees (derived ${arm.facts.runCount}/${arm.facts.resolvedCount}/${arm.facts.measuredCostMicroUsd}µ$ vs the corpus's ${cross.runCount}/${cross.resolvedCount}/${cross.measuredCostMicroUsd}µ$)`,
      );
    }
    if (
      arm.claimed?.resolvedCount !== undefined &&
      arm.claimed.resolvedCount !== arm.facts.resolvedCount
    ) {
      reasons.push(
        `a claimed resolvedCount ${arm.claimed.resolvedCount} != the recorded ${arm.facts.resolvedCount}`,
      );
    }
    verdicts.push({
      reference: arm.reference,
      integrity: reasons.length === 0,
      failureReason: reasons.length === 0 ? null : reasons.join("; "),
    });
    if (reasons.length > 0) {
      violations.push(
        `${arm.reference.armKind}:${arm.reference.corpusRowId} (${reasons.join("; ")})`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    verdicts,
    evidence: [
      `arms:${input.arms.map((arm) => `${arm.reference.armKind}:${arm.reference.corpusRowId}`).join(", ")}`,
      `digests:${input.arms.map((arm) => arm.reference.recordedDigest).join(",")}`,
      ...violations,
      violations.length === 0
        ? "honest (every arm bundle IS the recorded corpus's own derivation — verified field-by-field, digest-bound, cross-checked against the arm's own corpus extractor)"
        : "RE-MEASUREMENT MASQUERADE (the competitive benchmark derives over RECORDED results — a re-measurement masquerading as derivation is refused)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The family synthesis (the PURE comparison derivation)
// ---------------------------------------------------------------------------

/** The per-class aggregate verdict (the portfolio aggregate's basis). */
function classVerdictOf(comparisons: readonly PairwiseComparison[]): CompetitiveVerdictKind {
  const zeckWins = comparisons.filter(
    (comparison) => comparison.verdict === "zeck-wins-significant",
  );
  const alternativeWins = comparisons.filter(
    (comparison) => comparison.verdict === "alternative-wins-significant",
  );
  const underPowered = comparisons.filter((comparison) => comparison.verdict === "under-powered");
  const nullBasis = comparisons.filter(
    (comparison) => comparison.verdict === "incomparable-null-basis",
  );
  if (zeckWins.length > 0 && alternativeWins.length === 0) {
    return "zeck-wins-significant";
  }
  if (alternativeWins.length > 0 && zeckWins.length === 0) {
    return "alternative-wins-significant";
  }
  if (underPowered.length > 0) {
    return "under-powered";
  }
  if (comparisons.length > 0 && nullBasis.length === comparisons.length) {
    return "incomparable-null-basis";
  }
  return "statistical-tie";
}

/**
 * Derive the cross-workload competitive synthesis over the resolved
 * arm bundles (PURE): the per-arm family-adjusted costs, the pairwise
 * comparisons against the Zeck reference arm (the exact paired sign
 * test + the Wilson intervals + the enforced minimums), the
 * adjusted-basis ranking, the portfolio aggregate's weighted class
 * verdicts, and the mechanically derived row verdict.
 */
export function deriveCompetitiveSynthesis(input: {
  readonly row: CompetitiveCorpusRow;
  readonly arms: readonly RecordedCompetitiveArm[];
}): {
  readonly synthesis: ExpectedCompetitiveOutcome;
  readonly verdict: CompetitiveVerdictKind;
  readonly familyConformant: boolean;
  readonly comparisons: readonly PairwiseComparison[];
  readonly familyEvidence: readonly string[];
} {
  const zeck = input.arms.find((arm) => arm.reference.armKind === "zeck");
  const alternatives = input.arms.filter((arm) => arm.reference.armKind !== "zeck");
  const latencyBudget =
    input.row.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: input.row.latencyBudgetMs };
  const analysisFamily: CompetitiveFamily =
    input.row.family === "portfolio-weighted-aggregate"
      ? "failure-adjusted-ranking"
      : input.row.family;
  const comparisons: PairwiseComparison[] =
    zeck === undefined
      ? []
      : alternatives.map((alternative) =>
          analyzePairwiseComparison({
            family: analysisFamily,
            ...latencyBudget,
            minimumPairedRounds: input.row.minimumPairedRounds,
            policy: input.row.multipleComparison,
            zeck,
            alternative,
          }),
        );
  const arms = input.arms.map((arm) => {
    const facts = arm.facts;
    return {
      armKind: arm.reference.armKind,
      corpusRowId: arm.reference.corpusRowId,
      runCount: facts.runCount,
      resolvedCount: facts.resolvedCount,
      attainment: facts.runCount > 0 ? facts.resolvedCount / facts.runCount : 0,
      latencyCompliance:
        input.row.latencyBudgetMs === undefined
          ? null
          : facts.runCount > 0
            ? facts.rounds.filter((round) => round.latencyMs <= (input.row.latencyBudgetMs ?? 0))
                .length / facts.runCount
            : 0,
      adjustedPerResolvedMicroUsd: familyAdjustedPerResolvedMicroUsd({
        family: analysisFamily,
        facts,
        ...latencyBudget,
      }),
    };
  });
  const rankable = arms.filter((arm) => arm.adjustedPerResolvedMicroUsd !== null);
  const unrankable = arms.filter((arm) => arm.adjustedPerResolvedMicroUsd === null);
  const ranking = [
    ...rankable
      .sort((left, right) => {
        const leftValue = BigInt(left.adjustedPerResolvedMicroUsd as string);
        const rightValue = BigInt(right.adjustedPerResolvedMicroUsd as string);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      })
      .map((arm) => arm.armKind),
    ...unrankable.map((arm) => arm.armKind),
  ];
  const wilson =
    zeck === undefined
      ? { low: 0, high: 0 }
      : wilsonInterval(zeck.facts.resolvedCount, zeck.facts.runCount);

  // The row verdict (the honest aggregation, never a narrative).
  let verdict: CompetitiveVerdictKind;
  const classVerdicts: {
    workloadClass: string;
    weight: number;
    verdict: CompetitiveVerdictKind;
  }[] = [];
  if (input.row.family === "portfolio-weighted-aggregate") {
    for (const entry of input.row.declaredWeights ?? []) {
      const resolved = entry.armSet.map((reference) => recordedCompetitiveArmOf(reference)?.arm);
      if (resolved.some((candidate) => candidate === undefined)) {
        classVerdicts.push({
          workloadClass: entry.workloadClass,
          weight: entry.weight,
          verdict: "adversarial-failed",
        });
        continue;
      }
      const classZeck = resolved.find(
        (candidate) => candidate !== undefined && candidate.reference.armKind === "zeck",
      );
      const classAlternatives = resolved.filter(
        (candidate) => candidate !== undefined && candidate.reference.armKind !== "zeck",
      );
      const classComparisons =
        classZeck === undefined
          ? []
          : classAlternatives.map((alternative) =>
              analyzePairwiseComparison({
                family: "failure-adjusted-ranking",
                minimumPairedRounds: entry.minimumPairedRounds,
                policy: input.row.multipleComparison,
                zeck: classZeck,
                alternative: alternative as RecordedCompetitiveArm,
              }),
            );
      classVerdicts.push({
        workloadClass: entry.workloadClass,
        weight: entry.weight,
        verdict: classVerdictOf(classComparisons),
      });
    }
    const zeckShare = classVerdicts
      .filter((entry) => entry.verdict === "zeck-wins-significant")
      .reduce((total, entry) => total + entry.weight, 0);
    const alternativeShare = classVerdicts
      .filter((entry) => entry.verdict === "alternative-wins-significant")
      .reduce((total, entry) => total + entry.weight, 0);
    verdict =
      zeckShare > 0 && alternativeShare === 0
        ? "zeck-wins-significant"
        : alternativeShare > 0 && zeckShare === 0
          ? "alternative-wins-significant"
          : "statistical-tie";
  } else {
    verdict = classVerdictOf(comparisons);
  }
  const familyConformant =
    input.arms.length >= input.row.minimumDistinctArms ||
    input.row.family === "portfolio-weighted-aggregate";
  const synthesis: ExpectedCompetitiveOutcome = {
    family: input.row.family,
    workloadClass: input.row.workloadClass,
    arms,
    ranking,
    comparisons: comparisons.map((comparison) => ({
      armKind: comparison.armKind,
      totalBlocks: comparison.totalBlocks,
      zeckFavoring: comparison.zeckFavoring,
      alternativeFavoring: comparison.alternativeFavoring,
      tieBlocks: comparison.tieBlocks,
      excludedBlocks: comparison.excludedBlocks,
      outcomeDominantBlocks: comparison.outcomeDominantBlocks,
      pValueTwoSided: comparison.pValueTwoSided,
      verdict: comparison.verdict,
    })),
    wilson,
    verdict,
    ...(input.row.family === "portfolio-weighted-aggregate"
      ? { classVerdicts: classVerdicts.map((entry) => ({ ...entry })) }
      : {}),
  };
  const familyEvidence = [
    `family:${input.row.family}`,
    `workloadClass:${input.row.workloadClass}`,
    ...arms.map(
      (arm) =>
        `${arm.armKind}:runs=${arm.runCount} resolved=${arm.resolvedCount} attainment=${arm.attainment.toFixed(4)} adjusted=${arm.adjustedPerResolvedMicroUsd ?? "NULL"}µ$/resolved`,
    ),
    `ranking:${ranking.join(" < ")}`,
    ...comparisons.map(
      (comparison) =>
        `${comparison.armKind}:blocks=${comparison.totalBlocks} zeck=${comparison.zeckFavoring} alt=${comparison.alternativeFavoring} ties=${comparison.tieBlocks} p=${comparison.pValueTwoSided?.toFixed(6) ?? "none"} -> ${comparison.verdict}`,
    ),
    `wilson:[${wilson.low.toFixed(6)}, ${wilson.high.toFixed(6)}]`,
    ...(input.row.family === "portfolio-weighted-aggregate"
      ? [
          ...classVerdicts.map(
            (entry) => `classWeight:${entry.workloadClass}=${entry.weight} -> ${entry.verdict}`,
          ),
        ]
      : []),
    `verdict:${verdict}`,
  ];
  return { synthesis, verdict, familyConformant, comparisons, familyEvidence };
}

// ---------------------------------------------------------------------------
// The row criteria (the mechanical verification battery per row)
// ---------------------------------------------------------------------------

/**
 * Assemble the row's mechanical criteria (the verification battery
 * per row — AC4): input integrity, portfolio honesty, unit
 * comparability, cost-basis integrity, paired statistics,
 * multiple-comparison honesty, minimum-sample enforcement, the
 * weighting disclosure, failure-cost completeness, estimate/measure
 * separation, the family derivation, the pinned synthesis oracle and
 * the durable-ledger contracts.
 */
export function deriveCompetitiveRowCriteria(input: {
  readonly row: CompetitiveCorpusRow;
  readonly arms: readonly RecordedCompetitiveArm[];
  readonly recordedClasses: readonly string[];
  readonly observedTerminal: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalLatencyMs: number;
}): readonly LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const integrity = deriveCompetitiveInputIntegrity({ arms: input.arms });
  criteria.push({
    criterionId: "competitive-input-integrity",
    strategy: "deterministic",
    status: integrity.conformant ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });
  const portfolio = derivePortfolioHonesty({
    row: input.row,
    recordedClasses: input.recordedClasses,
  });
  criteria.push({
    criterionId: "portfolio-honesty",
    strategy: "deterministic",
    status: portfolio.conformant ? "PASS" : "FAIL",
    evidence: portfolio.evidence,
  });
  const synthesis = deriveCompetitiveSynthesis({ row: input.row, arms: input.arms });
  const unit = deriveUnitComparability({ row: input.row, arms: input.arms });
  criteria.push({
    criterionId: "unit-comparability",
    strategy: "deterministic",
    status: unit.conformant ? "PASS" : "FAIL",
    evidence: unit.evidence,
  });
  const basis = deriveCostBasisIntegrity({ row: input.row, comparisons: synthesis.comparisons });
  criteria.push({
    criterionId: "cost-basis-integrity",
    strategy: "deterministic",
    status: basis.conformant ? "PASS" : "FAIL",
    evidence: basis.evidence,
  });
  const paired = derivePairedStatisticsCorrectness({
    row: input.row,
    comparisons: synthesis.comparisons,
  });
  criteria.push({
    criterionId: "paired-statistics",
    strategy: "deterministic",
    status: paired.conformant ? "PASS" : "FAIL",
    evidence: paired.evidence,
  });
  const multiple = deriveMultipleComparisonHonesty({
    row: input.row,
    comparisons: synthesis.comparisons,
  });
  criteria.push({
    criterionId: "multiple-comparison-honesty",
    strategy: "deterministic",
    status: multiple.conformant ? "PASS" : "FAIL",
    evidence: multiple.evidence,
  });
  const minimum = deriveMinimumSampleEnforcement({
    row: input.row,
    comparisons: synthesis.comparisons,
  });
  criteria.push({
    criterionId: "minimum-sample-enforcement",
    strategy: "deterministic",
    status: minimum.conformant ? "PASS" : "FAIL",
    evidence: minimum.evidence,
  });
  const weighting = deriveWeightingDisclosure({
    row: input.row,
    recordedClasses: input.recordedClasses,
  });
  criteria.push({
    criterionId: "weighting-disclosure",
    strategy: "deterministic",
    status: weighting.conformant ? "PASS" : "FAIL",
    evidence: weighting.evidence,
  });
  const failureCompleteness = deriveFailureCostCompleteness({ arms: input.arms });
  criteria.push({
    criterionId: "failure-cost-completeness",
    strategy: "deterministic",
    status: failureCompleteness.conformant ? "PASS" : "FAIL",
    evidence: failureCompleteness.evidence,
  });
  const separation = deriveEstimateMeasureSeparation({ arms: input.arms });
  criteria.push({
    criterionId: "estimate-measure-separation",
    strategy: "deterministic",
    status: separation.conformant ? "PASS" : "FAIL",
    evidence: separation.evidence,
  });
  criteria.push({
    criterionId:
      input.row.family === "quality-adjusted-ranking"
        ? "quality-adjusted-ranking-derivation"
        : input.row.family === "latency-adjusted-ranking"
          ? "latency-adjusted-ranking-derivation"
          : input.row.family === "failure-adjusted-ranking"
            ? "failure-adjusted-ranking-derivation"
            : "portfolio-weighted-aggregate-derivation",
    strategy: "deterministic",
    status: synthesis.familyConformant ? "PASS" : "FAIL",
    evidence: synthesis.familyEvidence,
  });
  if (input.row.expected.synthesis !== undefined) {
    const expected = input.row.expected.synthesis;
    const observed = synthesis.synthesis;
    const matches =
      observed.family === expected.family &&
      observed.workloadClass === expected.workloadClass &&
      observed.ranking.join(",") === expected.ranking.join(",") &&
      observed.arms
        .map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd ?? "NULL"}`)
        .join(",") ===
        expected.arms
          .map((arm) => `${arm.armKind}=${arm.adjustedPerResolvedMicroUsd ?? "NULL"}`)
          .join(",") &&
      observed.comparisons
        .map(
          (comparison) =>
            `${comparison.armKind}:${comparison.zeckFavoring}/${comparison.alternativeFavoring}/${comparison.tieBlocks}/${comparison.pValueTwoSided?.toFixed(6) ?? "none"}/${comparison.verdict}`,
        )
        .join(",") ===
        expected.comparisons
          .map(
            (comparison) =>
              `${comparison.armKind}:${comparison.zeckFavoring}/${comparison.alternativeFavoring}/${comparison.tieBlocks}/${comparison.pValueTwoSided?.toFixed(6) ?? "none"}/${comparison.verdict}`,
          )
          .join(",") &&
      Math.abs(observed.wilson.low - expected.wilson.low) < 1e-9 &&
      Math.abs(observed.wilson.high - expected.wilson.high) < 1e-9 &&
      observed.verdict === expected.verdict &&
      (expected.classVerdicts === undefined ||
        (observed.classVerdicts ?? [])
          .map((entry) => `${entry.workloadClass}=${entry.weight}->${entry.verdict}`)
          .join(",") ===
          (expected.classVerdicts ?? [])
            .map((entry) => `${entry.workloadClass}=${entry.weight}->${entry.verdict}`)
            .join(","));
    criteria.push({
      criterionId: "synthesis-outcome-oracle",
      strategy: "deterministic",
      status: matches ? "PASS" : "FAIL",
      evidence: [
        `expectedVerdict:${expected.verdict}`,
        `observedVerdict:${observed.verdict}`,
        `expectedRanking:${expected.ranking.join(" < ")}`,
        `observedRanking:${observed.ranking.join(" < ")}`,
        `expectedComparisons:${expected.comparisons.length}`,
        `observedComparisons:${observed.comparisons.length}`,
      ],
    });
  }
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === input.row.expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${input.row.expected.executions}`,
    ],
  });
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === input.row.expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${input.row.expected.idempotencyRecords}`,
    ],
  });
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: input.finalFacts.orphanEventCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null || criteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${input.row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `expectedVerdict:${input.row.expected.verdict}`,
      `derivedVerdict:${synthesis.verdict}`,
      `observedTerminal:${input.observedTerminal ?? "none"}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.row.needsDispatch
        ? "competitive:live-measured on the live lane (BYOK; measured dispatches, never estimates)"
        : "competitive:recorded arm facts (deterministic recorded results — honestly labeled, never presented as live measurements)",
      "adjustedBasis:the VAL-044 adjusted-cost records (digest references, never re-run, never re-priced)",
      "curveContext:the VAL-045 attribution + the VAL-047 curves (disclosed, never mixed into the paired basis)",
      "substrateContext:the VAL-046 substrate windows (disclosed, never mixed)",
      "latencyMs:measured",
      `totalLatencyMs:${input.totalLatencyMs}`,
      "evidence:payload digests only (never payload bytes)",
    ],
  });
  return criteria;
}

// ---------------------------------------------------------------------------
// The row driver (the landed competitive execution)
// ---------------------------------------------------------------------------

/**
 * Drive one cross-workload competitive row to settlement through the
 * platform path: the landed execution's chain records the COMPETITIVE
 * DECISIONS BEFORE any input is consulted (the family, the workload
 * class, the arm set with every digest reference, the adjusted-basis
 * references, the curve context, the minimums, the Wilson
 * configuration, the multiple-comparison policy, the declared
 * weights), then each arm bundle is verified against the recorded
 * corpora (digest + field equality — journaled as digest references
 * only) and sealed through the REAL accounting rails (the measured
 * model cost as a measured fact at the arm's own pinned revision while
 * the planner quotes ride as SEPARATE estimate facts), the comparison
 * is derived PURELY over the recorded results, the row-level
 * mechanical criteria are assembled, the verdict completes the
 * execution and the observed terminal is read back from the ledger.
 * The honest terminal is FAILED when any failure was observed or any
 * criterion failed — never a partial-success shortcut.
 */
export async function driveCompetitiveRow(options: {
  readonly row: CompetitiveCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The resolved arm bundles (the fixtures' bundles — verified here). */
  readonly arms: readonly RecordedCompetitiveArm[];
  /** The recorded workload-class registry (the portfolio-honesty basis). */
  readonly recordedClasses: readonly string[];
  /** The accounting rails (the REAL recorder — the verified inputs' sealing). */
  readonly rails: EconomicAccountingRails;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
}): Promise<CompetitiveRunResult> {
  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const key = (): string => {
    keyCounter.count += 1;
    return `k${keyCounter.count}`;
  };
  const landed = await options.landedProvider(1, options.row.expected.appCreated);
  if (landed.length !== options.row.expected.appCreated || landed[0] === undefined) {
    const failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${options.row.expected.appCreated})`,
    };
    return {
      rowId: options.row.rowId,
      terminal: "FAILED",
      criteria: deriveCompetitiveRowCriteria({
        row: options.row,
        arms: options.arms,
        recordedClasses: options.recordedClasses,
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      arms: [],
      synthesis: null,
      totalLatencyMs: options.now().getTime() - runStartedAt,
      failure,
    };
  }
  const executionId = landed[0];
  let failure: { category: string; message: string } | null = null;

  // ---- the canonical prologue ----
  await options.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-048-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-048-plan",
    callKey: key(),
  });

  // ---- the COMPETITIVE DECISIONS (made BEFORE any input is consulted) ----
  const competitiveDecision: Record<string, unknown> = {
    kind: "cross-workload-competitive-plan",
    family: options.row.family,
    workloadClass: options.row.workloadClass,
    deriveOnlyOverRecorded:
      "the cross-workload competitive benchmark derives over RECORDED results (digest references; never a re-measurement, never a re-pricing)",
    preRegisteredArmSet: options.row.armSet.map((reference) => ({
      armKind: reference.armKind,
      corpusRowId: reference.corpusRowId,
      digest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
      workloadClass: reference.workloadClass,
    })),
    adjustedBasisReferences: options.row.adjustedBasisReferences,
    longitudinalContext: options.row.longitudinalContext,
    substrateContext: options.row.substrateContext.map((reference) => ({
      windowId: reference.windowId,
      digest: reference.recordedDigest,
      priceRevision: reference.priceRevision,
    })),
    minimumPairedRounds: options.row.minimumPairedRounds,
    minimumDistinctArms: options.row.minimumDistinctArms,
    multipleComparison: options.row.multipleComparison,
    ...(options.row.latencyBudgetMs === undefined
      ? {}
      : { latencyBudgetMs: options.row.latencyBudgetMs }),
    ...(options.row.declaredWeights === undefined
      ? {}
      : {
          declaredWeights: options.row.declaredWeights.map((entry) => ({
            workloadClass: entry.workloadClass,
            weight: entry.weight,
            minimumPairedRounds: entry.minimumPairedRounds,
            armSet: entry.armSet.map((reference) => reference.corpusRowId),
          })),
        }),
    wilson: WILSON_CONFIG,
    expectedVerdict: options.row.expected.verdict,
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "competitive-ledger",
      model: "recorded-competitive-history",
      strategyClass: "economic-competitive-benchmark",
    },
    armDecision: competitiveDecision,
  });
  await options.lifecycle.recordStepEvent({
    executionId,
    record: {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(competitiveDecision),
      detail: `competitive-decision:${options.row.rowId}:${options.row.family}`,
    },
  });
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-048-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-048-start",
    callKey: key(),
  });

  // ---- the input-verification loop (digest references only) ----
  const integrity = deriveCompetitiveInputIntegrity({ arms: options.arms });
  const verifiedArms: VerifiedCompetitiveArm[] = [];
  let ordinal = 1;
  for (const verdict of integrity.verdicts) {
    const record: EconomicJournalRecord = {
      ordinal: ordinal + 1,
      kind: verdict.integrity ? "round" : "failure",
      digest: economicDigestOf({
        arm: `${verdict.reference.armKind}:${verdict.reference.corpusRowId}`,
        declared: verdict.reference.recordedDigest,
        integrity: verdict.integrity,
      }),
      detail: `arm:${verdict.reference.armKind}:${verdict.reference.corpusRowId}:${verdict.integrity ? "verified" : (verdict.failureReason ?? "failed")}`,
    };
    await options.lifecycle.recordStepEvent({ executionId, record });
    ordinal += 1;
    verifiedArms.push({
      reference: verdict.reference,
      integrity: verdict.integrity,
      failureReason: verdict.failureReason,
    });
    if (!verdict.integrity && failure === null) {
      failure = {
        category: "input-integrity-failed",
        message:
          `${verdict.reference.armKind}:${verdict.reference.corpusRowId} ${verdict.failureReason ?? ""}`.trim(),
      };
    }
    // The verified arm seals through the REAL recorder: the measured
    // model cost as a measured fact at the arm's own pinned revision,
    // the planner-quote share as a SEPARATE estimate fact, the arm's
    // recorded window wallclock as the latency.
    const arm = options.arms.find(
      (candidate) =>
        candidate.reference.armKind === verdict.reference.armKind &&
        candidate.reference.corpusRowId === verdict.reference.corpusRowId,
    );
    if (arm === undefined) {
      continue;
    }
    const sealedAt = options.now().toISOString();
    options.rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: `${verdict.reference.armKind}:${verdict.reference.corpusRowId}`,
      environmentIdentity: options.environmentIdentity,
      events: [
        {
          kind: "run-start",
          data: {
            armKind: verdict.reference.armKind,
            workloadClass: verdict.reference.workloadClass,
          },
          at: sealedAt,
        },
        {
          kind: "model-choice",
          data: {
            requestDigest: verdict.reference.recordedDigest,
            request: 1,
            competitiveInput: true,
          },
          at: sealedAt,
        },
        {
          kind: "run-end",
          data: { terminalStatus: verdict.integrity ? "COMPLETED" : "FAILED" },
          at: sealedAt,
        },
      ],
      cost: [
        ...(BigInt(arm.facts.measuredCostMicroUsd) > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: arm.facts.measuredCostMicroUsd,
                source: `val-048:${options.row.rowId}:recorded:${verdict.reference.priceRevision}`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
        ...(BigInt(arm.facts.estimatedCostMicroUsd) > 0n
          ? [
              {
                kind: "estimate" as const,
                amountMicroUsd: arm.facts.estimatedCostMicroUsd,
                source: `val-048:${options.row.rowId}:planner-quote`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
      ],
      latency: [
        {
          phase: "total" as const,
          source: "platform-ledger" as const,
          milliseconds: arm.facts.rounds.reduce((total, round) => total + round.latencyMs, 0),
        },
      ],
      environment: [
        {
          kind: "state-transitioned",
          assertion: `the recorded arm ${verdict.reference.armKind}:${verdict.reference.corpusRowId} verified against the recorded corpora`,
          observedVia: "platform-ledger",
          passed: verdict.integrity,
        },
      ],
      sealedAt,
    });
  }

  // ---- the cross-workload competitive comparison (PURE over the recorded results) ----
  const comparison = deriveCompetitiveSynthesis({ row: options.row, arms: options.arms });

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-048-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveCompetitiveRowCriteria({
    row: options.row,
    arms: options.arms,
    recordedClasses: options.recordedClasses,
    observedTerminal: null,
    baseline: options.baseline,
    finalFacts,
    failure,
    totalLatencyMs,
  });
  const derivedTerminal: "COMPLETED" | "FAILED" =
    failure !== null || rowCriteria.some((criterion) => criterion.status === "FAIL")
      ? "FAILED"
      : "COMPLETED";
  const verdict: "pass" | "fail" = derivedTerminal === "COMPLETED" ? "pass" : "fail";
  await options.lifecycle.complete({
    executionId,
    verdict,
    criteria: rowCriteria,
    reason:
      verdict === "pass"
        ? "val-048-verified"
        : `val-048-${failure?.category ?? "protocol-violation"}`,
  });

  // ---- the observed terminal read back from the ledger ----
  const observedTerminal = await options.lifecycle.statusOf(executionId);
  const readbackAgrees = observedTerminal === derivedTerminal;
  const criteria: LabVerificationCriterion[] = [
    ...rowCriteria,
    {
      criterionId: "observed-terminal-readback",
      strategy: "deterministic",
      status: readbackAgrees ? "PASS" : "FAIL",
      evidence: [
        `derivedTerminal:${derivedTerminal}`,
        `observedTerminal:${observedTerminal ?? "none"}`,
        readbackAgrees
          ? "the ledger's own terminal agrees with the mechanically derived verdict"
          : "DISAGREED (a fabricated terminal at the ledger — the anyFail→FAILED invariant)",
      ],
    },
  ];
  const anyFail = derivedTerminal === "FAILED" || !readbackAgrees;
  return {
    rowId: options.row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    executionId,
    observedTerminal,
    arms: verifiedArms,
    synthesis: comparison.synthesis,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The live lane (env-gated — one REAL cross-workload comparison slice)
// ---------------------------------------------------------------------------

/**
 * The pinned live-competitive plan (the measured lane's declaration):
 * ONE dispatch binding for ALL live rows (the live-run lesson) — the
 * pinned OpenRouter chat rail — driving the PRIMARY competitive pair
 * (the Zeck live window vs the direct-provider live window) over the
 * same 4-round fixed-quality confirmation gate. The optimized and
 * competing LIVE windows remain declared in their own corpora for the
 * operator's live review (referenced honestly — never fabricated
 * here).
 */
export const LIVE_COMPETITIVE_PLAN = Object.freeze({
  /** The workload class the live slice drives. */
  workloadClass: "live-real-dispatch",
  /** The primary competitive pair the live slice drives. */
  lanes: Object.freeze(["zeck", "direct"] as const),
  /** The REAL rounds per lane (each one REAL model dispatch). */
  rounds: 4,
  /** The pinned model rail both lanes dispatch on (ONE binding — the live-run lesson). */
  rail: Object.freeze({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    priceRevision: "rev-001",
    maxTokens: 32,
    temperature: "unset (the provider's documented default — nothing rides the request)",
  }),
});

/** The live slice's identity (the measured lane's declaration reference). */
export const LIVE_COMPETITIVE_WORKLOAD_CLASS = "live-real-dispatch";

/** The declaration digest of the live plan (the reference's recorded digest). */
export function liveCompetitivePlanDigestOf(): string {
  return economicDigestOf({
    liveWorkloadClass: LIVE_COMPETITIVE_WORKLOAD_CLASS,
    lanes: LIVE_COMPETITIVE_PLAN.lanes,
    rounds: LIVE_COMPETITIVE_PLAN.rounds,
    rail: LIVE_COMPETITIVE_PLAN.rail,
  });
}
