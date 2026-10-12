/**
 * The validation lab's seam surface freeze (PCS-001 — the shared
 * re-export surface at benchmarks/validation/apps/shared/seam.ts).
 *
 * THE SEAM LAW, proven mechanically:
 *  - the surface exports EXACTLY the documented helper set (values AND
 *    types) — widening it is a work-order decision, never ambient: the
 *    source-level freeze fails on any added or removed name;
 *  - drift is a TYPED failure: the exact-shape assertion below breaks
 *    `bun run typecheck` when the seam gains or loses any value export,
 *    and every type re-export is pinned type-identical to its origin;
 *  - re-exports ONLY: every value binding IS the origin module's own
 *    (reference-identical — no logic moves, no copies, no new behavior);
 *  - the evaluation app consumes the seam: no four-level
 *    `experiments/ppr-027/...` deep paths remain in its import
 *    specifiers (import-path migration only — the PCR-003 suites prove
 *    the zero runtime-behavior drift).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, test } from "vitest";
import type {
  ExperimentRecoveryPlanInputs as SeamExperimentRecoveryPlanInputs,
  ExperimentStack as SeamExperimentStack,
  ModalityKind as SeamModalityKind,
  RequestRecord as SeamRequestRecord,
  SubjectDefinition as SeamSubjectDefinition,
  SubjectEdge as SeamSubjectEdge,
  VolumeKind as SeamVolumeKind,
  WorkloadRequest as SeamWorkloadRequest,
} from "../../../benchmarks/validation/apps/shared/seam";
import * as seam from "../../../benchmarks/validation/apps/shared/seam";
import {
  composeExperimentStack,
  type ExperimentRecoveryPlanInputs,
  type ExperimentStack,
} from "../../../experiments/ppr-027/compose";
import {
  edgeOf,
  type ModalityKind,
  type SubjectDefinition,
  type SubjectEdge,
  type VolumeKind,
  type WorkloadRequest,
} from "../../../experiments/ppr-027/config";
import {
  baselineTasksOf,
  buildCellCorpus,
  createDirectBaselineExecutor,
  createExperimentDriver,
  createOptimizedBaselineExecutor,
  type RequestRecord,
} from "../../../experiments/ppr-027/driver";
import { allSweepCells, experimentTraceSource } from "../../../experiments/ppr-027/sweep";
import {
  createSyntheticSupply,
  drawnFault,
  outcomeOf,
} from "../../../experiments/ppr-027/transport";

/** The documented helper set — the wired seam plus the read-only evaluation
 * companions the repository's evaluation applications actually consume. */
const DOCUMENTED_SEAM_SURFACE: readonly string[] = [
  // from experiments/ppr-027/compose — the ONE wired seam file
  "composeExperimentStack",
  "ExperimentRecoveryPlanInputs",
  "ExperimentStack",
  // from experiments/ppr-027/config — read-only evaluation companions
  "ModalityKind",
  "SubjectDefinition",
  "SubjectEdge",
  "VolumeKind",
  "WorkloadRequest",
  "edgeOf",
  // from experiments/ppr-027/driver — executor factories and corpus builders
  "baselineTasksOf",
  "buildCellCorpus",
  "createDirectBaselineExecutor",
  "createExperimentDriver",
  "createOptimizedBaselineExecutor",
  "RequestRecord",
  // from experiments/ppr-027/sweep
  "allSweepCells",
  "experimentTraceSource",
  // from experiments/ppr-027/transport
  "createSyntheticSupply",
  "drawnFault",
  "outcomeOf",
];

/** The value half of the surface (types are erased at runtime). */
const DOCUMENTED_SEAM_VALUES: readonly string[] = [
  "allSweepCells",
  "baselineTasksOf",
  "buildCellCorpus",
  "composeExperimentStack",
  "createDirectBaselineExecutor",
  "createExperimentDriver",
  "createOptimizedBaselineExecutor",
  "createSyntheticSupply",
  "drawnFault",
  "edgeOf",
  "experimentTraceSource",
  "outcomeOf",
];

const SEAM_MODULE_PATH = join(process.cwd(), "benchmarks/validation/apps/shared/seam.ts");

describe("the seam surface freeze (drift is a typed failure)", () => {
  test("the runtime value surface is exactly the documented set", () => {
    expect(Object.keys(seam).sort()).toEqual([...DOCUMENTED_SEAM_VALUES].sort());
  });

  test("the typed value surface is exactly the documented shape (typecheck gate)", () => {
    // This assertion is a NO-OP at runtime; it exists for `bun run
    // typecheck`: gaining or losing (or retyping) ANY value export of the
    // seam breaks the typecheck gate — the typed freeze. (The shape is
    // non-readonly: expect-type's strict identity sees module-namespace
    // members as non-readonly.)
    expectTypeOf(seam).toEqualTypeOf<{
      allSweepCells: typeof allSweepCells;
      baselineTasksOf: typeof baselineTasksOf;
      buildCellCorpus: typeof buildCellCorpus;
      composeExperimentStack: typeof composeExperimentStack;
      createDirectBaselineExecutor: typeof createDirectBaselineExecutor;
      createExperimentDriver: typeof createExperimentDriver;
      createOptimizedBaselineExecutor: typeof createOptimizedBaselineExecutor;
      createSyntheticSupply: typeof createSyntheticSupply;
      drawnFault: typeof drawnFault;
      edgeOf: typeof edgeOf;
      experimentTraceSource: typeof experimentTraceSource;
      outcomeOf: typeof outcomeOf;
    }>();
  });

  test("every type re-export is type-identical to its origin (the seam adds no types of its own)", () => {
    expectTypeOf<SeamExperimentRecoveryPlanInputs>().toEqualTypeOf<ExperimentRecoveryPlanInputs>();
    expectTypeOf<SeamExperimentStack>().toEqualTypeOf<ExperimentStack>();
    expectTypeOf<SeamModalityKind>().toEqualTypeOf<ModalityKind>();
    expectTypeOf<SeamSubjectDefinition>().toEqualTypeOf<SubjectDefinition>();
    expectTypeOf<SeamSubjectEdge>().toEqualTypeOf<SubjectEdge>();
    expectTypeOf<SeamVolumeKind>().toEqualTypeOf<VolumeKind>();
    expectTypeOf<SeamWorkloadRequest>().toEqualTypeOf<WorkloadRequest>();
    expectTypeOf<SeamRequestRecord>().toEqualTypeOf<RequestRecord>();
  });

  test("the module source exports exactly the documented names — widening is never ambient", () => {
    const source = readFileSync(SEAM_MODULE_PATH, "utf8");
    const names = new Set<string>();
    for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
      for (const specifier of (block[1] ?? "").split(",")) {
        const name =
          specifier
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0] ?? "";
        if (name.length > 0) {
          names.add(name);
        }
      }
    }
    expect([...names].sort()).toEqual([...DOCUMENTED_SEAM_SURFACE].sort());
    // Re-exports ONLY — no logic ever lives in the seam (no declarations,
    // no assignments: the module is export-from statements and comments).
    expect(source).not.toMatch(/^(export\s+)?(async\s+)?function\s/m);
    expect(source).not.toMatch(/^(export\s+)?(const|let|var|class|interface|enum)\s/m);
    expect(source).not.toMatch(/^type\s+\w+\s*=/m);
  });

  test("every value re-export IS the origin's own binding (reference identity, never a copy)", () => {
    expect(seam.composeExperimentStack).toBe(composeExperimentStack);
    expect(seam.edgeOf).toBe(edgeOf);
    expect(seam.baselineTasksOf).toBe(baselineTasksOf);
    expect(seam.buildCellCorpus).toBe(buildCellCorpus);
    expect(seam.createDirectBaselineExecutor).toBe(createDirectBaselineExecutor);
    expect(seam.createExperimentDriver).toBe(createExperimentDriver);
    expect(seam.createOptimizedBaselineExecutor).toBe(createOptimizedBaselineExecutor);
    expect(seam.allSweepCells).toBe(allSweepCells);
    expect(seam.experimentTraceSource).toBe(experimentTraceSource);
    expect(seam.createSyntheticSupply).toBe(createSyntheticSupply);
    expect(seam.drawnFault).toBe(drawnFault);
    expect(seam.outcomeOf).toBe(outcomeOf);
  });
});

describe("the evaluation app consumes the seam (the import migration)", () => {
  test("no four-level experiments/ppr-027 deep paths remain in the app's import specifiers", () => {
    const appDir = join(
      process.cwd(),
      "benchmarks/validation/apps/economic-recovery-plan-evaluation",
    );
    const migrated: readonly string[] = [
      "driver.ts",
      "corpus.ts",
      "canonical.ts",
      "fixtures.ts",
      "governed-ir.ts",
    ];
    const offenders: string[] = [];
    for (const file of readdirSync(appDir, { withFileTypes: true })) {
      if (!file.name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(appDir, file.name), "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (specifier.includes("experiments/ppr-027")) {
          offenders.push(`${file.name}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    for (const file of migrated) {
      const text = readFileSync(join(appDir, file), "utf8");
      expect(text, file).toContain('from "../shared/seam"');
    }
  });
});
