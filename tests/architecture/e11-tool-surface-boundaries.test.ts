/**
 * Architecture: the E1.1 tool-surface plane boundaries (WORK-051;
 * checkpoint contracts POLICY-BEFORE-DISPATCH, DEPENDENCY-DIRECTION,
 * IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE, SANDBOX-BOUNDARY,
 * CONCURRENCY-CRASH-SAFETY, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - T1 PLATFORM ISOLATION & DEPENDENCY DIRECTION: the tool-surface
 *    plane imports ONLY the WORK-049 execution-ir foundation, the
 *    WORK-050 execution-compiler variant surface (additive
 *    consumption, import-only), its own local modules and node
 *    builtins — no module, no integration, no api, no other platform
 *    plane (the plane is BUILT ON the foundation; it re-implements
 *    nothing and forks nothing).
 *  - T2 PROVIDER NEUTRALITY: the plane carries no vendor vocabulary
 *    (no SDKs, no vendor names in its contracts — the representation
 *    and error vocabularies are closed and neutral).
 *  - T3 THE MODULE BOUNDARY: the ONLY module-side surface
 *    referencing the tool-surface plane is the ONE declared sandbox
 *    seam adapter (`src/modules/sandbox/adapters/`
 *    `tool-surface-compute-seam.ts`) plus its barrel re-export; no
 *    other module file — domain, application, ports or adapters —
 *    may depend on the plane (no module depends on it for
 *    authority).
 *  - T4 NO SECOND STATE MACHINE / NO NEW DURABLE SURFACE: no
 *    execution-state vocabulary, no transition tables, no SQL, no
 *    new migration, no store implementation — the plane holds no
 *    durable surface at all; the sole durable surfaces remain the
 *    sandbox module's own (the seam adapter consults them through
 *    the PUBLIC service, never a second store).
 *  - T5 EVIDENCE-ONLY, NO AUTHORIZATION SURFACE: the plane exposes
 *    no admission/authorization vocabulary (no capability granting,
 *    no policy writing — derivation only READS constraint facts).
 *  - T6 SECRET-FREE SOURCES: no credential-shaped literals.
 *  - T7 PURITY & DETERMINISM: no ambient clock, no randomness, no
 *    module-level mutable state anywhere in the plane (the executor
 *    carries observed durations as evidence, never as decision
 *    inputs).
 *  - T8 THE CLOSED CATALOGS: the representation set is exactly the
 *    ADR-0019 §5 seven; the mechanical-operation vocabulary is
 *    exactly the four; the aggregate metrics exactly two; the
 *    invariant/precondition/audit vocabularies are closed; the
 *    plane's file set is exactly the seven declared modules; MCP
 *    appears as ONE representation among the closed set (never a
 *    required default).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  REPRESENTATION_PRECONDITION_CODES,
  SELECTION_ORDER,
  TOOL_REPRESENTATIONS,
  TOOL_SURFACE_INVARIANT_CODES,
} from "../../src/platform/tool-surface/catalog";
import {
  SURFACE_AUDIT_CODES,
  SURFACE_PROVENANCE_SOURCES,
} from "../../src/platform/tool-surface/derive";
import {
  AGGREGATE_METRICS,
  PROGRAMMATIC_OPERATIONS,
} from "../../src/platform/tool-surface/programmatic";
import { PROGRAMMATIC_SANDBOX_STATUSES } from "../../src/platform/tool-surface/seams";
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

const TOOL_SURFACE_FILES = listFiles("src/platform/tool-surface");

/** The vendor vocabulary the tool-surface plane must never carry. */
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

describe("E1.1 tool-surface plane architecture boundaries (WORK-051)", () => {
  test("T1 the plane depends ONLY on the execution-ir foundation, the compiler variant surface, local modules and node builtins", () => {
    expect(TOOL_SURFACE_FILES.length).toBeGreaterThanOrEqual(7);
    for (const file of TOOL_SURFACE_FILES) {
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
    // The compiler surface the plane consumes is the VARIANT only —
    // the engine modules (catalog/passes/pipeline/semantics/decisions)
    // are never imported by this plane (additive consumption, never
    // engine editing or engine coupling beyond the variant contract).
    for (const file of TOOL_SURFACE_FILES) {
      const content = read(file);
      expect(content, `${file} must not import the compiler engine modules`).not.toMatch(
        /from\s+"\.\.\/execution-compiler\/(catalog|passes|pipeline|semantics|decisions)"/,
      );
    }
    // The scanner proves the same over the whole tree: the plane has
    // no platform-isolation or undeclared-package violations.
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/tool-surface/"),
    );
    expect(files.length).toBe(TOOL_SURFACE_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(
      violations.filter(
        (violation) =>
          violation.rule === "platform-isolation" || violation.rule === "undeclared-package-import",
      ),
    ).toStrictEqual([]);
    // The foundation files are untouched by this plane (build ON,
    // never fork): no foundation file references the tool-surface
    // plane (dependency direction: tool-surface → foundation, never
    // the reverse).
    for (const file of listFiles("src/platform/execution-ir")) {
      const content = read(file);
      expect(content, `${file} must not depend on the tool-surface plane`).not.toContain(
        "tool-surface",
      );
    }
    for (const file of listFiles("src/platform/execution-compiler")) {
      const content = read(file);
      expect(content, `${file} must not depend on the tool-surface plane`).not.toContain(
        "tool-surface",
      );
    }
  });

  test("T2 provider neutrality: no vendor vocabulary in the plane", () => {
    for (const file of TOOL_SURFACE_FILES) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
    // The plane's own vocabularies are closed and vendor-free.
    const words = [...TOOL_REPRESENTATIONS, ...PROGRAMMATIC_OPERATIONS].join(" ").toLowerCase();
    for (const word of words.split(/[-_]/)) {
      expect(VENDOR_WORDS).not.toContain(word);
    }
  });

  test("T3 the module boundary: exactly ONE declared seam adapter references the plane (no authority dependence)", () => {
    const moduleFiles = collectSourceFiles(REPO_ROOT).filter(
      (file) => file.path.startsWith("src/modules/") || file.path.startsWith("src/integrations/"),
    );
    const referencing = moduleFiles.filter((file) => file.content.includes("tool-surface"));
    // The ONE declared adapter plus its barrel re-export line — nothing else.
    expect(referencing.map((file) => file.path)).toEqual([
      "src/modules/sandbox/adapters/index.ts",
      "src/modules/sandbox/adapters/tool-surface-compute-seam.ts",
    ]);
    // The adapter implements the platform seam port and nothing else
    // from the plane: it imports the programmatic helpers (the closed
    // crossing vocabulary), the seam contract and never the
    // derivation/selection machinery (decisions stay plane-owned,
    // the adapter only ships work into the existing authority).
    const adapter = read("src/modules/sandbox/adapters/tool-surface-compute-seam.ts");
    expect(adapter).toContain('from "../../../platform/tool-surface/seams"');
    expect(adapter).not.toMatch(
      /from\s+"\.\.\/\.\.\/\.\.\/platform\/tool-surface\/(derive|needs)"/,
    );
    // The sole SandboxComputeSeam implementation in the product tree
    // is the declared adapter (the port is implemented module-side,
    // never in the platform plane).
    const implementors = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.content.includes("SandboxComputeSeam"),
    );
    expect(
      implementors
        .filter((file) => file.path.startsWith("src/"))
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      "src/modules/sandbox/adapters/tool-surface-compute-seam.ts",
      "src/platform/tool-surface/executor.ts",
      "src/platform/tool-surface/programmatic.ts",
      "src/platform/tool-surface/seams.ts",
    ]);
    // No api surface may reference the plane (the crossing is
    // module-owned; the api boundary is untouched by this order).
    for (const file of collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/api/"),
    )) {
      expect(file.content, `${file.path} must not reference the tool-surface plane`).not.toContain(
        "tool-surface",
      );
    }
  });

  test("T4 no second state machine and no new durable surface", () => {
    for (const file of TOOL_SURFACE_FILES) {
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
    // No new migration: the platform migration set is unchanged (the
    // tool-surface plane adds NO durable state — the sandbox
    // authority's own surfaces carry every programmatic run).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(29);
    expect(migrations[migrations.length - 1]).toMatch(/^0030_execution_ir_decision_records/);
    // No store implementation exists in the plane (the sole seam
    // implementation is the module-side adapter over the sandbox
    // module's PUBLIC service).
    const storeShapes = collectSourceFiles(REPO_ROOT).filter(
      (file) =>
        file.path.startsWith("src/platform/tool-surface/") &&
        /implements\s+\w*Store/.test(file.content),
    );
    expect(storeShapes).toEqual([]);
  });

  test("T5 evidence-only: no admission/authorization vocabulary on the plane surface", () => {
    for (const file of TOOL_SURFACE_FILES) {
      const content = read(file);
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`async ${word}`);
      }
    }
    // The capability conditioning surface is READ-ONLY by name and
    // by signature (facts are consumed, never produced).
    const catalog = read("src/platform/tool-surface/catalog.ts");
    expect(catalog).toContain("capabilityFactsFromConstraints");
    expect(catalog).toContain("policyToolFactsFromConstraints");
    expect(catalog).toContain("toolAllowedByPolicyFacts");
    // No capability-granting surface exists anywhere in the plane.
    for (const file of TOOL_SURFACE_FILES) {
      expect(read(file), `${file} must not grant capabilities`).not.toMatch(
        /grant[A-Z]|GrantCapability|addCapability|registerCapability/,
      );
    }
  });

  test("T6 secret-free sources: no credential-shaped literals", () => {
    for (const file of TOOL_SURFACE_FILES) {
      const content = read(file);
      expect(content, `${file} must not carry access-key literals`).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content, `${file} must not carry secret assignments`).not.toMatch(
        /(secretAccessKey|apiToken|password|apiKey)\s*[:=]\s*"[^"${}]+"/,
      );
    }
  });

  test("T7 purity and determinism: no ambient clock, randomness or module-level mutable state", () => {
    for (const file of TOOL_SURFACE_FILES) {
      const content = read(file);
      expect(content, `${file} must not read ambient time`).not.toContain("Date.now");
      expect(content, `${file} must not construct dates`).not.toMatch(/new\s+Date\(/);
      expect(content, `${file} must not use randomness`).not.toContain("Math.random");
      // No module-level `let` (mutable module state breaks purity).
      const moduleLevelLet = [...content.matchAll(/^(let\s)/gm)].length;
      expect(moduleLevelLet, `${file} must not carry module-level let bindings`).toBe(0);
    }
  });

  test("T8 the closed catalogs: seven representations, four operations, two metrics, closed vocabularies, seven files", () => {
    expect([...TOOL_REPRESENTATIONS]).toEqual([
      "direct",
      "deferred",
      "cli",
      "script",
      "code",
      "mcp",
      "competence",
    ]);
    expect([...PROGRAMMATIC_OPERATIONS]).toEqual(["fan-out", "filter", "aggregate", "projection"]);
    expect([...AGGREGATE_METRICS]).toEqual(["count", "sum"]);
    expect([...REPRESENTATION_PRECONDITION_CODES]).toEqual([
      "binding-absent",
      "mcp-adapter-disabled",
      "lower-canonical-rank",
    ]);
    expect([...TOOL_SURFACE_INVARIANT_CODES]).toHaveLength(11);
    expect([...SURFACE_AUDIT_CODES]).toEqual([
      "surface-invalid",
      "derivation-mismatch",
      "surface-non-minimal",
      "provenance-mismatch",
    ]);
    expect([...SURFACE_PROVENANCE_SOURCES]).toEqual(["execution-ir.governed-plan"]);
    expect([...PROGRAMMATIC_SANDBOX_STATUSES]).toEqual([
      "completed",
      "failed",
      "denied",
      "non-convergent",
    ]);
    // The canonical selection order is a permutation of the closed set.
    expect(new Set(SELECTION_ORDER)).toEqual(new Set(TOOL_REPRESENTATIONS));
    expect(SELECTION_ORDER).toHaveLength(7);
    // The plane's file set is exactly the seven declared modules.
    expect(TOOL_SURFACE_FILES).toEqual([
      "src/platform/tool-surface/catalog.ts",
      "src/platform/tool-surface/derive.ts",
      "src/platform/tool-surface/executor.ts",
      "src/platform/tool-surface/needs.ts",
      "src/platform/tool-surface/programmatic.ts",
      "src/platform/tool-surface/results.ts",
      "src/platform/tool-surface/seams.ts",
    ]);
    // MCP is ONE representation among the closed set, NEVER a
    // required default: the configuration carries the enablement as
    // caller-provided DATA, and the adapter-disabled code exists in
    // the closed rejection vocabulary (the honest fall-through).
    const catalog = read("src/platform/tool-surface/catalog.ts");
    expect(catalog).not.toMatch(/mcpEnabled[?]?\s*:\s*true/);
    expect(REPRESENTATION_PRECONDITION_CODES).toContain("mcp-adapter-disabled");
  });
});
