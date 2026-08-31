/**
 * Architecture: the learning module boundary and non-authority surface
 * (WORK-014; checkpoint contracts LEARNING-NONAUTHORITY,
 * AUTH-PRESERVATION, DEPENDENCY-DIRECTION, PROVIDER neutrality).
 *
 * Mechanically proves over the REAL `src/modules/learning/` tree:
 *  - learning imports NO other module — not even public barrels: the
 *    module is an observation island (M2/M3/M4/M5/M6/M17: learning has
 *    no seam through which it could reach policy, budgets, capabilities,
 *    verification, executions, models, tools, agents or the planner);
 *  - learning domain/application/ports never import the platform (the
 *    shared dependency-rules engine covers this; pinned explicitly);
 *  - learning domain is provider-neutral (M18: the provider-identifier
 *    scanner over every domain file);
 *  - learning contains NO planner vocabulary (M17: no second planning
 *    authority — no selectStrategy/buildPlan/planner-version identity);
 *  - learning owns NO execution lifecycle vocabulary (M6: no transition
 *    commands, no state-machine calls);
 *  - learning owns NO deterministicization authority (M19: no
 *    promote/canary/rollout/replace decision surface — DTR identity is
 *    recorded, decisions belong to WORK-021);
 *  - the learning service and the shadow evaluator expose EXACTLY the
 *    non-authoritative dependency surface {store, digest, generateId,
 *    now} (M7/M8: a wiring that could authorize/dispatch/mutate is
 *    unrepresentable).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER } from "../discrimination/lib/patterns";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");

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

const FILES = collectFiles(LEARNING_DIR);

const RELATIVE_IMPORT = /from\s+["'](\.[^"']+)["']/g;
const CROSS_MODULE_IMPORT = /from\s+["']\.\.\/\.\.\/([a-z0-9-]+)\/(public|[a-z])/;
const PLATFORM_IMPORT = /from\s+["']\.\.\/\.\.\/\.\.\/platform\//;
const PLANNER_VOCABULARY =
  /\b(selectStrategy|buildPlan|PLANNER_VERSION|planExecution|strategySelection)\b/;
const EXECUTION_LIFECYCLE_VOCABULARY =
  /\b(nextState|canTransition|recordPlanningDecision|EXECUTION_COMMANDS|appendEvent)\b/;
const DETERMINISTICIZATION_AUTHORITY =
  /\b(promoteCandidate|canaryRollout|rolloutReplacement|applyDeterministicReplacement)\b/;

describe("architecture: the learning module boundary (WORK-014)", () => {
  test("the learning tree is present and scanned", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  test("learning imports NO other module (observation island — M2..M6, M17)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      let match = RELATIVE_IMPORT.exec(text);
      while (match !== null) {
        const specifier = match[1];
        if (specifier === undefined) {
          match = RELATIVE_IMPORT.exec(text);
          continue;
        }
        const cross = CROSS_MODULE_IMPORT.exec(specifier);
        if (cross !== null && cross[1] !== "shared") {
          violations.push(`${relative} -> ${specifier}`);
        }
        match = RELATIVE_IMPORT.exec(text);
      }
    }
    expect(violations).toEqual([]);
  });

  test("learning domain/application/ports never import the platform", () => {
    const violations: string[] = [];
    for (const layer of ["domain", "application", "ports"]) {
      for (const file of collectFiles(join(LEARNING_DIR, layer))) {
        const text = readFileSync(file, "utf8");
        if (PLATFORM_IMPORT.test(text)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("learning is provider-neutral in domain and contracts (M18)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      if (relative.includes("/adapters/")) {
        continue; // adapters may name neutral rail slugs in composition
      }
      const text = readFileSync(file, "utf8");
      const match = PROVIDER_IDENTIFIER.exec(text);
      if (match !== null) {
        violations.push(`${relative}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("learning contains NO planner vocabulary (M17: no second planning authority)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      const match = PLANNER_VOCABULARY.exec(text);
      if (match !== null) {
        violations.push(`${relative}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("learning contains NO execution lifecycle vocabulary (M6: no execution state authority)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      const match = EXECUTION_LIFECYCLE_VOCABULARY.exec(text);
      if (match !== null) {
        violations.push(`${relative}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("learning owns NO deterministicization authority (M19: DTR identity only)", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      const match = DETERMINISTICIZATION_AUTHORITY.exec(text);
      if (match !== null) {
        violations.push(`${relative}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the learning service and shadow evaluator expose EXACTLY the non-authoritative deps", () => {
    const serviceSource = readFileSync(
      join(LEARNING_DIR, "application/learning-service.ts"),
      "utf8",
    );
    const shadowSource = readFileSync(
      join(LEARNING_DIR, "application/shadow-evaluator.ts"),
      "utf8",
    );
    for (const [name, source] of [
      ["LearningServiceDeps", serviceSource],
      ["ShadowEvaluatorDeps", shadowSource],
    ] as const) {
      const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\}`).exec(source);
      expect(match, `${name} must exist`).not.toBeNull();
      const body = match?.[1] ?? "";
      const fields = [...body.matchAll(/readonly\s+(\w+)\s*:/g)].map((field) => field[1]);
      expect(fields.sort()).toEqual(["digest", "generateId", "now", "store"]);
    }
  });

  test("the public learning barrel carries the non-authority marker surface", async () => {
    const barrel = await import("../../src/modules/learning/public");
    expect(barrel.moduleDescriptor.id).toBe("learning");
    expect(barrel.LEARNING_SIGNAL_CLASS).toBe("non-authoritative-evidence-signal");
    // The barrel exposes consultation surfaces only — no authorize,
    // dispatch, mutate or transition entry points.
    const exportedNames = Object.keys(barrel);
    for (const forbidden of [
      "authorize",
      "dispatch",
      "admit",
      "reserve",
      "transition",
      "promote",
      "selectRoute",
      "mutate",
    ]) {
      expect(exportedNames.some((name) => name.toLowerCase().startsWith(forbidden))).toBe(false);
    }
  });
});
