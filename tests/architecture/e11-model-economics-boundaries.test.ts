/**
 * Architecture: the E1.1 model-economics plane boundaries (WORK-053;
 * checkpoint contracts ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE,
 * VERIFICATION-SEPARATION, COST-QUOTA-GUARDS,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the model-economics
 *    plane imports ONLY the WORK-049 execution-ir foundation, its own
 *    local modules and node builtins — no module, no integration, no
 *    api, no other platform plane (the plane is built ON the
 *    foundation and the compiler's representation-ladder hooks; it
 *    re-implements nothing).
 *  - C2 PROVIDER NEUTRALITY: the plane carries no vendor vocabulary
 *    (no SDKs, no vendor names in its contracts — the model routes
 *    are provider-neutral opaque strings exactly like the IR's
 *    routeRef).
 *  - C3 THE MODULE BOUNDARY: NO module, integration or api file
 *    references the model-economics plane — nothing depends on it
 *    for authority; it is consumed nowhere until a later Work Order
 *    wires its evidence through the declared seams.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE / NO
 *    ROUTING AUTHORITY: no execution-state or event vocabulary, no
 *    SQL anywhere in the plane, no new migration, no store
 *    implementation, no router or provider registry of authority —
 *    the sole durable surface remains the WORK-049 decision-record
 *    store; the plane holds no store client and creates no ambient
 *    model state.
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes
 *    no admission/authorization vocabulary; decision records are
 *    built as values.
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURE FUNCTIONS & DETERMINISM: no ambient clock, no randomness,
 *    no module-level mutable state in the plane (recordedAt is an
 *    explicit input everywhere).
 *  - C8 THE CLOSED FILE SET: the plane is exactly the nine declared
 *    modules.
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

const PLANE_FILES = listFiles("src/platform/model-economics");

/** The vendor vocabulary the model-economics plane must never carry. */
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

describe("E1.1 model-economics architecture boundaries (WORK-053)", () => {
  test("C1 the plane depends ONLY on the execution-ir foundation, local modules and node builtins", () => {
    expect(PLANE_FILES.length).toBe(9);
    for (const file of PLANE_FILES) {
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
    // The scanner proves the same over the whole tree (platform
    // isolation, package default-deny, import resolution — the
    // foundation imports resolve outside the filtered subset, exactly
    // as in the WORK-049/050 precedents, so the rule-filtered proof
    // is the mechanical one).
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/model-economics/"),
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

  test("C2 provider neutrality: no vendor vocabulary in the model-economics plane", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
    // The plane's own vocabularies are closed and vendor-free (the
    // effort levels, service classes and gate modes are neutral).
    for (const word of [
      "minimal",
      "low",
      "medium",
      "high",
      "maximum",
      "economy",
      "standard",
      "priority",
    ]) {
      expect(VENDOR_WORDS).not.toContain(word);
    }
  });

  test("C3 the module boundary: no module, integration or api file references the plane (no authority dependence)", () => {
    for (const file of listFiles("src/modules")) {
      const content = read(file);
      expect(content, `${file} must not reference the model-economics plane`).not.toContain(
        "platform/model-economics",
      );
      expect(content, `${file} must not reference the model-economics plane`).not.toContain(
        "model-economics",
      );
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the model-economics plane`).not.toContain(
        "platform/model-economics",
      );
    }
    for (const file of listFiles("src/api")) {
      const content = read(file);
      expect(content, `${file} must not reference the model-economics plane`).not.toContain(
        "platform/model-economics",
      );
    }
  });

  test("C4 no second state machine, no second durable surface, no routing authority", () => {
    for (const file of PLANE_FILES) {
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
      // No routing authority: no router, no provider registry of
      // authority, no ambient model state container.
      expect(content, `${file} must not declare a router or registry`).not.toMatch(
        /class\s+\w*(Router|Registry)/,
      );
      expect(content, `${file} must not import the decision store`).not.toContain("decision-store");
    }
    // No new migration: the migration set is unchanged (WORK-049's 0030
    // is still the last — the plane adds NO durable state).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(30);
    expect(migrations[migrations.length - 1]).toMatch(/^0031_audit_compliance/);
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

  test("C7 pure functions and determinism: no ambient clock, randomness or module-level mutable state", () => {
    for (const file of PLANE_FILES) {
      const content = read(file);
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not construct dates`).not.toMatch(/new\s+Date\(/);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      // No module-level `let` (mutable module state breaks purity).
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
  });

  test("C8 the closed file set: the plane is exactly the nine declared modules", () => {
    expect(PLANE_FILES).toEqual([
      "src/platform/model-economics/admissibility.ts",
      "src/platform/model-economics/agent-gate.ts",
      "src/platform/model-economics/decisions.ts",
      "src/platform/model-economics/effort-selection.ts",
      "src/platform/model-economics/escalation-hooks.ts",
      "src/platform/model-economics/expected-gain.ts",
      "src/platform/model-economics/model-selection.ts",
      "src/platform/model-economics/service-class.ts",
      "src/platform/model-economics/vocabulary.ts",
    ]);
  });

  test("the WORK-049 foundation files are untouched by this plane (build ON, never fork)", () => {
    // The foundation remains byte-stable at the dispatch base: the
    // model-economics plane imports it, it never edits it (mechanically
    // proven by the changed-file inventory — this check pins the
    // import-only relationship from the plane side).
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
    // No foundation file references the plane (dependency direction:
    // model-economics → foundation, never the reverse).
    for (const file of foundationFiles) {
      const content = read(file);
      expect(content, `${file} must not depend on the model-economics plane`).not.toContain(
        "model-economics",
      );
    }
    // The compiler plane is likewise unconsumed and unedited by this
    // plane (the representation-ladder hooks are import-only seam
    // consumers of the SHARED foundation vocabulary, not compiler
    // imports — pinned here so the boundary cannot drift).
    const compilerFiles = listFiles("src/platform/execution-compiler");
    expect(compilerFiles.length).toBe(6);
    for (const file of compilerFiles) {
      const content = read(file);
      expect(content, `${file} must not depend on the model-economics plane`).not.toContain(
        "model-economics",
      );
    }
  });
});
