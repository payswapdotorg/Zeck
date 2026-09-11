/**
 * Deterministic evaluation (VAL-008, acceptance criterion 1).
 *
 * Executes the corpus oracles EXACTLY: the expected terminal status,
 * verification outcome, response-shape fields, containsText assertions
 * and expected environment effects are checked mechanically against
 * the observed outcome of a run. No judgment, no leniency — a missed
 * oracle is a failed evaluation.
 */

import type { GoldenTask } from "../corpus/schema";

/** The observed outcome of one run (derived from harness/recorder facts). */
export interface ObservedOutcome {
  readonly terminalStatus: string | null;
  readonly verificationStatuses: readonly string[];
  /** The response text, when the run produced one (null otherwise). */
  readonly responseText: string | null;
  /** Fields present in the structured output artifact (when produced). */
  readonly outputShapeFields: readonly string[];
  /** Observed environment effects (kind + assertion + decided verdict). */
  readonly environmentEffects: readonly {
    readonly kind: string;
    readonly assertion: string;
    readonly passed: boolean;
  }[];
  /** Retryable errors surfaced during the run. */
  readonly retryableErrorsSurfaced: number;
}

/** One oracle check verdict. */
export interface OracleVerdict {
  readonly oracle: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Evaluate the deterministic oracles of one corpus task. */
export function evaluateDeterministic(
  task: GoldenTask,
  observed: ObservedOutcome,
): readonly OracleVerdict[] {
  const verdicts: OracleVerdict[] = [];
  const expected = task.expectedOutcome;

  const terminalPassed = observed.terminalStatus === expected.terminalStatus;
  verdicts.push({
    oracle: "terminal-status",
    passed: terminalPassed,
    detail: `expected ${expected.terminalStatus}, observed ${observed.terminalStatus ?? "TIMEOUT"}`,
  });

  if (expected.verification !== undefined) {
    const verificationPassed = observed.verificationStatuses.includes(expected.verification);
    verdicts.push({
      oracle: "verification",
      passed: verificationPassed,
      detail: `expected ${expected.verification} among [${observed.verificationStatuses.join(", ") || "none"}]`,
    });
  }

  for (const field of expected.outputShape ?? []) {
    const fieldPassed = observed.outputShapeFields.includes(field);
    verdicts.push({
      oracle: `output-shape:${field}`,
      passed: fieldPassed,
      detail: fieldPassed ? "present" : "missing from the output artifact",
    });
  }

  for (const needle of expected.containsText ?? []) {
    const textPassed =
      observed.responseText !== null &&
      observed.responseText.toLowerCase().includes(needle.toLowerCase());
    verdicts.push({
      oracle: `contains-text:${needle}`,
      passed: textPassed,
      detail: textPassed ? "present in the response" : "absent from the response",
    });
  }

  for (const effect of task.expectedEnvironmentEffects ?? []) {
    const effectObserved = observed.environmentEffects.some(
      (candidate) => candidate.kind === effect.kind && candidate.passed,
    );
    verdicts.push({
      oracle: `environment-effect:${effect.kind}`,
      passed: effectObserved,
      detail: effectObserved
        ? effect.assertion
        : `expected effect not observed: ${effect.assertion}`,
    });
  }

  return verdicts;
}
