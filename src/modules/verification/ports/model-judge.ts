/**
 * Model-judge port (verification module outbound; WORK-013).
 *
 * The provider-neutral seam for MODEL-BASED evaluation. A model judge is
 * an EVALUATOR, never an authority (`spec/architecture.md` §18, the
 * WORK-013 model-evaluation boundary):
 *
 *   - provider identity stays behind the models module's adapters: this
 *     port receives/returns provider-NEUTRAL contracts only; the
 *     production adapter (`adapters/model-judge-evaluator.ts`) dispatches
 *     through the models public gateway;
 *   - the judge's output is EVIDENCE that must be assessed against the
 *     declared criteria — the judgment is REQUIRED to bind the criterion
 *     it judges and to carry an explicit `meetsCriteria` verdict
 *     (boolean | "unknown"); a raw provider success, an HTTP status or a
 *     bare "looks correct" string is NOT a judgment and maps to
 *     INCONCLUSIVE (M1/M2: provider success and model self-certification
 *     can never produce PASS);
 *   - a judge may return `meetsCriteria: "unknown"` — model judges are
 *     not assumed infallible; uncertainty is the honest INCONCLUSIVE.
 */

import type { EvidenceBundle } from "../domain/evaluator";

export interface ModelJudgeRequest {
  readonly context: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly executionId: string;
  };
  readonly criteria: {
    readonly criterionId: string;
    readonly version: number;
    readonly rubric: string;
  };
  readonly evidence: EvidenceBundle;
}

/** The normalized structured judgment the judge MUST return. */
export interface ModelJudgment {
  /** MUST equal the judged criterion id (binding check is enforced). */
  readonly criterionId: string;
  /** true — evidence meets the rubric; false — it does not; "unknown" — cannot establish. */
  readonly meetsCriteria: boolean | "unknown";
  readonly rationale: string;
  readonly confidence?: number;
  /** Provider-neutral judge identity (recorded as evidence, never authority). */
  readonly judgeIdentity: {
    readonly provider?: string;
    readonly model?: string;
  };
}

export interface ModelJudge {
  judge(request: ModelJudgeRequest): Promise<ModelJudgment>;
}
