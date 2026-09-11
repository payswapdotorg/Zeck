/**
 * The evaluation engine entrypoint (VAL-008, acceptance criterion 5).
 *
 * Composes the deterministic oracles, tolerance bands and rubric
 * scoring into one evaluation result per corpus task, applies the
 * task's evaluation method, classifies failures mechanically through
 * the error taxonomy, and emits evaluation facts that attach to
 * validation run records (the recorder absorbs them as trajectory
 * events).
 */

import type { GoldenTask } from "../corpus/schema";
import { evaluateDeterministic, type ObservedOutcome, type OracleVerdict } from "./deterministic";
import {
  evaluateRubric,
  type JudgeConfiguration,
  type JudgeVerdict,
  type RubricEvaluation,
} from "./rubric";
import { classifyFailure, type ErrorClassification, type FailureSignals } from "./taxonomy";
import {
  evaluateTolerance,
  type Measurement,
  parseToleranceBands,
  type ToleranceVerdict,
} from "./tolerance";

/** The composed evaluation of one corpus task against one observed run. */
export interface EvaluationResult {
  readonly taskId: string;
  readonly corpusVersion: string;
  readonly method: "deterministic" | "tolerance" | "evaluator";
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly oracles: readonly OracleVerdict[];
  readonly tolerances: readonly ToleranceVerdict[];
  readonly rubric: RubricEvaluation | null;
  readonly classifications: readonly ErrorClassification[];
}

/**
 * Evaluate one observed run against its corpus task.
 *
 * - deterministic tasks: the oracles decide (all pass = pass).
 * - tolerance tasks: the parsed bands decide; unparsed statements or
 *   unmatched measurements make the verdict INCONCLUSIVE (honest —
 *   never a silent pass).
 * - evaluator tasks: the rubric score against its threshold decides
 *   (the deterministic oracles still run and report).
 * Failures classify through the mechanical taxonomy.
 */
export function evaluateRun(input: {
  readonly task: GoldenTask;
  readonly corpusVersion: string;
  readonly observed: ObservedOutcome;
  readonly measurements?: readonly Measurement[];
  readonly judge?: {
    readonly configuration: JudgeConfiguration;
    readonly verdicts: readonly JudgeVerdict[];
    readonly threshold: number;
  };
}): EvaluationResult {
  const { task, observed } = input;
  const oracles = evaluateDeterministic(task, observed);
  const toleranceVerdicts =
    task.evaluation.method === "tolerance"
      ? evaluateTolerance(
          parseToleranceBands(task.evaluation.tolerance ?? ""),
          input.measurements ?? [],
        )
      : [];
  const rubric =
    task.evaluation.method === "evaluator" && input.judge !== undefined
      ? evaluateRubric(
          task.qualityRubric,
          input.judge.verdicts,
          input.judge.configuration,
          input.judge.threshold,
        )
      : null;

  let verdict: EvaluationResult["verdict"];
  const oracleFloor = oracles.every((oracle) => oracle.passed);
  if (!oracleFloor) {
    // The deterministic oracles are the floor for EVERY method: a failed
    // oracle (terminal status, verification, shape, containsText, effect)
    // fails the evaluation regardless of the rubric or tolerance outcome.
    verdict = "fail";
  } else if (task.evaluation.method === "deterministic") {
    verdict = "pass";
  } else if (task.evaluation.method === "tolerance") {
    const bands = parseToleranceBands(task.evaluation.tolerance ?? "");
    if (bands.length === 0 || toleranceVerdicts.some((v) => v.measurement === null)) {
      verdict = "inconclusive";
    } else {
      verdict = toleranceVerdicts.every((v) => v.passed) ? "pass" : "fail";
    }
  } else {
    verdict = rubric !== null ? (rubric.passed ? "pass" : "fail") : "inconclusive";
  }

  const signals: FailureSignals = {
    terminalStatus: observed.terminalStatus,
    failedAssertions: oracles.filter((oracle) => !oracle.passed).map((oracle) => oracle.oracle),
    surfacedErrorCodes: [],
    failedEnvironmentEffects: (task.expectedEnvironmentEffects ?? [])
      .filter(
        (effect) =>
          !observed.environmentEffects.some(
            (candidate) => candidate.kind === effect.kind && candidate.passed,
          ),
      )
      .map((effect) => effect.assertion),
  };
  const classifications = verdict === "pass" ? [] : classifyFailure(signals);

  return {
    taskId: task.taskId,
    corpusVersion: input.corpusVersion,
    method: task.evaluation.method,
    verdict,
    oracles,
    tolerances: toleranceVerdicts,
    rubric,
    classifications,
  };
}

/**
 * Evaluation facts as trajectory-event payloads (criterion 5): the
 * recorder absorbs these to attach scoring results to run records.
 */
export function evaluationEventPayloads(
  result: EvaluationResult,
): readonly { kind: "verification" | "error-surfaced"; data: Record<string, unknown> }[] {
  const events: {
    kind: "verification" | "error-surfaced";
    data: Record<string, unknown>;
  }[] = [];
  events.push({
    kind: "verification",
    data: {
      status:
        result.verdict === "pass" ? "PASS" : result.verdict === "fail" ? "FAIL" : "INCONCLUSIVE",
      strategy: `evaluation-engine:${result.method}`,
      taskId: result.taskId,
      corpusVersion: result.corpusVersion,
      oracleCount: result.oracles.length,
      failedOracles: result.oracles.filter((o) => !o.passed).map((o) => o.oracle),
    },
  });
  if (result.rubric !== null) {
    events.push({
      kind: "verification",
      data: {
        status: result.rubric.passed ? "PASS" : "FAIL",
        strategy: "evaluation-engine:rubric",
        score: result.rubric.score,
        threshold: result.rubric.threshold,
        judge: result.rubric.judge.judgeId,
        judgeConfiguration: result.rubric.judge.configurationDigest,
      },
    });
  }
  for (const classification of result.classifications) {
    events.push({
      kind: "error-surfaced",
      data: {
        code: classification.family,
        retryable: false,
        message: classification.evidence,
        dispatchRule: classification.dispatchRule,
      },
    });
  }
  return events;
}
