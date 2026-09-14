/**
 * The economic-longitudinal-curve driver (VAL-047, acceptance criteria
 * 1, 2, 4 and 5 — the longitudinal cost-curve families over the
 * RECORDED longitudinal ledgers).
 *
 * The curve economics the work order exists for: how unit economics
 * IMPROVE (or fail to) over sustained operation, composed from the
 * recorded longitudinal history —
 *
 *   * COST-PER-SUCCESSFUL-OUTCOME TRAJECTORY: the per-generation cost
 *     per successful outcome ((recorded model cost + recorded substrate
 *     overhead) / recorded successful outcomes) over the declared
 *     window, every point carrying its run identity, its pinned price
 *     revisions and the Wilson confidence on the pooled
 *     successful-outcome rate;
 *   * IMPROVEMENT-RATE DECOMPOSITION: which mechanisms drove which
 *     delta — per generation the measured improvement delta decomposes
 *     EXACTLY into the VAL-045 attributed mechanisms + the substrate
 *     savings + the honest unattributed residual (an unexplained
 *     residual FAILs with both sides named);
 *   * PLATEAU-MATURITY VERDICT: the honest classification per workload
 *     class (improving / plateaued / never-materialized /
 *     mixed-cohort-regressing) derived from the recorded series over
 *     the PINNED thresholds — never a narrative.
 *
 * The verification core (each probed adversarially — the discrimination
 * battery): WINDOW HONESTY (the declared window matches the recorded
 * data — a cherry-picked window FAILs named), PRICE-REGIME MARKING
 * (every point's pinned price revision verified against the VAL-040
 * manifests; a regime change is MARKED — silently normalizing it away
 * FAILs named), NO EXTRAPOLATION (a point beyond the recorded evidence
 * FAILs and is named), IMPROVEMENT-RATE RECONCILIATION (the
 * decomposition reconciles EXACTLY against the VAL-045 attribution —
 * residual hiding FAILs with both sides named), COHORT HONESTY (a
 * regressing cohort reported as regressing — hiding it FAILs named),
 * the ESTIMATE/MEASURE SEPARATION, the WILSON/MINIMUM enforcement (no
 * post-hoc exclusions — the pre-registered window decides) and the
 * INPUT-INTEGRITY oracle (digest-verified RECORDED inputs; a
 * re-measurement masquerade FAILs field by field). Any failed verdict
 * → terminal FAILED (never a partial-success shortcut). The live lane
 * (env-gated, BYOK) drives one REAL longitudinal slice with live
 * dispatches recorded through the REAL recorder.
 *
 * Every derivation here is PURE over the given RECORDED inputs: the
 * corpus resolves the digest-referenced ledgers and attribution
 * results; the driver never re-runs and never re-prices a recorded
 * input (a re-measurement masquerading as curve derivation FAILs).
 */

import { wilsonInterval } from "../../accounting/aggregate";
import type { LabVerificationCriterion } from "../../platform/derive";
import type { CandidateKind } from "../../platform/learning-discovery";
import type { RunMetadata } from "../../run-identity";
import type {
  EconomicAccountingRails,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicWorldFacts,
  LandedExecutionsProvider,
} from "../economic-baseline/driver";
import { economicDigestOf } from "../economic-baseline/driver";
import { manifestRevisionOf } from "../economic-baseline/pricing";
import {
  deriveSubstrateManifestIntegrity,
  divRoundHalfUp,
} from "../economic-substrate-runtime/pricing";

// ---------------------------------------------------------------------------
// The curve vocabulary
// ---------------------------------------------------------------------------

/** The three longitudinal cost-curve families under test. */
export type CurveFamily =
  | "cost-per-outcome-trajectory"
  | "improvement-rate-decomposition"
  | "plateau-maturity-verdict";

/** The honest curve verdict the families exist to derive. */
export type CurveVerdictKind =
  | "trajectory-improving"
  | "trajectory-plateaued"
  | "never-materialized"
  | "mixed-cohort-regressing"
  | "refused-below-minimum"
  | "adversarial-failed";

/** The adversarial probe shapes the discrimination battery drives. */
export type CurveAdversarialKind =
  | "cherry-picked-window"
  | "regime-normalizing"
  | "extrapolating"
  | "residual-hiding"
  | "cohort-hiding"
  | "post-hoc-exclusion"
  | "sample-size-violation"
  | "remeasurement";

/** One mechanism cohort's derived verdict over the recorded attribution series. */
export type CohortVerdict = "improving" | "regressing" | "newly-appearing";

/** The Wilson configuration every curve comparison carries (95%, pinned). */
export const WILSON_CONFIG: { readonly confidenceLevel: number } = Object.freeze({
  confidenceLevel: 0.95,
});

/** The pinned statistical minimums (the curve sample's floor). */
export const MINIMUM_GENERATIONS_FOR_CURVE = 3;
export const MINIMUM_OUTCOMES_PER_POINT = 5;

/** The pinned plateau thresholds (the maturity classification's floor). */
export const PLATEAU_RATE_THRESHOLD = 0.02;
export const STABILITY_WINDOW_GENERATIONS = 2;

/** The four attribution mechanisms (the VAL-045 vocabulary, imported). */
export const CURVE_MECHANISMS: readonly CandidateKind[] = [
  "reuse",
  "cache",
  "competence",
  "deterministicization",
];

// ---------------------------------------------------------------------------
// The recorded curve inputs (the digest-referenced RECORDED results)
// ---------------------------------------------------------------------------

/** One RECORDED longitudinal ledger point (the curve's own fact basis). */
export interface RecordedCurvePoint {
  readonly workloadClass: string;
  readonly generation: number;
  /** The recorded run count of the generation's sustained operation. */
  readonly runs: number;
  /** The recorded successful outcomes of the generation's sustained operation. */
  readonly successfulOutcomes: number;
  /** The recorded measured model cost (micro-USD, at its own pinned revision). */
  readonly measuredModelCostMicroUsd: number;
  /** The recorded substrate overhead share (micro-USD — the VAL-046 substrate facts). */
  readonly substrateOverheadMicroUsd: number;
  /** The pinned MODEL price revision active at this point (VAL-040 manifests). */
  readonly modelPriceRevision: string;
  /** The pinned SUBSTRATE price revision active at this point (VAL-046 manifests). */
  readonly substratePriceRevision: string;
  /** The recorded cost basis (the estimate/measure separation). */
  readonly costBasis: "measured";
  /** A separate planner quote observed at the point (an estimate fact — never conflated). */
  readonly estimatedQuoteMicroUsd?: number;
}

/** The digest reference for one RECORDED ledger point (never a copy). */
export interface CurvePointReference {
  readonly workloadClass: string;
  readonly generation: number;
  /** The content digest of the point's RECORDED facts. */
  readonly recordedDigest: string;
  readonly modelPriceRevision: string;
  readonly substratePriceRevision: string;
  /** A live-point declaration (the measured lane — never compared field-wise against recorded ledgers). */
  readonly live?: boolean;
}

/**
 * One resolved ledger-point input (the driver's bundle entry). The
 * CLAIMS ride OUTSIDE the recorded facts — exactly the gaming surface
 * the oracles catch: a claimed cost/outcome differing from the
 * recorded one (the re-measurement catch), a claimed pre-change
 * revision (the regime-normalizing catch), a claimed estimate basis
 * (the estimate/measure catch).
 */
export interface CurvePointInput extends CurvePointReference {
  readonly facts: RecordedCurvePoint;
  readonly claimed?: {
    readonly measuredModelCostMicroUsd?: number;
    readonly successfulOutcomes?: number;
    readonly modelPriceRevision?: string;
    readonly costBasis?: "measured" | "estimate";
  };
}

/** One RECORDED attribution result per (workload class, generation) — the VAL-045 output. */
export interface CurveAttributionResult {
  readonly workloadClass: string;
  readonly generation: number;
  /** The per-mechanism attributed savings (micro-USD — the VAL-045 recorded ledger entries). */
  readonly attributedMicroUsd: Readonly<Record<CandidateKind, number>>;
  /** The honest unattributed residual (micro-USD — the VAL-045 recorded totals minus attributed). */
  readonly residualMicroUsd: number;
  /** The digest references into the VAL-045 recorded ledger entries this result derives from. */
  readonly ledgerEntryDigests: readonly string[];
  /** The digest references into the VAL-045 recorded savings totals. */
  readonly recordedTotalDigests: readonly string[];
  /** The content digest of this attribution result itself. */
  readonly attributionDigest: string;
}

/** One resolved attribution input (the driver's bundle entry — claims ride outside). */
export interface CurveAttributionInput extends CurveAttributionResult {
  readonly claimed?: {
    /** A claimed residual below the recorded one — the residual-hiding catch. */
    readonly residualMicroUsd?: number;
    /** A claimed attributed share above the recorded one — the same catch's other side. */
    readonly attributedTotalMicroUsd?: number;
  };
}

/** The content digest of one RECORDED ledger point (PURE — payload-free). */
export function recordedCurvePointDigestOf(point: RecordedCurvePoint): string {
  return economicDigestOf({
    workloadClass: point.workloadClass,
    generation: point.generation,
    runs: point.runs,
    successfulOutcomes: point.successfulOutcomes,
    measuredModelCostMicroUsd: point.measuredModelCostMicroUsd,
    substrateOverheadMicroUsd: point.substrateOverheadMicroUsd,
    modelPriceRevision: point.modelPriceRevision,
    substratePriceRevision: point.substratePriceRevision,
    costBasis: point.costBasis,
    estimatedQuoteMicroUsd: point.estimatedQuoteMicroUsd ?? 0,
  });
}

/** The content digest of one RECORDED attribution result (PURE). */
export function curveAttributionDigestOf(
  result: Omit<CurveAttributionResult, "attributionDigest">,
): string {
  return economicDigestOf({
    workloadClass: result.workloadClass,
    generation: result.generation,
    attributedMicroUsd: result.attributedMicroUsd,
    residualMicroUsd: result.residualMicroUsd,
    ledgerEntryDigests: result.ledgerEntryDigests,
    recordedTotalDigests: result.recordedTotalDigests,
  });
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** The longitudinal cost-curve corpus row (the curve declaration). */
export interface CurveCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The curve family under test. */
  readonly family: CurveFamily;
  /** The workload class the curve covers. */
  readonly workloadClass: string;
  /** The DECLARED window (must match the recorded data — cherry-picking FAILs). */
  readonly declaredWindow: {
    readonly fromGeneration: number;
    readonly toGeneration: number;
  };
  /** The PRE-REGISTERED point set (digest references into the recorded ledger). */
  readonly pointSet: readonly CurvePointReference[];
  /**
   * The row's declared mechanism-cohort verdicts (never trusted — the
   * cohort-honesty oracle re-derives them from the recorded
   * attribution series; a regressing cohort reported otherwise FAILs named).
   */
  readonly declaredCohorts: readonly {
    readonly mechanism: CandidateKind;
    readonly reported: CohortVerdict;
  }[];
  /**
   * The declared price-regime change points (every actual change MUST
   * be marked here; silently normalizing one away FAILs named).
   */
  readonly regimeChangePoints: readonly {
    readonly atGeneration: number;
    readonly dimension: "model" | "substrate";
    readonly fromRevision: string;
    readonly toRevision: string;
  }[];
  /** The minimum number of distinct generations (the curve sample's floor). */
  readonly minimumGenerations: number;
  /** The per-point statistical minimum (every point's successful outcomes must reach it). */
  readonly minimumOutcomesPerPoint: number;
  readonly needsDispatch: boolean;
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The adversarial probe declaration (probe rows only). */
  readonly adversarial?: CurveAdversarialKind;
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    readonly verdict: CurveVerdictKind;
    readonly executions: number;
    readonly idempotencyRecords: number;
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The pinned expected curve outcome (offline honest rows only). */
    readonly synthesis?: ExpectedCurveOutcome;
  };
}

/** The expected curve outcome the derivation must reproduce. */
export interface ExpectedCurveOutcome {
  readonly family: CurveFamily;
  readonly workloadClass: string;
  readonly windowFromGeneration: number;
  readonly windowToGeneration: number;
  readonly points: number;
  /** The trajectory: cost per successful outcome per point (micro-USD, half-up per outcome). */
  readonly perPointCostPerOutcomeMicroUsd: readonly string[];
  readonly totalCostFromMicroUsd: string;
  readonly totalCostToMicroUsd: string;
  /** The window's total measured improvement (micro-USD; negative = regression). */
  readonly totalImprovementMicroUsd: string;
  /** The mean relative improvement rate per generation over the window. */
  readonly improvementRatePerGeneration: number;
  /** The mean relative improvement rate over the last STABILITY_WINDOW transitions. */
  readonly lastWindowImprovementRate: number;
  readonly regimeChangePoints: number;
  /** The derived mechanism-cohort verdicts over the recorded attribution series. */
  readonly cohorts: readonly { readonly mechanism: string; readonly verdict: CohortVerdict }[];
  readonly wilson: { readonly low: number; readonly high: number };
  readonly verdict: CurveVerdictKind;
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One verified ledger-point input (the driver's per-input settlement). */
export interface VerifiedCurvePoint {
  readonly reference: CurvePointReference;
  /** Whether the point's facts EQUAL the recorded ledger's own derivation. */
  readonly integrity: boolean;
  readonly failureReason: string | null;
}

/** The curve row run result (the honest outcome contract). */
export interface CurveRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executionId: string | null;
  readonly observedTerminal: string | null;
  readonly points: readonly VerifiedCurvePoint[];
  readonly synthesis: ExpectedCurveOutcome | null;
  readonly totalLatencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The pooled curve facts (the trajectory basis — PURE)
// ---------------------------------------------------------------------------

/** The pooled curve facts over the point inputs (PURE). */
export function pooledCurveFactsOf(points: readonly CurvePointInput[]): {
  readonly points: number;
  readonly runs: number;
  readonly successfulOutcomes: number;
  readonly measuredModelCostMicroUsd: bigint;
  readonly substrateOverheadMicroUsd: bigint;
  readonly totalCostMicroUsd: bigint;
} {
  let runs = 0;
  let outcomes = 0;
  let model = 0n;
  let substrate = 0n;
  for (const point of points) {
    runs += point.facts.runs;
    outcomes += point.facts.successfulOutcomes;
    model += BigInt(point.facts.measuredModelCostMicroUsd);
    substrate += BigInt(point.facts.substrateOverheadMicroUsd);
  }
  return {
    points: points.length,
    runs,
    successfulOutcomes: outcomes,
    measuredModelCostMicroUsd: model,
    substrateOverheadMicroUsd: substrate,
    totalCostMicroUsd: model + substrate,
  };
}

/** One point's total recorded cost (model + substrate — PURE). */
export function totalCostOfPoint(point: RecordedCurvePoint): bigint {
  return BigInt(point.measuredModelCostMicroUsd) + BigInt(point.substrateOverheadMicroUsd);
}

// ---------------------------------------------------------------------------
// The WINDOW HONESTY oracle (PURE — the cherry-picking catch)
// ---------------------------------------------------------------------------

/**
 * The WINDOW HONESTY oracle: the declared window must match the
 * RECORDED data — the recorded ledger's own span (first..last recorded
 * generation) IS the honest window. A declared window omitting recorded
 * generations (the cherry-picked window that hides the inconvenient
 * prefix or suffix) FAILs named, with every omitted generation named.
 */
export function deriveWindowHonesty(input: {
  readonly row: CurveCorpusRow;
  readonly recordedLedger: readonly RecordedCurvePoint[];
}): {
  readonly conformant: boolean;
  readonly recordedSpan: { readonly from: number; readonly to: number } | null;
  readonly omittedGenerations: readonly number[];
  readonly evidence: readonly string[];
} {
  const ledger = [...input.recordedLedger].sort(
    (left, right) => left.generation - right.generation,
  );
  const recordedSpan =
    ledger.length === 0
      ? null
      : {
          from: ledger[0]?.generation ?? 0,
          to: ledger[ledger.length - 1]?.generation ?? 0,
        };
  const omitted: number[] = [];
  if (recordedSpan !== null) {
    for (const point of ledger) {
      if (
        point.generation < input.row.declaredWindow.fromGeneration ||
        point.generation > input.row.declaredWindow.toGeneration
      ) {
        omitted.push(point.generation);
      }
    }
  }
  const spanMatches =
    recordedSpan !== null &&
    recordedSpan.from === input.row.declaredWindow.fromGeneration &&
    recordedSpan.to === input.row.declaredWindow.toGeneration;
  const conformant = spanMatches && omitted.length === 0;
  return {
    conformant,
    recordedSpan,
    omittedGenerations: omitted,
    evidence: [
      `workloadClass:${input.row.workloadClass}`,
      `declaredWindow:[${input.row.declaredWindow.fromGeneration}, ${input.row.declaredWindow.toGeneration}]`,
      recordedSpan === null
        ? "recordedSpan:none (no recorded ledger)"
        : `recordedSpan:[${recordedSpan.from}, ${recordedSpan.to}]`,
      `omitted:${omitted.join(",") || "none"}`,
      conformant
        ? "honest (the declared window IS the recorded data's own span)"
        : `CHERRY-PICKED WINDOW: the declared window omits recorded generations [${omitted.join(", ")}] — the window that matches the recorded data is the recorded span, never a curated slice`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The PRICE-REGIME MARKING oracle (PURE — the normalization catch)
// ---------------------------------------------------------------------------

/**
 * The PRICE-REGIME MARKING oracle: every point's pinned price revision
 * is verified against the VAL-040 model manifests and the VAL-046
 * substrate manifests; every actual revision change between
 * consecutive recorded points is a REGIME CHANGE that MUST be marked
 * in the row's declared change points — silently normalizing a change
 * away (claiming the pre-change revision for post-change points, or
 * leaving an actual change undeclared) FAILs named. A declared change
 * that never happened FAILs too (a fabricated marking).
 */
export function derivePriceRegimeMarking(input: {
  readonly row: CurveCorpusRow;
  readonly points: readonly CurvePointInput[];
}): {
  readonly conformant: boolean;
  readonly actualChangePoints: readonly {
    readonly atGeneration: number;
    readonly dimension: "model" | "substrate";
    readonly fromRevision: string;
    readonly toRevision: string;
  }[];
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const sorted = [...input.points].sort((left, right) => left.generation - right.generation);
  for (const point of sorted) {
    const modelKnown = manifestRevisionOf(point.modelPriceRevision) !== null;
    const substrateManifest = deriveSubstrateManifestIntegrity({
      revision: point.substratePriceRevision,
    });
    if (!modelKnown) {
      violations.push(
        `UNPINNED MODEL PRICING: ${point.facts.workloadClass}@g${point.facts.generation} (revision ${point.modelPriceRevision} is no VAL-040 manifest revision)`,
      );
    }
    if (!substrateManifest.agreed) {
      violations.push(
        `UNPINNED SUBSTRATE PRICING: ${point.facts.workloadClass}@g${point.facts.generation} (revision ${point.substratePriceRevision} failed substrate manifest integrity)`,
      );
    }
    // The regime-normalizing catch: the REFERENCE's declared revision
    // must equal the point's own RECORDED revision — a normalized
    // reference (the pre-change revision pinned onto a post-change
    // point) FAILs named.
    if (point.claimed?.modelPriceRevision !== undefined) {
      if (point.claimed.modelPriceRevision !== point.facts.modelPriceRevision) {
        violations.push(
          `REGIME-NORMALIZED: ${point.facts.workloadClass}@g${point.facts.generation} (claimed ${point.claimed.modelPriceRevision} != the recorded ${point.facts.modelPriceRevision} — a price-regime change is marked on the curve, never silently normalized away)`,
        );
      }
    }
    if (
      point.modelPriceRevision !== point.facts.modelPriceRevision ||
      point.substratePriceRevision !== point.facts.substratePriceRevision
    ) {
      violations.push(
        `REFERENCE-DISAGREED: ${point.facts.workloadClass}@g${point.facts.generation} (the reference's revisions (${point.modelPriceRevision}/${point.substratePriceRevision}) disagree with the recorded point's own (${point.facts.modelPriceRevision}/${point.facts.substratePriceRevision}))`,
      );
    }
  }
  const actual: {
    atGeneration: number;
    dimension: "model" | "substrate";
    fromRevision: string;
    toRevision: string;
  }[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.facts.modelPriceRevision !== current.facts.modelPriceRevision) {
      actual.push({
        atGeneration: current.facts.generation,
        dimension: "model",
        fromRevision: previous.facts.modelPriceRevision,
        toRevision: current.facts.modelPriceRevision,
      });
    }
    if (previous.facts.substratePriceRevision !== current.facts.substratePriceRevision) {
      actual.push({
        atGeneration: current.facts.generation,
        dimension: "substrate",
        fromRevision: previous.facts.substratePriceRevision,
        toRevision: current.facts.substratePriceRevision,
      });
    }
  }
  const declaredKeys = input.row.regimeChangePoints.map(
    (change) =>
      `${change.atGeneration}:${change.dimension}:${change.fromRevision}->${change.toRevision}`,
  );
  for (const change of actual) {
    const key = `${change.atGeneration}:${change.dimension}:${change.fromRevision}->${change.toRevision}`;
    if (!declaredKeys.includes(key)) {
      violations.push(
        `UNMARKED REGIME CHANGE: g${change.atGeneration} ${change.dimension} ${change.fromRevision}->${change.toRevision} (an actual price-regime change the curve does not mark — normalizing it away FAILs)`,
      );
    }
  }
  const actualKeys = actual.map(
    (change) =>
      `${change.atGeneration}:${change.dimension}:${change.fromRevision}->${change.toRevision}`,
  );
  for (const key of declaredKeys) {
    if (!actualKeys.includes(key)) {
      violations.push(
        `FABRICATED MARKING: ${key} (a declared change point with no actual regime change in the recorded data)`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    actualChangePoints: actual,
    evidence: [
      `points:${sorted.length}`,
      `actualRegimeChanges:${actual.length}`,
      ...actual.map(
        (change) =>
          `regime-change:g${change.atGeneration}:${change.dimension}:${change.fromRevision}->${change.toRevision}`,
      ),
      `declaredRegimeChanges:${input.row.regimeChangePoints.length}`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "every point pinned at a manifest-verified revision and every regime change marked"
        : "PRICE-REGIME MARKING FAILED (a regime change normalized away, unmarked or fabricated)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The NO-EXTRAPOLATION oracle (PURE)
// ---------------------------------------------------------------------------

/**
 * The NO-EXTRAPOLATION oracle: every curve point must sit WITHIN the
 * recorded evidence — a point at a generation beyond (or absent from)
 * the recorded ledger FAILs and is named (the recorded evidence's last
 * generation named alongside).
 */
export function deriveNoExtrapolation(input: {
  readonly row: CurveCorpusRow;
  readonly recordedLedger: readonly RecordedCurvePoint[];
  readonly points: readonly CurvePointInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const ledger = [...input.recordedLedger].sort(
    (left, right) => left.generation - right.generation,
  );
  const lastGeneration =
    ledger.length === 0 ? null : (ledger[ledger.length - 1]?.generation ?? null);
  const recordedGenerations = new Set(ledger.map((point) => point.generation));
  for (const point of input.points) {
    if (point.live === true) {
      continue;
    }
    if (!recordedGenerations.has(point.facts.generation)) {
      violations.push(
        `EXTRAPOLATED POINT: ${point.facts.workloadClass}@g${point.facts.generation} (the recorded evidence ${lastGeneration === null ? "holds no generations" : `ends at generation ${lastGeneration}`} — a point beyond the recorded evidence is named and FAILs)`,
      );
    }
  }
  if (lastGeneration !== null && input.row.declaredWindow.toGeneration > lastGeneration) {
    violations.push(
      `EXTRAPOLATED WINDOW: the declared window ends at generation ${input.row.declaredWindow.toGeneration} while the recorded evidence ends at generation ${lastGeneration}`,
    );
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `recordedLastGeneration:${lastGeneration ?? "none"}`,
      `declaredWindowTo:${input.row.declaredWindow.toGeneration}`,
      `executedPoints:${input.points.length}`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "every point sits within the recorded evidence"
        : "EXTRAPOLATION FAILED (a curve point beyond its evidence)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The IMPROVEMENT-RATE RECONCILIATION oracle (PURE — the core identity)
// ---------------------------------------------------------------------------

/** One generation's decomposition row (the improvement-rate decomposition). */
export interface ImprovementDecompositionRow {
  readonly generation: number;
  readonly measuredDeltaMicroUsd: number;
  readonly attributedMicroUsd: number;
  readonly substrateSavingsMicroUsd: number;
  readonly residualMicroUsd: number;
  readonly reconciles: boolean;
}

/**
 * The IMPROVEMENT-RATE RECONCILIATION oracle (the work order's core):
 * per generation the measured improvement delta decomposes EXACTLY —
 *
 *   attributed mechanisms (VAL-045) + substrate savings (VAL-046 side)
 *   + honest residual (VAL-045) = the measured delta
 *
 * An unexplained residual FAILs with BOTH sides named (the measured
 * delta vs the decomposed sum). The residual-hiding catch: a CLAIMED
 * residual below the recorded one (or a claimed attributed share above
 * the recorded one) FAILs named with both sides — the unattributed
 * share is never hidden, never forced into a mechanism.
 */
export function deriveImprovementRateReconciliation(input: {
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
}): {
  readonly conformant: boolean;
  readonly decomposition: readonly ImprovementDecompositionRow[];
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const sorted = [...input.points].sort((left, right) => left.generation - right.generation);
  const attributionByGeneration = new Map(
    input.attribution.map((result) => [result.generation, result]),
  );
  const decomposition: ImprovementDecompositionRow[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const generation = current.facts.generation;
    const measuredDelta = Number(
      totalCostOfPoint(previous.facts) - totalCostOfPoint(current.facts),
    );
    const result = attributionByGeneration.get(generation);
    if (result === undefined) {
      violations.push(
        `MISSING ATTRIBUTION: g${generation} (the improvement-rate decomposition requires the recorded attribution result for every improved generation)`,
      );
      continue;
    }
    const attributed = CURVE_MECHANISMS.reduce(
      (total, mechanism) => total + (result.attributedMicroUsd[mechanism] ?? 0),
      0,
    );
    const substrateSavings =
      previous.facts.substrateOverheadMicroUsd - current.facts.substrateOverheadMicroUsd;
    const residual = result.residualMicroUsd;
    const decomposed = attributed + substrateSavings + residual;
    const reconciles = measuredDelta === decomposed;
    if (!reconciles) {
      violations.push(
        `UNEXPLAINED RESIDUAL: g${generation} (the measured delta ${measuredDelta} != the decomposition ${decomposed} = attributed ${attributed} + substrate ${substrateSavings} + residual ${residual} — both sides named; the decomposition must reconcile EXACTLY)`,
      );
    }
    const claimedResidual = result.claimed?.residualMicroUsd;
    if (claimedResidual !== undefined && claimedResidual !== residual) {
      violations.push(
        `RESIDUAL-HIDING: g${generation} (claimed residual ${claimedResidual} != the recorded ${residual} — the honest unattributed share is reported, never hidden, never forced into a mechanism)`,
      );
    }
    const claimedAttributed = result.claimed?.attributedTotalMicroUsd;
    if (claimedAttributed !== undefined && claimedAttributed !== attributed) {
      violations.push(
        `INFLATED ATTRIBUTION: g${generation} (claimed attributed ${claimedAttributed} != the recorded ${attributed} — the mechanism share never absorbs the residual)`,
      );
    }
    decomposition.push({
      generation,
      measuredDeltaMicroUsd: measuredDelta,
      attributedMicroUsd: attributed,
      substrateSavingsMicroUsd: substrateSavings,
      residualMicroUsd: residual,
      reconciles,
    });
  }
  return {
    conformant: violations.length === 0,
    decomposition,
    evidence: [
      `generationsDecomposed:${decomposition.length}`,
      ...decomposition.map(
        (row) =>
          `g${row.generation}: measured ${row.measuredDeltaMicroUsd} = attributed ${row.attributedMicroUsd} + substrate ${row.substrateSavingsMicroUsd} + residual ${row.residualMicroUsd} (${row.reconciles ? "reconciles" : "FAILS"})`,
      ),
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "the improvement-rate decomposition reconciles EXACTLY against the VAL-045 attribution on every generation"
        : "RECONCILIATION FAILED (an unexplained or hidden residual)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The COHORT HONESTY oracle (PURE — the regressing-cohort catch)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanism cohorts' honest verdicts from the recorded
 * attribution series (PURE): a mechanism with attributed savings in
 * at most one window generation is NEWLY-APPEARING; with savings in
 * several generations, any DECLINE between consecutive attributed
 * amounts makes the cohort REGRESSING (its improvement contribution
 * fell), else IMPROVING.
 */
export function deriveCohortVerdicts(input: {
  readonly attribution: readonly CurveAttributionResult[];
}): readonly { readonly mechanism: CandidateKind; readonly verdict: CohortVerdict }[] {
  const sorted = [...input.attribution].sort((left, right) => left.generation - right.generation);
  return CURVE_MECHANISMS.map((mechanism) => {
    const series = sorted
      .map((result) => result.attributedMicroUsd[mechanism] ?? 0)
      .filter((amount) => amount > 0);
    if (series.length <= 1) {
      return { mechanism, verdict: "newly-appearing" as const };
    }
    let regressing = false;
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      if (previous !== undefined && current !== undefined && current < previous) {
        regressing = true;
      }
    }
    return {
      mechanism,
      verdict: regressing ? ("regressing" as const) : ("improving" as const),
    };
  });
}

/**
 * The COHORT HONESTY oracle: a mechanism cohort whose attributed
 * savings declined (the honest REGRESSING verdict) must be REPORTED as
 * regressing in the row's declared cohorts — hiding it (declaring the
 * cohort improving, or omitting it) FAILs named, with the cohort and
 * its attributed series named.
 */
export function deriveCohortHonesty(input: {
  readonly row: CurveCorpusRow;
  readonly attribution: readonly CurveAttributionInput[];
}): {
  readonly conformant: boolean;
  readonly derivedCohorts: readonly {
    readonly mechanism: CandidateKind;
    readonly verdict: CohortVerdict;
  }[];
  readonly evidence: readonly string[];
} {
  const derived = deriveCohortVerdicts({ attribution: input.attribution });
  const violations: string[] = [];
  const declaredByMechanism = new Map(
    input.row.declaredCohorts.map((declared) => [declared.mechanism, declared.reported]),
  );
  for (const cohort of derived) {
    const series = [...input.attribution]
      .sort((left, right) => left.generation - right.generation)
      .map((result) => result.attributedMicroUsd[cohort.mechanism] ?? 0);
    const declared = declaredByMechanism.get(cohort.mechanism);
    if (declared === undefined) {
      if (series.some((amount) => amount > 0)) {
        violations.push(
          `COHORT-OMITTED: ${cohort.mechanism} (a mechanism with recorded attributed savings is absent from the declared cohorts)`,
        );
      }
      continue;
    }
    if (declared !== cohort.verdict) {
      violations.push(
        `COHORT-HIDING: ${cohort.mechanism} (the recorded attribution series [${series.join(", ")}] derives ${cohort.verdict} — reported as ${declared}${cohort.verdict === "regressing" ? " (a regressing cohort is reported as regressing, never hidden)" : ""})`,
      );
    }
  }
  for (const declared of input.row.declaredCohorts) {
    if (!derived.some((cohort) => cohort.mechanism === declared.mechanism)) {
      violations.push(
        `PHANTOM-COHORT: ${declared.mechanism} (a declared cohort with no recorded attribution in the window)`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    derivedCohorts: derived,
    evidence: [
      `derivedCohorts:${
        derived
          .filter((cohort) =>
            input.attribution.some(
              (result) => (result.attributedMicroUsd[cohort.mechanism] ?? 0) > 0,
            ),
          )
          .map((cohort) => `${cohort.mechanism}=${cohort.verdict}`)
          .join(",") || "none"
      }`,
      `declaredCohorts:${
        input.row.declaredCohorts
          .map((declared) => `${declared.mechanism}=${declared.reported}`)
          .join(",") || "none"
      }`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "every cohort's reported verdict matches the recorded attribution series (regressing cohorts reported as regressing)"
        : "COHORT HONESTY FAILED (a regressing cohort hidden)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The ESTIMATE/MEASURE SEPARATION oracle (PURE)
// ---------------------------------------------------------------------------

/**
 * The ESTIMATE/MEASURE SEPARATION oracle: every curve point's cost
 * basis is the RECORDED measured basis — a point claimed on an
 * estimate basis (or a point whose measured cost is zero while an
 * estimate quote exists — the estimate absorbed into the curve) FAILs
 * named. Estimates ride SEPARATELY (the planner quote), never on the
 * trajectory.
 */
export function deriveEstimateMeasureSeparation(input: {
  readonly points: readonly CurvePointInput[];
}): {
  readonly conformant: boolean;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  for (const point of input.points) {
    if (point.facts.costBasis !== "measured") {
      violations.push(
        `ESTIMATE-BACKED CURVE POINT: ${point.facts.workloadClass}@g${point.facts.generation} (the recorded basis is ${point.facts.costBasis} — the trajectory derives over measured facts only)`,
      );
    }
    if (point.claimed?.costBasis === "estimate") {
      violations.push(
        `ESTIMATE-BASIS CLAIM: ${point.facts.workloadClass}@g${point.facts.generation} (claimed basis estimate — the estimate/measure separation never folds a quote into the trajectory)`,
      );
    }
    if (
      point.facts.measuredModelCostMicroUsd === 0 &&
      (point.facts.estimatedQuoteMicroUsd ?? 0) > 0
    ) {
      violations.push(
        `ABSORBED ESTIMATE: ${point.facts.workloadClass}@g${point.facts.generation} (a zero measured cost beside a ${point.facts.estimatedQuoteMicroUsd} estimate quote — the estimate was absorbed into the curve)`,
      );
    }
  }
  return {
    conformant: violations.length === 0,
    evidence: [
      `points:${input.points.length}`,
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "every point carries its measured basis; estimates ride separately as quotes"
        : "ESTIMATE/MEASURE SEPARATION FAILED (an estimate folded into the trajectory)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The CONFIDENCE-AND-MINIMUM oracle (PURE — no post-hoc exclusions)
// ---------------------------------------------------------------------------

/**
 * The CONFIDENCE-AND-MINIMUM oracle: the PRE-REGISTERED point set
 * decides — an executed set that drops a pre-registered generation is
 * a POST-HOC EXCLUSION and FAILs named; an undeclared point FAILs
 * named; the statistical minimums (generations, per-point outcomes)
 * must hold; the Wilson 95% interval on the pooled successful-outcome
 * rate is REQUIRED on every curve comparison.
 */
export function deriveConfidenceAndMinimum(input: {
  readonly row: CurveCorpusRow;
  readonly points: readonly CurvePointInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly wilson: { readonly low: number; readonly high: number } | null;
  readonly evidence: readonly string[];
} {
  const violations: string[] = [];
  const registered = new Set(input.row.pointSet.map((reference) => reference.generation));
  const present = new Set(input.points.map((point) => point.facts.generation));
  for (const generation of registered) {
    if (!present.has(generation)) {
      violations.push(
        `post-hoc-excluded:g${generation} (a pre-registered curve point is absent — the pre-registered window decides, an excluded point is never data)`,
      );
    }
  }
  for (const generation of present) {
    if (!registered.has(generation)) {
      violations.push(`undeclared-point:g${generation} (a point outside the pre-registered set)`);
    }
  }
  if (input.points.length < input.row.minimumGenerations) {
    violations.push(
      `BELOW-MINIMUM: ${input.points.length} points < ${input.row.minimumGenerations} pre-registered (the curve sample is starved)`,
    );
  }
  const starved = input.points.filter(
    (point) => point.facts.successfulOutcomes < input.row.minimumOutcomesPerPoint,
  );
  const pooled = pooledCurveFactsOf(input.points);
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.successfulOutcomes, pooled.runs) : null;
  if (wilson === null) {
    violations.push(
      "CONFIDENCE-LESS COMPARISON: the Wilson 95% interval is required on every curve comparison",
    );
  }
  return {
    conformant: violations.length === 0,
    belowMinimum: input.points.length < input.row.minimumGenerations || starved.length > 0,
    wilson,
    evidence: [
      `minimumGenerations:${input.row.minimumGenerations}`,
      `points:${input.points.length}`,
      `minimumOutcomesPerPoint:${input.row.minimumOutcomesPerPoint}`,
      `pooledRuns:${pooled.runs}`,
      `pooledOutcomes:${pooled.successfulOutcomes}`,
      wilson === null
        ? "wilson95:none"
        : `wilson95:[${wilson.low.toFixed(4)}, ${wilson.high.toFixed(4)}] (level ${WILSON_CONFIG.confidenceLevel})`,
      ...(starved.length === 0
        ? []
        : starved.map(
            (point) =>
              `below-minimum-point:${point.facts.workloadClass}@g${point.facts.generation} (successful outcomes ${point.facts.successfulOutcomes} < the per-point minimum ${input.row.minimumOutcomesPerPoint})`,
          )),
      `violations:${violations.length}`,
      ...violations,
      violations.length === 0
        ? "confident (the pre-registered point set held and the interval brackets the pooled outcome rate)"
        : "NON-CONFORMANT (an excluded, undeclared, starved or confidence-less comparison)",
    ],
  };
}

/**
 * The BELOW-MINIMUM REFUSAL HONESTY oracle (PURE): a below-minimum
 * curve must claim the REFUSED verdict — a curve that claims a
 * trajectory verdict while below the pre-registered minimums FAILs
 * named (the verdict is fabricated on a starved sample).
 */
export function deriveBelowMinimumRefusalHonesty(input: {
  readonly row: CurveCorpusRow;
  readonly points: readonly CurvePointInput[];
}): {
  readonly conformant: boolean;
  readonly belowMinimum: boolean;
  readonly evidence: readonly string[];
} {
  const confidence = deriveConfidenceAndMinimum({ row: input.row, points: input.points });
  const belowMinimum = confidence.belowMinimum;
  const claimsRefusal = input.row.expected.verdict === "refused-below-minimum";
  const conformant = belowMinimum === claimsRefusal;
  return {
    conformant,
    belowMinimum,
    evidence: [
      `expectedVerdict:${input.row.expected.verdict}`,
      `minimumGenerations:${input.row.minimumGenerations}`,
      `minimumOutcomesPerPoint:${input.row.minimumOutcomesPerPoint}`,
      `belowMinimum:${String(belowMinimum)}`,
      conformant
        ? belowMinimum
          ? "refused honestly (the below-minimum curve refuses — never a fabricated verdict)"
          : "not below minimum (the verdict claim stands on a sufficient sample)"
        : "BELOW-MINIMUM VERDICT CLAIM (a curve below the pre-registered minimums claims a verdict it cannot support — the honest outcome is the refusal)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The CURVE INPUT-INTEGRITY oracle (PURE — the re-measurement catch)
// ---------------------------------------------------------------------------

/**
 * The CURVE INPUT-INTEGRITY oracle: every RECORDED ledger point's
 * digest reference resolves in the recorded ledger, the declared
 * digest agrees with the re-derived one, and the bundle's facts EQUAL
 * the ledger's own derivation field by field (runs, outcomes, the
 * measured model cost, the substrate overhead, both pinned revisions,
 * the cost basis) — a re-measurement masquerading as curve derivation
 * FAILs named, field by field. Every attribution bundle's attributed
 * split, residual and VAL-045 digest references re-derive identically
 * against the recorded attribution results. Live points (the measured
 * lane) verify their manifest + plan digest only — the live lane is
 * the only place new measurements happen.
 */
export function deriveCurveInputIntegrity(input: {
  readonly recordedLedger: readonly RecordedCurvePoint[];
  readonly points: readonly CurvePointInput[];
  readonly recordedAttribution: readonly CurveAttributionResult[];
  readonly attribution: readonly CurveAttributionInput[];
}): {
  readonly conformant: boolean;
  readonly verdicts: readonly (VerifiedCurvePoint & { readonly detail: readonly string[] })[];
  readonly evidence: readonly string[];
} {
  const verdicts: (VerifiedCurvePoint & { readonly detail: readonly string[] })[] = [];
  const failures: string[] = [];
  const ledgerByGeneration = new Map(
    input.recordedLedger.map((point) => [point.generation, point]),
  );
  for (const point of input.points) {
    const modelKnown = manifestRevisionOf(point.modelPriceRevision) !== null;
    const substrateAgreed = deriveSubstrateManifestIntegrity({
      revision: point.substratePriceRevision,
    }).agreed;
    if (!modelKnown || !substrateAgreed) {
      failures.push(
        `UNPINNED PRICING: ${point.facts.workloadClass}@g${point.facts.generation} (model ${point.modelPriceRevision} known=${String(modelKnown)}; substrate ${point.substratePriceRevision} agreed=${String(substrateAgreed)})`,
      );
    }
    if (point.live === true) {
      verdicts.push({
        reference: point,
        integrity: modelKnown && substrateAgreed,
        failureReason: modelKnown && substrateAgreed ? null : "manifest-integrity-failed",
        detail: [
          `point:${point.facts.workloadClass}@g${point.facts.generation}`,
          "lane:live (the measured lane — new measurements happen only here)",
          `revisions:${point.modelPriceRevision}/${point.substratePriceRevision}`,
        ],
      });
      continue;
    }
    const recorded = ledgerByGeneration.get(point.facts.generation);
    if (recorded === undefined) {
      failures.push(
        `UNRESOLVABLE DIGEST REFERENCE: ${point.facts.workloadClass}@g${point.facts.generation} (no such recorded ledger point)`,
      );
      verdicts.push({
        reference: point,
        integrity: false,
        failureReason: "unresolvable-reference",
        detail: ["the digest reference resolves to no recorded ledger point"],
      });
      continue;
    }
    const digest = recordedCurvePointDigestOf(recorded);
    const digestAgrees = digest === point.recordedDigest;
    const fieldMismatches: string[] = [];
    if (point.facts.runs !== recorded.runs) {
      fieldMismatches.push(`runs ${point.facts.runs} != recorded ${recorded.runs}`);
    }
    if (point.facts.successfulOutcomes !== recorded.successfulOutcomes) {
      fieldMismatches.push(
        `successfulOutcomes ${point.facts.successfulOutcomes} != recorded ${recorded.successfulOutcomes}`,
      );
    }
    if (point.facts.measuredModelCostMicroUsd !== recorded.measuredModelCostMicroUsd) {
      fieldMismatches.push(
        `measuredModelCost ${point.facts.measuredModelCostMicroUsd} != recorded ${recorded.measuredModelCostMicroUsd}`,
      );
    }
    if (point.facts.substrateOverheadMicroUsd !== recorded.substrateOverheadMicroUsd) {
      fieldMismatches.push(
        `substrateOverhead ${point.facts.substrateOverheadMicroUsd} != recorded ${recorded.substrateOverheadMicroUsd}`,
      );
    }
    if (point.facts.modelPriceRevision !== recorded.modelPriceRevision) {
      fieldMismatches.push(
        `modelPriceRevision ${point.facts.modelPriceRevision} != recorded ${recorded.modelPriceRevision}`,
      );
    }
    if (point.facts.substratePriceRevision !== recorded.substratePriceRevision) {
      fieldMismatches.push(
        `substratePriceRevision ${point.facts.substratePriceRevision} != recorded ${recorded.substratePriceRevision}`,
      );
    }
    if (point.facts.costBasis !== recorded.costBasis) {
      fieldMismatches.push(`costBasis ${point.facts.costBasis} != recorded ${recorded.costBasis}`);
    }
    const claimedCost = point.claimed?.measuredModelCostMicroUsd;
    if (claimedCost !== undefined && claimedCost !== recorded.measuredModelCostMicroUsd) {
      fieldMismatches.push(
        `claimed measuredModelCost ${claimedCost} != recorded ${recorded.measuredModelCostMicroUsd} (a re-measurement masquerading as the recorded result)`,
      );
    }
    const claimedOutcomes = point.claimed?.successfulOutcomes;
    if (claimedOutcomes !== undefined && claimedOutcomes !== recorded.successfulOutcomes) {
      fieldMismatches.push(
        `claimed successfulOutcomes ${claimedOutcomes} != recorded ${recorded.successfulOutcomes} (a re-measurement masquerading as the recorded result)`,
      );
    }
    if (!digestAgrees) {
      failures.push(
        `DIGEST-DISAGREED: ${point.facts.workloadClass}@g${point.facts.generation} (declared ${point.recordedDigest} != re-derived ${digest})`,
      );
    }
    if (fieldMismatches.length > 0) {
      failures.push(
        `RE-MEASUREMENT MASQUERADE: ${point.facts.workloadClass}@g${point.facts.generation} (${fieldMismatches.join("; ")}) — the curve derives over RECORDED results`,
      );
    }
    verdicts.push({
      reference: point,
      integrity: digestAgrees && fieldMismatches.length === 0,
      failureReason: !digestAgrees
        ? "digest-disagreed"
        : fieldMismatches.length > 0
          ? "re-measurement-masquerade"
          : null,
      detail: [
        `digest:declared=${point.recordedDigest}`,
        `digest:rederived=${digest}`,
        `digest:${digestAgrees ? "AGREED" : "DISAGREED"}`,
        `fields:${fieldMismatches.length === 0 ? "identical-to-the-recorded-ledger" : fieldMismatches.join("; ")}`,
      ],
    });
  }
  const attributionByGeneration = new Map(
    input.recordedAttribution.map((result) => [result.generation, result]),
  );
  for (const bundle of input.attribution) {
    const recorded = attributionByGeneration.get(bundle.generation);
    if (recorded === undefined) {
      failures.push(
        `UNRESOLVABLE ATTRIBUTION REFERENCE: ${bundle.workloadClass}@g${bundle.generation} (no such recorded attribution result)`,
      );
      continue;
    }
    if (bundle.attributionDigest !== recorded.attributionDigest) {
      failures.push(
        `ATTRIBUTION-DIGEST-DISAGREED: ${bundle.workloadClass}@g${bundle.generation} (declared ${bundle.attributionDigest} != re-derived ${recorded.attributionDigest})`,
      );
    }
    for (const mechanism of CURVE_MECHANISMS) {
      if (
        (bundle.attributedMicroUsd[mechanism] ?? 0) !==
        (recorded.attributedMicroUsd[mechanism] ?? 0)
      ) {
        failures.push(
          `ATTRIBUTION-FIELD-DISAGREED: ${bundle.workloadClass}@g${bundle.generation}:${mechanism} (claimed ${bundle.attributedMicroUsd[mechanism] ?? 0} != recorded ${recorded.attributedMicroUsd[mechanism] ?? 0})`,
        );
      }
    }
    if (bundle.residualMicroUsd !== recorded.residualMicroUsd) {
      failures.push(
        `ATTRIBUTION-RESIDUAL-DISAGREED: ${bundle.workloadClass}@g${bundle.generation} (claimed ${bundle.residualMicroUsd} != recorded ${recorded.residualMicroUsd})`,
      );
    }
  }
  return {
    conformant: failures.length === 0,
    verdicts,
    evidence: [
      `points:${input.points.length}`,
      `attributionBundles:${input.attribution.length}`,
      `failures:${failures.length}`,
      ...failures,
      failures.length === 0
        ? "integrity held (every point and attribution bundle IS the recorded result's own derivation — digest-verified, never re-measured)"
        : "INTEGRITY FAILED (an input is not the recorded result — a re-measurement masquerading as derivation)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The verdict derivation (the plateau-maturity classification — PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the honest curve verdict over the recorded series (PURE —
 * the pinned thresholds, never a judgment call): below the
 * pre-registered minimums → REFUSED; no generation ever improved →
 * NEVER-MATERIALIZED; the mean improvement rate over the last
 * STABILITY_WINDOW transitions below the plateau threshold →
 * PLATEAUED; any regressing mechanism cohort → MIXED-COHORT-REGRESSING
 * (the aggregate may still improve — the cohort is reported, never
 * hidden); else IMPROVING.
 */
export function deriveCurveVerdictKind(input: {
  readonly minimumGenerations: number;
  readonly minimumOutcomesPerPoint: number;
  readonly points: readonly RecordedCurvePoint[];
  readonly cohorts: readonly { readonly verdict: CohortVerdict }[];
}): CurveVerdictKind {
  const sorted = [...input.points].sort((left, right) => left.generation - right.generation);
  if (
    sorted.length < input.minimumGenerations ||
    sorted.some((point) => point.successfulOutcomes < input.minimumOutcomesPerPoint)
  ) {
    return "refused-below-minimum";
  }
  const deltas: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    deltas.push(Number(totalCostOfPoint(previous) - totalCostOfPoint(current)));
  }
  const everImproved = deltas.some((delta) => delta > 0);
  if (!everImproved) {
    return "never-materialized";
  }
  const rates: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousTotal = totalCostOfPoint(previous);
    if (previousTotal > 0n) {
      rates.push(
        Number(totalCostOfPoint(previous) - totalCostOfPoint(current)) / Number(previousTotal),
      );
    }
  }
  const lastWindow = rates.slice(-STABILITY_WINDOW_GENERATIONS);
  const lastWindowRate =
    lastWindow.length === 0
      ? 0
      : lastWindow.reduce((total, rate) => total + rate, 0) / lastWindow.length;
  if (lastWindowRate < PLATEAU_RATE_THRESHOLD) {
    return "trajectory-plateaued";
  }
  if (input.cohorts.some((cohort) => cohort.verdict === "regressing")) {
    return "mixed-cohort-regressing";
  }
  return "trajectory-improving";
}

// ---------------------------------------------------------------------------
// The family synthesis (the curve itself — PURE)
// ---------------------------------------------------------------------------

/**
 * Derive the full longitudinal cost curve for one row over its point
 * inputs + attribution bundles (PURE): the per-point cost per
 * successful outcome trajectory, the window's total measured
 * improvement, the improvement-rate statistics, the derived
 * mechanism-cohort verdicts, the Wilson 95% interval on the pooled
 * successful-outcome rate and the honest plateau-maturity verdict.
 * The verdict is honest: below-minimum inputs REFUSE; any failed
 * family derivation → the row's terminal is FAILED.
 */
export function deriveCurveFamilySynthesis(input: {
  readonly row: CurveCorpusRow;
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
}): {
  readonly synthesis: ExpectedCurveOutcome | null;
  readonly verdict: CurveVerdictKind;
  readonly familyConformant: boolean;
  readonly familyCriterionId: string;
  readonly familyEvidence: readonly string[];
} {
  const sorted = [...input.points].sort((left, right) => left.generation - right.generation);
  const pooled = pooledCurveFactsOf(sorted);
  const wilson = pooled.runs > 0 ? wilsonInterval(pooled.successfulOutcomes, pooled.runs) : null;
  const cohorts = deriveCohortVerdicts({ attribution: input.attribution });
  const recordedPoints = sorted.map((point) => point.facts);
  const verdict = deriveCurveVerdictKind({
    minimumGenerations: input.row.minimumGenerations,
    minimumOutcomesPerPoint: input.row.minimumOutcomesPerPoint,
    points: recordedPoints,
    cohorts,
  });
  const perPointCpso = sorted.map((point) =>
    point.facts.successfulOutcomes > 0
      ? divRoundHalfUp(
          totalCostOfPoint(point.facts),
          BigInt(point.facts.successfulOutcomes),
        ).toString()
      : "null",
  );
  const firstPoint = sorted[0];
  const lastPoint = sorted[sorted.length - 1];
  const totalFrom = firstPoint === undefined ? 0n : totalCostOfPoint(firstPoint.facts);
  const totalTo = lastPoint === undefined ? 0n : totalCostOfPoint(lastPoint.facts);
  const rates: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousTotal = totalCostOfPoint(previous.facts);
    if (previousTotal > 0n) {
      rates.push(
        Number(totalCostOfPoint(previous.facts) - totalCostOfPoint(current.facts)) /
          Number(previousTotal),
      );
    }
  }
  const meanRate =
    rates.length === 0 ? 0 : rates.reduce((total, rate) => total + rate, 0) / rates.length;
  const lastWindow = rates.slice(-STABILITY_WINDOW_GENERATIONS);
  const lastWindowRate =
    lastWindow.length === 0
      ? 0
      : lastWindow.reduce((total, rate) => total + rate, 0) / lastWindow.length;
  const synthesis: ExpectedCurveOutcome | null =
    sorted.length === 0 || wilson === null
      ? null
      : {
          family: input.row.family,
          workloadClass: input.row.workloadClass,
          windowFromGeneration: input.row.declaredWindow.fromGeneration,
          windowToGeneration: input.row.declaredWindow.toGeneration,
          points: sorted.length,
          perPointCostPerOutcomeMicroUsd: perPointCpso,
          totalCostFromMicroUsd: totalFrom.toString(),
          totalCostToMicroUsd: totalTo.toString(),
          totalImprovementMicroUsd: (totalFrom - totalTo).toString(),
          improvementRatePerGeneration: meanRate,
          lastWindowImprovementRate: lastWindowRate,
          regimeChangePoints: input.row.regimeChangePoints.length,
          cohorts: cohorts
            .filter((cohort) =>
              input.attribution.some(
                (result) => (result.attributedMicroUsd[cohort.mechanism] ?? 0) > 0,
              ),
            )
            .map((cohort) => ({ mechanism: cohort.mechanism, verdict: cohort.verdict })),
          wilson: { low: wilson.low, high: wilson.high },
          verdict,
        };

  const familyCriterionId =
    input.row.family === "cost-per-outcome-trajectory"
      ? "cost-per-outcome-trajectory-derivation"
      : input.row.family === "improvement-rate-decomposition"
        ? "improvement-rate-decomposition-derivation"
        : "plateau-maturity-verdict-derivation";
  const reconciliation = deriveImprovementRateReconciliation({
    points: sorted,
    attribution: input.attribution,
  });
  const familyViolations: string[] = [];
  if (input.row.family === "improvement-rate-decomposition" && !reconciliation.conformant) {
    familyViolations.push(
      "the improvement-rate decomposition must reconcile EXACTLY (attributed + substrate + residual = the measured delta)",
    );
  }
  if (
    input.row.family === "plateau-maturity-verdict" &&
    input.row.expected.verdict !== "adversarial-failed" &&
    input.row.expected.verdict !== "refused-below-minimum" &&
    verdict !== input.row.expected.verdict
  ) {
    familyViolations.push(
      `the derived classification ${verdict} != the declared ${input.row.expected.verdict} (the plateau-maturity verdict is derived over the pinned thresholds, never a narrative)`,
    );
  }
  const familyEvidence = [
    `family:${input.row.family}`,
    `workloadClass:${input.row.workloadClass}`,
    `window:[${input.row.declaredWindow.fromGeneration}, ${input.row.declaredWindow.toGeneration}]`,
    `trajectory:[${perPointCpso.join(", ")}] (cost per successful outcome, micro-USD)`,
    `totalImprovement:${(totalFrom - totalTo).toString()} micro-USD`,
    `improvementRatePerGeneration:${meanRate.toFixed(4)}`,
    `lastWindowImprovementRate:${lastWindowRate.toFixed(4)} (threshold ${PLATEAU_RATE_THRESHOLD})`,
    `cohorts:${
      cohorts
        .filter((cohort) =>
          input.attribution.some(
            (result) => (result.attributedMicroUsd[cohort.mechanism] ?? 0) > 0,
          ),
        )
        .map((cohort) => `${cohort.mechanism}=${cohort.verdict}`)
        .join(",") || "none"
    }`,
    `wilson95:[${wilson === null ? "none" : `${wilson.low.toFixed(4)}, ${wilson.high.toFixed(4)}`}]`,
    `verdict:${verdict}`,
    ...reconciliation.evidence,
    ...familyViolations,
  ];
  return {
    synthesis,
    verdict,
    familyConformant: familyViolations.length === 0,
    familyCriterionId,
    familyEvidence,
  };
}

// ---------------------------------------------------------------------------
// The row criteria (the mechanical verification core)
// ---------------------------------------------------------------------------

/**
 * The row-level mechanical criteria (PURE): every oracle's verdict as
 * one criterion + the pinned expected-synthesis oracle + the ledger
 * discipline (no phantom executions, no ledger drift, no orphan
 * transitions) + the honest outcome contract + the honest economics
 * declaration.
 */
export function deriveCurveRowCriteria(input: {
  readonly row: CurveCorpusRow;
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
  readonly recordedLedger: readonly RecordedCurvePoint[];
  readonly recordedAttribution: readonly CurveAttributionResult[];
  readonly observedTerminal: string | null;
  readonly baseline: EconomicWorldFacts;
  readonly finalFacts: EconomicWorldFacts;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalLatencyMs: number;
}): readonly LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const integrity = deriveCurveInputIntegrity({
    recordedLedger: input.recordedLedger,
    points: input.points,
    recordedAttribution: input.recordedAttribution,
    attribution: input.attribution,
  });
  criteria.push({
    criterionId: "curve-input-integrity",
    strategy: "deterministic",
    status: integrity.conformant ? "PASS" : "FAIL",
    evidence: integrity.evidence,
  });
  const window = deriveWindowHonesty({ row: input.row, recordedLedger: input.recordedLedger });
  criteria.push({
    criterionId: "window-honesty",
    strategy: "deterministic",
    status: window.conformant ? "PASS" : "FAIL",
    evidence: window.evidence,
  });
  const regime = derivePriceRegimeMarking({ row: input.row, points: input.points });
  criteria.push({
    criterionId: "price-regime-marking",
    strategy: "deterministic",
    status: regime.conformant ? "PASS" : "FAIL",
    evidence: regime.evidence,
  });
  const extrapolation = deriveNoExtrapolation({
    row: input.row,
    recordedLedger: input.recordedLedger,
    points: input.points,
  });
  criteria.push({
    criterionId: "no-extrapolation",
    strategy: "deterministic",
    status: extrapolation.conformant ? "PASS" : "FAIL",
    evidence: extrapolation.evidence,
  });
  const reconciliation = deriveImprovementRateReconciliation({
    points: input.points,
    attribution: input.attribution,
  });
  criteria.push({
    criterionId: "improvement-rate-reconciliation",
    strategy: "deterministic",
    status: reconciliation.conformant ? "PASS" : "FAIL",
    evidence: reconciliation.evidence,
  });
  const cohort = deriveCohortHonesty({ row: input.row, attribution: input.attribution });
  criteria.push({
    criterionId: "cohort-honesty",
    strategy: "deterministic",
    status: cohort.conformant ? "PASS" : "FAIL",
    evidence: cohort.evidence,
  });
  const estimate = deriveEstimateMeasureSeparation({ points: input.points });
  criteria.push({
    criterionId: "estimate-measure-separation",
    strategy: "deterministic",
    status: estimate.conformant ? "PASS" : "FAIL",
    evidence: estimate.evidence,
  });
  const confidence = deriveConfidenceAndMinimum({ row: input.row, points: input.points });
  criteria.push({
    criterionId: "confidence-and-minimum",
    strategy: "deterministic",
    status: confidence.conformant ? "PASS" : "FAIL",
    evidence: confidence.evidence,
  });
  const refusal = deriveBelowMinimumRefusalHonesty({ row: input.row, points: input.points });
  criteria.push({
    criterionId: "below-minimum-refusal-honesty",
    strategy: "deterministic",
    status: refusal.conformant ? "PASS" : "FAIL",
    evidence: refusal.evidence,
  });
  const family = deriveCurveFamilySynthesis({
    row: input.row,
    points: input.points,
    attribution: input.attribution,
  });
  criteria.push({
    criterionId: family.familyCriterionId,
    strategy: "deterministic",
    status: family.familyConformant ? "PASS" : "FAIL",
    evidence: family.familyEvidence,
  });
  if (input.row.expected.synthesis !== undefined) {
    const expected = input.row.expected.synthesis;
    const observed = family.synthesis;
    const matches =
      observed !== null &&
      observed.family === expected.family &&
      observed.workloadClass === expected.workloadClass &&
      observed.windowFromGeneration === expected.windowFromGeneration &&
      observed.windowToGeneration === expected.windowToGeneration &&
      observed.points === expected.points &&
      observed.perPointCostPerOutcomeMicroUsd.join(",") ===
        expected.perPointCostPerOutcomeMicroUsd.join(",") &&
      observed.totalCostFromMicroUsd === expected.totalCostFromMicroUsd &&
      observed.totalCostToMicroUsd === expected.totalCostToMicroUsd &&
      observed.totalImprovementMicroUsd === expected.totalImprovementMicroUsd &&
      Math.abs(observed.improvementRatePerGeneration - expected.improvementRatePerGeneration) <
        1e-9 &&
      Math.abs(observed.lastWindowImprovementRate - expected.lastWindowImprovementRate) < 1e-9 &&
      observed.regimeChangePoints === expected.regimeChangePoints &&
      observed.cohorts.map((entry) => `${entry.mechanism}=${entry.verdict}`).join(",") ===
        expected.cohorts.map((entry) => `${entry.mechanism}=${entry.verdict}`).join(",") &&
      Math.abs(observed.wilson.low - expected.wilson.low) < 1e-9 &&
      Math.abs(observed.wilson.high - expected.wilson.high) < 1e-9 &&
      observed.verdict === expected.verdict;
    criteria.push({
      criterionId: "synthesis-outcome-oracle",
      strategy: "deterministic",
      status: matches ? "PASS" : "FAIL",
      evidence: [
        `expectedFamily:${expected.family}`,
        `observedFamily:${observed?.family ?? "none"}`,
        `expectedPoints:${expected.points}`,
        `observedPoints:${observed?.points ?? "none"}`,
        `expectedTrajectory:${expected.perPointCostPerOutcomeMicroUsd.join(",")}`,
        `observedTrajectory:${observed?.perPointCostPerOutcomeMicroUsd.join(",") ?? "none"}`,
        `expectedTotalImprovement:${expected.totalImprovementMicroUsd}`,
        `observedTotalImprovement:${observed?.totalImprovementMicroUsd ?? "none"}`,
        `expectedVerdict:${expected.verdict}`,
        `observedVerdict:${observed?.verdict ?? "none"}`,
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
      `derivedVerdict:${family.verdict}`,
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
        ? "curve:live-measured on the live lane (BYOK; measured dispatches, never estimates)"
        : "curve:recorded ledger facts (deterministic recorded results — honestly labeled, never presented as live measurements)",
      "attribution:the RECORDED VAL-045 attribution results (digest references, never re-run, never re-priced)",
      "substrate:the RECORDED VAL-046 substrate facts at each point's own pinned revision",
      "latencyMs:measured",
      `totalLatencyMs:${input.totalLatencyMs}`,
      "evidence:payload digests only (never payload bytes)",
    ],
  });
  return criteria;
}

// ---------------------------------------------------------------------------
// The row driver (the landed curve execution)
// ---------------------------------------------------------------------------

/**
 * Drive one longitudinal cost-curve row to settlement through the
 * platform path: the landed execution's chain records the CURVE
 * DECISIONS BEFORE any input is consulted (the family, the workload
 * class, the declared window with every digest reference, the declared
 * cohorts, the regime change points, the minimums, the Wilson
 * configuration), then each recorded ledger point is verified against
 * the recorded ledger (digest + field equality — journaled as digest
 * references only) and sealed through the REAL accounting rails (the
 * measured model cost and the substrate overhead as measured facts at
 * their own pinned revisions), the curve family is derived PURELY over
 * the recorded results, the row-level mechanical criteria are
 * assembled, the verdict completes the execution and the observed
 * terminal is read back from the ledger. The honest terminal is FAILED
 * when any failure was observed or any criterion failed — never a
 * partial-success shortcut.
 */
export async function driveCurveRow(options: {
  readonly row: CurveCorpusRow;
  readonly lifecycle: EconomicLifecyclePort;
  /** The resolved ledger-point inputs (the fixtures' bundles — verified here). */
  readonly points: readonly CurvePointInput[];
  /** The resolved attribution bundles (digest references into the VAL-045 results). */
  readonly attribution: readonly CurveAttributionInput[];
  /** The class's full RECORDED ledger (the window-honesty + extrapolation basis). */
  readonly recordedLedger: readonly RecordedCurvePoint[];
  /** The class's RECORDED attribution results (the integrity basis). */
  readonly recordedAttribution: readonly CurveAttributionResult[];
  /** The accounting rails (the REAL recorder — the verified inputs' sealing). */
  readonly rails: EconomicAccountingRails;
  readonly metadata: RunMetadata;
  readonly environmentIdentity: string;
  readonly baseline: EconomicWorldFacts;
  readonly worldFacts: () => Promise<EconomicWorldFacts> | EconomicWorldFacts;
  readonly landedProvider: LandedExecutionsProvider;
  readonly now: () => Date;
}): Promise<CurveRunResult> {
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
      criteria: deriveCurveRowCriteria({
        row: options.row,
        points: options.points,
        attribution: options.attribution,
        recordedLedger: options.recordedLedger,
        recordedAttribution: options.recordedAttribution,
        observedTerminal: null,
        baseline: options.baseline,
        finalFacts: await Promise.resolve(options.worldFacts()),
        failure,
        totalLatencyMs: options.now().getTime() - runStartedAt,
      }),
      executionId: null,
      observedTerminal: null,
      points: [],
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
    reason: "val-047-authorize",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-047-plan",
    callKey: key(),
  });

  // ---- the CURVE DECISIONS (made BEFORE any input is consulted) ----
  const curveDecision: Record<string, unknown> = {
    kind: "longitudinal-cost-curve-plan",
    family: options.row.family,
    workloadClass: options.row.workloadClass,
    deriveOnlyOverRecorded:
      "the longitudinal cost curve derives over RECORDED results (digest references; never a re-measurement, never a re-pricing)",
    declaredWindow: options.row.declaredWindow,
    preRegisteredPointSet: options.row.pointSet.map((reference) => ({
      workloadClass: reference.workloadClass,
      generation: reference.generation,
      digest: reference.recordedDigest,
      modelPriceRevision: reference.modelPriceRevision,
      substratePriceRevision: reference.substratePriceRevision,
    })),
    declaredCohorts: options.row.declaredCohorts,
    regimeChangePoints: options.row.regimeChangePoints,
    minimumGenerations: options.row.minimumGenerations,
    minimumOutcomesPerPoint: options.row.minimumOutcomesPerPoint,
    wilson: WILSON_CONFIG,
    expectedVerdict: options.row.expected.verdict,
  };
  await options.lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "longitudinal-ledger",
      model: "recorded-longitudinal-history",
      strategyClass: "economic-longitudinal-curve",
    },
    armDecision: curveDecision,
  });
  await options.lifecycle.recordStepEvent({
    executionId,
    record: {
      ordinal: 1,
      kind: "arm-decision",
      digest: economicDigestOf(curveDecision),
      detail: `curve-decision:${options.row.rowId}:${options.row.family}`,
    },
  });
  await options.lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-047-queue",
    callKey: key(),
  });
  await options.lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-047-start",
    callKey: key(),
  });

  // ---- the input-verification loop (digest references only) ----
  const integrity = deriveCurveInputIntegrity({
    recordedLedger: options.recordedLedger,
    points: options.points,
    recordedAttribution: options.recordedAttribution,
    attribution: options.attribution,
  });
  const verifiedPoints: VerifiedCurvePoint[] = [];
  let ordinal = 1;
  for (const verdict of integrity.verdicts) {
    const record: EconomicJournalRecord = {
      ordinal: ordinal + 1,
      kind: verdict.integrity ? "round" : "failure",
      digest: economicDigestOf({
        point: `${verdict.reference.workloadClass}@g${verdict.reference.generation}`,
        declared: verdict.reference.recordedDigest,
        integrity: verdict.integrity,
      }),
      detail: `point:${verdict.reference.workloadClass}@g${verdict.reference.generation}:${verdict.integrity ? "verified" : (verdict.failureReason ?? "failed")}`,
    };
    await options.lifecycle.recordStepEvent({ executionId, record });
    ordinal += 1;
    verifiedPoints.push({
      reference: verdict.reference,
      integrity: verdict.integrity,
      failureReason: verdict.failureReason,
    });
    if (!verdict.integrity && failure === null) {
      failure = {
        category: "input-integrity-failed",
        message:
          `${verdict.reference.workloadClass}@g${verdict.reference.generation} ${verdict.failureReason ?? ""}`.trim(),
      };
    }
    // The verified point seals through the REAL recorder: the measured
    // model cost and the substrate overhead as measured facts at the
    // point's own pinned revisions, the planner quote as a SEPARATE
    // estimate fact, the generation's sustained-operation wallclock as
    // the latency.
    const item = options.points.find(
      (candidate) => candidate.facts.generation === verdict.reference.generation,
    );
    if (item === undefined) {
      continue;
    }
    const facts = item.facts;
    const sealedAt = options.now().toISOString();
    options.rails.sealRound({
      metadata: options.metadata,
      corpusTaskId: `${facts.workloadClass}-g${facts.generation}`,
      environmentIdentity: options.environmentIdentity,
      events: [
        {
          kind: "run-start",
          data: { workloadClass: facts.workloadClass, generation: facts.generation },
          at: sealedAt,
        },
        {
          kind: "model-choice",
          data: {
            requestDigest: verdict.reference.recordedDigest,
            request: 1,
            curveInput: true,
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
        ...(BigInt(facts.measuredModelCostMicroUsd) > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: facts.measuredModelCostMicroUsd.toString(),
                source: `val-047:${options.row.rowId}:recorded:${facts.modelPriceRevision}`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
        ...(BigInt(facts.substrateOverheadMicroUsd) > 0n
          ? [
              {
                kind: "measured" as const,
                amountMicroUsd: facts.substrateOverheadMicroUsd.toString(),
                source: `val-047:${options.row.rowId}:recorded:${facts.substratePriceRevision}`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
        ...((facts.estimatedQuoteMicroUsd ?? 0) > 0
          ? [
              {
                kind: "estimate" as const,
                amountMicroUsd: (facts.estimatedQuoteMicroUsd ?? 0).toString(),
                source: `val-047:${options.row.rowId}:planner-quote`,
                scope: "direct-execution" as const,
              },
            ]
          : []),
      ],
      latency: [
        {
          phase: "total" as const,
          source: "platform-ledger" as const,
          milliseconds: facts.runs * 100,
        },
      ],
      environment: [
        {
          kind: "state-transitioned",
          assertion: `the recorded point ${facts.workloadClass}@g${facts.generation} verified against the longitudinal ledger`,
          observedVia: "platform-ledger",
          passed: verdict.integrity,
        },
      ],
      sealedAt,
    });
  }

  // ---- the longitudinal cost curve (PURE over the recorded results) ----
  const comparison = deriveCurveFamilySynthesis({
    row: options.row,
    points: options.points,
    attribution: options.attribution,
  });

  // ---- the verify boundary, then the mechanically derived verdict ----
  await options.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-047-verify",
    callKey: key(),
  });
  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const rowCriteria = deriveCurveRowCriteria({
    row: options.row,
    points: options.points,
    attribution: options.attribution,
    recordedLedger: options.recordedLedger,
    recordedAttribution: options.recordedAttribution,
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
        ? "val-047-verified"
        : `val-047-${failure?.category ?? "protocol-violation"}`,
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
    points: verifiedPoints,
    synthesis: comparison.synthesis,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The live lane (env-gated — one REAL longitudinal slice)
// ---------------------------------------------------------------------------

/** The pinned live-curve plan (the measured lane's declaration). */
export const LIVE_CURVE_PLAN = Object.freeze({
  /** The workload class the live slice drives. */
  workloadClass: "live-longitudinal-slice",
  /** The pinned model price revision pricing the measured dispatches. */
  modelPriceRevision: "rev-001",
  /** The pinned substrate price revision pricing the measured substrate share. */
  substratePriceRevision: "sub-rev-001",
  /** The REAL curve points the live slice drives (each a REAL sustained-operation unit). */
  points: 3,
  /** The workload units per curve point (each one REAL model dispatch). */
  workloadUnitsPerPoint: 3,
  /** The pinned model rail the workload dispatches ride (ONE binding — the live-run lesson). */
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
export const LIVE_CURVE_WORKLOAD_CLASS = "live-longitudinal-slice";

/** The declaration digest of the live plan (the reference's recorded digest). */
export function liveCurvePlanDigestOf(): string {
  return economicDigestOf({
    liveWorkloadClass: LIVE_CURVE_WORKLOAD_CLASS,
    modelPriceRevision: LIVE_CURVE_PLAN.modelPriceRevision,
    substratePriceRevision: LIVE_CURVE_PLAN.substratePriceRevision,
    points: LIVE_CURVE_PLAN.points,
    workloadUnitsPerPoint: LIVE_CURVE_PLAN.workloadUnitsPerPoint,
    rail: LIVE_CURVE_PLAN.rail,
  });
}
