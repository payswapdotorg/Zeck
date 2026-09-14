/**
 * The economic-longitudinal-curve corpus (VAL-047, AC1): the declared
 * rows of the LONGITUDINAL COST CURVE — the RECORDED longitudinal
 * ledgers (per workload class, per generation: the runs, the
 * successful outcomes, the measured model cost, the substrate
 * overhead share, the pinned price revisions) composed with the
 * RECORDED VAL-045 attribution results (the per-mechanism attributed
 * savings + the honest residual — digest references into the
 * savings-attribution family economics, never copies) into the three
 * curve families. Per row: the FAMILY under test
 * (cost-per-outcome-trajectory | improvement-rate-decomposition |
 * plateau-maturity-verdict), the workload class (+ its mechanism
 * cohort declarations where pinned), the DECLARED window (matching
 * the recorded data — cherry-picking FAILs), the pinned price
 * revisions (with the price-regime change points marked), the
 * statistical minimums + the Wilson configuration, and the EXPECTED
 * VERDICT (improving / plateaued / never-materialized /
 * mixed-cohort-regressing — honest classification, never a narrative).
 *
 * The offline rows are deterministically reproducible (the RECORDED
 * ledgers + the pinned manifests — zero credentials, zero network,
 * zero re-measurement): four honest rows (an IMPROVING class with a
 * MARKED model price-regime change at generation 2; a PLATEAUED class
 * whose savings honestly stopped after generation 3; a
 * NEVER-MATERIALIZED class whose savings never recorded; a
 * MIXED-COHORT class whose deterministicization cohort HONESTLY
 * regressed at generation 2 — reported as regressing, never hidden)
 * PLUS the eight adversarial PROBE rows whose denatured shapes (the
 * cherry-picked window, the regime-normalizing reference, the
 * extrapolated point, the residual-hiding claim, the cohort-hiding
 * declaration, the post-hoc window exclusion, the sample-size
 * violation's below-minimum verdict claim, the re-measurement
 * masquerade) each FAIL their named criterion honestly. The live row
 * is env-gated on the operator-authorized OpenRouter rail and demands
 * one REAL longitudinal slice with live dispatches.
 *
 * Rows never embed prices and never copy recorded results: every
 * point and attribution bundle is a DIGEST REFERENCE resolved against
 * the imported recorded corpora at verification time; the expected
 * curve outcome is derived at module load through the same PURE
 * derivations the driver runs. The ledgers are CONSTRUCTED to
 * reconcile EXACTLY with the VAL-045 attribution (the measured model
 * cost of each generation declines by exactly the attributed +
 * residual savings the VAL-045 family economics recorded) — the
 * identity the improvement-rate reconciliation oracle enforces.
 */

import type { CandidateKind } from "../../platform/learning-discovery";
import {
  attributionEntryDigestOf,
  recordedSavingsTotalDigestOf,
} from "../../platform/savings-attribution";
import { FAMILY_ECONOMICS, familyEconomicsById } from "../savings-attribution/corpus";
import type {
  CurveAdversarialKind,
  CurveAttributionInput,
  CurveAttributionResult,
  CurveCorpusRow,
  CurveFamily,
  CurvePointInput,
  CurvePointReference,
  CurveVerdictKind,
  RecordedCurvePoint,
} from "./driver";
import {
  curveAttributionDigestOf,
  deriveCohortVerdicts,
  deriveCurveFamilySynthesis,
  LIVE_CURVE_PLAN,
  liveCurvePlanDigestOf,
  MINIMUM_GENERATIONS_FOR_CURVE,
  MINIMUM_OUTCOMES_PER_POINT,
  recordedCurvePointDigestOf,
} from "./driver";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const CURVE_TASK_KIND = "economic-longitudinal-curve.experiment.v1";

/** The corpus version the curve carries. */
export const CURVE_CORPUS_VERSION = "val-047-longitudinal-curve-v1";

// ---------------------------------------------------------------------------
// The RECORDED attribution results (digest references into VAL-045)
// ---------------------------------------------------------------------------

/**
 * One RECORDED attribution result per (workload class, generation)
 * (PURE): the per-mechanism attributed savings and the honest residual
 * DERIVED from the imported VAL-045 family economics — the ledger
 * entries of that generation attributed per mechanism, the recorded
 * savings totals of that generation minus the attributed sum as the
 * residual, the VAL-045 entry + total digests carried as the
 * digest references. A generation with no recorded entries and no
 * recorded totals carries the honest EMPTY result (nothing attributed,
 * nothing residual — never fabricated).
 */
export function curveAttributionResultOf(
  workloadClass: string,
  generation: number,
): CurveAttributionResult {
  const economics = familyEconomicsById(workloadClass);
  if (economics === null) {
    throw new Error(`the recorded attribution economics declare no family ${workloadClass}`);
  }
  const entries = economics.ledgerEntries.filter((entry) => entry.generation === generation);
  const totals = economics.recordedTotals.filter((record) => record.generation === generation);
  const attributed: Record<CandidateKind, number> = {
    reuse: 0,
    cache: 0,
    competence: 0,
    deterministicization: 0,
  };
  for (const entry of entries) {
    attributed[entry.mechanism] += entry.microUsd;
  }
  const attributedSum =
    attributed.reuse + attributed.cache + attributed.competence + attributed.deterministicization;
  const totalMicroUsd = totals.reduce((total, record) => total + record.totalMicroUsd, 0);
  const preliminary: CurveAttributionResult = {
    workloadClass,
    generation,
    attributedMicroUsd: attributed,
    residualMicroUsd: totalMicroUsd - attributedSum,
    ledgerEntryDigests: entries.map((entry) => attributionEntryDigestOf(entry)),
    recordedTotalDigests: totals.map((record) => recordedSavingsTotalDigestOf(record)),
    attributionDigest: "",
  };
  return { ...preliminary, attributionDigest: curveAttributionDigestOf(preliminary) };
}

/**
 * The RECORDED attribution results for one class over a generation
 * range (PURE — the honest bundle resolution; every generation in the
 * range carries its result, the empty one where nothing recorded).
 */
export function curveAttributionResultsOf(
  workloadClass: string,
  fromGeneration: number,
  toGeneration: number,
): readonly CurveAttributionResult[] {
  const results: CurveAttributionResult[] = [];
  for (let generation = fromGeneration; generation <= toGeneration; generation += 1) {
    results.push(curveAttributionResultOf(workloadClass, generation));
  }
  return results;
}

// ---------------------------------------------------------------------------
// The RECORDED longitudinal ledgers (the curve's own fact basis)
// ---------------------------------------------------------------------------

/** One workload class's pinned RECORDED longitudinal ledger. */
export interface CurveLedgerPin {
  readonly workloadClass: string;
  readonly description: string;
  readonly points: readonly RecordedCurvePoint[];
}

/**
 * Build one class's RECORDED longitudinal ledger from its pinned shape
 * (PURE): the baseline generation's facts plus one generation per
 * attribution entry — each generation's measured model cost DECLINES by
 * exactly the attributed + residual savings the VAL-045 family
 * economics recorded for that generation (the reconciliation identity
 * holds by construction), the substrate overhead follows the recorded
 * substrate series, and every point pins its own model + substrate
 * price revisions (a mid-series revision change is a MARKED regime
 * change).
 */
function curveLedgerOf(input: {
  readonly workloadClass: string;
  readonly description: string;
  /** The baseline (generation-0) recorded facts. */
  readonly baseline: {
    readonly runs: number;
    readonly successfulOutcomes: number;
    readonly measuredModelCostMicroUsd: number;
    readonly substrateOverheadMicroUsd: number;
    readonly modelPriceRevision: string;
    readonly substratePriceRevision: string;
    readonly estimatedQuoteMicroUsd?: number;
  };
  /** Per generation 1..n: [runs, successfulOutcomes]. */
  readonly runsOutcomes: readonly (readonly [number, number])[];
  /** Per generation 1..n: the recorded substrate overhead (micro-USD). */
  readonly substrateOverheads: readonly number[];
  /** Per generation 1..n: the pinned MODEL price revision (default the baseline's). */
  readonly modelPriceRevisions?: readonly string[];
  /** Per generation 1..n: the pinned SUBSTRATE price revision (default the baseline's). */
  readonly substratePriceRevisions?: readonly string[];
}): CurveLedgerPin {
  const points: RecordedCurvePoint[] = [
    {
      workloadClass: input.workloadClass,
      generation: 0,
      runs: input.baseline.runs,
      successfulOutcomes: input.baseline.successfulOutcomes,
      measuredModelCostMicroUsd: input.baseline.measuredModelCostMicroUsd,
      substrateOverheadMicroUsd: input.baseline.substrateOverheadMicroUsd,
      modelPriceRevision: input.baseline.modelPriceRevision,
      substratePriceRevision: input.baseline.substratePriceRevision,
      costBasis: "measured",
      ...(input.baseline.estimatedQuoteMicroUsd === undefined
        ? {}
        : { estimatedQuoteMicroUsd: input.baseline.estimatedQuoteMicroUsd }),
    },
  ];
  let previousModelCost = input.baseline.measuredModelCostMicroUsd;
  for (const [index, [runs, outcomes]] of input.runsOutcomes.entries()) {
    const generation = index + 1;
    const attribution = curveAttributionResultOf(input.workloadClass, generation);
    const attributedSum =
      attribution.attributedMicroUsd.reuse +
      attribution.attributedMicroUsd.cache +
      attribution.attributedMicroUsd.competence +
      attribution.attributedMicroUsd.deterministicization;
    const measuredModelCost = previousModelCost - attributedSum - attribution.residualMicroUsd;
    const substrateOverhead = input.substrateOverheads[index] ?? previousModelCost;
    points.push({
      workloadClass: input.workloadClass,
      generation,
      runs,
      successfulOutcomes: outcomes,
      measuredModelCostMicroUsd: measuredModelCost,
      substrateOverheadMicroUsd: substrateOverhead,
      modelPriceRevision: input.modelPriceRevisions?.[index] ?? input.baseline.modelPriceRevision,
      substratePriceRevision:
        input.substratePriceRevisions?.[index] ?? input.baseline.substratePriceRevision,
      costBasis: "measured",
    });
    previousModelCost = measuredModelCost;
  }
  return {
    workloadClass: input.workloadClass,
    description: input.description,
    points,
  };
}

/**
 * The corpus's pinned RECORDED longitudinal ledgers (the read-only
 * input the curve derives from — composed with the VAL-045 attribution
 * so the improvement-rate identity holds EXACTLY):
 *
 *   * `invoice-extraction` — IMPROVING (reuse-dominant savings growing
 *     every generation; a MARKED model price-regime change at
 *     generation 2: rev-001 -> rev-002, the VAL-040 append-only
 *     correction);
 *   * `code-search` — PLATEAUED (cache-dominant savings through
 *     generation 3, then the campaign ended — generations 4 and 5
 *     recorded flat with NO attribution: the honest plateau);
 *   * `tool-routing` — NEVER-MATERIALIZED (a lifecycle history whose
 *     savings were never recorded — the flat curve, never a narrative
 *     improvement);
 *   * `rag-retrieval` — MIXED-COHORT (the aggregate improves every
 *     generation while the deterministicization cohort's attributed
 *     savings HONESTLY regressed 120 -> 40 at generation 2 — reported
 *     as regressing, never hidden);
 *   * `text-summarization` — a SHORT two-generation history (the
 *     below-minimum probe's honest starved sample).
 */
export const LONGITUDINAL_LEDGERS: readonly CurveLedgerPin[] = [
  curveLedgerOf({
    workloadClass: "invoice-extraction",
    description:
      "the invoice-extraction class — reuse-dominant improvement across three generations with a MARKED model price-regime change at generation 2 (rev-001 -> rev-002)",
    baseline: {
      runs: 12,
      successfulOutcomes: 10,
      measuredModelCostMicroUsd: 500,
      substrateOverheadMicroUsd: 60,
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
      estimatedQuoteMicroUsd: 8,
    },
    runsOutcomes: [
      [12, 11],
      [13, 12],
      [14, 13],
    ],
    substrateOverheads: [55, 50, 45],
    modelPriceRevisions: ["rev-001", "rev-002", "rev-002"],
  }),
  curveLedgerOf({
    workloadClass: "code-search",
    description:
      "the code-search class — cache-dominant savings through generation 3, then the attribution campaign ended: generations 4 and 5 recorded flat with no savings (the honest plateau)",
    baseline: {
      runs: 25,
      successfulOutcomes: 25,
      measuredModelCostMicroUsd: 500,
      substrateOverheadMicroUsd: 50,
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
    },
    runsOutcomes: [
      [25, 25],
      [25, 25],
      [25, 25],
      [25, 25],
      [25, 25],
    ],
    substrateOverheads: [50, 50, 50, 50, 50],
  }),
  curveLedgerOf({
    workloadClass: "tool-routing",
    description:
      "the tool-routing class — a lifecycle history whose savings were never recorded: the flat cost curve (never-materialized, never a narrative improvement)",
    baseline: {
      runs: 10,
      successfulOutcomes: 8,
      measuredModelCostMicroUsd: 300,
      substrateOverheadMicroUsd: 40,
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
    },
    runsOutcomes: [
      [10, 8],
      [10, 8],
      [10, 8],
    ],
    substrateOverheads: [40, 40, 40],
  }),
  curveLedgerOf({
    workloadClass: "rag-retrieval",
    description:
      "the rag-retrieval class — all four mechanisms attributed across three generations; the aggregate improves while the deterministicization cohort's attributed savings HONESTLY regressed 120 -> 40 at generation 2 (reported as regressing, never hidden)",
    baseline: {
      runs: 12,
      successfulOutcomes: 10,
      measuredModelCostMicroUsd: 640,
      substrateOverheadMicroUsd: 80,
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
      estimatedQuoteMicroUsd: 9,
    },
    runsOutcomes: [
      [12, 11],
      [13, 12],
      [14, 13],
    ],
    substrateOverheads: [70, 60, 50],
  }),
  curveLedgerOf({
    workloadClass: "text-summarization",
    description:
      "the text-summarization class — a SHORT two-generation history (cache-only savings with a large honest residual; the below-minimum probe's starved sample)",
    baseline: {
      runs: 12,
      successfulOutcomes: 10,
      measuredModelCostMicroUsd: 600,
      substrateOverheadMicroUsd: 50,
      modelPriceRevision: "rev-001",
      substratePriceRevision: "sub-rev-001",
    },
    runsOutcomes: [[12, 11]],
    substrateOverheads: [45],
  }),
];

/** The pinned recorded ledger lookup (PURE). */
export function curveLedgerById(workloadClass: string): CurveLedgerPin | null {
  return LONGITUDINAL_LEDGERS.find((ledger) => ledger.workloadClass === workloadClass) ?? null;
}

// ---------------------------------------------------------------------------
// The digest-reference builders (never copies)
// ---------------------------------------------------------------------------

/**
 * The FABRICATED extrapolated point (the extrapolating probe's
 * denatured shape — DETERMINISTIC): the trend-continuation point the
 * dishonest curve pins one generation BEYOND the recorded evidence
 * (the last recorded model-cost decline continued, the substrate and
 * the workload carried forward). Never an honest input — the
 * no-extrapolation oracle names it.
 */
export function fabricatedExtrapolatedPointOf(
  workloadClass: string,
  generation: number,
): RecordedCurvePoint {
  const ledger = curveLedgerById(workloadClass);
  if (ledger === null) {
    throw new Error(`the recorded ledgers declare no workload class ${workloadClass}`);
  }
  const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
  const last = sorted[sorted.length - 1];
  const before = sorted[sorted.length - 2];
  if (last === undefined || before === undefined) {
    throw new Error(`the ${workloadClass} ledger holds fewer than two points`);
  }
  const decline = before.measuredModelCostMicroUsd - last.measuredModelCostMicroUsd;
  return {
    workloadClass,
    generation,
    runs: last.runs,
    successfulOutcomes: last.successfulOutcomes,
    measuredModelCostMicroUsd: last.measuredModelCostMicroUsd - decline,
    substrateOverheadMicroUsd: last.substrateOverheadMicroUsd,
    modelPriceRevision: last.modelPriceRevision,
    substratePriceRevision: last.substratePriceRevision,
    costBasis: "measured",
  };
}

/**
 * The digest reference for one RECORDED ledger point (PURE): the
 * point's own pinned revisions + the content digest of its RECORDED
 * facts — re-derived from the imported ledger through the same
 * digest derivation the input-integrity oracle runs at verification
 * time. A generation BEYOND the recorded evidence resolves to the
 * FABRICATED extrapolated reference (the extrapolating probe's
 * denatured declaration — named by the no-extrapolation oracle).
 */
export function pointReferenceOf(workloadClass: string, generation: number): CurvePointReference {
  const ledger = curveLedgerById(workloadClass);
  if (ledger === null) {
    throw new Error(`the recorded ledgers declare no workload class ${workloadClass}`);
  }
  const point = ledger.points.find((candidate) => candidate.generation === generation);
  if (point === undefined) {
    const fabricated = fabricatedExtrapolatedPointOf(workloadClass, generation);
    return {
      workloadClass,
      generation,
      recordedDigest: recordedCurvePointDigestOf(fabricated),
      modelPriceRevision: fabricated.modelPriceRevision,
      substratePriceRevision: fabricated.substratePriceRevision,
    };
  }
  return {
    workloadClass,
    generation,
    recordedDigest: recordedCurvePointDigestOf(point),
    modelPriceRevision: point.modelPriceRevision,
    substratePriceRevision: point.substratePriceRevision,
  };
}

/** Build the digest references for a generation range (in order). */
function pointSetOf(
  workloadClass: string,
  fromGeneration: number,
  toGeneration: number,
): readonly CurvePointReference[] {
  const references: CurvePointReference[] = [];
  for (let generation = fromGeneration; generation <= toGeneration; generation += 1) {
    references.push(pointReferenceOf(workloadClass, generation));
  }
  return references;
}

// ---------------------------------------------------------------------------
// The row builder (the honest oracle's derivation)
// ---------------------------------------------------------------------------

/**
 * The ledger's ACTUAL price-regime change points (PURE — the marking
 * basis): every revision change between consecutive recorded points.
 */
function actualRegimeChangePointsOf(ledger: CurveLedgerPin): readonly {
  atGeneration: number;
  dimension: "model" | "substrate";
  fromRevision: string;
  toRevision: string;
}[] {
  const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
  const changes: {
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
    if (previous.modelPriceRevision !== current.modelPriceRevision) {
      changes.push({
        atGeneration: current.generation,
        dimension: "model",
        fromRevision: previous.modelPriceRevision,
        toRevision: current.modelPriceRevision,
      });
    }
    if (previous.substratePriceRevision !== current.substratePriceRevision) {
      changes.push({
        atGeneration: current.generation,
        dimension: "substrate",
        fromRevision: previous.substratePriceRevision,
        toRevision: current.substratePriceRevision,
      });
    }
  }
  return changes;
}

/**
 * Build one offline curve row with its PINNED expected curve outcome:
 * the REAL derivations (the honest point inputs + the honest
 * attribution bundles) run over the declared window at module load —
 * exactly what the driver's own curve derivation must reproduce at
 * run time. The declared cohorts default to the DERIVED cohort
 * verdicts (regressing cohorts reported as regressing); the declared
 * regime change points default to the ledger's ACTUAL changes.
 */
function curveRow(input: {
  readonly rowId: string;
  readonly description: string;
  readonly family: CurveFamily;
  readonly workloadClass: string;
  readonly fromGeneration?: number;
  readonly toGeneration?: number;
  readonly declaredCohorts?: readonly {
    readonly mechanism: CandidateKind;
    readonly reported: "improving" | "regressing" | "newly-appearing";
  }[];
  readonly regimeChangePoints?: readonly {
    readonly atGeneration: number;
    readonly dimension: "model" | "substrate";
    readonly fromRevision: string;
    readonly toRevision: string;
  }[];
  readonly minimumGenerations?: number;
  readonly minimumOutcomesPerPoint?: number;
  readonly verdict?: CurveVerdictKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly adversarial?: CurveAdversarialKind;
  readonly pinSynthesis?: boolean;
}): CurveCorpusRow {
  const ledger = curveLedgerById(input.workloadClass);
  if (ledger === null) {
    throw new Error(`the recorded ledgers declare no workload class ${input.workloadClass}`);
  }
  const sorted = [...ledger.points].sort((left, right) => left.generation - right.generation);
  const fromGeneration = input.fromGeneration ?? sorted[0]?.generation ?? 0;
  const toGeneration = input.toGeneration ?? sorted[sorted.length - 1]?.generation ?? 0;
  const pointSet = pointSetOf(input.workloadClass, fromGeneration, toGeneration);
  const attributionResults = curveAttributionResultsOf(
    input.workloadClass,
    fromGeneration + 1,
    toGeneration,
  );
  const derivedCohorts = deriveCohortVerdicts({ attribution: attributionResults })
    .filter((cohort) =>
      attributionResults.some((result) => (result.attributedMicroUsd[cohort.mechanism] ?? 0) > 0),
    )
    .map((cohort) => ({ mechanism: cohort.mechanism, reported: cohort.verdict }));
  const row: CurveCorpusRow = {
    rowId: input.rowId,
    description: input.description,
    family: input.family,
    workloadClass: input.workloadClass,
    declaredWindow: { fromGeneration, toGeneration },
    pointSet,
    declaredCohorts: input.declaredCohorts ?? derivedCohorts,
    regimeChangePoints:
      input.regimeChangePoints ??
      actualRegimeChangePointsOf(ledger).filter(
        (change) => change.atGeneration > fromGeneration && change.atGeneration <= toGeneration,
      ),
    minimumGenerations: input.minimumGenerations ?? MINIMUM_GENERATIONS_FOR_CURVE,
    minimumOutcomesPerPoint: input.minimumOutcomesPerPoint ?? MINIMUM_OUTCOMES_PER_POINT,
    needsDispatch: false,
    ...(input.adversarial === undefined ? {} : { adversarial: input.adversarial }),
    expected: {
      terminal: input.terminal ?? "COMPLETED",
      verdict: input.verdict ?? "trajectory-improving",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  };
  if ((input.pinSynthesis ?? true) && input.adversarial === undefined) {
    const derived = deriveCurveFamilySynthesis({
      row,
      points: pointSet.map((reference) => {
        const point = ledger.points.find(
          (candidate) => candidate.generation === reference.generation,
        );
        if (point === undefined) {
          throw new Error(
            `the ${input.workloadClass} ledger declares no generation ${reference.generation}`,
          );
        }
        return { ...reference, facts: point };
      }),
      attribution: attributionResults,
    });
    if (derived.synthesis === null) {
      throw new Error(`the expected curve outcome of ${input.rowId} failed to derive`);
    }
    return { ...row, expected: { ...row.expected, synthesis: derived.synthesis } };
  }
  return row;
}

// ---------------------------------------------------------------------------
// The offline rows (deterministic — always drivable, zero credentials)
// ---------------------------------------------------------------------------

/** The honest offline rows (each curve family covered by an honest class). */
export const OFFLINE_CONTROL_ROWS: readonly CurveCorpusRow[] = [
  curveRow({
    rowId: "invoice-extraction-cost-per-outcome-trajectory",
    description:
      "The headline COST-PER-SUCCESSFUL-OUTCOME TRAJECTORY over the invoice-extraction class: four recorded ledger points (digest-referenced — the runs, the successful outcomes, the measured model cost at each point's own pinned revision, the substrate overhead share) composed into the cost-per-outcome trajectory 56 -> 43 -> 30 -> 17 micro-USD, with the model price-regime change at generation 2 (rev-001 -> rev-002, the VAL-040 append-only correction) MARKED on the curve and every point verified against the manifests. Expected verdict: trajectory-improving.",
    family: "cost-per-outcome-trajectory",
    workloadClass: "invoice-extraction",
  }),
  curveRow({
    rowId: "code-search-plateau-maturity-verdict",
    description:
      "The PLATEAU-MATURITY VERDICT over the code-search class: six recorded ledger points — cache-dominant savings attributed through generation 3 (the VAL-045 attribution results, digest-referenced), then the campaign ended and generations 4 and 5 recorded flat with NO attribution (the honest plateau: the last-window improvement rate is exactly zero, below the pinned threshold). The verdict is derived over the pinned thresholds — never a narrative. Expected verdict: trajectory-plateaued.",
    family: "plateau-maturity-verdict",
    workloadClass: "code-search",
    verdict: "trajectory-plateaued",
  }),
  curveRow({
    rowId: "tool-routing-never-materialized",
    description:
      "The honest NEVER-MATERIALIZED verdict over the tool-routing class: four recorded ledger points whose costs never improved — the VAL-045 attribution history honestly records no savings for the class (the empty attribution result per generation, digest-referenced), and the flat curve reports exactly that. The honest classification IS the verified outcome. Expected verdict: never-materialized.",
    family: "plateau-maturity-verdict",
    workloadClass: "tool-routing",
    verdict: "never-materialized",
  }),
  curveRow({
    rowId: "rag-retrieval-improvement-rate-decomposition",
    description:
      "The IMPROVEMENT-RATE DECOMPOSITION over the rag-retrieval class: every generation's measured improvement delta decomposes EXACTLY into the VAL-045 attributed mechanisms + the substrate savings + the honest residual (190 = 150 + 10 + 30 at g1; 170 = 140 + 10 + 30 at g2; 165 = 110 + 10 + 35 at g3) — while the deterministicization cohort's attributed savings HONESTLY regressed 120 -> 40 at generation 2, reported as regressing in the declared cohorts (never hidden). Expected verdict: mixed-cohort-regressing.",
    family: "improvement-rate-decomposition",
    workloadClass: "rag-retrieval",
    verdict: "mixed-cohort-regressing",
  }),
];

/** The adversarial probe rows (each FAILs its named criterion honestly). */
export const PROBE_ROWS: readonly CurveCorpusRow[] = [
  curveRow({
    rowId: "probe-cherry-picked-window",
    description:
      "The cherry-picked-window probe over the code-search class: the row declares the window [3, 5] — the flat tail — hiding the three recorded improving generations 0..2 (the class improved, then plateaued; the cherry-picked window tells a never-improved story). The window-honesty oracle FAILs it MECHANICALLY with the omitted generations named (the window that matches the recorded data is the recorded span, never a curated slice).",
    family: "plateau-maturity-verdict",
    workloadClass: "code-search",
    fromGeneration: 3,
    toGeneration: 5,
    adversarial: "cherry-picked-window",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-regime-normalizing",
    description:
      "The regime-normalizing probe over the invoice-extraction class: the curve CLAIMS a constant rev-001 model price basis for the generations 2 and 3 points while the recorded ledger pins them at rev-002 (the append-only price correction) — and declares NO regime change points. The price-regime-marking oracle FAILs it MECHANICALLY (a price-regime change is marked on the curve, never silently normalized away).",
    family: "cost-per-outcome-trajectory",
    workloadClass: "invoice-extraction",
    regimeChangePoints: [],
    adversarial: "regime-normalizing",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-extrapolating",
    description:
      "The extrapolating probe over the invoice-extraction class: the curve carries a FABRICATED generation-4 point beyond the recorded evidence (the recorded ledger ends at generation 3) — the trend continued onto a point no ledger records. The no-extrapolation oracle FAILs it MECHANICALLY with the point named (the recorded evidence's last generation named alongside).",
    family: "cost-per-outcome-trajectory",
    workloadClass: "invoice-extraction",
    toGeneration: 4,
    adversarial: "extrapolating",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-residual-hiding",
    description:
      "The residual-hiding probe over the rag-retrieval class: the row's attribution bundles CLAIM a zero residual for every generation while the VAL-045 recorded totals carry honest residuals of 30/30/35 micro-USD. The improvement-rate-reconciliation oracle FAILs it MECHANICALLY with both sides named (the unattributed share is reported, never hidden, never forced into a mechanism).",
    family: "improvement-rate-decomposition",
    workloadClass: "rag-retrieval",
    adversarial: "residual-hiding",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-cohort-hiding",
    description:
      "The cohort-hiding probe over the rag-retrieval class: the row's declared cohorts report the deterministicization cohort as IMPROVING while the recorded attribution series shows its attributed savings regressed 120 -> 40 at generation 2. The cohort-honesty oracle FAILs it MECHANICALLY (a regressing cohort is reported as regressing — hiding it FAILs with the cohort and its series named).",
    family: "improvement-rate-decomposition",
    workloadClass: "rag-retrieval",
    declaredCohorts: [
      { mechanism: "reuse", reported: "improving" },
      { mechanism: "cache", reported: "newly-appearing" },
      { mechanism: "competence", reported: "newly-appearing" },
      { mechanism: "deterministicization", reported: "improving" },
    ],
    adversarial: "cohort-hiding",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-post-hoc-exclusion",
    description:
      "The post-hoc-exclusion probe over the code-search class: one PRE-REGISTERED curve point (generation 4) is DROPPED from the executed input set — the confidence-and-minimum oracle FAILs it MECHANICALLY (the pre-registered window decides; an excluded point is a post-hoc exclusion, never data).",
    family: "cost-per-outcome-trajectory",
    workloadClass: "code-search",
    adversarial: "post-hoc-exclusion",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-sample-size-violation",
    description:
      "The sample-size violation probe over the text-summarization class: the class's recorded history holds only TWO generations (the honestly starved sample) while the row CLAIMS the trajectory-improving verdict — the below-minimum-refusal-honesty oracle FAILs it MECHANICALLY (a curve below the pre-registered minimum of three generations claims a verdict it cannot support; the honest outcome is the refusal).",
    family: "cost-per-outcome-trajectory",
    workloadClass: "text-summarization",
    adversarial: "sample-size-violation",
    terminal: "FAILED",
    verdict: "trajectory-improving",
    pinSynthesis: false,
  }),
  curveRow({
    rowId: "probe-remeasurement-masquerade",
    description:
      "The re-measurement masquerade probe over the invoice-extraction class: the generation-2 point's bundle carries a RE-MEASURED model cost (its own number, not the recorded ledger's) while declaring the recorded digest — the input-integrity oracle FAILs it MECHANICALLY, field by field (the curve derives over RECORDED results; a re-measurement masquerading as derivation is refused).",
    family: "cost-per-outcome-trajectory",
    workloadClass: "invoice-extraction",
    adversarial: "remeasurement",
    terminal: "FAILED",
    verdict: "adversarial-failed",
    pinSynthesis: false,
  }),
];

/** The offline rows (honest controls first, probes last — deterministic, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly CurveCorpusRow[] = [
  ...OFFLINE_CONTROL_ROWS,
  ...PROBE_ROWS,
];

// ---------------------------------------------------------------------------
// The live row (env-gated on the authorized rail; REAL longitudinal slice)
// ---------------------------------------------------------------------------

/** The live row's pinned point references (the measured lane's declarations). */
function livePointReferencesOf(): readonly CurvePointReference[] {
  const digest = liveCurvePlanDigestOf();
  return Array.from({ length: LIVE_CURVE_PLAN.points }, (_, index) => ({
    workloadClass: LIVE_CURVE_PLAN.workloadClass,
    generation: index + 1,
    recordedDigest: digest,
    modelPriceRevision: LIVE_CURVE_PLAN.modelPriceRevision,
    substratePriceRevision: LIVE_CURVE_PLAN.substratePriceRevision,
    live: true,
  }));
}

/** The live rows (env-gated on the authorized rail; one REAL longitudinal slice). */
export const LIVE_CORPUS_ROWS: readonly CurveCorpusRow[] = [
  {
    rowId: "live-longitudinal-curve-real-slice",
    description:
      "A REAL longitudinal slice (env-gated): three REAL curve points over the live workload class — each point a REAL sustained-operation unit whose workload rides REAL model dispatches on the operator-authorized OpenRouter rail (BYOK, measured usage, every priced input at its pinned manifest revision) — with the curve points computed over MEASURED facts and the verdict recorded through the REAL recorder with honest economics. Without the credential the row is honestly NOT RUN (never fabricated).",
    family: "cost-per-outcome-trajectory",
    workloadClass: LIVE_CURVE_PLAN.workloadClass,
    declaredWindow: { fromGeneration: 1, toGeneration: LIVE_CURVE_PLAN.points },
    pointSet: livePointReferencesOf(),
    declaredCohorts: [],
    regimeChangePoints: [],
    minimumGenerations: LIVE_CURVE_PLAN.points,
    minimumOutcomesPerPoint: 1,
    needsDispatch: true,
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the pinned chat model meta-llama/llama-3.3-70b-instruct — the REAL longitudinal slice demands REAL workload dispatches on the pinned rail (BYOK, measured usage, max_tokens 32 pinned explicitly, temperature unset per the provider's documented default)",
    },
    expected: {
      terminal: "COMPLETED",
      verdict: "trajectory-improving",
      executions: 1,
      idempotencyRecords: 1,
      appCreated: 1,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const CURVE_CORPUS: readonly CurveCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: CurveCorpusRow, env: NodeJS.ProcessEnv): boolean {
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
  return `val-047-app-${options.runSuffix}-${options.taskIndex}`;
}

/**
 * The app's task body for one row's submission: REFERENCES ONLY — the
 * row, the family, the workload class, the declared window, the
 * pre-registered point set (digest references), the declared cohorts,
 * the regime change points, the minimums, the Wilson level and the
 * expected verdict. Never a price, never a recorded result copy (the
 * platform resolves the ledgers, the attribution corpora and the
 * manifests through their registries).
 */
export function taskBodyFor(options: { readonly row: CurveCorpusRow }): Record<string, unknown> {
  const { row } = options;
  return {
    kind: CURVE_TASK_KIND,
    rowId: row.rowId,
    family: row.family,
    workloadClass: row.workloadClass,
    declaredWindow: row.declaredWindow,
    preRegisteredPointSet: row.pointSet.map((reference) => ({
      workloadClass: reference.workloadClass,
      generation: reference.generation,
      recordedDigest: reference.recordedDigest,
      modelPriceRevision: reference.modelPriceRevision,
      substratePriceRevision: reference.substratePriceRevision,
    })),
    declaredCohorts: row.declaredCohorts,
    regimeChangePoints: row.regimeChangePoints,
    minimumGenerations: row.minimumGenerations,
    minimumOutcomesPerPoint: row.minimumOutcomesPerPoint,
    wilsonConfidenceLevel: 0.95,
    expectedVerdict: row.expected.verdict,
    ...(row.liveGate === undefined ? {} : { liveGate: row.liveGate.envVars }),
  };
}

/** The row ids in corpus order (config.json mirrors this slice). */
export const CURVE_ROW_IDS: readonly string[] = CURVE_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function curveRowById(rowId: string): CurveCorpusRow | null {
  return CURVE_CORPUS.find((row) => row.rowId === rowId) ?? null;
}

// ---------------------------------------------------------------------------
// The honest input resolution (the driver's canonical input basis)
// ---------------------------------------------------------------------------

/** The honest resolved inputs of one row (the driver's + the tests' basis). */
export interface HonestCurveInputs {
  readonly points: readonly CurvePointInput[];
  readonly attribution: readonly CurveAttributionInput[];
  readonly recordedLedger: readonly RecordedCurvePoint[];
  readonly recordedAttribution: readonly CurveAttributionResult[];
}

/**
 * The HONEST resolved inputs of one row (PURE): every point reference
 * resolves against the recorded ledger into the FULL recorded facts,
 * and every generation in the window carries its RECORDED attribution
 * result (the empty one where nothing recorded) — the bundle the
 * input-integrity oracle verifies field-by-field. A reference beyond
 * the recorded ledger resolves to NOTHING (the extrapolating probe's
 * fabricated point is the fixtures' business, never the honest path).
 */
export function honestCurveInputsOf(row: CurveCorpusRow): HonestCurveInputs {
  const ledger = curveLedgerById(row.workloadClass);
  if (ledger === null) {
    throw new Error(`the recorded ledgers declare no workload class ${row.workloadClass}`);
  }
  const points = row.pointSet.flatMap((reference) => {
    const point = ledger.points.find((candidate) => candidate.generation === reference.generation);
    if (point === undefined) {
      return [];
    }
    return [
      {
        workloadClass: reference.workloadClass,
        generation: reference.generation,
        recordedDigest: reference.recordedDigest,
        modelPriceRevision: reference.modelPriceRevision,
        substratePriceRevision: reference.substratePriceRevision,
        ...(reference.live === undefined ? {} : { live: reference.live }),
        facts: point,
      },
    ];
  });
  const recordedAttribution = curveAttributionResultsOf(
    row.workloadClass,
    row.declaredWindow.fromGeneration + 1,
    row.declaredWindow.toGeneration,
  );
  return {
    points,
    attribution: recordedAttribution,
    recordedLedger: ledger.points,
    recordedAttribution,
  };
}

/**
 * The corpus's input digest over the full pinned recorded basis (PURE
 * — the deterministic-corpus fingerprint the config carries).
 */
export function pinnedCurveInputDigest(): string {
  return curveAttributionDigestOf({
    workloadClass: "val-047-longitudinal-curve-corpus",
    generation: 0,
    attributedMicroUsd: {
      reuse: 0,
      cache: 0,
      competence: 0,
      deterministicization: 0,
    },
    residualMicroUsd: 0,
    ledgerEntryDigests: FAMILY_ECONOMICS.flatMap((economics) =>
      economics.ledgerEntries.map((entry) => attributionEntryDigestOf(entry)),
    ),
    recordedTotalDigests: FAMILY_ECONOMICS.flatMap((economics) =>
      economics.recordedTotals.map((record) => recordedSavingsTotalDigestOf(record)),
    ),
  });
}
