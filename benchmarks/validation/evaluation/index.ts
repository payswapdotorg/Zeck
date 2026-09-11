/**
 * The evaluation engine public barrel (VAL-008).
 *
 * Deterministic oracles, tolerance bands, rubric scoring with recorded
 * judge configuration, the mechanical error taxonomy, and the composed
 * run evaluation whose facts attach to validation run records.
 */

export {
  evaluateDeterministic,
  type ObservedOutcome,
  type OracleVerdict,
} from "./deterministic";
export {
  type EvaluationResult,
  evaluateRun,
  evaluationEventPayloads,
} from "./evaluate";
export {
  evaluateRubric,
  type JudgeConfiguration,
  type JudgeVerdict,
  type RubricEvaluation,
} from "./rubric";
export {
  classifyFailure,
  ERROR_FAMILIES,
  type ErrorClassification,
  type ErrorFamily,
  type FailureSignals,
} from "./taxonomy";
export {
  evaluateTolerance,
  type Measurement,
  parseToleranceBands,
  type ToleranceBand,
  type ToleranceVerdict,
} from "./tolerance";
