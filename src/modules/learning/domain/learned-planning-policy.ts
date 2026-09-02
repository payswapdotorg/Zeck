/**
 * Learned planning-policy artifacts, evaluations and the publication
 * journal (learning module domain; WORK-020 / LRN-002,
 * `spec/architecture.md` §2.11/§19).
 *
 * THE ARTIFACT: a `LearnedPlanningPolicy` is an immutable, VERSIONED
 * route-preference ordering mined from the immutable telemetry
 * population — ADVISORY EVIDENCE, never authority:
 *
 * ```text
 *   LEARNED PLANNING POLICY  ≠  POLICY AUTHORITY   (the §10 invariant)
 * ```
 *
 * The artifact carries ONLY preferences (per-task-class ranked route
 * subjects with their honest observed metrics). It has NO restriction
 * fields, NO prohibition vocabulary, NO cost/quality/latency ceilings,
 * NO allowlists and NO denylists — a learned output is STRUCTURALLY
 * incapable of expressing, widening, narrowing or overriding a hard
 * policy prohibition (AC-2: hard prohibitions are immutable to
 * learning output; the policies module's restriction-vocabulary
 * boundary scan enforces this mechanically at the consumer seam).
 * A learned preference may only REFINE the ordering among choices the
 * current effective policy already permits.
 *
 * THE LIFECYCLE (all durable state is learning-owned observational
 * material — the authority chain is untouched):
 *
 * ```text
 *   immutable telemetry population
 *     → mineLearnedRoutePreferences (pure, honest-confidence ranking)
 *     → versioned immutable policy artifact (version-arbitrated append)
 *     → shadow evaluation against the LATEST durable scorecard
 *       (pre-publication, zero live effect — the WORK-014 discipline)
 *     → explicit publication, mode 'canary' (bounded: recorded
 *       divergence evidence only — never an ordering input)
 *     → canary evaluation (evaluation of a policy that RAN in canary,
 *       bound to the exact canary publication)
 *     → explicit publication, mode 'promoted' (requires BOTH the
 *       shadow and the canary evaluation evidence, digest-verified
 *       against the durable records — revision-bound)
 *     → rollback: publish a PRIOR promoted version (an ordinary
 *       journal append with reason 'rollback' — history is never
 *       rewritten; the artifact's rollback metadata names the exact
 *       prior version + digest, so rollback is deterministic)
 * ```
 *
 * PUBLICATION IS AN EXPLICIT GATE (AC-4): nothing influences any
 * execution choice until a publication entry exists, and only a
 * 'promoted' publication can carry ordering influence (AC-3's
 * shadow/canary-before-promotion ordering is enforced by the
 * publication requirements themselves: canary requires a completed
 * shadow evaluation; promoted requires shadow + canary).
 *
 * CONFIDENCE IS MEASURABLE OR ABSENT (§13): every ranked subject
 * carries the integer population, success counts, the point rate,
 * mean cost/latency and an honest uncertainty classification derived
 * from the binomial spread. Below the frozen population floor a
 * subject is NOT ranked (never a fabricated "low-confidence but
 * executable" hint).
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionOutcomeTelemetry } from "./telemetry";
import { TELEMETRY_SCHEMA_VERSION } from "./telemetry";

// ---------------------------------------------------------------------------
// Frozen vocabularies and identity anchors
// ---------------------------------------------------------------------------

/**
 * Machine-readable non-authority class carried by every learned
 * planning-policy artifact (the §10 invariant, mirrored by the
 * planning-side consultation capture).
 */
export const LEARNED_POLICY_CLASS = "non-authoritative-learned-planning-policy" as const;

/** The learned planning-policy artifact schema version. */
export const LEARNED_POLICY_SCHEMA_VERSION = 1;

/** The learned policy evaluation record schema version. */
export const LEARNED_POLICY_EVALUATION_SCHEMA_VERSION = 1;

/** The learned policy publication journal schema version. */
export const LEARNED_POLICY_PUBLICATION_SCHEMA_VERSION = 1;

/** Frozen mining/ranking algorithm identity (evidence model version). */
export const LEARNED_POLICY_ANALYSIS_VERSION = 1;

/**
 * Minimum population for a route subject to be RANKED (the
 * honest-evidence floor; below it the subject is never ranked — a
 * small sample never becomes executable guidance).
 */
export const MINIMUM_PREFERENCE_POPULATION = 5;

/** The modes a publication may carry (shadow is pre-publication evaluation). */
export const LEARNED_POLICY_PUBLICATION_MODES = ["canary", "promoted"] as const;
export type LearnedPolicyPublicationMode = (typeof LEARNED_POLICY_PUBLICATION_MODES)[number];

/** The honest publication reasons (the activation-journal vocabulary). */
export const LEARNED_POLICY_PUBLICATION_REASONS = ["initial", "rollback", "refresh"] as const;
export type LearnedPolicyPublicationReason = (typeof LEARNED_POLICY_PUBLICATION_REASONS)[number];

/** The evaluation kinds (shadow = pre-publication; canary = ran-in-canary). */
export const LEARNED_POLICY_EVALUATION_KINDS = ["shadow", "canary"] as const;
export type LearnedPolicyEvaluationKind = (typeof LEARNED_POLICY_EVALUATION_KINDS)[number];

/** The honest evaluation statuses. */
export const LEARNED_POLICY_EVALUATION_STATUSES = [
  "insufficient-evidence",
  "inconclusive",
  "evaluated",
] as const;
export type LearnedPolicyEvaluationStatus = (typeof LEARNED_POLICY_EVALUATION_STATUSES)[number];

/** The honest comparison verdicts (uncertainty is preserved, not collapsed). */
export const LEARNED_POLICY_VERDICTS = [
  "prefer-learned",
  "prefer-baseline",
  "inconclusive",
] as const;
export type LearnedPolicyVerdict = (typeof LEARNED_POLICY_VERDICTS)[number];

export function isLearnedPolicyPublicationMode(
  value: string,
): value is LearnedPolicyPublicationMode {
  return (LEARNED_POLICY_PUBLICATION_MODES as readonly string[]).includes(value);
}

export function isLearnedPolicyEvaluationKind(value: string): value is LearnedPolicyEvaluationKind {
  return (LEARNED_POLICY_EVALUATION_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The artifact: versioned immutable route preferences
// ---------------------------------------------------------------------------

/** One ranked route subject with its honest observed metrics. */
export interface LearnedRouteMetric {
  /** Opaque neutral subject key ("provider/model" — never an SDK type). */
  readonly subjectKey: string;
  /** Integer population — executions of this task class observing the subject. */
  readonly population: number;
  /** Integer count of successful (execution-completed) outcomes. */
  readonly successCount: number;
  /** Point success rate in [0,1] (derived from integers, recorded). */
  readonly successRate: number;
  /** Honest uncertainty classification (never collapsed). */
  readonly uncertaintyLevel: string;
  readonly uncertaintyReasonCode: string;
  /** Mean observed cost — integer micro-USD string. */
  readonly meanCostMicroUsd: string;
  /** Mean observed latency — integer milliseconds. */
  readonly meanLatencyMs: number;
}

/**
 * The per-task-class preference: the ranked subjects of ONE task class
 * in DESCENDING preference order (index 0 = the most preferred). Only
 * subjects with population >= the frozen floor are ranked.
 */
export interface LearnedRoutePreference {
  readonly taskClass: string;
  readonly ranked: readonly LearnedRouteMetric[];
  /** The honest confidence of the whole preference (worst ranked subject). */
  readonly confidence: {
    readonly level: "low" | "material" | "high";
    readonly reasonCode: string;
    readonly detail: string;
  };
  /** Contributing executions of the task class (integer). */
  readonly population: number;
  readonly windowFrom: string | null;
  readonly windowTo: string;
  /** Source executions — MANDATORY, non-empty (provenance). */
  readonly sourceExecutionIds: readonly string[];
  /** Evidence references — MANDATORY, non-empty (provenance). */
  readonly evidenceRefs: readonly string[];
}

/** Deterministic rollback metadata carried on every artifact version. */
export interface LearnedPolicyRollbackMetadata {
  /**
   * The prior policy version a rollback deterministically returns to
   * (null on the first version — nothing to roll back to).
   */
  readonly rollbackToPolicyVersion: number | null;
  /** sha256 digest of the prior policy version (null on the first version). */
  readonly priorPolicyDigest: string | null;
  readonly note: string;
}

/** The immutable, versioned learned planning-policy artifact (migration 0017 shape). */
export interface LearnedPlanningPolicy {
  /** Frozen non-authority marker (§10 — "policy artifact", never "policy authority"). */
  readonly policyClass: typeof LEARNED_POLICY_CLASS;
  readonly policyId: string;
  /** Monotonic version within the application scope. */
  readonly policyVersion: number;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly analysisVersion: number;
  readonly telemetrySchemaVersion: number;
  /** Population replay identity (regenerating the same basis converges). */
  readonly populationFingerprint: string;
  readonly totalPopulation: number;
  readonly evaluationWindowFrom: string | null;
  readonly evaluationWindowTo: string;
  /** NON-EMPTY: at least one task class with one ranked subject. */
  readonly preferences: readonly LearnedRoutePreference[];
  readonly rollback: LearnedPolicyRollbackMetadata;
  readonly generatedAt: string;
  /** sha256 over the canonical artifact basis (integrity for consumers). */
  readonly digest: string;
  readonly policySchemaVersion: number;
}

// ---------------------------------------------------------------------------
// The evaluation record: shadow / canary evidence (immutable)
// ---------------------------------------------------------------------------

/** The exact scorecard version an evaluation consulted (revision-bound basis). */
export type LearnedPolicyEvaluationBasis =
  | {
      readonly kind: "scorecard";
      readonly scorecardId: string;
      readonly scorecardVersion: number;
      readonly definitionId: string;
      readonly definitionVersion: number;
      readonly telemetrySchemaVersion: number;
      readonly populationWindowFrom: string | null;
      readonly populationWindowTo: string;
    }
  | { readonly kind: "none" };

/** The comparison metrics (honest, uncertainty preserved). */
export interface LearnedPolicyEvaluationMetrics {
  /** Mean success rate of the learned side's per-class top picks. */
  readonly learnedMeanSuccessRate: number;
  /** Mean success rate of the baseline side's per-class picks. */
  readonly baselineMeanSuccessRate: number;
  readonly learnedPopulation: number;
  readonly baselinePopulation: number;
  /** Honest 2-sigma spreads on each side (never collapsed). */
  readonly learnedSpread: number;
  readonly baselineSpread: number;
  /** Task classes that produced a comparable pair (non-empty when evaluated). */
  readonly taskClasses: readonly string[];
}

/** A canary evaluation MUST bind the exact canary publication it observes. */
export interface LearnedPolicyCanaryBinding {
  readonly publicationId: string;
  readonly publishedAt: string;
}

/** The durable learned-policy evaluation record (migration 0017 shape). */
export interface LearnedPolicyEvaluation {
  readonly evaluationId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly evaluationClass: LearnedPolicyEvaluationKind;
  readonly status: LearnedPolicyEvaluationStatus;
  readonly verdict: LearnedPolicyVerdict | null;
  readonly metrics: LearnedPolicyEvaluationMetrics | null;
  readonly comparison: {
    readonly preferred: "learned" | "baseline" | "inconclusive";
    readonly uncertainty: string;
    readonly rationale: string;
  } | null;
  readonly basis: LearnedPolicyEvaluationBasis;
  /** REQUIRED for canary evaluations (the ran-in-canary proof). */
  readonly canaryBinding: LearnedPolicyCanaryBinding | null;
  readonly evidenceRefs: readonly string[];
  readonly sourceExecutionIds: readonly string[];
  readonly evaluatedAt: string;
  readonly schemaVersion: number;
}

// ---------------------------------------------------------------------------
// The publication journal (append-only deployment state)
// ---------------------------------------------------------------------------

/** Revision-bound evaluation evidence referenced by a publication. */
export interface PublicationEvidenceReference {
  readonly evaluationId: string;
  readonly evaluationClass: LearnedPolicyEvaluationKind;
  /** sha256 digest of the durable evaluation record (integrity). */
  readonly evaluationDigest: string;
  readonly evaluatedAt: string;
}

/** The append-only publication entry (the deployment journal). */
export interface LearnedPolicyPublication {
  /** Content-derived identity (the same logical request converges). */
  readonly publicationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly publicationMode: LearnedPolicyPublicationMode;
  readonly publicationReason: LearnedPolicyPublicationReason;
  /** NON-EMPTY: the revision-bound evaluation evidence for this publication. */
  readonly evaluationEvidence: readonly PublicationEvidenceReference[];
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly publicationSchemaVersion: number;
}

// ---------------------------------------------------------------------------
// Mining: route preferences from the immutable population (pure)
// ---------------------------------------------------------------------------

interface SubjectAccumulator {
  readonly subjectKey: string;
  population: number;
  successCount: number;
  costSumMicroUsd: bigint;
  latencySumMs: number;
}

interface TaskClassAccumulator {
  readonly taskClass: string;
  readonly subjects: Map<string, SubjectAccumulator>;
  population: number;
  windowFrom: string | null;
  windowTo: string;
  readonly executionIds: Set<string>;
  readonly evidenceRefs: Set<string>;
}

function uncertaintyOf(population: number): {
  readonly level: "low" | "material" | "high";
  readonly reasonCode: string;
} {
  const spread = 2 * Math.sqrt(0.25 / population);
  if (spread > 0.4) {
    return { level: "high", reasonCode: "binomial-spread" };
  }
  if (spread > 0.2) {
    return { level: "material", reasonCode: "binomial-spread" };
  }
  return { level: "low", reasonCode: "adequate-population" };
}

function meanMicroUsd(sum: bigint, count: number): string {
  if (count === 0) {
    return "0";
  }
  return (sum / BigInt(count)).toString(10);
}

/**
 * Mine the route-preference ordering from the immutable telemetry
 * population (pure, deterministic, honest):
 *
 *  - observations group by (taskClass, route subject);
 *  - a subject QUALIFIES only with population >= the frozen floor;
 *  - ranking within a task class: success rate descending, ties break
 *    on lower mean cost, then lower mean latency, then the subject key
 *    (a total deterministic order);
 *  - task classes without ANY qualifying subject produce NO preference
 *    (uncertainty is preserved, never amplified into guidance);
 *  - an EMPTY result means the population carries no rankable evidence.
 */
export function mineLearnedRoutePreferences(
  population: readonly ExecutionOutcomeTelemetry[],
  options?: { readonly minimumPopulation?: number },
): readonly LearnedRoutePreference[] {
  const minimumPopulation = options?.minimumPopulation ?? MINIMUM_PREFERENCE_POPULATION;
  const classes = new Map<string, TaskClassAccumulator>();

  for (const datum of population) {
    let accumulator = classes.get(datum.taskClass);
    if (accumulator === undefined) {
      accumulator = {
        taskClass: datum.taskClass,
        subjects: new Map(),
        population: 0,
        windowFrom: null,
        windowTo: datum.recordedAt,
        executionIds: new Set(),
        evidenceRefs: new Set(),
      };
      classes.set(datum.taskClass, accumulator);
    }
    accumulator.population += 1;
    if (accumulator.windowFrom === null || datum.recordedAt < accumulator.windowFrom) {
      accumulator.windowFrom = datum.recordedAt;
    }
    if (datum.recordedAt > accumulator.windowTo) {
      accumulator.windowTo = datum.recordedAt;
    }
    accumulator.executionIds.add(datum.executionId);
    for (const ref of datum.evidenceRefs) {
      accumulator.evidenceRefs.add(ref);
    }
    if (datum.routes.length === 0) {
      continue;
    }
    for (const route of datum.routes) {
      const subjectKey = `${route.provider}/${route.model}`;
      let subject = accumulator.subjects.get(subjectKey);
      if (subject === undefined) {
        subject = {
          subjectKey,
          population: 0,
          successCount: 0,
          costSumMicroUsd: 0n,
          latencySumMs: 0,
        };
        accumulator.subjects.set(subjectKey, subject);
      }
      subject.population += 1;
      if (datum.outcome === "execution-completed") {
        subject.successCount += 1;
      }
      subject.costSumMicroUsd += BigInt(datum.costMicroUsd);
      subject.latencySumMs += datum.latencyMs;
    }
  }

  const preferences: LearnedRoutePreference[] = [];
  for (const taskClass of [...classes.keys()].sort()) {
    const accumulator = classes.get(taskClass);
    if (accumulator === undefined) {
      continue;
    }
    const ranked = [...accumulator.subjects.values()]
      .filter((subject) => subject.population >= minimumPopulation)
      .map<LearnedRouteMetric>((subject) => {
        const uncertainty = uncertaintyOf(subject.population);
        return {
          subjectKey: subject.subjectKey,
          population: subject.population,
          successCount: subject.successCount,
          successRate: subject.successCount / subject.population,
          uncertaintyLevel: uncertainty.level,
          uncertaintyReasonCode: uncertainty.reasonCode,
          meanCostMicroUsd: meanMicroUsd(subject.costSumMicroUsd, subject.population),
          meanLatencyMs: Math.round(subject.latencySumMs / subject.population),
        };
      })
      .sort((a, b) => {
        if (a.successRate !== b.successRate) {
          return b.successRate - a.successRate;
        }
        const costOrder = BigInt(a.meanCostMicroUsd) < BigInt(b.meanCostMicroUsd) ? -1 : 1;
        if (a.meanCostMicroUsd !== b.meanCostMicroUsd) {
          return costOrder;
        }
        if (a.meanLatencyMs !== b.meanLatencyMs) {
          return a.meanLatencyMs - b.meanLatencyMs;
        }
        return a.subjectKey < b.subjectKey ? -1 : 1;
      });

    if (ranked.length === 0) {
      continue;
    }
    const uncertaintyRank: Record<string, number> = { low: 0, material: 1, high: 2 };
    let worstLevel: "low" | "material" | "high" = "low";
    let worstReasonCode = "adequate-population";
    for (const metric of ranked) {
      const metricLevel: string = metric.uncertaintyLevel;
      if ((uncertaintyRank[metricLevel] ?? 0) > (uncertaintyRank[worstLevel] ?? 0)) {
        worstLevel = metricLevel as "low" | "material" | "high";
        worstReasonCode = metric.uncertaintyReasonCode;
      }
    }
    preferences.push({
      taskClass,
      ranked,
      confidence: {
        level: worstLevel,
        reasonCode: worstReasonCode,
        detail:
          worstLevel === "low"
            ? "all ranked subjects meet the population floor with low binomial spread"
            : "the worst ranked subject carries material or high binomial spread (uncertainty preserved)",
      },
      population: accumulator.population,
      windowFrom: accumulator.windowFrom,
      windowTo: accumulator.windowTo,
      sourceExecutionIds: [...accumulator.executionIds].sort(),
      evidenceRefs: [...accumulator.evidenceRefs].sort(),
    });
  }
  return preferences;
}

// ---------------------------------------------------------------------------
// Evaluation against a durable scorecard (pure)
// ---------------------------------------------------------------------------

/** The scorecard-entry subset the evaluation logic consumes. */
export interface EvaluationScorecardLike {
  readonly scorecardId: string;
  readonly scorecardVersion: number;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly telemetrySchemaVersion: number;
  readonly populationFrom: string | null;
  readonly populationTo: string;
  readonly entries: readonly {
    readonly subjectKind: string;
    readonly subjectKey: string;
    readonly taskClass: string;
    readonly population: number;
    readonly successCount: number;
    readonly successRate: number;
    readonly meanCostMicroUsd: string;
    readonly evidenceRefs: readonly string[];
    readonly sourceExecutionIds: readonly string[];
  }[];
}

/**
 * Evaluate a learned policy against a durable scorecard (pure, honest):
 *
 *  - the LEARNED side per task class = the preference's TOP-ranked
 *    subject's scorecard entry (the pick the policy would refine to);
 *  - the BASELINE side per task class = the entry the cost-first
 *    default would pick (lowest mean cost among the class's entries
 *    that meet the population floor — the governed default ordering
 *    implied by the SAME evidence);
 *  - the comparison preserves uncertainty: overlapping 2-sigma
 *    intervals yield 'inconclusive', never a forced winner;
 *  - classes without a comparable pair are skipped; when NO class
 *    produces a pair the status is 'insufficient-evidence'.
 */
export function evaluateLearnedPolicyAgainstScorecard(
  policy: LearnedPlanningPolicy,
  scorecard: EvaluationScorecardLike | null,
): {
  readonly status: LearnedPolicyEvaluationStatus;
  readonly verdict: LearnedPolicyVerdict | null;
  readonly metrics: LearnedPolicyEvaluationMetrics | null;
  readonly comparison: LearnedPolicyEvaluation["comparison"];
  readonly basis: LearnedPolicyEvaluationBasis;
  readonly evidenceRefs: readonly string[];
  readonly sourceExecutionIds: readonly string[];
} {
  if (scorecard === null) {
    return {
      status: "insufficient-evidence",
      verdict: null,
      metrics: null,
      comparison: null,
      basis: { kind: "none" },
      evidenceRefs: [],
      sourceExecutionIds: [],
    };
  }
  const basis: LearnedPolicyEvaluationBasis = {
    kind: "scorecard",
    scorecardId: scorecard.scorecardId,
    scorecardVersion: scorecard.scorecardVersion,
    definitionId: scorecard.definitionId,
    definitionVersion: scorecard.definitionVersion,
    telemetrySchemaVersion: scorecard.telemetrySchemaVersion,
    populationWindowFrom: scorecard.populationFrom,
    populationWindowTo: scorecard.populationTo,
  };

  const learnedRates: number[] = [];
  const baselineRates: number[] = [];
  let learnedPopulation = 0;
  let baselinePopulation = 0;
  let learnedSpread = 0;
  let baselineSpread = 0;
  const taskClasses: string[] = [];
  const evidenceRefs = new Set<string>();
  const sourceExecutionIds = new Set<string>();

  for (const preference of policy.preferences) {
    const classEntries = scorecard.entries.filter(
      (entry) => entry.taskClass === preference.taskClass,
    );
    if (classEntries.length === 0) {
      continue;
    }
    const topSubject = preference.ranked[0];
    if (topSubject === undefined) {
      continue;
    }
    const learnedEntry = classEntries.find((entry) => entry.subjectKey === topSubject.subjectKey);
    if (learnedEntry === undefined) {
      continue;
    }
    const qualifying = classEntries.filter(
      (entry) => entry.population >= MINIMUM_PREFERENCE_POPULATION,
    );
    const baselineEntry = qualifying.reduce<(typeof classEntries)[number] | null>((best, entry) => {
      if (best === null) {
        return entry;
      }
      if (BigInt(entry.meanCostMicroUsd) !== BigInt(best.meanCostMicroUsd)) {
        return BigInt(entry.meanCostMicroUsd) < BigInt(best.meanCostMicroUsd) ? entry : best;
      }
      return entry.successRate > best.successRate ? entry : best;
    }, null);
    if (baselineEntry === null) {
      continue;
    }
    learnedRates.push(learnedEntry.successRate);
    baselineRates.push(baselineEntry.successRate);
    learnedPopulation = Math.max(learnedPopulation, learnedEntry.population);
    baselinePopulation = Math.max(baselinePopulation, baselineEntry.population);
    learnedSpread = Math.max(learnedSpread, 2 * Math.sqrt(0.25 / learnedEntry.population));
    baselineSpread = Math.max(baselineSpread, 2 * Math.sqrt(0.25 / baselineEntry.population));
    taskClasses.push(preference.taskClass);
    for (const ref of learnedEntry.evidenceRefs) {
      evidenceRefs.add(ref);
    }
    for (const executionId of learnedEntry.sourceExecutionIds) {
      sourceExecutionIds.add(executionId);
    }
    for (const ref of baselineEntry.evidenceRefs) {
      evidenceRefs.add(ref);
    }
    for (const executionId of baselineEntry.sourceExecutionIds) {
      sourceExecutionIds.add(executionId);
    }
  }

  if (learnedRates.length === 0) {
    return {
      status: "insufficient-evidence",
      verdict: null,
      metrics: null,
      comparison: null,
      basis,
      evidenceRefs: [],
      sourceExecutionIds: [],
    };
  }

  const learnedMeanSuccessRate =
    learnedRates.reduce((sum, rate) => sum + rate, 0) / learnedRates.length;
  const baselineMeanSuccessRate =
    baselineRates.reduce((sum, rate) => sum + rate, 0) / baselineRates.length;
  const metrics: LearnedPolicyEvaluationMetrics = {
    learnedMeanSuccessRate,
    baselineMeanSuccessRate,
    learnedPopulation,
    baselinePopulation,
    learnedSpread,
    baselineSpread,
    taskClasses: [...taskClasses].sort(),
  };
  const overlap =
    Math.abs(learnedMeanSuccessRate - baselineMeanSuccessRate) <= learnedSpread + baselineSpread;
  const uncertaintyLevel =
    learnedSpread > 0.4 || baselineSpread > 0.4
      ? "high"
      : learnedSpread > 0.2 || baselineSpread > 0.2
        ? "material"
        : "low";
  if (overlap) {
    const comparison = {
      preferred: "inconclusive" as const,
      uncertainty: uncertaintyLevel,
      rationale:
        "the success-rate intervals of the learned preferences and the cost-first baseline overlap within honest 2-sigma spread — insufficient evidence to prefer either (uncertainty preserved, never collapsed)",
    };
    return {
      status: "inconclusive",
      verdict: "inconclusive",
      metrics,
      comparison,
      basis,
      evidenceRefs: [...evidenceRefs].sort(),
      sourceExecutionIds: [...sourceExecutionIds].sort(),
    };
  }
  if (learnedMeanSuccessRate > baselineMeanSuccessRate) {
    return {
      status: "evaluated",
      verdict: "prefer-learned",
      metrics,
      comparison: {
        preferred: "learned" as const,
        uncertainty: uncertaintyLevel,
        rationale: `learned mean success rate ${learnedMeanSuccessRate.toFixed(3)} exceeds the cost-first baseline ${baselineMeanSuccessRate.toFixed(3)} with non-overlapping spread (evaluation evidence only — never production authority)`,
      },
      basis,
      evidenceRefs: [...evidenceRefs].sort(),
      sourceExecutionIds: [...sourceExecutionIds].sort(),
    };
  }
  return {
    status: "evaluated",
    verdict: "prefer-baseline",
    metrics,
    comparison: {
      preferred: "baseline" as const,
      uncertainty: uncertaintyLevel,
      rationale: `the cost-first baseline mean success rate ${baselineMeanSuccessRate.toFixed(3)} exceeds the learned preferences ${learnedMeanSuccessRate.toFixed(3)} with non-overlapping spread (evaluation evidence only — never production authority)`,
    },
    basis,
    evidenceRefs: [...evidenceRefs].sort(),
    sourceExecutionIds: [...sourceExecutionIds].sort(),
  };
}

// ---------------------------------------------------------------------------
// Validation (closed shapes — fail closed, typed)
// ---------------------------------------------------------------------------

const MICRO_USD_INT = /^\d{1,19}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `learned planning policy ${what} must be a non-empty string (max 256)`,
      details: { field: key },
    });
  }
  return value;
}

function requirePositiveInteger(
  container: Record<string, unknown>,
  key: string,
  what: string,
): number {
  const value = container[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `learned planning policy ${what} must be a positive integer`,
      details: { field: key },
    });
  }
  return value;
}

function requireRate(container: Record<string, unknown>, key: string, what: string): number {
  const value = container[key];
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `learned planning policy ${what} must be a rate in [0,1]`,
      details: { field: key },
    });
  }
  return value;
}

function requireNonEmptyStringArray(
  container: Record<string, unknown>,
  key: string,
  what: string,
): readonly string[] {
  const value = container[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `learned planning policy ${what} must be a non-empty array of non-empty strings (provenance)`,
      details: { field: key },
    });
  }
  return value as readonly string[];
}

/** Fail-closed closed-shape validation of the artifact (store round-trip). */
export function validateLearnedPlanningPolicy(
  value: unknown,
): asserts value is LearnedPlanningPolicy {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned planning policy must be an object",
    });
  }
  const policy = value;
  if (policy.policyClass !== LEARNED_POLICY_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned planning policy must carry the frozen non-authority class (a learned policy artifact is never a policy authority)",
      details: { expected: LEARNED_POLICY_CLASS, got: policy.policyClass },
    });
  }
  requireString(policy, "policyId", "policyId");
  requireString(policy, "applicationId", "applicationId");
  requireString(policy, "tenantId", "tenantId");
  requirePositiveInteger(policy, "policyVersion", "policyVersion");
  if (policy.analysisVersion !== LEARNED_POLICY_ANALYSIS_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned planning policy analysisVersion must match the frozen analysis identity",
      details: { expected: LEARNED_POLICY_ANALYSIS_VERSION },
    });
  }
  requirePositiveInteger(policy, "telemetrySchemaVersion", "telemetrySchemaVersion");
  requireString(policy, "populationFingerprint", "populationFingerprint");
  requirePositiveInteger(policy, "totalPopulation", "totalPopulation");
  requireString(policy, "evaluationWindowTo", "evaluationWindowTo");
  requireString(policy, "generatedAt", "generatedAt");
  requireString(policy, "digest", "digest");
  if (policy.policySchemaVersion !== LEARNED_POLICY_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned planning policy schema version must match the frozen artifact schema",
      details: { expected: LEARNED_POLICY_SCHEMA_VERSION },
    });
  }
  if (policy.telemetrySchemaVersion !== TELEMETRY_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned planning policy telemetrySchemaVersion must match the frozen telemetry schema",
      details: { expected: TELEMETRY_SCHEMA_VERSION },
    });
  }
  const preferences = policy.preferences;
  if (!Array.isArray(preferences) || preferences.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned planning policy preferences must be non-empty (an empty artifact is unrepresentable)",
      details: { field: "preferences" },
    });
  }
  for (const preference of preferences) {
    if (!isRecord(preference)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned route preference must be an object",
      });
    }
    requireString(preference, "taskClass", "preference taskClass");
    const ranked = preference.ranked;
    if (!Array.isArray(ranked) || ranked.length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned route preference ranked must be non-empty (the honest-evidence floor)",
        details: { field: "ranked" },
      });
    }
    for (const metric of ranked) {
      if (!isRecord(metric)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ranked route metric must be an object",
        });
      }
      requireString(metric, "subjectKey", "ranked subjectKey");
      const population = requirePositiveInteger(metric, "population", "ranked population");
      if (
        typeof metric.successCount !== "number" ||
        !Number.isInteger(metric.successCount) ||
        metric.successCount < 0 ||
        metric.successCount > population
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ranked successCount must be an integer within [0, population]",
          details: { field: "successCount" },
        });
      }
      requireRate(metric, "successRate", "ranked successRate");
      requireString(metric, "uncertaintyLevel", "ranked uncertaintyLevel");
      requireString(metric, "uncertaintyReasonCode", "ranked uncertaintyReasonCode");
      if (
        typeof metric.meanCostMicroUsd !== "string" ||
        !MICRO_USD_INT.test(metric.meanCostMicroUsd)
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ranked meanCostMicroUsd must be an integer micro-USD string",
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
          message: "ranked meanLatencyMs must be a non-negative integer",
          details: { field: "meanLatencyMs" },
        });
      }
      if (population < MINIMUM_PREFERENCE_POPULATION) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ranked subjects must meet the frozen population floor (uncertainty honesty)",
          details: { field: "population", minimum: MINIMUM_PREFERENCE_POPULATION },
        });
      }
    }
    if (!isRecord(preference.confidence)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned route preference confidence must be an object",
      });
    }
    if (
      !["low", "material", "high"].includes(String(preference.confidence.level)) ||
      typeof preference.confidence.reasonCode !== "string" ||
      preference.confidence.reasonCode.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned route preference confidence must carry the honest vocabulary",
        details: { field: "confidence" },
      });
    }
    requirePositiveInteger(preference, "population", "preference population");
    requireString(preference, "windowTo", "preference windowTo");
    requireNonEmptyStringArray(preference, "sourceExecutionIds", "preference sourceExecutionIds");
    requireNonEmptyStringArray(preference, "evidenceRefs", "preference evidenceRefs");
  }
  if (!isRecord(policy.rollback)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned planning policy must carry rollback metadata (deterministic rollback basis)",
      details: { field: "rollback" },
    });
  }
  const rollbackTo = policy.rollback.rollbackToPolicyVersion;
  if (rollbackTo !== null) {
    if (typeof rollbackTo !== "number" || !Number.isInteger(rollbackTo) || rollbackTo < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "rollback rollbackToPolicyVersion must be a positive integer or null",
        details: { field: "rollbackToPolicyVersion" },
      });
    }
    if (rollbackTo >= (policy.policyVersion as number)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "rollback metadata must point at a STRICTLY EARLIER version (deterministic rollback)",
        details: { field: "rollbackToPolicyVersion" },
      });
    }
    if (
      typeof policy.rollback.priorPolicyDigest !== "string" ||
      policy.rollback.priorPolicyDigest.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "rollback metadata with a prior version must carry the prior digest",
        details: { field: "priorPolicyDigest" },
      });
    }
  } else if (policy.rollback.priorPolicyDigest !== null) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rollback metadata without a prior version must not carry a prior digest",
      details: { field: "priorPolicyDigest" },
    });
  }
  if (typeof policy.rollback.note !== "string" || policy.rollback.note.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rollback metadata must carry a non-empty note",
      details: { field: "note" },
    });
  }
}

/** Fail-closed closed-shape validation of an evaluation record. */
export function validateLearnedPolicyEvaluation(
  value: unknown,
): asserts value is LearnedPolicyEvaluation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation must be an object",
    });
  }
  const evaluation = value;
  requireString(evaluation, "evaluationId", "evaluationId");
  requireString(evaluation, "policyId", "policyId");
  requireString(evaluation, "applicationId", "applicationId");
  requireString(evaluation, "tenantId", "tenantId");
  requirePositiveInteger(evaluation, "policyVersion", "policyVersion");
  if (
    typeof evaluation.evaluationClass !== "string" ||
    !isLearnedPolicyEvaluationKind(evaluation.evaluationClass)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation class must be 'shadow' or 'canary'",
      details: { allowed: LEARNED_POLICY_EVALUATION_KINDS },
    });
  }
  if (
    typeof evaluation.status !== "string" ||
    !(LEARNED_POLICY_EVALUATION_STATUSES as readonly string[]).includes(evaluation.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation status must be the honest status vocabulary",
      details: { allowed: LEARNED_POLICY_EVALUATION_STATUSES },
    });
  }
  if (evaluation.evaluationClass === "canary" && evaluation.status === "insufficient-evidence") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "a canary evaluation cannot be 'insufficient-evidence' (canary requires the canary publication to exist — the ran-in-canary proof)",
      details: { field: "status" },
    });
  }
  if (
    evaluation.verdict !== null &&
    (typeof evaluation.verdict !== "string" ||
      !(LEARNED_POLICY_VERDICTS as readonly string[]).includes(evaluation.verdict))
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation verdict must be the honest verdict vocabulary or null",
      details: { allowed: LEARNED_POLICY_VERDICTS },
    });
  }
  if (evaluation.status === "insufficient-evidence" && evaluation.verdict !== null) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "an insufficient-evidence evaluation carries no verdict (uncertainty honesty)",
    });
  }
  if (evaluation.evaluationClass === "canary") {
    const binding = evaluation.canaryBinding;
    if (
      !isRecord(binding) ||
      typeof binding.publicationId !== "string" ||
      binding.publicationId.length === 0 ||
      typeof binding.publishedAt !== "string" ||
      binding.publishedAt.length === 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "a canary evaluation MUST bind the exact canary publication it observed (publicationId + publishedAt)",
        details: { field: "canaryBinding" },
      });
    }
  } else if (evaluation.canaryBinding !== null) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "only a canary evaluation may carry a canary binding",
      details: { field: "canaryBinding" },
    });
  }
  const basis = evaluation.basis;
  if (!isRecord(basis)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned policy evaluation must record its basis (the exact scorecard version consulted)",
    });
  }
  if (basis.kind !== "none") {
    if (basis.kind !== "scorecard") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "learned policy evaluation basis kind must be 'scorecard' or 'none'",
      });
    }
    requireString(basis, "scorecardId", "basis scorecardId");
    requireString(basis, "definitionId", "basis definitionId");
    requirePositiveInteger(basis, "scorecardVersion", "basis scorecardVersion");
    requirePositiveInteger(basis, "definitionVersion", "basis definitionVersion");
    requirePositiveInteger(basis, "telemetrySchemaVersion", "basis telemetrySchemaVersion");
    requireString(basis, "populationWindowTo", "basis populationWindowTo");
  } else if (evaluation.status !== "insufficient-evidence") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "an evaluation with a 'none' basis can only be insufficient-evidence",
    });
  }
  if (evaluation.metrics !== null && !isRecord(evaluation.metrics)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation metrics must be an object or null",
    });
  }
  if (evaluation.comparison !== null && !isRecord(evaluation.comparison)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation comparison must be an object or null",
    });
  }
  requireString(evaluation, "evaluatedAt", "evaluatedAt");
  if (evaluation.schemaVersion !== LEARNED_POLICY_EVALUATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy evaluation schema version must match the frozen schema",
      details: { expected: LEARNED_POLICY_EVALUATION_SCHEMA_VERSION },
    });
  }
}

/** Fail-closed closed-shape validation of a publication journal entry. */
export function validateLearnedPolicyPublication(
  value: unknown,
): asserts value is LearnedPolicyPublication {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy publication must be an object",
    });
  }
  const publication = value;
  requireString(publication, "publicationId", "publicationId");
  requireString(publication, "applicationId", "applicationId");
  requireString(publication, "tenantId", "tenantId");
  requireString(publication, "policyId", "policyId");
  requirePositiveInteger(publication, "policyVersion", "policyVersion");
  if (
    typeof publication.publicationMode !== "string" ||
    !isLearnedPolicyPublicationMode(publication.publicationMode)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned policy publication mode must be 'canary' or 'promoted' (shadow is pre-publication evaluation)",
      details: { allowed: LEARNED_POLICY_PUBLICATION_MODES },
    });
  }
  if (
    typeof publication.publicationReason !== "string" ||
    !(LEARNED_POLICY_PUBLICATION_REASONS as readonly string[]).includes(
      publication.publicationReason,
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy publication reason must be the journal vocabulary",
      details: { allowed: LEARNED_POLICY_PUBLICATION_REASONS },
    });
  }
  const evidence = publication.evaluationEvidence;
  if (
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    evidence.some(
      (reference) =>
        !isRecord(reference) ||
        typeof reference.evaluationId !== "string" ||
        reference.evaluationId.length === 0 ||
        typeof reference.evaluationClass !== "string" ||
        !isLearnedPolicyEvaluationKind(reference.evaluationClass) ||
        typeof reference.evaluationDigest !== "string" ||
        reference.evaluationDigest.length === 0 ||
        typeof reference.evaluatedAt !== "string" ||
        reference.evaluatedAt.length === 0,
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "learned policy publication must carry non-empty revision-bound evaluation evidence (evaluation id, class, digest, evaluatedAt)",
      details: { field: "evaluationEvidence" },
    });
  }
  requireString(publication, "publishedAt", "publishedAt");
  requireString(publication, "publishedBy", "publishedBy");
  if (publication.publicationSchemaVersion !== LEARNED_POLICY_PUBLICATION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "learned policy publication schema version must match the frozen schema",
      details: { expected: LEARNED_POLICY_PUBLICATION_SCHEMA_VERSION },
    });
  }
}

// ---------------------------------------------------------------------------
// Digest bases (the canonical integrity anchors)
// ---------------------------------------------------------------------------

/** The canonical digest basis of a policy artifact. */
export function learnedPolicyDigestBasis(
  policy: Omit<LearnedPlanningPolicy, "digest">,
): Record<string, unknown> {
  return {
    policyClass: policy.policyClass,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    applicationId: policy.applicationId,
    analysisVersion: policy.analysisVersion,
    telemetrySchemaVersion: policy.telemetrySchemaVersion,
    populationFingerprint: policy.populationFingerprint,
    totalPopulation: policy.totalPopulation,
    evaluationWindowFrom: policy.evaluationWindowFrom,
    evaluationWindowTo: policy.evaluationWindowTo,
    preferences: policy.preferences,
    rollback: policy.rollback,
    generatedAt: policy.generatedAt,
    policySchemaVersion: policy.policySchemaVersion,
  };
}

/** The canonical digest basis of an evaluation record. */
export function learnedPolicyEvaluationDigestBasis(
  evaluation: Omit<LearnedPolicyEvaluation, never>,
): Record<string, unknown> {
  return {
    evaluationId: evaluation.evaluationId,
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    applicationId: evaluation.applicationId,
    evaluationClass: evaluation.evaluationClass,
    status: evaluation.status,
    verdict: evaluation.verdict,
    metrics: evaluation.metrics,
    comparison: evaluation.comparison,
    basis: evaluation.basis,
    canaryBinding: evaluation.canaryBinding,
    evidenceRefs: [...evaluation.evidenceRefs],
    sourceExecutionIds: [...evaluation.sourceExecutionIds],
    evaluatedAt: evaluation.evaluatedAt,
    schemaVersion: evaluation.schemaVersion,
  };
}

/** The canonical digest basis of a publication journal entry. */
export function learnedPolicyPublicationDigestBasis(
  publication: Omit<LearnedPolicyPublication, never>,
): Record<string, unknown> {
  return {
    publicationId: publication.publicationId,
    applicationId: publication.applicationId,
    policyId: publication.policyId,
    policyVersion: publication.policyVersion,
    publicationMode: publication.publicationMode,
    publicationReason: publication.publicationReason,
    evaluationEvidence: publication.evaluationEvidence.map((reference) => ({
      evaluationId: reference.evaluationId,
      evaluationClass: reference.evaluationClass,
      evaluationDigest: reference.evaluationDigest,
      evaluatedAt: reference.evaluatedAt,
    })),
    publishedAt: publication.publishedAt,
    publishedBy: publication.publishedBy,
    publicationSchemaVersion: publication.publicationSchemaVersion,
  };
}
