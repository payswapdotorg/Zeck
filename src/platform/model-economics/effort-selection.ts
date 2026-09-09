/**
 * Reasoning-effort selection (platform model-economics plane;
 * WORK-053 / E1.1 — the charter's "higher reasoning effort" rung).
 *
 * The selection of the least expensive SUFFICIENT reasoning-effort
 * level for one GENERATIVE step, under the SAME explicit-basis
 * economics as model selection (WORK-053 acceptance criterion 2):
 *
 *  - the assurance floor is inviolable: below-floor effort candidates
 *    are inadmissible regardless of cost; hard quality/budget/latency
 *    constraints are enforced per candidate;
 *  - the deterministic order: expected successful-resolution cost
 *    ascending, ties broken toward LOWER effort (the effort rank —
 *    the cheaper-path default; the charter's ladder places lower
 *    effort below higher effort), ties by candidateId — identical
 *    inputs can never produce a different selection (invariant 5);
 *  - no route dimension: effort refines the model invocation the step
 *    already carries (the route stays the planner's authority);
 *  - fail closed on unmet preconditions (the step must exist and be
 *    generative; the corpus non-empty; ids unique);
 *  - decision evidence only (invariant 4).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { ExecutionIr } from "../execution-ir/ir";
import type { CandidateAdmissibility, GoverningFacts } from "./admissibility";
import {
  compareAdmissible,
  evaluateAdmissibility,
  governingFacts,
  rejectDuplicateIds,
} from "./admissibility";
import { requireGenerativeStep } from "./model-selection";
import type { EffortCandidate, EffortLevel, QualityFacts } from "./vocabulary";
import {
  effortLadderRank,
  reject,
  validateEffortCandidate,
  validateQualityFacts,
} from "./vocabulary";

// ---------------------------------------------------------------------------
// The selection input and result (typed, bounded)
// ---------------------------------------------------------------------------

/** The reasoning-effort selection input for ONE generative step. */
export interface EffortSelectionInput {
  /** The governed Execution IR the step belongs to. */
  readonly ir: ExecutionIr;
  /** The generative step the effort level is selected for. */
  readonly stepId: string;
  /** The declared effort corpus (explicit-basis claims only). */
  readonly candidates: readonly EffortCandidate[];
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
}

/** One recorded effort-candidate verdict (effort + admissibility). */
export interface EffortCandidateVerdict extends CandidateAdmissibility {
  /** The candidate's effort level (the closed neutral vocabulary). */
  readonly effort: EffortLevel;
  readonly inadmissibleCode?: CandidateAdmissibility["inadmissibleCode"];
}

/** The reasoning-effort selection result (typed evidence). */
export interface EffortSelection {
  readonly kind: "selected" | "no-admissible-candidate";
  /** The selected effort verdict, or null when none is admissible. */
  readonly selected: EffortCandidateVerdict | null;
  /** The governing facts the selection ran under (floors, ceilings). */
  readonly facts: GoverningFacts;
  /** Every candidate's verdict (the auditable comparison evidence). */
  readonly verdicts: readonly EffortCandidateVerdict[];
  /** The frozen, human-auditable selection basis. */
  readonly selectionBasis: string;
}

/** The frozen selection-basis statement of every effort selection. */
export const EFFORT_SELECTION_BASIS =
  "least-expensive-sufficient-effort;order:expected-successful-resolution-cost,effort-rank,candidateId;floors:quality,reliability,budget,latency;below-floor-inadmissible-regardless-of-cost";

// ---------------------------------------------------------------------------
// The effort-specific deterministic order
// ---------------------------------------------------------------------------

/**
 * Compare two ADMISSIBLE effort verdicts: expected
 * successful-resolution cost ascending, ties toward LOWER effort
 * (the cheaper-path default — the effort rank), ties by candidateId.
 * Deterministic and total — non-deterministic tie-breaks are
 * impossible (every tie resolves on content).
 */
function compareEffortVerdicts(a: EffortCandidateVerdict, b: EffortCandidateVerdict): number {
  const byCost = compareAdmissible(a, b);
  if (byCost !== 0) {
    return byCost;
  }
  // compareAdmissible ties on (cost, ladder rank, candidateId); for
  // effort candidates the ladder rank is the model class, so a tie
  // here means the SAME class and DIFFERENT candidateIds would have
  // resolved already. Effort rank orders the remaining dimension:
  // equal cost across effort levels of the same class prefers the
  // LOWER effort (cheaper-path default).
  const rankA = effortLadderRank(a.effort);
  const rankB = effortLadderRank(b.effort);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The selection (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Select the least expensive SUFFICIENT reasoning-effort level for
 * one generative step. Pure and deterministic; decision evidence
 * only — never an authorization (invariant 4).
 */
export function selectReasoningEffort(input: EffortSelectionInput): EffortSelection {
  const step = requireGenerativeStep(input.ir, input.stepId);
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const candidates = input.candidates.map((candidate) => validateEffortCandidate(candidate));
  if (candidates.length === 0) {
    reject("candidate-shape", "effort selection requires at least one declared candidate", {
      stepId: step.id,
    });
  }
  rejectDuplicateIds(candidates.map((candidate) => candidate.candidateId));

  const facts = governingFacts(qualityFacts, input.constraints);

  const verdicts: EffortCandidateVerdict[] = candidates.map((candidate) => ({
    ...evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: candidate.representationClass,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    ),
    effort: candidate.effort,
  }));

  const admissible = verdicts.filter((verdict) => verdict.admissible).sort(compareEffortVerdicts);
  const inadmissible = verdicts.filter((verdict) => !verdict.admissible);
  const selected = admissible[0] ?? null;
  return {
    kind: selected === null ? "no-admissible-candidate" : "selected",
    selected,
    facts,
    verdicts: [...admissible, ...inadmissible],
    selectionBasis: EFFORT_SELECTION_BASIS,
  };
}
