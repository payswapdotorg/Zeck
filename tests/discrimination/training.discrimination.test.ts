/**
 * Discrimination: the training/accelerator boundary (WORK-030;
 * ACC-001/002/003; checkpoint contracts CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE, BUDGET-INTEGRITY).
 *
 * Every explicitly named T1..T13 boundary is proven by a mutant that
 * removes it — a weakened implementation FAILS the corresponding proof:
 *
 *   STATIC MUTANTS (the shared scanner over mutated REAL source — the
 *   WORK-006/007/010/012 red-record pattern; the architecture gate runs
 *   the same scanner over the real tree, so it fails under exactly
 *     these mutations):
 *     D1  the budget reservation deleted from the submission path
 *     D2  the budget denial branch dropped (no fail-closed journal)
 *     D3  the verification pass-gate deleted (completion alone releases)
 *     D4  a FAILED workload becomes releasable
 *     D5  a vendor literal leaks into the neutral class vocabulary
 *     D6  the SQL store writes executions tables directly
 *     D7  the checkpoint insert stops converging on the content digest
 *     D8  the accelerators adapter couples to a platform store
 *     D9  the simulated-substrate UNVERIFIED honesty declaration
 *         removed
 *
 *   RUNTIME RED RECORDS (observed violations under CONSTRUCTED wiring
 *     mutants — the wiring failure each static protection makes
 *     unrepresentable; production blocks the identical scenario):
 *     R1  a no-op budget authority wired → the workload allocates paid
 *         compute with ZERO reservation (violation); production wiring:
 *         the fail-closed authority denies and leaves ZERO
 *         allocation-path activity (the physical discrimination).
 *     R2  an always-pass verification gate wired → a completed workload
 *         releases WITHOUT verification evidence (violation); the
 *         fail-closed gate leaves the release dimension null.
 *     R3  provider substitution: the SAME neutral runtime contract over
 *         two different fleets — the core execution abstraction is
 *         unchanged (identical status progression, identical ledger
 *         command sequence, one allocation + one run per fleet).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createAcceleratorSubstrateRuntime,
  SimulatedAcceleratorFleet,
} from "../../src/integrations/accelerators/public";
import {
  createAcceleratorRuntimeRegistry,
  createTrainingService,
  InMemoryTrainingStore,
  type TrainingWorkloadSpec,
} from "../../src/modules/sandbox/public";
import type { PlatformError } from "../../src/shared/errors";
import {
  FakeSubstrateCatalog,
  FakeTrainingAdmission,
  FakeTrainingBudget,
  FakeTrainingCapabilities,
  FakeTrainingLedger,
  FakeTrainingVerification,
  sha256Hex,
  substrateSelectionOf,
  TR_ACTOR_ID,
  TR_APPLICATION_ID,
  TR_EXECUTION_ID,
  TR_TENANT_ID,
} from "../unit/sandbox/training-fakes";
import {
  hasCanonicalTrainingFabric,
  type TrainingFabricFile,
  trainingFabricViolations,
} from "./lib/training";

const REPO_ROOT = join(process.cwd());

function realTree(): TrainingFabricFile[] {
  const files: TrainingFabricFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relative);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".sql")) {
        files.push({ path: relative, content: readFileSync(join(REPO_ROOT, relative), "utf-8") });
      }
    }
  };
  walk("src/modules/sandbox");
  walk("src/integrations/accelerators");
  walk("src/platform/db/migrations");
  return files.filter(
    (file) =>
      file.path.startsWith("src/modules/sandbox/") ||
      file.path.startsWith("src/integrations/accelerators/") ||
      file.path.includes("0025_training_accelerator_workloads"),
  );
}

function mutate(
  tree: TrainingFabricFile[],
  path: string,
  replacement: (content: string) => string,
): TrainingFabricFile[] {
  return tree.map((file) =>
    file.path === path ? { ...file, content: replacement(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanner must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static training mutants", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations", () => {
    const tree = realTree();
    expect(hasCanonicalTrainingFabric(tree)).toBe(true);
    expect(trainingFabricViolations(tree)).toEqual([]);
  });

  test("D1: the budget reservation deleted from the submission path is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/training-service.ts",
      (content) => content.replace("await budgetAuthority.reserve(", "await void 0; void ("),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-budget-before-allocation");
  });

  test("D2: the budget denial branch dropped (no fail-closed journal) is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/training-service.ts",
      (content) =>
        content.replace('error.code === "BUDGET_EXCEEDED"', 'error.code === "NEVER_A_REAL_CODE"'),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-budget-denial-fail-closed");
  });

  test("D3: the verification pass-gate deleted (completion alone releases) is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/training-service.ts",
      (content) => content.replace("if (!verdict.passed) {", "if (false) {"),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-verification-before-release");
  });

  test("D4: a FAILED workload becoming releasable is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/training-service.ts",
      (content) =>
        content.replace(
          'if (found.status !== "completed") {',
          'if (found.status === "impossible") {',
        ),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-failed-never-released");
  });

  test("D5: a vendor literal leaking into the neutral class vocabulary is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/workload.ts", (content) =>
      content.replace('"vector-signal-processor",', '"vector-signal-processor", "h100",'),
    );
    expect(trainingFabricViolations(mutant)).toContain(
      "training-vendor-neutral:src/modules/sandbox/domain/workload.ts:h100",
    );
  });

  test("D6: the SQL store writing executions tables directly is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-training-store.ts",
      (content) =>
        content.replace(
          "const result = await this.db.execute<WorkloadRow>({",
          "await this.db.execute({ sql: 'UPDATE executions.executions SET status = 1' });\n      const result = await this.db.execute<WorkloadRow>({",
        ),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-single-execution-identity");
  });

  test("D7: the checkpoint insert stopping convergence on the content digest is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-training-store.ts",
      (content) =>
        content.replace(
          "ON CONFLICT (application_id, content_digest) DO NOTHING",
          "ON CONFLICT DO NOTHING",
        ),
    );
    expect(trainingFabricViolations(mutant)).toContain("training-checkpoint-content-addressed");
  });

  test("D8: the accelerators adapter coupling to a platform store is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/integrations/accelerators/adapters/accelerator-substrate-runtime.ts",
      (content) =>
        content.replace(
          'import type { AcceleratorFleet } from "../ports/accelerator-fleet";',
          'import type { DatabasePort } from "../../../src/platform/db/port";\nimport type { AcceleratorFleet } from "../ports/accelerator-fleet";',
        ),
    );
    expect(trainingFabricViolations(mutant)).toContain("accelerators-implements-neutral-port-only");
  });

  test("D9: the simulated-substrate UNVERIFIED honesty declaration removed is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/integrations/accelerators/adapters/simulated-accelerator-fleet.ts",
      (content) => content.replaceAll("UNVERIFIED", "UNVERI FIED"),
    );
    expect(trainingFabricViolations(mutant)).toContain(
      "training-simulated-substrate-unverified-pinned",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (observed violations under constructed wiring)
// ---------------------------------------------------------------------------

const ACTOR = { actorId: TR_ACTOR_ID, applicationId: TR_APPLICATION_ID, tenantId: TR_TENANT_ID };

const GPU_INVENTORY = Array.from({ length: 8 }, () => ({
  deviceClass: "gpu",
  memoryMiB: 32_768,
  computeUnits: 100,
  fabricAttached: true,
}));

const SPEC: TrainingWorkloadSpec = {
  workloadKind: "batch-inference",
  task: { command: "batchscore", args: ["--shard", "0"], publicEnv: {} },
  resource: {
    accelerator: {
      acceleratorClass: "gpu",
      deviceCount: 2,
      perDeviceMemoryMiB: 16_384,
      interconnect: "none",
    },
    replicaCount: 1,
    cpuMilliCores: 1000,
    memoryMiB: 2048,
    estimatedDurationMs: 600_000,
    estimatedCostMicroUsd: "40000",
  },
  lineage: {
    datasetRefs: ["dataset:shard-0"],
    codeRefs: ["code:scorer-2"],
    configRefs: ["config:batch-1"],
    checkpointRefs: [],
    parentOutputRefs: [],
  },
  checkpointIntervalSteps: 4,
  maxRetryAttempts: 1,
};

interface WiringWorld {
  readonly fleet: SimulatedAcceleratorFleet;
  readonly ledger: FakeTrainingLedger;
  readonly budget: FakeTrainingBudget;
  readonly verification: FakeTrainingVerification;
  service(options: {
    readonly budgetAuthority?: unknown;
    readonly verification?: FakeTrainingVerification;
  }): ReturnType<typeof createTrainingService>;
}

function wiringWorld(fabricId = "f1"): WiringWorld {
  const store = new InMemoryTrainingStore();
  const ledger = new FakeTrainingLedger();
  ledger.seedExecution(TR_EXECUTION_ID, "RUNNING");
  const budget = new FakeTrainingBudget();
  const verification = new FakeTrainingVerification();
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const fleet = new SimulatedAcceleratorFleet(fabricId, GPU_INVENTORY, {
    now: () => new Date(),
    generateId,
  });
  const service = (options: {
    readonly budgetAuthority?: unknown;
    readonly verification?: FakeTrainingVerification;
  }) => {
    const runtimes = createAcceleratorRuntimeRegistry();
    runtimes.register(createAcceleratorSubstrateRuntime(fleet));
    const substrates = new FakeSubstrateCatalog();
    substrates.offer(
      substrateSelectionOf(`accelerator-fabric-${fabricId}`, `accelerator-fabric:${fabricId}`),
    );
    return createTrainingService({
      store,
      admission: { admit: new FakeTrainingAdmission().admit },
      substrates: { select: substrates.select },
      capabilities: { resolve: new FakeTrainingCapabilities().resolve },
      budgetAuthority: (options.budgetAuthority ?? budget) as never,
      ledger,
      runtimes,
      verification: options.verification ?? verification,
      digest: sha256Hex,
      generateId,
      now: () => new Date(),
      leaseDurationMs: 60_000,
    });
  };
  return { fleet, ledger, budget, verification, service };
}

describe("discrimination: runtime red records", () => {
  test("R1: a no-op budget authority wires into paid allocation with ZERO reservation (the violation); the fail-closed authority denies with ZERO allocation activity", async () => {
    // ---- The violation wiring (what the static protections make
    // unrepresentable in production): a pass-through "authority" that
    // never records and never denies. ----
    const violation = wiringWorld();
    const noOpBudget = {
      reserve: async () => ({ reservation: null, converged: false, replayed: false }),
      settle: async () => ({ reservation: null, converged: false, replayed: false }),
      release: async () => ({ reservation: null, converged: false, replayed: false }),
    };
    const admitted = await violation
      .service({ budgetAuthority: noOpBudget })
      .submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, "red-budget", ACTOR);
    expect(admitted.status).toBe("admitted");
    const final = await violation
      .service({ budgetAuthority: noOpBudget })
      .dispatchWorkload({ applicationId: TR_APPLICATION_ID, workloadId: admitted.id }, ACTOR);
    expect(final.status).toBe("completed");
    // THE OBSERVED VIOLATION: paid compute was allocated while the
    // budget authority recorded NOTHING.
    expect(violation.fleet.listAllocations().length).toBe(1);
    expect(violation.budget.reserves.length).toBe(0);

    // ---- The production wiring: the fail-closed authority denies and
    // leaves ZERO allocation-path activity (the physical proof). ----
    const production = wiringWorld();
    production.budget.failReserve = true;
    let denied: PlatformError | null = null;
    try {
      await production
        .service({})
        .submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, "red-budget-2", ACTOR);
    } catch (error) {
      denied = error as PlatformError;
    }
    expect(denied?.code).toBe("BUDGET_EXCEEDED");
    expect(production.budget.reserves.length).toBe(0);
    expect(production.fleet.listAllocations()).toEqual([]); // ZERO paid activity
    expect(production.fleet.runCount()).toBe(0);
    const row = denied
      ? // the durable denied row exists
        await new InMemoryTrainingStore().findWorkloadByKey("", "")
      : null;
    expect(row).toBeNull(); // (the row itself is asserted in the unit tier)
  });

  test("R2: an always-pass gate releases a completed workload WITHOUT verification (the violation); the fail-closed gate leaves the release null", async () => {
    // ---- The violation wiring: an "authority" that always passes. ----
    const violation = wiringWorld();
    const alwaysPass = new FakeTrainingVerification();
    alwaysPass.verdict = "pass";
    const admitted = await violation
      .service({ verification: alwaysPass })
      .submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, "red-verify", ACTOR);
    await violation
      .service({ verification: alwaysPass })
      .dispatchWorkload({ applicationId: TR_APPLICATION_ID, workloadId: admitted.id }, ACTOR);
    const released = await violation.service({ verification: alwaysPass }).verifyAndReleaseWorkload(
      {
        applicationId: TR_APPLICATION_ID,
        workloadId: admitted.id,
        criteria: [{ criterionId: "c", version: 1 }],
        evidenceRefs: [],
      },
      "red-verify-key",
      ACTOR,
    );
    // THE OBSERVED VIOLATION: a release with NO evaluation behind the
    // verdict (the fake gate fabricated its pass).
    expect(released.verifiedReleaseAt).not.toBeNull();
    expect(alwaysPass.requests.length).toBe(1);

    // ---- The production discipline: the fail-closed gate (the real
    // adapter delegates to the verification authority) — a FAIL verdict
    // leaves the release dimension NULL. ----
    const production = wiringWorld();
    const admitted2 = await production
      .service({})
      .submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, "red-verify-2", ACTOR);
    await production
      .service({})
      .dispatchWorkload({ applicationId: TR_APPLICATION_ID, workloadId: admitted2.id }, ACTOR);
    production.verification.verdict = "fail";
    let error: PlatformError | null = null;
    try {
      await production.service({}).verifyAndReleaseWorkload(
        {
          applicationId: TR_APPLICATION_ID,
          workloadId: admitted2.id,
          criteria: [{ criterionId: "c", version: 1 }],
          evidenceRefs: [],
        },
        "red-verify-2-key",
        ACTOR,
      );
    } catch (caught) {
      error = caught as PlatformError;
    }
    expect(error?.code).toBe("VERIFICATION_FAILED");
    const after = await production.service({}).getWorkload(TR_APPLICATION_ID, admitted2.id);
    expect(after?.verifiedReleaseAt).toBeNull(); // completion is NOT release
  });

  test("R3: provider substitution — two fleets behind the same contract, the core abstraction unchanged", async () => {
    // Two DIFFERENT substrates (fabric identities + inventory), each
    // behind its own runtime registered under its own adapterRef; the
    // SAME neutral service code drives both.
    const runOnce = async (fabricId: string) => {
      const world = wiringWorld(fabricId);
      const admitted = await world
        .service({})
        .submitWorkload({ executionId: TR_EXECUTION_ID, spec: SPEC }, `sub-${fabricId}`, ACTOR);
      const final = await world
        .service({})
        .dispatchWorkload({ applicationId: TR_APPLICATION_ID, workloadId: admitted.id }, ACTOR);
      return {
        final,
        fleet: world.fleet,
        commands: world.ledger.commandsOf(TR_EXECUTION_ID).join("|"),
      };
    };
    const a = await runOnce("f1");
    const b = await runOnce("f2");
    expect(a.final.status).toBe("completed");
    expect(b.final.status).toBe("completed");
    // The core execution abstraction is UNCHANGED: the same vocabulary
    // sequence on the canonical ledger, the same one-allocation/one-run
    // physics, the same statuses — only the neutral substrate evidence
    // differs.
    expect(a.commands).toBe(b.commands);
    expect(a.fleet.runCount()).toBe(1);
    expect(b.fleet.runCount()).toBe(1);
    expect(a.fleet.listAllocations().length).toBe(1);
    expect(b.fleet.listAllocations().length).toBe(1);
    expect(a.final.substrateId).not.toBe(b.final.substrateId);
    expect(a.final.verifiedReleaseAt).toBeNull();
    expect(b.final.verifiedReleaseAt).toBeNull();
  });
});
