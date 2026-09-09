/**
 * Architecture: the E1.1 Execution IR foundation boundaries (WORK-049;
 * checkpoint contracts ECONOMIC-AUTHORITY-BOUNDARY,
 * DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE,
 * VERIFICATION-SEPARATION, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/execution-ir/**` imports no
 *    module/integration/api surface (the IR foundation is pinned
 *    platform; its module dependencies are the declared SEAMS,
 *    injected — never imports).
 *  - B2 PROVIDER NEUTRALITY: the IR foundation carries no vendor
 *    vocabulary — no vendor SDKs, no vendor names in its contracts
 *    (representation classes, constraint kinds and transformation
 *    bases are closed neutral vocabularies).
 *  - B3 THE SEAM BOUNDARY: the ONLY module-side surface referencing
 *    the IR foundation is the declared three-file seam set (the
 *    WORK-048 evacuation-seam precedent); no other module file —
 *    domain, application, ports or adapters — may depend on the IR
 *    foundation (no module depends on it for authority).
 *  - B4 NO SECOND STATE MACHINE: the IR plane and its migration carry
 *    no execution-state vocabulary, no event vocabulary and no
 *    status/transition column — decision records are append-only
 *    evidence, and the E1.1 non-redundancy rule holds (no optimizer
 *    engine exists in the foundation — the compiler is WORK-050).
 *  - B5 EVIDENCE-ONLY STORE: the durable decision-record store exposes
 *    no admission/authorization vocabulary; the budget authority
 *    surface is untouched (read-only seam).
 *  - B6 SECRET-FREE SOURCES: no credential-shaped literals in the new
 *    surfaces.
 *  - B7 NO NEW PROVIDER SDK: the IR plane imports only node builtins
 *    and repository-relative modules.
 *  - B8 DURABLE AUTHORITY: the migration is the sole durable surface
 *    of the foundation, in the platform migration set (forward-only,
 *    never edited), and no other store implementation exists.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CONSTRAINT_KINDS } from "../../src/platform/execution-ir/constraints";
import { REPRESENTATION_CLASSES } from "../../src/platform/execution-ir/cost-model";
import { TRANSFORMATION_BASIS_CODES } from "../../src/platform/execution-ir/decision-record";
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

const IR_FILES = listFiles("src/platform/execution-ir");
const REPRESENTATIONS = { REPRESENTATION_CLASSES };
const KINDS = { CONSTRAINT_KINDS };
const BASES = { TRANSFORMATION_BASIS_CODES };

/** The vendor vocabulary the IR foundation must never carry. */
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

describe("E1.1 Execution IR foundation architecture boundaries (WORK-049)", () => {
  test("B1 platform isolation: the IR foundation imports no module/integration/api surface", () => {
    expect(IR_FILES.length).toBeGreaterThanOrEqual(7);
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/execution-ir/"),
    );
    expect(files.length).toBe(IR_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(violations.filter((violation) => violation.rule === "platform-isolation")).toStrictEqual(
      [],
    );
    // The IR foundation's import set is EXACTLY platform db + local
    // (the digest is injected; modules arrive through seams).
    for (const file of IR_FILES) {
      const content = read(file);
      const imports = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of imports) {
        const legal = specifier.startsWith("../db/") || specifier.startsWith("./");
        expect(legal, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  test("B2 provider neutrality: no vendor vocabulary in the IR foundation", async () => {
    for (const file of IR_FILES) {
      const content = read(file);
      for (const word of VENDOR_WORDS) {
        // Whole-word match (comments may legitimately use words like
        // "coherent"; vendor vocabulary as identifiers/strings may not).
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
    // The neutral vocabularies are closed and vendor-free (static import).
    const { REPRESENTATION_CLASSES } = REPRESENTATIONS;
    const { CONSTRAINT_KINDS } = KINDS;
    const { TRANSFORMATION_BASIS_CODES } = BASES;
    const all = [...REPRESENTATION_CLASSES, ...CONSTRAINT_KINDS, ...TRANSFORMATION_BASIS_CODES];
    for (const word of all.join(" ").toLowerCase().split(/[-_]/)) {
      expect(VENDOR_WORDS).not.toContain(word);
    }
  });

  test("B3 the seam boundary: exactly the declared three-file module-side seam set", () => {
    const DECLARED_SEAMS = [
      "src/modules/planning/adapters/ir-plan-source.ts",
      "src/modules/executions/adapters/ir-execution-binding.ts",
      "src/modules/budgets/adapters/ir-cost-constraints.ts",
    ];
    for (const seam of DECLARED_SEAMS) {
      const content = read(seam);
      expect(content, `${seam} must implement platform seam/IR types`).toContain(
        "platform/execution-ir/",
      );
    }
    // NO other module file may reference the IR foundation (no module
    // depends on it — for authority or anything else).
    for (const file of listFiles("src/modules")) {
      if (DECLARED_SEAMS.includes(file)) {
        continue;
      }
      const content = read(file);
      expect(content, `${file} must not reference the execution-ir plane`).not.toContain(
        "platform/execution-ir/",
      );
      expect(content, `${file} must not reference the execution-ir plane`).not.toContain(
        "execution-ir",
      );
    }
    // The seam adapters never touch the durable decision store (the
    // executions seam is read-only; the planning seam is a pure
    // converter; the budgets seam is read-only).
    for (const seam of DECLARED_SEAMS) {
      expect(read(seam)).not.toContain("decision-store");
      expect(read(seam)).not.toContain("OptimizationDecisionStore");
    }
  });

  test("B4 no second state machine: no execution-state/event vocabulary, no optimizer engine", () => {
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
    for (const file of IR_FILES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content, `${file} must not carry the execution state "${state}"`).not.toContain(
          `"${state}"`,
        );
      }
      // No transition-table vocabulary either.
      expect(content).not.toContain("transitionTable");
      expect(content).not.toContain("TRANSITION_TABLE");
    }
    // The migration adds append-only evidence: no status/lifecycle
    // COLUMN (comments explaining the absence are fine — the columns
    // are what a state machine would need).
    const migration = read("src/platform/db/migrations/0030_execution_ir_decision_records.sql");
    expect(migration).not.toMatch(/\bstatus\s+(text|integer|varchar|boolean)\b/i);
    expect(migration).not.toMatch(/\b(state|lifecycle)\s+(text|integer|varchar|boolean)\b/i);
    expect(migration).not.toMatch(/transition\s+to/i);
    expect(migration).toContain("append-only");
    expect(migration).toContain("execution_ir.optimization_decision_records");
    // The E1.1 non-redundancy rule: no optimizer/compiler engine exists
    // in the foundation (WORK-050 owns it) — no compile/optimize entry
    // points in the plane.
    for (const file of IR_FILES) {
      const content = read(file);
      expect(content, `${file} must not introduce a compiler engine`).not.toMatch(
        /export function (compile|optimize)[A-Za-z]*\(/,
      );
    }
  });

  test("B5 evidence-only store: no admission/authorization vocabulary on the durable evidence path", () => {
    const storeSource = read("src/platform/execution-ir/decision-store.ts");
    for (const word of ["authorize", "admission", "evaluate", "reserve", "settle", "release"]) {
      expect(storeSource, `the store must not expose "${word}"`).not.toContain(`readonly ${word}`);
    }
    // The store interface is exactly append + read.
    expect(storeSource).toContain("append(record: OptimizationDecisionRecord)");
    expect(storeSource).toContain("get(applicationId: string, decisionId: string)");
    expect(storeSource).toContain("listByPlan(");
    expect(storeSource).toContain("listByExecution(");
    // The budgets authority surface is untouched: the budgets seam is
    // read-only (SELECT only, no budget mutation).
    const budgetsSeam = read("src/modules/budgets/adapters/ir-cost-constraints.ts");
    expect(budgetsSeam).toContain("SELECT");
    expect(budgetsSeam).not.toMatch(/INSERT|UPDATE|DELETE/i);
    // The executions seam is read-only over the executions authority.
    const executionsSeam = read("src/modules/executions/adapters/ir-execution-binding.ts");
    expect(executionsSeam).toContain("SELECT");
    expect(executionsSeam).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  test("B6 secret-free sources: no credential-shaped literals in the new surfaces", () => {
    const surfaces = [
      ...IR_FILES,
      "src/platform/db/migrations/0030_execution_ir_decision_records.sql",
    ];
    for (const file of surfaces) {
      const content = read(file);
      expect(content, `${file} must not carry access-key literals`).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content, `${file} must not carry secret assignments`).not.toMatch(
        /(secretAccessKey|apiToken|password|apiKey)\s*[:=]\s*"[^"${}]+"/,
      );
    }
  });

  test("B7 no new provider SDK: the IR plane imports only node builtins and repository-relative modules", () => {
    for (const file of IR_FILES) {
      const content = read(file);
      const externalImports = [...content.matchAll(/from\s+"([^."][^"]*)"/g)].map(
        (m) => m[1] ?? "",
      );
      for (const specifier of externalImports) {
        expect(specifier.startsWith("node:")).toBe(true);
      }
    }
  });

  test("B8 durable authority: one migration, one store implementation, forward-only", () => {
    // The migration ships in the platform set with the next version.
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toContain("0030_execution_ir_decision_records.sql");
    // The ONLY durable implementation of the store port is the SQL
    // adapter (no second durable authority anywhere in src/).
    const implementors = collectSourceFiles(REPO_ROOT).filter(
      (file) =>
        file.content.includes("implements OptimizationDecisionStore") ||
        file.content.includes("implements OptimizationDecisionStore<"),
    );
    expect(implementors.map((file) => file.path)).toEqual([
      "src/platform/execution-ir/decision-store.ts",
    ]);
  });
});
