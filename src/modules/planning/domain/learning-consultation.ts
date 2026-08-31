/**
 * Learning consultation capture (planning module domain; WORK-014 /
 * INT-006, TOL-003; ADR-0005, `spec/architecture.md` §2.11/§19).
 *
 * THE PLANNING-SIDE READ SEAM OF LEARNING. When the planner is wired
 * with a learning signal source, it consults the LATEST versioned
 * scorecard signals for the task class and the admissible candidates'
 * route subjects, and records the consultation INSIDE the durable
 * planning decision — as EVIDENCE:
 *
 *  - the LIVE selection is computed BEFORE the consultation and is
 *    never changed by it (the pipeline order is the protection: task →
 *    policy → capabilities → deterministic sufficiency → candidates →
 *    selection → THEN the consultation capture — M1/M8: a learning
 *    score can never authorize a forbidden route and a shadow/learning
 *    preference can never change live routing);
 *  - `preferredStrategyId` records WHICH admissible candidate learning
 *    would prefer (highest success rate with adequate population and
 *    non-high uncertainty) — the recorded disagreement between the
 *    learning preference and the governed selection is exactly the
 *    INT-006 signal future governed adoption (WORK-020) would consume;
 *  - every consulted signal carries the FULL versioning basis (M13):
 *    scorecard id + version, aggregation definition id + version,
 *    telemetry schema version and the population window — an
 *    unversioned signal fails closed in `validateConsultedSignal`
 *    and never enters a durable decision record;
 *  - the signal class is pinned to the frozen non-authoritative class
 *    (LEARNING SIGNAL ≠ AUTHORIZATION — the §10 invariant).
 *
 * Deterministic-first is untouched (ADR-0007): the consultation records
 * learning's preference among ADMISSIBLE candidates only, and even a
 * unanimous learning preference can never make an inadmissible or
 * lower-preference-order candidate the live selection — selection
 * authority stays `selectStrategy`'s.
 *
 * This file is pure domain: no side effects, no learning module import
 * (the port/adapter seam lives in ports/adapters).
 */

import { PlatformError } from "../../../shared/errors";
import type { CandidateStrategy } from "./strategy";

/** The frozen non-authority class carried by consulted signals. */
export const CONSULTED_SIGNAL_CLASS = "non-authoritative-evidence-signal" as const;

/**
 * A learning signal as captured in a durable planning decision.
 * Consumer-side mirror of the learning module's public `LearningSignal`
 * (planning validates what it consumes — M13 is enforced HERE too).
 */
export interface ConsultedLearningSignal {
  readonly signalClass: typeof CONSULTED_SIGNAL_CLASS;
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly taskClass: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly meanCostMicroUsd: string;
  readonly meanLatencyMs: number;
  readonly uncertaintyLevel: string;
  readonly scorecardId: string;
  readonly scorecardVersion: number;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly telemetrySchemaVersion: number;
  readonly populationWindowFrom: string | null;
  readonly populationWindowTo: string;
  readonly evidenceRefs: readonly string[];
}

/** The consultation capture recorded on the planning decision. */
export interface LearningConsultation {
  readonly consulted: readonly ConsultedLearningSignal[];
  /** Learning's preference among ADMISSIBLE candidates (null: none). */
  readonly preferredStrategyId: string | null;
  /** Whether the learning preference agrees with the governed selection. */
  readonly agreesWithSelection: boolean;
  readonly consultedAt: string;
}

/** Uncertainty levels that disqualify a signal from informing a preference. */
const PREFERENCE_BLOCKING_UNCERTAINTY = "high";

/** Minimum population for a signal to inform a preference (frozen floor). */
export const PREFERENCE_MINIMUM_POPULATION = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted learning signal ${what} must be a non-empty string (M13 versioning basis)`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Fail-closed validation of a consulted signal (the M13 boundary on the
 * CONSUMER side): the full versioning basis must be present. An
 * unversioned signal is rejected — it never enters a decision record.
 */
export function validateConsultedSignal(value: unknown): asserts value is ConsultedLearningSignal {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted learning signal must be an object",
    });
  }
  const signal = value;
  if (signal.signalClass !== CONSULTED_SIGNAL_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted signal must carry the frozen non-authority class (a signal is never an authorization)",
      details: { expected: CONSULTED_SIGNAL_CLASS },
    });
  }
  for (const key of ["subjectKind", "subjectKey", "taskClass", "uncertaintyLevel"] as const) {
    requireString(signal, key, key);
  }
  for (const key of ["population", "meanLatencyMs"] as const) {
    const number = signal[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted learning signal ${key} must be a positive integer`,
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
      message:
        "consulted learning signal successCount must be a non-negative integer (0 is honest)",
      details: { field: "successCount" },
    });
  }
  for (const key of ["scorecardVersion", "definitionVersion", "telemetrySchemaVersion"] as const) {
    const version = signal[key];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted learning signal ${key} must be a positive integer (versioned scorecard basis, M13)`,
        details: { field: key },
      });
    }
  }
  for (const key of ["scorecardId", "definitionId", "populationWindowTo"] as const) {
    requireString(signal, key, key);
  }
  if (typeof signal.successRate !== "number" || signal.successRate < 0 || signal.successRate > 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted learning signal successRate must be in [0,1]",
    });
  }
  if (typeof signal.meanCostMicroUsd !== "string" || !/^\d{1,19}$/.test(signal.meanCostMicroUsd)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted learning signal meanCostMicroUsd must be an integer micro-USD string",
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
      message: "consulted learning signal evidenceRefs must be non-empty (M11)",
      details: { field: "evidenceRefs" },
    });
  }
}

/** Validate a full consultation capture (decision-record round-trip). */
export function validateLearningConsultation(
  value: unknown,
): asserts value is LearningConsultation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning consultation must be an object",
    });
  }
  const consultation = value;
  const consulted = consultation.consulted;
  if (!Array.isArray(consulted)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning consultation consulted must be an array (may be empty)",
    });
  }
  for (const signal of consulted) {
    validateConsultedSignal(signal);
  }
  if (
    consultation.preferredStrategyId !== null &&
    (typeof consultation.preferredStrategyId !== "string" ||
      consultation.preferredStrategyId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning consultation preferredStrategyId must be a non-empty string or null",
    });
  }
  if (typeof consultation.agreesWithSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learning consultation agreesWithSelection must be a boolean",
    });
  }
  requireString(consultation, "consultedAt", "consultedAt");
}

/**
 * Learning's preference among ADMISSIBLE candidates (pure, recorded as
 * evidence — never applied to the live selection).
 *
 * A candidate qualifies when at least one of its route subjects has a
 * consulted signal with population >= PREFERENCE_MINIMUM_POPULATION and
 * uncertainty level below `high`. The preferred candidate is the one
 * whose BEST qualifying signal has the highest success rate; ties break
 * on the candidate's position in the input order (deterministic).
 * Inadmissible candidates NEVER qualify (M1: a learning score cannot
 * authorize a forbidden route).
 */
export function learningPreferredCandidateId(
  candidates: readonly CandidateStrategy[],
  signals: readonly ConsultedLearningSignal[],
): string | null {
  let preferredStrategyId: string | null = null;
  let preferredRate = -1;
  for (const candidate of candidates) {
    if (!candidate.admissible) {
      continue;
    }
    const routeSubjects = candidate.plan.steps
      .map((step) =>
        step.routeRef === undefined ? null : `${step.routeRef.provider}/${step.routeRef.model}`,
      )
      .filter((subject): subject is string => subject !== null);
    const qualifying = signals.filter(
      (signal) =>
        routeSubjects.includes(signal.subjectKey) &&
        signal.population >= PREFERENCE_MINIMUM_POPULATION &&
        signal.uncertaintyLevel !== PREFERENCE_BLOCKING_UNCERTAINTY,
    );
    if (qualifying.length === 0) {
      continue;
    }
    const bestRate = Math.max(...qualifying.map((signal) => signal.successRate));
    if (bestRate > preferredRate) {
      preferredRate = bestRate;
      preferredStrategyId = candidate.strategyId;
    }
  }
  return preferredStrategyId;
}

/** Build the consultation capture (validating every signal again). */
export function buildLearningConsultation(input: {
  readonly candidates: readonly CandidateStrategy[];
  readonly signals: readonly ConsultedLearningSignal[];
  readonly selectedStrategyId: string;
  readonly consultedAt: string;
}): LearningConsultation {
  for (const signal of input.signals) {
    validateConsultedSignal(signal);
  }
  const preferredStrategyId = learningPreferredCandidateId(input.candidates, input.signals);
  return {
    consulted: input.signals.map((signal) => ({ ...signal })),
    preferredStrategyId,
    agreesWithSelection: preferredStrategyId === input.selectedStrategyId,
    consultedAt: input.consultedAt,
  };
}
