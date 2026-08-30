/**
 * Deterministic sufficiency tests (planning module; WORK-009 / ADR-0007).
 *
 * The explicit sufficiency decision table: semantic requirement ⇒
 * insufficient; unmet capability ⇒ insufficient; confident quality gap ⇒
 * insufficient (deterministic would materially reduce the verified
 * outcome); target met but estimate unverified ⇒ UNCERTAIN (bounded
 * evaluation, never blind escalation); otherwise sufficient.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { CapabilityResolution } from "../../../src/modules/capabilities/public";
import {
  DETERMINISTIC_CATALOG_SEED,
  deriveTaskProfile,
  evaluateDeterministicSufficiency,
} from "../../../src/modules/planning/public";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const SATISFIED: CapabilityResolution = {
  satisfied: true,
  catalogRevision: "rev-1",
  satisfactions: [],
};

function catalogWith(overrides: Partial<(typeof DETERMINISTIC_CATALOG_SEED)[number]>) {
  return DETERMINISTIC_CATALOG_SEED.map((entry) =>
    entry.capabilityId === overrides.capabilityId ? { ...entry, ...overrides } : entry,
  );
}

describe("deterministic sufficiency (ADR-0007 decision table)", () => {
  test("a deterministic task with verified coverage is SUFFICIENT", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "arithmetic", input: { expression: "2+2" } } },
      digest,
    );
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(decision.outcome).toBe("sufficient");
    expect(decision.semanticReasoningRequired).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "deterministic-coverage-verified",
    );
    expect(decision.deterministicQualityEstimate).toBeGreaterThanOrEqual(profile.qualityTarget);
  });

  test("a semantic task is INSUFFICIENT for deterministic execution by construction", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "interpretation", input: { text: "..." } } },
      digest,
    );
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(decision.outcome).toBe("insufficient");
    expect(decision.reasons.map((reason) => reason.code)).toContain("semantic-reasoning-required");
  });

  test("a confident quality gap is INSUFFICIENT (material reduction of the verified outcome)", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "arithmetic", input: {}, qualityTarget: 0.9999 } },
      digest,
    );
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(decision.outcome).toBe("insufficient");
    expect(decision.reasons.map((reason) => reason.code)).toContain("quality-gap");
  });

  test("an UNVERIFIED estimate meeting the target is UNCERTAIN (bounded evaluation path)", () => {
    // structured-dataset-read is verified 0.999; force the uncertain
    // branch via an estimated catalog override.
    const profile = deriveTaskProfile(
      { task: { kind: "data-retrieval", input: { query: "x" }, qualityTarget: 0.9 } },
      digest,
    );
    expect(profile.capabilityRequirements[0]?.id).toBe("structured-dataset-read");
    const estimatedCatalog = catalogWith({
      capabilityId: "structured-dataset-read",
      qualityConfidence: "estimated",
      expectedQuality: 0.95,
    });
    const uncertain = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: estimatedCatalog,
    });
    expect(uncertain.outcome).toBe("uncertain");
    expect(uncertain.reasons.map((reason) => reason.code)).toContain("quality-unverified");
  });

  test("an unmet deterministic capability is INSUFFICIENT with capability-unmet", () => {
    const profile = deriveTaskProfile(
      { task: { kind: "validation", input: { schema: "x" } } },
      digest,
    );
    expect(profile.capabilityRequirements[0]?.id).toBe("json-schema-validation");
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: [], // no deterministic capabilities at all
    });
    expect(decision.outcome).toBe("insufficient");
    expect(decision.reasons.map((reason) => reason.code)).toContain("capability-unmet");
  });

  test("registry-unmet requirements are insufficient even when the planning catalog has the entry", () => {
    const profile = deriveTaskProfile({ task: { kind: "arithmetic", input: {} } }, digest);
    const unmet: CapabilityResolution = {
      satisfied: false,
      catalogRevision: "rev-1",
      unmet: [
        {
          requirementId: "numeric-computation",
          kind: "algorithm",
          reason: "unknown-capability",
          minVersion: null,
        },
      ],
    };
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: unmet,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(decision.outcome).toBe("insufficient");
    expect(
      decision.coverage.find((item) => item.requirementId === "numeric-computation")?.covered,
    ).toBe(false);
  });

  test("the chained quality estimate is the MINIMUM over covered entries", () => {
    const profile = deriveTaskProfile(
      {
        task: {
          kind: "mixed",
          input: {},
          requiredCapabilities: [
            { id: "numeric-computation", kind: "algorithm" },
            { id: "json-schema-validation", kind: "algorithm" },
          ],
          semanticReasoning: false,
          qualityTarget: 0.5,
        },
      },
      digest,
    );
    const decision = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(decision.outcome).toBe("sufficient");
    expect(decision.deterministicQualityEstimate).toBeCloseTo(0.999, 3);
  });

  test("the sufficiency decision is pure — no side effects, no route consultation", () => {
    const profile = deriveTaskProfile({ task: { kind: "arithmetic", input: {} } }, digest);
    const first = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    const second = evaluateDeterministicSufficiency({
      profile,
      resolution: SATISFIED,
      catalog: DETERMINISTIC_CATALOG_SEED,
    });
    expect(first).toEqual(second);
  });
});
