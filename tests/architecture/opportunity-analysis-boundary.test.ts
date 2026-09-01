/**
 * Architecture: the codebase-opportunity analysis boundary (WORK-022;
 * checkpoint contracts IMPLEMENTATION-COMPLETENESS,
 * SELF-HOSTING-BOUNDARY, EXECUTION-PROVENANCE — plus the LEARNING
 * non-authority and planner-surface invariants this Work Order
 * extends).
 *
 * Mechanically proves over the REAL tree:
 *  - the migration 0016 claim (the parallel-wave collision rule): the
 *    claim is pinned in the file, unique, un-renumbered, and the
 *    physical twins (immutability triggers, the born-advisory insert
 *    guard, the journal-coupled state guard, the VOI CHECK, the
 *    NULL-safe verified-equivalence CHECK, the preference-only rating
 *    answer CHECK) are present in the shipped SQL;
 *  - the analyzer service exposes EXACTLY the non-authoritative deps
 *    {store, digest, generateId, now} (M2/M4/M5/M6/M20: no policy,
 *    capability, budget, sandbox or execution authority can be wired
 *    into it);
 *  - the learning opportunity tree owns NO code-execution /
 *    code-mutation surface (M20/M21: no fs/process/eval anywhere in
 *    the module — the analysis reads caller-supplied data only);
 *  - the API route composes "Analysis is an Execution": the executions
 *    authority's create + authorize transition happen BEFORE the
 *    analyzer call (M2/M4: policy admission before codebase access),
 *    and the route carries no repository-mutation surface;
 *  - the planner opportunity seam is consult-only (M17/M19: one
 *    `consult` method, planning-owned port, consulted AFTER the
 *    governed selection, the durable record binds the governed
 *    selection — never an opportunity preference).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");
const PLANNING_DIR = join(REPO_ROOT, "src/modules/planning");
const ROUTE_PATH = join(REPO_ROOT, "src/api/routes/codebase-analysis.ts");
const MIGRATIONS_DIR = join(REPO_ROOT, "src/platform/db/migrations");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const LEARNING_FILES = collectFiles(LEARNING_DIR);

/** Strip comments (block + line) so scanner probes hit CODE, not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The code-execution / code-mutation vocabulary (M20/M21). */
const CODE_MUTATION_VOCABULARY =
  /\b(writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync|spawnSync|execSync|spawn|execFile|child_process|new Function|eval\(|git clone|git checkout|git push|readFileSync)\b/;

describe("architecture: the codebase-opportunity analysis boundary (WORK-022)", () => {
  test("the migration claim 0016 is pinned, unique and un-renumbered (the collision rule)", () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    const versions = names.map((name) => Number(name.slice(0, 4))).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(versions.length); // globally unique
    // The WORK-017 baseline (0001..0010) is intact and contiguous.
    expect(versions.filter((version) => version <= 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(versions).toContain(14); // WORK-032 economic actions (landed on main)
    // WORK-022's pre-assigned claim (the wave order: WORK-019 claims
    // 0015 — a sibling branch; its absence here is a LEGAL pre-merge
    // gap: the runner applies in ascending order and tolerates gaps).
    expect(versions).toContain(16);
    expect(names).toContain("0016_opportunity_analysis.sql");
    const migration = readFileSync(join(MIGRATIONS_DIR, "0016_opportunity_analysis.sql"), "utf8");
    expect(migration).toContain("WORK-022 claims 0016");
    expect(migration).toContain("WORK-019 claims 0015");
  });

  test("migration 0016 carries the physical protection twins", () => {
    const migration = readFileSync(join(MIGRATIONS_DIR, "0016_opportunity_analysis.sql"), "utf8");
    // §18 no-auto-promotion: 'promoted' is not a state of this module.
    expect(migration).toContain(
      "findings_state_vocabulary CHECK (state IN ('advisory','candidate','verified'))",
    );
    // A finding is born advisory (the insert guard).
    expect(migration).toContain("opportunity_findings_insert_guard");
    // The state advance is evidence-gated (journal-coupled) and
    // forward-only.
    expect(migration).toContain("opportunity_findings_state_guard");
    expect(migration).toContain("transitions_forward_only CHECK");
    // M15/M16: verified requires equivalence evidence (NULL-safe).
    expect(migration).toContain("verified_equivalence IS NOT NULL");
    expect(migration).toContain("transitions_verified_requires_equivalence");
    // M10: the rating answer vocabulary is preference-only.
    expect(migration).toContain("ratings_v22_answer_vocabulary");
    // M24 (physical): prompts justify their user friction.
    expect(migration).toContain(
      "prompts_voi_gate CHECK (expected_information_gain > user_friction_threshold)",
    );
    // Immutability everywhere (write-once evidence).
    for (const guard of [
      "opportunity_analyses_immutable_guard",
      "opportunity_findings_immutable_guard",
      "opportunity_prompts_immutable_guard",
      "opportunity_ratings_immutable_guard",
      "opportunity_transitions_immutable_guard",
    ]) {
      expect(migration).toContain(guard);
    }
    // M12/M28: revision binding is physical on every table that
    // references a source revision.
    expect(migration).toContain("analyses_revision_nonempty");
    expect(migration).toContain("ratings_v22_revision_nonempty");
    // M2/M26: the analysis-is-an-execution binding is a physical UNIQUE.
    expect(migration).toContain("analyses_execution_unique UNIQUE (execution_id)");
  });

  test("the analyzer service exposes EXACTLY the non-authoritative deps (M2/M4/M5/M6/M20)", () => {
    const source = readFileSync(join(LEARNING_DIR, "application/opportunity-analyzer.ts"), "utf8");
    const match = /interface OpportunityAnalyzerDeps \{([\s\S]*?)\}/.exec(source);
    expect(match, "OpportunityAnalyzerDeps must exist").not.toBeNull();
    const fields = [...(match?.[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
      (field) => field[1] ?? "",
    );
    expect(fields.sort()).toEqual(["digest", "generateId", "now", "store"]);
    // The authority seam names are absent from the analyzer CODE
    // (comments are stripped: prose about the invariant is not a seam).
    const code = stripComments(source);
    for (const forbidden of [
      "policyAuthority",
      "capabilityAuthority",
      "budgetAuthority",
      "sandbox",
      "computeEnvironment",
      "dispatch",
      "authorize",
      "admitExecution",
    ]) {
      expect(code.includes(forbidden), `analyzer must not reference ${forbidden}`).toBe(false);
    }
  });

  test("the learning opportunity tree owns NO code-execution / code-mutation surface (M20/M21)", () => {
    const violations: string[] = [];
    for (const file of LEARNING_FILES) {
      const relative = file.slice(REPO_ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      if (/from\s+["']node:(fs|child_process|os)["']/.test(text)) {
        violations.push(`node-builtin-import:${relative}`);
      }
      const match = CODE_MUTATION_VOCABULARY.exec(text);
      if (match !== null) {
        violations.push(`code-mutation-vocabulary:${relative}:${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the API route composes Analysis-is-an-Execution: admission BEFORE the analyzer (M2/M4)", () => {
    const route = readFileSync(ROUTE_PATH, "utf8");
    const createCall = route.indexOf("deps.executions.createExecution");
    const authorizeCall = route.indexOf('deps.executions.transition(commandOf("authorize")');
    const analyzerCall = route.indexOf("deps.analyzer.analyzeSubgraph");
    expect(createCall).toBeGreaterThanOrEqual(0);
    expect(authorizeCall).toBeGreaterThan(createCall);
    expect(analyzerCall).toBeGreaterThan(authorizeCall);
    // The route delegates every execution write to the authority (no
    // direct SQL, no store access, no code-mutation vocabulary).
    expect(/from\s+["'].*platform\/db/.test(route)).toBe(false);
    expect(CODE_MUTATION_VOCABULARY.test(route)).toBe(false);
    // 'promoted' is not reachable on this surface.
    expect(route).not.toMatch(/\bpromote\b/);
  });

  test("the planner opportunity seam is consult-only and post-selection (M17/M19)", () => {
    const portSource = readFileSync(join(PLANNING_DIR, "ports/opportunity-signals.ts"), "utf8");
    // Exactly one method: consult (a READ). No mutate/authorize surface
    // (comments stripped: the port's PROSE about the invariant is not a seam).
    const methods = [...portSource.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1] ?? "");
    expect(methods).toEqual(["consult"]);
    const portCode = stripComments(portSource);
    for (const forbidden of [
      "mutate",
      "authorize",
      "reserve",
      "dispatch",
      "transition",
      "promote",
    ]) {
      expect(portCode.toLowerCase(), `the port must not expose ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    const plannerSource = readFileSync(join(PLANNING_DIR, "application/planner.ts"), "utf8");
    const selectionCall = plannerSource.indexOf("const selection = selectStrategy(");
    const selectedBinding = plannerSource.indexOf("const selected = selection.selected;");
    const opportunityConsult = plannerSource.search(/deps\.opportunitySignals\??\.consult\(/);
    expect(selectionCall).toBeGreaterThanOrEqual(0);
    expect(selectedBinding).toBeGreaterThan(selectionCall);
    expect(opportunityConsult).toBeGreaterThan(selectedBinding);
    // The consultation sits between the selection and the decision
    // record — never before the governed selection (the record binding
    // pattern is the same unique one the WORK-014 scanner pins).
    const decisionRecord = plannerSource.indexOf(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
    );
    expect(decisionRecord).toBeGreaterThan(opportunityConsult);
    // Between the selection call and the selected binding, opportunity
    // consultation is absent (the selection is computed free of it).
    const selectionSegment = plannerSource.slice(selectionCall, selectedBinding);
    expect(/opportunity/i.test(selectionSegment)).toBe(false);

    // The adapter validates every consulted finding at the seam.
    const adapterSource = readFileSync(
      join(PLANNING_DIR, "adapters/opportunity-signals-adapter.ts"),
      "utf8",
    );
    expect(adapterSource.includes("validateConsultedOpportunitySignal(consulted)")).toBe(true);
  });

  test("the learning public barrel exposes the advisory surface only (no promotion, no dispatch)", async () => {
    const barrel = await import("../../src/modules/learning/public");
    const exportedNames = Object.keys(barrel);
    for (const forbidden of [
      "promote",
      "promoteFinding",
      "deploy",
      "dispatch",
      "authorize",
      "mutateRepository",
      "executeSubgraph",
      "applyDeterministicReplacement",
    ]) {
      expect(
        exportedNames.some((name) => name.toLowerCase().startsWith(forbidden.toLowerCase())),
        `the learning barrel must not expose ${forbidden}`,
      ).toBe(false);
    }
    // The finding-state vocabulary is closed (advisory | candidate |
    // verified — 'promoted' is unrepresentable).
    expect(barrel.FINDING_STATES).toEqual(["advisory", "candidate", "verified"]);
    expect(barrel.INSERTABLE_FINDING_STATES).toEqual(["advisory"]);
    // 'verified-equivalent' is not an insertable equivalence potential.
    expect(barrel.DETERMINISTIC_EQUIVALENCE_POTENTIALS).toEqual(["none", "candidate-replacement"]);
    // The rating answers are preference-only (M10).
    expect(barrel.EVALUATION_RATING_ANSWERS).toEqual([
      "prefer-candidate",
      "prefer-baseline",
      "no-difference",
      "insufficient-information",
    ]);
  });

  test("planning domain/application/ports consult learning TYPE-ONLY (values live in adapters)", () => {
    const violations: string[] = [];
    for (const layer of ["domain", "application", "ports"]) {
      for (const file of collectFiles(join(PLANNING_DIR, layer))) {
        const text = readFileSync(file, "utf8");
        // An import statement mentioning learning/public must be type-only
        // (multi-line statements included: find the statement start).
        for (const statement of text.matchAll(
          /import\s+type\s*\{[\s\S]*?\}\s*from\s*["'][^"']*learning\/public["']/g,
        )) {
          void statement;
        }
        const learningImports = [
          ...text.matchAll(
            /(^import\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*)(["'][^"']*learning\/public["'])/g,
          ),
        ];
        for (const match of learningImports) {
          const head = match[1] ?? "";
          if (!/^import\s+type(\s|\{)/.test(head.trim())) {
            violations.push(`value-import:${file.slice(REPO_ROOT.length + 1)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the wire surface carries the closed advisory vocabulary (no code payloads)", () => {
    const wire = readFileSync(join(REPO_ROOT, "src/shared/wire.ts"), "utf8");
    expect(wire).toContain("CODEBASE_FINDING_STATES");
    expect(wire).toContain('CODEBASE_FINDING_STATES = ["advisory", "candidate", "verified"]');
    // No code/patch/deployment payload crosses the wire for analysis.
    for (const forbidden of ["CodebasePatch", "CodebaseDiff", "CodebaseDeployment", "codePatch"]) {
      expect(wire.includes(forbidden)).toBe(false);
    }
  });
});
