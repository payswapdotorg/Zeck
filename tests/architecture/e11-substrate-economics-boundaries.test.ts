/**
 * Architecture: the E1.1 substrate-economics plane boundaries (WORK-054;
 * checkpoint contracts EXTERNAL-SIDE-EFFECTS, ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE,
 * VERIFICATION-SEPARATION, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - C1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the plane's
 *    non-adapter modules import ONLY the WORK-049 execution-ir
 *    foundation, their own local modules and node builtins; the
 *    adapters additionally import ONLY the declared sandbox seam
 *    (container-profile, runtime-client) and the plane's local
 *    contract modules. No execution-compiler import, no sibling-plane
 *    import (context-economics / tool-surface / model-economics), no
 *    module, no integration, no api. The DOMAIN modules never import
 *    the adapter directory — adapters are leaf mechanisms the
 *    composition root binds, never a dependency of plane logic.
 *  - C2 PROVIDER NEUTRALITY & VOCABULARY CONFINEMENT: the non-adapter
 *    plane files, the shared adapter seam contract (`adapters/port.ts`)
 *    and the self-hosted adapter carry ZERO vendor vocabulary; each
 *    provider adapter file carries ONLY its own vendor's vocabulary
 *    (never another provider's) — provider specifics live behind
 *    adapter seams, mechanically.
 *  - C3 THE MODULE BOUNDARY: NO module/integration/api file references
 *    the plane — nothing depends on it for authority.
 *  - C4 NO SECOND STATE MACHINE / NO SECOND DURABLE SURFACE: no
 *    execution-state vocabulary, no SQL, no db import, no store
 *    implementation, no new migration — the sole durable surface
 *    remains the WORK-049 decision-record store (the migration count
 *    stays 29; substrate accounting rides the EXISTING store at the
 *    caller's seam).
 *  - C5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes no
 *    admission/authorization vocabulary; substrate selection is
 *    evidence, never permission (adapters are mechanisms, never
 *    authorities).
 *  - C6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - C7 PURITY & DETERMINISM: the non-adapter modules have no ambient
 *    clock, no randomness, no module-level mutable state (pure
 *    decision functions; the adapters' injected-clock seam defaults
 *    are constructor configuration, not decision input).
 *  - C8 THE CLOSED VOCABULARIES AND THE DECLARED FILE SET: the
 *    availability modes, readiness states, insufficiency codes,
 *    selection outcomes and invariant codes are closed; the plane's
 *    file set is exactly the twelve declared modules.
 *  - C9 BUILD-ON, NEVER-FORK: the WORK-049 foundation and the
 *    declared sandbox seam are never referenced by this plane's name
 *    (the dependency direction is substrate-economics → foundation /
 *    sandbox, never the reverse).
 */
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

const PLANE_FILES = listFiles("src/platform/substrate-economics");
const DOMAIN_FILES = PLANE_FILES.filter(
  (file) => !file.startsWith("src/platform/substrate-economics/adapters/"),
);
const ADAPTER_FILES = PLANE_FILES.filter((file) =>
  file.startsWith("src/platform/substrate-economics/adapters/"),
);

/** The vendor vocabulary confined to the owning provider adapter files. */
const VENDOR_WORDS = [
  "e2b",
  "daytona",
  "modal",
  "firecracker",
  "openrouter",
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

describe("E1.1 substrate-economics architecture boundaries (WORK-054)", () => {
  test("C1 the plane depends ONLY on execution-ir, the declared sandbox seam, local modules and node builtins", () => {
    expect(DOMAIN_FILES.length).toBe(6);
    expect(ADAPTER_FILES.length).toBe(6);
    for (const file of DOMAIN_FILES) {
      const specifiers = extractImportSpecifiers(read(file));
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          expect(
            specifier.startsWith("../execution-ir/") || specifier.startsWith("./"),
            `${file} imports ${specifier} (domain modules may import only ../execution-ir/* and ./)`,
          ).toBe(true);
        } else {
          expect(specifier.startsWith("node:"), `${file} imports external ${specifier}`).toBe(true);
        }
      }
    }
    for (const file of ADAPTER_FILES) {
      for (const specifier of extractImportSpecifiers(read(file))) {
        if (specifier.startsWith(".")) {
          const legal =
            specifier.startsWith("./") ||
            (specifier.startsWith("../") && !specifier.startsWith("../../")) ||
            specifier.startsWith("../../execution-ir/") ||
            specifier.startsWith("../../sandbox/");
          expect(
            legal,
            `${file} imports ${specifier} (adapters may import only plane-local modules, the execution-ir foundation and the declared sandbox seam)`,
          ).toBe(true);
        } else {
          expect(specifier.startsWith("node:"), `${file} imports external ${specifier}`).toBe(true);
        }
      }
      // No adapter ever imports a provider SDK: the transports are
      // typed ports the composition root binds (live SDKs land inside
      // the adapter directory per the boundary table, never imported
      // by the seam contracts themselves).
      expect(read(file)).not.toMatch(/from\s+"(@?e2b|@daytonaio|modal)/);
    }
    // No sibling-plane or compiler import anywhere in the plane.
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
      expect(content, `${file} must not import the model-economics plane`).not.toContain(
        "../model-economics/",
      );
    }
    // The DOMAIN modules never import the adapter directory: adapters
    // are leaf mechanisms, never a dependency of plane logic.
    for (const file of DOMAIN_FILES) {
      if (file === "src/platform/substrate-economics/index.ts") {
        // The plane barrel re-exports the adapter factories for the
        // composition root — a re-export, never an import dependency
        // of any domain module.
        continue;
      }
      expect(read(file), `${file} must not depend on the adapters`).not.toContain("./adapters");
    }
    // The repository-wide dependency-rule scanner over the plane.
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/substrate-economics/"),
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

  test("C2 provider neutrality: vendor vocabulary is CONFINED to the owning provider adapter files", () => {
    // The non-adapter plane files, the shared seam contract and the
    // self-hosted adapter carry ZERO vendor vocabulary.
    const vendorFree = [
      ...DOMAIN_FILES,
      "src/platform/substrate-economics/adapters/port.ts",
      "src/platform/substrate-economics/adapters/self-hosted.ts",
    ];
    for (const file of vendorFree) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
    // Each provider adapter file carries ONLY its own vendor's
    // vocabulary — never another provider's.
    const ownVocabulary: Readonly<Record<string, string>> = {
      "src/platform/substrate-economics/adapters/e2b.ts": "e2b",
      "src/platform/substrate-economics/adapters/daytona.ts": "daytona",
      "src/platform/substrate-economics/adapters/modal.ts": "modal",
    };
    for (const [file, own] of Object.entries(ownVocabulary)) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        if (word === own) {
          continue;
        }
        expect(content, `${file} must not carry the foreign vendor "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
  });

  test("C3 the module boundary: no module/integration/api references the plane", () => {
    for (const file of listFiles("src/modules")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("substrate-economics");
    }
    for (const file of listFiles("src/integrations")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain(
        "platform/substrate-economics",
      );
    }
    for (const file of listFiles("src/api")) {
      const content = read(file);
      expect(content, `${file} must not reference the plane`).not.toContain("substrate-economics");
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
    // substrate accounting rides the EXISTING WORK-049 store.
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

  test("C7 purity and determinism: no ambient clock, randomness or module-level mutable state in the decision modules", () => {
    for (const file of DOMAIN_FILES) {
      const content = read(file);
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not construct dates`).not.toMatch(/new\s+Date\(/);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
    // The adapters may default their INJECTED clock seam at
    // construction (configuration, never decision input) but never
    // carry randomness or module-level mutable state.
    for (const file of ADAPTER_FILES) {
      const content = read(file);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
  });

  test("C8 the closed vocabularies and the declared file set", () => {
    const catalog = read("src/platform/substrate-economics/catalog.ts");
    // The invariant-code vocabulary is closed and listed.
    expect(catalog).toContain("export const SUBSTRATE_ECONOMICS_INVARIANT_CODES");
    // The availability-mode vocabulary (cold/warm/snapshot) is closed.
    expect(catalog).toContain("export const SUBSTRATE_AVAILABILITY_MODES");
    // The neutral readiness ladder is closed.
    expect(catalog).toContain("export const SUBSTRATE_READINESS_STATES");
    // The insufficiency reason codes are closed.
    expect(catalog).toContain("export const SUBSTRATE_INSUFFICIENCY_CODES");
    // The selection outcome vocabulary is closed.
    expect(catalog).toContain("export const SUBSTRATE_SELECTION_OUTCOMES");
    // The plane's file set is exactly the declared modules.
    expect(PLANE_FILES).toEqual([
      "src/platform/substrate-economics/accounting.ts",
      "src/platform/substrate-economics/adapters/daytona.ts",
      "src/platform/substrate-economics/adapters/e2b.ts",
      "src/platform/substrate-economics/adapters/index.ts",
      "src/platform/substrate-economics/adapters/modal.ts",
      "src/platform/substrate-economics/adapters/port.ts",
      "src/platform/substrate-economics/adapters/self-hosted.ts",
      "src/platform/substrate-economics/catalog.ts",
      "src/platform/substrate-economics/facts.ts",
      "src/platform/substrate-economics/index.ts",
      "src/platform/substrate-economics/lifecycle.ts",
      "src/platform/substrate-economics/selection.ts",
    ]);
  });

  test("C9 build-on, never-fork: the foundation and the declared sandbox seam never reference the plane", () => {
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
    const sandboxFiles = listFiles("src/platform/sandbox");
    expect(sandboxFiles).toEqual([
      "src/platform/sandbox/container-profile.ts",
      "src/platform/sandbox/index.ts",
      "src/platform/sandbox/process-runtime.ts",
      "src/platform/sandbox/runtime-client.ts",
    ]);
    for (const file of [...foundationFiles, ...sandboxFiles]) {
      const content = read(file);
      expect(content, `${file} must not depend on the substrate-economics plane`).not.toContain(
        "substrate-economics",
      );
    }
  });
});
