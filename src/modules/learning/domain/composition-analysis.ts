/**
 * Tool-sequence analysis, evaluation and ranking (learning module
 * domain; WORK-017 / ADR-0005, `spec/architecture.md` §19).
 *
 * THE canonical flow (the Work Order's objective, as pure functions
 * over the immutable telemetry population + the neutral tool-fact
 * catalog):
 *
 * ```text
 *   historical executions → learning telemetry (immutable population)
 *     → population SEGREGATION (task class + policy-relevant context)
 *     → tool-sequence mining (per-sequence joint statistics)
 *     → candidate composition (linear chain, versioned tools)
 *     → structural evaluation (composition safety vs the facts)
 *     → evidence evaluation (population, success, verification,
 *       cost/latency, failure modes, window, provenance)
 *     → ranked recommendation (honest confidence — never fabricated)
 * ```
 *
 * THE POPULATION SEGREGATION IS THE POLICY-CONTEXT HONESTY (§9/M13):
 * observations are keyed by (taskClass, capability set, strategy
 * class, context strategy) — the policy-relevant vocabulary telemetry
 * ACTUALLY records. Populations with different keys are NEVER silently
 * combined: each recommendation records its exact context key, and the
 * planner re-checks admissibility against the CURRENT effective policy
 * at consultation time (a high learning score can NEVER make a
 * forbidden tool admissible — the §6 boundary; the planner-side gate
 * owns that mechanically).
 *
 * CONFIDENCE IS MEASURABLE OR ABSENT (§13/M10): every recommendation
 * carries the integer population, success count, the point rate, the
 * verification rollup, the failure distribution, the evaluation window
 * and an honest uncertainty classification derived from the binomial
 * spread — the WORK-014 scorecard discipline applied to sequences.
 * Below the minimum population floor a recommendation is INCONCLUSIVE
 * (never a fabricated "low-confidence but ranked" executable hint).
 *
 * RECOMMENDATION ≠ AUTHORIZATION (§6/§16): the output is advisory
 * material for the planner's consultation seam. The planner remains
 * the sole planning authority; policy/capability/budget/verification
 * stay mandatory before any execution.
 *
 * DETERMINISTIC-FIRST COMPATIBILITY (§17): per-sequence
 * deterministic-evidence counters (subgraph observations and how many
 * contributing executions were fully-deterministic subgraph-wise) are
 * preserved so future deterministicization discovery (WORK-021) has
 * the evidence it needs. This file performs NO deterministicization
 * and owns NO replacement decision.
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { ToolComposition } from "./composition";
import {
  COMPOSITION_SCHEMA_VERSION,
  checkToolComposition,
  linearCompositionOf,
} from "./composition";
import type { ExecutionOutcomeTelemetry } from "./telemetry";
import type { ToolFactCatalog, ToolVersionRef } from "./tool-facts";
import { findToolFact } from "./tool-facts";

/** Frozen analysis-algorithm version (the recommendation's model identity). */
export const COMPOSITION_ANALYSIS_VERSION = 1;

/** Machine-readable non-authority class carried by every recommendation. */
export const COMPOSITION_RECOMMENDATION_CLASS =
  "non-authoritative-composition-recommendation" as const;

/** The recommendation schema version. */
export const COMPOSITION_RECOMMENDATION_SCHEMA_VERSION = 1;

/**
 * Minimum population for a sequence to be ranked as SUPPORTED evidence
 * (the honest-evidence floor; below it the recommendation is
 * INCONCLUSIVE — a small sample never becomes executable guidance).
 */
export const MINIMUM_SEQUENCE_POPULATION = 5;

/** The honest recommendation status vocabulary (§12). */
export const COMPOSITION_RECOMMENDATION_STATUSES = [
  "supported",
  "unsupported",
  "inconclusive",
] as const;

export type CompositionRecommendationStatus = (typeof COMPOSITION_RECOMMENDATION_STATUSES)[number];

/** Machine-readable evaluation-status reasons (closed vocabulary). */
export const COMPOSITION_RECOMMENDATION_REASON_CODES = [
  "adequate-population",
  "insufficient-population",
  "structural-rejection",
] as const;

export type CompositionRecommendationReasonCode =
  (typeof COMPOSITION_RECOMMENDATION_REASON_CODES)[number];

/** Honest confidence classification (the scorecard discipline). */
export interface RecommendationConfidence {
  readonly level: "low" | "material" | "high";
  readonly reasonCode:
    | "small-population"
    | "binomial-spread"
    | "adequate-population"
    | "zero-population";
  readonly detail: string;
}

/** The policy-relevant population context key (§9 — segregation honesty). */
export interface PopulationContextKey {
  readonly taskClass: string;
  /** The sorted capability-set the population's plans resolved. */
  readonly capabilities: readonly string[];
  /** The strategy class of the population's plans (or "unknown"). */
  readonly strategyClass: string;
  /** The context strategy of the population (or "unknown"). */
  readonly contextStrategy: string;
}

/** The observed failure-mode distribution (outcome → count). */
export interface OutcomeCount {
  readonly outcomeClass: string;
  readonly count: number;
}

/**
 * THE learned composition recommendation (closed shape). Advisory
 * evidence ONLY — never authorization, never a planning decision.
 */
export interface CompositionRecommendation {
  readonly recommendationClass: typeof COMPOSITION_RECOMMENDATION_CLASS;
  /** The context the population represents (never merged — M13). */
  readonly context: PopulationContextKey;
  /** The structurally validated composition (versioned tools — M26). */
  readonly composition: ToolComposition;
  /** The pinned tool versions, in sequence order. */
  readonly toolVersions: readonly ToolVersionRef[];
  /** The capability ids of the recommended tools (alignment evidence). */
  readonly toolCapabilityIds: readonly string[];
  readonly status: CompositionRecommendationStatus;
  readonly statusReason: CompositionRecommendationReasonCode;
  /** Structural rejection detail (present for unsupported records). */
  readonly unsupportedDetail?: string;
  /** Rank among SUPPORTED recommendations (1 = best; null otherwise). */
  readonly rank: number | null;
  readonly confidence: RecommendationConfidence;
  /** Integer population — contributing executions. */
  readonly population: number;
  readonly successCount: number;
  readonly successRate: number;
  /** Verification PASS rate over observed results, or null (none). */
  readonly verificationPassRate: number | null;
  readonly verificationTotal: number;
  /** Mean observed cost — integer micro-USD string. */
  readonly meanCostMicroUsd: string;
  /** Mean observed latency — integer milliseconds. */
  readonly meanLatencyMs: number;
  /** The observed failure-mode distribution (non-success outcomes). */
  readonly failureModes: readonly OutcomeCount[];
  /** Evaluation window (inclusive bounds, RFC 3339). */
  readonly evaluationWindowFrom: string;
  readonly evaluationWindowTo: string;
  /** Source executions — MANDATORY, non-empty (M11 provenance). */
  readonly sourceExecutionIds: readonly string[];
  /** Evidence references — MANDATORY, non-empty (M11 provenance). */
  readonly evidenceRefs: readonly string[];
  /** Deterministic-evidence counters (§17 — preserved, never acted on). */
  readonly deterministicEvidence: {
    readonly subgraphObservationCount: number;
    readonly fullyDeterministicExecutionCount: number;
  };
  readonly compositionSchemaVersion: number;
  readonly recommendationSchemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The population context key of a telemetry datum (pure derivation). */
export function populationContextKeyOf(datum: ExecutionOutcomeTelemetry): PopulationContextKey {
  return {
    taskClass: datum.taskClass,
    capabilities: [...new Set(datum.capabilities)].sort(),
    strategyClass: datum.strategyClass ?? "unknown",
    contextStrategy: datum.contextStrategy ?? "unknown",
  };
}

/** Canonical string form of a context key (map identity). */
export function canonicalContextKey(key: PopulationContextKey): string {
  return JSON.stringify([key.taskClass, key.capabilities, key.strategyClass, key.contextStrategy]);
}

/** The observed tool sequence of a telemetry datum (identity order). */
export function toolSequenceOf(datum: ExecutionOutcomeTelemetry): readonly string[] {
  return [...datum.tools];
}

/** Honest confidence classification from integer counts (never collapsed). */
export function classifyRecommendationConfidence(
  population: number,
  successCount: number,
): RecommendationConfidence {
  if (population < 1) {
    return {
      level: "high",
      reasonCode: "zero-population",
      detail: "no contributing executions (the record is a placeholder, never guidance)",
    };
  }
  const spread = 2 * Math.sqrt(0.25 / population);
  if (population < 2 * MINIMUM_SEQUENCE_POPULATION) {
    return {
      level: "material",
      reasonCode: "small-population",
      detail: `population ${population} is below the 2x minimum-population threshold; the point rate may swing materially`,
    };
  }
  if (spread < 0.1) {
    return {
      level: "low",
      reasonCode: "adequate-population",
      detail: `population ${population}, 2-sigma spread ~${spread.toFixed(3)} on success rate ${successCount}/${population}`,
    };
  }
  return {
    level: "material",
    reasonCode: "binomial-spread",
    detail: `population ${population}, 2-sigma spread ~${spread.toFixed(3)} exceeds the low-uncertainty band`,
  };
}

interface SequenceWorking {
  readonly context: PopulationContextKey;
  readonly sequence: readonly string[];
  population: number;
  successCount: number;
  verificationPasses: number;
  verificationTotal: number;
  totalCostMicroUsd: bigint;
  totalLatencyMs: number;
  outcomeCounts: Map<string, number>;
  sourceExecutionIds: Set<string>;
  evidenceRefs: Set<string>;
  windowFrom: string | null;
  windowTo: string | null;
  subgraphObservationCount: number;
  fullyDeterministicExecutionCount: number;
}

/**
 * THE sequence miner + evaluator + ranker (pure).
 *
 * Segregates the population by context key (never merging incompatible
 * populations — M13), mines each observed tool sequence, evaluates it
 * jointly (population/success/verification/cost/latency/failure
 * modes/window/provenance), builds the linear candidate composition,
 * validates it structurally against the tool facts and produces the
 * ranked closed-shape recommendations.
 *
 * Fails closed when the population is EMPTY (evidence over claims) or
 * mixes telemetry schema versions (the scorecard M14 discipline).
 */
export function analyzeToolSequences(
  population: readonly ExecutionOutcomeTelemetry[],
  catalog: ToolFactCatalog,
): readonly CompositionRecommendation[] {
  if (population.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "tool-sequence analysis requires a non-empty telemetry population",
    });
  }
  const schemaVersions = new Set(population.map((datum) => datum.schemaVersion));
  if (schemaVersions.size !== 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "tool-sequence analysis cannot combine incompatible telemetry schemas (the population is heterogeneous)",
      details: { observedSchemaVersions: [...schemaVersions].sort() },
    });
  }
  const bySequence = new Map<string, SequenceWorking>();
  for (const datum of population) {
    if (datum.tools.length === 0) {
      continue; // executions with no tool usage contribute no sequence
    }
    const context = populationContextKeyOf(datum);
    const sequence = toolSequenceOf(datum);
    const key = `${canonicalContextKey(context)}\u0000${JSON.stringify(sequence)}`;
    let working = bySequence.get(key);
    if (working === undefined) {
      working = {
        context,
        sequence,
        population: 0,
        successCount: 0,
        verificationPasses: 0,
        verificationTotal: 0,
        totalCostMicroUsd: 0n,
        totalLatencyMs: 0,
        outcomeCounts: new Map<string, number>(),
        sourceExecutionIds: new Set<string>(),
        evidenceRefs: new Set<string>(),
        windowFrom: null,
        windowTo: null,
        subgraphObservationCount: 0,
        fullyDeterministicExecutionCount: 0,
      };
      bySequence.set(key, working);
    }
    working.population += 1;
    if (datum.outcome === "execution-completed") {
      working.successCount += 1;
    }
    working.verificationPasses += datum.verification.passCount;
    working.verificationTotal +=
      datum.verification.passCount +
      datum.verification.failCount +
      datum.verification.inconclusiveCount;
    working.totalCostMicroUsd += BigInt(datum.costMicroUsd);
    working.totalLatencyMs += datum.latencyMs;
    const current = working.outcomeCounts.get(datum.outcome) ?? 0;
    working.outcomeCounts.set(datum.outcome, current + 1);
    working.sourceExecutionIds.add(datum.executionId);
    for (const ref of datum.evidenceRefs) {
      working.evidenceRefs.add(ref);
    }
    working.windowFrom =
      working.windowFrom === null || datum.recordedAt < working.windowFrom
        ? datum.recordedAt
        : working.windowFrom;
    working.windowTo =
      working.windowTo === null || datum.recordedAt > working.windowTo
        ? datum.recordedAt
        : working.windowTo;
    working.subgraphObservationCount += datum.subgraphs.length;
    if (
      datum.subgraphs.length > 0 &&
      datum.subgraphs.every((subgraph) => subgraph.computationType === "deterministic")
    ) {
      working.fullyDeterministicExecutionCount += 1;
    }
  }

  const recommendations: CompositionRecommendation[] = [];
  for (const working of bySequence.values()) {
    // Version resolution: pin each observed tool to its exact catalog
    // version. The OBSERVED identity is the toolId; the version comes
    // from the fact catalog (the caller supplies the current registry
    // view). A tool absent from the catalog → UNSUPPORTED
    // (unknown-tool-reference); a single-tool catalog carrying multiple
    // versions pins the newest (the caller's "current registry" view —
    // recorded honestly via the pinned versions on the record, M26).
    const versions: ToolVersionRef[] = [];
    let unresolved: { reason: string; detail: string } | null = null;
    for (const toolId of working.sequence) {
      const versionsOfTool = catalog.facts
        .filter((fact) => fact.toolId === toolId)
        .map((fact) => fact.version)
        .sort();
      const newest = versionsOfTool[versionsOfTool.length - 1];
      if (newest === undefined) {
        unresolved = {
          reason: "unknown-tool-reference",
          detail: `observed tool ${toolId} is unknown to the fact catalog`,
        };
        versions.push({ toolId, version: "" });
        continue;
      }
      versions.push({ toolId, version: newest });
    }

    const windowFrom = working.windowFrom ?? "";
    const windowTo = working.windowTo ?? "";
    // The alignment evidence: the capability ids of the pinned tool
    // versions (derived from the fact catalog — recorded immutably so
    // the consumer seam needs no registry access).
    const toolCapabilityIds: string[] = [];
    for (const tool of versions) {
      const fact = tool.version === "" ? null : findToolFact(catalog, tool.toolId, tool.version);
      if (fact !== null) {
        for (const capability of fact.capabilityIds) {
          if (!toolCapabilityIds.includes(capability)) {
            toolCapabilityIds.push(capability);
          }
        }
      }
    }

    const base = {
      recommendationClass: COMPOSITION_RECOMMENDATION_CLASS,
      context: working.context,
      toolVersions: versions.map((tool) => ({ ...tool })),
      toolCapabilityIds,
      population: working.population,
      successCount: working.successCount,
      successRate: working.population === 0 ? 0 : working.successCount / working.population,
      verificationPassRate:
        working.verificationTotal > 0
          ? working.verificationPasses / working.verificationTotal
          : null,
      verificationTotal: working.verificationTotal,
      meanCostMicroUsd:
        working.population === 0
          ? "0"
          : (working.totalCostMicroUsd / BigInt(working.population)).toString(),
      meanLatencyMs:
        working.population === 0 ? 0 : Math.round(working.totalLatencyMs / working.population),
      failureModes: [...working.outcomeCounts.entries()]
        .filter(([outcome]) => outcome !== "execution-completed")
        .map(([outcomeClass, count]) => ({ outcomeClass, count }))
        .sort((a, b) => (a.outcomeClass < b.outcomeClass ? -1 : 1)),
      evaluationWindowFrom: windowFrom,
      evaluationWindowTo: windowTo,
      sourceExecutionIds: [...working.sourceExecutionIds].sort(),
      evidenceRefs: [...working.evidenceRefs].sort(),
      deterministicEvidence: {
        subgraphObservationCount: working.subgraphObservationCount,
        fullyDeterministicExecutionCount: working.fullyDeterministicExecutionCount,
      },
      compositionSchemaVersion: COMPOSITION_SCHEMA_VERSION,
      recommendationSchemaVersion: COMPOSITION_RECOMMENDATION_SCHEMA_VERSION,
    };

    if (unresolved !== null) {
      recommendations.push({
        ...base,
        composition: linearCompositionOf(versions),
        status: "unsupported" as const,
        statusReason: "structural-rejection" as const,
        unsupportedDetail: unresolved.detail,
        rank: null,
        confidence: classifyRecommendationConfidence(working.population, working.successCount),
      });
      continue;
    }

    const candidate = linearCompositionOf(versions);
    const structural = checkToolComposition(candidate, catalog);
    if (!structural.valid) {
      recommendations.push({
        ...base,
        composition: candidate,
        status: "unsupported" as const,
        statusReason: "structural-rejection" as const,
        unsupportedDetail: structural.detail,
        rank: null,
        confidence: classifyRecommendationConfidence(working.population, working.successCount),
      });
      continue;
    }

    if (working.population < MINIMUM_SEQUENCE_POPULATION) {
      recommendations.push({
        ...base,
        composition: structural.composition,
        status: "inconclusive" as const,
        statusReason: "insufficient-population" as const,
        rank: null,
        confidence: classifyRecommendationConfidence(working.population, working.successCount),
      });
      continue;
    }

    recommendations.push({
      ...base,
      composition: structural.composition,
      status: "supported" as const,
      statusReason: "adequate-population" as const,
      rank: null,
      confidence: classifyRecommendationConfidence(working.population, working.successCount),
    });
  }

  // Deterministic ranking of the SUPPORTED recommendations: success
  // rate desc, then population desc, then canonical sequence order.
  // Rank is assigned by REBUILDING (records are readonly, closed-shaped).
  const sequenceKeyOf = (recommendation: CompositionRecommendation): string =>
    canonicalContextKey(recommendation.context) +
    JSON.stringify(recommendation.toolVersions.map((tool) => [tool.toolId, tool.version]));
  const supported = recommendations
    .filter((recommendation) => recommendation.status === "supported")
    .sort((a, b) => {
      if (b.successRate !== a.successRate) {
        return b.successRate - a.successRate;
      }
      if (b.population !== a.population) {
        return b.population - a.population;
      }
      return sequenceKeyOf(a) < sequenceKeyOf(b) ? -1 : 1;
    });
  const rankBySequence = new Map<string, number>();
  supported.forEach((recommendation, index) => {
    rankBySequence.set(sequenceKeyOf(recommendation), index + 1);
  });
  const ranked = recommendations.map((recommendation) =>
    recommendation.status === "supported"
      ? { ...recommendation, rank: rankBySequence.get(sequenceKeyOf(recommendation)) ?? null }
      : recommendation,
  );

  // Stable overall order: supported (by rank), then inconclusive, then
  // unsupported — deterministic, canonical-form stable.
  const statusOrder = { supported: 0, inconclusive: 1, unsupported: 2 } as const;
  return [...ranked].sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) {
      return statusOrder[a.status] - statusOrder[b.status];
    }
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return sequenceKeyOf(a) < sequenceKeyOf(b) ? -1 : 1;
  });
}

/** Fail-closed closed-shape validation of one recommendation record. */
export function validateCompositionRecommendation(
  value: unknown,
): asserts value is CompositionRecommendation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation must be an object",
    });
  }
  const recommendation = value;
  if (recommendation.recommendationClass !== COMPOSITION_RECOMMENDATION_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation must carry the frozen non-authority class",
      details: { expected: COMPOSITION_RECOMMENDATION_CLASS },
    });
  }
  if (!isRecord(recommendation.context) || typeof recommendation.context.taskClass !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation must carry a population context",
    });
  }
  if (!Array.isArray(recommendation.context.capabilities)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation context capabilities must be an array",
    });
  }
  if (
    !Array.isArray(recommendation.toolVersions) ||
    recommendation.toolVersions.length === 0 ||
    recommendation.toolVersions.some(
      (tool) =>
        !isRecord(tool) || typeof tool.toolId !== "string" || typeof tool.version !== "string",
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "composition recommendation must pin non-empty tool versions (M26 — versioned tool identity)",
    });
  }
  if (
    !Array.isArray(recommendation.toolCapabilityIds) ||
    recommendation.toolCapabilityIds.some((capability) => typeof capability !== "string")
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "composition recommendation toolCapabilityIds must be an array of strings (alignment evidence)",
    });
  }
  if (
    typeof recommendation.status !== "string" ||
    !(COMPOSITION_RECOMMENDATION_STATUSES as readonly string[]).includes(recommendation.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation status must be the closed vocabulary",
      details: { allowed: COMPOSITION_RECOMMENDATION_STATUSES },
    });
  }
  if (
    typeof recommendation.statusReason !== "string" ||
    !(COMPOSITION_RECOMMENDATION_REASON_CODES as readonly string[]).includes(
      recommendation.statusReason,
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation statusReason must be the closed vocabulary",
    });
  }
  if (
    recommendation.rank !== null &&
    (typeof recommendation.rank !== "number" || recommendation.rank < 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation rank must be a positive integer or null",
    });
  }
  for (const key of ["population", "successCount", "verificationTotal", "meanLatencyMs"] as const) {
    const number = recommendation[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `composition recommendation ${key} must be a non-negative integer`,
        details: { field: key },
      });
    }
  }
  if (
    typeof recommendation.successRate !== "number" ||
    recommendation.successRate < 0 ||
    recommendation.successRate > 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation successRate must be in [0,1]",
    });
  }
  if (
    recommendation.verificationPassRate !== null &&
    (typeof recommendation.verificationPassRate !== "number" ||
      recommendation.verificationPassRate < 0 ||
      recommendation.verificationPassRate > 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation verificationPassRate must be in [0,1] or null",
    });
  }
  if (
    typeof recommendation.meanCostMicroUsd !== "string" ||
    !/^\d{1,19}$/.test(recommendation.meanCostMicroUsd)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation meanCostMicroUsd must be an integer micro-USD string",
    });
  }
  // M11/M12: provenance and evaluation window are unrepresentable-as-absent.
  for (const key of ["sourceExecutionIds", "evidenceRefs"] as const) {
    const refs = recommendation[key];
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some((ref) => typeof ref !== "string" || ref.length === 0)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `composition recommendation ${key} must be non-empty (M11 provenance)`,
        details: { field: key },
      });
    }
  }
  for (const key of ["evaluationWindowFrom", "evaluationWindowTo"] as const) {
    if (typeof recommendation[key] !== "string" || (recommendation[key] as string).length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `composition recommendation ${key} must be a non-empty timestamp (M12 evaluation window)`,
        details: { field: key },
      });
    }
  }
  if (!isRecord(recommendation.confidence) || typeof recommendation.confidence.level !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation must carry an honest confidence classification",
    });
  }
  if (
    typeof recommendation.compositionSchemaVersion !== "number" ||
    recommendation.compositionSchemaVersion < 1 ||
    typeof recommendation.recommendationSchemaVersion !== "number" ||
    recommendation.recommendationSchemaVersion !== COMPOSITION_RECOMMENDATION_SCHEMA_VERSION
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation must carry its schema version anchors",
    });
  }
}

/**
 * The versioned, immutable recommendation SET (the durable unit —
 * activation and rollback operate on whole sets, §21/§22).
 */
export interface CompositionRecommendationSet {
  readonly setId: string;
  /** Monotonic version within (application, analysis). */
  readonly setVersion: number;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly analysisVersion: number;
  readonly telemetrySchemaVersion: number;
  /** Digest over the population basis + facts basis (replay identity). */
  readonly populationFingerprint: string;
  readonly evaluationWindowFrom: string | null;
  readonly evaluationWindowTo: string;
  /** Population size BEFORE per-sequence minimum filtering (honesty). */
  readonly totalPopulation: number;
  readonly recommendations: readonly CompositionRecommendation[];
  readonly generatedAt: string;
  readonly digest: string;
}

/** The activation-log record (append-only; the deployment state). */
export interface RecommendationSetActivation {
  readonly activationId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly setId: string;
  readonly setVersion: number;
  readonly activatedAt: string;
  readonly activatedBy: string;
  readonly reason: "initial" | "rollback" | "refresh";
}

/** Activation reason vocabulary (closed). */
export const RECOMMENDATION_ACTIVATION_REASONS = ["initial", "rollback", "refresh"] as const;

/**
 * Canonical fingerprint basis of a recommendation set (identity +
 * full entries; two sets differing in ANY recorded field differ in
 * digest).
 */
export function recommendationSetDigestBasis(
  set: Omit<CompositionRecommendationSet, "digest">,
): Readonly<Record<string, unknown>> {
  return {
    setId: set.setId,
    setVersion: set.setVersion,
    applicationId: set.applicationId,
    tenantId: set.tenantId,
    analysisVersion: set.analysisVersion,
    telemetrySchemaVersion: set.telemetrySchemaVersion,
    populationFingerprint: set.populationFingerprint,
    evaluationWindowFrom: set.evaluationWindowFrom,
    evaluationWindowTo: set.evaluationWindowTo,
    totalPopulation: set.totalPopulation,
    generatedAt: set.generatedAt,
    recommendations: set.recommendations.map((recommendation) => ({
      context: recommendation.context,
      toolVersions: recommendation.toolVersions.map((tool) => [tool.toolId, tool.version]),
      toolCapabilityIds: [...recommendation.toolCapabilityIds],
      status: recommendation.status,
      statusReason: recommendation.statusReason,
      ...(recommendation.unsupportedDetail === undefined
        ? {}
        : { unsupportedDetail: recommendation.unsupportedDetail }),
      rank: recommendation.rank,
      confidence: recommendation.confidence,
      population: recommendation.population,
      successCount: recommendation.successCount,
      successRate: recommendation.successRate,
      verificationPassRate: recommendation.verificationPassRate,
      verificationTotal: recommendation.verificationTotal,
      meanCostMicroUsd: recommendation.meanCostMicroUsd,
      meanLatencyMs: recommendation.meanLatencyMs,
      failureModes: recommendation.failureModes,
      evaluationWindowFrom: recommendation.evaluationWindowFrom,
      evaluationWindowTo: recommendation.evaluationWindowTo,
      sourceExecutionIds: [...recommendation.sourceExecutionIds],
      evidenceRefs: [...recommendation.evidenceRefs],
      deterministicEvidence: recommendation.deterministicEvidence,
      compositionSchemaVersion: recommendation.compositionSchemaVersion,
      recommendationSchemaVersion: recommendation.recommendationSchemaVersion,
    })),
  };
}

/** Fail-closed validation of a full recommendation set (store reads). */
export function validateCompositionRecommendationSet(
  value: unknown,
): asserts value is CompositionRecommendationSet {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "recommendation set must be an object",
    });
  }
  const set = value;
  for (const key of [
    "setId",
    "applicationId",
    "tenantId",
    "populationFingerprint",
    "evaluationWindowTo",
    "generatedAt",
    "digest",
  ] as const) {
    if (typeof set[key] !== "string" || (set[key] as string).length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `recommendation set ${key} must be a non-empty string`,
        details: { field: key },
      });
    }
  }
  for (const key of [
    "setVersion",
    "analysisVersion",
    "telemetrySchemaVersion",
    "totalPopulation",
  ] as const) {
    const version = set[key];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `recommendation set ${key} must be a positive integer (version anchors)`,
        details: { field: key },
      });
    }
  }
  if (set.evaluationWindowFrom !== null && typeof set.evaluationWindowFrom !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "recommendation set evaluationWindowFrom must be a string or null",
    });
  }
  const recommendations = set.recommendations;
  if (!Array.isArray(recommendations)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "recommendation set recommendations must be an array (may be empty when nothing was observed)",
    });
  }
  for (const recommendation of recommendations) {
    validateCompositionRecommendation(recommendation);
  }
}

/** Fail-closed validation of an activation record (store reads). */
export function validateRecommendationSetActivation(
  value: unknown,
): asserts value is RecommendationSetActivation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "recommendation activation must be an object",
    });
  }
  const activation = value;
  for (const key of [
    "activationId",
    "applicationId",
    "tenantId",
    "setId",
    "activatedAt",
    "activatedBy",
  ] as const) {
    if (typeof activation[key] !== "string" || (activation[key] as string).length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `recommendation activation ${key} must be a non-empty string`,
        details: { field: key },
      });
    }
  }
  if (
    typeof activation.setVersion !== "number" ||
    !Number.isInteger(activation.setVersion) ||
    activation.setVersion < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "recommendation activation setVersion must be a positive integer",
    });
  }
  if (
    typeof activation.reason !== "string" ||
    !(RECOMMENDATION_ACTIVATION_REASONS as readonly string[]).includes(activation.reason)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "recommendation activation reason must be the closed vocabulary",
      details: { allowed: RECOMMENDATION_ACTIVATION_REASONS },
    });
  }
}

/**
 * The consultation SIGNAL: one recommendation projected with its SET
 * anchors (which immutable set version produced it — M13/M14 basis
 * at the consumer seam). Built at consultation time from the active
 * set; never persisted in this form.
 */
export interface CompositionRecommendationSignal extends CompositionRecommendation {
  readonly setId: string;
  readonly setVersion: number;
  readonly analysisVersion: number;
}

/** Project a stored recommendation into the consultation signal (pure). */
export function signalFromRecommendation(
  recommendation: CompositionRecommendation,
  basis: {
    readonly setId: string;
    readonly setVersion: number;
    readonly analysisVersion: number;
  },
): CompositionRecommendationSignal {
  const signal: CompositionRecommendationSignal = {
    ...recommendation,
    setId: basis.setId,
    setVersion: basis.setVersion,
    analysisVersion: basis.analysisVersion,
  };
  if (
    typeof signal.setId !== "string" ||
    signal.setId.length === 0 ||
    !Number.isInteger(signal.setVersion) ||
    signal.setVersion < 1 ||
    !Number.isInteger(signal.analysisVersion) ||
    signal.analysisVersion < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "composition recommendation signal must carry its set versioning basis",
    });
  }
  return signal;
}

/** Resolve the fact a recommendation's tools pin (or null — M26 check). */
export function resolvedFactOf(
  catalog: ToolFactCatalog,
  tool: ToolVersionRef,
): ReturnType<typeof findToolFact> {
  return findToolFact(catalog, tool.toolId, tool.version);
}
