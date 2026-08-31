/**
 * Verification conclusions (verification module domain; WORK-013, INT-005).
 *
 * The conclusion is what the verification authority REPORTS — facts and
 * evidence, never planner state mutation:
 *
 *   verification result
 *     ↓
 *   planner/replanning authority (the ReplanningBoundary port)
 *     ↓
 *   new plan OR escalation
 *
 * `criteriaMet` is TRUE only when EVERY required criterion's LATEST
 * revision-matching result is PASS (optional criteria never gate; the
 * latest result per criterion wins — re-verification after rework
 * supersedes earlier results). FAIL and INCONCLUSIVE required criteria
 * are BOTH "unmet" — INCONCLUSIVE never silently becomes acceptance
 * (M5/M22): the unmet list carries the exact status so the planner can
 * distinguish a demonstrated failure out of insufficient evidence
 * (replan vs. more computation/escalation, ADR-0008's selective-
 * evaluation decision inputs).
 */

import type { VerificationResultRecord } from "./result";

export interface UnmetCriterion {
  readonly criterionId: string;
  readonly criteriaVersion: number;
  readonly status: "FAIL" | "INCONCLUSIVE";
  readonly reason: string;
}

/** The replanning boundary's decision over an unmet outcome. */
export type ReplanningDecision =
  | { readonly decision: "replan"; readonly detail?: string }
  | { readonly decision: "escalate-human"; readonly detail?: string }
  | { readonly decision: "fail"; readonly detail?: string }
  | { readonly decision: "no-action"; readonly detail?: string };

export interface VerificationConclusion {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly evaluationId: string;
  /** True only when every REQUIRED criterion has a revision-matching PASS. */
  readonly criteriaMet: boolean;
  readonly requiredUnmet: readonly UnmetCriterion[];
  readonly results: readonly VerificationResultRecord[];
  /**
   * The replanning boundary's decision for an unmet outcome (recorded as
   * evidence; the boundary/planner owns the decision — the verifier
   * reports). Absent when criteria are met or no boundary is wired.
   */
  readonly replanningDecision?: ReplanningDecision;
  /** True when the completion transition was driven (criteria met). */
  readonly completed: boolean;
  readonly replayed: boolean;
}

/**
 * Derive the unmet list from results against the resolved criteria.
 * Results are counted ONLY when their target revision matches the
 * evaluation's target revision (M12: a stale PASS for an older plan
 * revision does not satisfy the current one), and the LATEST matching
 * result per criterion is decisive (re-verification supersedes).
 */
export function deriveConclusion(input: {
  readonly results: readonly VerificationResultRecord[];
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly version: number;
    readonly required: boolean;
  }[];
  readonly targetRevision?: string;
}): { readonly criteriaMet: boolean; readonly requiredUnmet: readonly UnmetCriterion[] } {
  const requiredUnmet: UnmetCriterion[] = [];
  for (const criterion of input.criteria) {
    if (!criterion.required) {
      continue;
    }
    const matching = input.results.filter(
      (result) =>
        result.criterionId === criterion.criterionId &&
        result.criteriaVersion === criterion.version &&
        // Revision binding: results for the evaluated revision only.
        (input.targetRevision === undefined ||
          result.target.revision === undefined ||
          result.target.revision === input.targetRevision),
    );
    const latest = matching.at(-1);
    if (latest === undefined || latest.status !== "PASS") {
      requiredUnmet.push({
        criterionId: criterion.criterionId,
        criteriaVersion: criterion.version,
        status:
          latest === undefined
            ? "INCONCLUSIVE"
            : latest.status === "INCONCLUSIVE"
              ? "INCONCLUSIVE"
              : "FAIL",
        reason:
          latest === undefined
            ? "no evaluation result for the required criterion (revision-matching)"
            : latest.status === "PASS"
              ? "the PASS result is bound to a different target revision (stale)"
              : `the evidence did not establish the criterion (${latest.status})`,
      });
    }
  }
  return { criteriaMet: requiredUnmet.length === 0, requiredUnmet };
}
