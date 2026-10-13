/**
 * Architecture: the semantic-fidelity typed-facts plane boundaries
 * (capabilities module domain; ACR-009 §2; work order PCS-002).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - A1 NO NEW DURABLE SURFACE: the semantic-fidelity module holds no
 *    SQL, no store, no state machine, no lifecycle; the platform
 *    migration census is unchanged (33 migrations — no new durable
 *    surface was created anywhere for semantic fidelity).
 *  - A2 THE FAMILY CENSUS IS FROZEN: the 22 workload families, the
 *    machine manifest's family rows, the six seed capability facts and
 *    the six capability kinds are exactly the pre-change sets — no new
 *    capability family, no registry widening, and the semantic
 *    vocabularies never intersect the capability-kind vocabulary (a
 *    deterministic substitute is NOT a new family).
 *  - A3 NO AMBIENT CONFIGURATION: the module reads no environment, no
 *    clock, no randomness (the C7/C11 pattern).
 *  - A4 THE CLOSED VOCABULARIES: every semantic vocabulary is pinned
 *    exactly — widening is a reviewed change, never silent.
 *  - A5 NO WIRING INTO RUNTIME EXECUTION SEAMS: no code surface
 *    outside the capabilities module, the planning module and the
 *    tests references the semantic-fidelity vocabulary — the planner
 *    gating + disclosure wiring is PCS-003's (DELIVERED: the planning
 *    module is now a wired home), the evaluation is PCS-004's.
 *  - A6 THE MODULE FILE CENSUS: the capabilities module's
 *    application/ports/adapters/internal layers are exactly the
 *    pre-change file sets; the domain layer is the pre-change set plus
 *    the ONE declared artifact (semantic-fidelity.ts) — no second
 *    registry, no new module surface.
 *  - A7 DRIFT-IMMUNE OWNERSHIP PIN: the dynamic merge-base diff of
 *    this branch against main touches NOTHING outside the capabilities
 *    module, the planning module (PCS-003's declared wiring surfaces)
 *    and the tests (the e11 C9 pattern — main advancing past the
 *    branch point never trips it; after merge the diff is empty and
 *    the ownership claim holds trivially, the e11 reconciliation
 *    discipline).
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { WORKLOAD_FAMILIES } from "../../benchmarks/validation/corpus/schema";
import {
  CAPABILITY_KINDS,
  SEED_CAPABILITY_FACTS,
  SEMANTIC_COMPATIBILITY_CONSTRAINTS,
  SEMANTIC_MODALITIES,
  SEMANTIC_NORMALIZATIONS,
  SEMANTIC_QUALITY_REQUIREMENTS,
  SEMANTIC_REPRESENTATION_KINDS,
  SEMANTIC_SIMILARITY_SEMANTICS,
} from "../../src/modules/capabilities/public";

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

const SEMANTIC_MODULE = read("src/modules/capabilities/domain/semantic-fidelity.ts");

describe("architecture: the semantic-fidelity typed-facts plane (PCS-002)", () => {
  test("A1 no new durable surface: no SQL, no store, no state machine; the migration census is unchanged", () => {
    expect(SEMANTIC_MODULE).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
    );
    expect(SEMANTIC_MODULE).not.toMatch(/\bfrom\s+["'](\.\.\/)+(adapters|ports)\/index["']/);
    // The platform migration census at the PCS-002 base is 33 SQL
    // files — semantic fidelity added none (no durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(33);
    expect(migrations.at(-1)).toBe("0034_sandbox_governance.sql");
  });

  test("A2 the family census is frozen: 22 workload families, 22 manifest rows, 6 seeds, 6 kinds — no widening", () => {
    // The 22-family workload census (the corpus vocabulary — read-only import).
    expect([...WORKLOAD_FAMILIES]).toEqual([
      "text",
      "structured",
      "rag",
      "tools",
      "workflow",
      "long-running",
      "voice",
      "realtime-voice",
      "image-generation",
      "video-media",
      "image-recognition",
      "vlm",
      "audio-understanding",
      "multimodal",
      "three-d",
      "customer-service",
      "browser-use",
      "computer-use",
      "research",
      "coding",
      "operations",
      "hitl",
    ]);
    // The machine manifest's family rows mirror the corpus exactly.
    const manifest = JSON.parse(read("docs/developer/machine/capability-manifest.json"));
    expect(manifest.workloadFamilies).toHaveLength(22);
    expect(
      manifest.workloadFamilies.map((entry: { family: string }) => entry.family).sort(),
    ).toEqual([...WORKLOAD_FAMILIES].sort());
    // The seed capability facts are the pre-change six (no new seeds).
    expect(
      SEED_CAPABILITY_FACTS.map((fact) => `${fact.claim.id}:${fact.claim.kind}`).sort(),
    ).toEqual([
      "document-retrieval:tool",
      "human-review:human",
      "json-schema-validation:algorithm",
      "process-sandbox:runtime",
      "structured-dataset-read:data",
      "text-generation:model",
    ]);
    // The capability kinds are the frozen six.
    expect([...CAPABILITY_KINDS]).toEqual([
      "model",
      "tool",
      "algorithm",
      "data",
      "runtime",
      "human",
    ]);
    // The semantic vocabularies never intersect the capability-kind
    // vocabulary (a deterministic substitute is NOT a new family/kind).
    const semanticVocabulary = new Set<string>([
      ...SEMANTIC_REPRESENTATION_KINDS,
      ...SEMANTIC_MODALITIES,
      ...SEMANTIC_NORMALIZATIONS,
      ...SEMANTIC_SIMILARITY_SEMANTICS,
      ...SEMANTIC_QUALITY_REQUIREMENTS,
      ...SEMANTIC_COMPATIBILITY_CONSTRAINTS,
    ]);
    for (const kind of CAPABILITY_KINDS) {
      expect(semanticVocabulary.has(kind)).toBe(false);
    }
  });

  test("A3 no ambient configuration: no environment read, no clock, no randomness in the module", () => {
    expect(SEMANTIC_MODULE).not.toContain("process.env");
    expect(SEMANTIC_MODULE).not.toContain("Date.now");
    expect(SEMANTIC_MODULE).not.toMatch(/new\s+Date\(/);
    expect(SEMANTIC_MODULE).not.toContain("Math.random");
    expect(SEMANTIC_MODULE).not.toMatch(/\bfetch\s*\(/);
  });

  test("A4 the closed vocabularies are pinned exactly (widening is a reviewed change)", () => {
    expect([...SEMANTIC_REPRESENTATION_KINDS]).toEqual([
      "semantic-model-backed",
      "deterministic-substitute",
    ]);
    expect([...SEMANTIC_MODALITIES]).toEqual(["text", "image", "audio", "multimodal"]);
    expect([...SEMANTIC_NORMALIZATIONS]).toEqual(["none", "l2", "scale-bounded"]);
    expect([...SEMANTIC_SIMILARITY_SEMANTICS]).toEqual([
      "cosine",
      "dot",
      "exact-match-lexical",
      "hash-proximity",
    ]);
    expect([...SEMANTIC_QUALITY_REQUIREMENTS]).toEqual(["requires-semantic-retrieval-quality"]);
    expect([...SEMANTIC_COMPATIBILITY_CONSTRAINTS]).toEqual([
      "dimensionality-match",
      "normalization-match",
      "similarity-semantics-match",
    ]);
  });

  test("A5 no wiring into runtime execution seams: the vocabulary is confined to the capabilities module, the planning module and the tests", () => {
    const codeSurfaces = [
      "src/api",
      "src/platform",
      "src/modules/models",
      "src/modules/executions",
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
        if (/semantic[-_]?fidelity|semanticFidelity/i.test(content)) {
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
          if (/semantic[-_]?fidelity|semanticFidelity/i.test(content)) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const surface of codeSurfaces) {
      scan(surface);
    }
    // PCS-003 owns the planner gating + disclosure wiring — DELIVERED:
    // the planning module (src/modules/planning) is now a wired home
    // for the vocabulary (the ACR-009 §3/§4 wiring this test originally
    // anticipated). PCS-004 owns the evaluation wiring — DELIVERED:
    // the evaluation app (benchmarks/validation/apps/
    // semantic-fidelity-evaluation) is the declared evaluation home;
    // every OTHER benchmarks/experiments surface stays forbidden (the
    // exemption is exactly the one declared directory, never the tree).
    const pcs004EvaluationHome = offenders.filter((path) =>
      path.startsWith("benchmarks/validation/apps/semantic-fidelity-evaluation/"),
    );
    expect(pcs004EvaluationHome.length).toBeGreaterThan(0);
    expect(offenders).toEqual([...pcs004EvaluationHome]);
  });

  test("A6 the module file census: one declared new file, no second registry, no new module surface", () => {
    // The capabilities module's non-domain layers are EXACTLY the
    // pre-change file sets (no new registry, no new adapter, no new port).
    expect(listFiles("src/modules/capabilities/application")).toEqual([
      "src/modules/capabilities/application/capability-registry.ts",
      "src/modules/capabilities/application/index.ts",
      "src/modules/capabilities/application/substrate-registry.ts",
    ]);
    expect(listFiles("src/modules/capabilities/ports")).toEqual([
      "src/modules/capabilities/ports/capability-registry.ts",
      "src/modules/capabilities/ports/index.ts",
      "src/modules/capabilities/ports/substrate-store.ts",
    ]);
    expect(listFiles("src/modules/capabilities/adapters")).toEqual([
      "src/modules/capabilities/adapters/in-memory-catalog-store.ts",
      "src/modules/capabilities/adapters/in-memory-substrate-store.ts",
      "src/modules/capabilities/adapters/index.ts",
      "src/modules/capabilities/adapters/seed-catalog.ts",
      "src/modules/capabilities/adapters/sql-substrate-store.ts",
    ]);
    expect(listFiles("src/modules/capabilities/internal")).toEqual([
      "src/modules/capabilities/internal/async-lock.ts",
      "src/modules/capabilities/internal/index.ts",
    ]);
    // The domain layer is the pre-change set plus the ONE declared
    // artifact (semantic-fidelity.ts) — the module's own convention.
    expect(listFiles("src/modules/capabilities/domain")).toEqual([
      "src/modules/capabilities/domain/capability.ts",
      "src/modules/capabilities/domain/index.ts",
      "src/modules/capabilities/domain/resolution.ts",
      "src/modules/capabilities/domain/semantic-fidelity.ts",
      "src/modules/capabilities/domain/substrate.ts",
      "src/modules/capabilities/domain/validation.ts",
    ]);
  });

  test("A7 the drift-immune ownership pin: this branch touches nothing outside the capabilities module, the planning module and the tests", () => {
    // The e11 C9 pattern: compute the merge-base of this checkout and
    // main AT RUNTIME (a stale pin would self-trip when main advances;
    // the dynamic merge-base can only ever name THIS checkout's own
    // changes, and after merge the diff is empty). The empty-diff state
    // (a fresh main checkout, or this branch merged into main) is a
    // PASS — the ownership claim holds trivially — per the e11
    // reconciliation discipline. [PCS-003 correction: the original pin
    // asserted a non-empty changed set, which is false on a fresh
    // main checkout — the pre-existing base-state failure PCS-003
    // root-caused and fixed with the e11 pattern.]
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
    // The work order's owned surfaces: the capabilities module's fact
    // plane (PCS-002), the planning module's gating + disclosure wiring
    // (PCS-003), the PCS-004 evaluation app under
    // benchmarks/validation/apps/semantic-fidelity-evaluation (the
    // declared evaluation home — this test's own A5 anticipated it) and
    // the test files beside the existing suites. NOTHING else. The
    // empty diff (post-merge / fresh main) satisfies the claim trivially.
    // [ACR-010 records-channel correction, 2026-10-13: the pin as written
    // tripped on every pure records-channel branch — an ACR PR touches
    // docs/architecture-changes/ only, and CI must run on those branches
    // (ACR-009's PR predated this pin; ACR-010's PR exposed the defect).
    // The records channel (docs/, spec/) is Lead-owned governance surface,
    // never a worker surface — files there are EXCLUDED from the worker
    // ownership claim (a pure records branch touches no worker surface at
    // all; a mixed branch still has every worker-surface file checked). The
    // e11 C9 discipline's own treatment of spec/ records commits is the
    // precedent. Worker boundaries remain enforced by the work-order
    // protocol, the Lead review and the e11 checks.]
    const recordsChannel = (file: string) => file.startsWith("docs/") || file.startsWith("spec/");
    const outsideOwnership = changed
      .filter((file) => !recordsChannel(file))
      .filter(
        (file) =>
          !file.startsWith("src/modules/capabilities/") &&
          !file.startsWith("src/modules/planning/") &&
          !file.startsWith("benchmarks/validation/apps/semantic-fidelity-evaluation/") &&
          !file.startsWith("tests/"),
      );
    expect(outsideOwnership).toEqual([]);
  });
});
