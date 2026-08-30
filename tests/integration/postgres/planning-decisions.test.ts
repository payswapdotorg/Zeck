/**
 * Real-PostgreSQL planning-decision integration (WORK-009).
 *
 * Durable planning through the REAL executions ledger: the planner is
 * wired over the SQL execution service (the executions-world fixture)
 * with the REAL capability registry (planning deterministic facts
 * published through the sanctioned publish path) and the REAL policy
 * authority adapter. Proves the Work Order's durable verification set:
 * durable planning-decision persistence, idempotent plan creation,
 * CONCURRENT duplicate planning (×8 → exactly one envelope, real
 * PostgreSQL arbitration), replanning provenance through the existing
 * authority boundary, policy inputs captured in the durable record,
 * tenant isolation and the state guard.
 */

import { expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/public";
import type { ExecutionService } from "../../../src/modules/executions/public";
import type { ModelRouteCandidate, PlannerService } from "../../../src/modules/planning/public";
import {
  createCapabilityAuthorityAdapter,
  createInMemoryDeterministicCatalog,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  publishDeterministicCapabilityFacts,
} from "../../../src/modules/planning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import {
  ACTOR_ID,
  type ExecutionsWorld,
  generateId,
  seedExecutionsWorld,
} from "./executions-world";
import { definePgSuite } from "./harness";

const ROUTES: readonly ModelRouteCandidate[] = [
  {
    provider: "rail-a",
    model: "model-x",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "1000",
    expectedQuality: 0.92,
    expectedLatencyMs: 2000,
  },
  {
    provider: "rail-b",
    model: "model-y",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "200",
    expectedQuality: 0.85,
    expectedLatencyMs: 1500,
  },
];

interface PlanningWorld {
  readonly base: ExecutionsWorld;
  readonly planner: PlannerService;
  readonly service: ExecutionService;
}

async function setup(port: Parameters<typeof seedExecutionsWorld>[0]): Promise<PlanningWorld> {
  const base = await seedExecutionsWorld(port);
  const registry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: SEED_CAPABILITY_FACTS,
  });
  await publishDeterministicCapabilityFacts(registry);
  const policyAuthority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  const planner = createPlannerService({
    capabilityAuthority: createCapabilityAuthorityAdapter(registry),
    policyInputs: createPolicyInputsAdapter(policyAuthority),
    routeExplorer: createRouteTableExplorer(ROUTES),
    deterministicCatalog: createInMemoryDeterministicCatalog(),
    sink: createPlanningSinkAdapter(base.service),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  return { base, planner, service: base.service };
}

definePgSuite("planning decisions (real PostgreSQL)", (ctx) => {
  let world: PlanningWorld;

  async function executionInPlanning(task: Record<string, unknown>, key: string): Promise<string> {
    const receipt = await world.service.createExecution(
      { applicationId: world.base.applicationId, task },
      `create-${key}`,
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    const executionId = receipt.executionId;
    for (const [command, commandKey] of [
      ["authorize", "auth"],
      ["plan", "plancmd"],
    ] as const) {
      await world.service.transition(
        {
          actorId: ACTOR_ID,
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
          executionId,
          command,
        },
        `${commandKey}-${key}`,
      );
    }
    return executionId;
  }

  function planningInput(executionId: string, task: Record<string, unknown>) {
    return {
      applicationId: world.base.applicationId,
      executionId,
      tenantId: world.base.tenantId,
      actorId: ACTOR_ID,
      task,
    };
  }

  test("durable zero-model planning decision persists through the real ledger", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning(
      { kind: "arithmetic", input: { expression: "2+2" } },
      "durable",
    );
    const outcome = await world.planner.planExecution(
      planningInput(executionId, { kind: "arithmetic", input: { expression: "2+2" } }),
      "decision-durable",
    );
    expect(outcome.selectedPlan.modelCalls).toBe(0);
    expect(outcome.selectedPlan.hasRouteRef).toBe(false);
    expect(outcome.replayed).toBe(false);

    const events = await world.service.listEvents(world.base.applicationId, executionId);
    const envelope = events.find((event) => event.type === "planning.decision-recorded");
    expect(envelope).toBeDefined();
    expect(envelope?.sequence).toBe(4);
    expect(envelope?.command).toBe("plan");
    expect(envelope?.cause).toBe("planning-decision");
    const payload = envelope?.payload as Record<string, unknown>;
    expect(payload.decisionId).toBe(outcome.decision.decisionId);
    expect((payload.taskProfile as Record<string, unknown>).kind).toBe("arithmetic");
    expect(payload.deterministicSufficiency).toMatchObject({ outcome: "sufficient" });
    // Gapless sequence preserved around the planning record.
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    // The execution row preserved PLANNING through the identity-preserving
    // sequence advance.
    const row = await world.service.getExecution(world.base.applicationId, executionId);
    expect(row?.status).toBe("PLANNING");
    expect(row?.lastEventSequence).toBe(4);
  });

  test("idempotent plan creation: same key replays the same durable decision", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning(
      { kind: "arithmetic", input: { expression: "3*3" } },
      "idem",
    );
    const input = planningInput(executionId, {
      kind: "arithmetic",
      input: { expression: "3*3" },
    });
    const first = await world.planner.planExecution(input, "decision-idem");
    const second = await world.planner.planExecution(input, "decision-idem");
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.sequence).toBe(first.sequence);
    // The replay returns the DURABLE record (volatile fields included).
    expect(second.decision.recordedAt).toBe(first.decision.recordedAt);
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(1);
  });

  test("the same key with a different logical decision fails IDEMPOTENCY_KEY_REUSED", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning({ kind: "arithmetic", input: {} }, "reuse");
    await world.planner.planExecution(
      planningInput(executionId, { kind: "arithmetic", input: { expression: "1+1" } }),
      "decision-reuse",
    );
    await expect(
      world.planner.planExecution(
        planningInput(executionId, { kind: "arithmetic", input: { expression: "2+2" } }),
        "decision-reuse",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("CONCURRENT duplicate planning (x8) converges to exactly ONE durable decision envelope", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning(
      { kind: "arithmetic", input: { expression: "9*9" } },
      "concurrent",
    );
    const input = planningInput(executionId, {
      kind: "arithmetic",
      input: { expression: "9*9" },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        world.planner.planExecution(input, "decision-concurrent").then(
          (value) => value,
          (error: unknown) => error,
        ),
      ),
    );
    const errors = outcomes.filter((outcome) => outcome instanceof Error);
    expect(errors).toEqual([]);
    const successes = outcomes as Awaited<ReturnType<PlannerService["planExecution"]>>[];
    expect(successes).toHaveLength(8);
    expect(new Set(successes.map((outcome) => outcome.decision.decisionId)).size).toBe(1);
    expect(new Set(successes.map((outcome) => outcome.sequence)).size).toBe(1);
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(1);
    // The ledger stays gapless after the concurrent burst.
    const ledgerSequences = events.map((event) => event.sequence);
    expect(ledgerSequences).toEqual(ledgerSequences.map((_, index) => index + 1));
    const replays = successes.filter((outcome) => outcome.replayed);
    expect(replays.length).toBe(successes.length - 1);
  });

  test("replanning provenance binds replanOf through the existing authority boundary", async () => {
    world = await setup(ctx.port);
    const firstExecution = await executionInPlanning(
      { kind: "interpretation", input: { text: "why?" } },
      "replan-1",
    );
    const first = await world.planner.planExecution(
      planningInput(firstExecution, { kind: "interpretation", input: { text: "why?" } }),
      "decision-replan-1",
    );
    expect(first.selectedPlan.modelCalls).toBe(1);

    // A verification outcome on the FIRST execution drives the existing
    // state machine (fail is terminal here); replanning happens on a
    // successor decision that binds replanOf provenance to the first.
    const scope = {
      actorId: ACTOR_ID,
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
      executionId: firstExecution,
    };
    await world.service.transition({ ...scope, command: "queue" }, "rq-1");
    await world.service.transition({ ...scope, command: "start" }, "rs-1");
    await world.service.transition(
      {
        ...scope,
        command: "fail",
        reason: "verification-failed",
        verificationResults: [
          {
            criterionId: "answer-quality",
            strategy: "llm-judge",
            status: "FAIL",
            recordedBy: "verifier-1",
          },
        ],
      },
      "rf-1",
    );
    const row = await world.service.getExecution(world.base.applicationId, firstExecution);
    expect(row?.status).toBe("FAILED"); // terminal — through the EXISTING machine

    // The successor execution re-plans with replanOf provenance.
    const successor = await executionInPlanning(
      { kind: "interpretation", input: { text: "why? (retry)" } },
      "replan-2",
    );
    const second = await world.planner.planExecution(
      {
        ...planningInput(successor, { kind: "interpretation", input: { text: "why? (retry)" } }),
        replanOf: first.decision.decisionId,
      },
      "decision-replan-2",
    );
    expect(second.decision.replanOf).toBe(first.decision.decisionId);
    const events = await world.service.listEvents(world.base.applicationId, successor);
    const envelope = events.find((event) => event.type === "planning.decision-recorded");
    expect((envelope?.reference as Record<string, unknown>)?.replanOf).toBe(
      first.decision.decisionId,
    );
  });

  test("the canonical VERIFYING -> REPLANNING edge accepts a replan decision while REPLANNING", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning(
      { kind: "interpretation", input: { text: "analyze" } },
      "replanning-edge",
    );
    await world.planner.planExecution(
      planningInput(executionId, { kind: "interpretation", input: { text: "analyze" } }),
      "decision-edge-1",
    );
    const scope = {
      actorId: ACTOR_ID,
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
      executionId,
    };
    for (const [command, key] of [
      ["queue", "eq"],
      ["start", "es"],
      ["verify", "ev"],
    ] as const) {
      await world.service.transition({ ...scope, command }, key);
    }
    await world.service.transition(
      { ...scope, command: "replan", reason: "verification-inconclusive" },
      "er",
    );
    const replanned = await world.planner.planExecution(
      planningInput(executionId, { kind: "interpretation", input: { text: "analyze" } }),
      "decision-edge-2",
    );
    expect(replanned.selectedPlan.modelCalls).toBe(1);
    const row = await world.service.getExecution(world.base.applicationId, executionId);
    expect(row?.status).toBe("REPLANNING");
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(2);
  });

  test("policy inputs are captured in the DURABLE planning record", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning({ kind: "arithmetic", input: {} }, "policy");
    const outcome = await world.planner.planExecution(
      planningInput(executionId, { kind: "arithmetic", input: {} }),
      "decision-policy",
    );
    // No policy set configured: allow + empty restriction set, digested.
    expect(outcome.decision.policyInputs.outcome).toBe("allow");
    expect(outcome.decision.policyInputs.restrictionSetDigest).toMatch(/^[0-9a-f]{64}$/);
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    const envelope = events.find((event) => event.type === "planning.decision-recorded");
    const policyInputs = (envelope?.payload as Record<string, unknown>)?.policyInputs as Record<
      string,
      unknown
    >;
    expect(policyInputs?.outcome).toBe("allow");
    expect(typeof policyInputs?.restrictionSetDigest).toBe("string");
  });

  test("tenant isolation: planning decisions never cross tenant scope", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning({ kind: "arithmetic", input: {} }, "tenant");
    await expect(
      world.planner.planExecution(
        {
          applicationId: world.base.applicationId,
          executionId,
          tenantId: "00000000-0000-7000-8000-0000000000dd",
          actorId: ACTOR_ID,
          task: { kind: "arithmetic", input: {} },
        },
        "decision-tenant",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(0);
  });

  test("the state guard rejects out-of-phase planning with zero writes", async () => {
    world = await setup(ctx.port);
    const executionId = await executionInPlanning({ kind: "arithmetic", input: {} }, "phase");
    const scope = {
      actorId: ACTOR_ID,
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
      executionId,
    };
    await world.service.transition({ ...scope, command: "queue" }, "pq");
    await world.service.transition({ ...scope, command: "start" }, "ps");
    await expect(
      world.planner.planExecution(
        planningInput(executionId, { kind: "arithmetic", input: {} }),
        "decision-phase",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const events = await world.service.listEvents(world.base.applicationId, executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(0);
  });
});
