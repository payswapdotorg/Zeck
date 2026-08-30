/**
 * Subgraph evidence tests (planning module; WORK-009 / DTR-001, DTR-004).
 *
 * The evidence contract for future deterministicization discovery and
 * codebase opportunity analysis: computation type, expected cost/quality,
 * verification strategy, repeated-use opportunity and deterministicization
 * potential — with recorded bases, and NO runtime authority.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildPlan,
  computationTypeOfStep,
  DETERMINISTIC_CATALOG_SEED,
  emitSubgraphEvidence,
} from "../../../src/modules/planning/public";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const CATALOG_BY_ID = new Map(DETERMINISTIC_CATALOG_SEED.map((e) => [e.capabilityId, e]));

describe("subgraph evidence (DTR-001 / DTR-004)", () => {
  test("step classes map to computation types", () => {
    expect(computationTypeOfStep({ id: "r", stepClass: "retrieve" })).toBe("retrieval");
    expect(computationTypeOfStep({ id: "m", stepClass: "call-model" })).toBe("generative");
    expect(computationTypeOfStep({ id: "v", stepClass: "verify" })).toBe("verification");
    expect(computationTypeOfStep({ id: "a", stepClass: "run-algorithm" })).toBe("deterministic");
    expect(computationTypeOfStep({ id: "h", stepClass: "ask-human" })).toBe("human");
    expect(computationTypeOfStep({ id: "t", stepClass: "call-tool" })).toBe("tool");
  });

  test("a deterministic plan emits one observation per step with catalog estimates", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          {
            id: "compute",
            stepClass: "run-algorithm",
            capabilityId: "numeric-computation",
            verificationStrategy: "exact-recomputation",
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "exact-recomputation" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const observations = emitSubgraphEvidence(plan, DETERMINISTIC_CATALOG_SEED);
    expect(observations).toHaveLength(2);
    const compute = observations.find((o) => o.subgraphId === "step:compute");
    expect(compute?.computationType).toBe("deterministic");
    expect(compute?.expectedCostMicroUsd).toBe(
      CATALOG_BY_ID.get("numeric-computation")?.expectedCostMicroUsd,
    );
    expect(compute?.verificationStrategy).toBe("exact-recomputation");
    expect(compute?.repeatedUseOpportunity.score).toBeGreaterThan(0.8);
    expect(compute?.deterministicizationPotential.score).toBe(0);
  });

  test("a hybrid plan additionally emits the whole-plan hybrid observation", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          {
            id: "retrieve",
            stepClass: "call-tool",
            capabilityId: "document-retrieval",
            verificationStrategy: "retrieval-recall-check",
          },
          {
            id: "model",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "retrieve", to: "model" },
          { from: "model", to: "verify" },
        ],
      },
      digest,
    );
    const observations = emitSubgraphEvidence(plan, DETERMINISTIC_CATALOG_SEED, {
      "rail-a\u0000model-x": { costMicroUsd: "1000", quality: 0.92 },
    });
    const whole = observations.find((o) => o.subgraphId === "plan:whole");
    expect(whole?.computationType).toBe("hybrid");
    expect(whole?.stepPath).toEqual(["retrieve", "model", "verify"]);
    expect(whole?.deterministicizationPotential.score).toBeGreaterThan(0.5);
    // Route costs flow into the generative step observation.
    const model = observations.find((o) => o.subgraphId === "step:model");
    expect(model?.expectedCostMicroUsd).toBe("1000");
    expect(model?.expectedQuality).toBe(0.92);
  });

  test("a pure deterministic plan does NOT emit a hybrid whole-plan observation", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "deterministic-only",
        steps: [
          { id: "compute", stepClass: "run-algorithm", capabilityId: "numeric-computation" },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "compute", to: "verify" }],
      },
      digest,
    );
    const observations = emitSubgraphEvidence(plan, DETERMINISTIC_CATALOG_SEED);
    expect(observations.find((o) => o.subgraphId === "plan:whole")).toBeUndefined();
  });

  test("unknown route estimates record honestly (quality 0 = unestimated)", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "generative",
        steps: [
          {
            id: "model",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-unknown", model: "model-z" },
          },
          { id: "verify", stepClass: "verify" },
        ],
        edges: [{ from: "model", to: "verify" }],
      },
      digest,
    );
    const observations = emitSubgraphEvidence(plan, DETERMINISTIC_CATALOG_SEED, {});
    const model = observations.find((o) => o.subgraphId === "step:model");
    expect(model?.expectedQuality).toBe(0);
    expect(model?.repeatedUseOpportunity.basis).toContain("model");
  });

  test("every observation carries auditable bases (evidence, not vibes)", () => {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "generative",
        steps: [
          {
            id: "model",
            stepClass: "generate",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
        ],
        edges: [],
      },
      digest,
    );
    const observations = emitSubgraphEvidence(plan, DETERMINISTIC_CATALOG_SEED, {
      "rail-a\u0000model-x": { costMicroUsd: "5", quality: 0.9 },
    });
    for (const observation of observations) {
      expect(observation.repeatedUseOpportunity.basis.length).toBeGreaterThan(0);
      expect(observation.deterministicizationPotential.basis.length).toBeGreaterThan(0);
    }
    const generative = observations.find((o) => o.computationType === "generative");
    expect(generative?.deterministicizationPotential.basis).toContain("DTR-002");
  });
});
