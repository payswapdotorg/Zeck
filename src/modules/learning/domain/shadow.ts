/**
 * Shadow evaluation model (learning module domain; WORK-014 / INT-006,
 * ADR-0008/ADR-0009; `spec/architecture.md` §2.11).
 *
 * SHADOW MEANS SHADOW. A `ShadowEvaluationRecord` is the durable, honest
 * answer to:
 *
 * ```text
 *   proposed strategy
 *     → evaluated against EXISTING evidence (a versioned scorecard)
 *     → scored + compared against a baseline (uncertainty preserved)
 *     → recorded as a SIGNAL
 * ```
 *
 * WITHOUT any live effect. The evaluation consumes ONLY an immutable
 * scorecard (already-computed aggregates over past telemetry). The shadow
 * evaluator has NO ports that can dispatch work, mutate policy, budgets,
 * capabilities, executions or routing (M7/M8: the wiring is
 * unrepresentable — see application/shadow-evaluator.ts whose deps are
 * store + digest + clock ONLY, and tests/discrimination/ learning tests
 * that prove a mutated wiring is detected).
 *
 * A SHADOW RESULT IS NOT A PRODUCTION RESULT (M15): the record class is
 * `shadow` — CHECK-bound in migration 0009 and distinct at the type
 * level. It is never readable as a verification result, an execution
 * outcome or a planning decision input; it is learning evidence for
 * future governed adoption (which re-enters the normal policy /
 * capability / budget / verification gates — LRN-002/WORK-020 own the
 * policy-side discrimination).
 *
 * UNCERTAINTY IS NOT COLLAPSED (§13): when the two scores' honest
 * uncertainty overlaps (their [rate - spread, rate + spread] intervals
 * intersect), the comparison verdict is `inconclusive`, never a forced
 * winner. A shadow verdict also records the population basis — tiny
 * populations are reported as such, never amplified into confidence.
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { Scorecard, ScorecardEntry, UncertaintyLevel } from "./scorecard";

/** The record class vocabulary — shadow rows are shadow rows (M15). */
export const SHADOW_RECORD_CLASSES = ["shadow"] as const;
export type ShadowRecordClass = (typeof SHADOW_RECORD_CLASSES)[number];

/** Statuses a shadow evaluation can honestly terminate in. */
export const SHADOW_EVALUATION_STATUSES = [
  "scored",
  "insufficient-evidence",
  "incompatible-schema",
  "no-baseline",
] as const;
export type ShadowEvaluationStatus = (typeof SHADOW_EVALUATION_STATUSES)[number];

export function isShadowEvaluationStatus(value: string): value is ShadowEvaluationStatus {
  return (SHADOW_EVALUATION_STATUSES as readonly string[]).includes(value);
}

/** A strategy under shadow evaluation — identity + neutral description. */
export interface ShadowStrategyDescription {
  /** Stable strategy identity (opaque string, caller-assigned). */
  readonly strategyIdentity: string;
  /** sha256 content digest of the strategy description (integrity). */
  readonly descriptionDigest: string;
  /** Task class the strategy targets. */
  readonly taskClass: string;
  /** Route subjects the strategy would use (neutral provider/model keys). */
  readonly routeSubjects: readonly string[];
  /** Tool subjects the strategy would use. */
  readonly toolSubjects: readonly string[];
  /** Declared expectations (recorded, never used as authority). */
  readonly expectedCostMicroUsd?: string;
  readonly expectedQuality?: number;
  readonly expectedLatencyMs?: number;
}

/** The evaluation basis: the EXACT scorecard version consulted. */
export type ShadowEvaluationBasis =
  | {
      readonly kind: "scorecard";
      readonly scorecardId: string;
      readonly scorecardVersion: number;
      readonly definitionId: string;
      readonly definitionVersion: number;
      readonly telemetrySchemaVersion: number;
      readonly populationWindowFrom: string | null;
      readonly populationWindowTo: string;
    }
  | {
      /** Honest "no scorecard existed for the scope" basis. */
      readonly kind: "none";
    };

/** One subject's aggregate score extracted from the scorecard. */
export interface ShadowSubjectScore {
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly uncertainty: UncertaintyLevel;
  /** Honest 2-sigma spread on the success rate (never collapsed). */
  readonly spread: number;
}

export interface ShadowComparison {
  readonly preferred: "proposed" | "baseline" | "inconclusive";
  readonly uncertainty: UncertaintyLevel;
  readonly rationale: string;
}

/** The durable shadow evaluation record (migration 0009 shape). */
export interface ShadowEvaluationRecord {
  readonly shadowId: string;
  readonly recordClass: ShadowRecordClass;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly proposed: ShadowStrategyDescription;
  /** Baseline strategy being compared against (optional). */
  readonly baseline?: ShadowStrategyDescription;
  readonly evaluationBasis: ShadowEvaluationBasis;
  readonly proposedScores: readonly ShadowSubjectScore[];
  readonly baselineScores: readonly ShadowSubjectScore[];
  readonly comparison?: ShadowComparison;
  readonly status: ShadowEvaluationStatus;
  /** Sample of the scorecard entries' evidence refs (traceability). */
  readonly evidenceRefs: readonly string[];
  /** Sample of source executions behind the score (M10 traceability). */
  readonly sourceExecutionIds: readonly string[];
  readonly requestedBy: string;
  readonly cause?: string;
  readonly recordedAt: string;
  readonly schemaVersion: number;
}

/** Frozen shadow-record schema version. */
export const SHADOW_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `shadow ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

function validateStrategyDescription(
  value: unknown,
  what: string,
): asserts value is ShadowStrategyDescription {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `shadow ${what} must be an object`,
    });
  }
  const strategy = value;
  requireString(strategy, "strategyIdentity", `${what} strategyIdentity`);
  requireString(strategy, "descriptionDigest", `${what} descriptionDigest`);
  requireString(strategy, "taskClass", `${what} taskClass`);
  for (const key of ["routeSubjects", "toolSubjects"] as const) {
    const subjects = strategy[key];
    if (
      !Array.isArray(subjects) ||
      subjects.some((subject) => typeof subject !== "string" || subject.length === 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `shadow ${what} ${key} must be an array of non-empty subject keys`,
        details: { field: key },
      });
    }
  }
  if (strategy.expectedCostMicroUsd !== undefined) {
    if (
      typeof strategy.expectedCostMicroUsd !== "string" ||
      !/^\d{1,19}$/.test(strategy.expectedCostMicroUsd)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `shadow ${what} expectedCostMicroUsd must be an integer micro-USD string`,
      });
    }
  }
  if (
    strategy.expectedQuality !== undefined &&
    (typeof strategy.expectedQuality !== "number" ||
      strategy.expectedQuality < 0 ||
      strategy.expectedQuality > 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `shadow ${what} expectedQuality must be in [0,1]`,
    });
  }
  if (
    strategy.expectedLatencyMs !== undefined &&
    (typeof strategy.expectedLatencyMs !== "number" || strategy.expectedLatencyMs < 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `shadow ${what} expectedLatencyMs must be non-negative`,
    });
  }
}

/** Extract the subject scores for a strategy from a scorecard (pure). */
export function scoreShadowSubjects(
  strategy: ShadowStrategyDescription,
  scorecard: Scorecard,
): readonly ShadowSubjectScore[] {
  const subjects = [...strategy.routeSubjects, ...strategy.toolSubjects];
  const scores: ShadowSubjectScore[] = [];
  for (const subjectKey of subjects) {
    const entry: ScorecardEntry | undefined = scorecard.entries.find(
      (candidate) =>
        candidate.subjectKey === subjectKey && candidate.taskClass === strategy.taskClass,
    );
    if (entry === undefined) {
      continue;
    }
    scores.push({
      subjectKind: entry.subjectKind,
      subjectKey: entry.subjectKey,
      population: entry.population,
      successCount: entry.successCount,
      successRate: entry.successRate,
      uncertainty: entry.uncertainty.level,
      spread: 2 * Math.sqrt(0.25 / entry.population),
    });
  }
  return scores;
}

/**
 * Compare two score sets HONESTLY. A winner exists ONLY when both sides
 * have evidence AND the success-rate intervals (rate ± 2-sigma spread)
 * do NOT overlap AND both populations are adequate. Overlap or missing
 * evidence ⇒ `inconclusive` (§13: uncertain evidence is never collapsed
 * into false certainty).
 */
export function compareShadowScores(
  proposed: readonly ShadowSubjectScore[],
  baseline: readonly ShadowSubjectScore[] | undefined,
): ShadowComparison | undefined {
  if (baseline === undefined || baseline.length === 0) {
    return undefined;
  }
  if (proposed.length === 0) {
    return {
      preferred: "inconclusive",
      uncertainty: "high",
      rationale: "the proposed strategy has no scored subject in the evaluation basis",
    };
  }
  const meanRate = (scores: readonly ShadowSubjectScore[]): number =>
    scores.reduce((sum, score) => sum + score.successRate, 0) / scores.length;
  const worstSpread = (scores: readonly ShadowSubjectScore[]): number =>
    scores.reduce((max, score) => Math.max(max, score.spread), 0);
  const worstUncertainty = (scores: readonly ShadowSubjectScore[]): UncertaintyLevel => {
    const rank: Record<UncertaintyLevel, number> = { low: 0, material: 1, high: 2 };
    return scores.reduce<UncertaintyLevel>(
      (worst, score) => (rank[score.uncertainty] > rank[worst] ? score.uncertainty : worst),
      "low",
    );
  };

  const proposedRate = meanRate(proposed);
  const baselineRate = meanRate(baseline);
  const overlap =
    Math.abs(proposedRate - baselineRate) <= worstSpread(proposed) + worstSpread(baseline);
  const uncertainty = worstUncertainty([...proposed, ...baseline]);

  if (overlap) {
    return {
      preferred: "inconclusive",
      uncertainty,
      rationale:
        "the success-rate intervals of the proposed and baseline strategies overlap within honest 2-sigma spread — insufficient evidence to prefer either (uncertainty preserved, not collapsed)",
    };
  }
  if (proposedRate > baselineRate) {
    return {
      preferred: "proposed",
      uncertainty,
      rationale: `proposed mean success rate ${proposedRate.toFixed(3)} exceeds baseline ${baselineRate.toFixed(3)} with non-overlapping spread (shadow evidence only — never production authority)`,
    };
  }
  return {
    preferred: "baseline",
    uncertainty,
    rationale: `baseline mean success rate ${baselineRate.toFixed(3)} exceeds proposed ${proposedRate.toFixed(3)} with non-overlapping spread (shadow evidence only — never production authority)`,
  };
}

/** Closed-shape validation of a durable shadow record (store round-trip). */
export function validateShadowEvaluationRecord(
  value: unknown,
): asserts value is ShadowEvaluationRecord {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "shadow record must be an object" });
  }
  const record = value;
  requireString(record, "shadowId", "shadowId");
  // M15: the record class is pinned to "shadow" — a speculative result
  // presented as a production outcome is unrepresentable.
  if (record.recordClass !== "shadow") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "shadow record class must be 'shadow' (M15: speculative results are never production outcomes)",
      details: { got: record.recordClass },
    });
  }
  requireString(record, "applicationId", "applicationId");
  requireString(record, "tenantId", "tenantId");
  validateStrategyDescription(record.proposed, "proposed");
  if (record.baseline !== undefined) {
    validateStrategyDescription(record.baseline, "baseline");
  }
  const basis = record.evaluationBasis;
  if (!isRecord(basis)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "shadow evaluationBasis must record the exact scorecard version consulted (M13)",
    });
  }
  if (basis.kind === "none") {
    if (record.status !== "insufficient-evidence") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "a shadow evaluation with a 'none' basis can only be insufficient-evidence",
      });
    }
  } else {
    if (basis.kind !== "scorecard") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "shadow evaluationBasis kind must be 'scorecard' or 'none'",
      });
    }
    requireString(basis, "scorecardId", "evaluationBasis scorecardId");
    requireString(basis, "definitionId", "evaluationBasis definitionId");
    for (const key of [
      "scorecardVersion",
      "definitionVersion",
      "telemetrySchemaVersion",
    ] as const) {
      const version = basis[key];
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `shadow evaluationBasis ${key} must be a positive integer (versioned basis, M13)`,
          details: { field: key },
        });
      }
    }
    if (typeof basis.populationWindowTo !== "string" || basis.populationWindowTo.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "shadow evaluationBasis populationWindowTo must be a non-empty timestamp",
      });
    }
  }
  const status = record.status;
  if (typeof status !== "string" || !isShadowEvaluationStatus(status)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "shadow status must be the honest status vocabulary",
      details: { allowed: SHADOW_EVALUATION_STATUSES },
    });
  }
  for (const key of [
    "proposedScores",
    "baselineScores",
    "evidenceRefs",
    "sourceExecutionIds",
  ] as const) {
    if (!Array.isArray(record[key])) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `shadow ${key} must be an array`,
        details: { field: key },
      });
    }
  }
  requireString(record, "requestedBy", "requestedBy");
  requireString(record, "recordedAt", "recordedAt");
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || schemaVersion !== SHADOW_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "shadow schemaVersion must match the frozen shadow record schema",
      details: { expected: SHADOW_SCHEMA_VERSION },
    });
  }
}
