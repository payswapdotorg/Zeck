/**
 * Architecture: the E1.1 failure-recovery plane boundaries (WORK-055;
 * checkpoint contracts EXTERNAL-SIDE-EFFECTS, ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE, VERIFICATION-SEPARATION,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the plane imports
 *    ONLY the WORK-049/050 foundation (execution-ir), the declared
 *    dependency planes (model-economics, substrate-economics — the
 *    merged WORK-053/054 planes, import/consume only), its own local
 *    modules and node builtins. No module, no integration, no api, no
 *    other platform plane (tool-surface, context-economics,
 *    execution-compiler, sandbox, recovery…).
 *  - C2 PROVIDER NEUTRALITY: the plane carries ZERO vendor vocabulary
 *    (component references, routes and substrates are opaque neutral
 *    slugs — no vendor semantics cross the seams).
 *  - C3 THE MODULE BOUNDARY: NO module/integration/api file references
 *    the plane — nothing depends on it for authority.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE: no
 *    execution-state vocabulary, no SQL, no db import, no store
 *    implementation, no new migration — the sole durable surface
 *    remains the WORK-049 decision-record store (the migration count
 *    stays 29; recovery decisions ride the EXISTING store at the
 *    caller's seam).
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes no
 *    admission/authorization vocabulary; recovery decisions are
 *    evidence, never permission.
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURITY & DETERMINISM: no ambient clock, no randomness, no
 *    module-level mutable state in the plane (recordedAt/observedAt
 *    are explicit inputs everywhere).
 *  - C8 THE CLOSED VOCABULARIES AND THE DECLARED FILE SET: the
 *    failure classes, signals, recovery strategies, inadmissibility
 *    and fail-closed codes are closed; the plane's file set is
 *    exactly the eight declared modules.
 *  - C9 BUILD-ON, NEVER-FORK: the foundation and the dependency
 *    planes are never modified by this branch (git ancestry proof)
 *    and never reference the failure-recovery plane (the reverse
 *    dependency direction never exists).
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import { extractImportSpecifiers, scanDependencyRules } from "./lib/dependency-rules";

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

const PLANE_FILES = listFiles("src/platform/failure-recovery");

/** The vendor vocabulary the failure-recovery plane must never carry. */
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
  "aws-sdk",
  "sigv4",
  "docker",
  "dockerode",
  "koyeb",
  "fluidstack",
  "hyperbolic",
  "runpod",
  "lambda-labs",
  "firecracker",
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

describe("E1.1 failure-recovery architecture boundaries (WORK-055)", () => {
  test("C1 the plane depends ONLY on execution-ir, the declared dependency planes, local modules and node builtins", () => {
    expect(PLANE_FILES).toHaveLength(8);
    for (const file of PLANE_FILES) {
      const specifiers = extractImportSpecifiers(read(file));
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          const legal =
            specifier.startsWith("../execution-ir/") ||
            specifier.startsWith("../model-economics/") ||
            specifier.startsWith("../substrate-economics/") ||
            specifier.startsWith("./");
          expect(
            legal,
            `${file} imports ${specifier} (the plane may import only ../execution-ir/*, ../model-economics/*, ../substrate-economics/* and ./ — the declared foundation and dependency planes)`,
          ).toBe(true);
        } else {
          expect(specifier.startsWith("node:"), `${file} imports external ${specifier}`).toBe(true);
        }
      }
    }
    // No undeclared platform plane is imported anywhere in the plane.
    for (const file of PLANE_FILES) {
      const content = read(file);
      expect(content, `${file} must not import the compiler plane`).not.toContain(
        "../execution-compiler/",
      );
      expect(content, `${file} must not import the context-economics plane`).not.toContain(
        "../context-economics/",
      );
      expect(content, `${file} must not import the tool-surface plane`).not.toContain(
        "../tool-surface/",
      );
      expect(content, `${file} must not import the sandbox plane`).not.toContain("../sandbox/");
      expect(content, `${file} must not import the D-07 recovery plane`).not.toContain(
        "../recovery/",
      );
      expect(content, `${file} must not import the db plane`).not.toContain("../db/");
    }
    // The repository-wide dependency-rule scanner over the plane.
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/failure-recovery/"),
    );
    expect(files.length).toBe(PLANE_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(
      violations.filter(
        (violation) =>
          violation.rule === "platform-isolation" ||
          violation.rule === "undeclared-package-import" ||
          violation.rule === "provider-sdk-outside-adapter",
      ),
    ).toStrictEqual([]);
  });

  test("C2 provider neutrality: vendor vocabulary never crosses the plane's seams", () => {
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
      expect(content, `${file} must not reference the plane`).not.toContain("failure-recovery");
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain(
        "platform/failure-recovery",
      );
    }
    for (const file of listFiles("src/api")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("failure-recovery");
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
      expect(content, `${file} must not import the db port`).not.toContain("DatabasePort");
    }
    // No new migration: the set stays 29 (0030 is still the last) —
    // recovery decisions ride the EXISTING WORK-049 store.
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(30); // +0031_isolation_profiles (WORK-058 / D-08)
    expect(migrations[migrations.length - 1]).toMatch(/^0031_isolation_profiles/); // WORK-058 / D-08
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
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
      expect(content, `${file} must not mutate module state`).not.toMatch(
        /^\s*(const|let)\s+\w+\s*=\s*\[\s*\]\s*;?\s*$/gm,
      );
    }
  });

  test("C8 the closed vocabularies and the declared file set", () => {
    const catalog = read("src/platform/failure-recovery/catalog.ts");
    // The five-class failure taxonomy is closed and listed.
    expect(catalog).toContain("export const FAILURE_CLASSES");
    // The observation-signal vocabulary is closed.
    expect(catalog).toContain("export const FAILURE_SIGNALS");
    // The signal → admissible-classes table is closed.
    expect(catalog).toContain("export const SIGNAL_CLASS_ADMISSIBILITY");
    // The recovery-strategy vocabulary is closed.
    expect(catalog).toContain("export const RECOVERY_STRATEGIES");
    // The inadmissibility reason codes are closed.
    expect(catalog).toContain("export const RECOVERY_INADMISSIBLE_CODES");
    // The fail-closed reason codes are closed.
    expect(catalog).toContain("export const RECOVERY_FAIL_CLOSED_CODES");
    // The invariant-code vocabulary is closed.
    expect(catalog).toContain("export const FAILURE_RECOVERY_INVARIANT_CODES");
    // The plane's file set is exactly the declared modules.
    expect(PLANE_FILES).toEqual([
      "src/platform/failure-recovery/attribution.ts",
      "src/platform/failure-recovery/catalog.ts",
      "src/platform/failure-recovery/continuation.ts",
      "src/platform/failure-recovery/decisions.ts",
      "src/platform/failure-recovery/escalation.ts",
      "src/platform/failure-recovery/fingerprint.ts",
      "src/platform/failure-recovery/index.ts",
      "src/platform/failure-recovery/strategy.ts",
    ]);
  });

  test("C9 build-on, never-fork: the foundation and the dependency planes are untouched and never reference this plane", () => {
    // The reverse dependency direction never exists: the foundation
    // and both dependency planes carry no reference to failure-recovery.
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
    const modelEconomicsFiles = listFiles("src/platform/model-economics");
    expect(modelEconomicsFiles).toHaveLength(9);
    const substrateFiles = listFiles("src/platform/substrate-economics");
    expect(substrateFiles).toHaveLength(12);
    for (const file of [...foundationFiles, ...modelEconomicsFiles, ...substrateFiles]) {
      const content = read(file);
      expect(content, `${file} must not depend on the failure-recovery plane`).not.toContain(
        "failure-recovery",
      );
    }
    // Git ancestry proof (the DRIFT-IMMUNE dynamic merge-base pin,
    // reconciled by the Architect after WORK-055's merge): diff the
    // import-only surfaces against the merge-base of this checkout and
    // main, computed AT RUNTIME. The original proof pinned the dispatch
    // base (9b6fa2f) statically, which self-tripped whenever main
    // advanced past the branch point (the Architect's finalization
    // commits touch spec/). The dynamic merge-base can only ever name
    // THIS checkout's own changes; main advancing past the branch point
    // never trips the proof, and the branch merging into main makes the
    // merge-base the head itself (the diff stays empty).
    const mainRef = ["origin/main", "main"].find((candidate) => {
      try {
        execSync(`git rev-parse --verify --quiet ${candidate}`, {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(mainRef, "a main ref must exist for the ancestry proof").toBeDefined();
    const mergeBase = execSync(`git merge-base HEAD ${mainRef}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const changed = execSync(
      `git diff --name-only ${mergeBase}..HEAD -- src/platform/execution-ir/ src/platform/model-economics/ src/platform/substrate-economics/ src/platform/tool-surface/ src/platform/context-economics/ src/platform/execution-compiler/ spec/`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    expect(changed).toBe("");
  });
});
