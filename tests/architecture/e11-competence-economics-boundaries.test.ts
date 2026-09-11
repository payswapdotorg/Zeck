/**
 * Architecture: the E1.1 competence-economics plane boundaries
 * (WORK-056; checkpoint contracts LEARNING-NONAUTHORITY,
 * PROMOTION-GATES, ROLLBACK-SAFETY, DEPENDENCY-DIRECTION,
 * IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE,
 * VERIFICATION-SEPARATION, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the plane imports
 *    ONLY the WORK-049/050 foundation (execution-ir), the declared
 *    dependency planes (tool-surface, context-economics,
 *    model-economics, failure-recovery — the merged WORK-051/052/
 *    053/055 planes, import/consume only), its own local modules
 *    and node builtins. No module, no integration, no api, no other
 *    platform plane (execution-compiler, substrate-economics,
 *    sandbox, recovery, db…).
 *  - C2 PROVIDER NEUTRALITY: the plane carries ZERO vendor
 *    vocabulary (capability references, bindings and authority
 *    identities are opaque neutral slugs — no vendor semantics
 *    cross the seams).
 *  - C3 THE MODULE BOUNDARY: NO module/integration/api file
 *    references the plane — nothing depends on it for authority.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE: no
 *    execution-state vocabulary, no SQL, no db import, no store
 *    implementation, no new migration — the sole durable surface
 *    remains the WORK-049 decision-record store (the migration
 *    count stays 29; competence decisions ride the EXISTING store
 *    at the caller's seam).
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes
 *    no admission/authorization vocabulary; competence records,
 *    promotion verdicts and rollbacks are evidence, never
 *    permission.
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURITY & DETERMINISM: no ambient clock, no randomness, no
 *    module-level mutable state in the plane (recordedAt/observedAt
 *    are explicit inputs everywhere).
 *  - C8 THE CLOSED VOCABULARIES AND THE DECLARED FILE SET: the
 *    promotion stages, equivalence-evidence kinds, rollback
 *    reasons, retrieval and promotion inadmissibility codes and
 *    invariant codes are closed; the plane's file set is exactly
 *    the nine declared modules.
 *  - C9 BUILD-ON, NEVER-FORK: the foundation and the dependency
 *    planes are never modified by this branch (git ancestry proof
 *    against the DYNAMIC merge-base of this branch and main — the
 *    drift-immune pin: the diff can only ever name THIS branch's
 *    own changes, so main advancing never self-trips the proof)
 *    and never reference the competence-economics plane (the
 *    reverse dependency direction never exists).
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  COMPETENCE_ECONOMICS_INVARIANT_CODES,
  EQUIVALENCE_EVIDENCE_KINDS,
  PROMOTION_STAGES,
  REPLACEMENT_BINDING_REPRESENTATIONS,
  ROLLBACK_REASON_CODES,
} from "../../src/platform/competence-economics/catalog";
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

const PLANE_FILES = listFiles("src/platform/competence-economics");

/** The vendor vocabulary the competence-economics plane must never carry. */
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

describe("E1.1 competence-economics architecture boundaries (WORK-056)", () => {
  test("C1 the plane depends ONLY on execution-ir, the declared dependency planes, local modules and node builtins", () => {
    expect(PLANE_FILES).toHaveLength(9);
    for (const file of PLANE_FILES) {
      const specifiers = extractImportSpecifiers(read(file));
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          const legal =
            specifier.startsWith("../execution-ir/") ||
            specifier.startsWith("../tool-surface/") ||
            specifier.startsWith("../context-economics/") ||
            specifier.startsWith("../model-economics/") ||
            specifier.startsWith("../failure-recovery/") ||
            specifier.startsWith("./");
          expect(
            legal,
            `${file} imports ${specifier} (the plane may import only ../execution-ir/*, ../tool-surface/*, ../context-economics/*, ../model-economics/*, ../failure-recovery/* and ./ — the declared foundation and dependency planes)`,
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
      expect(content, `${file} must not import the substrate-economics plane`).not.toContain(
        "../substrate-economics/",
      );
      expect(content, `${file} must not import the sandbox plane`).not.toContain("../sandbox/");
      expect(content, `${file} must not import the D-07 recovery plane`).not.toContain(
        "../recovery/",
      );
      expect(content, `${file} must not import the db plane`).not.toContain("../db/");
      expect(content, `${file} must not import the queue plane`).not.toContain("../queue/");
      expect(content, `${file} must not import the observability plane`).not.toContain(
        "../observability/",
      );
    }
    // The repository-wide dependency-rule scanner over the plane
    // (import-resolution is proven by the repository-wide
    // dependency-direction test over the FULL tree).
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/competence-economics/"),
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
    // The full-tree scan stays clean with the plane in place.
    const allFiles = collectSourceFiles(REPO_ROOT);
    const allViolations = scanDependencyRules(allFiles, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(allViolations).toStrictEqual([]);
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
      expect(content, `${file} must not reference the plane`).not.toContain("competence-economics");
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain(
        "platform/competence-economics",
      );
    }
    for (const file of listFiles("src/api")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("competence-economics");
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
      expect(content, `${file} must not import the pg driver`).not.toContain('"pg"');
    }
    // No new migration: the set stays 29 (0030 is still the last) —
    // competence decisions ride the EXISTING WORK-049 store.
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
    // The authority surfaces never consult the plane (the reverse
    // dependency direction never exists — the D6 discrimination
    // battery proves the behavioral side).
    for (const tree of [
      "src/modules/auth",
      "src/modules/policies",
      "src/modules/capabilities",
      "src/modules/budgets",
    ]) {
      for (const file of listFiles(tree)) {
        expect(read(file), `${file} must not reference the competence plane`).not.toContain(
          "competence-economics",
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
    const catalog = read("src/platform/competence-economics/catalog.ts");
    // The promotion stages are closed and ordered.
    expect(catalog).toContain("export const PROMOTION_STAGES");
    // The equivalence-evidence kinds are closed to exactly three.
    expect(catalog).toContain("export const EQUIVALENCE_EVIDENCE_KINDS");
    // The rollback reason vocabulary is closed.
    expect(catalog).toContain("export const ROLLBACK_REASON_CODES");
    // The retrieval inadmissibility codes are closed.
    expect(catalog).toContain("export const RETRIEVAL_INADMISSIBLE_CODES");
    // The promotion inadmissible codes are closed.
    expect(catalog).toContain("export const PROMOTION_INADMISSIBLE_CODES");
    // The invariant-code vocabulary is closed.
    expect(catalog).toContain("export const COMPETENCE_ECONOMICS_INVARIANT_CODES");
    // The closed vocabularies are EXACTLY the declared shapes.
    expect([...PROMOTION_STAGES]).toEqual(["candidate", "shadow", "canary", "deterministic"]);
    expect([...EQUIVALENCE_EVIDENCE_KINDS]).toEqual(["differential", "property", "replay"]);
    expect([...ROLLBACK_REASON_CODES]).toEqual([
      "equivalence-degraded",
      "quality-degraded",
      "economics-degraded",
      "policy-revoked",
    ]);
    expect([...REPLACEMENT_BINDING_REPRESENTATIONS]).toEqual(["competence", "code"]);
    expect([...COMPETENCE_ECONOMICS_INVARIANT_CODES]).toHaveLength(13);
    // The plane's file set is exactly the declared modules.
    expect(PLANE_FILES).toEqual([
      "src/platform/competence-economics/catalog.ts",
      "src/platform/competence-economics/decisions.ts",
      "src/platform/competence-economics/equivalence.ts",
      "src/platform/competence-economics/index.ts",
      "src/platform/competence-economics/mining.ts",
      "src/platform/competence-economics/promotion.ts",
      "src/platform/competence-economics/record.ts",
      "src/platform/competence-economics/retrieval.ts",
      "src/platform/competence-economics/rollback.ts",
    ]);
  });

  test("C9 build-on, never-fork: the foundation and the dependency planes are untouched and never reference this plane", () => {
    // The reverse dependency direction never exists: the foundation
    // and every dependency plane carry no reference to
    // competence-economics.
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
    const dependencyTrees = [
      "src/platform/tool-surface",
      "src/platform/context-economics",
      "src/platform/model-economics",
      "src/platform/failure-recovery",
    ];
    const dependencyFiles = dependencyTrees.flatMap((tree) => listFiles(tree));
    for (const file of [...foundationFiles, ...dependencyFiles]) {
      const content = read(file);
      expect(content, `${file} must not depend on the competence-economics plane`).not.toContain(
        "competence-economics",
      );
    }
    // Git ancestry proof (the DRIFT-IMMUNE dynamic merge-base pin):
    // diff the import-only surfaces against the merge-base of this
    // branch and main, computed AT RUNTIME. The diff can only ever
    // name THIS branch's own changes — main advancing past the
    // branch point (the Architect's finalization commits) never
    // self-trips the proof, and the branch merging into main makes
    // the merge-base the branch head itself (the diff stays empty).
    const ref = ["origin/main", "main"].find((candidate) => resolveGitRef(candidate));
    expect(ref, "a main ref must exist for the ancestry proof").toBeDefined();
    const mergeBase = execSync(`git merge-base HEAD ${ref}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const changed = execSync(
      `git diff --name-only ${mergeBase}..HEAD -- src/platform/execution-ir/ src/platform/tool-surface/ src/platform/context-economics/ src/platform/model-economics/ src/platform/substrate-economics/ src/platform/failure-recovery/ src/platform/execution-compiler/ spec/`,
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    expect(changed).toBe("");
    // And the WORK-056 merge window never touched anything outside this
    // plane's Declared Change Surfaces. Historical-window form
    // (2026-09-11, Architect — completing the 84b96af WORK-055
    // reconciliation pattern for this plane): the containment proof is
    // pinned to the FIXED historical range (dispatch base 201756c ..
    // merge commit 3318a8a, PR #31). The previous runtime form
    // (`git diff mergeBase..HEAD` asserted non-empty and inside this
    // plane's surfaces) was satisfiable ONLY while HEAD was the WORK-056
    // work branch: it failed every CI run on main itself (zero
    // branch-local changes) and would fail every future work branch
    // whose legitimate changes live outside this plane. The pinned
    // window is the durable invariant — the 056 implementation touched
    // only its declared surfaces — provable at any future revision
    // (CI checks out with fetch-depth: 0, so the range is always
    // reachable).
    const WORK_056_BASE = "201756c";
    const WORK_056_MERGE = "3318a8a";
    const windowChanges = execSync(`git diff --name-only ${WORK_056_BASE}..${WORK_056_MERGE}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(windowChanges.length).toBeGreaterThan(0);
    for (const path of windowChanges) {
      expect(
        /^(src\/platform\/competence-economics\/|tests\/|docs\/work-items\/WORK-056)/.test(path),
        `${path} is outside the Declared Change Surfaces`,
      ).toBe(true);
    }
  });
});

/** Resolve a git ref without throwing (returns true when it exists). */
function resolveGitRef(ref: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet ${ref}`, { cwd: REPO_ROOT, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}
