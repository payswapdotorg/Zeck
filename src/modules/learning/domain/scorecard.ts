/**
 * Versioned scorecards and aggregation definitions (learning module
 * domain; WORK-014 / LRN-001, TOL-003, INT-006; ADR-0005).
 *
 * A `Scorecard` is an immutable, VERSIONED aggregate computed from a
 * population of execution outcome telemetry. It is the planning-consumable
 * signal SOURCE — and it is EVIDENCE, never authority:
 *
 *  - every entry carries its full versioning basis: scorecardId +
 *    scorecardVersion + definitionId + definitionVersion +
 *    telemetrySchemaVersion + population window (M13: a planning consumer
 *    can always identify WHICH scorecard version, WHICH aggregation
 *    definition, WHICH telemetry schema and WHICH evidence population
 *    produced the signal — unversioned signals are unrepresentable);
 *  - every entry carries `sourceExecutionIds` and `evidenceRefs` — the
 *    aggregate stays traceable to reality, never an orphaned "model
 *    performance" fact (M10/M11);
 *  - entries NEVER mix telemetry schema versions (M14:
 *    `buildScorecard` fails closed on a heterogeneous population — a
 *    scorecard combining incompatible telemetry schemas is
 *    unrepresentable);
 *  - uncertainty is PRESERVED, never collapsed: each entry records the
 *    integer population + success counts, the point rate, and an honest
 *    uncertainty class derived from the binomial spread (`§13` of the
 *    Work Order: "do not collapse uncertain evidence into false
 *    certainty");
 *  - scorecards are IMMUTABLE and append-only by version: there is NO
 *    update path in the domain surface, and migration 0009 makes the
 *    physical rows immutable (M9: historical scorecards never mutate
 *    silently). A new population ⇒ a NEW scorecard version.
 *
 * The aggregation definitions are a FROZEN, registry-style vocabulary
 * (`AGGREGATION_DEFINITIONS`): each definition declares its grouping
 * subject kind, its metrics, its minimum population and its compatible
 * telemetry schema versions. Extending the registry is a reviewed,
 * versioned change — a definition is never edited in place (definition
 * version bumps instead).
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionOutcomeTelemetry } from "./telemetry";
import { TELEMETRY_SCHEMA_VERSION } from "./telemetry";

/** The subject kinds a scorecard can aggregate over (provider-neutral). */
export const SCORECARD_SUBJECT_KINDS = [
  "route",
  "tool",
  "environment",
  "context-strategy",
  "plan",
  "subgraph",
  "verifier",
] as const;

export type ScorecardSubjectKind = (typeof SCORECARD_SUBJECT_KINDS)[number];

export function isScorecardSubjectKind(value: string): value is ScorecardSubjectKind {
  return (SCORECARD_SUBJECT_KINDS as readonly string[]).includes(value);
}

/** Honest uncertainty classes — never collapsed, never hidden (§13). */
export const UNCERTAINTY_LEVELS = ["low", "material", "high"] as const;
export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number];

export interface ScorecardUncertainty {
  readonly level: UncertaintyLevel;
  /** Machine-readable reason code (auditable). */
  readonly reasonCode:
    | "small-population"
    | "binomial-spread"
    | "adequate-population"
    | "zero-population";
  readonly detail: string;
}

/** One aggregated subject row of a scorecard (all fields non-derived). */
export interface ScorecardEntry {
  /** Subject identity: e.g. kind "route", key "providerA/modelB". */
  readonly subjectKind: ScorecardSubjectKind;
  /** Opaque neutral subject key (NEVER a provider SDK type — M18). */
  readonly subjectKey: string;
  /** Task class the population was restricted to. */
  readonly taskClass: string;
  /** Integer population — the number of contributing executions. */
  readonly population: number;
  /** Integer count of successful outcomes (execution-completed). */
  readonly successCount: number;
  /** Point success rate in [0,1] (derived from integers, recorded). */
  readonly successRate: number;
  /** Verification PASS rate in [0,1], or null when no verification data. */
  readonly verificationPassRate: number | null;
  /** Mean observed cost — integer micro-USD string. */
  readonly meanCostMicroUsd: string;
  /** Mean observed latency — integer milliseconds. */
  readonly meanLatencyMs: number;
  readonly uncertainty: ScorecardUncertainty;
  /** The source executions of this entry — MANDATORY, non-empty (M10). */
  readonly sourceExecutionIds: readonly string[];
  /** The evidence refs backing the entry — MANDATORY, non-empty (M11). */
  readonly evidenceRefs: readonly string[];
}

/** The immutable, versioned aggregate (migration 0009 shape). */
export interface Scorecard {
  readonly scorecardId: string;
  /** Which aggregation definition produced this scorecard. */
  readonly definitionId: string;
  readonly definitionVersion: number;
  /** Monotonic version within (application, definition). */
  readonly scorecardVersion: number;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The single telemetry schema version of the contributing population. */
  readonly telemetrySchemaVersion: number;
  /** Population window (inclusive lower bound, exclusive upper bound). */
  readonly populationFrom: string | null;
  readonly populationTo: string;
  /** Population size BEFORE per-entry minimum filtering (honesty). */
  readonly totalPopulation: number;
  readonly entries: readonly ScorecardEntry[];
  readonly computedAt: string;
  /** sha256 over the canonical scorecard form (integrity for consumers). */
  readonly digest: string;
}

/** The frozen aggregation-definition registry (extend = new version). */
export interface AggregationDefinition {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly subjectKind: ScorecardSubjectKind;
  /** Metrics computed for every entry. */
  readonly metrics: readonly (
    | "successRate"
    | "verificationPassRate"
    | "meanCostMicroUsd"
    | "meanLatencyMs"
  )[];
  /** Entries below this population are excluded (uncertainty honesty). */
  readonly minimumPopulation: number;
  /** Telemetry schema versions this definition can aggregate (M14). */
  readonly compatibleTelemetrySchemas: readonly number[];
}

export const AGGREGATION_DEFINITIONS: readonly AggregationDefinition[] = [
  {
    id: "route-outcome-by-task-class",
    version: 1,
    description:
      "Route (provider/model) outcome aggregates per task class: population, success count/rate, verification pass rate, mean cost and mean latency, with per-entry source-execution and evidence binding.",
    subjectKind: "route",
    metrics: ["successRate", "verificationPassRate", "meanCostMicroUsd", "meanLatencyMs"],
    minimumPopulation: 5,
    compatibleTelemetrySchemas: [TELEMETRY_SCHEMA_VERSION],
  },
  {
    id: "tool-outcome-by-task-class",
    version: 1,
    description:
      "Tool outcome aggregates per task class (TOL-003: which tools improve outcomes for which task classes) with source-execution/evidence binding.",
    subjectKind: "tool",
    metrics: ["successRate", "verificationPassRate", "meanCostMicroUsd", "meanLatencyMs"],
    minimumPopulation: 5,
    compatibleTelemetrySchemas: [TELEMETRY_SCHEMA_VERSION],
  },
  {
    id: "environment-outcome-by-task-class",
    version: 1,
    description:
      "Compute-environment outcome aggregates per task class with source-execution/evidence binding.",
    subjectKind: "environment",
    metrics: ["successRate", "verificationPassRate", "meanCostMicroUsd", "meanLatencyMs"],
    minimumPopulation: 5,
    compatibleTelemetrySchemas: [TELEMETRY_SCHEMA_VERSION],
  },
  {
    id: "plan-outcome-by-task-class",
    version: 1,
    description:
      "Plan (planId/revision) outcome aggregates per task class with source-execution/evidence binding.",
    subjectKind: "plan",
    metrics: ["successRate", "verificationPassRate", "meanCostMicroUsd", "meanLatencyMs"],
    minimumPopulation: 5,
    compatibleTelemetrySchemas: [TELEMETRY_SCHEMA_VERSION],
  },
  {
    id: "subgraph-frequency-by-task-class",
    version: 1,
    description:
      "Subgraph identity frequency and outcome aggregates per task class — the DTR-001 evidence substrate for future deterministicization discovery (WORK-021 owns the decisions; this is identity + outcomes only).",
    subjectKind: "subgraph",
    metrics: ["successRate", "meanCostMicroUsd", "meanLatencyMs"],
    minimumPopulation: 5,
    compatibleTelemetrySchemas: [TELEMETRY_SCHEMA_VERSION],
  },
];

export function findAggregationDefinition(id: string): AggregationDefinition | undefined {
  return AGGREGATION_DEFINITIONS.find((definition) => definition.id === id);
}

/** Subject key of a datum under a definition (route = "provider/model"). */
function subjectKeysOf(
  definition: AggregationDefinition,
  datum: ExecutionOutcomeTelemetry,
): readonly string[] {
  switch (definition.subjectKind) {
    case "route":
      return datum.routes.map((route) => `${route.provider}/${route.model}`);
    case "tool":
      return [...datum.tools];
    case "environment":
      return [...datum.environments];
    case "context-strategy":
      return datum.contextStrategy === undefined ? [] : [datum.contextStrategy];
    case "plan":
      return [datum.planId];
    case "subgraph":
      return datum.subgraphs.map((subgraph) => subgraph.subgraphId);
    case "verifier":
      return [...datum.verification.evaluatorIds];
  }
}

/** Honest uncertainty classification from integer counts (never collapsed). */
function classifyUncertainty(population: number, successCount: number): ScorecardUncertainty {
  if (population < 1) {
    return {
      level: "high",
      reasonCode: "zero-population",
      detail: "no contributing executions",
    };
  }
  // Binomial standard-deviation bound p(1-p) <= 1/4, sigma/n with 2-sigma
  // spread on the point rate: deterministic thresholds. Population below
  // twice the registry-default minimum floor is honestly "material" at
  // best (small samples swing).
  const spread = 2 * Math.sqrt(0.25 / population);
  if (population < 2 * MINIMUM_POPULATION_FLOOR) {
    return {
      level: "material",
      reasonCode: "small-population",
      detail: `population ${population} is below the 2x minimum-population threshold; point rate may swing materially`,
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

/** Registry-default minimum population floor (uncertainty honesty). */
const MINIMUM_POPULATION_FLOOR = 5;

/**
 * The canonical fingerprint basis of a scorecard (for the digest):
 * identity fields + the full entries array in canonical (subject, task)
 * order. Version fields participate — two scorecards differing in ANY
 * recorded field differ in digest.
 */
export function scorecardDigestBasis(
  scorecard: Omit<Scorecard, "digest">,
): Readonly<Record<string, unknown>> {
  return {
    scorecardId: scorecard.scorecardId,
    definitionId: scorecard.definitionId,
    definitionVersion: scorecard.definitionVersion,
    scorecardVersion: scorecard.scorecardVersion,
    applicationId: scorecard.applicationId,
    tenantId: scorecard.tenantId,
    telemetrySchemaVersion: scorecard.telemetrySchemaVersion,
    populationFrom: scorecard.populationFrom,
    populationTo: scorecard.populationTo,
    totalPopulation: scorecard.totalPopulation,
    computedAt: scorecard.computedAt,
    entries: scorecard.entries.map((entry) => ({
      subjectKind: entry.subjectKind,
      subjectKey: entry.subjectKey,
      taskClass: entry.taskClass,
      population: entry.population,
      successCount: entry.successCount,
      successRate: entry.successRate,
      verificationPassRate: entry.verificationPassRate,
      meanCostMicroUsd: entry.meanCostMicroUsd,
      meanLatencyMs: entry.meanLatencyMs,
      uncertainty: {
        level: entry.uncertainty.level,
        reasonCode: entry.uncertainty.reasonCode,
        detail: entry.uncertainty.detail,
      },
      sourceExecutionIds: [...entry.sourceExecutionIds],
      evidenceRefs: [...entry.evidenceRefs],
    })),
  };
}

export interface BuildScorecardInput {
  readonly definitionId: string;
  readonly scorecardId: string;
  readonly scorecardVersion: number;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The telemetry population (validated by the caller). */
  readonly telemetry: readonly ExecutionOutcomeTelemetry[];
  /** Inclusive lower bound of the population window (null = unbounded). */
  readonly populationFrom: string | null;
  /** Exclusive upper bound of the population window. */
  readonly populationTo: string;
  readonly computedAt: string;
}

/**
 * Build a scorecard from a telemetry population. PURE.
 *
 * Fails closed when:
 *  - the definition id is unknown (typed error — no silent default);
 *  - the population is EMPTY (a scorecard with no evidence population is
 *    not a scorecard — evidence over claims);
 *  - the population mixes telemetry schema versions (M14: incompatible
 *    schemas cannot be combined);
 *  - a schema version is incompatible with the definition.
 *
 * Entries below the definition's minimum population are EXCLUDED (the
 * `totalPopulation` field still records the pre-filter population —
 * the exclusion is visible, never silent).
 */
export function buildScorecard(input: BuildScorecardInput): Omit<Scorecard, "digest"> {
  const definition = findAggregationDefinition(input.definitionId);
  if (definition === undefined) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "unknown aggregation definition id (the registry is the closed vocabulary)",
      details: { definitionId: input.definitionId },
    });
  }
  if (input.telemetry.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "a scorecard requires a non-empty telemetry population (evidence over claims)",
      details: { definitionId: input.definitionId },
    });
  }

  const schemaVersions = new Set(input.telemetry.map((datum) => datum.schemaVersion));
  if (schemaVersions.size !== 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "a scorecard cannot combine incompatible telemetry schemas (M14): the population is heterogeneous",
      details: { observedSchemaVersions: [...schemaVersions].sort() },
    });
  }
  const schemaVersion = input.telemetry[0]?.schemaVersion;
  if (
    schemaVersion === undefined ||
    !definition.compatibleTelemetrySchemas.includes(schemaVersion)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry schema version is incompatible with the aggregation definition",
      details: {
        definitionId: definition.id,
        definitionVersion: definition.version,
        schemaVersion,
        compatible: definition.compatibleTelemetrySchemas,
      },
    });
  }

  interface Working {
    population: number;
    successCount: number;
    verificationPasses: number;
    verificationTotal: number;
    totalCostMicroUsd: bigint;
    totalLatencyMs: number;
    sourceExecutionIds: Set<string>;
    evidenceRefs: Set<string>;
  }
  const groups = new Map<string, Working>();

  for (const datum of input.telemetry) {
    // The scope binding is mandatory: a datum from another application or
    // tenant never contributes (M12 — tenant identity is never dropped).
    if (datum.applicationId !== input.applicationId || datum.tenantId !== input.tenantId) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "telemetry population contains a datum outside the scorecard scope (M12)",
        details: { executionId: datum.executionId },
      });
    }
    for (const subjectKey of subjectKeysOf(definition, datum)) {
      const key = `${subjectKey}\u0000${datum.taskClass}`;
      let working = groups.get(key);
      if (working === undefined) {
        working = {
          population: 0,
          successCount: 0,
          verificationPasses: 0,
          verificationTotal: 0,
          totalCostMicroUsd: 0n,
          totalLatencyMs: 0,
          sourceExecutionIds: new Set<string>(),
          evidenceRefs: new Set<string>(),
        };
        groups.set(key, working);
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
      working.sourceExecutionIds.add(datum.executionId);
      for (const ref of datum.evidenceRefs) {
        working.evidenceRefs.add(ref);
      }
    }
  }

  const entries: ScorecardEntry[] = [];
  for (const [key, working] of groups) {
    const [subjectKey, taskClass] = key.split("\u0000");
    if (subjectKey === undefined || taskClass === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "internal group key split failure",
      });
    }
    if (working.population < definition.minimumPopulation) {
      // Excluded by the minimum-population rule — recorded in
      // totalPopulation, never silently dropped from accounting.
      continue;
    }
    const population = working.population;
    const successCount = working.successCount;
    const successRate = successCount / population;
    const hasVerification = working.verificationTotal > 0;
    entries.push({
      subjectKind: definition.subjectKind,
      subjectKey,
      taskClass,
      population,
      successCount,
      successRate,
      verificationPassRate: hasVerification
        ? working.verificationPasses / working.verificationTotal
        : null,
      meanCostMicroUsd: (working.totalCostMicroUsd / BigInt(population)).toString(),
      meanLatencyMs: Math.round(working.totalLatencyMs / population),
      uncertainty: classifyUncertainty(population, successCount),
      sourceExecutionIds: [...working.sourceExecutionIds].sort(),
      evidenceRefs: [...working.evidenceRefs].sort(),
    });
  }

  // Deterministic entry order (canonical form stability).
  entries.sort((a, b) =>
    a.subjectKey < b.subjectKey
      ? -1
      : a.subjectKey > b.subjectKey
        ? 1
        : a.taskClass < b.taskClass
          ? -1
          : 1,
  );

  if (entries.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "no scorecard entry reached the minimum population threshold (a scorecard requires at least one adequately-populated entry — evidence over claims)",
      details: { definitionId: definition.id, minimumPopulation: definition.minimumPopulation },
    });
  }

  return {
    scorecardId: input.scorecardId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    scorecardVersion: input.scorecardVersion,
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    telemetrySchemaVersion: schemaVersion,
    populationFrom: input.populationFrom,
    populationTo: input.populationTo,
    totalPopulation: input.telemetry.length,
    entries,
    computedAt: input.computedAt,
  };
}

/**
 * Validate a full scorecard (round-trip validation for store reads).
 * Fails closed on: missing version anchors, empty entries, empty
 * per-entry source/evidence binding, heterogeneous subject kinds.
 */
export function validateScorecard(value: unknown): asserts value is Scorecard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "scorecard must be an object" });
  }
  const card = value as Record<string, unknown>;
  for (const key of [
    "scorecardId",
    "definitionId",
    "applicationId",
    "tenantId",
    "populationTo",
    "computedAt",
    "digest",
  ] as const) {
    if (typeof card[key] !== "string" || (card[key] as string).length === 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `scorecard ${key} must be a non-empty string`,
        details: { field: key },
      });
    }
  }
  for (const key of [
    "definitionVersion",
    "scorecardVersion",
    "telemetrySchemaVersion",
    "totalPopulation",
  ] as const) {
    const version = card[key];
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `scorecard ${key} must be a positive integer (version anchors, M13)`,
        details: { field: key },
      });
    }
  }
  if (typeof card.totalPopulation === "number" && card.totalPopulation < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "scorecard totalPopulation must be >= 1 (a scorecard aggregates a real population)",
    });
  }
  const entries = card.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "scorecard entries must be a non-empty array",
    });
  }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry must be an object",
      });
    }
    const record = entry as Record<string, unknown>;
    const subjectKind = record.subjectKind;
    if (typeof subjectKind !== "string" || !isScorecardSubjectKind(subjectKind)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry subjectKind must be the closed subject vocabulary",
        details: { allowed: SCORECARD_SUBJECT_KINDS },
      });
    }
    for (const key of ["subjectKey", "taskClass"] as const) {
      if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `scorecard entry ${key} must be a non-empty string`,
        });
      }
    }
    for (const key of ["population", "successCount", "meanLatencyMs"] as const) {
      const number = record[key];
      if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `scorecard entry ${key} must be a non-negative integer`,
        });
      }
    }
    const population = record.population;
    const successCount = record.successCount;
    if (
      typeof population === "number" &&
      typeof successCount === "number" &&
      successCount > population
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry successCount cannot exceed population",
      });
    }
    if (
      typeof record.successRate !== "number" ||
      record.successRate < 0 ||
      record.successRate > 1
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry successRate must be in [0,1]",
      });
    }
    if (
      typeof record.meanCostMicroUsd !== "string" ||
      !/^\d{1,19}$/.test(record.meanCostMicroUsd)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry meanCostMicroUsd must be an integer micro-USD string",
      });
    }
    if (
      record.verificationPassRate !== null &&
      (typeof record.verificationPassRate !== "number" ||
        record.verificationPassRate < 0 ||
        record.verificationPassRate > 1)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry verificationPassRate must be in [0,1] or null",
      });
    }
    const uncertainty = record.uncertainty;
    if (
      typeof uncertainty !== "object" ||
      uncertainty === null ||
      Array.isArray(uncertainty) ||
      !(UNCERTAINTY_LEVELS as readonly string[]).includes(
        (uncertainty as Record<string, unknown>).level as string,
      )
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "scorecard entry uncertainty must carry an honest level classification",
      });
    }
    // M10/M11: per-entry traceability is mandatory.
    for (const key of ["sourceExecutionIds", "evidenceRefs"] as const) {
      const refs = record[key];
      if (
        !Array.isArray(refs) ||
        refs.length === 0 ||
        refs.some((ref) => typeof ref !== "string")
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `scorecard entry ${key} must be a non-empty array of strings (M10/M11 traceability)`,
          details: { field: key },
        });
      }
    }
  }
}
