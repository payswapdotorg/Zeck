/**
 * The planner quality-contract gating — the evaluation's app-local
 * projection of the PCS-003 wiring (ACR-009 §3; work order PCS-004).
 *
 * THE BOUNDARY DISCIPLINE (VAL-002 AC7 — never `src/**` from the
 * application tree): the REAL gate lives in
 * `src/modules/planning/domain/semantic-quality-gating.ts`
 * (`classifySemanticQualityContract` + `applySemanticQualityGating`,
 * exported through `src/modules/planning/public.ts`) and is NOT
 * importable here. This module mirrors the gate the same established
 * way the PCR-003 app mirrors the canonical serializer: implemented
 * locally over NEUTRAL data, and pinned BY TEST — the
 * `tests/unit/validation/pcs-004-*.test.ts` suites drive the REAL gate
 * (imported from `src/modules/planning/public`) over EVERY control of
 * this evaluation and assert the verdicts are EXACTLY the local
 * projection's verdicts (a fabricated pass is unrepresentable; drift is
 * a typed failure).
 *
 * THE SEMANTICS MIRRORED (ACR-009 §3 — composed exactly like the
 * existing admissibility dimensions):
 *
 *  - a task that declares a quality contract requiring semantic
 *    retrieval quality (`requires-semantic-retrieval-quality`) makes a
 *    `deterministic-substitute` representation INADMISSIBLE for that
 *    task's satisfaction — the typed reason
 *    `semantic-quality-contract-forbids-substitute`; the planner never
 *    "tries anyway";
 *  - a task that declares no contract (or the explicit absence
 *    spelling) may select the substitute — permitted, with the
 *    substitution fact recorded (the disclosure);
 *  - an unknown or malformed quality contract is INADMISSIBLE with the
 *    typed reason `semantic-quality-contract-malformed` — fail-closed,
 *    never a permissive default;
 *  - an already-inadmissible candidate is returned UNCHANGED — the
 *    gating can only ADD inadmissibility, never remove it, and never
 *    revises a policy verdict (the invariant-13 boundary);
 *  - a plan step's `capabilityId` names the requirement its capability
 *    serves, so a substitute representation binds exactly the steps
 *    whose capability it substituted for.
 *
 * Pure and total: no ambient input of any kind rides this projection.
 */

import type { SemanticQualityContract, SemanticRepresentationKind } from "./fidelity";

// ---------------------------------------------------------------------------
// The quality-requirement vocabulary mirror (pinned against the
// capabilities authority by test — the workload-class precedent)
// ---------------------------------------------------------------------------

/**
 * The closed quality-requirement vocabulary this projection enforces —
 * the mirror of the PCS-002 authority's frozen vocabulary (widening is
 * a reviewed change the pin catches; the evaluation never invents a
 * quality metric — ACR-009 §7).
 */
export const SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY: readonly string[] = [
  "requires-semantic-retrieval-quality",
];

/** The acceptance-basis bound (mirrors the PCS-002 discipline). */
const ACCEPTANCE_BASIS_MAX = 200;

// ---------------------------------------------------------------------------
// The classification (total, fail-closed — the mirror of the PCS-003
// classifySemanticQualityContract; reasons are byte-identical)
// ---------------------------------------------------------------------------

/**
 * The total classification of a task-authored quality contract:
 * `undeclared` (no contract field at all — today's exact behavior),
 * `absent` (the explicit `{kind: "absent"}` spelling — substitutes
 * explicitly permitted), `declared` (a closed-vocabulary requirement
 * with a bounded acceptance basis), or `malformed` (anything else —
 * fail-closed, never a permissive default).
 */
export type SemanticQualityContractClassification =
  | { readonly kind: "undeclared" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "declared";
      readonly requirement: string;
      readonly acceptanceBasis: string;
    }
  | { readonly kind: "malformed"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a task-authored quality contract. TOTAL and deterministic:
 * every input maps to exactly one verdict; unknown requirement kinds,
 * incoherent shapes and unbounded bases classify `malformed` with a
 * reason naming the defect — the gate treats malformed as
 * DECLARED-but-unreadable (inadmissible substitutes), never as absent.
 */
export function classifyQualityContractMirror(
  value: unknown,
): SemanticQualityContractClassification {
  if (value === undefined || value === null) {
    return { kind: "undeclared" };
  }
  if (!isRecord(value)) {
    return {
      kind: "malformed",
      reason: "semanticQualityContract must be an object with kind declared|absent",
    };
  }
  if (value.kind === "absent") {
    if (value.requirement !== undefined || value.acceptanceBasis !== undefined) {
      return {
        kind: "malformed",
        reason:
          "semanticQualityContract absent cannot carry a requirement or acceptanceBasis (the incoherent shape is rejected)",
      };
    }
    return { kind: "absent" };
  }
  if (value.kind !== "declared") {
    return {
      kind: "malformed",
      reason: "semanticQualityContract.kind must be declared|absent",
    };
  }
  if (
    typeof value.requirement !== "string" ||
    !SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY.includes(value.requirement)
  ) {
    return {
      kind: "malformed",
      reason: `semanticQualityContract.requirement must be one of ${SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY.join("|")}: ${String(value.requirement)}`,
    };
  }
  if (
    typeof value.acceptanceBasis !== "string" ||
    value.acceptanceBasis.length === 0 ||
    value.acceptanceBasis.length > ACCEPTANCE_BASIS_MAX
  ) {
    return {
      kind: "malformed",
      reason: `semanticQualityContract.acceptanceBasis must be a bounded non-empty string (<=${ACCEPTANCE_BASIS_MAX})`,
    };
  }
  return {
    kind: "declared",
    requirement: value.requirement,
    acceptanceBasis: value.acceptanceBasis,
  };
}

// ---------------------------------------------------------------------------
// The neutral candidate + representation shapes (the real gate's inputs,
// projected over neutral data — the suite constructs the REAL
// CandidateStrategy from these and proves verdict equality)
// ---------------------------------------------------------------------------

/**
 * One neutral plan step: the `capabilityId` names the requirement its
 * capability serves (the real gate's step binding).
 */
export interface NeutralPlanStep {
  readonly stepId: string;
  readonly capabilityId?: string;
}

/**
 * The neutral candidate the local projection gates: an admissible flag,
 * the existing inadmissibility reason (when the policy authorities have
 * already spoken), and the plan steps.
 */
export interface NeutralCandidate {
  readonly strategyId: string;
  readonly admissible: boolean;
  /** The existing (policy) inadmissibility reason — never revised by this gate. */
  readonly inadmissibleReason?: string;
  readonly planSteps: readonly NeutralPlanStep[];
}

/**
 * One per-requirement representation summary (the real gate's
 * `SemanticRepresentationSummary` shape over neutral data): which
 * requirement, which representation kind satisfies it, the claim
 * provenance, and the FULL explicit basis.
 */
export interface NeutralRepresentationSummary {
  readonly requirementId: string;
  readonly representationKind: SemanticRepresentationKind;
  readonly claimId: string;
  readonly claimVersion: string;
  readonly publisher: string;
  readonly basis: {
    readonly executionId: string;
    readonly capabilityId: string;
    readonly substituteId?: string;
  };
}

/** The typed gating reasons (the real `InadmissibleReasonCode` members this dimension adds). */
export const SEMANTIC_GATING_REASONS = [
  "semantic-quality-contract-forbids-substitute",
  "semantic-quality-contract-malformed",
] as const;
export type SemanticGatingReason = (typeof SEMANTIC_GATING_REASONS)[number];

/** The local gate's verdict. */
export type LocalGateVerdict =
  | { readonly verdict: "admissible" }
  | {
      readonly verdict: "inadmissible";
      readonly reason: string;
      /** True when the gate returned an already-inadmissible candidate UNCHANGED (invariant 13). */
      readonly unchanged: boolean;
    };

/**
 * Does the candidate's plan carry a step satisfied by a
 * `deterministic-substitute` representation? Pure step-level lookup —
 * the mirror of the real gate's `substitutedRequirementIds`.
 */
function substitutedRequirementIds(
  candidate: NeutralCandidate,
  representations: readonly NeutralRepresentationSummary[],
): readonly string[] {
  const substitutes = representations.filter(
    (representation) => representation.representationKind === "deterministic-substitute",
  );
  if (substitutes.length === 0) {
    return [];
  }
  const substituted: string[] = [];
  for (const step of candidate.planSteps) {
    if (step.capabilityId === undefined) {
      continue;
    }
    if (substitutes.some((representation) => representation.requirementId === step.capabilityId)) {
      substituted.push(step.capabilityId);
    }
  }
  return substituted;
}

/**
 * Apply the typed quality-contract gating dimension to ONE candidate —
 * the local projection of the REAL `applySemanticQualityGating` (pinned
 * verdict-for-verdict in-suite):
 *
 *  - the contract is `undeclared` or `absent` (substitutes permitted) ⇒
 *    ADMISSIBLE (the substitution fact is recorded by the caller when
 *    such a candidate is selected);
 *  - the contract is `declared` and the candidate carries a
 *    `deterministic-substitute` representation on its plan ⇒
 *    INADMISSIBLE with the typed reason
 *    `semantic-quality-contract-forbids-substitute`;
 *  - the contract is `malformed` and the candidate carries a
 *    deterministic-substitute representation ⇒ INADMISSIBLE with the
 *    typed reason `semantic-quality-contract-malformed`;
 *  - an already-inadmissible candidate is returned UNCHANGED (its
 *    existing reason preserved — the gate never revises a policy
 *    verdict, never lowers a quality floor, never raises a budget
 *    ceiling and never bypasses policy: it can only ADD
 *    inadmissibility).
 */
export function applyQualityContractGatingMirror(
  candidate: NeutralCandidate,
  input: {
    readonly contract: SemanticQualityContractClassification;
    readonly representations: readonly NeutralRepresentationSummary[];
  },
): LocalGateVerdict {
  if (!candidate.admissible) {
    // Invariant-13 composition: the policy authorities have already
    // spoken on this candidate — the gating never revises their verdict.
    return {
      verdict: "inadmissible",
      reason: candidate.inadmissibleReason ?? "inadmissible",
      unchanged: true,
    };
  }
  if (input.contract.kind === "undeclared" || input.contract.kind === "absent") {
    // Substitutes are permitted (no contract declared, or the explicit
    // absence spelling): today's exact admissibility, byte-identical.
    return { verdict: "admissible" };
  }
  const substituted = substitutedRequirementIds(candidate, input.representations);
  if (substituted.length === 0) {
    // The candidate carries no deterministic-substitute representation:
    // the contract question does not arise for it.
    return { verdict: "admissible" };
  }
  return {
    verdict: "inadmissible",
    reason:
      input.contract.kind === "declared"
        ? "semantic-quality-contract-forbids-substitute"
        : "semantic-quality-contract-malformed",
    unchanged: false,
  };
}

// ---------------------------------------------------------------------------
// The substitution fact + the disclosure projection (ACR-009 §3/§4 —
// the mirrors of buildSemanticSubstitutionCapture + the disclosure
// projection's entry derivation; pinned in-suite)
// ---------------------------------------------------------------------------

/** One substituted requirement on the SELECTED plan (the full provenance). */
export interface LocalSubstitutionFact {
  readonly requirementId: string;
  readonly representationKind: SemanticRepresentationKind;
  readonly claimId: string;
  readonly claimVersion: string;
  readonly publisher: string;
  readonly basis: NeutralRepresentationSummary["basis"];
}

/** The substitution capture (what the record carries when a substitute is PERMITTED and selected). */
export interface LocalSubstitutionCapture {
  /** The governing contract spelling (`{kind: "absent"}` when none was declared). */
  readonly qualityContract: SemanticQualityContract | { readonly kind: "absent" };
  /** The per-requirement representation facts consulted (at least one). */
  readonly representations: readonly NeutralRepresentationSummary[];
  /** The substituted requirements on the selected plan (may be empty). */
  readonly substitutions: readonly LocalSubstitutionFact[];
}

/**
 * Build the substitution capture for a completed selection — the mirror
 * of the real `buildSemanticSubstitutionCapture`: `undefined` (no
 * capture — the byte-identical-today record) when the resolution
 * carried NO representation facts; otherwise the governing contract
 * spelling, the consulted representations, and the substitute
 * representations the SELECTED plan actually carries.
 */
export function buildSubstitutionCaptureMirror(input: {
  readonly contract: SemanticQualityContract | undefined;
  readonly representations: readonly NeutralRepresentationSummary[];
  readonly selected: NeutralCandidate;
}): LocalSubstitutionCapture | undefined {
  if (input.representations.length === 0) {
    return undefined;
  }
  const substituted = substitutedRequirementIds(input.selected, input.representations);
  const substitutions: LocalSubstitutionFact[] = [];
  for (const requirementId of substituted) {
    const representation = input.representations.find(
      (candidate) => candidate.requirementId === requirementId,
    );
    if (representation === undefined) {
      continue;
    }
    substitutions.push({
      requirementId,
      representationKind: representation.representationKind,
      claimId: representation.claimId,
      claimVersion: representation.claimVersion,
      publisher: representation.publisher,
      basis: representation.basis,
    });
  }
  return {
    qualityContract: input.contract ?? { kind: "absent" },
    representations: [...input.representations],
    substitutions,
  };
}

/** The disclosure status of one declared/substituted requirement (the closed two-status vocabulary). */
export type LocalDisclosureStatus =
  | "met-by-deterministic-substitute"
  | "unmet-no-admissible-semantic-representation";

/** One machine-checkable disclosure entry (never prose — typed record facts only). */
export interface LocalDisclosureEntry {
  readonly requirementId: string;
  readonly status: LocalDisclosureStatus;
  readonly declaredRequirement?: string;
  readonly representation?: LocalSubstitutionFact;
  /** What remains unavailable (the closed two-kind vocabulary's other member). */
  readonly unavailable: readonly SemanticRepresentationKind[];
  readonly inadmissibleReason?: string;
}

/**
 * The gated disclosure of one control: when a substitute is PERMITTED
 * and selected under a non-declared contract, the
 * `met-by-deterministic-substitute` entry (which requirement, which
 * representation satisfied it with its full provenance, what remains
 * unavailable); when a DECLARED contract blocks the substitute, the
 * `unmet-no-admissible-semantic-representation` entry with the typed
 * inadmissibility reason that blocked it. Every field derives from
 * typed facts — never prose.
 */
export function projectDisclosureMirror(input: {
  readonly contract: SemanticQualityContract | undefined;
  readonly representations: readonly NeutralRepresentationSummary[];
  readonly selected: NeutralCandidate;
  readonly gating: LocalGateVerdict;
}): readonly LocalDisclosureEntry[] {
  const classification = classifyQualityContractMirror(input.contract);
  // The met-by-substitute entries project ONLY for an ADMITTED
  // selection (the candidate the gate let through — an inadmissible
  // candidate is never selected, so nothing was "met" by it).
  if (input.gating.verdict !== "admissible") {
    const entries: LocalDisclosureEntry[] = [];
    if (classification.kind === "declared" && !input.gating.unchanged) {
      // Unmet-and-blocked entries (only under a DECLARED contract that
      // forbade the substitute): the declared requirement could not be
      // met by an admissible semantic representation.
      for (const representation of input.representations) {
        if (representation.representationKind !== "deterministic-substitute") {
          continue;
        }
        entries.push({
          requirementId: representation.requirementId,
          status: "unmet-no-admissible-semantic-representation",
          declaredRequirement: classification.requirement,
          unavailable: ["semantic-model-backed"],
          inadmissibleReason: input.gating.reason,
        });
      }
    }
    return entries;
  }
  const capture = buildSubstitutionCaptureMirror({
    contract: input.contract,
    representations: input.representations,
    selected: input.selected,
  });
  const entries: LocalDisclosureEntry[] = [];
  // Met-by-substitute entries: the substitutions the SELECTED plan
  // carries, with the model-backed member of the closed two-kind
  // vocabulary named as what remains unavailable.
  for (const substitution of capture?.substitutions ?? []) {
    entries.push({
      requirementId: substitution.requirementId,
      status: "met-by-deterministic-substitute",
      ...(classification.kind === "declared"
        ? { declaredRequirement: classification.requirement }
        : {}),
      representation: substitution,
      unavailable: ["semantic-model-backed"],
    });
  }
  return entries;
}
