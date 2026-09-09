/**
 * Service-class selection hooks (platform model-economics plane;
 * WORK-053 / E1.1 — the charter's "alternative inference/service
 * tier" rung, ADR-0020).
 *
 * HOOKS ONLY (WORK-053 acceptance criterion 5): where the substrate
 * supports declared service classes, this module selects the least
 * expensive SUFFICIENT class among the DECLARED candidates and
 * returns a typed hook decision for the substrate adapters (WORK-054)
 * to consume. There is NO live tier call, no substrate client, no
 * provider vocabulary — the selection is offline decision evidence.
 *
 * Where the substrate declares NO service classes, the hook outcome
 * is the typed `unsupported` (no selection — recorded honestly,
 * never defaulted).
 *
 * The economics are the plane's shared rules: the inviolable quality
 * floor, hard budget/latency ceilings, and the deterministic order —
 * expected successful-resolution cost ascending, ties toward the
 * CHEAPER service class (economy < standard < priority — the
 * cheaper-path default), ties by candidateId (invariant 5). Decision
 * evidence only (invariant 4).
 */

import type { OptimizationConstraint } from "../execution-ir/constraints";
import type { CandidateAdmissibility, GoverningFacts } from "./admissibility";
import {
  compareAdmissible,
  evaluateAdmissibility,
  governingFacts,
  rejectDuplicateIds,
} from "./admissibility";
import type { QualityFacts, ServiceClass, ServiceClassCandidate } from "./vocabulary";
import {
  serviceClassRank,
  validateQualityFacts,
  validateServiceClassCandidate,
} from "./vocabulary";

// ---------------------------------------------------------------------------
// The hook input and result (typed, bounded)
// ---------------------------------------------------------------------------

/** The service-class selection hook input. */
export interface ServiceClassSelectionInput {
  /** The declared service classes the substrate supports (may be empty). */
  readonly declaredClasses: readonly ServiceClassCandidate[];
  /** The quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
}

/** One recorded service-class candidate verdict. */
export interface ServiceClassVerdict extends CandidateAdmissibility {
  /** The candidate's service class (the closed neutral vocabulary). */
  readonly serviceClass: ServiceClass;
  readonly inadmissibleCode?: CandidateAdmissibility["inadmissibleCode"];
}

/**
 * The service-class hook decision: `unsupported` when the substrate
 * declares no classes (no selection), else the selection over the
 * declared corpus (typed outcome — never a below-floor selection).
 */
export interface ServiceClassSelection {
  readonly kind: "selected" | "no-admissible-candidate" | "unsupported";
  readonly selected: ServiceClassVerdict | null;
  /** The governing facts the hook ran under. */
  readonly facts: GoverningFacts | null;
  /** Every declared candidate's verdict (the auditable comparison). */
  readonly verdicts: readonly ServiceClassVerdict[];
  /** The frozen, human-auditable hook basis. */
  readonly selectionBasis: string;
}

/** The frozen basis statement of every service-class hook decision. */
export const SERVICE_CLASS_SELECTION_BASIS =
  "least-expensive-sufficient-service-class;order:expected-successful-resolution-cost,service-class-rank,candidateId;floors:quality,reliability,budget,latency;below-floor-inadmissible-regardless-of-cost;hooks-only";

// ---------------------------------------------------------------------------
// The service-class order (the cheaper-class default)
// ---------------------------------------------------------------------------

/**
 * Compare two ADMISSIBLE service-class verdicts: expected
 * successful-resolution cost ascending, ties toward the CHEAPER class
 * (economy < standard < priority), ties by candidateId. Deterministic
 * and total.
 */
function compareServiceClassVerdicts(a: ServiceClassVerdict, b: ServiceClassVerdict): number {
  const byCost = compareAdmissible(a, b);
  if (byCost !== 0) {
    return byCost;
  }
  const rankA = serviceClassRank(a.serviceClass);
  const rankB = serviceClassRank(b.serviceClass);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The hook (pure, deterministic, total)
// ---------------------------------------------------------------------------

/**
 * Select the least expensive SUFFICIENT service class among the
 * DECLARED substrate classes — a typed HOOK decision (evidence only;
 * the substrate adapters consume it; nothing executes a tier here).
 */
export function selectServiceClass(input: ServiceClassSelectionInput): ServiceClassSelection {
  const qualityFacts = validateQualityFacts(input.qualityFacts);
  const candidates = input.declaredClasses.map((candidate) =>
    validateServiceClassCandidate(candidate),
  );
  if (candidates.length === 0) {
    // The substrate supports no declared service classes: the honest
    // typed outcome (no selection, never a defaulted one).
    return {
      kind: "unsupported",
      selected: null,
      facts: null,
      verdicts: [],
      selectionBasis: SERVICE_CLASS_SELECTION_BASIS,
    };
  }
  rejectDuplicateIds(candidates.map((candidate) => candidate.candidateId));

  const facts = governingFacts(qualityFacts, input.constraints);
  const verdicts: ServiceClassVerdict[] = candidates.map((candidate) => ({
    ...evaluateAdmissibility(
      {
        candidateId: candidate.candidateId,
        representationClass: candidate.representationClass,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        claim: candidate.claim,
      },
      facts,
    ),
    serviceClass: candidate.serviceClass,
  }));

  const admissible = verdicts
    .filter((verdict) => verdict.admissible)
    .sort(compareServiceClassVerdicts);
  const inadmissible = verdicts.filter((verdict) => !verdict.admissible);
  const selected = admissible[0] ?? null;
  return {
    kind: selected === null ? "no-admissible-candidate" : "selected",
    selected,
    facts,
    verdicts: [...admissible, ...inadmissible],
    selectionBasis: SERVICE_CLASS_SELECTION_BASIS,
  };
}
