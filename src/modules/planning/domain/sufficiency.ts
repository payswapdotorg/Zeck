/**
 * Deterministic sufficiency evaluation (planning module domain;
 * WORK-009 / ACR-001 / ADR-0007 — THE core deterministic-first decision).
 *
 * `evaluateDeterministicSufficiency` answers ONE question BEFORE any
 * provider/model/agent selection: can admissible deterministic
 * computation satisfy this task without materially reducing the verified
 * outcome?
 *
 * Decision table (pure, total, tested):
 *  - semantic/generative reasoning required by the task profile
 *      ⇒ `insufficient` (reason: semantic-reasoning-required);
 *  - a declared capability requirement is unmet by the arbitrated
 *    catalog ⇒ `insufficient` (reason: capability-unmet);
 *  - deterministic expected quality is below the task's quality target
 *    (confidently) ⇒ `insufficient` (reason: quality-gap — choosing
 *    deterministic here would materially reduce the verified outcome);
 *  - deterministic expected quality meets the target but the estimate is
 *    UNVERIFIED (estimated confidence) ⇒ `uncertain` (reason:
 *    quality-unverified) — the planner must request a bounded
 *    evaluation/compare path rather than blindly escalating to a model
 *    (ACR-002 / ADR-0012);
 *  - otherwise ⇒ `sufficient` (deterministic is preferred — ADR-0007).
 *
 * Policy enters as INPUT, never as an override: a policy that forbids
 * every model route does not make deterministic "sufficient" when it is
 * not — it makes generative strategies inadmissible at selection time
 * (possibly yielding `NO_ELIGIBLE_ROUTE`).
 */

import type { CapabilityResolution } from "../../capabilities/public";
import type { DeterministicCatalogEntry } from "../ports/deterministic-catalog";
import type { TaskProfile } from "./task-profile";

export type SufficiencyOutcome = "sufficient" | "insufficient" | "uncertain";

/** Typed rationale codes (machine-readable, frozen vocabulary). */
export type SufficiencyReasonCode =
  | "semantic-reasoning-required"
  | "capability-unmet"
  | "quality-gap"
  | "quality-unverified"
  | "deterministic-coverage-verified";

export interface SufficiencyReason {
  readonly code: SufficiencyReasonCode;
  readonly detail: string;
  readonly requirementId?: string;
}

export interface DeterministicSufficiencyDecision {
  readonly outcome: SufficiencyOutcome;
  readonly semanticReasoningRequired: boolean;
  readonly reasons: readonly SufficiencyReason[];
  /** Per-requirement deterministic coverage from the catalog (evidence). */
  readonly coverage: readonly RequirementCoverage[];
  /** The deterministic quality estimate that decided the outcome. */
  readonly deterministicQualityEstimate: number | null;
  readonly qualityConfidence: "verified" | "estimated" | null;
}

export interface RequirementCoverage {
  readonly requirementId: string;
  readonly covered: boolean;
  readonly catalogEntry?: DeterministicCatalogEntry;
}

export interface SufficiencyInput {
  readonly profile: TaskProfile;
  readonly resolution: CapabilityResolution;
  readonly catalog: readonly DeterministicCatalogEntry[];
  /** The policy quality floor, when set (context for the decision record). */
  readonly policyQualityFloor?: number;
}

/**
 * Evaluate deterministic sufficiency. PURE — no route explorer, no model
 * gateway, no side effects; this function must be callable BEFORE any
 * provider/model selection exists (the ordering boundary itself).
 */
export function evaluateDeterministicSufficiency(
  input: SufficiencyInput,
): DeterministicSufficiencyDecision {
  const { profile, resolution, catalog } = input;
  const reasons: SufficiencyReason[] = [];
  const coverage: RequirementCoverage[] = [];

  const catalogById = new Map(catalog.map((entry) => [entry.capabilityId, entry]));
  const registryUnmet = resolution.satisfied ? [] : resolution.unmet;

  // Deterministic coverage per requirement (the catalog is the planning
  // contract's minimum deterministic capability set). Model/human-kind
  // requirements are deterministic-UNCOVERABLE at plan time by definition.
  for (const requirement of profile.capabilityRequirements) {
    if (requirement.kind === "model" || requirement.kind === "human") {
      coverage.push({ requirementId: requirement.id, covered: false });
      continue;
    }
    const registryUnmetForRequirement = registryUnmet.some(
      (unmet) => unmet.requirementId === requirement.id,
    );
    const entry = catalogById.get(requirement.id);
    if (entry === undefined || registryUnmetForRequirement) {
      coverage.push({ requirementId: requirement.id, covered: false });
      continue;
    }
    coverage.push({ requirementId: requirement.id, covered: true, catalogEntry: entry });
  }

  const uncoveredNonModel = coverage.filter((item) => !item.covered);
  for (const item of uncoveredNonModel) {
    reasons.push({
      code: "capability-unmet",
      detail: `requirement ${item.requirementId} has no admissible deterministic capability`,
      requirementId: item.requirementId,
    });
  }

  // Semantic reasoning short-circuits to insufficient — by construction a
  // generative step is required.
  if (profile.requiresSemanticReasoning) {
    reasons.push({
      code: "semantic-reasoning-required",
      detail: "the task profile declares semantic/generative reasoning requirements",
    });
    return {
      outcome: "insufficient",
      semanticReasoningRequired: true,
      reasons,
      coverage,
      deterministicQualityEstimate: null,
      qualityConfidence: null,
    };
  }

  if (uncoveredNonModel.length > 0) {
    return {
      outcome: "insufficient",
      semanticReasoningRequired: false,
      reasons,
      coverage,
      deterministicQualityEstimate: null,
      qualityConfidence: null,
    };
  }

  // Every deterministic facet is covered: aggregate the quality estimate
  // as the MINIMUM over the covering entries (a chain is as good as its
  // weakest step) and decide against the task quality target.
  const covered = coverage
    .map((item) => item.catalogEntry)
    .filter((entry): entry is DeterministicCatalogEntry => entry !== undefined);
  const deterministicQuality = Math.min(...covered.map((entry) => entry.expectedQuality));
  const confidence = covered.every((entry) => entry.qualityConfidence === "verified")
    ? "verified"
    : "estimated";

  if (deterministicQuality < profile.qualityTarget) {
    reasons.push({
      code: "quality-gap",
      detail: `deterministic quality estimate ${deterministicQuality.toFixed(4)} is below the task quality target ${profile.qualityTarget.toFixed(4)} — deterministic execution would materially reduce the verified outcome`,
    });
    return {
      outcome: "insufficient",
      semanticReasoningRequired: false,
      reasons,
      coverage,
      deterministicQualityEstimate: deterministicQuality,
      qualityConfidence: confidence,
    };
  }

  if (confidence === "estimated") {
    reasons.push({
      code: "quality-unverified",
      detail: `deterministic quality estimate ${deterministicQuality.toFixed(4)} meets the target ${profile.qualityTarget.toFixed(4)} but is not verified — a bounded evaluation/compare path is required before relying on it`,
    });
    return {
      outcome: "uncertain",
      semanticReasoningRequired: false,
      reasons,
      coverage,
      deterministicQualityEstimate: deterministicQuality,
      qualityConfidence: confidence,
    };
  }

  reasons.push({
    code: "deterministic-coverage-verified",
    detail: `deterministic capabilities cover every requirement with verified quality ${deterministicQuality.toFixed(4)} at or above the target ${profile.qualityTarget.toFixed(4)}`,
  });
  return {
    outcome: "sufficient",
    semanticReasoningRequired: false,
    reasons,
    coverage,
    deterministicQualityEstimate: deterministicQuality,
    qualityConfidence: "verified",
  };
}
