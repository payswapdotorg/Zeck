/**
 * Evaluator contracts (verification module domain; WORK-013).
 *
 * Evaluators are CAPABILITIES/PARTICIPANTS of the verification authority —
 * never authorities themselves (`spec/architecture.md` §18, the
 * WORK-013 "Verification is an AUTHORITY" boundary):
 *
 *   - an evaluator assesses EVIDENCE against DECLARED CRITERIA and
 *     produces an outcome + observations — nothing else;
 *   - an evaluator can never authorize a platform action (no policy
 *     authority — M15), never transition an execution, never mutate
 *     planner state (M16), never self-declare its result a completion;
 *   - provider identity (for model-based evaluators) stays behind the
 *     models module's adapters: the evaluator ADAPTER dispatches through
 *     the models public gateway, and the judgment comes back as
 *     normalized evidence that must be assessed against the criteria
 *     (a provider HTTP success or a bare "looks correct" string is
 *     INCONCLUSIVE evidence, never PASS — M1/M2);
 *   - deterministic evaluators establish deterministic criteria kinds
 *     only (M18: deterministic verification is never secretly replaced
 *     by an AI call — evaluator selection is kind-bound);
 *   - human evaluation is MEDIATED: a human decision arrives through the
 *     governed request/decision path (`domain/human.ts`), is attributable
 *     and provenance-preserving (M19) — never an in-process evaluator
 *     call that could strip actor identity.
 *
 * The outcome vocabulary is exactly PASS | FAIL | INCONCLUSIVE. An
 * evaluator that cannot establish a criterion from the evidence at hand
 * MUST return INCONCLUSIVE — the honest "insufficient evidence" state,
 * never a coerced PASS.
 */

import type { CriterionKind } from "./criteria";
import type { VerificationTarget } from "./result";

/**
 * The evidence under assessment: normalized FACTS about the target plus
 * durable evidence references. Facts are observations (tool outputs,
 * model outputs, computed values, recorded decisions) — never authority
 * statements: a provider HTTP status fact or a tool-outcome fact is inert
 * unless a DECLARED criterion makes it load-bearing (the M1/M3
 * separation: provider/tool success facts are evidence, not verdicts).
 */
export interface EvidenceBundle {
  readonly target: VerificationTarget;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
}

/** What an evaluator established, considering which evidence. */
export interface EvaluationOutcome {
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly observations: readonly string[];
  /** The evidence references the assessment actually considered. */
  readonly evidenceRefs: readonly string[];
  readonly confidence?: number;
}

/** The execution scope every evaluator runs within (never authority). */
export interface EvaluationContext {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly actorId: string;
}

/**
 * The evaluator contract (implemented by adapters). `establishes` is the
 * declared capability: the criterion kinds this evaluator can assess.
 * Selection matches `establishes` against the criterion kind — a
 * deterministic evaluator can never be handed a `model-judged`
 * criterion and a model evaluator can never silently take over a
 * deterministic criterion.
 */
export interface Evaluator {
  readonly identity: {
    readonly kind: "deterministic" | "model" | "human";
    readonly id: string;
    readonly version: string;
  };
  readonly establishes: readonly CriterionKind[];
  evaluate(
    evidence: EvidenceBundle,
    criteria: {
      readonly criterionId: string;
      readonly version: number;
      readonly kind: CriterionKind;
      readonly definition: Readonly<Record<string, unknown>>;
    },
    context: EvaluationContext,
  ): Promise<EvaluationOutcome>;
}

/**
 * Deterministic-first evaluator selection (ADR-0007/0011 applied to
 * verification): for each criterion kind, deterministic evaluators come
 * first; judged kinds route to their judge class. A criterion with NO
 * matching evaluator yields no evaluation (the service records an
 * INCONCLUSIVE outcome with an explicit observation) — it is NEVER
 * silently reassigned to another evaluator class.
 */
export function selectEvaluator(
  evaluators: readonly Evaluator[],
  kind: CriterionKind,
): Evaluator | null {
  return evaluators.find((evaluator) => evaluator.establishes.includes(kind)) ?? null;
}
