/**
 * Planner quality-contract gating and substitute disclosure (planning
 * module domain; ACR-009 §3–§5; work order PCS-003 — the wiring).
 *
 * THE ONE CONCERN THIS MODULE OWNS: the typed quality-contract dimension
 * of candidate admissibility, the substitution fact recorded on the
 * decision record when a substitute is PERMITTED and selected, and the
 * machine-checkable user-facing disclosure projected from those typed
 * facts. It consumes the PCS-002 `SemanticFidelityFacts` plane READ-ONLY
 * (the capabilities module's own closed vocabularies and validated
 * facts) and composes into the EXISTING planning machinery — no second
 * planner, no second selection path, no new durable surface:
 *
 *  - `applySemanticQualityGating` extends the admissibility evaluation
 *    with the typed dimension: a task that declares a quality contract
 *    requiring semantic quality (`requires-semantic-retrieval-quality`)
 *    makes a `deterministic-substitute` representation INADMISSIBLE for
 *    that task's satisfaction — a typed `InadmissibleReasonCode` composed
 *    exactly like the existing economics/quality/policy reasons
 *    (strategy.ts's family). It is composed AFTER the hard policy filter
 *    and NEVER touches an already-inadmissible candidate: the gating can
 *    only ADD inadmissibility, never remove it — it never lowers a
 *    quality floor, raises a budget ceiling or bypasses policy
 *    (invariant 13 boundary).
 *  - FAIL-CLOSED: an unknown or malformed quality contract is
 *    inadmissible (`semantic-quality-contract-malformed`), never a
 *    permissive default — defense in depth behind the task-profile
 *    derivation's own fail-closed rejection of malformed contracts.
 *  - `buildSemanticSubstitutionCapture` records the SUBSTITUTION FACT on
 *    the decision record (the existing WORK-049 seam — append-only
 *    values) exactly when a permitted substitute is selected: which
 *    requirement, which representation satisfied it (kind + the full
 *    PCS-002 provenance basis), under which governing contract spelling.
 *  - `projectSemanticDisclosure` derives the user-facing disclosure
 *    mechanically from the typed record facts — never prose: which
 *    requirement was declared, which representation satisfied it (kind +
 *    provenance), and what remains unavailable (the closed two-kind
 *    vocabulary's other member). It projects ONLY where facts exist;
 *    with no facts the projection is null (absence-equivalent).
 *
 * THE WIRING DISCIPLINE (ACR-009 §5 — default-off, absence-equivalent):
 * every function here is total and pure over its inputs, and every
 * absent input selects byte-identically to the pre-change behavior: no
 * declared contract + no representation facts ⇒ the gating returns the
 * candidate UNCHANGED, no capture is built, no disclosure is projected.
 * There is NO ambient configuration: the gating input is the task's
 * DECLARED contract (and the capability resolution's declared facts) —
 * nothing else (no environment, no clock, no randomness, no flags).
 *
 * THE VOCABULARY MIRROR (the planner-surface discipline — the
 * workload-class precedent): planning domain/application consult other
 * modules TYPE-ONLY (values live in adapters), so the closed
 * quality-requirement vocabulary is mirrored BY VALUE here and PINNED
 * against the capabilities authority (`SEMANTIC_QUALITY_REQUIREMENTS`)
 * by test — widening is a reviewed change that the pin catches, never a
 * silent drift.
 */

import { PlatformError } from "../../../shared/errors";
// The planner-surface seam convention (the workload-class precedent):
// planning domain consults other modules TYPE-ONLY, on single-line
// imports — so the module anchors on the two names that fit and DERIVES
// the rest of the closed PCS-002 types from them (type-level
// extraction, never a re-declaration — zero drift risk).
import type { ClaimSatisfaction, SemanticQualityContract } from "../../capabilities/public";
import type { ExecutionPlan } from "./plan";
import type { CandidateStrategy, InadmissibleReasonCode } from "./strategy";

/** The satisfying claim's arbitrated semantic-fidelity fact block (PCS-002's closed type, read-only). */
type SatisfyingSemanticFidelity = NonNullable<ClaimSatisfaction["semanticFidelity"]>;

/** The closed two-kind representation vocabulary (derived from the PCS-002 fact type). */
type SemanticRepresentationKind = SatisfyingSemanticFidelity["representationKind"];

/** The explicit provenance basis every semantic fact carries (the CostClaim discipline). */
type SemanticFidelityBasis = SatisfyingSemanticFidelity["basis"];

/** The closed quality-requirement vocabulary member (derived from the declared-contract member). */
type SemanticQualityRequirement = Extract<
  SemanticQualityContract,
  { kind: "declared" }
>["requirement"];

// ---------------------------------------------------------------------------
// The planning-side mirror of the closed quality-requirement vocabulary
// ---------------------------------------------------------------------------

/**
 * The planning-side mirror of the capabilities module's frozen
 * `SEMANTIC_QUALITY_REQUIREMENTS` (the workload-class mirror precedent:
 * planning domain consults other modules TYPE-ONLY, so the closed
 * vocabulary is mirrored by value here and PINNED against the
 * capabilities authority by test — `tests/unit/planning/
 * semantic-quality-gating.test.ts`). Widening either side is a reviewed
 * change the pin catches; the planner never invents a quality metric
 * (ACR-009 §7 — the contract is task-authored, Zeck types and enforces
 * it).
 */
export const SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY: readonly SemanticQualityRequirement[] = [
  "requires-semantic-retrieval-quality",
];

/** The acceptance-basis bound (mirrors the PCS-002 discipline: bounded, non-empty). */
const ACCEPTANCE_BASIS_MAX = 200;

// ---------------------------------------------------------------------------
// The quality-contract classification (total, fail-closed)
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
      readonly requirement: SemanticQualityRequirement;
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
 * reason naming the defect — the gate treats malformed as DECLARED-but-
 * unreadable (inadmissible substitutes), never as absent.
 */
export function classifySemanticQualityContract(
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
    // The incoherent shape is rejected (the PCS-002 discipline —
    // presence spelled on an absence is malformed, never silently read
    // as permission).
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
    !(SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY as readonly string[]).includes(value.requirement)
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
    requirement: value.requirement as SemanticQualityRequirement,
    acceptanceBasis: value.acceptanceBasis,
  };
}

// ---------------------------------------------------------------------------
// The per-requirement representation facts (consumed read-only)
// ---------------------------------------------------------------------------

/**
 * The per-requirement semantic representation summary the planner
 * consumes READ-ONLY from the capability resolution's satisfactions
 * (PCS-002's facts, projected): which requirement, which representation
 * kind satisfies it, and the claim provenance (claim identity, version,
 * publisher). Only requirements whose satisfying claim DECLARES
 * semantic-fidelity facts appear here — a claim without facts is not a
 * substitute and never a model-backed claim (the absence spelling).
 */
export interface SemanticRepresentationSummary {
  readonly requirementId: string;
  readonly representationKind: SemanticRepresentationKind;
  readonly claimId: string;
  readonly claimVersion: string;
  readonly publisher: string;
  /** The FULL PCS-002 explicit basis (which execution, which capability, which substitute). */
  readonly basis: SemanticFidelityBasis;
}

/**
 * Project the resolution's per-requirement representation facts. PURE —
 * a read-only projection of the satisfaction pass-through blocks; a
 * resolution without fidelity facts yields the EMPTY array (the
 * absence-equivalent spelling — nothing to gate, nothing to record).
 */
export function semanticRepresentationsOf(
  resolution:
    | {
        readonly satisfied: false;
        readonly catalogRevision?: string;
        readonly unmet?: readonly unknown[];
      }
    | {
        readonly satisfied: true;
        readonly catalogRevision?: string;
        readonly satisfactions: readonly ClaimSatisfaction[];
      },
): readonly SemanticRepresentationSummary[] {
  if (!resolution.satisfied) {
    return [];
  }
  const summaries: SemanticRepresentationSummary[] = [];
  for (const satisfaction of resolution.satisfactions) {
    const facts = satisfaction.semanticFidelity;
    if (facts === undefined || facts === null) {
      continue;
    }
    summaries.push({
      requirementId: satisfaction.requirementId,
      representationKind: facts.representationKind,
      claimId: satisfaction.claimId,
      claimVersion: satisfaction.claimVersion,
      publisher: satisfaction.publisher,
      basis: facts.basis,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// The typed quality-contract gating dimension (ACR-009 §3)
// ---------------------------------------------------------------------------

/** The gating input: the classified contract + the representation facts. */
export interface SemanticQualityGatingInput {
  readonly contract: SemanticQualityContractClassification;
  readonly representations: readonly SemanticRepresentationSummary[];
}

/**
 * Does the candidate's plan carry a step satisfied by a
 * `deterministic-substitute` representation? Pure step-level lookup:
 * a plan step's `capabilityId` names the requirement its capability
 * serves, so a substitute representation binds exactly the steps whose
 * capability it substituted for.
 */
function substitutedRequirementIds(
  plan: ExecutionPlan,
  representations: readonly SemanticRepresentationSummary[],
): readonly string[] {
  const substitutes = representations.filter(
    (representation) => representation.representationKind === "deterministic-substitute",
  );
  if (substitutes.length === 0) {
    return [];
  }
  const substituted: string[] = [];
  for (const step of plan.steps) {
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
 * composed AFTER the hard policy filter, exactly like the policy reasons
 * it extends (strategy.ts's `InadmissibleReasonCode` family):
 *
 *  - the contract is `undeclared` or `absent` (substitutes permitted) ⇒
 *    the candidate is returned UNCHANGED (byte-identical — the
 *    substitution fact is recorded by `buildSemanticSubstitutionCapture`
 *    when such a candidate is selected);
 *  - the contract is `declared` and the candidate carries a
 *    `deterministic-substitute` representation ⇒ INADMISSIBLE with the
 *    typed reason `semantic-quality-contract-forbids-substitute`;
 *  - the contract is `malformed` ⇒ INADMISSIBLE with the typed reason
 *    `semantic-quality-contract-malformed` — fail-closed, never a
 *    permissive default;
 *  - an already-inadmissible candidate is returned UNCHANGED — the
 *    gating never overrides a policy verdict, never lowers a quality
 *    floor, never raises a budget ceiling and never bypasses policy
 *    (invariant 13 boundary: it can only ADD inadmissibility).
 *
 * PURE and total; no ambient input of any kind rides this gate.
 */
export function applySemanticQualityGating(
  candidate: CandidateStrategy,
  input: SemanticQualityGatingInput,
): CandidateStrategy {
  if (!candidate.admissible) {
    // Invariant 13 composition: the policy authorities have already
    // spoken on this candidate — the gating never revises their verdict.
    return candidate;
  }
  if (input.contract.kind === "undeclared" || input.contract.kind === "absent") {
    // Substitutes are permitted (no contract declared, or the explicit
    // absence spelling): today's exact admissibility, byte-identical.
    return candidate;
  }
  const substituted = substitutedRequirementIds(candidate.plan, input.representations);
  if (substituted.length === 0) {
    // The candidate carries no deterministic-substitute representation:
    // the contract question does not arise for it.
    return candidate;
  }
  return {
    ...candidate,
    admissible: false,
    inadmissibleReason:
      input.contract.kind === "declared"
        ? ("semantic-quality-contract-forbids-substitute" as const)
        : ("semantic-quality-contract-malformed" as const),
  };
}

// ---------------------------------------------------------------------------
// The substitution fact on the decision record (ACR-009 §3 / §4)
// ---------------------------------------------------------------------------

/**
 * One substituted requirement on the SELECTED plan: which requirement,
 * which representation satisfied it (kind), and the FULL provenance —
 * the claim identity/version/publisher plus the PCS-002 explicit basis
 * (which execution produced the fact, which capability it attaches to,
 * which substitute function produced it). Mechanically complete: a
 * consumer needs no prose to know what was substituted by what.
 */
export interface SemanticSubstitutionFact {
  readonly requirementId: string;
  readonly representationKind: SemanticRepresentationKind;
  readonly claimId: string;
  readonly claimVersion: string;
  readonly publisher: string;
  readonly basis: SemanticFidelityBasis;
}

/**
 * The substitution capture on the decision record (the WORK-049 seam —
 * append-only values, no new durable surface): the governing contract
 * spelling, the per-requirement representation facts that were
 * consulted, and the substitutions on the selected plan. Built exactly
 * when the capability resolution carried semantic-fidelity facts (the
 * disclosure projects only where facts exist).
 */
export interface SemanticSubstitutionCapture {
  /** The governing contract spelling (`{kind: "absent"}` when none was declared). */
  readonly qualityContract: SemanticQualityContract;
  /** The per-requirement representation facts consulted (at least one). */
  readonly representations: readonly SemanticRepresentationSummary[];
  /** The substituted requirements on the selected plan (may be empty — gated or clean). */
  readonly substitutions: readonly SemanticSubstitutionFact[];
}

/**
 * Build the substitution capture for a completed selection. Returns
 * `undefined` (no capture — the byte-identical-today record) when the
 * resolution carried NO representation facts; otherwise records the
 * governing contract spelling, the consulted representations, and the
 * substitute representations the SELECTED plan actually carries.
 */
export function buildSemanticSubstitutionCapture(input: {
  readonly contract: SemanticQualityContract | undefined;
  readonly representations: readonly SemanticRepresentationSummary[];
  readonly selected: CandidateStrategy;
}): SemanticSubstitutionCapture | undefined {
  if (input.representations.length === 0) {
    return undefined;
  }
  const substituted = substitutedRequirementIds(input.selected.plan, input.representations);
  const substitutions: SemanticSubstitutionFact[] = [];
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

// ---------------------------------------------------------------------------
// The user-facing disclosure projection (ACR-009 §4 — mechanical, typed)
// ---------------------------------------------------------------------------

/** The disclosure status of one declared/substituted requirement. */
export type SemanticDisclosureStatus =
  | "met-by-deterministic-substitute"
  | "unmet-no-admissible-semantic-representation";

/**
 * One machine-checkable disclosure entry: which requirement, its status,
 * the representation that satisfied it (kind + full provenance, when
 * met), the declared requirement (when a contract was declared), what
 * remains unavailable (the closed two-kind vocabulary's other member),
 * and the typed inadmissibility reason that blocked the substitute
 * (when unmet). Never prose — every field derives from typed record
 * facts.
 */
export interface SemanticDisclosureEntry {
  readonly requirementId: string;
  readonly status: SemanticDisclosureStatus;
  readonly declaredRequirement?: SemanticQualityRequirement;
  readonly representation?: SemanticSubstitutionFact;
  /** What remains unavailable (the closed two-kind vocabulary's members). */
  readonly unavailable: readonly SemanticRepresentationKind[];
  readonly inadmissibleReason?: InadmissibleReasonCode;
}

/** The full disclosure: the governing contract + the per-requirement entries. */
export interface SemanticDisclosure {
  readonly qualityContract: SemanticQualityContract;
  readonly entries: readonly SemanticDisclosureEntry[];
}

/**
 * The typed semantic-gating inadmissibility reasons (closed, for the
 * disclosure's unmet derivation).
 */
const SEMANTIC_GATING_REASONS: readonly InadmissibleReasonCode[] = [
  "semantic-quality-contract-forbids-substitute",
  "semantic-quality-contract-malformed",
];

/**
 * Project the user-facing semantic disclosure from a durable planning
 * decision record — MECHANICALLY, from the typed facts only (never
 * prose): which requirement was declared (the task profile's contract),
 * which representation satisfied it (the substitution capture's kind +
 * provenance), and what remains unavailable. Returns `null` when the
 * record carries NO semantic facts (no declared contract and no
 * substitution capture) — the absence-equivalent projection: no facts,
 * no disclosure, byte-identical behavior.
 *
 * Unmet-and-blocked entries derive from the record's own typed
 * evidence: a declared contract + a gated candidate (the typed
 * semantic reason) + a substitute representation that did NOT satisfy
 * the selected plan — the honest NOT-RUN/unmet boundary discipline the
 * records already carry, extended with the typed facts.
 */
export function projectSemanticDisclosure(record: {
  readonly taskProfile: { readonly semanticQualityContract?: SemanticQualityContract };
  readonly semanticSubstitution?: SemanticSubstitutionCapture;
  readonly candidates: readonly {
    readonly admissible: boolean;
    readonly inadmissibleReason?: InadmissibleReasonCode;
    readonly plan: ExecutionPlan;
  }[];
}): SemanticDisclosure | null {
  const contract = record.taskProfile.semanticQualityContract;
  const capture = record.semanticSubstitution;
  if (contract === undefined && capture === undefined) {
    // Absence-equivalent: no facts exist, no disclosure is projected.
    return null;
  }
  const governingContract: SemanticQualityContract = contract ??
    capture?.qualityContract ?? {
      kind: "absent",
    };
  const entries: SemanticDisclosureEntry[] = [];

  // Met-by-substitute entries: the substitutions the SELECTED plan
  // carries (kind + provenance), with the model-backed member of the
  // closed two-kind vocabulary named as what remains unavailable.
  for (const substitution of capture?.substitutions ?? []) {
    entries.push({
      requirementId: substitution.requirementId,
      status: "met-by-deterministic-substitute",
      ...(contract?.kind === "declared" ? { declaredRequirement: contract.requirement } : {}),
      representation: substitution,
      unavailable: ["semantic-model-backed"],
    });
  }

  // Unmet-and-blocked entries (only under a DECLARED contract): a
  // substitute representation that a recorded candidate carried
  // inadmissibly (the typed semantic reason) and that the selected plan
  // does not satisfy — the declared requirement could not be met by an
  // admissible semantic representation.
  if (contract?.kind === "declared") {
    for (const representation of capture?.representations ?? []) {
      if (representation.representationKind !== "deterministic-substitute") {
        continue;
      }
      const satisfiedOnSelectedPlan = (capture?.substitutions ?? []).some(
        (substitution) => substitution.requirementId === representation.requirementId,
      );
      if (satisfiedOnSelectedPlan) {
        continue;
      }
      const gatedReason = record.candidates.find(
        (candidate) =>
          !candidate.admissible &&
          candidate.inadmissibleReason !== undefined &&
          SEMANTIC_GATING_REASONS.includes(candidate.inadmissibleReason) &&
          candidate.plan.steps.some((step) => step.capabilityId === representation.requirementId),
      )?.inadmissibleReason;
      if (gatedReason === undefined) {
        continue;
      }
      entries.push({
        requirementId: representation.requirementId,
        status: "unmet-no-admissible-semantic-representation",
        declaredRequirement: contract.requirement,
        unavailable: ["semantic-model-backed"],
        inadmissibleReason: gatedReason,
      });
    }
  }

  return { qualityContract: governingContract, entries };
}

// ---------------------------------------------------------------------------
// Closed-shape validation (the decision-record discipline)
// ---------------------------------------------------------------------------

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `planning decision semanticSubstitution ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Closed-shape validation of the substitution capture (the consultation
 * validators' discipline): the governing contract must classify cleanly
 * (declared or absent — a capture never carries a malformed contract),
 * every representation must carry its typed fields with the substitute
 * identity exactly when the kind is `deterministic-substitute`, and
 * every substitution must carry its full provenance basis (an
 * unattributed substitution fact is unrepresentable — the explicit-basis
 * CostClaim discipline).
 */
export function validateSemanticSubstitutionCapture(
  value: unknown,
): asserts value is SemanticSubstitutionCapture {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision semanticSubstitution must be an object (the typed capture)",
    });
  }
  const contractClassification = classifySemanticQualityContract(value.qualityContract);
  if (contractClassification.kind === "malformed" || contractClassification.kind === "undeclared") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "planning decision semanticSubstitution.qualityContract must be the declared or absent spelling (never malformed, never undeclared)",
    });
  }
  if (!Array.isArray(value.representations) || value.representations.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "planning decision semanticSubstitution.representations must be a non-empty array of typed representation summaries",
    });
  }
  for (const representation of value.representations) {
    if (!isRecord(representation)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "each semanticSubstitution representation must be an object",
      });
    }
    requireString(representation, "requirementId", "representation.requirementId");
    if (
      representation.representationKind !== "semantic-model-backed" &&
      representation.representationKind !== "deterministic-substitute"
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution representation.representationKind must be semantic-model-backed|deterministic-substitute",
      });
    }
    requireString(representation, "claimId", "representation.claimId");
    requireString(representation, "claimVersion", "representation.claimVersion");
    requireString(representation, "publisher", "representation.publisher");
    if (!isRecord(representation.basis)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution representation.basis is required on every representation fact (the explicit-basis discipline)",
      });
    }
    requireString(representation.basis, "executionId", "representation.basis.executionId");
    requireString(representation.basis, "capabilityId", "representation.basis.capabilityId");
    if (representation.representationKind === "deterministic-substitute") {
      if (
        typeof representation.basis.substituteId !== "string" ||
        representation.basis.substituteId.length === 0
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "semanticSubstitution representation.basis.substituteId is required when representationKind is deterministic-substitute",
        });
      }
    } else if (representation.basis.substituteId !== undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution representation.basis.substituteId cannot ride a semantic-model-backed representation (the incoherent shape is rejected)",
      });
    }
  }
  if (!Array.isArray(value.substitutions)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision semanticSubstitution.substitutions must be an array",
    });
  }
  for (const substitution of value.substitutions) {
    if (!isRecord(substitution)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "each semanticSubstitution substitution must be an object",
      });
    }
    requireString(substitution, "requirementId", "substitution.requirementId");
    if (substitution.representationKind !== "deterministic-substitute") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution substitution.representationKind must be deterministic-substitute (a substitution IS a substitute)",
      });
    }
    requireString(substitution, "claimId", "substitution.claimId");
    requireString(substitution, "claimVersion", "substitution.claimVersion");
    requireString(substitution, "publisher", "substitution.publisher");
    if (!isRecord(substitution.basis)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution substitution.basis is required on every substitution fact (the explicit-basis discipline — an unattributed substitution is unrepresentable)",
      });
    }
    requireString(substitution.basis, "executionId", "substitution.basis.executionId");
    requireString(substitution.basis, "capabilityId", "substitution.basis.capabilityId");
    if (
      typeof substitution.basis.substituteId !== "string" ||
      substitution.basis.substituteId.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "semanticSubstitution substitution.basis.substituteId is required (which substitute function produced it)",
      });
    }
  }
}
