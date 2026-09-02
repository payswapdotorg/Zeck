/**
 * Deterministicization discovery (learning module domain; WORK-021 /
 * DTR-001; `spec/deterministicization-contract.md` Purpose; ADR-0008).
 *
 * DISCOVERY = OBSERVE + CHARACTERIZE, purely over the OBSERVED
 * execution-telemetry population (WORK-014's immutable records):
 *
 *   group terminal-execution observations by (task class, subgraph
 *   identity) where the subgraph's computation is AI work
 *   (`computationType` "generative" | "hybrid")
 *     → recurrence: occurrence count, aggregated observed AI cost,
 *       observed error fraction, first/last observation window
 *     → PROVENANCE: the source executions + evidence refs behind the
 *       group (a discovered subgraph without provenance is
 *       unrepresentable)
 *     → strength: a subgraph is a STRONG candidate when its recurrence
 *       meets the floor and its observed cost share is material
 *       (recurrence + cost are the honest signals — never a claim
 *       about semantic replaceability, which is the VALIDATION
 *       pipeline's business, DTR-002)
 *
 * DISCOVERY IS ADVISORY AND PURE: it proposes nothing durable, changes
 * nothing and reads only telemetry. The output is the input basis for
 * candidate PROPOSAL (the caller composes a candidate with an explicit
 * contract, program and incumbent binding — acceptance criterion 2).
 *
 * Provider-neutral by construction: routes are opaque strings. Pure
 * domain: no side effects, imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";
import type { ExecutionOutcomeTelemetry } from "./telemetry";

/**
 * The minimum recurrence for a subgraph to be reported as a candidate
 * (DTR-001 "recurring"). Configurable via `DiscoveryConfig`.
 */
export const DISCOVERY_MINIMUM_RECURRENCE = 5;

/** The computation types that count as AI work for DTR-001. */
export const AI_COMPUTATION_TYPES = ["generative", "hybrid"] as const;

export type AiComputationType = (typeof AI_COMPUTATION_TYPES)[number];

/** The discovery configuration (floors are configurable). */
export interface DiscoveryConfig {
  /** Minimum occurrence count (>= 1). */
  readonly minimumRecurrence: number;
  /** Restrict discovery to one task class (optional). */
  readonly taskClass?: string;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  minimumRecurrence: DISCOVERY_MINIMUM_RECURRENCE,
};

/** One characterized recurring AI subgraph — a discovery output. */
export interface DiscoveredSubgraph {
  readonly subgraphId: string;
  readonly stepPath: readonly string[];
  readonly computationType: string;
  readonly taskClass: string;
  /** The neutral route subjects observed on the subgraph (opaque). */
  readonly routes: readonly { readonly provider: string; readonly model: string }[];
  /** The tool identities observed alongside (opaque). */
  readonly tools: readonly string[];
  readonly occurrenceCount: number;
  /** Aggregated observed cost, integer micro-USD string. */
  readonly totalCostMicroUsd: string;
  /** Observed failure fraction in [0,1] (failures / occurrences). */
  readonly errorRate: number;
  readonly sourceExecutionIds: readonly string[];
  /** A sample of the source evidence refs (one per source execution). */
  readonly evidenceRefs: readonly string[];
  readonly windowFrom: string;
  readonly windowTo: string;
  /** The honest strength verdict + its reason codes. */
  readonly strong: boolean;
  readonly reasonCodes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a discovery configuration (fail closed). */
export function validateDiscoveryConfig(config: DiscoveryConfig): void {
  if (
    typeof config.minimumRecurrence !== "number" ||
    !Number.isInteger(config.minimumRecurrence) ||
    config.minimumRecurrence < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "discovery config minimumRecurrence must be a positive integer",
      details: { got: config.minimumRecurrence },
    });
  }
  if (
    config.taskClass !== undefined &&
    (typeof config.taskClass !== "string" || config.taskClass.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "discovery config taskClass must be a non-empty string when present",
    });
  }
}

function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}/${route.model}`;
}

/**
 * Discover recurring AI execution subgraphs in a telemetry population
 * (pure). The output is ordered by DESC aggregated observed cost (the
 * honest priority signal), then by subgraph id (deterministic).
 *
 * The population MUST be non-empty and every datum must be a validated
 * telemetry record (the store guarantees this); an empty population
 * returns an empty discovery (honest: nothing observed).
 */
export function discoverDeterminizationCandidates(
  population: readonly ExecutionOutcomeTelemetry[],
  config: DiscoveryConfig = DEFAULT_DISCOVERY_CONFIG,
): readonly DiscoveredSubgraph[] {
  validateDiscoveryConfig(config);

  interface Accumulator {
    readonly subgraphId: string;
    readonly stepPath: readonly string[];
    readonly computationType: string;
    readonly taskClass: string;
    occurrences: number;
    failures: number;
    totalCostMicroUsd: bigint;
    readonly routes: Map<string, { provider: string; model: string }>;
    readonly tools: Set<string>;
    readonly sourceExecutionIds: string[];
    readonly evidenceRefs: string[];
    windowFrom: string | null;
    windowTo: string | null;
  }

  const groups = new Map<string, Accumulator>();
  for (const datum of population) {
    if (
      !isRecord(datum) ||
      typeof datum.subgraphs !== "object" ||
      !Array.isArray(datum.subgraphs)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "discovery requires validated telemetry records (closed-shape subgraph observations)",
      });
    }
    if (config.taskClass !== undefined && datum.taskClass !== config.taskClass) {
      continue;
    }
    for (const subgraph of datum.subgraphs) {
      if (!isRecord(subgraph)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "discovery requires validated subgraph observations",
        });
      }
      const computationType = subgraph.computationType;
      if (typeof computationType !== "string") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "discovery requires the computationType axis on every subgraph observation",
        });
      }
      if (!(AI_COMPUTATION_TYPES as readonly string[]).includes(computationType)) {
        continue; // deterministic/retrieval/tool/human/verification subgraphs are not AI work
      }
      const subgraphId = subgraph.subgraphId;
      const stepPath = subgraph.stepPath;
      if (typeof subgraphId !== "string" || subgraphId.length === 0 || !Array.isArray(stepPath)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "discovery requires the subgraph identity axis on every observation",
        });
      }
      const key = `${datum.taskClass}\u0000${subgraphId}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          subgraphId,
          stepPath: [...stepPath],
          computationType,
          taskClass: datum.taskClass,
          occurrences: 0,
          failures: 0,
          totalCostMicroUsd: 0n,
          routes: new Map(),
          tools: new Set(),
          sourceExecutionIds: [],
          evidenceRefs: [],
          windowFrom: null,
          windowTo: null,
        };
        groups.set(key, group);
      }
      group.occurrences += 1;
      if (datum.outcome === "execution-failed") {
        group.failures += 1;
      }
      group.totalCostMicroUsd += BigInt(datum.costMicroUsd);
      for (const route of datum.routes) {
        group.routes.set(routeKey(route), { provider: route.provider, model: route.model });
      }
      for (const tool of datum.tools) {
        group.tools.add(tool);
      }
      group.sourceExecutionIds.push(datum.executionId);
      // A representative evidence sample: the FIRST evidence ref of
      // each source execution (the full refs stay on the telemetry rows).
      const firstRef = datum.evidenceRefs[0];
      if (typeof firstRef === "string" && firstRef.length > 0) {
        group.evidenceRefs.push(firstRef);
      }
      if (group.windowFrom === null || datum.recordedAt < group.windowFrom) {
        group.windowFrom = datum.recordedAt;
      }
      if (group.windowTo === null || datum.recordedAt > group.windowTo) {
        group.windowTo = datum.recordedAt;
      }
    }
  }

  const discovered: DiscoveredSubgraph[] = [];
  for (const group of groups.values()) {
    if (group.occurrences < config.minimumRecurrence) {
      continue;
    }
    const reasonCodes: string[] = [
      `recurrence:${group.occurrences}`,
      `task-class:${group.taskClass}`,
      `computation:${group.computationType}`,
    ];
    const strong = group.occurrences >= DISCOVERY_MINIMUM_RECURRENCE;
    if (strong) {
      reasonCodes.push("strong:recurrence-floor-met");
    } else {
      reasonCodes.push("weak:recurrence-below-default-floor");
    }
    if (group.totalCostMicroUsd > 0n) {
      reasonCodes.push("observed-cost:material");
    }
    discovered.push({
      subgraphId: group.subgraphId,
      stepPath: [...group.stepPath],
      computationType: group.computationType,
      taskClass: group.taskClass,
      routes: [...group.routes.values()],
      tools: [...group.tools],
      occurrenceCount: group.occurrences,
      totalCostMicroUsd: group.totalCostMicroUsd.toString(),
      errorRate: group.occurrences === 0 ? 0 : group.failures / group.occurrences,
      sourceExecutionIds: [...new Set(group.sourceExecutionIds)],
      evidenceRefs: [...new Set(group.evidenceRefs)],
      windowFrom: group.windowFrom ?? "",
      windowTo: group.windowTo ?? "",
      strong,
      reasonCodes,
    });
  }

  // Deterministic ordering: descending observed cost, then subgraph id.
  discovered.sort((left, right) => {
    const costLeft = BigInt(left.totalCostMicroUsd);
    const costRight = BigInt(right.totalCostMicroUsd);
    if (costLeft !== costRight) {
      return costLeft > costRight ? -1 : 1;
    }
    return left.subgraphId < right.subgraphId ? -1 : left.subgraphId > right.subgraphId ? 1 : 0;
  });
  return discovered;
}

/**
 * The canonical basis of the evaluation-corpus digest of a discovered
 * subgraph (content-addressed over the FULL provenance: the source
 * executions, their task class, subgraph identity and evidence refs —
 * the candidate identity binds to this).
 */
export function discoveryCorpusBasis(input: {
  readonly subgraphId: string;
  readonly taskClass: string;
  readonly computationType: string;
  readonly sourceExecutionIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly windowFrom: string;
  readonly windowTo: string;
}): Record<string, unknown> {
  return {
    corpusSchema: 1,
    subgraphId: input.subgraphId,
    taskClass: input.taskClass,
    computationType: input.computationType,
    sourceExecutionIds: [...input.sourceExecutionIds],
    evidenceRefs: [...input.evidenceRefs],
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
  };
}
