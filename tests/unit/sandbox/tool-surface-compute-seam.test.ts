/**
 * Tool-surface compute-seam adapter unit tests (WORK-051): the
 * module-side adapter over the REAL sandbox service (in-memory store,
 * REAL policy/capability admission fakes, the REAL ledger seam, the
 * REAL process provider) — every programmatic run is a fully
 * admitted + dispatched + journaled sandbox execution, the mechanical
 * evaluation runs INSIDE the dispatched sandbox process through the
 * generic runner shim, and the shim's closed semantics are pinned
 * against the platform evaluator kernel over a representative corpus
 * (the two implementations cannot drift silently).
 */

import { readFileSync, statSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createNodeDigest } from "../../../src/modules/planning/adapters/node-digest";
import { InMemorySandboxStore } from "../../../src/modules/sandbox/adapters/in-memory-sandbox-store";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { createToolSurfaceComputeSeam } from "../../../src/modules/sandbox/adapters/tool-surface-compute-seam";
import { createEnvironmentCatalog } from "../../../src/modules/sandbox/application/environment-catalog";
import { createSandboxService } from "../../../src/modules/sandbox/application/sandbox-service";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/domain/environment";
import { createSandboxProviderRegistry } from "../../../src/modules/sandbox/ports/sandbox-provider";
import { runProgrammaticExecution } from "../../../src/platform/tool-surface/executor";
import {
  evaluateProgrammaticSpec,
  ProgrammaticError,
  type ProgrammaticSpec,
  validateProgrammaticSpec,
} from "../../../src/platform/tool-surface/programmatic";
import type { ResultStepFacts } from "../../../src/platform/tool-surface/results";
import {
  ACTOR_ID,
  APPLICATION_ID,
  FakeCapabilityGate,
  FakeExecutionLedger,
  FakeSandboxAdmission,
  TENANT_ID,
} from "./fakes";

const nodeDigest = createNodeDigest();
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const ACTOR = { actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID };

const PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

const STEPS: readonly ResultStepFacts[] = [
  {
    stepId: "curate",
    stepClass: "transform",
    computationType: "deterministic",
    sideEffectClass: "pure",
  },
];

interface World {
  readonly service: ReturnType<typeof createSandboxService>;
  readonly environmentId: string;
  readonly ledger: FakeExecutionLedger;
  readonly store: InMemorySandboxStore;
  readonly admission: FakeSandboxAdmission;
  readonly capabilities: FakeCapabilityGate;
}

function world(): World {
  const store = new InMemorySandboxStore();
  const admission = new FakeSandboxAdmission();
  const capabilities = new FakeCapabilityGate();
  const ledger = new FakeExecutionLedger();
  const providers = createSandboxProviderRegistry();
  providers.register(new ProcessSandboxProvider());
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const service = createSandboxService({
    store,
    admission,
    capabilities: { resolve: capabilities.resolve },
    ledger,
    providers,
    generateId,
    now: () => new Date(),
  });
  return {
    service,
    ledger,
    store,
    admission,
    capabilities,
    environmentId: "pending",
  };
}

async function seededWorld(): Promise<World> {
  const w = world();
  w.ledger.seedExecution(EXECUTION_ID, "RUNNING");
  const catalog = createEnvironmentCatalog({
    store: w.store,
    generateId: () =>
      `00000000-0000-7000-8000-${String(Math.random()).slice(2, 14).padStart(12, "0")}`,
    now: () => new Date(),
    hashSpec: (canonical) => `digest:${canonical.length}`,
  });
  const record = await catalog.register(
    {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      slug: "programmatic-runtime",
      name: "Programmatic runtime",
      spec: PROCESS_SPEC,
    },
    `prog-env-${APPLICATION_ID}`,
    ACTOR,
  );
  return { ...w, environmentId: record.id };
}

function specOf(operation: string, params: Record<string, unknown>): ProgrammaticSpec {
  return validateProgrammaticSpec({
    specId: "curate-work",
    stepId: "curate",
    operation,
    params,
    bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
  });
}

describe("tool-surface compute seam over the real sandbox service (WORK-051)", () => {
  test("every programmatic run is a fully admitted, dispatched and journaled sandbox execution", async () => {
    const w = await seededWorld();
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    const result = await runProgrammaticExecution(
      {
        spec: specOf("filter", { field: "status", equals: "ok" }),
        input: {
          items: [
            { status: "ok", n: 1 },
            { status: "bad", n: 2 },
            { status: "ok", n: 3 },
          ],
        },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: w.environmentId,
          idempotencyKey: "prog-run-1",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      seam,
      nodeDigest,
    );
    expect(result.value).toEqual([
      { status: "ok", n: 1 },
      { status: "ok", n: 3 },
    ]);
    expect(result.provenance.sandboxId).not.toBeNull();
    // Durable evidence: the admitted + completed ledger envelopes and
    // the terminal sandbox row in the store.
    const events = w.ledger.eventsOf(EXECUTION_ID);
    expect(events.map((e) => e.event.command)).toEqual(["sandbox-admitted", "sandbox-completed"]);
    const record = await w.service.getSandbox(APPLICATION_ID, result.provenance.sandboxId ?? "");
    expect(record?.status).toBe("completed");
    expect(record?.outputDigest).toBe(result.provenance.outputDigest);
    // The task carried ONE argument: the content-addressed runner
    // file (the spec + input are EMBEDDED constants inside it — the
    // child reads no argv payload, no environment, no filesystem),
    // with NO ambient env entries. The digest-pinned path records
    // exactly which runner+payload content ran.
    expect(Object.keys(record?.runtimeMetadata.task.publicEnv ?? {})).toEqual([]);
    const runPath = record?.runtimeMetadata.task.args[0];
    expect(typeof runPath).toBe("string");
    expect(runPath).toMatch(/zeck-prog-run-[0-9a-f]{32}[\\/]run\.mjs$/);
    const runContent = readFileSync(String(runPath), "utf8");
    expect(runContent).toContain('"operation":"filter"');
    expect(runContent).toContain('"status":"ok"');
    // The run file is idempotent: a second run with the SAME crossing
    // content converges on the identical path (write-if-absent — the
    // file was not rewritten).
    const before = statSync(String(runPath));
    await runProgrammaticExecution(
      {
        spec: specOf("filter", { field: "status", equals: "ok" }),
        input: {
          items: [
            { status: "ok", n: 1 },
            { status: "bad", n: 2 },
            { status: "ok", n: 3 },
          ],
        },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: w.environmentId,
          idempotencyKey: "prog-run-1-again",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      seam,
      nodeDigest,
    );
    expect(statSync(String(runPath)).mtimeMs).toBe(before.mtimeMs);
  });

  test("the same idempotency key replays the same durable outcome (no re-execution)", async () => {
    const w = await seededWorld();
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    const input = {
      spec: specOf("aggregate", { metric: "sum", field: "n" }),
      input: { items: [{ n: 1 }, { n: 2 }, { n: 3.5 }] },
      scope: {
        executionId: EXECUTION_ID,
        environmentId: w.environmentId,
        idempotencyKey: "prog-replay",
        actor: ACTOR,
      },
      surfaceId: null,
      steps: STEPS,
    };
    const first = await runProgrammaticExecution(input, seam, nodeDigest);
    const second = await runProgrammaticExecution(input, seam, nodeDigest);
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(second.provenance.sandboxId).toBe(first.provenance.sandboxId);
    // Exactly one sandbox row and exactly two ledger envelopes (the
    // replays converge on the committed row).
    const rows = await w.service.listSandboxesByExecution(APPLICATION_ID, EXECUTION_ID);
    expect(rows).toHaveLength(1);
  });

  test("admission denial surfaces as the typed sandbox-denied outcome", async () => {
    const w = await seededWorld();
    w.admission.decide({ allowed: false, reason: "denied by test policy" });
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    let caught: unknown;
    try {
      await runProgrammaticExecution(
        {
          spec: specOf("filter", { field: "status", equals: "ok" }),
          input: { items: [] },
          scope: {
            executionId: EXECUTION_ID,
            environmentId: w.environmentId,
            idempotencyKey: "prog-denied",
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProgrammaticError);
    expect((caught as ProgrammaticError).code).toBe("sandbox-denied");
    // The durable denial row + envelope exist (journal-then-fail).
    const rows = await w.service.listSandboxesByExecution(APPLICATION_ID, EXECUTION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("denied");
    const events = w.ledger.eventsOf(EXECUTION_ID);
    expect(events.map((e) => e.event.command)).toEqual(["sandbox-denied"]);
  });

  test("the wall-clock bound must be covered by the environment's admitted timeout", async () => {
    const w = await seededWorld();
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    const longSpec = validateProgrammaticSpec({
      specId: "curate-work",
      stepId: "curate",
      operation: "filter",
      params: { field: "status", equals: "ok" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 60_000 },
    });
    await expect(
      seam.runProgrammaticWork({
        scope: {
          executionId: EXECUTION_ID,
          environmentId: w.environmentId,
          idempotencyKey: "prog-timeout",
          actor: ACTOR,
        },
        spec: longSpec,
        input: { items: [] },
      }),
    ).rejects.toThrow();
  });

  test("the runner shim evaluates the closed vocabulary identically to the platform kernel (drift pinning)", async () => {
    const w = await seededWorld();
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    const corpus: readonly {
      readonly spec: ProgrammaticSpec;
      readonly items: readonly unknown[];
    }[] = [
      {
        spec: specOf("fan-out", {}),
        items: ["a", { b: 1 }, null, 42],
      },
      {
        spec: specOf("filter", { field: "status", equals: "ok" }),
        items: [
          { status: "ok", n: 1 },
          { status: "bad", n: 2 },
          "not-a-record",
          { status: "ok", n: 3 },
          null,
        ],
      },
      {
        spec: specOf("filter", { field: "flag", equals: true }),
        items: [{ flag: true }, { flag: false }, { flag: true }],
      },
      {
        spec: specOf("aggregate", { metric: "count" }),
        items: [1, 2, 3],
      },
      {
        spec: specOf("aggregate", { metric: "sum", field: "n" }),
        items: [{ n: 1.5 }, { n: 2 }, { n: 0.5 }],
      },
      {
        spec: specOf("projection", { fields: ["a", "c"] }),
        items: [
          { a: 1, b: 2, c: 3 },
          { a: 4, c: 5 },
        ],
      },
      {
        // Chunked crossing: an input large enough to span multiple argv
        // chunks (deterministic chunking + shim re-assembly).
        spec: specOf("filter", { field: "k", equals: "yes" }),
        items: Array.from({ length: 40 }, (_, i) => ({
          k: i % 2 === 0 ? "yes" : "no",
          pad: "x".repeat(200),
        })),
      },
    ];
    let key = 0;
    for (const entry of corpus) {
      key += 1;
      const kernel = evaluateProgrammaticSpec(entry.spec, { items: entry.items });
      const result = await runProgrammaticExecution(
        {
          spec: entry.spec,
          input: { items: entry.items },
          scope: {
            executionId: EXECUTION_ID,
            environmentId: w.environmentId,
            idempotencyKey: `prog-corpus-${key}`,
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      );
      expect(result.value).toEqual(kernel.value as unknown);
    }
  });

  test("a bound violation inside the sandbox process surfaces as the typed closed code", async () => {
    const w = await seededWorld();
    const seam = createToolSurfaceComputeSeam({
      service: w.service,
      catalog: makeCatalog(w),
      options: { environmentId: w.environmentId, runnerCommand: process.execPath },
    });
    // maxIterations: 2 with 3 items → the shim reports
    // iteration-exceeded as a typed envelope (the process exits 0; the
    // executor maps the closed code).
    const tight = validateProgrammaticSpec({
      specId: "curate-work",
      stepId: "curate",
      operation: "fan-out",
      params: {},
      bounds: { maxInputItems: 64, maxIterations: 2, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    let caught: unknown;
    try {
      await runProgrammaticExecution(
        {
          spec: tight,
          input: { items: [1, 2, 3] },
          scope: {
            executionId: EXECUTION_ID,
            environmentId: w.environmentId,
            idempotencyKey: "prog-tight",
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProgrammaticError);
    expect((caught as ProgrammaticError).code).toBe("iteration-exceeded");
    // The sandbox row itself COMPLETED honestly (the runner worked; the
    // work failed its bounds) — the typed programmatic error carries
    // the decision, the durable evidence carries the run.
    const rows = await w.service.listSandboxesByExecution(APPLICATION_ID, EXECUTION_ID);
    expect(rows[rows.length - 1]?.status).toBe("completed");
  });
});

/** A minimal catalog view over the in-memory store for the seam. */
function makeCatalog(w: World) {
  return {
    async get(applicationId: string, environmentId: string) {
      return w.store.findEnvironment(applicationId, environmentId);
    },
  } as unknown as Parameters<typeof createToolSurfaceComputeSeam>[0]["catalog"];
}
