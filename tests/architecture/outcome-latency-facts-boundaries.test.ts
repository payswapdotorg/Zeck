/**
 * Architecture: the outcome-latency typed-facts plane boundaries
 * (executions module domain; ACR-010 §2; work order PCL-001).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - A1 NO NEW DURABLE SURFACE: the outcome-latency module holds no
 *    SQL, no store, no state machine, no lifecycle; the platform
 *    migration census is unchanged (33 migrations — no new durable
 *    surface was created anywhere for the evidence plane).
 *  - A2 SELF-CONTAINED PURE DOMAIN: the module imports NOTHING — no
 *    platform plane, no cross-module surface, no shared dependency, no
 *    runtime package (the enforced domain layering made structural:
 *    the CostClaim discipline and the failure taxonomies are mirrored
 *    by value, never imported).
 *  - A3 NO AMBIENT CONFIGURATION: the module reads no environment, no
 *    clock, no randomness, no network — and never uses a
 *    locale-dependent ordering (the canonical order is code-unit).
 *  - A4 THE CLOSED VOCABULARIES: every vocabulary is pinned exactly —
 *    widening is a reviewed change, never silent.
 *  - A5 THE CONFINEMENT (as amended by the PCL-002 wiring — the
 *    amendment this test's own comments anticipated): no code surface
 *    OUTSIDE the executions module and the tests references the
 *    outcome-latency vocabulary; inside the module it appears in
 *    exactly the declared artifact set — the PCL-01 artifact plus the
 *    two PCL-002 declared surfaces (the declarative pacing
 *    configuration consuming the vocabularies read-only, and the
 *    pacing seam adapter). The evaluation is PCL-003's.
 *  - A6 THE MODULE FILE CENSUS: the executions module's
 *    application/ports/adapters/internal layers are the pre-change
 *    file sets plus the ONE declared PCL-002 wiring seam
 *    (adapters/tail-pacing.ts); the domain layer is the pre-change set
 *    plus the PCL-01 artifact and the PCL-002 configuration artifact —
 *    no second authority, no new module surface, no public.ts
 *    re-export.
 *  - A7 DRIFT-IMMUNE OWNERSHIP PIN: the dynamic merge-base diff of
 *    this branch against main touches NOTHING outside the executions
 *    module and the tests (the e11 C9 pattern — main advancing past
 *    the branch point never trips it; after merge the diff is empty
 *    and the ownership claim holds trivially, the e11 reconciliation
 *    discipline; the records channel docs/ + spec/ is Lead-owned
 *    governance surface, excluded exactly as in the PCS-002 A7
 *    correction).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CLOCK_DISCIPLINES,
  DISPATCH_COOLDOWN_KINDS,
  MAX_ATTEMPT_COUNT,
  MAX_LATENCY_MS,
  MAX_LEGS,
  MAX_PLAN_REVISION,
  MAX_VERIFICATION_RESULT_REFS,
  MEASUREMENT_KINDS,
  OUTCOME_CLASSES,
  OUTCOME_FAILURE_CLASSES,
  PROGRESS_DELIVERY_MODES,
  VERIFICATION_PROOF_KINDS,
  VERIFICATION_PROOF_OUTCOMES,
} from "../../src/modules/executions/domain/outcome-latency-facts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

const OUTCOME_MODULE = read(OUTCOME_MODULE_PATH);

describe("architecture: the outcome-latency typed-facts plane (PCL-001)", () => {
  test("A1 no new durable surface: no SQL, no store, no state machine; the migration census is unchanged", () => {
    expect(OUTCOME_MODULE).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
    );
    expect(OUTCOME_MODULE).not.toMatch(/\bfrom\s+["'](\.\.\/)+(adapters|ports)\/index["']/);
    expect(OUTCOME_MODULE).not.toContain("DatabasePort");
    expect(OUTCOME_MODULE).not.toContain("transitionTable");
    // The platform migration census at the PCL-001 base is 33 SQL
    // files — the evidence plane added none (no durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(33);
    expect(migrations.at(-1)).toBe("0034_sandbox_governance.sql");
  });

  test("A2 the plane is a self-contained pure domain module: zero imports, no platform or cross-module dependency", () => {
    // The module is fully self-contained (the layering laws made
    // structural): no import statement of ANY kind and no require — a
    // platform plane, a cross-module surface or a runtime package would
    // each need one (the CostClaim discipline and the failure
    // taxonomies are mirrored by value, never imported).
    expect(OUTCOME_MODULE).not.toMatch(/^import\s/m);
    expect(OUTCOME_MODULE).not.toMatch(/\brequire\s*\(/);
    expect(OUTCOME_MODULE).not.toMatch(/\bfrom\s+["']/);
  });

  test("A3 no ambient configuration: no environment read, no clock, no randomness, no locale-dependent ordering", () => {
    expect(OUTCOME_MODULE).not.toContain("process.env");
    expect(OUTCOME_MODULE).not.toContain("Date.now");
    expect(OUTCOME_MODULE).not.toMatch(/new\s+Date\(/);
    expect(OUTCOME_MODULE).not.toContain("Math.random");
    expect(OUTCOME_MODULE).not.toMatch(/\bfetch\s*\(/);
    // The canonical order is code-unit ordering — a locale-dependent
    // comparison would make the content address environment-dependent.
    expect(OUTCOME_MODULE).not.toContain("localeCompare");
  });

  test("A4 the closed vocabularies are pinned exactly (widening is a reviewed change)", () => {
    expect([...OUTCOME_CLASSES]).toEqual([
      "succeeded-first-attempt",
      "succeeded-after-retry",
      "succeeded-on-fallback",
      "failed-terminal",
    ]);
    expect([...OUTCOME_FAILURE_CLASSES]).toEqual([
      "provider-5xx",
      "provider-timeout",
      "provider-throttle",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
    ]);
    expect([...PROGRESS_DELIVERY_MODES]).toEqual(["event-stream", "polled"]);
    expect([...CLOCK_DISCIPLINES]).toEqual(["wall-clock", "monotonic"]);
    expect([...MEASUREMENT_KINDS]).toEqual(["measured", "not-run"]);
    expect([...VERIFICATION_PROOF_KINDS]).toEqual(["proved", "not-run"]);
    expect([...VERIFICATION_PROOF_OUTCOMES]).toEqual(["pass", "fail", "inconclusive"]);
    expect([...DISPATCH_COOLDOWN_KINDS]).toEqual(["none", "active"]);
    // The typed bounds are pinned (every field closed or bounded).
    expect(MAX_LATENCY_MS).toBe(3_600_000);
    expect(MAX_ATTEMPT_COUNT).toBe(1000);
    expect(MAX_PLAN_REVISION).toBe(2_147_483_647);
    expect(MAX_LEGS).toBe(100);
    expect(MAX_VERIFICATION_RESULT_REFS).toBe(100);
  });

  test("A5 no wiring into runtime execution seams beyond the DECLARED PCL-002 surfaces: the vocabulary is confined to the executions module and the tests", () => {
    const vocabularyPattern = /outcome[-_]?latency|outcomeLatency/i;
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
    // Every code surface EXCEPT the executions module (the plane's
    // home): the sibling modules, the platform, the api surfaces, the
    // shared wire, the integrations, and the out-of-src surfaces.
    const siblingModules = readdirSync(join(REPO_ROOT, "src/modules"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "executions")
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
    // The OUTSIDE-executions confinement stays ABSOLUTE (the PCL-002
    // wiring landed inside the executions module only — A7 proves it
    // mechanically over the branch diff).
    expect(offenders).toEqual([]);
    // Inside the executions module the vocabulary appears in EXACTLY
    // the declared artifact set. [PCL-002 wiring amendment, documented
    // in the PCL-002 delivery: the riding/wiring this test anticipated
    // ("the riding/wiring is PCL-002's, behind the existing seams,
    // default-off") LANDED as (a) the declarative tail-pacing
    // configuration — the domain artifact that consumes the PCL-01
    // vocabularies READ-ONLY (types + taxonomy, keyed for the cooldown
    // rules and the retryable set), and (b) the tail-pacing seam
    // adapter — the executions module's single pacing-reading point,
    // which projects the applied mechanics into the PCL-01 facts
    // shapes. No other executions-module surface references the
    // vocabulary; no re-export exists (domain files are imported
    // directly — the module's own convention).]
    const homeOffenders: string[] = [];
    for (const file of listFiles("src/modules/executions")) {
      if (vocabularyPattern.test(read(file))) {
        homeOffenders.push(file);
      }
    }
    expect(homeOffenders).toEqual([
      "src/modules/executions/adapters/tail-pacing.ts",
      "src/modules/executions/domain/outcome-latency-facts.ts",
      "src/modules/executions/domain/tail-pacing-configuration.ts",
    ]);
  });

  test("A6 the module file census: one declared new file, no second authority, no new module surface", () => {
    // The executions module's non-domain layers are EXACTLY the
    // pre-change file sets (no new service, no new port, no new
    // adapter, no public-surface change).
    expect(listFiles("src/modules/executions/application")).toEqual([
      "src/modules/executions/application/execution-service.ts",
      "src/modules/executions/application/index.ts",
      "src/modules/executions/application/long-running-service.ts",
    ]);
    expect(listFiles("src/modules/executions/ports")).toEqual([
      "src/modules/executions/ports/authorization.ts",
      "src/modules/executions/ports/execution-idempotency.ts",
      "src/modules/executions/ports/execution-store.ts",
      "src/modules/executions/ports/index.ts",
      "src/modules/executions/ports/long-running-store.ts",
      "src/modules/executions/ports/resume-admission.ts",
    ]);
    // The adapters layer: the pre-change set plus the PCL-002 declared
    // wiring seam (tail-pacing.ts — the executions module's single
    // pacing-reading point over the domain configuration; no new
    // service, no new port, no public-surface change). [PCL-002 wiring
    // amendment, documented in the delivery.]
    expect(listFiles("src/modules/executions/adapters")).toEqual([
      "src/modules/executions/adapters/evacuation-seam.ts",
      "src/modules/executions/adapters/in-memory-long-running-store.ts",
      "src/modules/executions/adapters/index.ts",
      "src/modules/executions/adapters/ir-execution-binding.ts",
      "src/modules/executions/adapters/orchestration-source.ts",
      "src/modules/executions/adapters/policy-resume-admission.ts",
      "src/modules/executions/adapters/recovery-invariants.ts",
      "src/modules/executions/adapters/sql-execution-store.ts",
      "src/modules/executions/adapters/sql-long-running-store.ts",
      "src/modules/executions/adapters/tail-pacing.ts",
      "src/modules/executions/adapters/transport-effect.ts",
      "src/modules/executions/adapters/worker-fabric.ts",
      "src/modules/executions/adapters/workflow-effect.ts",
    ]);
    expect(listFiles("src/modules/executions/internal")).toEqual([
      "src/modules/executions/internal/index.ts",
    ]);
    // The domain layer is the pre-change set plus the ONE declared
    // artifact (outcome-latency-facts.ts) and, since the PCL-002
    // wiring, the declarative pacing configuration artifact
    // (tail-pacing-configuration.ts) — the module's own convention (no
    // barrel registration; domain files are imported directly).
    // [PCL-002 wiring amendment, documented in the delivery: the
    // configuration artifact is the PCL-002 work order's declared
    // domain surface — the typed, closed, versioned pacing DATA that
    // consumes this module's vocabularies read-only.]
    expect(listFiles("src/modules/executions/domain")).toEqual([
      "src/modules/executions/domain/checkpoint.ts",
      "src/modules/executions/domain/event.ts",
      "src/modules/executions/domain/execution.ts",
      "src/modules/executions/domain/index.ts",
      "src/modules/executions/domain/lease.ts",
      "src/modules/executions/domain/longrunning.ts",
      "src/modules/executions/domain/outcome-latency-facts.ts",
      "src/modules/executions/domain/state-machine.ts",
      "src/modules/executions/domain/tail-pacing-configuration.ts",
      "src/modules/executions/domain/verification.ts",
      "src/modules/executions/domain/wakeup.ts",
    ]);
  });

  test("A7 the drift-immune ownership pin: this branch touches nothing outside the executions module and the tests", () => {
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
    // the executions module (src/modules/executions/) and the new test
    // files beside the existing suites (tests/). NOTHING else. The
    // empty diff (post-merge / fresh main) satisfies the claim
    // trivially.
    const recordsChannel = (file: string) => file.startsWith("docs/") || file.startsWith("spec/");
    // [Lead governance-fitness amendment, 2026-10-13 (PR body documents it):
    // the same two refinements the PCS-002/PCS-003 pins received this cycle —
    // (a) the TRIGGER is the work order's SUBSTANTIVE surface (the executions
    // module); tests/ alone never triggers (the boundary tests are shared
    // governance-maintenance surface); (b) a branch touching none of the
    // substantive surfaces (another program's delivery) makes the claim
    // vacuous — post-merge the diff is empty per the e11 reconciliation
    // discipline. A rogue file beside a substantive touch is caught exactly
    // as before.]
    const substantiveSurface = (file: string) => file.startsWith("src/modules/executions/");
    const touchesThisWorkOrder = changed.some(
      (file) => !recordsChannel(file) && substantiveSurface(file),
    );
    if (touchesThisWorkOrder) {
      const outsideOwnership = changed
        .filter((file) => !recordsChannel(file))
        .filter(
          (file) => !file.startsWith("src/modules/executions/") && !file.startsWith("tests/"),
        );
      expect(outsideOwnership).toEqual([]);
    }
  });
});
