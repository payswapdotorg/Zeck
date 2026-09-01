/**
 * Architecture: the substrate federation boundary (WORK-031, CSX-001..004;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, EXECUTION-PROVENANCE).
 *
 * Mechanically proves over the REAL trees:
 *
 *  - F1 the substrate contract is provider-neutral: no provider
 *    identifier, no vendor SKU/rail anywhere in the capabilities
 *    substrate tree or the planning substrate tree;
 *  - F2 the substrate registry publishes claims through the EXISTING
 *    capability registry (no second registry: the substrate registry's
 *    deps are pinned to {store, registry, digest, generateId, now} —
 *    no policy/budget/execution seam);
 *  - F3 the CSX-003 ordering is structural: the planner's substrate
 *    consultation sits AFTER policy/capability/sufficiency/selection
 *    (the step 7.7 placement) and the selection validation rejects
 *    pre-ordering captures (pinned by the unit suite; here the
 *    planner source order);
 *  - F4 deterministic-first before substrate selection: the planner
 *    short-circuits "no-substrate-required" BEFORE consulting the
 *    catalog (the source order is pinned);
 *  - F5 the workload-class vocabulary is declared ONCE (capabilities
 *    domain) and consumed via public barrels (no duplicate vocabulary
 *    in planning);
 *  - F6 the migration claim: 0013 with physical guards + the
 *    parallel-wave collision-rule documentation;
 *  - F7 the integration is non-authoritative: the federation service
 *    holds no registry/validation regime (it delegates to the
 *    capabilities authority) and the operator adapter port has no
 *    execution surface;
 *  - F8 no execution state machine: the substrate trees contain no
 *    executions transition vocabulary (executions remain the runs).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER } from "../discrimination/lib/patterns";

const REPO_ROOT = join(process.cwd());

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

const SUBSTRATE_FILES = [
  ...collectFiles(join(REPO_ROOT, "src/modules/capabilities")).filter((f) =>
    f.includes("substrate"),
  ),
  ...collectFiles(join(REPO_ROOT, "src/modules/planning")).filter(
    (f) => f.includes("substrate") || f.includes("workload-class"),
  ),
  ...collectFiles(join(REPO_ROOT, "src/integrations/substrate-federation")),
];

const PLANNER_SOURCE = readFileSync(
  join(REPO_ROOT, "src/modules/planning/application/planner.ts"),
  "utf8",
);

describe("architecture: the substrate federation boundary (WORK-031)", () => {
  test("the substrate trees are present and scanned", () => {
    expect(SUBSTRATE_FILES.length).toBeGreaterThan(10);
  });

  test("F1: provider neutrality across the substrate trees", () => {
    const violations: string[] = [];
    for (const file of SUBSTRATE_FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (PROVIDER_IDENTIFIER.test(text)) {
        violations.push(`${relative}: provider identifier`);
      }
      if (/\b(A100|H100|T4|V100|kubernetes|aws|gcp|azure)\b/i.test(text)) {
        violations.push(`${relative}: vendor SKU/cloud identifier`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("F2: the substrate registry deps are pinned (claims through the EXISTING registry)", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/modules/capabilities/application/substrate-registry.ts"),
      "utf8",
    );
    const depsMatch = /export interface SubstrateRegistryDeps \{([\s\S]*?)\n\}/.exec(source);
    expect(depsMatch).not.toBeNull();
    const depNames = [...(depsMatch?.[1] ?? "").matchAll(/readonly (\w+):/g)]
      .map((m) => m[1] ?? "")
      .sort();
    expect(depNames).toEqual(["digest", "generateId", "now", "registry", "store"]);
    // The claim publishes through the existing registry.
    expect(source.includes("registry.publish({")).toBe(true);
    for (const forbidden of ["ToolAdmission", "BudgetAuthority", "ExecutionService", "nextState"]) {
      expect(source.includes(forbidden), `registry must not mention ${forbidden}`).toBe(false);
    }
  });

  test("F3: the planner's substrate consultation sits AFTER the governed selection (CSX-003)", () => {
    const compositionIndex = PLANNER_SOURCE.indexOf(
      "7.6 OPTIONAL composition-recommendation consultation",
    );
    const substrateIndex = PLANNER_SOURCE.indexOf("7.7 OPTIONAL substrate selection");
    const decisionIndex = PLANNER_SOURCE.indexOf("8. The durable decision record");
    expect(compositionIndex).toBeGreaterThan(-1);
    expect(substrateIndex).toBeGreaterThan(compositionIndex);
    expect(decisionIndex).toBeGreaterThan(substrateIndex);
    // The ordering evidence is captured on the record.
    expect(PLANNER_SOURCE.includes("policyInputsCaptured: true")).toBe(true);
  });

  test("F4: deterministic-first — the no-substrate short-circuit precedes the catalog consultation", () => {
    const noSubstrateIndex = PLANNER_SOURCE.indexOf('"no-substrate-required"');
    const catalogIndex = PLANNER_SOURCE.indexOf("deps.substrateCatalog.listAvailable");
    expect(noSubstrateIndex).toBeGreaterThan(-1);
    expect(catalogIndex).toBeGreaterThan(-1);
    expect(noSubstrateIndex).toBeLessThan(catalogIndex);
    expect(PLANNER_SOURCE.includes('sufficiency.outcome === "sufficient"')).toBe(true);
  });

  test("F5: the workload-class vocabulary is declared ONCE (capabilities) and consumed via barrels", () => {
    const capabilitiesDomain = readFileSync(
      join(REPO_ROOT, "src/modules/capabilities/domain/substrate.ts"),
      "utf8",
    );
    expect(capabilitiesDomain.includes("export const WORKLOAD_CLASSES")).toBe(true);
    // Planning consumes it through the public barrel, never re-declares.
    const planningWorkload = readFileSync(
      join(REPO_ROOT, "src/modules/planning/domain/workload-class.ts"),
      "utf8",
    );
    expect(planningWorkload.includes('from "../../capabilities/public"')).toBe(true);
    expect(planningWorkload.includes("export const WORKLOAD_CLASSES")).toBe(false);
  });

  test("F6: the migration claim (0013, the collision rule, physical guards)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0013_substrate_federation.sql"),
      "utf8",
    );
    expect(migration.includes("capabilities.substrates")).toBe(true);
    expect(migration.includes("substrates_core_guard")).toBe(true);
    expect(migration.includes("substrates_lifecycle_guard")).toBe(true);
    expect(migration.includes("substrates_no_delete_guard")).toBe(true);
    expect(migration.includes("substrates_identity_unique")).toBe(true);
    // The parallel-wave collision-rule discipline is documented.
    expect(migration.includes("WORK-018 claims 0011")).toBe(true);
    expect(migration.includes("WORK-023 claims 0012")).toBe(true);
    expect(migration.includes("WORK-031 claims 0013")).toBe(true);
  });

  test("F7: the integration is non-authoritative (delegation to the capabilities authority)", () => {
    const service = readFileSync(
      join(REPO_ROOT, "src/integrations/substrate-federation/application/federation-service.ts"),
      "utf8",
    );
    // Delegates validation + publication to the capabilities authority.
    expect(service.includes("validateComputationalSubstrate")).toBe(true);
    expect(service.includes("substrateRegistry.publish")).toBe(true);
    for (const forbidden of [
      "createCapabilityRegistry",
      "ExecutionService",
      "ToolAdmission",
      "BudgetAuthority",
      "nextState",
      "createExecution",
    ]) {
      expect(service.includes(forbidden), `the integration must not carry ${forbidden}`).toBe(
        false,
      );
    }
    const operatorPort = readFileSync(
      join(REPO_ROOT, "src/integrations/substrate-federation/ports/operator-adapter.ts"),
      "utf8",
    );
    for (const forbidden of ["execute(", "invoke(", "admit(", "authorize(", "dispatch("]) {
      expect(
        operatorPort.includes(forbidden),
        `the operator port must not carry ${forbidden}`,
      ).toBe(false);
    }
  });

  test("F8: no execution state machine in the substrate trees", () => {
    const violations: string[] = [];
    for (const file of SUBSTRATE_FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      for (const pattern of [/\bEXECUTION_COMMANDS\b/, /\bnextState\b/, /\bappendEvent\b/]) {
        if (pattern.test(text)) {
          violations.push(`${relative}: ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
