/**
 * Composition recommendation consultation capture (planning module
 * domain; WORK-017 / ADR-0005, `spec/architecture.md` §19).
 *
 * THE PLANNING-SIDE READ SEAM of tool-composition learning. When the
 * planner is wired with a composition-recommendation source, it
 * consults the ACTIVE recommendation set for the task class and
 * records the consultation INSIDE the durable planning decision — as
 * EVIDENCE:
 *
 *  - the LIVE selection is computed BEFORE the consultation and is
 *    never changed by it (the pipeline order is the protection: task
 *    → policy → capabilities → deterministic sufficiency → candidates
 *    → selection → THEN the composition consultation capture — M1/M18:
 *    a learned recommendation can never change live routing and can
 *    never bypass the deterministic-first preference);
 *  - every consulted recommendation carries its full versioning basis
 *    (set id + version, analysis version, composition schema version,
 *    recommendation schema version, the evaluation window, the pinned
 *    tool versions and the non-empty provenance) — an unversioned or
 *    unprovenanced recommendation fails closed in
 *    `validateConsultedCompositionRecommendation` and never enters a
 *    durable decision record (M11/M12/M13/M26);
 *  - the policy gate is re-checked AT CONSULTATION TIME under the
 *    CURRENT effective policy (`compositionAllowedByPolicy`): a tool
 *    forbidden by the effective restriction set can NEVER become a
 *    preferred recommendation regardless of its learning score (M5 —
 *    FORBIDDEN TOOL ≠ ADMISSIBLE, the §9 boundary);
 *  - `preferredStrategyId` records WHICH admissible candidate the
 *    recommendations would prefer (the highest-ranked supported,
 *    policy-allowed recommendation whose tool capabilities align with
 *    the candidate's call-tool steps) — the recorded disagreement
 *    between the learned preference and the governed selection is
 *    consultation evidence, exactly like the WORK-014 learning
 *    consultation;
 *  - the recommendation class is pinned to the frozen
 *    non-authoritative class (RECOMMENDATION ≠ AUTHORIZATION).
 *
 * Deterministic-first is untouched (ADR-0007/§17): the consultation
 * records the learned preference among ADMISSIBLE candidates only;
 * a deterministic-sufficient selection is NEVER replaced by a
 * generative preference (M23) — the sufficiency decision precedes the
 * consultation and the consultation cannot revisit it.
 *
 * This file is pure domain: no side effects, no learning module import
 * (the port/adapter seam lives in ports/adapters).
 */

import { PlatformError } from "../../../shared/errors";
import type { RestrictionSet } from "../../policies/public";
import type { CandidateStrategy } from "./strategy";

/** The frozen non-authority class carried by consulted recommendations. */
export const CONSULTED_COMPOSITION_CLASS = "non-authoritative-composition-recommendation" as const;

/** The honest recommendation status vocabulary (the learning mirror). */
export const CONSULTED_COMPOSITION_STATUSES = ["supported", "unsupported", "inconclusive"] as const;

/**
 * A composition recommendation as captured in a durable planning
 * decision. Consumer-side mirror of the learning module's public
 * `CompositionRecommendation` (planning validates what it consumes —
 * the version/provenance anchors are enforced HERE too).
 */
export interface ConsultedCompositionRecommendation {
  readonly recommendationClass: typeof CONSULTED_COMPOSITION_CLASS;
  readonly taskClass: string;
  /** The policy-relevant context key of the evidence population. */
  readonly contextCapabilities: readonly string[];
  readonly contextStrategyClass: string;
  /** The pinned tool versions, in sequence order (M26). */
  readonly toolVersions: readonly { readonly toolId: string; readonly version: string }[];
  /** The capability ids of the recommended tools (alignment evidence). */
  readonly toolCapabilityIds: readonly string[];
  readonly status: (typeof CONSULTED_COMPOSITION_STATUSES)[number];
  readonly rank: number | null;
  readonly confidenceLevel: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly meanCostMicroUsd: string;
  readonly meanLatencyMs: number;
  /** Full versioning basis (M13). */
  readonly setId: string;
  readonly setVersion: number;
  readonly analysisVersion: number;
  readonly compositionSchemaVersion: number;
  readonly recommendationSchemaVersion: number;
  readonly evaluationWindowFrom: string;
  readonly evaluationWindowTo: string;
  /** Evidence references backing the recommendation (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
  /** Source executions (M11, non-empty). */
  readonly sourceExecutionIds: readonly string[];
}

/** The composition consultation capture recorded on the planning decision. */
export interface CompositionConsultation {
  readonly consulted: readonly ConsultedCompositionRecommendation[];
  /** Learning's preference among ADMISSIBLE candidates (null: none). */
  readonly preferredStrategyId: string | null;
  /** Whether the learned preference agrees with the governed selection. */
  readonly agreesWithSelection: boolean;
  readonly consultedAt: string;
}

/** Minimum population for a recommendation to inform a preference (frozen floor). */
export const COMPOSITION_PREFERENCE_MINIMUM_POPULATION = 5;

/** Uncertainty levels that disqualify a recommendation from informing a preference. */
const PREFERENCE_BLOCKING_UNCERTAINTY = "high";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted composition recommendation ${what} must be a non-empty string (versioning/provenance anchors)`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Fail-closed validation of a consulted composition recommendation
 * (the consumer-side M11/M12/M13/M26 boundary): the full versioning
 * basis and the non-empty provenance must be present, the tools must
 * be pinned to concrete versions and the status must be the closed
 * vocabulary. An unversioned or unprovenanced recommendation is
 * rejected — it never enters a decision record.
 */
export function validateConsultedCompositionRecommendation(
  value: unknown,
): asserts value is ConsultedCompositionRecommendation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation must be an object",
    });
  }
  const recommendation = value;
  if (recommendation.recommendationClass !== CONSULTED_COMPOSITION_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted composition recommendation must carry the frozen non-authority class (a recommendation is never an authorization)",
      details: { expected: CONSULTED_COMPOSITION_CLASS },
    });
  }
  for (const key of ["taskClass", "contextStrategyClass", "confidenceLevel"] as const) {
    requireString(recommendation, key, key);
  }
  for (const key of ["setId", "evaluationWindowFrom", "evaluationWindowTo"] as const) {
    requireString(recommendation, key, key);
  }
  for (const key of ["setVersion", "analysisVersion", "meanLatencyMs"] as const) {
    const number = recommendation[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted composition recommendation ${key} must be a positive integer`,
        details: { field: key },
      });
    }
  }
  for (const key of ["compositionSchemaVersion", "recommendationSchemaVersion"] as const) {
    const number = recommendation[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted composition recommendation ${key} must be a positive integer (schema anchors, M13)`,
        details: { field: key },
      });
    }
  }
  const toolVersions = recommendation.toolVersions;
  if (
    !Array.isArray(toolVersions) ||
    toolVersions.length === 0 ||
    toolVersions.some(
      (tool) =>
        !isRecord(tool) ||
        typeof tool.toolId !== "string" ||
        tool.toolId.length === 0 ||
        typeof tool.version !== "string" ||
        tool.version.length === 0,
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted composition recommendation toolVersions must be non-empty and pinned to concrete versions (M26 — never bare tool names)",
      details: { field: "toolVersions" },
    });
  }
  for (const key of ["contextCapabilities", "toolCapabilityIds"] as const) {
    const list = recommendation[key];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted composition recommendation ${key} must be an array of strings`,
        details: { field: key },
      });
    }
  }
  if (
    typeof recommendation.status !== "string" ||
    !(CONSULTED_COMPOSITION_STATUSES as readonly string[]).includes(recommendation.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation status must be the closed vocabulary",
      details: { allowed: CONSULTED_COMPOSITION_STATUSES },
    });
  }
  if (
    recommendation.rank !== null &&
    (typeof recommendation.rank !== "number" || recommendation.rank < 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation rank must be a positive integer or null",
    });
  }
  if (
    typeof recommendation.population !== "number" ||
    !Number.isInteger(recommendation.population) ||
    recommendation.population < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation population must be a non-negative integer",
    });
  }
  if (
    typeof recommendation.successCount !== "number" ||
    !Number.isInteger(recommendation.successCount) ||
    recommendation.successCount < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation successCount must be a non-negative integer",
    });
  }
  if (
    typeof recommendation.successRate !== "number" ||
    recommendation.successRate < 0 ||
    recommendation.successRate > 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted composition recommendation successRate must be in [0,1]",
    });
  }
  if (
    typeof recommendation.meanCostMicroUsd !== "string" ||
    !/^\d{1,19}$/.test(recommendation.meanCostMicroUsd)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted composition recommendation meanCostMicroUsd must be an integer micro-USD string",
    });
  }
  for (const key of ["evidenceRefs", "sourceExecutionIds"] as const) {
    const refs = recommendation[key];
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some((ref) => typeof ref !== "string" || ref.length === 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted composition recommendation ${key} must be non-empty (M11 provenance)`,
        details: { field: key },
      });
    }
  }
}

/** Validate a full composition consultation capture (round-trip). */
export function validateCompositionConsultation(
  value: unknown,
): asserts value is CompositionConsultation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition consultation must be an object",
    });
  }
  const consultation = value;
  const consulted = consultation.consulted;
  if (!Array.isArray(consulted)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition consultation consulted must be an array (may be empty)",
    });
  }
  for (const recommendation of consulted) {
    validateConsultedCompositionRecommendation(recommendation);
  }
  if (
    consultation.preferredStrategyId !== null &&
    (typeof consultation.preferredStrategyId !== "string" ||
      consultation.preferredStrategyId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition consultation preferredStrategyId must be a non-empty string or null",
    });
  }
  if (typeof consultation.agreesWithSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition consultation agreesWithSelection must be a boolean",
    });
  }
  requireString(consultation, "consultedAt", "consultedAt");
}

/**
 * THE policy gate (M5): whether a recommendation's pinned tools are
 * ALL admissible under the CURRENT effective restriction set's tool
 * dimension. A forbidden tool makes the whole recommendation
 * non-admissible REGARDLESS of its learning score (§9: a high score
 * can never make a forbidden tool admissible).
 */
export function compositionAllowedByPolicy(
  toolIds: readonly string[],
  tool: RestrictionSet["tool"],
): boolean {
  if (tool === undefined) {
    return true;
  }
  const { allowedTools, deniedTools } = tool;
  for (const toolId of toolIds) {
    if (deniedTools?.includes(toolId) === true) {
      return false;
    }
    if (allowedTools !== undefined && allowedTools.length > 0 && !allowedTools.includes(toolId)) {
      return false;
    }
  }
  return true;
}

/**
 * Learning's preference among ADMISSIBLE candidates (pure, recorded as
 * evidence — never applied to the live selection).
 *
 * A recommendation QUALIFIES when it is: 'supported', ranked,
 * policy-allowed under the effective restriction set (M5), carries
 * population >= the frozen floor, and its uncertainty level is not
 * 'high'. A candidate ALIGNs with a recommendation when the candidate's
 * call-tool step capability ids equal the recommendation's tool
 * capability ids (the tool-composition alignment — order-insensitive
 * set equality on the capability vocabulary both sides speak).
 *
 * The preferred candidate is the one aligned with the BEST-qualifying
 * (lowest rank) recommendation; ties break on the candidate's position
 * in the input order (deterministic). Inadmissible candidates NEVER
 * qualify (M1: a learned recommendation cannot authorize a forbidden
 * route; M23: a deterministic-sufficient selection is never displaced
 * — the preference is recorded evidence only).
 */
export function compositionPreferredCandidateId(
  candidates: readonly CandidateStrategy[],
  recommendations: readonly ConsultedCompositionRecommendation[],
  policy: RestrictionSet,
): string | null {
  const qualifying = recommendations
    .filter(
      (recommendation) =>
        recommendation.status === "supported" &&
        recommendation.rank !== null &&
        recommendation.population >= COMPOSITION_PREFERENCE_MINIMUM_POPULATION &&
        recommendation.confidenceLevel !== PREFERENCE_BLOCKING_UNCERTAINTY &&
        compositionAllowedByPolicy(
          recommendation.toolVersions.map((tool) => tool.toolId),
          policy.tool,
        ),
    )
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));

  for (const recommendation of qualifying) {
    const requiredCapabilities = new Set(recommendation.toolCapabilityIds);
    for (const candidate of candidates) {
      if (!candidate.admissible) {
        continue;
      }
      const candidateCapabilities = candidate.plan.steps
        .filter((step) => step.stepClass === "call-tool" && step.capabilityId !== undefined)
        .map((step) => step.capabilityId as string);
      if (candidateCapabilities.length === 0) {
        continue;
      }
      const candidateSet = new Set(candidateCapabilities);
      if (
        candidateSet.size === requiredCapabilities.size &&
        [...requiredCapabilities].every((capability) => candidateSet.has(capability))
      ) {
        return candidate.strategyId;
      }
    }
  }
  return null;
}

/** Build the consultation capture (validating every recommendation again). */
export function buildCompositionConsultation(input: {
  readonly candidates: readonly CandidateStrategy[];
  readonly recommendations: readonly ConsultedCompositionRecommendation[];
  readonly policy: RestrictionSet;
  readonly selectedStrategyId: string;
  readonly consultedAt: string;
}): CompositionConsultation {
  for (const recommendation of input.recommendations) {
    validateConsultedCompositionRecommendation(recommendation);
  }
  const preferredStrategyId = compositionPreferredCandidateId(
    input.candidates,
    input.recommendations,
    input.policy,
  );
  return {
    consulted: input.recommendations.map((recommendation) => ({ ...recommendation })),
    preferredStrategyId,
    agreesWithSelection: preferredStrategyId === input.selectedStrategyId,
    consultedAt: input.consultedAt,
  };
}
