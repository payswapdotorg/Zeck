/**
 * Real-PostgreSQL — the tool-surface programmatic-execution durable
 * semantics, complementary battery (WORK-051; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, EXECUTION-PROVENANCE, SANDBOX-BOUNDARY,
 * CONCURRENCY-CRASH-SAFETY, POLICY-BEFORE-DISPATCH).
 *
 * The sibling suite (`tool-surface.test.ts`) proves the full stage-3
 * chain, the real-process runs and the derivation/N=8 convergence.
 * THIS battery adds the durable-outcome semantics the chain must
 * honor after the first run:
 *
 *  - DURABLE IDEMPOTENCY: the same idempotency key replays the same
 *    durable outcome (one sandbox row, no re-execution, byte-stable
 *    result digest);
 *  - CONCURRENCY-CRASH-SAFETY (the honest §14 semantics): N=8
 *    SIMULTANEOUS programmatic runs of the SAME logical run (one
 *    idempotency key, one identical request) converge with no torn or
 *    duplicated durable effects — exactly ONE completed durable row,
 *    exactly one admitted + completed ledger envelope pair, ONE
 *    successful outcome (the winner's durable truth) and every loser
 *    surfacing the TYPED `non-convergent` fail-closed outcome (the
 *    sandbox authority's own §14 discipline, mapped through the seam
 *    as an observation — never a raw escape, never a fabricated
 *    success), and the replay AFTER the terminal state converging on
 *    the same durable outcome;
 *  - POLICY-BEFORE-DISPATCH: a policy-denied programmatic run is
 *    journal-then-fail durable evidence (a durable denied row + a
 *    sandbox-denied envelope; the executor surfaces the typed
 *    sandbox-denied outcome — programmatic execution can never bypass
 *    the admission chain).
 */
import { expect, test } from "vitest";
import { createIrPlanSource } from "../../../src/modules/planning/adapters/ir-plan-source";
import { createNodeDigest } from "../../../src/modules/planning/adapters/node-digest";
import { buildPlan } from "../../../src/modules/planning/public";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { createToolSurfaceComputeSeam } from "../../../src/modules/sandbox/adapters/tool-surface-compute-seam";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import type { ToolSurfaceConfig } from "../../../src/platform/tool-surface/catalog";
import { deriveToolSurface } from "../../../src/platform/tool-surface/derive";
import { runProgrammaticExecution } from "../../../src/platform/tool-surface/executor";
import { ProgrammaticError } from "../../../src/platform/tool-surface/programmatic";
import type { ResultStepFacts } from "../../../src/platform/tool-surface/results";
import { definePgSuite } from "./harness";
import { type SandboxPgWorld, seedSandboxWorld } from "./sandbox-world";

const digest = createNodeDigest();
const planSource = createIrPlanSource();

/** The governed plan: two declared tool needs + one mechanical declaration. */
function governedIrOfWorld() {
  const plan = buildPlan(
    {
      revision: 3,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "call-tool", capabilityId: "web-retrieval" },
        {
          id: "curate",
          stepClass: "transform",
          config: {
            programmatic: {
              specId: "curate-filter",
              stepId: "curate",
              operation: "filter",
              params: { field: "status", equals: "ok" },
              bounds: {
                maxInputItems: 64,
                maxIterations: 512,
                maxOutputBytes: 8192,
                wallClockMs: 5000,
              },
            },
          },
        },
        { id: "parse", stepClass: "call-tool", capabilityId: "parsing" },
      ],
      edges: [
        { from: "fetch", to: "curate" },
        { from: "curate", to: "parse" },
      ],
    },
    (value) => digest.sha256Hex(canonicalJson(value)),
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
}

/** The governing constraint mirrors (capability + policy facts, read-only). */
function governingConstraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "capability-satisfaction",
      kind: "capability",
      enforcement: "hard",
      source: { authority: "capability", catalogRevision: "rev-1" },
      payload: { satisfiedIds: ["web-retrieval", "parsing"], unmetIds: [] },
    },
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "default" },
      payload: { providerModel: { allowedProviders: ["rail-a"] } },
    },
  ];
}

function surfaceConfig(): ToolSurfaceConfig {
  return {
    configSchema: 1,
    mcpEnabled: false,
    programmaticEnabled: true,
    bindings: [
      {
        toolId: "web-retrieval",
        representations: { direct: { typed: true }, cli: { command: "fetch-cli" } },
      },
      {
        toolId: "parsing",
        representations: { direct: { typed: true }, mcp: { server: "tools-mcp" } },
      },
    ],
  };
}

const STEPS: readonly ResultStepFacts[] = [
  {
    stepId: "curate",
    stepClass: "transform",
    computationType: "deterministic",
    sideEffectClass: "pure",
  },
];

interface ToolSurfacePgWorld {
  readonly world: SandboxPgWorld;
  readonly executionId: string;
  readonly environmentId: string;
}

async function seedToolSurfaceWorld(
  port: Parameters<typeof seedSandboxWorld>[0],
): Promise<ToolSurfacePgWorld> {
  const world = await seedSandboxWorld(port);
  world.registerProvider(new ProcessSandboxProvider());
  const environmentId = await world.registerEnvironment("programmatic-runtime", {
    kind: "process",
    limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
    network: { egress: "none", allowedHosts: [] },
    filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
    secrets: { secretRefs: [] },
    runtime: { capabilityId: "process-sandbox" },
    cost: { estimatedCostMicroUsd: "0" },
  });
  const executionId = await world.seedExecution("RUNNING");
  return { world, executionId, environmentId };
}

function seamOf(seed: ToolSurfacePgWorld) {
  return createToolSurfaceComputeSeam({
    service: seed.world.service,
    catalog: seed.world.catalog,
    options: { environmentId: seed.environmentId, runnerCommand: process.execPath },
  });
}

definePgSuite("tool-surface programmatic execution (real PostgreSQL)", (ctx) => {
  test("durable idempotency: the same idempotency key replays the same durable outcome (no re-execution)", async () => {
    const seed = await seedToolSurfaceWorld(ctx.port);
    const seam = seamOf(seed);
    const ir = governedIrOfWorld();
    const surface = deriveToolSurface({
      ir,
      constraints: governingConstraints(),
      config: surfaceConfig(),
      digest,
    });
    const decision = surface.programmatic.find((entry) => entry.stepId === "curate");
    const input = {
      spec: decision?.spec as never,
      input: { items: [{ status: "ok", n: 1 }, { status: "bad" }] },
      scope: {
        executionId: seed.executionId,
        environmentId: seed.environmentId,
        idempotencyKey: "pg-prog-replay",
        actor: seed.world.actor(),
      },
      surfaceId: surface.surfaceId,
      steps: STEPS,
    };
    const first = await runProgrammaticExecution(input, seam, digest);
    const second = await runProgrammaticExecution(input, seam, digest);
    // The replay converges on the SAME durable outcome.
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(second.provenance.sandboxId).toBe(first.provenance.sandboxId);
    expect(second.value).toEqual(first.value);
    // Exactly ONE durable sandbox row for the idempotency key.
    const rows = await seed.world.service.listSandboxesByExecution(
      seed.world.applicationId,
      seed.executionId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
  });

  test("CONCURRENCY-CRASH-SAFETY: N=8 simultaneous programmatic runs converge with no torn or duplicated durable effects", async () => {
    const seed = await seedToolSurfaceWorld(ctx.port);
    const seam = seamOf(seed);
    const ir = governedIrOfWorld();
    const surface = deriveToolSurface({
      ir,
      constraints: governingConstraints(),
      config: surfaceConfig(),
      digest,
    });
    const decision = surface.programmatic.find((entry) => entry.stepId === "curate");
    // The SAME logical run: one idempotency key, one identical request
    // (spec + input byte-identical — the fingerprint discriminator),
    // eight simultaneous attempts. The SQL store's unique index
    // converges the creates; the dispatch of an IN-FLIGHT row fails
    // closed per the authority's own \u00a714 discipline (never
    // re-executed, never torn).
    const items = [
      { status: "ok", n: 1 },
      { status: "bad", n: 2 },
      { status: "ok", n: 3 },
    ];
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runProgrammaticExecution(
          {
            spec: decision?.spec as never,
            input: { items },
            scope: {
              executionId: seed.executionId,
              environmentId: seed.environmentId,
              idempotencyKey: "pg-prog-race",
              actor: seed.world.actor(),
            },
            surfaceId: surface.surfaceId,
            steps: STEPS,
          },
          seam,
          digest,
        ),
      ),
    );
    // Every outcome is HONEST: either the converged durable result
    // (identical sandbox identity and result digest — the winning
    // attempt's durable row is the single source of truth) or the
    // typed fail-closed non-convergent error (the \u00a714 discipline:
    // an in-flight dispatch may not be re-executed). NOTHING is torn,
    // duplicated or fabricated.
    const successes: Awaited<ReturnType<typeof runProgrammaticExecution>>[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        successes.push(outcome.value);
      } else {
        const error = outcome.reason as ProgrammaticError;
        expect(error).toBeInstanceOf(ProgrammaticError);
        expect(error.code).toBe("non-convergent");
      }
    }
    // The race has exactly one winner (the durable row's dispatch); the
    // concurrent losers fail closed honestly.
    expect(successes.length).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(7);
    expect(new Set(successes.map((run) => run.provenance.sandboxId)).size).toBe(1);
    expect(new Set(successes.map((run) => run.resultDigest)).size).toBe(1);
    for (const run of successes) {
      expect(run.value).toEqual(successes[0]?.value);
    }
    // Exactly ONE durable row, completed — no duplicates, no torn
    // state, regardless of how many attempts raced.
    const rows = await seed.world.service.listSandboxesByExecution(
      seed.world.applicationId,
      seed.executionId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    // The ledger carries exactly the one admitted + completed pair
    // (one dispatch, one journal — the losers wrote nothing durable).
    const events = await seed.world.executionService.listEvents(
      seed.world.applicationId,
      seed.executionId,
    );
    expect(events.filter((event) => event.type === "execution.sandbox-admitted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "execution.sandbox-completed")).toHaveLength(1);
    // The replay AFTER the terminal state converges on the SAME
    // durable outcome (the bounded no-op re-run).
    const replay = await runProgrammaticExecution(
      {
        spec: decision?.spec as never,
        input: { items },
        scope: {
          executionId: seed.executionId,
          environmentId: seed.environmentId,
          idempotencyKey: "pg-prog-race",
          actor: seed.world.actor(),
        },
        surfaceId: surface.surfaceId,
        steps: STEPS,
      },
      seam,
      digest,
    );
    expect(replay.provenance.sandboxId).toBe(successes[0]?.provenance.sandboxId);
    expect(replay.resultDigest).toBe(successes[0]?.resultDigest);
    expect(replay.value).toEqual(successes[0]?.value);
  });

  test("POLICY-BEFORE-DISPATCH: a policy-denied programmatic run is journal-then-fail durable evidence (never a bypass)", async () => {
    const seed = await seedToolSurfaceWorld(ctx.port);
    // A restrictive policy v2: the container isolation floor denies the
    // process environment (the admission chain decides BEFORE dispatch).
    await seed.world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { isolation: { minIsolation: "container" } },
        },
      ],
    });
    const ir = governedIrOfWorld();
    const surface = deriveToolSurface({
      ir,
      constraints: governingConstraints(),
      config: surfaceConfig(),
      digest,
    });
    const decision = surface.programmatic.find((entry) => entry.stepId === "curate");
    let caught: unknown;
    try {
      await runProgrammaticExecution(
        {
          spec: decision?.spec as never,
          input: { items: [{ status: "ok", n: 1 }] },
          scope: {
            executionId: seed.executionId,
            environmentId: seed.environmentId,
            idempotencyKey: "pg-prog-denied",
            actor: seed.world.actor(),
          },
          surfaceId: surface.surfaceId,
          steps: STEPS,
        },
        seamOf(seed),
        digest,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProgrammaticError);
    expect((caught as ProgrammaticError).code).toBe("sandbox-denied");
    // The denial is DURABLE evidence: a denied row + envelope.
    const denied = await seed.world.sandboxStore.findSandboxByKey(
      seed.world.applicationId,
      "pg-prog-denied",
    );
    expect(denied?.status).toBe("denied");
    expect(denied?.denialClass).toBe("policy");
    const events = await seed.world.executionService.listEvents(
      seed.world.applicationId,
      seed.executionId,
    );
    expect(events.some((event) => event.type === "execution.sandbox-denied")).toBe(true);
  });
});
