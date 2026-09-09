/**
 * Quality-aware model selection (platform model-economics plane;
 * WORK-053 / E1.1 — ADR-0019 §5, ADR-0020).
 *
 * The selection of the least expensive SUFFICIENT model route for
 * one GENERATIVE step of a governed Execution IR, among DECLARED
 * candidates carrying explicit-basis claims:
 *
 *  - selection is a PURE function of (plan IR facts, candidate facts,
 *    quality facts, constraints) — fail closed on unmet preconditions
 *    (the referenced step must exist and must be a model-selection
 *    point: a generative step class, the only classes whose routes
 *    are legal);
 *  - the required outcome quality (the assurance floor, possibly
 *    raised by hard quality constraints) is a HARD constraint:
 *    below-floor candidates are INADMISSIBLE regardless of cost
 *    (invariant 8 — price never overrides quality);
 *  - hard ceilings (budget, latency) and hard policy route
 *    restrictions (the planning module's own denylists-dominate
 *    semantics, through the foundation's sanctioned mirror) are
 *    enforced per candidate;
 *  - among ADMISSIBLE candidates the selection order is the
 *    foundation's deterministic auditable comparison basis: expected
 *    successful-resolution cost ascending (ceil(cost/reliability)),
 *    ties by the canonical representation ladder (sufficient-model
 *    before stronger-model — the cheaper rung first), ties by
 *    candidateId (invariant 5: identical inputs can never produce a
 *    different selection, including tie-breaking);
 *  - when no candidate is admissible the outcome is the TYPED
 *    `no-admissible-candidate` — NEVER a below-floor selection;
 *  - the selection is DECISION EVIDENCE ONLY (invariant 4): it
 *    authorizes nothing; the WORK-049-format decision record is
 *    built as a value (`decisions.ts`) and the durable append happens
 *    through the existing store at the caller's seam.
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { ExecutionIr } from "../execution-ir/ir";
import { isGenerativeStepClass, type PlanStepClass } from "../execution-ir/ir";
import type { CandidateAdmissibility, GoverningFacts } from "./admissibility";
import {
  evaluateAdmissibility,
  governingFacts,
  orderVerdicts,
  rejectDuplicateIds,
  routeEligibility,
} from "./admissibility";
import type { ModelCandidate, QualityFacts } from "./vocabulary";
import { reject, validateModelCandidate, validateQualityFacts } from "./vocabulary";

// ---------------------------------------------------------------------------
// The selection input and result (typed, bounded)
// ---------------------------------------------------------------------------

/** The quality-aware model selection input for ONE generative step. */
export interface ModelSelectionInput {
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The generative step the model route is selected for. */
  readonly stepId: string;
  /** The declared candidate corpus (explicit-basis claims only). */
  readonly candidates: readonly ModelCandidate[];
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
}

/** One recorded model-candidate verdict (route + claim + admissibility). */
export interface ModelCandidateVerdict extends CandidateAdmissibility {
  /** The candidate's provider-neutral route. */
  readonly route: { readonly provider: string; readonly model: string };
  readonly inadmissibleCode?: CandidateAdmissibility["inadmissibleCode"];
}

/** The quality-aware model selection result (typed evidence). */
export interface ModelSelection {
  readonly kind: "selected" | "no-admissible-candidate";
  /** The selected candidate's verdict, or null when none is admissible. */
  readonly selected: ModelCandidateVerdict | null;
  /** The governing facts the selection ran under (floors, ceilings). */
  readonly facts: GoverningFacts;
  /**
   * Every candidate's verdict in the deterministic order: admissible
   * first (cost ascending, ladder rank, candidateId), inadmissible
   * after in input order — the auditable "why the cheaper did or did
   * not win" evidence.
   */
  readonly verdicts: readonly ModelCandidateVerdict[];
  /** The frozen, human-auditable selection basis. */
  readonly selectionBasis: string;
}

/** The frozen selection-basis statement of every model selection. */
export const MODEL_SELECTION_BASIS =
  "least-expensive-sufficient-model-route;order:expected-successful-resolution-cost,representation-ladder,candidateId;floors:quality,reliability,budget,latency,policy;below-floor-inadmissible-regardless-of-cost";

// ---------------------------------------------------------------------------
// The step preconditions (fail closed)
// ---------------------------------------------------------------------------

/**
 * Resolve the generative step the selection is for. Fail closed
 * (typed) when the step does not exist or is not a model-selection
 * point — model routes are legal ONLY on generative step classes
 * (the frozen architecture rule the IR itself enforces).
 */
export function requireGenerativeStep(
  ir: ExecutionIr,
  stepId: string,
): { readonly id: string; readonly stepClass: PlanStepClass } {
  const step = ir.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    reject("step-not-found", "the referenced step does not exist in the IR", { stepId });
  }
  if (!isGenerativeStepClass(step.stepClass)) {
    reject("step-not-generative", "model selection points are generative steps only", {
      stepId,
      stepClass: step.stepClass,
    });
  }
  return { id: step.id, stepClass: step.stepClass };
}

// ---------------------------------------------------------------------------
// The selection (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Select the least expensive SUFFICIENT model route for one
 * generative step. Pure and deterministic: the same inputs always
 * produce the identical verdicts, the identical selected candidate
 * and the identical selection basis (invariant 5). Decision evidence
 * only — never an authorization (invariant 4).
 */
export function selectModelRepresentation(input: ModelSelectionInput): ModelSelection {
  const step = requireGenerativeStep(input.ir, input.stepId);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const candidates = input.candidates.map((candidate) => {
    const validated = validateModelCandidate(candidate);
    return validated;
  });
  if (candidates.length === 0) {
    reject("candidate-shape", "model selection requires at least one declared candidate", {
      stepId: step.id,
    });
  }
  rejectDuplicateIds(candidates.map((candidate) => candidate.candidateId));

  const facts = governingFacts(qualityFacts, input.constraints);

  const verdicts: ModelCandidateVerdict[] = candidates.map((candidate) => {
    const admissibility = evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: candidate.representationClass,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    );
    // Route policy eligibility (the foundation's sanctioned mirror of
    // the planning module's semantics — denylists dominate).
    const eligibility = routeEligibility(candidate.route, facts);
    if (eligibility.eligible) {
      return {
        ...admissibility,
        route: candidate.route,
        ...(admissibility.inadmissibleCode === undefined
          ? {}
          : { inadmissibleCode: admissibility.inadmissibleCode }),
      };
    }
    // A policy-forbidden route is inadmissible regardless of every
    // other dimension (recorded with the typed code).
    return {
      candidateId: candidate.candidateId,
      representationClass: candidate.representationClass,
      admissible: false,
      inadmissibleCode: "policy-forbidden-route" as const,
      route: candidate.route,
      evaluation: admissibility.evaluation,
    };
  });

  const { ordered, selected } = orderVerdicts(verdicts);
  return {
    kind: selected === null ? "no-admissible-candidate" : "selected",
    selected,
    facts,
    verdicts: ordered,
    selectionBasis: MODEL_SELECTION_BASIS,
  };
}
