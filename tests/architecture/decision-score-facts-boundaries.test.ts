/**
 * Architecture: the decision-score typed-facts plane boundaries
 * (planning module domain; ACR-011 §2; work order PCD-001).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - A1 NO NEW DURABLE SURFACE: the decision-score module holds no
 *    SQL, no store, no state machine, no lifecycle; the platform
 *    migration census is unchanged (33 migrations — no new durable
 *    surface was created anywhere for the prediction plane).
 *  - A2 SELF-CONTAINED PURE DOMAIN: the module imports NOTHING — no
 *    platform plane, no cross-module surface, no shared dependency, no
 *    runtime package (the enforced domain layering made structural:
 *    the failure taxonomy is mirrored BY VALUE, never imported — the
 *    prediction/measurement separation is structural before it is
 *    tested).
 *  - A3 NO AMBIENT CONFIGURATION: the module reads no environment, no
 *    clock, no randomness, no network — and never uses a
 *    locale-dependent ordering (the canonical order is code-unit).
 *  - A4 THE CLOSED VOCABULARIES: every vocabulary is pinned exactly —
 *    widening is a reviewed change, never silent.
 *  - A5 THE CONFINEMENT (as delivered by PCD-001 — the amendments
 *    this test's own comments anticipate are PCD-002's wiring and
 *    PCD-003's evaluation, NOT this work order's): no code surface
 *    OUTSIDE the planning module and the tests references the
 *    decision-score vocabulary; inside the module it appears in
 *    exactly the ONE declared artifact. The seam (the scorer adapter,
 *    the declarative configuration) is PCD-002's; the evaluation is
 *    PCD-003's — this plane wires itself into NOTHING.
 *  - A6 THE MODULE FILE CENSUS: the planning module's
 *    application/ports/adapters/internal layers are exactly the
 *    pre-change file sets; the domain layer is the pre-change set plus
 *    the ONE declared PCD-001 artifact (decision-score-facts.ts) — no
 *    second authority, no new module surface, no index re-export (the
 *    module's own convention: domain files are imported directly).
 *  - A7 DRIFT-IMMUNE OWNERSHIP PIN: the dynamic merge-base diff of
 *    this branch against main touches NOTHING outside the planning
 *    module and the tests (the e11 C9 pattern — main advancing past
 *    the branch point never trips it; after merge the diff is empty
 *    and the ownership claim holds trivially, the e11 reconciliation
 *    discipline; the records channel docs/ + spec/ is Lead-owned
 *    governance surface, excluded exactly as in the PCL-001 A7).
 *  - A8 THE PREDICTION/MEASUREMENT SEPARATION (ACR-011 §2/§5 — the
 *    automatic-void condition): the prediction plane's digest
 *    namespace tag is pinned exactly and is DISJOINT from the
 *    measured plane's own tag (compared at runtime through BOTH
 *    planes' real canonical forms); the mirrored failure taxonomy
 *    aligns with the measured plane's BY VALUE (the cross-module value
 *    comparison lives in THIS test — the domain module itself imports
 *    nothing, per A2); neither plane's source references the other's
 *    namespace; the digest is injected, never a shared implementation.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { OutcomeLatencyFacts } from "../../src/modules/executions/domain/outcome-latency-facts";
import {
  canonicalOutcomeLatencyJson,
  OUTCOME_FAILURE_CLASSES,
} from "../../src/modules/executions/domain/outcome-latency-facts";
import type { DecisionScoreFacts } from "../../src/modules/planning/domain/decision-score-facts";
import {
  CONFIDENCE_DISCIPLINES,
  canonicalDecisionScoreJson,
  DECISION_SCORE_KINDS,
  MASS_RECONCILIATION_TOLERANCE,
  MAX_BOUNDARY_CANDIDATES,
  MAX_SCORE_ENTRIES,
  MAX_SCORED_ESTIMATE,
  SCORED_FAILURE_CLASSES,
  SCORER_KINDS,
} from "../../src/modules/planning/domain/decision-score-facts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DECISION_MODULE_PATH = "src/modules/planning/domain/decision-score-facts.ts";
const OUTCOME_MODULE_PATH = "src/modules/executions/domain/outcome-latency-facts.ts";

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

const DECISION_MODULE = read(DECISION_MODULE_PATH);
const OUTCOME_MODULE = read(OUTCOME_MODULE_PATH);

/** A minimal valid decision-score block (one bounded candidate-success entry). */
const decisionScoreFacts: DecisionScoreFacts = {
  entries: [
    {
      value: { kind: "candidate-success", probability: 0.5 },
      confidence: { kind: "bounded", lowerBound: 0.4, upperBound: 0.6 },
      provenance: {
        scorer: {
          kind: "external-scorer",
          identity: "jev",
          version: "1.4.2",
          configurationDigest: "cafe0123",
        },
        calibrationBasisDigest: "beef0456",
        candidateId: "strategy-a",
        scoringContextDigest: "d00d03aa",
      },
    },
  ],
};

/** A minimal valid outcome-latency block (the measured plane's own fixture shape). */
const outcomeLatencyFacts: OutcomeLatencyFacts = {
  outcomeClass: "succeeded-first-attempt",
  legs: [
    {
      legId: "dispatch-1",
      route: { provider: "neutral-a", model: "model-a" },
      firstByte: { kind: "measured", milliseconds: 120 },
      completion: { kind: "measured", milliseconds: 340 },
    },
  ],
  attemptCensus: { original: 1, retry: 0, fallback: 0, verification: 1, attempts: 2 },
  progress: { mode: "event-stream", cooldownAtDispatch: { kind: "none" } },
  cost: {
    totalIncludingDuplicates: { kind: "measured", microUsd: "1250", source: "ledger" },
    verification: { kind: "measured", microUsd: "80", source: "journal" },
  },
  resolved: true,
  verification: { kind: "proved", outcome: "pass", resultIds: ["vr-1"] },
  basis: {
    executionId: "exec-0001",
    route: { provider: "neutral-a", model: "model-a" },
    revision: 3,
    clockDiscipline: "wall-clock",
  },
};

describe("architecture: the decision-score typed-facts plane (PCD-001)", () => {
  test("A1 no new durable surface: no SQL, no store, no state machine; the migration census is unchanged", () => {
    expect(DECISION_MODULE).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
    );
    expect(DECISION_MODULE).not.toMatch(/\bfrom\s+["'](\.\.\/)+(adapters|ports)\/index["']/);
    expect(DECISION_MODULE).not.toContain("DatabasePort");
    expect(DECISION_MODULE).not.toContain("transitionTable");
    // The platform migration census at the PCD-001 base is 33 SQL
    // files — the prediction plane added none (no durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(33);
    expect(migrations.at(-1)).toBe("0034_sandbox_governance.sql");
  });

  test("A2 the plane is a self-contained pure domain module: zero imports, no platform or cross-module dependency", () => {
    // The module is fully self-contained (the layering laws made
    // structural): no import statement of ANY kind and no require — a
    // platform plane, a cross-module surface (the measured
    // outcome-evidence planes included) or a runtime package would
    // each need one (the failure taxonomy is mirrored by value, never
    // imported — the prediction/measurement separation is structural).
    expect(DECISION_MODULE).not.toMatch(/^import\s/m);
    expect(DECISION_MODULE).not.toMatch(/\brequire\s*\(/);
    expect(DECISION_MODULE).not.toMatch(/\bfrom\s+["']/);
  });

  test("A3 no ambient configuration: no environment read, no clock, no randomness, no locale-dependent ordering", () => {
    expect(DECISION_MODULE).not.toContain("process.env");
    expect(DECISION_MODULE).not.toContain("Date.now");
    expect(DECISION_MODULE).not.toMatch(/new\s+Date\(/);
    expect(DECISION_MODULE).not.toContain("Math.random");
    expect(DECISION_MODULE).not.toMatch(/\bfetch\s*\(/);
    // The canonical order is code-unit ordering — a locale-dependent
    // comparison would make the content address environment-dependent.
    expect(DECISION_MODULE).not.toContain("localeCompare");
  });

  test("A4 the closed vocabularies are pinned exactly (widening is a reviewed change)", () => {
    expect([...DECISION_SCORE_KINDS]).toEqual([
      "candidate-success",
      "failure-class-distribution",
      "verifier-value",
      "route-suitability",
    ]);
    expect([...SCORER_KINDS]).toEqual([
      "deterministic-baseline",
      "external-scorer",
      "zeck-trained",
    ]);
    expect([...CONFIDENCE_DISCIPLINES]).toEqual(["bounded", "unbounded-unknown"]);
    expect([...SCORED_FAILURE_CLASSES]).toEqual([
      "provider-5xx",
      "provider-timeout",
      "provider-throttle",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
    ]);
    // The typed bounds are pinned (every field closed or bounded).
    expect(MAX_SCORE_ENTRIES).toBe(256);
    expect(MAX_BOUNDARY_CANDIDATES).toBe(256);
    expect(MAX_SCORED_ESTIMATE).toBe(1_000_000_000);
    expect(MASS_RECONCILIATION_TOLERANCE).toBe(1e-9);
  });

  test("A5 no wiring into runtime seams: the vocabulary is confined to the planning module and the tests (the seam is PCD-002's, the evaluation PCD-003's — neither is this work order's)", () => {
    const vocabularyPattern = /decision[-_]?score/i;
    const offenders: string[] = [];
    const scan = (relPath: string): void => {
      const full = join(REPO_ROOT, relPath);
      if (!existsSync(full)) {
        // A surface that does not exist cannot offend.
        return;
      }
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(full, { withFileTypes: true }) as never;
      } catch {
        // A file, not a directory (e.g. server.ts) — scan its content.
        if (relPath.endsWith(".ts") && vocabularyPattern.test(read(relPath))) {
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
          if (vocabularyPattern.test(content)) {
            offenders.push(rel);
          }
        }
      }
    };
    // Every code surface EXCEPT the planning module (the plane's
    // home): the sibling modules, the platform, the api surfaces, the
    // shared wire, the integrations, and the out-of-src surfaces.
    const siblingModules = readdirSync(join(REPO_ROOT, "src/modules"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "planning")
      .map((entry) => `src/modules/${entry.name}`);
    for (const surface of [
      ...siblingModules,
      "src/api",
      "src/platform",
      "src/shared",
      "src/integrations",
      "api",
      "apps",
      "benchmarks",
      "compat",
      "examples",
      "experiments",
      "sdk",
      "cli",
      "deploy",
      "server.ts",
    ]) {
      scan(surface);
    }
    // The OUTSIDE-planning confinement with NO wiring exemptions: this
    // work order (PCD-001) delivers the pure plane ONLY — the scorer
    // seam/adapter and the declarative configuration are PCD-002's
    // declared surfaces, and the shadow/offline evaluation is
    // PCD-003's; when those land, their homes become declared
    // amendments to this pin exactly as the PCL-002/PCL-003 amendments
    // documented in the outcome-latency A5. Today the vocabulary
    // appears NOWHERE outside the planning module and the tests.
    expect(offenders).toEqual([]);
    // Inside the planning module the vocabulary appears in EXACTLY the
    // one declared artifact (no re-export — the module's own
    // convention; domain files are imported directly).
    const homeOffenders: string[] = [];
    for (const file of listFiles("src/modules/planning")) {
      if (vocabularyPattern.test(read(file))) {
        homeOffenders.push(file);
      }
    }
    expect(homeOffenders).toEqual(["src/modules/planning/domain/decision-score-facts.ts"]);
  });

  test("A6 the module file census: one declared new file, no second authority, no new module surface", () => {
    // The planning module's non-domain layers are EXACTLY the
    // pre-change file sets (no new service, no new port, no new
    // adapter, no public-surface change).
    expect(listFiles("src/modules/planning/application")).toEqual([
      "src/modules/planning/application/index.ts",
      "src/modules/planning/application/planner.ts",
    ]);
    expect(listFiles("src/modules/planning/ports")).toEqual([
      "src/modules/planning/ports/capability-authority.ts",
      "src/modules/planning/ports/composition-recommendations.ts",
      "src/modules/planning/ports/deterministic-catalog.ts",
      "src/modules/planning/ports/deterministicization-signals.ts",
      "src/modules/planning/ports/digest.ts",
      "src/modules/planning/ports/index.ts",
      "src/modules/planning/ports/learned-policy.ts",
      "src/modules/planning/ports/learning-signals.ts",
      "src/modules/planning/ports/model-routes.ts",
      "src/modules/planning/ports/opportunity-signals.ts",
      "src/modules/planning/ports/planning-sink.ts",
      "src/modules/planning/ports/policy-inputs.ts",
      "src/modules/planning/ports/substrate-catalog.ts",
    ]);
    expect(listFiles("src/modules/planning/adapters")).toEqual([
      "src/modules/planning/adapters/capability-authority-adapter.ts",
      "src/modules/planning/adapters/composition-recommendations-adapter.ts",
      "src/modules/planning/adapters/deterministic-capability-publisher.ts",
      "src/modules/planning/adapters/deterministicization-signals-adapter.ts",
      "src/modules/planning/adapters/in-memory-deterministic-catalog.ts",
      "src/modules/planning/adapters/index.ts",
      "src/modules/planning/adapters/ir-plan-source.ts",
      "src/modules/planning/adapters/learned-policy-adapter.ts",
      "src/modules/planning/adapters/learning-signals-adapter.ts",
      "src/modules/planning/adapters/node-digest.ts",
      "src/modules/planning/adapters/opportunity-signals-adapter.ts",
      "src/modules/planning/adapters/planning-sink-adapter.ts",
      "src/modules/planning/adapters/policy-inputs-adapter.ts",
      "src/modules/planning/adapters/route-table-explorer.ts",
      "src/modules/planning/adapters/substrate-catalog-adapter.ts",
    ]);
    expect(listFiles("src/modules/planning/internal")).toEqual([
      "src/modules/planning/internal/index.ts",
    ]);
    // The domain layer is the pre-change set plus the ONE declared
    // PCD-001 artifact (decision-score-facts.ts) — the module's own
    // convention (no barrel registration; domain files are imported
    // directly, exactly as the executions module's PCL-01 artifact).
    expect(listFiles("src/modules/planning/domain")).toEqual([
      "src/modules/planning/domain/canonical.ts",
      "src/modules/planning/domain/composition-consultation.ts",
      "src/modules/planning/domain/decision-score-facts.ts",
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
  });

  test("A7 the drift-immune ownership pin: this branch touches nothing outside the planning module and the tests", () => {
    // The e11 C9 pattern: compute the merge-base of this checkout and
    // main AT RUNTIME (a stale pin would self-trip when main advances;
    // the dynamic merge-base can only ever name THIS checkout's own
    // changes, and after merge the diff is empty). The empty-diff state
    // (a fresh main checkout, or this branch merged into main) is a
    // PASS — the ownership claim holds trivially — per the e11
    // reconciliation discipline. The records channel (docs/, spec/) is
    // Lead-owned governance surface, never a worker surface — files
    // there are EXCLUDED from the worker ownership claim (the PCS-002
    // A7 records-channel correction; the e11 C9 discipline's own
    // treatment of spec/ records commits is the precedent).
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
    // The work order's owned surfaces: the ONE typed-fact artifact in
    // the planning module (src/modules/planning/) and the new test
    // files beside the existing suites (tests/). NOTHING else. The
    // empty diff (post-merge / fresh main) satisfies the claim
    // trivially.
    // [P4 governance-fitness exemption, 2026-10-16 (the e901fbd precedent):
    // the Lead's validation-lab vocabulary/census refinement (the P4
    // registration's records commit added PCD-001..003 specs without
    // extending the closed family — 21 unit suites failed at load) is a
    // Lead-owned governance surface, exactly like the records channel;
    // worker boundaries remain fully enforced.]
    const recordsChannel = (file: string) =>
      file.startsWith("docs/") ||
      file.startsWith("spec/") ||
      file === "apps/dashboard/validation-lab.ts" ||
      file === "tests/unit/dashboard/validation-lab-work-order-vocabulary.test.ts";
    // [The Lead governance-fitness refinements the PCS-002/PCL-001 pins
    // received, carried forward: (a) the TRIGGER is the work order's
    // SUBSTANTIVE surface (the planning module); tests/ alone never
    // triggers (the boundary tests are shared governance-maintenance
    // surface); (b) a branch touching none of the substantive surfaces
    // (another program's delivery) makes the claim vacuous — post-merge
    // the diff is empty per the e11 reconciliation discipline. A rogue
    // file beside a substantive touch is caught exactly as before.]
    const substantiveSurface = (file: string) => file.startsWith("src/modules/planning/");
    const touchesThisWorkOrder = changed.some(
      (file) => !recordsChannel(file) && substantiveSurface(file),
    );
    if (touchesThisWorkOrder) {
      const outsideOwnership = changed
        .filter((file) => !recordsChannel(file))
        .filter((file) => !file.startsWith("src/modules/planning/") && !file.startsWith("tests/"));
      expect(outsideOwnership).toEqual([]);
    }
  });

  test("A8 the prediction/measurement separation: disjoint digest namespaces, taxonomy aligned by value, never by import", () => {
    // The prediction plane's digest namespace tag is pinned exactly...
    const decisionCanonical = canonicalDecisionScoreJson(decisionScoreFacts);
    expect(decisionCanonical.startsWith('["planning.decision-score-facts",')).toBe(true);
    // ...and the measured plane's own tag is pinned from ITS module at
    // runtime (the two canonical forms are the REAL namespaces).
    const outcomeCanonical = canonicalOutcomeLatencyJson(outcomeLatencyFacts);
    expect(outcomeCanonical.startsWith('["executions.outcome-latency-facts",')).toBe(true);
    // The namespaces are DISJOINT — neither plane's canonical form can
    // ever carry the other's tag (a shared digest namespace is the
    // conflation shape, the automatic-void condition of ACR-011 §5).
    expect("planning.decision-score-facts").not.toBe("executions.outcome-latency-facts");
    expect(decisionCanonical).not.toContain("executions.outcome-latency-facts");
    expect(outcomeCanonical).not.toContain("planning.decision-score-facts");
    // Neither plane's SOURCE references the other's namespace — the
    // separation is textual as well as structural (the domain module
    // imports nothing, per A2; the digest is injected per plane, never
    // a shared implementation).
    expect(DECISION_MODULE).not.toContain("executions.outcome-latency-facts");
    expect(OUTCOME_MODULE).not.toContain("planning.decision-score-facts");
    // The mirrored failure taxonomy aligns with the measured plane's
    // closed seven BY VALUE — this cross-module comparison lives in
    // the TEST (the alignment pin); the domain module mirrors the
    // taxonomy and never imports it (A2). A drift on either side
    // fails this pin and demands a reviewed change.
    expect([...SCORED_FAILURE_CLASSES]).toEqual([...OUTCOME_FAILURE_CLASSES]);
    // And the prediction plane's vocabulary never intersects the
    // measured plane's outcome-class vocabulary (a score kind is never
    // an outcome class — predictions and measurements never merge).
    expect(DECISION_SCORE_KINDS).not.toContain("succeeded-first-attempt");
  });
});
