/**
 * Architecture: the tool-synthesis boundary (WORK-018, TOL-004;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY).
 *
 * Mechanically proves over the REAL `src/modules/tools/` tree:
 *
 *  - S1 NO EXECUTION SURFACE OUTSIDE THE SANDBOX SEAM: the tools tree
 *    contains no child_process spawn, no dynamic evaluation (eval /
 *    new Function), no worker threads, no HTTP egress — compiled and
 *    executed programs can ONLY cross the `SynthesisSandboxExecutor`
 *    port (criterion 2; the discrimination suite proves a mutated
 *    bypass is flagged);
 *  - S2 THE EXECUTOR'S ONLY IMPLEMENTATION WRAPS THE SANDBOX MANAGER:
 *    the synthesis-sandbox-executor adapter imports the sandbox
 *    module's PUBLIC surface and drives the governed create+dispatch
 *    path; no other file implements the port (the executor seam is
 *    single-implementation by construction);
 *  - S3 THE SYNTHESIS SERVICE DEPS ARE PINNED: exactly {store, sandbox
 *    executor, registry, adapter factory, digest, generateId, now} —
 *    no policy/budget/capability/execution-transition seam is
 *    reachable from the synthesis service (admission belongs to the
 *    runtime chain and the sandbox service);
 *  - S4 THE SYNTHESIZED LIFECYCLE IS SUBORDINATE: no execution state
 *    machine vocabulary (no nextState/canTransition over execution
 *    commands), no verification vocabulary, no policy admission
 *    re-implementation (the tools admission port remains the only
 *    policy seam);
 *  - S5 THE SYNTHESIS MIGRATION IS CLAIMED: 0011 exists, creates
 *    tools.synthesized_programs with the physical immutability guards
 *    and the additive sandbox output-evidence column (the collision
 *    rule, parallel-wave documented assignment);
 *  - S6 THE SYNTHESIS VOCABULARY IS CONFINED TO THE TOOLS MODULE: the
 *    synthesized-program status/lifecycle vocabulary appears nowhere
 *    outside tools (no second lifecycle authority);
 *  - S7 THE ADAPTER-FACTORY SEAM: the synthesized tool adapter
 *    dispatches only through the executor port and the durable store
 *    re-read (dispatch-time fail-closed discipline).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  executionSurfaceViolations,
  executorImplementationViolations,
  lifecycleVocabularyViolations,
  synthesisDepsViolations,
} from "../discrimination/lib/tool-synthesis";

const REPO_ROOT = join(process.cwd());
const TOOLS_DIR = join(REPO_ROOT, "src/modules/tools");

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

const FILES = collectFiles(TOOLS_DIR);

describe("architecture: the tool-synthesis boundary (WORK-018)", () => {
  test("the tools tree is present and scanned", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  test("S1: NO execution surface outside the sandbox seam (criterion 2)", () => {
    const files = FILES.map((file) => ({
      path: file.slice(REPO_ROOT.length + 1),
      content: readFileSync(file, "utf8"),
    }));
    expect(executionSurfaceViolations(files)).toEqual([]);
  });

  test("S2: the executor's only implementation wraps the sandbox manager", () => {
    const files = FILES.map((file) => ({
      path: file.slice(REPO_ROOT.length + 1),
      content: readFileSync(file, "utf8"),
    }));
    expect(executorImplementationViolations(files)).toEqual([]);
  });

  test("S3: the synthesis service deps are pinned (no authority seam is reachable)", () => {
    const service = readFileSync(join(TOOLS_DIR, "application/synthesis-service.ts"), "utf8");
    expect(synthesisDepsViolations(service)).toEqual([]);
  });

  test("S4: the synthesized lifecycle owns no execution/verification/policy vocabulary", () => {
    const synthesisFiles = FILES.filter((file) => file.includes("/synthesis"));
    for (const file of synthesisFiles) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [
        /\bEXECUTION_COMMANDS\b/,
        /\bappendEvent\b/,
        /\brecordPlanningDecision\b/,
        /\bverificationPassed\b/,
        /\bPOLICY_DENIED\b/,
      ]) {
        expect(pattern.test(text), `${file} must not carry ${pattern.source}`).toBe(false);
      }
    }
  });

  test("S5: the synthesis migration is claimed with physical guards (0011)", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0011_tool_synthesis.sql"),
      "utf8",
    );
    expect(migration.includes("tools.synthesized_programs")).toBe(true);
    expect(migration.includes("synthesized_programs_core_guard")).toBe(true);
    expect(migration.includes("synthesized_programs_lifecycle_guard")).toBe(true);
    expect(migration.includes("synthesized_programs_no_delete_guard")).toBe(true);
    expect(migration.includes("ADD COLUMN output jsonb")).toBe(true);
    // The collision-rule discipline is documented in the migration itself.
    expect(migration.includes("WORK-018 claims 0011")).toBe(true);
    expect(migration.includes("WORK-023 claims 0012")).toBe(true);
    expect(migration.includes("WORK-031 claims 0013")).toBe(true);
  });

  test("S6: the synthesized-program lifecycle vocabulary is confined to tools", () => {
    const violations: string[] = [];
    const modulesRoot = join(REPO_ROOT, "src/modules");
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          violations.push(full.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(modulesRoot);
    const files = violations.map((path) => ({
      path,
      content: readFileSync(join(REPO_ROOT, path), "utf8"),
    }));
    expect(lifecycleVocabularyViolations(files)).toEqual([]);
  });

  test("S7: the synthesized tool adapter dispatches only through the executor + store", () => {
    const adapter = readFileSync(join(TOOLS_DIR, "adapters/synthesized-tool-adapter.ts"), "utf8");
    expect(adapter.includes("SynthesisSandboxExecutor")).toBe(true);
    expect(adapter.includes("SynthesisStore")).toBe(true);
    // The dispatch-time fail-closed checks are present (defense in depth).
    expect(adapter.includes("no longer usable")).toBe(true);
    expect(adapter.includes("never executed past expiry")).toBe(true);
  });
});
