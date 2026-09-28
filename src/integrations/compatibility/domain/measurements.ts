/**
 * The reusable measurement schema (PPR-018A scope item 6) — the common
 * vocabulary EVERY application work order (PPR-018..027) measures its
 * proof with, so portfolio-level comparison (PPR-027) reads ONE schema
 * instead of ten ad-hoc ones.
 *
 * COVERAGE IS THE CONTRACT: the schema's dimensions are exactly the
 * program's portfolio-level measures (docs/APPLICATION-COMPATIBILITY-
 * PROOF-PROGRAM.md §"Portfolio-level measures" + the Tech-Lead
 * handoff §10), all thirteen:
 *
 *   1. outcome-success            — outcome success;
 *   2. quality-verification       — quality/verification result;
 *   3. latency-tail               — latency and tail latency;
 *   4. usage-cost                 — usage and cost;
 *   5. failure-retry              — failure/retry counts;
 *   6. determinism-reuse          — deterministic/reuse/verified-
 *                                   computation opportunities;
 *   7. provider-portability       — provider portability/change effort;
 *   8. customization-coverage     — customization coverage;
 *   9. engineering-surface-removed — engineering surface removed;
 *  10. capability-discovery-avoidance — capability-discovery-driven
 *                                   avoided implementation;
 *  11. telemetry-explainability   — telemetry/explainability
 *                                   completeness;
 *  12. diagnosis-recovery         — diagnosis/recovery time;
 *  13. reproducibility           — reproducibility.
 *
 * HONESTY IS THE OTHER CONTRACT: every dimension carries an explicit
 * basis — `measured`, `estimated` or `not-measured` — and a verbatim
 * statement with units and caveats. A missing dimension is a NAMED
 * validation defect (never silently absent); an unmeasured dimension
 * is honest (`not-measured` + why). Nothing here computes marketing
 * claims: no ranking, no winner, no scenario-derived percentage
 * (the program's rule).
 *
 * Pure and total: no environment, no clock, no I/O.
 */

/** The thirteen measurement dimensions (frozen order; the program's own list). */
export const MEASUREMENT_DIMENSIONS = [
  "outcome-success",
  "quality-verification",
  "latency-tail",
  "usage-cost",
  "failure-retry",
  "determinism-reuse",
  "provider-portability",
  "customization-coverage",
  "engineering-surface-removed",
  "capability-discovery-avoidance",
  "telemetry-explainability",
  "diagnosis-recovery",
  "reproducibility",
] as const;

export type MeasurementDimension = (typeof MEASUREMENT_DIMENSIONS)[number];

/** Is a value one of the thirteen dimensions? */
export function isMeasurementDimension(value: unknown): value is MeasurementDimension {
  return typeof value === "string" && (MEASUREMENT_DIMENSIONS as readonly string[]).includes(value);
}

/** The honest basis vocabulary — never a fabricated number. */
export const MEASUREMENT_BASES = ["measured", "estimated", "not-measured"] as const;
export type MeasurementBasis = (typeof MEASUREMENT_BASES)[number];

export function isMeasurementBasis(value: unknown): value is MeasurementBasis {
  return typeof value === "string" && (MEASUREMENT_BASES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The per-dimension fact payloads
// ---------------------------------------------------------------------------

/** Dimension 1 — outcome success: how many runs resolved the task. */
export interface OutcomeSuccessMeasurement {
  readonly dimension: "outcome-success";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly notRun: number;
}

/** Dimension 2 — quality/verification result (the task's own checks + Zeck verification). */
export interface QualityVerificationMeasurement {
  readonly dimension: "quality-verification";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  /** Task-level success checks that passed (the corpus's own definition). */
  readonly taskChecksPassed: number | null;
  readonly taskChecksTotal: number | null;
  /** Zeck verification results backing the delegated executions (PASS/total). */
  readonly zeckVerificationsPassed: number | null;
  readonly zeckVerificationsTotal: number | null;
}

/** Dimension 3 — latency and tail latency (milliseconds; deterministic percentiles). */
export interface LatencyTailMeasurement {
  readonly dimension: "latency-tail";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  /** The raw successful-outcome latency samples (ms), in run order. */
  readonly samplesMs: readonly number[];
  readonly sampleCount: number;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
}

/** Dimension 4 — usage and cost (integer micro-USD strings; the platform money convention). */
export interface UsageCostMeasurement {
  readonly dimension: "usage-cost";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalCostMicroUsd: string | null;
  /** Cost per SUCCESSFULLY resolved outcome (the program's economics rule). */
  readonly costPerSuccessMicroUsd: string | null;
}

/** Dimension 5 — failure/retry counts. */
export interface FailureRetryMeasurement {
  readonly dimension: "failure-retry";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly failureCount: number | null;
  readonly retryCount: number | null;
  readonly duplicateCount: number | null;
  readonly timeoutCount: number | null;
}

/** Dimension 6 — deterministic/reuse/verified-computation opportunities. */
export interface DeterminismReuseMeasurement {
  readonly dimension: "determinism-reuse";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly deterministicExecutionCount: number | null;
  readonly reuseCount: number | null;
  readonly verifiedComputationSubstitutions: number | null;
}

/** Dimension 7 — provider portability / change effort. */
export interface ProviderPortabilityMeasurement {
  readonly dimension: "provider-portability";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  /** Provider switch time observed (ms), when measured. */
  readonly providerSwitchTimeMs: number | null;
  /** Changed application code surface (files), when measured. */
  readonly changedApplicationFiles: number | null;
  readonly regressionCount: number | null;
}

/** Dimension 8 — customization coverage (what the application could still tune). */
export interface CustomizationCoverageMeasurement {
  readonly dimension: "customization-coverage";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly customizationAxesRetained: number | null;
  readonly customizationAxesTotal: number | null;
}

/** Dimension 9 — engineering surface removed (lines/files of provider plumbing erased). */
export interface EngineeringSurfaceMeasurement {
  readonly dimension: "engineering-surface-removed";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly removedFiles: number | null;
  readonly removedLines: number | null;
}

/** Dimension 10 — capability-discovery-driven avoided implementation. */
export interface CapabilityDiscoveryMeasurement {
  readonly dimension: "capability-discovery-avoidance";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly capabilitiesAdoptedFromZeck: number | null;
  readonly avoidedBespokeImplementations: number | null;
}

/** Dimension 11 — telemetry/explainability completeness. */
export interface TelemetryExplainabilityMeasurement {
  readonly dimension: "telemetry-explainability";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  /** Executions whose records reconstruct plan/route/usage/cost/verification end-to-end. */
  readonly reconstructibleExecutions: number | null;
  readonly executionsTotal: number | null;
}

/** Dimension 12 — diagnosis/recovery time (ms), when exercised. */
export interface DiagnosisRecoveryMeasurement {
  readonly dimension: "diagnosis-recovery";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly diagnosisTimeMs: number | null;
  readonly recoveryTimeMs: number | null;
  readonly incidentsExercised: number | null;
}

/** Dimension 13 — reproducibility (re-run agreement). */
export interface ReproducibilityMeasurement {
  readonly dimension: "reproducibility";
  readonly basis: MeasurementBasis;
  readonly statement: string;
  readonly rerunsAttempted: number | null;
  readonly rerunsAgreed: number | null;
}

/** One measurement entry — the discriminated union over the thirteen dimensions. */
export type MeasurementEntry =
  | OutcomeSuccessMeasurement
  | QualityVerificationMeasurement
  | LatencyTailMeasurement
  | UsageCostMeasurement
  | FailureRetryMeasurement
  | DeterminismReuseMeasurement
  | ProviderPortabilityMeasurement
  | CustomizationCoverageMeasurement
  | EngineeringSurfaceMeasurement
  | CapabilityDiscoveryMeasurement
  | TelemetryExplainabilityMeasurement
  | DiagnosisRecoveryMeasurement
  | ReproducibilityMeasurement;

/** A complete measurement set: EVERY dimension present exactly once. */
export interface MeasurementSet {
  readonly entries: readonly MeasurementEntry[];
}

/** A named measurement validation issue (fail-closed, machine-readable). */
export interface MeasurementIssue {
  readonly dimension: string;
  readonly issue: string;
}

/** Validate one measurement entry's shape (basis + mandatory verbatim statement). */
export function validateMeasurementEntry(entry: unknown): readonly MeasurementIssue[] {
  if (typeof entry !== "object" || entry === null) {
    return [{ dimension: "(missing)", issue: "measurement entry must be an object" }];
  }
  const record = entry as Record<string, unknown>;
  const dimension = typeof record.dimension === "string" ? record.dimension : "(missing)";
  if (!isMeasurementDimension(record.dimension)) {
    return [
      { dimension, issue: "measurement dimension must be one of the thirteen schema dimensions" },
    ];
  }
  const issues: MeasurementIssue[] = [];
  if (!isMeasurementBasis(record.basis)) {
    issues.push({
      dimension,
      issue: "measurement basis must be measured | estimated | not-measured",
    });
  }
  if (typeof record.statement !== "string" || record.statement.trim().length === 0) {
    issues.push({
      dimension,
      issue: "every measurement carries a verbatim statement (units and caveats included)",
    });
  }
  if (
    record.basis === "not-measured" &&
    typeof record.statement === "string" &&
    record.statement.trim().length > 0 &&
    !/not[- ]measured|unavailable|not yet|no .*recorded|not exercised/i.test(record.statement)
  ) {
    issues.push({
      dimension,
      issue:
        "a not-measured entry's statement must say why it is not measured (the honest unavailability), never imply a value",
    });
  }
  return issues;
}

/**
 * Validate a whole measurement set: every one of the THIRTEEN dimensions
 * present exactly once, every entry structurally valid. A missing
 * dimension is a NAMED defect — the schema's coverage contract.
 */
export function validateMeasurementSet(set: unknown): readonly MeasurementIssue[] {
  if (
    typeof set !== "object" ||
    set === null ||
    !Array.isArray((set as { entries?: unknown }).entries)
  ) {
    return [{ dimension: "(set)", issue: "measurement set must carry an entries array" }];
  }
  const entries = (set as { entries: unknown[] }).entries;
  const issues: MeasurementIssue[] = [];
  const byDimension = new Map<string, number>();
  for (const entry of entries) {
    issues.push(...validateMeasurementEntry(entry));
    const dimension = (entry as { dimension?: unknown })?.dimension;
    if (typeof dimension === "string") {
      byDimension.set(dimension, (byDimension.get(dimension) ?? 0) + 1);
    }
  }
  for (const dimension of MEASUREMENT_DIMENSIONS) {
    const count = byDimension.get(dimension) ?? 0;
    if (count === 0) {
      issues.push({
        dimension,
        issue:
          "the measurement set is MISSING this dimension — every proof measures (or honestly declines) all thirteen",
      });
    } else if (count > 1) {
      issues.push({ dimension, issue: `duplicate measurement entry (${count} present)` });
    }
  }
  return issues;
}

/** Which dimensions does the set honestly decline to measure? (transparency helper) */
export function notMeasuredDimensions(set: MeasurementSet): readonly MeasurementDimension[] {
  return set.entries
    .filter((entry) => entry.basis === "not-measured")
    .map((entry) => entry.dimension);
}

// ---------------------------------------------------------------------------
// Deterministic percentile helpers (one definition, no drift)
// ---------------------------------------------------------------------------

/**
 * The median of a sample set (pure, deterministic). Null when empty.
 * Definition: sort ascending; the middle element for odd counts, the
 * arithmetic mean of the two middle elements for even counts.
 */
export function medianOf(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return (left + right) / 2;
}

/**
 * The p-th percentile (0..100) of a sample set, nearest-rank method
 * (pure, deterministic). Null when empty or p out of range.
 * Definition: sort ascending; rank = ceil(p/100 * n); the rank-th
 * smallest sample (1-based). p50 via this method differs from
 * medianOf on even counts — prefer medianOf for the median.
 */
export function percentileOf(samples: readonly number[], p: number): number | null {
  if (samples.length === 0 || p <= 0 || p > 100 || !Number.isFinite(p)) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Build the latency-tail entry from raw samples (the one aggregation
 * every proof shares). All facts derived; the statement is verbatim
 * with units.
 */
export function latencyTailOf(
  samplesMs: readonly number[],
  basis: MeasurementBasis,
  statement: string,
): LatencyTailMeasurement {
  const max = samplesMs.length === 0 ? null : Math.max(...samplesMs);
  return {
    dimension: "latency-tail",
    basis,
    statement,
    samplesMs: [...samplesMs],
    sampleCount: samplesMs.length,
    medianMs: medianOf(samplesMs),
    p95Ms: percentileOf(samplesMs, 95),
    p99Ms: percentileOf(samplesMs, 99),
    maxMs: max,
  };
}
