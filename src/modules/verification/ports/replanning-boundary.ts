/**
 * Replanning boundary port (verification module outbound; WORK-013,
 * INT-005).
 *
 * THE planner/verification separation: verification does not directly
 * mutate planner state. When required criteria are unmet, the
 * verification service REPORTS the outcome to the replanning authority
 * through this port and records the authority's decision as evidence:
 *
 *   verification result
 *     ↓
 *   planner/replanning authority (this port — implemented by the
 *   planning/orchestrator side)
 *     ↓
 *   new plan OR escalation
 *
 * The verifier reports facts/evidence; the planner decides what
 * execution strategy follows (`spec/architecture.md` §2.11, WORK-009's
 * deterministic-first contract: the verifier is not the planner, does
 * not choose providers, does not rewrite plans). The port is OPTIONAL
 * wiring at service construction: with no boundary wired, an unmet
 * outcome is still honestly reported (the conclusion carries the unmet
 * list; the CALLER drives replanning) — it can never be silently
 * accepted.
 */

import type { ReplanningDecision, VerificationConclusion } from "../domain/conclusion";

/** The outcome facts the boundary receives (never planner state). */
export interface ReplanningOutcomeInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly evaluationId: string;
  readonly criteriaMet: boolean;
  readonly requiredUnmet: readonly {
    readonly criterionId: string;
    readonly criteriaVersion: number;
    readonly status: "FAIL" | "INCONCLUSIVE";
    readonly reason: string;
  }[];
}

export interface ReplanningBoundary {
  /**
   * Report an unmet verification outcome; the authority returns ITS
   * decision (recorded as evidence — the verifier executes none of it:
   * replan/escalate/fail transitions belong to the planner side).
   */
  onVerificationOutcome(outcome: ReplanningOutcomeInput): Promise<ReplanningDecision>;
}

/** Narrow the conclusion onto the boundary input shape. */
export function replanningOutcomeOf(conclusion: VerificationConclusion): ReplanningOutcomeInput {
  return {
    applicationId: conclusion.applicationId,
    tenantId: conclusion.tenantId,
    executionId: conclusion.executionId,
    evaluationId: conclusion.evaluationId,
    criteriaMet: conclusion.criteriaMet,
    requiredUnmet: conclusion.requiredUnmet,
  };
}
