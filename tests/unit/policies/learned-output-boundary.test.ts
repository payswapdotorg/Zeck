/**
 * Unit: the learned-output restriction-vocabulary boundary (policies
 * module domain; WORK-020 / LRN-002, AC-2 — hard policy prohibitions
 * are immutable to learning output).
 *
 * The boundary makes a smuggled restriction STRUCTURALLY undeliverable:
 * a learned output record (any learning-produced artifact) may never
 * carry a policy restriction field or dimension key anywhere in its
 * JSON shape. Every typed restriction field of `RestrictionSet`
 * (POL-002) is exercised, plus nesting, arrays, non-walkable values
 * and the bounded-walk depth guard.
 */

import { describe, expect, test } from "vitest";
import {
  assertLearnedOutputFreeOfRestrictions,
  learnedOutputRestrictionViolations,
  type PolicySet,
  RESTRICTION_DIMENSION_VOCABULARY,
  RESTRICTION_FIELD_VOCABULARY,
} from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";

/** An honest learned route-metric record (adjacent vocabulary, allowed). */
const HONEST_LEARNED_METRIC = {
  subjectKey: "rail-a/model-x",
  population: 12,
  successCount: 11,
  successRate: 0.917,
  meanCostMicroUsd: "1000",
  meanLatencyMs: 1500,
  uncertaintyLevel: "material",
  uncertaintyReasonCode: "binomial-spread",
};

describe("policies: the learned-output restriction-vocabulary boundary", () => {
  test("the typed restriction vocabulary is the closed POL-002 leaf set", () => {
    expect(RESTRICTION_FIELD_VOCABULARY).toEqual([
      "maxCostMicroUsd",
      "minQuality",
      "maxLatencyMs",
      "allowedProviders",
      "deniedProviders",
      "allowedModels",
      "deniedModels",
      "allowedTools",
      "deniedTools",
      "egress",
      "allowedHosts",
      "deniedHosts",
      "access",
      "allowedSecretRefs",
      "deniedSecretRefs",
      "maxAutonomy",
      "minIsolation",
    ]);
    expect(RESTRICTION_DIMENSION_VOCABULARY).toEqual([
      "cost",
      "quality",
      "latency",
      "providerModel",
      "tool",
      "network",
      "secrets",
      "autonomy",
      "isolation",
    ]);
  });

  test("an honest learned record is clean (adjacent vocabulary allowed)", () => {
    const honest = {
      policyClass: "non-authoritative-learned-planning-policy",
      policyId: "p-1",
      policyVersion: 3,
      preferences: [
        {
          taskClass: "generation",
          ranked: [HONEST_LEARNED_METRIC],
          confidenceLevel: "material",
          evidenceRefs: ["execution:1:receipt"],
          sourceExecutionIds: ["exec-1"],
        },
      ],
    };
    expect(learnedOutputRestrictionViolations(honest)).toEqual([]);
    expect(() => assertLearnedOutputFreeOfRestrictions(honest)).not.toThrow();
  });

  test("every typed restriction field is rejected at the root", () => {
    for (const field of RESTRICTION_FIELD_VOCABULARY) {
      const smuggled = { ...HONEST_LEARNED_METRIC, [field]: "anything" };
      const violations = learnedOutputRestrictionViolations(smuggled);
      expect(violations).toEqual([`$.${field}`]);
    }
  });

  test("every restriction dimension key is rejected at the root", () => {
    for (const dimension of RESTRICTION_DIMENSION_VOCABULARY) {
      const smuggled = { preferences: [], [dimension]: {} };
      expect(learnedOutputRestrictionViolations(smuggled)).toEqual([`$.${dimension}`]);
    }
  });

  test("smuggled restrictions are detected at ANY depth (nested objects)", () => {
    const smuggled = {
      preferences: [
        {
          taskClass: "generation",
          ranked: [
            {
              ...HONEST_LEARNED_METRIC,
              provenance: { receipt: { deniedProviders: ["rail-forbidden"] } },
            },
          ],
        },
      ],
    };
    expect(learnedOutputRestrictionViolations(smuggled)).toEqual([
      "$.preferences[0].ranked[0].provenance.receipt.deniedProviders",
    ]);
  });

  test("smuggled restrictions are detected inside arrays", () => {
    const smuggled = {
      preferences: [{ ranked: [] }, { ranked: [{ tail: [{ maxCostMicroUsd: "1" }] }] }],
    };
    expect(learnedOutputRestrictionViolations(smuggled)).toEqual([
      "$.preferences[1].ranked[0].tail[0].maxCostMicroUsd",
    ]);
  });

  test("a PolicySet-like restriction document is wholesale rejected (learning may never carry one)", () => {
    const policyShaped: Pick<PolicySet, "documents"> = {
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: {
            cost: { maxCostMicroUsd: "1000" },
            providerModel: { deniedProviders: ["rail-b"] },
          },
        },
      ],
    };
    const violations = learnedOutputRestrictionViolations(policyShaped);
    expect(violations).toContain("$.documents[0].restrictions.cost");
    expect(violations).toContain("$.documents[0].restrictions.providerModel");
    expect(violations).toContain("$.documents[0].restrictions.cost.maxCostMicroUsd");
    expect(violations).toContain("$.documents[0].restrictions.providerModel.deniedProviders");
  });

  test("non-walkable values fail closed (learning output outside the JSON universe)", () => {
    // NaN, Infinity, symbols and functions are never policy-trustworthy.
    expect(learnedOutputRestrictionViolations({ value: Number.NaN })).toEqual([
      "<root>:non-walkable",
    ]);
    expect(learnedOutputRestrictionViolations({ value: Number.POSITIVE_INFINITY })).toEqual([
      "<root>:non-walkable",
    ]);
    expect(learnedOutputRestrictionViolations({ value: () => 1 })).toEqual(["<root>:non-walkable"]);
    expect(learnedOutputRestrictionViolations(undefined)).toEqual(["<root>:non-walkable"]);
  });

  test("absurd depth fails closed (bounded traversal)", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 16; index += 1) {
      deep = { nested: deep };
    }
    // The guard fires at the frozen depth limit (12) on the single chain.
    const violations = learnedOutputRestrictionViolations(deep);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^\$\.nested(\.nested){12}:walk-depth-exceeded$/);
  });

  test("assertLearnedOutputFreeOfRestrictions throws the POLICY_DENIED typed failure", () => {
    expect.assertions(3);
    try {
      assertLearnedOutputFreeOfRestrictions({
        preferences: [{ deniedModels: ["model-hot"] }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      const platformError = error as PlatformError;
      expect(platformError.code).toBe("POLICY_DENIED");
      expect((platformError.details as { violations: string[] }).violations).toEqual([
        "$.preferences[0].deniedModels",
      ]);
    }
  });

  test("a clean record with an empty preferences array is still clean (preference-only semantics)", () => {
    expect(learnedOutputRestrictionViolations({ preferences: [], digest: "a".repeat(64) })).toEqual(
      [],
    );
  });
});
