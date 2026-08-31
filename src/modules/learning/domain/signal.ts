/**
 * Planning-consumable learning signals (learning module domain; WORK-014 /
 * INT-006, TOL-003; `spec/architecture.md` §2.11 "Learning improves
 * decisions; it never silently rewrites authority").
 *
 * A `LearningSignal` is what crosses the learning → planning READ seam.
 * It is a VERSIONED, non-authoritative projection of ONE scorecard entry:
 *
 * ```text
 *   LEARNING SIGNAL  ≠  AUTHORIZATION   (the §10 invariant, frozen)
 * ```
 *
 * A learned score such as "route X has 94% success" MUST NEVER imply
 * "route X is therefore permitted". The signal carries a machine-readable
 * non-authority class; the planner records signals as consultation
 * EVIDENCE and remains the sole planning decision authority (the
 * deterministic-first preference, policy admissibility and cheap-first
 * cascade are untouched — see the planning-side consultation capture and
 * the M1/M8 discrimination red-records).
 *
 * Every signal identifies its FULL versioning basis (M13): the scorecard
 * id + version, the aggregation definition id + version, the telemetry
 * schema version and the evidence population window. A planner consumer
 * can always answer "which scorecard version / aggregation definition /
 * telemetry schema / evidence population produced this signal" — an
 * unversioned signal is rejected by `validateLearningSignal` (fail
 * closed, never silently consumed).
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";

/** Machine-readable non-authority class carried by every signal. */
export const LEARNING_SIGNAL_CLASS = "non-authoritative-evidence-signal" as const;

/** The signal schema version. */
export const LEARNING_SIGNAL_SCHEMA_VERSION = 1;

export interface LearningSignal {
  /** Frozen non-authority marker (§10 — "signal", never "authorization"). */
  readonly signalClass: typeof LEARNING_SIGNAL_CLASS;
  readonly subjectKind: string;
  /** Opaque neutral subject key (e.g. "providerA/modelB"). */
  readonly subjectKey: string;
  readonly taskClass: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly verificationPassRate: number | null;
  readonly meanCostMicroUsd: string;
  readonly meanLatencyMs: number;
  readonly uncertaintyLevel: string;
  readonly uncertaintyReasonCode: string;
  /** Full versioning basis (M13). */
  readonly scorecardId: string;
  readonly scorecardVersion: number;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly telemetrySchemaVersion: number;
  readonly populationWindowFrom: string | null;
  readonly populationWindowTo: string;
  /** Evidence references backing the signal (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
  readonly signalSchemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `learning signal ${key} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Fail-closed validation of a learning signal (the M13 boundary on the
 * consumer side): the signal must carry the frozen non-authority class,
 * the full versioning basis and non-empty evidence references. A signal
 * without version anchors is REJECTED, never consumed.
 */
export function validateLearningSignal(value: unknown): asserts value is LearningSignal {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal must be an object",
    });
  }
  const signal = value;
  if (signal.signalClass !== LEARNING_SIGNAL_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learning signal must carry the frozen non-authority class (a signal is never an authorization)",
      details: { expected: LEARNING_SIGNAL_CLASS, got: signal.signalClass },
    });
  }
  for (const key of [
    "subjectKind",
    "subjectKey",
    "taskClass",
    "scorecardId",
    "definitionId",
    "populationWindowTo",
    "uncertaintyLevel",
    "uncertaintyReasonCode",
  ] as const) {
    requireString(signal, key);
  }
  for (const key of [
    "population",
    "meanLatencyMs",
    "scorecardVersion",
    "definitionVersion",
    "telemetrySchemaVersion",
    "signalSchemaVersion",
  ] as const) {
    const number = signal[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `learning signal ${key} must be a positive integer (version/population anchors, M13)`,
        details: { field: key },
      });
    }
  }
  if (
    typeof signal.successCount !== "number" ||
    !Number.isInteger(signal.successCount) ||
    signal.successCount < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal successCount must be a non-negative integer (0 is honest)",
      details: { field: "successCount" },
    });
  }
  if (typeof signal.successRate !== "number" || signal.successRate < 0 || signal.successRate > 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal successRate must be in [0,1]",
    });
  }
  if (
    signal.verificationPassRate !== null &&
    (typeof signal.verificationPassRate !== "number" ||
      signal.verificationPassRate < 0 ||
      signal.verificationPassRate > 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal verificationPassRate must be in [0,1] or null",
    });
  }
  if (typeof signal.meanCostMicroUsd !== "string" || !/^\d{1,19}$/.test(signal.meanCostMicroUsd)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal meanCostMicroUsd must be an integer micro-USD string",
    });
  }
  const evidenceRefs = signal.evidenceRefs;
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length === 0 ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal evidenceRefs must be non-empty (M11)",
      details: { field: "evidenceRefs" },
    });
  }
  if (signal.signalSchemaVersion !== LEARNING_SIGNAL_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning signal schema version must match the frozen signal schema",
      details: { expected: LEARNING_SIGNAL_SCHEMA_VERSION },
    });
  }
}

/** Project one scorecard entry into a learning signal (pure). */
export function signalFromScorecardEntry(
  entry: {
    readonly subjectKind: string;
    readonly subjectKey: string;
    readonly taskClass: string;
    readonly population: number;
    readonly successCount: number;
    readonly successRate: number;
    readonly verificationPassRate: number | null;
    readonly meanCostMicroUsd: string;
    readonly meanLatencyMs: number;
    readonly uncertainty: { readonly level: string; readonly reasonCode: string };
    readonly evidenceRefs: readonly string[];
  },
  basis: {
    readonly scorecardId: string;
    readonly scorecardVersion: number;
    readonly definitionId: string;
    readonly definitionVersion: number;
    readonly telemetrySchemaVersion: number;
    readonly populationWindowFrom: string | null;
    readonly populationWindowTo: string;
  },
): LearningSignal {
  const signal: LearningSignal = {
    signalClass: LEARNING_SIGNAL_CLASS,
    subjectKind: entry.subjectKind,
    subjectKey: entry.subjectKey,
    taskClass: entry.taskClass,
    population: entry.population,
    successCount: entry.successCount,
    successRate: entry.successRate,
    verificationPassRate: entry.verificationPassRate,
    meanCostMicroUsd: entry.meanCostMicroUsd,
    meanLatencyMs: entry.meanLatencyMs,
    uncertaintyLevel: entry.uncertainty.level,
    uncertaintyReasonCode: entry.uncertainty.reasonCode,
    scorecardId: basis.scorecardId,
    scorecardVersion: basis.scorecardVersion,
    definitionId: basis.definitionId,
    definitionVersion: basis.definitionVersion,
    telemetrySchemaVersion: basis.telemetrySchemaVersion,
    populationWindowFrom: basis.populationWindowFrom,
    populationWindowTo: basis.populationWindowTo,
    evidenceRefs: [...entry.evidenceRefs],
    signalSchemaVersion: LEARNING_SIGNAL_SCHEMA_VERSION,
  };
  validateLearningSignal(signal);
  return signal;
}
