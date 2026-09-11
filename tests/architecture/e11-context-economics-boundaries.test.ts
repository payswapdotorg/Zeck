/**
 * Architecture: the E1.1 context-economics plane boundaries (WORK-052;
 * checkpoint contracts TENANT-ISOLATION, ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the
 *    context-economics plane imports ONLY the WORK-049 execution-ir
 *    foundation, the WORK-050 execution-compiler plane (the
 *    memoization-hook annotation contract it consumes) and its own
 *    local modules plus node builtins — no module, no integration,
 *    no api, no other platform plane.
 *  - C2 PROVIDER NEUTRALITY: the plane carries no vendor vocabulary.
 *  - C3 THE MODULE BOUNDARY: NO module/integration/api file references
 *    the plane — nothing depends on it for authority.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE: no
 *    execution-state vocabulary, no SQL, no db import, no store
 *    implementation, no new migration — the sole durable surface
 *    remains the WORK-049 decision-record store (the migration count
 *    stays 29: duplication accounting rides the EXISTING store at the
 *    caller's seam).
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes no
 *    admission/authorization vocabulary; the cache plan is evidence
 *    and mechanism, never an authorization input.
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURITY & DETERMINISM: no ambient clock, no randomness, no
 *    module-level mutable state anywhere in the plane (the decision
 *    modules are pure; the coalescer's coordinator holds only
 *    instance-level bounded state).
 *  - C8 THE CLOSED VOCABULARIES AND THE DECLARED FILE SET: the
 *    invariant codes, segment kinds, key classes, decision outcomes
 *    and reason codes are closed; the plane's file set is exactly the
 *    seven declared modules.
 *  - C9 BUILD-ON, NEVER-FORK: the WORK-049/050 foundation files are
 *    untouched by this plane and never reference it (the dependency
 *    direction is context-economics → foundation/compiler, never the
 *    reverse; the annotation consumption is read-only).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function listFiles(dir: string): string[] {
  const base = join(REPO_ROOT, dir);
  const walk = (current: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel, out);
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  const out: string[] = [];
  walk(base, dir, out);
  return out.sort();
}

const PLANE_FILES = listFiles("src/platform/context-economics");

/** The vendor vocabulary the plane must never carry. */
const VENDOR_WORDS = [
  "openrouter",
  "e2b",
  "daytona",
  "modal",
  "anthropic",
  "openai",
  "mistral",
  "groq",
  "cohere",
  "azure",
  "gemini",
  "vercel",
  "neon",
  "cloudflare",
  "fly-io",
  "aws-sdk",
  "@aws-sdk",
  "sigv4",
  "docker",
  "dockerode",
];

/** The execution-state vocabulary a second state machine would need. */
const EXECUTION_STATES = [
  "CREATED",
  "AUTHORIZED",
  "PLANNING",
  "QUEUED",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_USER",
  "WAITING_HUMAN",
  "VERIFYING",
  "REPLANNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
];

describe("E1.1 context-economics architecture boundaries (WORK-052)", () => {
  test("C1 the plane depends ONLY on execution-ir, execution-compiler, local modules and node builtins", () => {
    expect(PLANE_FILES.length).toBeGreaterThanOrEqual(7);
    for (const file of PLANE_FILES) {
      const content = read(file);
      const relativeImports = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of relativeImports) {
        const legal =
          specifier.startsWith("../execution-ir/") ||
          specifier.startsWith("../execution-compiler/") ||
          specifier.startsWith("./");
        expect(
          legal,
          `${file} imports ${specifier} (only ../execution-ir/*, ../execution-compiler/* and ./ are legal)`,
        ).toBe(true);
      }
      const externalImports = [...content.matchAll(/from\s+"([^."][^"]*)"/g)].map(
        (m) => m[1] ?? "",
      );
      for (const specifier of externalImports) {
        expect(specifier.startsWith("node:"), `${file} imports external ${specifier}`).toBe(true);
      }
    }
    // The repository-wide dependency-rule scanner over the plane.
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/context-economics/"),
    );
    expect(files.length).toBe(PLANE_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(
      violations.filter(
        (violation) =>
          violation.rule === "platform-isolation" || violation.rule === "undeclared-package-import",
      ),
    ).toStrictEqual([]);
  });

  test("C2 provider neutrality: no vendor vocabulary in the plane", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
  });

  test("C3 the module boundary: no module/integration/api references the plane", () => {
    for (const file of listFiles("src/modules")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("context-economics");
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain(
        "platform/context-economics",
      );
    }
    for (const file of listFiles("src/api")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("context-economics");
    }
  });

  test("C4 no second state machine and no second durable surface", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content, `${file} must not carry the execution state "${state}"`).not.toContain(
          `"${state}"`,
        );
      }
      expect(content, `${file} must not carry transition tables`).not.toContain("transitionTable");
      expect(content, `${file} must not carry SQL`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|SELECT\s+.*\s+FROM|CREATE\s+TABLE)\b/,
      );
      expect(content, `${file} must not import the db port`).not.toContain("../db/");
      expect(content, `${file} must not import the db port`).not.toContain("DatabasePort");
    }
    // No new migration: the set stays 29 (0030 is still the last) —
    // duplication accounting rides the EXISTING WORK-049 store.
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(31); // +0031_isolation_profiles (WORK-058) +0032_audit_compliance (WORK-059 / D-08)
    expect(migrations[migrations.length - 1]).toMatch(/^0032_audit_compliance/); // WORK-059 / D-08
    // No store implementation exists beyond the WORK-049 one.
    const implementors = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.content.includes("implements OptimizationDecisionStore"),
    );
    expect(implementors.map((file) => file.path)).toEqual([
      "src/platform/execution-ir/decision-store.ts",
    ]);
  });

  test("C5 evidence-only: no admission/authorization vocabulary on the plane surface", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`async ${word}`);
        expect(content, `${file} must not expose the type "${word}"`).not.toMatch(
          new RegExp(`(?:type|interface)\\s+${word}\\b`, "i"),
        );
      }
    }
  });

  test("C6 secret-free sources: no credential-shaped literals", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      expect(content, `${file} must not carry access-key literals`).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content, `${file} must not carry secret assignments`).not.toMatch(
        /(secretAccessKey|apiToken|password|apiKey)\s*[:=]\s*"[^"${}]+"/,
      );
    }
  });

  test("C7 purity and determinism: no ambient clock, randomness or module-level mutable state", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not construct dates`).not.toMatch(/new\s+Date\(/);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      // No module-level `let` (mutable module state breaks determinism;
      // the coalescer's registry is instance-level bounded state).
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
  });

  test("C8 the closed vocabularies and the declared file set", () => {
    const catalog = read("src/platform/context-economics/catalog.ts");
    // The invariant-code vocabulary is closed and listed.
    expect(catalog).toContain("export const CONTEXT_ECONOMICS_INVARIANT_CODES");
    // The segment-kind vocabulary is closed.
    expect(catalog).toContain("export const CONTEXT_SEGMENT_KINDS");
    // The cache-key classes are closed.
    expect(catalog).toContain("export const CACHE_KEY_CLASSES");
    // The decision vocabularies are closed.
    expect(catalog).toContain("export const CACHE_SITE_DECISIONS");
    expect(catalog).toContain("export const CACHE_COMPUTE_REASONS");
    expect(catalog).toContain("export const PREFIX_CACHE_DECISIONS");
    expect(catalog).toContain("export const COALESCE_DECISION_KINDS");
    expect(catalog).toContain("export const DUPLICATION_OUTCOME_KINDS");
    // The plane's file set is exactly the declared modules.
    expect(PLANE_FILES).toEqual([
      "src/platform/context-economics/accounting.ts",
      "src/platform/context-economics/catalog.ts",
      "src/platform/context-economics/coalesce.ts",
      "src/platform/context-economics/cost.ts",
      "src/platform/context-economics/keys.ts",
      "src/platform/context-economics/memo.ts",
      "src/platform/context-economics/plan.ts",
    ]);
  });

  test("C9 build-on, never-fork: the foundation and compiler files are untouched and never reference the plane", () => {
    const foundationFiles = listFiles("src/platform/execution-ir");
    expect(foundationFiles).toEqual([
      "src/platform/execution-ir/audit.ts",
      "src/platform/execution-ir/canonical.ts",
      "src/platform/execution-ir/constraints.ts",
      "src/platform/execution-ir/cost-model.ts",
      "src/platform/execution-ir/decision-record.ts",
      "src/platform/execution-ir/decision-store.ts",
      "src/platform/execution-ir/ir.ts",
      "src/platform/execution-ir/seams.ts",
    ]);
    const compilerFiles = listFiles("src/platform/execution-compiler");
    expect(compilerFiles).toEqual([
      "src/platform/execution-compiler/catalog.ts",
      "src/platform/execution-compiler/decisions.ts",
      "src/platform/execution-compiler/passes.ts",
      "src/platform/execution-compiler/pipeline.ts",
      "src/platform/execution-compiler/semantics.ts",
      "src/platform/execution-compiler/variant.ts",
    ]);
    // Neither foundation nor compiler references this plane (the
    // dependency direction is one-way: consumer → consumed).
    for (const file of [...foundationFiles, ...compilerFiles]) {
      const content = read(file);
      expect(content, `${file} must not depend on the context-economics plane`).not.toContain(
        "context-economics",
      );
    }
  });
});
