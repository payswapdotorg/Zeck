/**
 * Architecture: the planner quality-contract gating + substitute
 * disclosure boundaries (planning module; ACR-009 §3–§5; work order
 * PCS-003 — the wiring).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 NO SECOND PLANNER: the planning domain gains EXACTLY ONE new
 *    file (semantic-quality-gating.ts); the planner application keeps
 *    its single service constructor and composes the gating through the
 *    existing domain seam (a pure pass over filterAdmissibility's
 *    output — never a second selection path, comparator or engine).
 *  - B2 NO AMBIENT CONFIGURATION: the gating module reads no
 *    environment, no clock, no randomness (the C7/C11 pattern); the
 *    gating input is the task's DECLARED contract + the resolution's
 *    declared facts — nothing else.
 *  - B3 NO NEW DURABLE SURFACE: no SQL, no store, no state machine in
 *    the new module; the platform migration census is unchanged (33);
 *    the substitution capture rides the EXISTING planning-decision
 *    event on the executions ledger (the WORK-049 seam, single write
 *    path, no new event type).
 *  - B4 THE VOCABULARY CONFINEMENT (the PCS-003 evolution of the
 *    PCS-002 A5 boundary): the semantic-fidelity vocabulary in runtime
 *    code is confined to the capabilities module (the fact plane) and
 *    the planning module (the gating + disclosure wiring this work
 *    order owns); every other runtime surface — the evaluation planes
 *    (benchmarks, experiments — PCS-004's), the product surfaces
 *    (apps, sdk, cli, deploy), src/api, src/platform and every other
 *    module — stays clean.
 *  - B5 THE DRIFT-IMMUNE OWNERSHIP PIN (the e11 C9 pattern): the
 *    dynamic merge-base diff of this checkout against main touches
 *    NOTHING outside the planning module, the capabilities module and
 *    the tests. The empty-diff state (a fresh main checkout, or this
 *    branch merged into main) PASSES — the pin can only ever name THIS
 *    checkout's own changes (the e11 reconciliation discipline).
 *  - B6 THE SEAM + VOCABULARY PINS: the new domain module consults the
 *    capabilities module TYPE-ONLY (the planner-surface discipline);
 *    the planning-side quality-requirement vocabulary mirror is pinned
 *    byte-equal against the capabilities authority.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SEMANTIC_QUALITY_REQUIREMENTS } from "../../src/modules/capabilities/public";
import { SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY } from "../../src/modules/planning/public";

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

const GATING_MODULE = read("src/modules/planning/domain/semantic-quality-gating.ts");
const PLANNER_SOURCE = read("src/modules/planning/application/planner.ts");

describe("architecture: planner quality-contract gating + substitute disclosure (PCS-003)", () => {
  test("B1 no second planner: one declared new domain file, one service constructor, composition through the existing seam", () => {
    // The planning domain is the pre-change set plus EXACTLY the one
    // declared artifact (semantic-quality-gating.ts) — the module's own
    // convention (the PCS-002 A6 precedent).
    expect(listFiles("src/modules/planning/domain")).toEqual([
      "src/modules/planning/domain/canonical.ts",
      "src/modules/planning/domain/composition-consultation.ts",
      "src/modules/planning/domain/decision.ts",
      "src/modules/planning/domain/deterministicization-consultation.ts",
      "src/modules/planning/domain/index.ts",
      "src/modules/planning/domain/learned-policy-consultation.ts",
      "src/modules/planning/domain/learning-consultation.ts",
      "src/modules/planning/domain/opportunity-consultation.ts",
      "src/modules/planning/domain/plan.ts",
      "src/modules/planning/domain/semantic-quality-gating.ts",
      "src/modules/planning/domain/strategy.ts",
      "src/modules/planning/domain/subgraph-evidence.ts",
      "src/modules/planning/domain/substrate-selection.ts",
      "src/modules/planning/domain/sufficiency.ts",
      "src/modules/planning/domain/task-profile.ts",
      "src/modules/planning/domain/workload-class.ts",
    ]);
    // One planner service, unchanged: the application layer defines it
    // exactly once and the gating introduces no second constructor.
    expect(PLANNER_SOURCE.match(/export function create\w+Service/g)).toEqual([
      "export function createPlannerService",
    ]);
    // The gating composes through the EXISTING domain seam (the planner
    // imports the pure pass and maps it over filterAdmissibility's
    // output) — never a second selection path of its own.
    expect(PLANNER_SOURCE).toContain("applySemanticQualityGating");
    expect(PLANNER_SOURCE).toContain("filterAdmissibility");
    expect(PLANNER_SOURCE.match(/const gatedCandidates = admissibleCandidates\.map/g)).toHaveLength(
      1,
    );
    // The gating module holds NO selection engine of its own: no
    // candidate sorting, no comparator, no strategy selection — it is a
    // typed admissibility dimension over the existing machinery.
    expect(GATING_MODULE).not.toMatch(/\.sort\(/);
    expect(GATING_MODULE).not.toContain("selectStrategy");
    expect(GATING_MODULE).not.toContain("compareCheapFirst");
  });

  test("B2 no ambient configuration: the gating reads no environment, no clock, no randomness", () => {
    for (const module of [GATING_MODULE, PLANNER_SOURCE]) {
      expect(module).not.toContain("process.env");
      expect(module).not.toContain("Date.now");
      expect(module).not.toMatch(/new\s+Date\(/);
      expect(module).not.toContain("Math.random");
      expect(module).not.toMatch(/\bfetch\s*\(/);
    }
    // The gating input is the declared contract + the resolution facts
    // — no configuration identifier, environment read or ambient state
    // appears anywhere in the module (the C7/C11 scans above are the
    // mechanical pin; the input discipline is the typed signature).
  });

  test("B3 no new durable surface: no SQL/store in the new module; the migration census is unchanged; the capture rides the existing ledger event", async () => {
    expect(GATING_MODULE).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
    );
    expect(GATING_MODULE).not.toMatch(/\bfrom\s+["'](\.\.\/)+(adapters|ports)\/index["']/);
    // The platform migration census at the PCS-003 base is 33 SQL
    // files — the wiring added none (no durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(33);
    expect(migrations.at(-1)).toBe("0034_sandbox_governance.sql");
    // The substitution capture rides the EXISTING planning-decision
    // event through the executions ledger (the single write path) — no
    // new event type, no second store, no second state machine.
    const { PLANNING_DECISION_EVENT_TYPE, TRANSITION_TABLE, EXECUTION_COMMANDS } = await import(
      "../../src/modules/executions/public"
    );
    expect(PLANNING_DECISION_EVENT_TYPE).toBe("planning.decision-recorded");
    expect(EXECUTION_COMMANDS).toHaveLength(14);
    const concreteEdges = TRANSITION_TABLE.filter(
      (edge: { command: string }) => edge.command !== "cancel" && edge.command !== "expire",
    );
    expect(concreteEdges).toHaveLength(16);
  });

  test("B4 vocabulary confinement: the semantic-fidelity vocabulary lives only in the capabilities fact plane and the planning wiring", () => {
    const codeSurfaces = [
      "src/api",
      "src/platform",
      "src/modules/models",
      "src/modules/executions",
      "src/modules/verification",
      "src/modules/learning",
      "src/modules/economics",
      "src/modules/budgets",
      "src/modules/policies",
      "src/modules/audit",
      "src/integrations",
      "apps",
      "benchmarks",
      "compat",
      "experiments",
      "sdk",
      "cli",
      "deploy",
      "server.ts",
    ];
    const offenders: string[] = [];
    const scan = (relPath: string): void => {
      const full = join(REPO_ROOT, relPath);
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(full, { withFileTypes: true }) as never;
      } catch {
        // A file, not a directory.
        const content = read(relPath);
        if (/semantic[-_]?fidelity|semanticFidelity|SemanticFidelity/i.test(content)) {
          offenders.push(relPath);
        }
        return;
      }
      for (const entry of entries) {
        const rel = `${relPath}/${entry.name}`;
        if (entry.isDirectory()) {
          scan(rel);
        } else if (entry.name.endsWith(".ts")) {
          const content = read(rel);
          if (/semantic[-_]?fidelity|semanticFidelity|SemanticFidelity/i.test(content)) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const surface of codeSurfaces) {
      scan(surface);
    }
    // PCS-003 owns the planner gating + disclosure wiring (the planning
    // module) over the capabilities fact plane (PCS-002); PCS-004 owns
    // the evaluation (benchmarks/experiments stay forbidden until it
    // wires them). Every other runtime surface stays clean.
    expect(offenders).toEqual([]);
  });

  test("B5 the drift-immune ownership pin: this branch touches nothing outside planning, capabilities and the tests", () => {
    // The e11 C9 pattern: compute the merge-base of this checkout and
    // main AT RUNTIME (a stale pin would self-trip when main advances).
    // The dynamic merge-base can only ever name THIS checkout's own
    // changes; main advancing past the branch point never trips the
    // proof, and this branch merging into main makes the merge-base the
    // head itself — the diff stays EMPTY and the ownership claim holds
    // trivially (the e11 reconciliation discipline; the pre-merge empty
    // state is a PASS, never a failure).
    const mainRef = ["main", "origin/main"].find((candidate) => {
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
    expect(mainRef, "a main ref must exist for the ownership pin").toBeDefined();
    const mergeBase = execSync(`git merge-base HEAD ${mainRef}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const changed = execSync(`git diff --name-only ${mergeBase}..HEAD`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // The work order's owned surfaces: the planning module's gating +
    // disclosure wiring, the capabilities module's additive satisfaction
    // pass-through, and the test files beside the existing suites.
    // NOTHING else.
    const outsideOwnership = changed.filter(
      (file) =>
        !file.startsWith("src/modules/planning/") &&
        !file.startsWith("src/modules/capabilities/") &&
        !file.startsWith("tests/"),
    );
    expect(outsideOwnership).toEqual([]);
  });

  test("B6 the seam and vocabulary pins: TYPE-ONLY cross-module imports; the mirror is pinned against the authority", () => {
    // The planner-surface discipline: planning domain consults other
    // modules TYPE-ONLY (values live in adapters).
    const crossModuleImports = [
      ...GATING_MODULE.matchAll(/from\s+["'](\.\.\/\.\.\/[a-z-]+\/public)["']/g),
    ];
    expect(crossModuleImports.length).toBeGreaterThan(0);
    for (const match of GATING_MODULE.matchAll(
      /^(import\s+type\s+\{[^}]*\}\s+from\s+["']\.\.\/\.\.\/[a-z-]+\/public["'])/gm,
    )) {
      expect(match[1]).toMatch(/^import\s+type\s/);
    }
    // The planner-surface line discipline: every cross-module public
    // import in the gating module is TYPE-ONLY (single-line imports —
    // the module convention the seam checker validates).
    const gatingLines = GATING_MODULE.split("\n");
    for (const line of gatingLines) {
      if (
        /from\s+["']\.\.\/\.\.\/(capabilities|policies|models|connections|executions|budgets|artifacts|context|auth|applications|learning)\/public["']/.test(
          line,
        )
      ) {
        expect(
          line.trim().startsWith("import type"),
          `non-type cross-module import: ${line.trim()}`,
        ).toBe(true);
      }
    }
    // No cross-module VALUE imports anywhere in the module (the shared
    // errors module is intra-platform, not a module barrel).
    for (const line of gatingLines) {
      if (/^import\s+\{/.test(line.trim())) {
        expect(line, "a value import in the gating module must be intra-module only").not.toMatch(
          /from\s+["']\.\.\/\.\.\/[a-z-]+\/public["']/,
        );
      }
    }
    // The vocabulary mirror is pinned against the capabilities
    // authority byte-for-byte (the workload-class precedent).
    expect([...SEMANTIC_QUALITY_REQUIREMENT_VOCABULARY]).toEqual([
      ...SEMANTIC_QUALITY_REQUIREMENTS,
    ]);
  });
});
