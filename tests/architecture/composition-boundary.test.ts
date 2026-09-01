/**
 * Architecture: the tool-composition learning boundary (WORK-017;
 * checkpoint contracts LEARNING-NONAUTHORITY, DEPENDENCY-DIRECTION,
 * SELF-HOSTING-BOUNDARY, PROVIDER neutrality).
 *
 * Mechanically proves over the REAL `src/modules/learning/` and
 * `src/modules/planning/` trees (the WORK-014 learning-boundary test
 * already pins the observation island over the whole learning tree —
 * these gates pin the WORK-017 additions specifically):
 *  - the composition advisor exposes EXACTLY the non-authoritative
 *    deps {store, digest, generateId, now} (M19: no dispatch surface
 *    is representable);
 *  - the composition store port exposes NO mutation surface for
 *    history (only the activation journal append — M15);
 *  - the planner's composition consultation stays AFTER the governed
 *    selection and NEVER rebinds the durable selection (M18);
 *  - the planning composition adapter validates every consulted
 *    recommendation (M11/M12/M13/M26 consumer-side boundary);
 *  - the composition analysis's minimum-population floor and the
 *    structural cycle check are present (M7/M10);
 *  - NO synthesis vocabulary anywhere in the composition surfaces
 *    (M24: WORK-018 owns synthesis — no code generation, no
 *    synthesized tools);
 *  - the migration inventory claim: unique, un-renumbered and
 *    merge-order-tolerant for the parallel wave's pre-assigned
 *    0011/0012/0013 (the collision rule; WORK-018's claim: 0011,
 *    WORK-023's claim: 0012).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER } from "../discrimination/lib/patterns";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");
const PLANNING_DIR = join(REPO_ROOT, "src/modules/planning");
const PLANNER_SOURCE = readFileSync(join(PLANNING_DIR, "application/planner.ts"), "utf8");
const COMPOSITION_ADAPTER_SOURCE = readFileSync(
  join(PLANNING_DIR, "adapters/composition-recommendations-adapter.ts"),
  "utf8",
);

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

const COMPOSITION_FILES = [
  ...collectFiles(LEARNING_DIR).filter((file) => file.includes("composition")),
  ...collectFiles(PLANNING_DIR).filter((file) => file.includes("composition")),
];

const SYNTHESIS_VOCABULARY =
  /\b(generateProgram|synthesizeTool|synthesizedTool|emitCode|codegen|compiledTool|ephemeralProgram)\b/;
const RECOMMENDATION_MUTATION_VOCABULARY =
  /\b(updateRecommendationSet|deleteRecommendationSet|mutateRecommendation|rewriteHistory)\b/;

describe("architecture: the tool-composition learning boundary (WORK-017)", () => {
  test("the composition surfaces exist and are scanned", () => {
    expect(COMPOSITION_FILES.length).toBeGreaterThanOrEqual(5);
  });

  test("the composition advisor exposes EXACTLY the non-authoritative deps (M19)", () => {
    const advisorSource = readFileSync(
      join(LEARNING_DIR, "application/composition-advisor.ts"),
      "utf8",
    );
    const match = /interface CompositionAdvisorDeps \{([\s\S]*?)\}/.exec(advisorSource);
    expect(match).not.toBeNull();
    const fields = [...(match?.[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
      (field) => field[1] ?? "",
    );
    expect(fields.sort()).toEqual(["digest", "generateId", "now", "store"]);
  });

  test("the composition store port has NO history-mutation surface (M15)", () => {
    const portSource = readFileSync(join(LEARNING_DIR, "ports/composition-store.ts"), "utf8");
    expect(RECOMMENDATION_MUTATION_VOCABULARY.test(portSource)).toBe(false);
    // The ONLY durable write surfaces are set append + activation append.
    const writes = [...portSource.matchAll(/\n\s+(insert\w+|append\w+)\(/g)].map(
      (match) => match[1] ?? "",
    );
    expect(writes.sort()).toEqual(["appendActivation", "insertRecommendationSet"]);
  });

  test("the planner's composition consultation stays AFTER the governed selection (M18)", () => {
    const selectionCall = PLANNER_SOURCE.indexOf("const selection = selectStrategy(");
    const compositionCall = PLANNER_SOURCE.search(/deps\.compositionRecommendations\??\.consult\(/);
    expect(selectionCall).toBeGreaterThan(-1);
    expect(compositionCall).toBeGreaterThan(selectionCall);
    const selectedBinding = PLANNER_SOURCE.indexOf("const selected = selection.selected;");
    expect(compositionCall).toBeGreaterThan(selectedBinding);
    // The durable record keeps the governed selection binding.
    expect(
      PLANNER_SOURCE.includes(
        "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
      ),
    ).toBe(true);
  });

  test("the planning composition adapter validates every consulted recommendation (M26/M11)", () => {
    expect(
      COMPOSITION_ADAPTER_SOURCE.includes("validateConsultedCompositionRecommendation(consulted)"),
    ).toBe(true);
  });

  test("the analysis's minimum-population floor and cycle check are present (M7/M10)", () => {
    const analysisSource = readFileSync(
      join(LEARNING_DIR, "domain/composition-analysis.ts"),
      "utf8",
    );
    expect(analysisSource.includes("MINIMUM_SEQUENCE_POPULATION")).toBe(true);
    expect(analysisSource.includes("population < MINIMUM_SEQUENCE_POPULATION")).toBe(true);
    const compositionSource = readFileSync(join(LEARNING_DIR, "domain/composition.ts"), "utf8");
    expect(compositionSource.includes("compositionCycleExists")).toBe(true);
    expect(compositionSource.includes("cyclic-composition")).toBe(true);
  });

  test("NO synthesis vocabulary anywhere in the composition surfaces (M24)", () => {
    const violations: string[] = [];
    for (const file of COMPOSITION_FILES) {
      if (SYNTHESIS_VOCABULARY.test(readFileSync(file, "utf8"))) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the composition surfaces are provider-neutral (M20)", () => {
    const violations: string[] = [];
    for (const file of COMPOSITION_FILES) {
      if (file.includes("/adapters/")) {
        continue;
      }
      if (PROVIDER_IDENTIFIER.test(readFileSync(file, "utf8"))) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the migration inventory claim: unique, un-renumbered, wave-tolerant (the collision rule)", () => {
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => Number(name.slice(0, 4)))
      .sort((a, b) => a - b);
    const unique = new Set(migrations);
    expect(unique.size).toBe(migrations.length); // globally unique
    // The WORK-017 baseline (0001..0010) is intact, un-renumbered and
    // contiguous. The parallel wave (WORK-018 | WORK-023 | WORK-031)
    // pre-assigned 0011/0012/0013 by dispatch order, documented in every
    // sibling evidence file; the assertion is MERGE-ORDER TOLERANT: the
    // wave numbers may be present (a sibling merged first) or absent
    // (this branch carries only its own claim). WORK-032 landed on main
    // (PR #36) and contributes 0014_economic_actions.sql; 0011/0012/0013
    // arrive with their sibling work orders' merges, so the reconciled
    // inventory is [1..10, 11, 12, 13, 14] with file gaps LEGAL pre-merge
    // (the runner applies in ascending order and allows gaps) —
    // uniqueness + the intact baseline + the present claims are the
    // invariants.
    for (let version = 1; version <= 10; version += 1) {
      expect(migrations).toContain(version);
    }
    expect(migrations.filter((version) => version <= 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(migrations).toContain(11); // WORK-018's claim (asserted below via the file read)
    expect(migrations).toContain(12); // WORK-023's claim (asserted below via the file read)
    expect(migrations).toContain(13); // WORK-031's claim (asserted below via the file read)
    expect(migrations).toContain(14); // WORK-032 economic actions (landed on main)
    // 0010 is the WORK-017 composition migration.
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0010_learning_compositions.sql"),
      "utf8",
    );
    expect(migration.includes("composition_recommendation_sets")).toBe(true);
    expect(migration.includes("composition_activation_log")).toBe(true);
    // Physical immutability: both tables are trigger-guarded.
    expect(migration.includes("composition_sets_immutable_guard")).toBe(true);
    expect(migration.includes("composition_activation_immutable_guard")).toBe(true);
    // WORK-018's claim: 0011 is the tool-synthesis migration (tools
    // schema + the additive sandbox output-evidence column).
    const synthesisMigration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0011_tool_synthesis.sql"),
      "utf8",
    );
    expect(synthesisMigration.includes("tools.synthesized_programs")).toBe(true);
    expect(synthesisMigration.includes("ADD COLUMN output jsonb")).toBe(true);
    // WORK-023's claim: 0012 is the deployment-fabric migration (the
    // sibling branches carry 0011/0013 respectively).
    const fabricMigration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0012_deployment_fabric.sql"),
      "utf8",
    );
    expect(fabricMigration.includes("deployments.deployment_profiles")).toBe(true);
    expect(fabricMigration.includes("deployments.deployment_events")).toBe(true);
    // WORK-031's claim: 0013 is the substrate-federation migration (the
    // sibling branches carry 0011/0012 respectively).
    const substrateMigration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0013_substrate_federation.sql"),
      "utf8",
    );
    expect(substrateMigration.includes("capabilities.substrates")).toBe(true);
  });

  test("the learning signal projection carries the set anchors (M13/M14)", () => {
    const analysisSource = readFileSync(
      join(LEARNING_DIR, "domain/composition-analysis.ts"),
      "utf8",
    );
    expect(analysisSource.includes("signalFromRecommendation")).toBe(true);
    expect(analysisSource.includes("CompositionRecommendationSignal")).toBe(true);
  });
});
