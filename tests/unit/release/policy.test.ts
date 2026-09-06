/**
 * Unit — the release promotion policy (WORK-047 / D-06; the
 * PROMOTION-GATES checkpoint): the repository policy loads against
 * the environments.json ladder, drift is unrepresentable, and the
 * pure promotion evaluation decides from recorded evidence only.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import type { ReleasePolicy } from "../../../src/platform/release/policy";
import { evaluatePromotion, loadReleasePolicy } from "../../../src/platform/release/policy";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const POLICY_SOURCE = readFileSync(
  resolve(REPO_ROOT, "deploy/manifests/release-policy.json"),
  "utf8",
);

/** The real manifest set (environments.json drives the ladder). */
function manifestWith(overrides?: {
  readonly promotionRequires?: Record<string, readonly string[]>;
}) {
  const reader = (file: string): string => {
    if (file !== "environments.json" || overrides?.promotionRequires === undefined) {
      return readFileSync(resolve(REPO_ROOT, "deploy/manifests", file), "utf8");
    }
    const environments = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "deploy/manifests", "environments.json"), "utf8"),
    ) as {
      environments: Record<string, { promotion: { requires: string[] } | null }>;
    };
    for (const [environment, requires] of Object.entries(overrides.promotionRequires)) {
      const target = environments.environments[environment];
      if (target?.promotion !== null && target?.promotion !== undefined) {
        target.promotion.requires = [...requires];
      }
    }
    return JSON.stringify(environments);
  };
  return loadDeploymentManifest(reader);
}

describe("the release policy loader (WORK-047 D-06)", () => {
  test("the repository policy loads against the real environments.json ladder", () => {
    const policy = loadReleasePolicy(POLICY_SOURCE, manifestWith());
    // The closed gate-kind vocabulary.
    const kinds = policy.gateKinds.map((gate) => gate.kind).sort();
    expect(kinds).toEqual(
      [
        "architect-approval",
        "ci-gates",
        "deployment-identity-audit",
        "full-test-suite",
        "governance-check",
        "health",
        "identity-audit",
        "lint",
        "migration",
        "preview-smoke",
        "staging-smoke",
        "typecheck",
        "validation",
      ].sort(),
    );
    // The ladder entry gates.
    expect(policy.entryGates.ci).toEqual([
      "governance-check",
      "typecheck",
      "lint",
      "full-test-suite",
    ]);
    expect(policy.entryGates.staging).toContain("migration");
    expect(policy.entryGates.staging).toContain("health");
    expect(policy.entryGates.production).toContain("architect-approval");
    // The environments.json requirements are COVERED (the cross-check).
    expect(policy.entryGates.ci).toEqual(
      expect.arrayContaining(["governance-check", "typecheck", "lint", "full-test-suite"]),
    );
    expect(policy.entryGates.staging).toEqual(
      expect.arrayContaining(["ci-gates", "preview-smoke"]),
    );
    expect(policy.entryGates.production).toEqual(
      expect.arrayContaining(["architect-approval", "staging-smoke", "deployment-identity-audit"]),
    );
  });

  test("DRIFT: an environments.json requirement missing from the policy refuses (the weakening mutation)", () => {
    const manifest = manifestWith({
      promotionRequires: {
        local: ["governance-check", "typecheck", "lint", "full-test-suite", "SOME-NEW-GATE"],
      },
    });
    expect(() => loadReleasePolicy(POLICY_SOURCE, manifest)).toThrow(
      /entryGates.ci must cover the environments.json requirement "SOME-NEW-GATE"/,
    );
  });

  test("REMOVED: dropping an environments.json requirement from the policy refuses", () => {
    // environments.json staging promotion requires architect-approval —
    // a policy whose production entry gates drop it must refuse.
    const weakened = JSON.parse(POLICY_SOURCE) as {
      entryGates: Record<string, string[]>;
    };
    const productionGates = weakened.entryGates.production ?? [];
    weakened.entryGates.production = productionGates.filter(
      (gate) => gate !== "architect-approval",
    );
    expect(() => loadReleasePolicy(JSON.stringify(weakened), manifestWith())).toThrow(
      /entryGates.production must cover the environments.json requirement "architect-approval"/,
    );
  });

  test("entry gates referencing undeclared kinds refuse (closed vocabulary)", () => {
    const mutated = JSON.parse(POLICY_SOURCE) as { entryGates: Record<string, string[]> };
    mutated.entryGates.ci = ["not-a-declared-gate"];
    expect(() => loadReleasePolicy(JSON.stringify(mutated), manifestWith())).toThrow(
      /not-a-declared-gate.*not declared in gateKinds/,
    );
  });

  test("a production entry-gate hole is representable only through explicit policy — an EMPTY production gate set that still covers environments.json refuses only on coverage", () => {
    const mutated = JSON.parse(POLICY_SOURCE) as { entryGates: Record<string, string[]> };
    mutated.entryGates.production = [];
    expect(() => loadReleasePolicy(JSON.stringify(mutated), manifestWith())).toThrow(
      /entryGates.production must cover/,
    );
  });

  test("invalid JSON and non-object sources refuse", () => {
    expect(() => loadReleasePolicy("not json", manifestWith())).toThrow(/not valid JSON/);
    expect(() => loadReleasePolicy("[]", manifestWith())).toThrow(
      /gateKinds must be a non-empty array/,
    );
    expect(() => loadReleasePolicy('{"gateKinds":[]}', manifestWith())).toThrow(
      /gateKinds must be a non-empty array/,
    );
    expect(() => loadReleasePolicy('{"gateKinds":[],"entryGates":{}}', manifestWith())).toThrow(
      /non-empty array/,
    );
  });
});

describe("the pure promotion evaluation", () => {
  const policy: ReleasePolicy = loadReleasePolicy(POLICY_SOURCE, manifestWith());

  test("no evidence: refused with the exact missing gates", () => {
    const evaluation = evaluatePromotion("staging", [], policy);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.missing).toEqual(policy.entryGates.staging);
    expect(evaluation.reason).toContain("promotion to staging is missing required gate evidence");
  });

  test("partial evidence: only the satisfied subset is reported satisfied", () => {
    const evaluation = evaluatePromotion(
      "staging",
      [
        { gateKind: "validation", status: "passed" },
        { gateKind: "health", status: "passed" },
        { gateKind: "migration", status: "failed" },
      ],
      policy,
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.satisfied).toContain("validation");
    expect(evaluation.satisfied).toContain("health");
    // A FAILED latest attempt is a missing gate (re-run to satisfy).
    expect(evaluation.missing).toContain("migration");
    expect(evaluation.missing).not.toContain("validation");
  });

  test("full evidence: allowed", () => {
    const evaluation = evaluatePromotion(
      "staging",
      policy.entryGates.staging.map((gateKind) => ({ gateKind, status: "passed" })),
      policy,
    );
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.missing).toEqual([]);
    expect(evaluation.reason).toBeNull();
  });

  test("extra evidence beyond the required set is harmless", () => {
    const evaluation = evaluatePromotion(
      "ci",
      [
        ...policy.entryGates.ci.map((gateKind) => ({ gateKind, status: "passed" })),
        { gateKind: "identity-audit", status: "passed" },
      ],
      policy,
    );
    expect(evaluation.allowed).toBe(true);
  });
});
