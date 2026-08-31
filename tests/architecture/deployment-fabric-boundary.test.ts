/**
 * Architecture: the deployment fabric boundary (WORK-023, MOD-001..004;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, EXECUTION-PROVENANCE).
 *
 * Mechanically proves over the REAL `src/modules/deployments/` tree:
 *
 *  - D1 the modality-adapter port carries NO authority surface
 *    (MOD-004): no admission/authorize/budget/execute/invoke method
 *    names, no store/service handles — duplicate authorities are
 *    unrepresentable in the port's shape, and the port's METHOD set
 *    is exactly the non-authoritative duo (M10..M15: ANY added
 *    authority-shaped method is a violation);
 *  - D2 the deployment service deps are pinned: exactly {store,
 *    agentInventory, environmentResolver, adapters, digest,
 *    generateId, now} — no policy/budget/capability/execution
 *    surface is reachable from the service;
 *  - D3 NO execution state machine: the deployments tree contains no
 *    executions transition vocabulary (no nextState/canTransition
 *    over execution commands, no EXECUTION_COMMANDS, no appendEvent
 *    onto the executions ledger);
 *  - D4 provider neutrality: no provider identifier and no vendor
 *    rail slug anywhere in the deployments tree;
 *  - D5 the module skeleton: the 19th architecture module is properly
 *    declared (shared module ids, architecture table, IMPLEMENTATION
 *    layout — the module-skeleton suite covers the full tree; here
 *    the deployments-specific claim);
 *  - D6 the migration claim: 0012 is the deployment-fabric migration
 *    with the physical guards (immutable artifacts, guarded lifecycle,
 *    append-only journal) and the parallel-wave collision rule
 *    documentation;
 *  - D7 the agents seam is read-only: the agent-inventory adapter
 *    calls only getAgent/listVersions (no registration, promotion or
 *    session mutation crosses);
 *  - D8 no cross-module internal imports (the shared dependency-rules
 *    engine covers the tree; pinned explicitly for the new module);
 *  - D9 the adapters' SQL WRITE targets are ONLY deployments.* tables
 *    (M22: no direct customer-domain workflow mutation, no
 *    cross-module SQL writes — reads stay the documented read-only
 *    precedents).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER } from "../discrimination/lib/patterns";
import { collectSourceFiles } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = join(process.cwd());
const DEPLOYMENTS_DIR = join(REPO_ROOT, "src/modules/deployments");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collectFiles(DEPLOYMENTS_DIR);

describe("architecture: the deployment fabric boundary (WORK-023)", () => {
  test("the deployments tree is present and scanned", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  test("D1: the modality-adapter port carries NO authority surface (MOD-004)", () => {
    const port = readFileSync(join(DEPLOYMENTS_DIR, "ports/modality-adapter.ts"), "utf8");
    // No admission/execution method names.
    for (const forbidden of [
      "admit(",
      "authorize(",
      "execute(",
      "invoke(",
      "dispatch(",
      "transition(",
      "ToolAdmission",
      "BudgetAuthority",
      "ExecutionService",
      "ExecutionStore",
    ]) {
      expect(port.includes(forbidden), `the adapter port must not carry "${forbidden}"`).toBe(
        false,
      );
    }
    // The interface surface is exactly the non-authoritative trio.
    expect(port.includes("checkBinding")).toBe(true);
    expect(port.includes("describeBinding")).toBe(true);
    expect(port.includes("descriptor")).toBe(true);
    // The port's METHOD set is EXACTLY the non-authoritative duo: ANY
    // added method (execute/verify/authorize/admit/registerAgent/…)
    // is an authority-shaped leak (M10..M15) and fails this gate.
    const adapterInterface =
      /export interface ModalityChannelAdapter \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    const methodNames = [
      ...adapterInterface.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm),
    ].map((m) => m[1] ?? "");
    expect([...new Set(methodNames)].sort()).toEqual(["checkBinding", "describeBinding"]);
  });

  test("D2: the deployment service deps are pinned (no authority seam)", () => {
    const service = readFileSync(
      join(DEPLOYMENTS_DIR, "application/deployment-service.ts"),
      "utf8",
    );
    const depsMatch = /export interface DeploymentServiceDeps \{([\s\S]*?)\n\}/.exec(service);
    expect(depsMatch).not.toBeNull();
    const depNames = [...(depsMatch?.[1] ?? "").matchAll(/readonly (\w+):/g)]
      .map((m) => m[1] ?? "")
      .sort();
    expect(depNames).toEqual([
      "adapters",
      "agentInventory",
      "digest",
      "environmentResolver",
      "generateId",
      "now",
      "store",
    ]);
    for (const forbidden of ["ToolAdmission", "BudgetAuthority", "ExecutionService", "nextState"]) {
      expect(service.includes(forbidden), `service must not mention ${forbidden}`).toBe(false);
    }
  });

  test("D3: NO execution state machine in the deployments tree", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      for (const pattern of [
        /\bEXECUTION_COMMANDS\b/,
        /\bnextState\b/,
        /\bappendEvent\b/,
        /\brecordPlanningDecision\b/,
        /\bcreateExecutionService\b/,
      ]) {
        if (pattern.test(text)) {
          violations.push(`${relative}: ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("D4: provider neutrality across the deployments tree", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (PROVIDER_IDENTIFIER.test(text)) {
        violations.push(`${relative}: provider identifier`);
      }
      // Vendor rail slugs never cross the public contracts.
      if (/["'](whatsapp|twilio|slack|telegram|vonage)["']/i.test(text)) {
        violations.push(`${relative}: vendor rail slug`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("D5: the 19th module is declared in the sync chain", () => {
    const shared = readFileSync(join(REPO_ROOT, "src/shared/module.ts"), "utf8");
    expect(shared.includes('"deployments"')).toBe(true);
    const architecture = readFileSync(join(REPO_ROOT, "spec/architecture.md"), "utf8");
    expect(architecture.includes("| `/deployments` |")).toBe(true);
    const implementation = readFileSync(join(REPO_ROOT, "IMPLEMENTATION.md"), "utf8");
    expect(implementation.includes("    deployments/")).toBe(true);
    const barrel = readFileSync(join(DEPLOYMENTS_DIR, "public.ts"), "utf8");
    expect(barrel.includes('moduleDescriptor: ModuleDescriptor = { id: "deployments" }')).toBe(
      true,
    );
  });

  test("D6: the migration claim (0012, the collision rule, physical guards)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0012_deployment_fabric.sql"),
      "utf8",
    );
    expect(migration.includes("deployments.deployment_profiles")).toBe(true);
    expect(migration.includes("deployments.deployment_plans")).toBe(true);
    expect(migration.includes("deployments.deployments")).toBe(true);
    expect(migration.includes("deployments.deployment_events")).toBe(true);
    expect(migration.includes("deployment_profiles_immutable_guard")).toBe(true);
    expect(migration.includes("deployment_plans_immutable_guard")).toBe(true);
    expect(migration.includes("deployments_lifecycle_guard")).toBe(true);
    expect(migration.includes("deployments_no_delete_guard")).toBe(true);
    expect(migration.includes("deployment_events_append_only_guard")).toBe(true);
    // The parallel-wave collision-rule discipline is documented.
    expect(migration.includes("WORK-018 claims 0011")).toBe(true);
    expect(migration.includes("WORK-023 claims 0012")).toBe(true);
    expect(migration.includes("WORK-031 claims 0013")).toBe(true);
    // MOD-002's identity binding is physical.
    expect(migration.includes("deployments_identity_unique")).toBe(true);
  });

  test("D7: the agents seam is read-only (the inventory adapter)", () => {
    const adapter = readFileSync(
      join(DEPLOYMENTS_DIR, "adapters/agent-inventory-adapter.ts"),
      "utf8",
    );
    expect(adapter.includes("registry.getAgent")).toBe(true);
    expect(adapter.includes("registry.listVersions")).toBe(true);
    for (const forbidden of [
      "registerAgent",
      "publishVersion",
      ".promote(",
      ".rollback(",
      "createSession",
    ]) {
      expect(adapter.includes(forbidden), `the agents seam must not call ${forbidden}`).toBe(false);
    }
  });

  test("D8: no rule violations over the deployments tree (the shared engine)", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const violations = scanDependencyRules(files, { allowedPackages: ["fastify"] });
    const deploymentViolations = violations.filter((v) =>
      v.path.startsWith("src/modules/deployments"),
    );
    expect(deploymentViolations.map((v) => `${v.rule} @ ${v.path}`)).toEqual([]);
  });

  test("D9: the adapters' SQL writes target ONLY the deployments schema (M22)", () => {
    const writeTargets: string[] = [];
    for (const file of FILES.filter((f) => f.includes("/adapters/"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+\.[a-z_]+)/gi,
      )) {
        writeTargets.push(`${file.slice(REPO_ROOT.length + 1)}: ${match[1]}`);
      }
    }
    // The durable store writes; every write targets deployments.*.
    expect(writeTargets.length).toBeGreaterThan(0);
    const foreign = writeTargets.filter((target) => {
      const schema = target.split(": ")[1]?.split(".")[0] ?? "";
      return schema !== "deployments";
    });
    expect(foreign).toEqual([]);
  });
});
