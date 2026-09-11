/**
 * Architecture: the E1.1 deterministic Execution Compiler boundaries
 * (WORK-050; checkpoint contracts ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE,
 * VERIFICATION-SEPARATION, CONCURRENCY-CRASH-SAFETY,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the compiler plane
 *    imports ONLY the WORK-049 execution-ir foundation, its own local
 *    modules and node builtins — no module, no integration, no api, no
 *    other platform plane (the compiler is built ON the foundation; it
 *    re-implements nothing).
 *  - C2 PROVIDER NEUTRALITY: the compiler plane carries no vendor
 *    vocabulary (no SDKs, no vendor names in its contracts — the pass
 *    and check vocabularies are closed and neutral).
 *  - C3 THE MODULE BOUNDARY: NO module file references the compiler
 *    plane — nothing depends on it for authority; the compiler
 *    consumes modules nowhere and is consumed nowhere.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE: no
 *    execution-state or event vocabulary, no status/transition
 *    columns, no SQL anywhere in the plane, no new migration, no
 *    store implementation — the sole durable surface remains the
 *    WORK-049 decision-record store.
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the compiler plane
 *    exposes no admission/authorization vocabulary; decision records
 *    are built as values; the plane holds no store client at all.
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURE FUNCTIONS & DETERMINISM: no ambient clock, no randomness,
 *    no module-level mutable state in the plane.
 *  - C8 THE CLOSED CATALOG: the pass vocabulary is exactly the
 *    charter's eleven transformations; the invariant and rejection
 *    vocabularies are closed (no open extension point).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { COMPILER_PASS_IDS } from "../../src/platform/execution-compiler/catalog";
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

const COMPILER_FILES = listFiles("src/platform/execution-compiler");

/** The vendor vocabulary the compiler plane must never carry. */
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

describe("E1.1 Execution Compiler architecture boundaries (WORK-050)", () => {
  test("C1 the compiler depends ONLY on the execution-ir foundation, local modules and node builtins", () => {
    expect(COMPILER_FILES.length).toBeGreaterThanOrEqual(6);
    for (const file of COMPILER_FILES) {
      const content = read(file);
      const relativeImports = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of relativeImports) {
        const legal = specifier.startsWith("../execution-ir/") || specifier.startsWith("./");
        expect(
          legal,
          `${file} imports ${specifier} (only ../execution-ir/* and ./ are legal)`,
        ).toBe(true);
      }
      const externalImports = [...content.matchAll(/from\s+"([^."][^"]*)"/g)].map(
        (m) => m[1] ?? "",
      );
      for (const specifier of externalImports) {
        expect(specifier.startsWith("node:"), `${file} imports external ${specifier}`).toBe(true);
      }
    }
    // The scanner proves the same over the whole tree: the compiler
    // plane has no rule violations (platform isolation, package
    // default-deny, import resolution — the foundation imports resolve
    // outside the filtered subset, exactly as in the WORK-049 B1
    // precedent, so the rule-filtered proof is the mechanical one).
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/execution-compiler/"),
    );
    expect(files.length).toBe(COMPILER_FILES.length);
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

  test("C2 provider neutrality: no vendor vocabulary in the compiler plane", () => {
    for (const file of COMPILER_FILES) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
    // The compiler's own vocabularies are closed and vendor-free.
    const words = COMPILER_PASS_IDS.join(" ").toLowerCase().split(/[-_]/);
    for (const word of words) {
      expect(VENDOR_WORDS).not.toContain(word);
    }
  });

  test("C3 the module boundary: no module references the compiler plane (no authority dependence)", () => {
    for (const file of listFiles("src/modules")) {
      const content = read(file);
      expect(content, `${file} must not reference the compiler plane`).not.toContain(
        "platform/execution-compiler",
      );
      expect(content, `${file} must not reference the compiler plane`).not.toContain(
        "execution-compiler",
      );
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the compiler plane`).not.toContain(
        "platform/execution-compiler",
      );
    }
  });

  test("C4 no second state machine and no second durable surface", () => {
    for (const file of COMPILER_FILES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content, `${file} must not carry the execution state "${state}"`).not.toContain(
          `"${state}"`,
        );
      }
      expect(content, `${file} must not carry transition tables`).not.toContain("transitionTable");
      // Case-sensitive SQL keywords (code-level SQL; English prose like
      // "select deterministically" in comments is not SQL).
      expect(content, `${file} must not carry SQL`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|SELECT\s+.*\s+FROM|CREATE\s+TABLE)\b/,
      );
      expect(content, `${file} must not import the db port`).not.toContain("../db/");
      expect(content, `${file} must not import the db port`).not.toContain("DatabasePort");
    }
    // No new migration: the migration set is unchanged (WORK-049's 0030
    // is still the last — the compiler adds NO durable state).
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

  test("C5 evidence-only: no admission/authorization vocabulary on the compiler surface", () => {
    for (const file of COMPILER_FILES) {
      const content = read(file);
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`async ${word}`);
      }
    }
  });

  test("C6 secret-free sources: no credential-shaped literals", () => {
    for (const file of COMPILER_FILES) {
      const content = read(file);
      expect(content, `${file} must not carry access-key literals`).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content, `${file} must not carry secret assignments`).not.toMatch(
        /(secretAccessKey|apiToken|password|apiKey)\s*[:=]\s*"[^"${}]+"/,
      );
    }
  });

  test("C7 pure functions and determinism: no ambient clock, randomness or module-level mutable state", () => {
    for (const file of COMPILER_FILES) {
      const content = read(file);
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not construct dates`).not.toMatch(/new\s+Date\(/);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      // No module-level `let` (mutable module state breaks purity).
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
  });

  test("C8 the transformation catalog is exactly the charter's eleven passes (closed)", () => {
    expect([...COMPILER_PASS_IDS]).toEqual([
      "constant-folding",
      "dead-step-elimination",
      "common-subexpression-reuse",
      "verification-insertion",
      "retry-normalization",
      "safe-parallelization",
      "batching",
      "memoization-hooks",
      "subgraph-decomposition",
      "result-shaping",
      "representation-ladder-hooks",
    ]);
    expect(COMPILER_FILES.length).toBe(6);
    // The plane's file set is exactly the declared engine modules.
    expect(COMPILER_FILES).toEqual([
      "src/platform/execution-compiler/catalog.ts",
      "src/platform/execution-compiler/decisions.ts",
      "src/platform/execution-compiler/passes.ts",
      "src/platform/execution-compiler/pipeline.ts",
      "src/platform/execution-compiler/semantics.ts",
      "src/platform/execution-compiler/variant.ts",
    ]);
  });

  test("the WORK-049 foundation files are untouched by this plane (build ON, never fork)", () => {
    // The foundation remains byte-stable at the dispatch base: the
    // compiler imports it, it never edits it (mechanically proven by
    // the changed-file inventory — this check pins the import-only
    // relationship from the compiler side).
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
    // No foundation file references the compiler (dependency direction:
    // compiler → foundation, never the reverse).
    for (const file of foundationFiles) {
      const content = read(file);
      expect(content, `${file} must not depend on the compiler plane`).not.toContain(
        "execution-compiler",
      );
    }
  });
});
