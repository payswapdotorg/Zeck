/**
 * VAL-001 acceptance criterion 1 (deterministic entrypoint + canonical
 * pointers), criterion 6 (surface-ownership governance rejects
 * simultaneous non-mechanical ownership) and criterion 7 (the validation
 * layer duplicates no product or development-state authority).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseAllowedSurfaces,
  resolveProgramEntrypoint,
  surfaceOwnershipConflicts,
  VALIDATION_PROGRAM,
  type ValidationStateSnapshot,
} from "../../../benchmarks/validation";

const REPO_ROOT = join(process.cwd());

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8"));
}

const state = {
  program: readJson("spec/validation-state/program-state.json"),
  frontier: readJson("spec/validation-state/frontier-state.json"),
  dependencies: readJson("spec/validation-state/dependency-state.json"),
} as ValidationStateSnapshot;

describe("validation: program entrypoint (VAL-001 AC1)", () => {
  test("the entrypoint is deterministic", () => {
    const a = resolveProgramEntrypoint({ baseRevision: "X", state });
    const b = resolveProgramEntrypoint({ baseRevision: "X", state });
    expect(a).toEqual(b);
    const c = resolveProgramEntrypoint({ baseRevision: "Y", state });
    expect(c).not.toEqual(a);
  });

  test("the entrypoint points at the canonical governing documents, which exist", () => {
    const documents = Object.values(VALIDATION_PROGRAM.canonicalDocuments);
    expect(documents.length).toBeGreaterThanOrEqual(6);
    for (const relative of documents) {
      const full = join(REPO_ROOT, relative);
      if (relative.endsWith(".json") || relative.endsWith(".md")) {
        expect(existsSync(full), `${relative} must exist`).toBe(true);
      } else {
        expect(existsSync(full), `${relative} (directory) must exist`).toBe(true);
      }
    }
    const entry = resolveProgramEntrypoint({ baseRevision: "X", state });
    expect(entry.roadmap).toBe("docs/VALIDATION-ROADMAP.md");
    expect(entry.techLeadContract).toBe("docs/LLM-VALIDATION-TECH-LEAD-CONTRACT.md");
  });
});

describe("validation: surface-ownership governance (VAL-001 AC6)", () => {
  test("the REAL in-flight set owns no conflicting surface", () => {
    const woDir = join(REPO_ROOT, "spec/validation-work-orders");
    const inFlight = state.frontier.inFlight;
    const parsed = inFlight
      .map((id) => {
        const file = join(woDir, `${id}.md`);
        if (!existsSync(file)) {
          return null;
        }
        return parseAllowedSurfaces({ workOrder: id, text: readFileSync(file, "utf8") });
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    expect(surfaceOwnershipConflicts(parsed)).toEqual([]);
  });

  test("the parser reads exactly the Allowed-surfaces block of a real spec", () => {
    const file = join(REPO_ROOT, "spec/validation-work-orders/VAL-001.md");
    const parsed = parseAllowedSurfaces({
      workOrder: "VAL-001",
      text: readFileSync(file, "utf8"),
    });
    expect(parsed.surfaces).toContain("benchmarks/validation/**");
    expect(parsed.surfaces).toContain("spec/validation-state/**");
    expect(parsed.surfaces).not.toContain("Forbidden");
  });

  test("two in-flight work orders owning the SAME surface are rejected (discrimination)", () => {
    const conflicts = surfaceOwnershipConflicts([
      { workOrder: "VAL-A", surfaces: ["docs/VALIDATION-REPORT.md"] },
      { workOrder: "VAL-B", surfaces: ["docs/VALIDATION-REPORT.md"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("surface-overlap");
  });

  test("a wildcard surface covering another's protected surface is rejected (discrimination)", () => {
    const conflicts = surfaceOwnershipConflicts([
      { workOrder: "VAL-A", surfaces: ["benchmarks/validation/**"] },
      { workOrder: "VAL-B", surfaces: ["benchmarks/validation/report.ts"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("overlapping-prefix");
  });

  test("disjoint additive directories are NOT conflicts (the mechanical case)", () => {
    const conflicts = surfaceOwnershipConflicts([
      { workOrder: "VAL-A", surfaces: ["benchmarks/validation/harness/**"] },
      { workOrder: "VAL-B", surfaces: ["benchmarks/validation/corpus/**"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("every validation work order spec declares an Allowed-surfaces block", () => {
    const woDir = join(REPO_ROOT, "spec/validation-work-orders");
    for (const name of readdirSync(woDir)) {
      if (!name.endsWith(".md") || name.includes("evidence")) {
        continue;
      }
      const parsed = parseAllowedSurfaces({
        workOrder: name.replace(/\.md$/, ""),
        text: readFileSync(join(woDir, name), "utf8"),
      });
      expect(parsed.surfaces.length, `${name} must declare allowed surfaces`).toBeGreaterThan(0);
    }
  });
});

describe("validation: authority isolation (VAL-001 AC7)", () => {
  test("spec/validation-state is the ONE validation-state authority (no duplication)", () => {
    expect(existsSync(join(REPO_ROOT, "spec/validation-state"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src/validation-state"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "benchmarks/validation/state.json"))).toBe(false);
  });

  test("the validation lab imports no product internals, platform or authority surface", () => {
    const labDir = join(REPO_ROOT, "benchmarks/validation");
    for (const name of readdirSync(labDir)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(labDir, name), "utf8");
      expect(text, `${name} must not import src/`).not.toMatch(/from\s+["']\.\.\/src\//);
      expect(text, `${name} must not import platform internals`).not.toMatch(/src\/platform\//);
      expect(text, `${name} must not import module internals`).not.toMatch(/\/internal\//);
    }
  });

  test("the validation layer holds no authority mutation channel (no network, no SQL, no mutation calls)", () => {
    const labDir = join(REPO_ROOT, "benchmarks/validation");
    for (const name of readdirSync(labDir)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(labDir, name), "utf8");
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(
        /\bfrom\s+["'](node:http|node:https|node:net|node:tls|undici|axios|got|node-fetch|pg|postgres)["']/,
      );
      expect(text, name).not.toMatch(/\b(INSERT INTO|DELETE FROM)\b/);
      expect(text, name).not.toMatch(
        /\.(createExecution|registerAgent|publishVersion|promote|rollback|suspend|resume|retire|reserve|settle|release|submitWork)\s*\(/,
      );
    }
  });
});
