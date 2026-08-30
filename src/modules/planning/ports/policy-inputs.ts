/**
 * Policy inputs port (planning module outbound; WORK-009 / POL boundary).
 *
 * The planner consumes the WORK-007 policy authority's RESOLVED outputs —
 * never re-implementing resolution, never weakening restrictions. The
 * captured resolution is recorded on the durable planning decision
 * (policy inputs are part of the auditable evidence, AC-8) and applied as
 * HARD admissibility constraints at strategy selection (AC-9).
 */

import type { PolicyRequestContext, RestrictionSet } from "../../policies/public";

export interface ResolvedPolicyInputs {
  readonly outcome: "allow" | "deny";
  readonly effective?: RestrictionSet;
  /** Policy-set identity provenance (from the current set record). */
  readonly policySetId?: string;
  readonly policySetVersion?: number;
  readonly policyContentHash?: string;
  /** Applied scopes in precedence order. */
  readonly appliedScopes?: readonly string[];
  /** Denial detail when the resolution denies this context. */
  readonly denial?: Readonly<Record<string, unknown>>;
}

export interface PlanningPolicyInputs {
  /** Resolve the effective restrictions for a request context. */
  effective(context: PolicyRequestContext): Promise<ResolvedPolicyInputs>;
}
