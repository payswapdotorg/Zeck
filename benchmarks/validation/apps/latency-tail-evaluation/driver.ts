/**
 * The evaluation driver (PCL-003): the per-cell orchestration, the
 * census reconciliation proofs, the cost-truth lines, the aggregation
 * and the digests.
 *
 * THE CELL LAW: per cell, BOTH arms replay FRESH over the same corpus
 * and the same arm-agnostic draws (the replay engine); each arm's
 * executions project into the typed-fact percentile tables (never
 * aggregate-only), the cost lines (every number with its explicit
 * basis), the census proof (attempts = original + retry + fallback +
 * verification — a dropped or reclassified failure is the
 * automatic-void shape, mechanically caught here), and the per-cell
 * honest verdict (the gate's four legs at the cell level). The
 * capstone's recorded result is quoted VERBATIM beside the re-run
 * (its own basis preserved, never relabeled).
 *
 * THE AGGREGATE LAW: the per-arm global aggregates pool every
 * execution of every cell (the outcome percentiles, the per-class
 * decompositions, the cost truth — the transport's nano accounting
 * rounded ONCE at the global line — the census); the promotion gate is
 * applied MECHANICALLY over the two aggregates against the DECLARED
 * thresholds (loaded fail-closed from the committed declaration file —
 * the declared-before discipline).
 *
 * THE DIGEST LAW: every digest runs over a canonical projection that
 * EXCLUDES wall-clock values and run identities; the per-cell digest
 * binds the full typed-fact evidence through the facts' content
 * addresses (the suite re-derives every identity from the committed
 * records and re-computes every digest).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCellCorpus } from "../shared/seam";
import { createNodeDigestPort, type DigestPort, evaluationCanonicalJson } from "./canonical";
import { BASELINE_ARM, TUNED_ARM } from "./configurations";
import {
  type EvaluationCell,
  type RecordedCapstoneCell,
  recordedCapstoneCellOf,
  targetedCells,
} from "./corpus";
import {
  type ArmGateFacts,
  applyPromotionGate,
  DECLARED_THRESHOLDS,
  type DeclaredThresholds,
  type PromotionGateVerdict,
} from "./gate";
import type { PacingResolverFactory } from "./pacing";
import {
  legPercentilesByFailureClassAndRoute,
  outcomePercentilesByEncounteredClass,
  outcomePercentilesByOutcomeClass,
  overallOutcomePercentiles,
  type PercentileRow,
  resolvedOutcomePercentiles,
} from "./percentiles";
import { type ExecutionRecord, replayCellArm } from "./replay";

/** The committed declaration file (experiments/pcl-003/declared-thresholds.json). */
const DECLARED_THRESHOLDS_PATH = fileURLToPath(
  new URL("../../../../experiments/pcl-003/declared-thresholds.json", import.meta.url),
);

/**
 * Load and validate the committed threshold declarations — fail-closed
 * (a missing or drifted declaration file is a typed error, never a
 * silent default; the declarations were committed BEFORE the run).
 */
export function loadDeclaredThresholds(): DeclaredThresholds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(DECLARED_THRESHOLDS_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `the committed threshold declarations are unreadable at experiments/pcl-003/declared-thresholds.json (the declared-before discipline is fail-closed): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const t1 = record.t1Tail as Record<string, unknown> | undefined;
  const t2 = record.t2Resolution as Record<string, unknown> | undefined;
  const t3 = record.t3Cost as Record<string, unknown> | undefined;
  const t4 = record.t4Preservation as Record<string, unknown> | undefined;
  if (
    t1?.rule !== "p95-and-p99-strictly-improved" ||
    t2?.rule !== "resolution-rate-not-below-baseline" ||
    t3?.rule !== "total-cost-within-budget-delta" ||
    t4?.rule !== "timeout-and-terminal-preservation"
  ) {
    throw new Error(
      "the committed threshold declarations drifted from the declared rules (the gate applies the COMMITTED declarations, fail-closed)",
    );
  }
  const fraction = t3.budgetDeltaFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0) {
    throw new Error("the declared cost budget delta fraction must be a finite non-negative number");
  }
  return {
    t1Tail: { rule: "p95-and-p99-strictly-improved", points: ["p95", "p99"] },
    t2Resolution: { rule: "resolution-rate-not-below-baseline" },
    t3Cost: { rule: "total-cost-within-budget-delta", budgetDeltaFraction: fraction },
    t4Preservation: { rule: "timeout-and-terminal-preservation" },
  };
}

/** One cost-truth line (the explicit-basis discipline: every number states its basis). */
export interface CostTruthLine {
  readonly microUsd: number;
  readonly basis: string;
}

/** One arm's cost truth: total including duplicates, the duplicates component, verification its own line. */
export interface ArmCostTruth {
  readonly totalIncludingDuplicates: CostTruthLine;
  readonly duplicates: CostTruthLine;
  readonly verification: CostTruthLine;
  readonly dispatches: number;
}

/** The attempt-census proof. */
export interface CensusProof {
  readonly original: number;
  readonly retry: number;
  readonly fallback: number;
  readonly verification: number;
  readonly attempts: number;
  readonly legs: number;
  /** attempts === original + retry + fallback + verification === legs (the exact reconciliation). */
  readonly reconciles: boolean;
}

/** One arm's measured facts (the shared summary shape, cell-level and global). */
export interface ArmMeasuredSummary {
  readonly armId: string;
  readonly label: string;
  readonly basis: string;
  readonly executions: number;
  readonly resolved: number;
  readonly failed: number;
  readonly resolutionRate: number;
  readonly overallOutcomeLatency: PercentileRow;
  /** The successful-outcome tail (the capstone's own latency-tail pool — the T1 pool). */
  readonly resolvedOutcomeLatency: PercentileRow;
  readonly outcomeLatencyByClass: readonly PercentileRow[];
  readonly outcomeLatencyByEncounteredClass: readonly PercentileRow[];
  readonly legPercentilesByClassAndRoute: readonly PercentileRow[];
  readonly cost: ArmCostTruth;
  readonly census: CensusProof;
  readonly terminalFailures: number;
  readonly maskedTerminalFailures: number;
  readonly dispatchBudgetViolations: number;
  readonly maxElapsedMs: number | null;
  readonly verificationOutcomes: { readonly pass: number; readonly notRun: number };
}

/** One arm's cell result (the measured summary + the facts identities binding the evidence). */
export interface ArmCellResult extends ArmMeasuredSummary {
  readonly factsIdentities: readonly string[];
}

/** The per-cell honest verdict (the gate's four legs at the cell level). */
export interface CellVerdict {
  readonly tailImproved: boolean;
  readonly resolutionNotRegressed: boolean;
  readonly costWithinBudget: boolean;
  readonly preservationHeld: boolean;
  readonly verdict: "cell-passed" | "cell-missed";
  readonly failingLegs: readonly string[];
}

/** One cell's evaluation result's digest-projection fields (wall-clock and the evidence body excluded by construction). */
export interface CellProjectionInput {
  readonly cellId: string;
  readonly subjectId: string;
  readonly dimensions: {
    readonly volume: string;
    readonly repetitions: number;
    readonly providerConfig: string;
    readonly modality: string;
  };
  readonly corpus: { readonly tasks: number; readonly requests: number };
  readonly arms: { readonly baseline: ArmCellResult; readonly tuned: ArmCellResult };
  readonly recorded: RecordedCapstoneCell;
  readonly cellVerdict: CellVerdict;
}

/** One cell's evaluation result (both arms + the recorded quote + the verdict + the digest). */
export interface CellEvaluationResult extends CellProjectionInput {
  readonly digest: string;
  readonly wallMs: number;
  /** The full per-execution evidence (the committed artifact's body; bound by the facts identities). */
  readonly evidence: {
    readonly baseline: readonly ExecutionRecord[];
    readonly tuned: readonly ExecutionRecord[];
  };
}

/** The digest projection of one arm's summary. */
function armSummaryProjectionOf(arm: ArmMeasuredSummary): Record<string, unknown> {
  return {
    armId: arm.armId,
    executions: arm.executions,
    resolved: arm.resolved,
    failed: arm.failed,
    resolutionRate: arm.resolutionRate,
    resolvedOutcomeLatency: arm.resolvedOutcomeLatency,
    overallOutcomeLatency: arm.overallOutcomeLatency,
    outcomeLatencyByClass: arm.outcomeLatencyByClass,
    outcomeLatencyByEncounteredClass: arm.outcomeLatencyByEncounteredClass,
    legPercentilesByClassAndRoute: arm.legPercentilesByClassAndRoute,
    cost: arm.cost,
    census: arm.census,
    terminalFailures: arm.terminalFailures,
    maskedTerminalFailures: arm.maskedTerminalFailures,
    dispatchBudgetViolations: arm.dispatchBudgetViolations,
    maxElapsedMs: arm.maxElapsedMs,
    verificationOutcomes: arm.verificationOutcomes,
    ...("factsIdentities" in arm
      ? { factsIdentities: [...(arm as ArmCellResult).factsIdentities] }
      : {}),
  };
}

/** The cell's digest projection (wall-clock excluded by construction). */
export function cellDigestProjectionOf(cell: CellProjectionInput): string {
  return evaluationCanonicalJson({
    cellId: cell.cellId,
    subjectId: cell.subjectId,
    dimensions: cell.dimensions,
    corpus: cell.corpus,
    arms: {
      baseline: armSummaryProjectionOf(cell.arms.baseline),
      tuned: armSummaryProjectionOf(cell.arms.tuned),
    },
    recorded: {
      cellId: cell.recorded.cellId,
      recorded: cell.recorded.recorded,
      latencyTail: cell.recorded.latencyTail,
      mediatedOutcomes: cell.recorded.mediatedOutcomes,
      mediatedLatencySummary: cell.recorded.mediatedLatencySummary,
      basis: cell.recorded.basis,
    },
    cellVerdict: cell.cellVerdict,
  });
}

const TOTAL_COST_BASIS =
  "synthetic-price-schedule:transport-charges-per-physical-dispatch (nano-USD summed over every attempt of every execution, rounded once to integer micro-USD)";
const DUPLICATES_COST_BASIS =
  "synthetic-price-schedule:transport-charges-per-duplicate-attempt (every attempt beyond the first of each execution — the duplicate-attempt truth)";
const VERIFICATION_COST_BASIS =
  "synthetic-price-schedule:no-verification-charge (internal verification draws no provider charge under the declared schedule)";

function costTruthOf(executions: readonly ExecutionRecord[]): ArmCostTruth {
  let totalNano = 0;
  let duplicatesNano = 0;
  let dispatches = 0;
  let verificationMicro = 0;
  for (const execution of executions) {
    const ladderNano = execution.attempts.reduce((sum, attempt) => sum + attempt.costNanoUsd, 0);
    totalNano += ladderNano;
    duplicatesNano += execution.attempts
      .slice(1)
      .reduce((sum, attempt) => sum + attempt.costNanoUsd, 0);
    dispatches += execution.attempts.length;
    verificationMicro +=
      execution.facts.cost.verification.kind === "measured"
        ? Number(execution.facts.cost.verification.microUsd)
        : 0;
  }
  return {
    totalIncludingDuplicates: { microUsd: Math.round(totalNano / 1000), basis: TOTAL_COST_BASIS },
    duplicates: { microUsd: Math.round(duplicatesNano / 1000), basis: DUPLICATES_COST_BASIS },
    verification: { microUsd: verificationMicro, basis: VERIFICATION_COST_BASIS },
    dispatches,
  };
}

function censusProofOf(executions: readonly ExecutionRecord[]): CensusProof {
  let original = 0;
  let retry = 0;
  let fallback = 0;
  let verification = 0;
  let attempts = 0;
  let legs = 0;
  for (const execution of executions) {
    original += execution.facts.attemptCensus.original;
    retry += execution.facts.attemptCensus.retry;
    fallback += execution.facts.attemptCensus.fallback;
    verification += execution.facts.attemptCensus.verification;
    attempts += execution.facts.attemptCensus.attempts;
    legs += execution.facts.legs.length;
  }
  const sum = original + retry + fallback + verification;
  const dispatchLegs = original + retry + fallback;
  return {
    original,
    retry,
    fallback,
    verification,
    attempts,
    legs,
    // The exact outcome-census reconciliation (ACR-010 §2, no failure
    // hiding): attempts = original + retry + fallback + verification,
    // and the route legs = original + retry + fallback (the dispatch
    // attempts; the verification attempts are not route legs).
    reconciles: attempts === sum && legs === dispatchLegs,
  };
}

function measuredSummaryOf(
  arm: { readonly armId: string; readonly label: string; readonly basis: string },
  executions: readonly ExecutionRecord[],
  dispatchBudgetViolations: number,
  maxElapsedMs: number,
): ArmMeasuredSummary {
  const outcomes = executions.map((execution) => ({
    outcomeClass: execution.outcomeClass as string,
    outcomeLatencyMs: execution.outcomeLatencyMs,
  }));
  const resolved = executions.filter((execution) => execution.resolved).length;
  const terminalFailures = executions.filter(
    (execution) => execution.facts.outcomeClass === "failed-terminal",
  ).length;
  const maskedTerminalFailures = executions.filter(
    (execution) => execution.facts.outcomeClass === "failed-terminal" && execution.facts.resolved,
  ).length;
  return {
    armId: arm.armId,
    label: arm.label,
    basis: arm.basis,
    executions: executions.length,
    resolved,
    failed: executions.length - resolved,
    resolutionRate: executions.length === 0 ? 0 : resolved / executions.length,
    overallOutcomeLatency: overallOutcomePercentiles(outcomes),
    resolvedOutcomeLatency: resolvedOutcomePercentiles(outcomes),
    outcomeLatencyByClass: outcomePercentilesByOutcomeClass(outcomes),
    outcomeLatencyByEncounteredClass: outcomePercentilesByEncounteredClass(
      executions.map((execution) => ({
        outcomeLatencyMs: execution.outcomeLatencyMs,
        facts: execution.facts,
      })),
    ),
    legPercentilesByClassAndRoute: legPercentilesByFailureClassAndRoute(
      executions.map((execution) => execution.facts),
    ),
    cost: costTruthOf(executions),
    census: censusProofOf(executions),
    terminalFailures,
    maskedTerminalFailures,
    dispatchBudgetViolations,
    maxElapsedMs,
    verificationOutcomes: {
      pass: executions.filter((execution) => execution.verificationOutcome === "pass").length,
      notRun: executions.filter((execution) => execution.verificationOutcome === "not-run").length,
    },
  };
}

/** Run ONE cell's evaluation (both arms FRESH + the recorded quote + the verdict). */
export function runEvaluationCell(
  cell: EvaluationCell,
  options: {
    readonly thresholds: DeclaredThresholds;
    readonly digest?: DigestPort;
    readonly resolverFactory?: PacingResolverFactory;
  },
): CellEvaluationResult {
  const digest = options.digest ?? createNodeDigestPort();
  const startedAt = Date.now();
  const corpusTasks = buildCellCorpus(cell.subject, cell.modality, cell.volume, cell.repetitions);
  const totalRequests = corpusTasks.reduce((sum, task) => sum + task.requests.length, 0);

  const baselineReplay = replayCellArm(cell, BASELINE_ARM, {
    ...(options.resolverFactory === undefined ? {} : { resolverFactory: options.resolverFactory }),
    digest,
  });
  const tunedReplay = replayCellArm(cell, TUNED_ARM, {
    ...(options.resolverFactory === undefined ? {} : { resolverFactory: options.resolverFactory }),
    digest,
  });

  const baseline: ArmCellResult = {
    ...measuredSummaryOf(
      BASELINE_ARM,
      baselineReplay.executions,
      baselineReplay.dispatchBudgetViolations,
      baselineReplay.maxElapsedMs,
    ),
    factsIdentities: baselineReplay.executions.map((execution) => execution.factsIdentity),
  };
  const tuned: ArmCellResult = {
    ...measuredSummaryOf(
      TUNED_ARM,
      tunedReplay.executions,
      tunedReplay.dispatchBudgetViolations,
      tunedReplay.maxElapsedMs,
    ),
    factsIdentities: tunedReplay.executions.map((execution) => execution.factsIdentity),
  };

  const failingLegs: string[] = [];
  const tailImproved =
    tuned.resolvedOutcomeLatency.p95Ms !== null &&
    baseline.resolvedOutcomeLatency.p95Ms !== null &&
    tuned.resolvedOutcomeLatency.p99Ms !== null &&
    baseline.resolvedOutcomeLatency.p99Ms !== null &&
    (tuned.resolvedOutcomeLatency.p95Ms as number) <
      (baseline.resolvedOutcomeLatency.p95Ms as number) &&
    (tuned.resolvedOutcomeLatency.p99Ms as number) <
      (baseline.resolvedOutcomeLatency.p99Ms as number);
  if (!tailImproved) {
    failingLegs.push("T1");
  }
  const resolutionNotRegressed = tuned.resolutionRate >= baseline.resolutionRate;
  if (!resolutionNotRegressed) {
    failingLegs.push("T2");
  }
  const costWithinBudget =
    tuned.cost.totalIncludingDuplicates.microUsd <=
    Math.round(
      baseline.cost.totalIncludingDuplicates.microUsd *
        (1 + options.thresholds.t3Cost.budgetDeltaFraction),
    );
  if (!costWithinBudget) {
    failingLegs.push("T3");
  }
  const preservationHeld =
    tuned.maskedTerminalFailures === 0 &&
    baseline.maskedTerminalFailures === 0 &&
    tuned.dispatchBudgetViolations === 0 &&
    baseline.dispatchBudgetViolations === 0 &&
    tuned.census.reconciles &&
    baseline.census.reconciles;
  if (!preservationHeld) {
    failingLegs.push("T4");
  }
  const cellVerdict: CellVerdict = {
    tailImproved,
    resolutionNotRegressed,
    costWithinBudget,
    preservationHeld,
    verdict: failingLegs.length === 0 ? "cell-passed" : "cell-missed",
    failingLegs,
  };

  const projectionInput: CellProjectionInput = {
    cellId: cell.cellId,
    subjectId: cell.subject.subjectId,
    dimensions: {
      volume: cell.volume,
      repetitions: cell.repetitions,
      providerConfig: cell.providerConfig,
      modality: cell.modality,
    },
    corpus: { tasks: corpusTasks.length, requests: totalRequests },
    arms: { baseline, tuned },
    recorded: recordedCapstoneCellOf(cell.cellId),
    cellVerdict,
  };
  return {
    ...projectionInput,
    digest: digest.sha256Hex(cellDigestProjectionOf(projectionInput)),
    wallMs: Date.now() - startedAt,
    evidence: {
      baseline: baselineReplay.executions,
      tuned: tunedReplay.executions,
    },
  };
}

// ---------------------------------------------------------------------------
// The aggregation (the program-level evidence)
// ---------------------------------------------------------------------------

/** The full evaluation aggregate (the program-level evidence). */
export interface EvaluationAggregate {
  readonly arms: { readonly baseline: ArmMeasuredSummary; readonly tuned: ArmMeasuredSummary };
  readonly gate: PromotionGateVerdict;
  readonly cellVerdicts: {
    readonly passed: number;
    readonly missed: number;
    readonly failingLegTallies: Readonly<Record<string, number>>;
  };
  readonly cells: readonly {
    readonly cellId: string;
    readonly digest: string;
    readonly cellVerdict: CellVerdict;
    readonly corpus: { readonly tasks: number; readonly requests: number };
  }[];
  readonly corpusDigest: string;
  readonly thresholdsDigest: string;
  readonly evaluationDigest: string;
}

function armAggregateOf(
  arm: { readonly armId: string; readonly label: string; readonly basis: string },
  executions: readonly ExecutionRecord[],
  dispatchBudgetViolations: number,
  maxElapsedMs: number,
): ArmMeasuredSummary {
  return measuredSummaryOf(arm, executions, dispatchBudgetViolations, maxElapsedMs);
}

/** The aggregate's digest projection (wall-clock and run identities excluded). */
export function evaluationDigestProjectionOf(
  aggregate: Omit<EvaluationAggregate, "evaluationDigest">,
): string {
  return evaluationCanonicalJson({
    arms: {
      baseline: armSummaryProjectionOf(aggregate.arms.baseline),
      tuned: armSummaryProjectionOf(aggregate.arms.tuned),
    },
    gate: aggregate.gate,
    cellVerdicts: aggregate.cellVerdicts,
    cells: aggregate.cells,
    corpusDigest: aggregate.corpusDigest,
    thresholdsDigest: aggregate.thresholdsDigest,
  });
}

/** The measured summary → the gate's facts (the projection the gate consumes). */
function armGateFactsOf(arm: ArmMeasuredSummary): ArmGateFacts {
  return {
    armId: arm.armId,
    executions: arm.executions,
    resolved: arm.resolved,
    resolutionRate: arm.resolutionRate,
    p50Ms: arm.resolvedOutcomeLatency.p50Ms,
    p95Ms: arm.resolvedOutcomeLatency.p95Ms,
    p99Ms: arm.resolvedOutcomeLatency.p99Ms,
    totalCostMicroUsd: arm.cost.totalIncludingDuplicates.microUsd,
    totalCostBasis: arm.cost.totalIncludingDuplicates.basis,
    verificationCostMicroUsd: arm.cost.verification.microUsd,
    verificationCostBasis: arm.cost.verification.basis,
    terminalFailures: arm.terminalFailures,
    maskedTerminalFailures: arm.maskedTerminalFailures,
    dispatchBudgetViolations: arm.dispatchBudgetViolations,
    censusReconciles: arm.census.reconciles,
  };
}

/** Aggregate the cells into the program-level evidence + the mechanical gate verdict. */
export function aggregateEvaluation(
  cells: readonly CellEvaluationResult[],
  input: {
    readonly corpusDigest: string;
    readonly thresholds: DeclaredThresholds;
    readonly thresholdsDigest: string;
    readonly digest?: DigestPort;
  },
): EvaluationAggregate {
  const digest = input.digest ?? createNodeDigestPort();
  const baselineExecutions = cells.flatMap((cell) => cell.evidence.baseline);
  const tunedExecutions = cells.flatMap((cell) => cell.evidence.tuned);
  const baseline = armAggregateOf(
    BASELINE_ARM,
    baselineExecutions,
    cells.reduce((sum, cell) => sum + cell.arms.baseline.dispatchBudgetViolations, 0),
    Math.max(0, ...cells.map((cell) => cell.arms.baseline.maxElapsedMs ?? 0)),
  );
  const tuned = armAggregateOf(
    TUNED_ARM,
    tunedExecutions,
    cells.reduce((sum, cell) => sum + cell.arms.tuned.dispatchBudgetViolations, 0),
    Math.max(0, ...cells.map((cell) => cell.arms.tuned.maxElapsedMs ?? 0)),
  );
  const gate = applyPromotionGate({
    baseline: armGateFactsOf(baseline),
    tuned: armGateFactsOf(tuned),
    thresholds: input.thresholds,
  });
  const failingLegTallies: Record<string, number> = { T1: 0, T2: 0, T3: 0, T4: 0 };
  let passed = 0;
  let missed = 0;
  for (const cell of cells) {
    if (cell.cellVerdict.verdict === "cell-passed") {
      passed += 1;
    } else {
      missed += 1;
      for (const leg of cell.cellVerdict.failingLegs) {
        failingLegTallies[leg] = (failingLegTallies[leg] ?? 0) + 1;
      }
    }
  }
  const projection: Omit<EvaluationAggregate, "evaluationDigest"> = {
    arms: { baseline, tuned },
    gate,
    cellVerdicts: { passed, missed, failingLegTallies },
    cells: cells.map((cell) => ({
      cellId: cell.cellId,
      digest: cell.digest,
      cellVerdict: cell.cellVerdict,
      corpus: cell.corpus,
    })),
    corpusDigest: input.corpusDigest,
    thresholdsDigest: input.thresholdsDigest,
  };
  return {
    ...projection,
    evaluationDigest: digest.sha256Hex(evaluationDigestProjectionOf(projection)),
  };
}

/** The targeted cells (the capstone's complete enumeration). */
export function evaluationCells(): readonly EvaluationCell[] {
  return targetedCells();
}

/** The committed declarations' digest (bound into the evaluation digest). */
export function declaredThresholdsDigest(digest: DigestPort): string {
  return digest.sha256Hex(evaluationCanonicalJson(DECLARED_THRESHOLDS));
}
