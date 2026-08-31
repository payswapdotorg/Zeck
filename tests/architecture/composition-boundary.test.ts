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
 *  - the migration inventory claim: 0010 is the only new migration,
 *    no version renumbering (the collision rule).
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

  test("the migration inventory claim: 0010 is unique and next (the collision rule)", () => {
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => Number(name.slice(0, 4)))
      .sort((a, b) => a - b);
    const unique = new Set(migrations);
    expect(unique.size).toBe(migrations.length); // globally unique
    expect(migrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
