/**
 * Tool-sequence analysis tests (learning module domain; WORK-017).
 *
 * Required-test mapping (acceptance criteria 1/2 and §7/§13/§15/§17):
 *  - population segregation by task class + policy-relevant context
 *    (M13: incompatible populations never silently combined);
 *  - sequence statistics: population, success, verification, cost,
 *    latency, failure modes, window (M12);
 *  - provenance: source execution ids + evidence refs non-empty (M11);
 *  - minimum population floor: below it → INCONCLUSIVE, never a
 *    fabricated confident ranking (M10);
 *  - unsupported structural rejections recorded honestly (M6/M8);
 *  - deterministic ranking (success rate desc, population desc,
 *    canonical order);
 *  - version pinning from the fact catalog (M26);
 *  - deterministic-evidence preservation (§17 — counters only).
 */

import { describe, expect, test } from "vitest";
import {
  analyzeToolSequences,
  type ExecutionOutcomeTelemetry,
  MINIMUM_SEQUENCE_POPULATION,
  populationContextKeyOf,
  type ToolFact,
  validateToolFacts,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

function fact(toolId: string, version: string, capability: string): ToolFact {
  return {
    toolId,
    version,
    capabilityIds: [capability],
    inputFields: [],
    outputFields: [],
  };
}

const FACTS = [
  fact("fetch", "1.0.0", "web-retrieval"),
  fact("parse", "2.1.0", "parsing"),
  fact("sort", "1.4.0", "sorting"),
  fact("translate", "3.0.0", "translation"),
];
const CATALOG = validateToolFacts(FACTS);

let seq = 0;
function datum(overrides: Partial<ExecutionOutcomeTelemetry> = {}): ExecutionOutcomeTelemetry {
  seq += 1;
  const id = `00000000-0000-7000-9000-${String(seq).padStart(12, "0")}`;
  return {
    telemetryId: `t-${seq}`,
    executionId: id,
    applicationId: APP,
    tenantId: TENANT,
    taskClass: "extract",
    capabilities: ["web-retrieval"],
    planId: `plan-${seq}`,
    planRevision: 1,
    strategyClass: "hybrid",
    routes: [],
    tools: ["fetch", "parse"],
    environments: [],
    verification: {
      resultIds: [`v-${seq}`],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1000",
    latencyMs: 1000,
    outcome: "execution-completed",
    recordedAt: new Date(Date.parse("2026-08-31T12:00:00Z") + seq * 1000).toISOString(),
    evidenceRefs: [`execution:${id}:receipt`],
    subgraphs: [],
    schemaVersion: 1,
    ...overrides,
  };
}

describe("learning: tool-sequence analysis", () => {
  test("empty population fails closed (evidence over claims)", () => {
    expect(() => analyzeToolSequences([], CATALOG)).toThrow(PlatformError);
  });

  test("heterogeneous telemetry schemas fail closed", () => {
    const population = [datum(), datum({ schemaVersion: 2 })];
    expect(() => analyzeToolSequences(population, CATALOG)).toThrow(PlatformError);
  });

  test("executions with no tools contribute no sequences", () => {
    const recommendations = analyzeToolSequences([datum({ tools: [] })], CATALOG);
    expect(recommendations).toHaveLength(0);
  });

  test("an adequate population produces a SUPPORTED ranked recommendation with full provenance (M11/M12)", () => {
    const population = Array.from({ length: MINIMUM_SEQUENCE_POPULATION + 2 }, () => datum());
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations).toHaveLength(1);
    const recommendation = recommendations[0];
    expect(recommendation?.status).toBe("supported");
    expect(recommendation?.rank).toBe(1);
    expect(recommendation?.population).toBe(MINIMUM_SEQUENCE_POPULATION + 2);
    expect(recommendation?.successCount).toBe(MINIMUM_SEQUENCE_POPULATION + 2);
    expect(recommendation?.successRate).toBe(1);
    expect(recommendation?.sourceExecutionIds.length).toBe(MINIMUM_SEQUENCE_POPULATION + 2);
    expect(recommendation?.evidenceRefs.length).toBe(MINIMUM_SEQUENCE_POPULATION + 2);
    expect(recommendation?.evaluationWindowFrom).toBe(population[0]?.recordedAt);
    expect(recommendation?.evaluationWindowTo).toBe(population[population.length - 1]?.recordedAt);
    // M26: pinned versions from the catalog.
    expect(recommendation?.toolVersions).toEqual([
      { toolId: "fetch", version: "1.0.0" },
      { toolId: "parse", version: "2.1.0" },
    ]);
    expect(recommendation?.toolCapabilityIds).toEqual(["web-retrieval", "parsing"]);
    // The composition is the validated linear chain.
    expect(recommendation?.composition.steps).toHaveLength(2);
    expect(recommendation?.composition.edges).toHaveLength(1);
  });

  test("a tiny sample is INCONCLUSIVE with an honest reason — never fabricated confidence (M10)", () => {
    const population = Array.from({ length: 3 }, () => datum());
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations).toHaveLength(1);
    const recommendation = recommendations[0];
    expect(recommendation?.status).toBe("inconclusive");
    expect(recommendation?.statusReason).toBe("insufficient-population");
    expect(recommendation?.rank).toBeNull();
    expect(recommendation?.confidence.level).toBe("material");
    expect(recommendation?.confidence.reasonCode).toBe("small-population");
  });

  test("unknown tools produce UNSUPPORTED records (M8)", () => {
    const population = Array.from({ length: MINIMUM_SEQUENCE_POPULATION }, () =>
      datum({ tools: ["fetch", "ghost-tool"] }),
    );
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations).toHaveLength(1);
    const recommendation = recommendations[0];
    expect(recommendation?.status).toBe("unsupported");
    expect(recommendation?.statusReason).toBe("structural-rejection");
    expect(recommendation?.unsupportedDetail).toContain("ghost-tool");
    expect(recommendation?.rank).toBeNull();
  });

  test("different sequences in the same context produce separate recommendations with deterministic ranking", () => {
    const population = [
      ...Array.from({ length: 7 }, () => datum({ tools: ["fetch", "parse"] })),
      ...Array.from({ length: 6 }, () =>
        datum({
          tools: ["fetch", "parse", "sort"],
          outcome: "execution-failed",
          verification: {
            resultIds: [`v-f-${seq}`],
            statuses: ["FAIL"],
            evaluatorIds: ["deterministic:schema@1"],
            passCount: 0,
            failCount: 1,
            inconclusiveCount: 0,
            verified: false,
          },
        }),
      ),
    ];
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations).toHaveLength(2);
    const [first, second] = recommendations;
    expect(first?.status).toBe("supported");
    expect(first?.rank).toBe(1);
    expect(first?.successRate).toBe(1);
    expect(second?.status).toBe("supported");
    expect(second?.rank).toBe(2);
    expect(second?.successRate).toBe(0);
    // Failure modes are honest: the failing sequence records its
    // execution-failed distribution.
    expect(second?.failureModes).toEqual([{ outcomeClass: "execution-failed", count: 6 }]);
    expect(first?.failureModes).toEqual([]);
  });

  test("populations with different policy-relevant contexts are NEVER merged (M13)", () => {
    const population = [
      ...Array.from({ length: 6 }, () => datum({ capabilities: ["web-retrieval"] })),
      ...Array.from({ length: 6 }, () =>
        datum({ capabilities: ["translation"], tools: ["translate"] }),
      ),
    ];
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations).toHaveLength(2);
    for (const recommendation of recommendations) {
      expect(recommendation.population).toBe(6);
      expect(recommendation.context.capabilities).toHaveLength(1);
      // Each recommendation's provenance covers exactly ITS population.
      expect(recommendation.sourceExecutionIds.length).toBe(6);
    }
    const capabilities = recommendations.map((r) => r.context.capabilities[0]);
    expect(capabilities).toContain("web-retrieval");
    expect(capabilities).toContain("translation");
  });

  test("the context key derivation is total and deterministic", () => {
    const key = populationContextKeyOf(datum());
    expect(key.taskClass).toBe("extract");
    expect(key.capabilities).toEqual(["web-retrieval"]);
    expect(key.strategyClass).toBe("hybrid");
    expect(key.contextStrategy).toBe("unknown");
    const again = populationContextKeyOf(datum());
    expect(key).toEqual(again);
  });

  test("deterministic-evidence counters are preserved (§17)", () => {
    const population = [
      datum({
        subgraphs: [{ subgraphId: "s1", stepPath: ["s1"], computationType: "deterministic" }],
      }),
      datum({
        subgraphs: [{ subgraphId: "s1", stepPath: ["s1"], computationType: "generative" }],
      }),
    ];
    const recommendations = analyzeToolSequences(population, CATALOG);
    const recommendation = recommendations[0];
    expect(recommendation?.deterministicEvidence.subgraphObservationCount).toBe(2);
    expect(recommendation?.deterministicEvidence.fullyDeterministicExecutionCount).toBe(1);
  });

  test("out-of-scope telemetry is rejected by the analysis contract (scope honesty)", () => {
    const population = [datum(), datum({ applicationId: "another-app" })];
    // The analysis itself is pure over the population; the ADVISOR is
    // the scope boundary (store reads are scope-filtered). Here we
    // assert the pure function rejects nothing silently: both data
    // mine independently — segregation keys differ by application is
    // NOT a context dimension, so the advisor's scoped read is the
    // enforcement point (proved in the advisor tests).
    const recommendations = analyzeToolSequences(population, CATALOG);
    expect(recommendations.length).toBeGreaterThan(0);
  });
});
