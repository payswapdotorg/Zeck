/**
 * Model-judge evaluator adapter (verification module; WORK-013).
 *
 * Implements the `Evaluator` contract for `model-judged` criteria over
 * the provider-neutral `ModelJudge` port (the models module's gateway
 * sits behind that port — provider identity never enters here).
 *
 * THE provider-success ≠ verification-PASS boundary (VER-001, the
 * WORK-013 headline negative test):
 *
 *   - the judge's output is EVIDENCE assessed against the declared
 *     criteria — a raw provider success, an HTTP status or a bare
 *     "looks correct" string is NOT a judgment: the adapter requires a
 *     STRUCTURED judgment that binds the judged criterion id and
 *     carries an explicit `meetsCriteria` verdict;
 *   - a judgment that does not bind the criterion (M2: model
 *     self-certification) maps to INCONCLUSIVE — never PASS;
 *   - `meetsCriteria: "unknown"` maps to INCONCLUSIVE (model judges are
 *     not assumed infallible);
 *   - the judge's provider/model identity is recorded as EVIDENCE
 *     (observations), never as authority;
 *   - the evaluator holds no policy logic (M15) — admission happens at
 *     the service boundary before this evaluator runs.
 */

import type { EvaluationOutcome, Evaluator } from "../domain/evaluator";
import type { ModelJudge } from "../ports/model-judge";

export const MODEL_JUDGE_EVALUATOR_VERSION = "1";

export function createModelJudgeEvaluator(judge: ModelJudge, id = "model-judge"): Evaluator {
  return {
    identity: { kind: "model", id, version: MODEL_JUDGE_EVALUATOR_VERSION },
    establishes: ["model-judged"],
    async evaluate(evidence, criteria, context): Promise<EvaluationOutcome> {
      const rubric = String(criteria.definition.rubric ?? "");
      const judgment = await judge.judge({
        context: {
          tenantId: context.tenantId,
          applicationId: context.applicationId,
          executionId: context.executionId,
        },
        criteria: {
          criterionId: criteria.criterionId,
          version: criteria.version,
          rubric,
        },
        evidence,
      });

      const judgeLabel =
        judgment.judgeIdentity.provider !== undefined || judgment.judgeIdentity.model !== undefined
          ? `${judgment.judgeIdentity.provider ?? "?"}/${judgment.judgeIdentity.model ?? "?"}`
          : "model-judge";
      const evidenceRefs = [
        `model-judgment:${criteria.criterionId}@${criteria.version}`,
        ...evidence.evidenceRefs,
      ];

      // Binding check: the judgment MUST address the declared criterion —
      // a self-certification about something else (or nothing) is not a
      // judgment of THIS criterion.
      if (judgment.criterionId !== criteria.criterionId) {
        return {
          status: "INCONCLUSIVE",
          observations: [
            `the model judgment binds criterion "${judgment.criterionId}" but the declared criterion is "${criteria.criterionId}" (unbound judgment cannot produce PASS)`,
          ],
          evidenceRefs,
        };
      }
      if (judgment.meetsCriteria === "unknown") {
        return {
          status: "INCONCLUSIVE",
          observations: [
            `model judge (${judgeLabel}) could not establish the rubric: ${judgment.rationale}`,
          ],
          evidenceRefs,
          ...(judgment.confidence === undefined ? {} : { confidence: judgment.confidence }),
        };
      }
      return {
        status: judgment.meetsCriteria ? "PASS" : "FAIL",
        observations: [
          `model judge (${judgeLabel}) ${judgment.meetsCriteria ? "established" : "refuted"} the rubric: ${judgment.rationale}`,
        ],
        evidenceRefs,
        ...(judgment.confidence === undefined ? {} : { confidence: judgment.confidence }),
      };
    },
  };
}
