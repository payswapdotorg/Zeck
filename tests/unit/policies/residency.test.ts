/**
 * Unit tests — the residency constraint plane (WORK-060 / D-08,
 * SEC-003): a policy-CONSUMED constraint with fail-closed evaluation.
 *
 * Proves: a tenant-declared constraint is satisfied when every durable
 * data-at-rest surface (authoritative state, artifact bytes, evidence)
 * lives in a required region; UNSATISFIED residency fails closed with
 * the typed refusal; malformed constraints/localities are refused
 * (residency-invalid); the deployment-seam enforcement projects the
 * environment region onto the three surfaces and fails closed for
 * undeclared environments; the canonical decision form is deterministic
 * (replayable provenance) and excludes volatile data.
 *
 * Also proves the NO-NEW-AUTHORITY boundary: the nine-dimension
 * restriction vocabulary is untouched (residency is not a restriction
 * dimension — no policy document can widen residency).
 */

import { describe, expect, test } from "vitest";
import { createResidencyEnforcement } from "../../../src/modules/policies/adapters/residency-enforcement";
import {
  DATA_AT_REST_SURFACES,
  evaluateResidencyConstraint,
  isResidencyRefused,
} from "../../../src/modules/policies/domain/residency";
import { POLICY_DIMENSIONS } from "../../../src/modules/policies/public";

const LOCALITIES = [
  { surface: "authoritative-state" as const, region: "eu-west" },
  { surface: "artifact-bytes" as const, region: "eu-west" },
  { surface: "evidence" as const, region: "eu-west" },
];

describe("the residency constraint evaluation (pure, fail-closed)", () => {
  test("a satisfied constraint proves every durable surface's locality", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west"] },
      LOCALITIES,
    );
    expect(outcome.outcome).toBe("satisfied");
    if (outcome.outcome === "satisfied") {
      expect(outcome.surfaces).toHaveLength(3);
      expect(outcome.requiredRegions).toEqual(["eu-west"]);
    }
  });

  test("a multi-region constraint is satisfied when the surface region is among them", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west", "us-east"] },
      LOCALITIES,
    );
    expect(outcome.outcome).toBe("satisfied");
  });

  test("UNSATISFIED residency FAILS CLOSED with the typed refusal naming every violating surface", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["us-east"] },
      LOCALITIES,
    );
    expect(outcome.outcome).toBe("refused");
    expect(isResidencyRefused(outcome)).toBe(true);
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.kind).toBe("residency-unsatisfied");
      expect(outcome.refusal.problems).toHaveLength(3);
      for (const problem of outcome.refusal.problems) {
        expect(problem).toContain("fails closed");
        expect(problem).toContain("eu-west");
      }
    }
  });

  test("a single violating surface refuses the whole constraint (fail closed on any surface)", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west"] },
      [...LOCALITIES.slice(0, 2), { surface: "evidence" as const, region: "us-east" }],
    );
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.problems.join("\n")).toContain("evidence surface");
      expect(outcome.refusal.problems.join("\n")).not.toContain("authoritative-state surface");
    }
  });

  test("an unprovable locality (empty list) fails closed when a constraint is declared", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west"] },
      [],
    );
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.problems[0] ?? "").toContain("unprovable locality fails closed");
    }
  });

  test("malformed constraints are refused as residency-invalid (garbage never silently passes)", () => {
    for (const constraint of [
      { tenantId: "", requiredRegions: ["eu-west"] },
      { tenantId: "tenant-a", requiredRegions: [] },
      { tenantId: "tenant-a", requiredRegions: ["EU WEST"] },
      { tenantId: "tenant-a", requiredRegions: ["eu-west", "eu-west"] },
    ]) {
      const outcome = evaluateResidencyConstraint(constraint, LOCALITIES);
      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome === "refused") {
        expect(outcome.refusal.kind).toBe("residency-invalid");
      }
    }
  });

  test("malformed localities are refused", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west"] },
      [{ surface: "authoritative-state" as const, region: "Not A Region" }],
    );
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.kind).toBe("residency-invalid");
      expect(outcome.refusal.problems.join("\n")).toContain("malformed region");
    }
  });

  test("unknown surfaces are refused", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["eu-west"] },
      [{ surface: "not-a-surface" as "authoritative-state", region: "eu-west" }],
    );
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.problems.join("\n")).toContain("unknown data-at-rest surface");
    }
  });

  test("the canonical decision form is deterministic and replayable (EXECUTION-PROVENANCE)", () => {
    const constraint = { tenantId: "tenant-a", requiredRegions: ["eu-west", "us-east"] };
    const first = evaluateResidencyConstraint(constraint, LOCALITIES);
    const second = evaluateResidencyConstraint(constraint, LOCALITIES);
    expect(first.canonicalForm).toBe(second.canonicalForm);
    // Order of localities does not change the decision semantics.
    const reordered = evaluateResidencyConstraint(constraint, [...LOCALITIES].reverse());
    expect(reordered.outcome).toBe(first.outcome);
    // A different constraint produces a different canonical form.
    const other = evaluateResidencyConstraint(
      { tenantId: "tenant-b", requiredRegions: ["eu-west", "us-east"] },
      LOCALITIES,
    );
    expect(other.canonicalForm).not.toBe(first.canonicalForm);
  });

  test("the durable surface vocabulary is exactly the three SEC-003 surfaces", () => {
    expect(DATA_AT_REST_SURFACES).toEqual(["authoritative-state", "artifact-bytes", "evidence"]);
  });
});

describe("the deployment-seam enforcement (the adapter projection)", () => {
  const enforcement = createResidencyEnforcement({
    environments: [
      { id: "eu-environment", region: "eu-west" },
      { id: "us-environment", region: "us-east" },
    ],
  });

  test("localitiesFor projects all three durable surfaces at the environment's region", () => {
    const localities = enforcement.localitiesFor("eu-environment");
    expect(localities).toHaveLength(3);
    for (const locality of localities) {
      expect(locality.region).toBe("eu-west");
    }
    expect(localities.map((locality) => locality.surface).sort()).toEqual(
      [...DATA_AT_REST_SURFACES].sort(),
    );
  });

  test("satisfied constraints pass the seam (proven by test — AC3)", () => {
    const outcome = enforcement.enforce({
      tenantId: "tenant-a",
      requiredRegions: ["eu-west", "us-central"],
      environment: "eu-environment",
    });
    expect(outcome.outcome).toBe("satisfied");
  });

  test("unsatisfied constraints fail closed at the seam (AC3)", () => {
    const outcome = enforcement.enforce({
      tenantId: "tenant-a",
      requiredRegions: ["us-east"],
      environment: "eu-environment",
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.kind).toBe("residency-unsatisfied");
      expect(outcome.refusal.problems).toHaveLength(3);
    }
  });

  test("an undeclared environment has no provable locality — fails closed", () => {
    const outcome = enforcement.enforce({
      tenantId: "tenant-a",
      requiredRegions: ["eu-west"],
      environment: "not-declared",
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.problems[0] ?? "").toContain("unprovable locality fails closed");
    }
    expect(() => enforcement.localitiesFor("not-declared")).toThrow(
      /no provable data-at-rest locality — fail closed/,
    );
  });
});

describe("the no-new-authority boundary (residency is NOT an authorization dimension)", () => {
  test("the nine-dimension restriction vocabulary is untouched (residency is not a dimension)", () => {
    expect(POLICY_DIMENSIONS).toHaveLength(9);
    expect(POLICY_DIMENSIONS).not.toContain("residency");
    const serialized = JSON.stringify(POLICY_DIMENSIONS);
    expect(serialized).not.toContain("residency");
  });
});
