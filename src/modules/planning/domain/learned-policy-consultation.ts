/**
 * Learned planning-policy consultation capture (planning module
 * domain; WORK-020 / LRN-002, `spec/architecture.md` §2.11/§19).
 *
 * THE PLANNING-SIDE READ SEAM OF LEARNED PLANNING POLICIES. When the
 * planner is wired with a learned-policy source, it consults the
 * ACTIVE publication's route preferences AFTER every hard authority
 * has spoken (policy inputs → capability resolution → deterministic
 * sufficiency → candidate composition → the HARD policy admissibility
 * filter) and BEFORE the cascade selection — because a PUBLISHED
 * learned policy refines the ORDERING among already-admissible
 * choices:
 *
 *  - a learned preference may only REFINE the ordering among
 *    candidates the current effective policy ALREADY permits — it can
 *    never widen, bypass or override a prohibition (the admissibility
 *    filter ran before the preference exists; see
 *    `learnedPolicyConsultation` rejections for the belt-and-braces
 *    recheck at consultation time);
 *  - only a 'promoted' publication carries ordering influence: a
 *    'canary' publication (or no publication at all) records its
 *    preference as DIVERGENCE EVIDENCE and never changes the live
 *    selection (M-canary: shadow/canary cannot silently become
 *    authoritative);
 *  - the deterministic-first preference is UNTOUCHABLE (ADR-0007):
 *    `selectStrategy` applies the learned ordering ONLY inside the
 *    cheap-first cascade — a deterministic-sufficient selection is
 *    never displaced by a learned preference;
 *  - the consulted record carries its FULL versioning basis (the
 *    policy id + version, the publication id + mode + reason, the
 *    digest, the analysis/telemetry schema anchors, the evaluation
 *    window and the non-empty per-preference provenance) — an
 *    unversioned or unprovenanced record fails closed in
 *    `validateConsultedLearnedPolicy` and never enters a durable
 *    decision record;
 *  - the record class is pinned to the frozen non-authoritative class
 *    (LEARNED PLANNING POLICY ≠ POLICY AUTHORITY — the §10
 *    invariant; the policies module's restriction-vocabulary boundary
 *    scan runs at the consumer seam and rejects any smuggled
 *    prohibition vocabulary).
 *
 * This file is pure domain: no side effects, no learning module
 * import (the port/adapter seam lives in ports/adapters).
 */

import { PlatformError } from "../../../shared/errors";
import type { RestrictionSet } from "../../policies/public";
import type { CandidateStrategy } from "./strategy";
import { compareCheapFirst, routeAllowedByPolicy } from "./strategy";

/** The frozen non-authority class carried by consulted learned policies. */
export const CONSULTED_LEARNED_POLICY_CLASS = "non-authoritative-learned-planning-policy" as const;

/** The publication modes a consulted policy can carry (shadow is pre-publication). */
export const CONSULTED_LEARNED_POLICY_MODES = ["canary", "promoted"] as const;
export type ConsultedLearnedPolicyMode = (typeof CONSULTED_LEARNED_POLICY_MODES)[number];

/**
 * A ranked route subject as captured in a durable planning decision.
 * Consumer-side mirror of the learning module's public
 * `LearnedRouteMetric` (planning validates what it consumes).
 */
export interface ConsultedLearnedRouteMetric {
  readonly subjectKey: string;
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  readonly meanCostMicroUsd: string;
  readonly meanLatencyMs: number;
  readonly uncertaintyLevel: string;
}

/** A task-class preference as captured in a durable planning decision. */
export interface ConsultedLearnedRoutePreference {
  readonly taskClass: string;
  /** Ranked subjects, DESCENDING preference (index 0 = most preferred). */
  readonly ranked: readonly ConsultedLearnedRouteMetric[];
  readonly confidenceLevel: string;
  readonly population: number;
  readonly windowFrom: string | null;
  readonly windowTo: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceExecutionIds: readonly string[];
}

/**
 * The consulted learned policy (the ACTIVE publication's projection).
 * Carries the FULL versioning + publication anchors (fail-closed
 * validated before it can enter a decision record).
 */
export interface ConsultedLearnedPolicy {
  readonly policyClass: typeof CONSULTED_LEARNED_POLICY_CLASS;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly publicationId: string;
  readonly publicationMode: ConsultedLearnedPolicyMode;
  readonly publicationReason: string;
  readonly analysisVersion: number;
  readonly telemetrySchemaVersion: number;
  readonly digest: string;
  readonly evaluationWindowFrom: string | null;
  readonly evaluationWindowTo: string;
  readonly preferences: readonly ConsultedLearnedRoutePreference[];
  readonly publishedAt: string;
}

/** The consultation capture recorded on the planning decision. */
export interface LearnedPolicyConsultation {
  readonly consultedPolicy: ConsultedLearnedPolicy;
  /**
   * The GOVERNED selection (the learning-free deterministic-first /
   * cheap-first result) — the audit anchor the refined selection is
   * compared against.
   */
  readonly governedStrategyId: string;
  /** The learned preference among ADMISSIBLE candidates (null: none). */
  readonly preferredStrategyId: string | null;
  /** Whether the learned preference agrees with the LIVE selection. */
  readonly agreesWithSelection: boolean;
  /**
   * True ONLY when a 'promoted' publication's ordering refined the
   * live selection away from the governed default (canary/shadow
   * never set this — they cannot become authoritative).
   */
  readonly appliedToSelection: boolean;
  /** Subjects dropped by the CURRENT-policy recheck at consultation time. */
  readonly rejectedByPolicy: readonly string[];
  /** Ranked subjects matching NO admissible candidate (never introducible). */
  readonly unmatchedSubjects: readonly string[];
  readonly consultedAt: string;
}

/** Minimum population for a ranked subject to inform ordering (frozen floor). */
export const LEARNED_PREFERENCE_MINIMUM_POPULATION = 5;

/** Uncertainty levels that disqualify a ranked subject from ordering. */
const PREFERENCE_BLOCKING_UNCERTAINTY = "high";

const MICRO_USD_INT = /^\d{1,19}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted learned policy ${what} must be a non-empty string (versioning/publication anchors)`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Fail-closed validation of a consulted learned policy (the
 * consumer-side boundary): the full versioning and publication basis
 * must be present, every ranked subject must meet the population
 * floor with honest uncertainty, and every preference must carry
 * non-empty provenance. An unversioned or unprovenanced record is
 * rejected — it never enters a decision record.
 */
export function validateConsultedLearnedPolicy(
  value: unknown,
): asserts value is ConsultedLearnedPolicy {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted learned policy must be an object",
    });
  }
  const policy = value;
  if (policy.policyClass !== CONSULTED_LEARNED_POLICY_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted learned policy must carry the frozen non-authority class (a learned policy artifact is never a policy authority)",
      details: { expected: CONSULTED_LEARNED_POLICY_CLASS },
    });
  }
  for (const key of [
    "policyId",
    "publicationId",
    "digest",
    "evaluationWindowTo",
    "publishedAt",
  ] as const) {
    requireString(policy, key, key);
  }
  for (const key of ["policyVersion", "analysisVersion", "telemetrySchemaVersion"] as const) {
    const number = policy[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted learned policy ${key} must be a positive integer (version anchors)`,
        details: { field: key },
      });
    }
  }
  if (
    typeof policy.publicationMode !== "string" ||
    !(CONSULTED_LEARNED_POLICY_MODES as readonly string[]).includes(policy.publicationMode)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted learned policy publicationMode must be 'canary' or 'promoted' (shadow is pre-publication evaluation)",
      details: { allowed: CONSULTED_LEARNED_POLICY_MODES },
    });
  }
  requireString(policy, "publicationReason", "publicationReason");
  const preferences = policy.preferences;
  if (!Array.isArray(preferences)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted learned policy preferences must be an array",
      details: { field: "preferences" },
    });
  }
  for (const preference of preferences) {
    if (!isRecord(preference)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "consulted learned route preference must be an object",
      });
    }
    requireString(preference, "taskClass", "preference taskClass");
    requireString(preference, "confidenceLevel", "preference confidenceLevel");
    requireString(preference, "windowTo", "preference windowTo");
    const ranked = preference.ranked;
    if (!Array.isArray(ranked) || ranked.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "consulted learned route preference ranked must be non-empty (the honest-evidence floor)",
        details: { field: "ranked" },
      });
    }
    for (const metric of ranked) {
      if (!isRecord(metric)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "consulted ranked route metric must be an object",
        });
      }
      requireString(metric, "subjectKey", "ranked subjectKey");
      requireString(metric, "uncertaintyLevel", "ranked uncertaintyLevel");
      if (
        typeof metric.population !== "number" ||
        !Number.isInteger(metric.population) ||
        metric.population < LEARNED_PREFERENCE_MINIMUM_POPULATION
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "consulted ranked subjects must meet the frozen population floor (honest evidence only)",
          details: { field: "population", minimum: LEARNED_PREFERENCE_MINIMUM_POPULATION },
        });
      }
      if (
        typeof metric.successCount !== "number" ||
        !Number.isInteger(metric.successCount) ||
        metric.successCount < 0 ||
        metric.successCount > metric.population
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "consulted ranked successCount must be an integer within [0, population]",
          details: { field: "successCount" },
        });
      }
      if (
        typeof metric.successRate !== "number" ||
        metric.successRate < 0 ||
        metric.successRate > 1
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "consulted ranked successRate must be in [0,1]",
          details: { field: "successRate" },
        });
      }
      if (
        typeof metric.meanCostMicroUsd !== "string" ||
        !MICRO_USD_INT.test(metric.meanCostMicroUsd)
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "consulted ranked meanCostMicroUsd must be an integer micro-USD string",
          details: { field: "meanCostMicroUsd" },
        });
      }
      if (
        typeof metric.meanLatencyMs !== "number" ||
        !Number.isInteger(metric.meanLatencyMs) ||
        metric.meanLatencyMs < 0
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "consulted ranked meanLatencyMs must be a non-negative integer",
          details: { field: "meanLatencyMs" },
        });
      }
    }
    for (const key of ["evidenceRefs", "sourceExecutionIds"] as const) {
      const refs = preference[key];
      if (
        !Array.isArray(refs) ||
        refs.length === 0 ||
        refs.some((ref) => typeof ref !== "string" || ref.length === 0)
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `consulted learned route preference ${key} must be non-empty (provenance)`,
          details: { field: key },
        });
      }
    }
  }
}

/** Validate a full consultation capture (decision-record round-trip). */
export function validateLearnedPolicyConsultation(
  value: unknown,
): asserts value is LearnedPolicyConsultation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy consultation must be an object",
    });
  }
  const consultation = value;
  validateConsultedLearnedPolicy(consultation.consultedPolicy);
  requireString(consultation, "governedStrategyId", "governedStrategyId");
  if (
    consultation.preferredStrategyId !== null &&
    (typeof consultation.preferredStrategyId !== "string" ||
      consultation.preferredStrategyId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy consultation preferredStrategyId must be a non-empty string or null",
    });
  }
  if (typeof consultation.agreesWithSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy consultation agreesWithSelection must be a boolean",
    });
  }
  if (typeof consultation.appliedToSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy consultation appliedToSelection must be a boolean",
    });
  }
  for (const key of ["rejectedByPolicy", "unmatchedSubjects"] as const) {
    const list = consultation[key];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `learned policy consultation ${key} must be an array of strings`,
        details: { field: key },
      });
    }
  }
  requireString(consultation, "consultedAt", "consultedAt");
}

/**
 * Split a ranked-subject list into (allowed, rejected) under the
 * CURRENT effective policy (the belt-and-braces consultation-time
 * recheck — a forbidden subject NEVER becomes an ordering input even
 * if the admissibility filter was already applied to the candidates).
 */
export function splitRankedSubjectsByPolicy(
  ranked: readonly ConsultedLearnedRouteMetric[],
  policy: RestrictionSet,
): { readonly allowed: readonly string[]; readonly rejected: readonly string[] } {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const metric of ranked) {
    const separator = metric.subjectKey.indexOf("/");
    const provider = separator === -1 ? metric.subjectKey : metric.subjectKey.slice(0, separator);
    const model = separator === -1 ? "" : metric.subjectKey.slice(separator + 1);
    if (routeAllowedByPolicy(provider, model, policy.providerModel)) {
      allowed.push(metric.subjectKey);
    } else {
      rejected.push(metric.subjectKey);
    }
  }
  return { allowed, rejected };
}

/**
 * The learned ordering input for `selectStrategy`: the ranked subject
 * keys (descending preference) that passed the population floor, the
 * uncertainty filter and the CURRENT-policy recheck. Subjects a
 * 'promoted' policy prefers but the policy forbids are EXCLUDED here
 * (recorded as `rejectedByPolicy` by the capture builder) — they can
 * never enter an ordering.
 */
export function learnedOrderingSubjects(
  preference: ConsultedLearnedRoutePreference,
  policy: RestrictionSet,
): readonly string[] {
  const { allowed } = splitRankedSubjectsByPolicy(preference.ranked, policy);
  return preference.ranked
    .filter(
      (metric) =>
        allowed.includes(metric.subjectKey) &&
        metric.uncertaintyLevel !== PREFERENCE_BLOCKING_UNCERTAINTY,
    )
    .map((metric) => metric.subjectKey);
}

/**
 * The learned preference among ADMISSIBLE candidates (pure): the
 * candidate whose best-ranked subject (by the consulted preference's
 * ranking, policy-rechecked) is ranked highest. Inadmissible
 * candidates NEVER qualify; a candidate with no ranked subject never
 * qualifies (a learned preference cannot introduce anything).
 */
export function learnedPreferredCandidateId(
  candidates: readonly CandidateStrategy[],
  preference: ConsultedLearnedRoutePreference,
  policy: RestrictionSet,
): string | null {
  const ordering = learnedOrderingSubjects(preference, policy);
  if (ordering.length === 0) {
    return null;
  }
  let preferredStrategyId: string | null = null;
  let preferredRank = Number.MAX_SAFE_INTEGER;
  for (const candidate of candidates) {
    if (!candidate.admissible) {
      continue;
    }
    const subjects = candidate.plan.steps
      .map((step) =>
        step.routeRef === undefined ? null : `${step.routeRef.provider}/${step.routeRef.model}`,
      )
      .filter((subject): subject is string => subject !== null);
    const rank = subjects.reduce((best, subject) => {
      const index = ordering.indexOf(subject);
      return index === -1 ? best : Math.min(best, index);
    }, Number.MAX_SAFE_INTEGER);
    if (rank !== Number.MAX_SAFE_INTEGER && rank < preferredRank) {
      preferredRank = rank;
      preferredStrategyId = candidate.strategyId;
    }
  }
  return preferredStrategyId;
}

/**
 * Ordering key for the learned-preference cascade: candidates whose
 * route subjects the (policy-rechecked, uncertainty-filtered)
 * ordering prefers come FIRST; ties break cheap-first; candidates
 * with no ranked subject keep the pure cheap-first order.
 */
export function compareLearnedThenCheapFirst(
  a: CandidateStrategy,
  b: CandidateStrategy,
  learnedOrder: readonly string[],
): number {
  const rankOf = (candidate: CandidateStrategy): number => {
    const subjects = candidate.plan.steps
      .map((step) =>
        step.routeRef === undefined ? null : `${step.routeRef.provider}/${step.routeRef.model}`,
      )
      .filter((subject): subject is string => subject !== null);
    return subjects.reduce((best, subject) => {
      const index = learnedOrder.indexOf(subject);
      return index === -1 ? best : Math.min(best, index);
    }, Number.MAX_SAFE_INTEGER);
  };
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }
  return compareCheapFirst(a, b);
}

/** Build the consultation capture (validating the consulted policy again). */
export function buildLearnedPolicyConsultation(input: {
  readonly candidates: readonly CandidateStrategy[];
  readonly consultedPolicy: ConsultedLearnedPolicy;
  readonly taskClass: string;
  readonly policy: RestrictionSet;
  readonly governedStrategyId: string;
  readonly selectedStrategyId: string;
  readonly appliedToSelection: boolean;
  readonly consultedAt: string;
}): LearnedPolicyConsultation {
  validateConsultedLearnedPolicy(input.consultedPolicy);
  const preference = input.consultedPolicy.preferences.find(
    (candidate) => candidate.taskClass === input.taskClass,
  );
  const rejectedByPolicy: string[] = [];
  if (preference !== undefined) {
    const { rejected } = splitRankedSubjectsByPolicy(preference.ranked, input.policy);
    rejectedByPolicy.push(...rejected);
  }
  // Ranked subjects matching NO admissible candidate: the learned
  // preference names something the current candidate pool does not
  // contain — it can never be introduced (unregistered capability).
  const admissibleSubjects = new Set(
    input.candidates
      .filter((candidate) => candidate.admissible)
      .flatMap((candidate) =>
        candidate.plan.steps
          .map((step) =>
            step.routeRef === undefined ? null : `${step.routeRef.provider}/${step.routeRef.model}`,
          )
          .filter((subject): subject is string => subject !== null),
      ),
  );
  const unmatchedSubjects =
    preference === undefined
      ? []
      : preference.ranked
          .map((metric) => metric.subjectKey)
          .filter((subject) => !admissibleSubjects.has(subject));
  const preferredStrategyId =
    preference === undefined
      ? null
      : learnedPreferredCandidateId(input.candidates, preference, input.policy);
  return {
    consultedPolicy: { ...input.consultedPolicy },
    governedStrategyId: input.governedStrategyId,
    preferredStrategyId,
    agreesWithSelection: preferredStrategyId === input.selectedStrategyId,
    appliedToSelection: input.appliedToSelection,
    rejectedByPolicy: [...new Set(rejectedByPolicy)].sort(),
    unmatchedSubjects: [...new Set(unmatchedSubjects)].sort(),
    consultedAt: input.consultedAt,
  };
}
