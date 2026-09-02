/**
 * Planner learned-policy seam tests (planning module application;
 * WORK-020 / LRN-002).
 *
 * Wires the REAL planner over the REAL in-memory executions service
 * with the FULL in-memory learned-policy stack (learning service →
 * learned-policy service → public learned-policy source → the REAL
 * planning adapter) — proving the runtime negative guarantees:
 *
 *  - M-canary (runtime): an ACTIVE canary publication records its
 *    preference as DIVERGENCE EVIDENCE and never changes the live
 *    selection;
 *  - M-promoted (runtime): ONLY a promoted publication refines the
 *    cascade ordering among ALREADY-ADMISSIBLE candidates (the
 *    deterministic-first branch is untouchable);
 *  - M-forbidden (runtime): a learned recommendation whose top subject
 *    the CURRENT policy forbids never authorizes that route — it is
 *    dropped from the ordering and recorded as rejected;
 *  - M-unpublished (runtime): with no publication the planner behaves
 *    exactly like the un-wired baseline;
 *  - the durable decision record carries the consultation capture with
 *    its full anchors (validated closed shape);
 *  - a malformed or restriction-smuggled learned output fails the
 *    planning request CLOSED at the adapter seam.
 */

import { describe, expect, test } from "vitest";
import {
  type ActiveLearnedPolicyView,
  createInMemoryLearnedPolicyStore,
  createInMemoryLearningStore,
  createLearnedPolicyService,
  createLearnedPolicySource,
  createLearningService,
  type LearnedPolicyService,
  type LearnedPolicySource as LearningLearnedPolicySource,
  type RecordTelemetryInput,
} from "../../../src/modules/learning/public";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import {
  createLearnedPolicyAdapter,
  createNodeDigest,
  createPlannerService,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
  type ResolvedPolicyInputs,
} from "../../../src/modules/planning/public";
import type { RestrictionSet } from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../executions/fakes";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";

/** rail-a is DEARER than rail-b — the governed cheap-first pick is rail-b. */
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

const GOVERNED_PICK = "generative:rail-b/model-y";
const LEARNED_PICK = "generative:rail-a/model-x";

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `00000000-0000-7000-a000-${String(idCounter).padStart(12, "0")}`;
}

let tick = 0;
function clock(): Date {
  return new Date(Date.parse("2026-09-15T12:00:00Z") + ++tick * 1000);
}

function capabilityAuthority(): PlanningCapabilityAuthority {
  return {
    async resolve() {
      return { satisfied: true, catalogRevision: "rev-test", satisfactions: [] };
    },
    get catalogRevision(): string {
      return "rev-test";
    },
  };
}

function policyInputs(effective: RestrictionSet = {}): PlanningPolicyInputs {
  return {
    async effective(): Promise<ResolvedPolicyInputs> {
      return {
        outcome: "allow",
        effective,
        policySetId: "default",
        policySetVersion: 1,
        policyContentHash: "deadbeef",
        appliedScopes: ["platform"],
      };
    },
  };
}

interface LearnedWorld {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly learnedService: LearnedPolicyService;
  readonly consultCalls: { count: number };
}

/** The full in-memory learned-policy stack (generation → publication). */
async function buildLearnedWorld(
  options: {
    readonly policy?: RestrictionSet;
    readonly source?: LearningLearnedPolicySource;
    readonly telemetryRoute?: { provider: string; model: string };
  } = {},
): Promise<LearnedWorld> {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);

  const learningStore = createInMemoryLearningStore();
  const learnedStore = createInMemoryLearnedPolicyStore(learningStore);
  const learningService = createLearningService({
    store: learningStore,
    digest: createNodeDigest(),
    generateId,
    now: clock,
  });
  const learnedService = createLearnedPolicyService({
    store: learnedStore,
    digest: createNodeDigest(),
    generateId,
    now: clock,
  });

  // Seed a population where the LEARNED preference (telemetry route)
  // differs from the governed cheap-first pick: the observed route
  // succeeds in 11/12 while rail-b (in a second population) succeeds in
  // 5/12 — the ranking prefers the observed route.
  const observed = options.telemetryRoute ?? { provider: "rail-a", model: "model-x" };
  for (let index = 0; index < 12; index += 1) {
    const input: RecordTelemetryInput = {
      executionId: generateId(),
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      taskClass: "generation",
      capabilities: ["text-generation"],
      planId: "plan-1",
      planRevision: 1,
      strategyClass: "generative",
      routes: [observed],
      tools: [],
      environments: [],
      verification: {
        resultIds: ["ver-1"],
        statuses: ["PASS"],
        evaluatorIds: ["deterministic:schema@1"],
        passCount: 1,
        failCount: 0,
        inconclusiveCount: 0,
        verified: true,
      },
      costMicroUsd: "1000",
      latencyMs: 2000,
      outcome: index < 11 ? "execution-completed" : "execution-failed",
      evidenceRefs: [`execution:${index}:receipt`],
      subgraphs: [],
      schemaVersion: 1,
    };
    await learningStore.ingestTelemetry(
      {
        telemetryId: generateId(),
        recordedAt: new Date(Date.parse("2026-09-15T11:00:00Z") + index * 1000).toISOString(),
        ...input,
      },
      `fingerprint-${index}`,
    );
  }
  for (let index = 0; index < 12; index += 1) {
    const input: RecordTelemetryInput = {
      executionId: generateId(),
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      taskClass: "generation",
      capabilities: ["text-generation"],
      planId: "plan-1",
      planRevision: 1,
      strategyClass: "generative",
      routes: [{ provider: "rail-b", model: "model-y" }],
      tools: [],
      environments: [],
      verification: {
        resultIds: ["ver-1"],
        statuses: ["PASS"],
        evaluatorIds: ["deterministic:schema@1"],
        passCount: 1,
        failCount: 0,
        inconclusiveCount: 0,
        verified: true,
      },
      costMicroUsd: "200",
      latencyMs: 1500,
      outcome: index < 5 ? "execution-completed" : "execution-failed",
      evidenceRefs: [`execution:b:${index}:receipt`],
      subgraphs: [],
      schemaVersion: 1,
    };
    await learningStore.ingestTelemetry(
      {
        telemetryId: generateId(),
        recordedAt: new Date(Date.parse("2026-09-15T11:30:00Z") + index * 1000).toISOString(),
        ...input,
      },
      `fingerprint-b-${index}`,
    );
  }
  await learningService.buildScorecard({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    definitionId: "route-outcome-by-task-class",
  });

  const source =
    options.source === undefined ? createLearnedPolicySource(learnedService) : options.source;
  const consultCalls = { count: 0 };
  const countingSource: LearningLearnedPolicySource = {
    async consult(request) {
      consultCalls.count += 1;
      return source.consult(request);
    },
  };
  const planner = createPlannerService({
    capabilityAuthority: capabilityAuthority(),
    policyInputs: policyInputs(options.policy),
    routeExplorer: {
      async explore() {
        return ROUTES;
      },
    },
    deterministicCatalog: {
      async list() {
        const { DETERMINISTIC_CATALOG_SEED } = await import(
          "../../../src/modules/planning/adapters/in-memory-deterministic-catalog"
        );
        return DETERMINISTIC_CATALOG_SEED;
      },
    },
    sink: createPlanningSinkAdapter(executions.service),
    digest: createNodeDigest(),
    generateId: executions.generateId,
    now: clock,
    learnedPolicy: createLearnedPolicyAdapter(countingSource),
  });
  return { planner, executions, learnedService, consultCalls };
}

/** Publish a learned policy through the full explicit path. */
async function publishFully(
  service: LearnedPolicyService,
  mode: "canary" | "promoted",
): Promise<void> {
  const { policy } = await service.generateLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
  });
  const { evaluation: shadow } = await service.evaluateLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    policyId: policy.policyId,
    evaluationClass: "shadow",
  });
  if (mode === "canary") {
    await service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
    });
    return;
  }
  await service.publishLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    policyId: policy.policyId,
    publicationMode: "canary",
    publishedBy: "operator-1",
    evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
  });
  const { evaluation: canary } = await service.evaluateLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    policyId: policy.policyId,
    evaluationClass: "canary",
  });
  await service.publishLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    policyId: policy.policyId,
    publicationMode: "promoted",
    publishedBy: "operator-1",
    evaluationEvidence: [
      { evaluationId: shadow.evaluationId },
      { evaluationId: canary.evaluationId },
    ],
  });
}

async function planGeneration(
  world: LearnedWorld,
  key: string,
  task: Record<string, unknown> = { kind: "generation", input: { text: "artifact-1" } },
): Promise<ReturnType<Awaited<ReturnType<typeof buildLearnedWorld>>["planner"]["planExecution"]>> {
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task },
    `create-${key}`,
    ACTOR,
  );
  const executionId = receipt.executionId;
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
    `authorize-${key}`,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
    `plan-${key}`,
  );
  return world.planner.planExecution(
    {
      applicationId: APP_ID,
      executionId,
      tenantId: ACTOR.tenantId,
      actorId: ACTOR.actorId,
      task,
    },
    `plan-exec-${key}`,
  );
}

describe("planner: the learned-policy consultation seam", () => {
  test("unwired seam ⇒ zero learned-policy interaction; the decision omits the capture", async () => {
    const executions = createInMemoryExecutions();
    executions.store.seedApplication(APP_ID, ACTOR.tenantId);
    const planner = createPlannerService({
      capabilityAuthority: capabilityAuthority(),
      policyInputs: policyInputs(),
      routeExplorer: {
        async explore() {
          return ROUTES;
        },
      },
      deterministicCatalog: {
        async list() {
          const { DETERMINISTIC_CATALOG_SEED } = await import(
            "../../../src/modules/planning/adapters/in-memory-deterministic-catalog"
          );
          return DETERMINISTIC_CATALOG_SEED;
        },
      },
      sink: createPlanningSinkAdapter(executions.service),
      digest: createNodeDigest(),
      generateId: executions.generateId,
      now: clock,
    });
    const receipt = await executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "generation", input: { text: "a" } } },
      "create-unwired",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-unwired",
    );
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-unwired",
    );
    const outcome = await planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "generation", input: { text: "a" } },
      },
      "plan-exec-unwired",
    );
    expect(outcome.decision.learnedPolicyConsultation).toBeUndefined();
    // The governed cheap-first pick.
    expect(outcome.decision.selectedStrategyId).toBe(GOVERNED_PICK);
  });

  test("no publication ⇒ the source returns null and the planner is byte-identical to the baseline", async () => {
    const world = await buildLearnedWorld();
    const outcome = await planGeneration(world, "unpublished");
    expect(world.consultCalls.count).toBe(1);
    expect(outcome.decision.learnedPolicyConsultation).toBeUndefined();
    expect(outcome.decision.selectedStrategyId).toBe(GOVERNED_PICK);
  });

  test("M-canary (runtime): an ACTIVE canary publication records divergence and NEVER changes the selection", async () => {
    const world = await buildLearnedWorld();
    await publishFully(world.learnedService, "canary");
    const outcome = await planGeneration(world, "canary");
    // The live selection is the GOVERNED pick.
    expect(outcome.decision.selectedStrategyId).toBe(GOVERNED_PICK);
    const capture = outcome.decision.learnedPolicyConsultation;
    expect(capture).toBeDefined();
    expect(capture?.consultedPolicy.publicationMode).toBe("canary");
    expect(capture?.consultedPolicy.publicationId).toBeTruthy();
    // The learned preference is recorded as DIVERGENCE EVIDENCE.
    expect(capture?.preferredStrategyId).toBe(LEARNED_PICK);
    expect(capture?.agreesWithSelection).toBe(false);
    expect(capture?.appliedToSelection).toBe(false);
    expect(capture?.governedStrategyId).toBe(GOVERNED_PICK);
    // The durable record validates round-trip.
    expect(() => JSON.parse(JSON.stringify(capture))).not.toThrow();
  });

  test("M-promoted (runtime): ONLY a promoted publication refines the ordering among admissible candidates", async () => {
    const world = await buildLearnedWorld();
    await publishFully(world.learnedService, "promoted");
    const outcome = await planGeneration(world, "promoted");
    // The learned preference (rail-a — dearer but higher observed
    // success rate) refined the cascade away from the cheap-first pick.
    expect(outcome.decision.selectedStrategyId).toBe(LEARNED_PICK);
    const capture = outcome.decision.learnedPolicyConsultation;
    expect(capture?.consultedPolicy.publicationMode).toBe("promoted");
    expect(capture?.appliedToSelection).toBe(true);
    expect(capture?.governedStrategyId).toBe(GOVERNED_PICK);
    expect(capture?.preferredStrategyId).toBe(LEARNED_PICK);
    expect(capture?.agreesWithSelection).toBe(true);
    expect(capture?.rejectedByPolicy).toEqual([]);
    // The selection rationale names the published learned policy.
    expect(outcome.decision.selectionRationale).toContain("learned-policy");
  });

  test("M-forbidden (runtime): a learned recommendation CANNOT authorize a route the current policy forbids", async () => {
    // The current policy forbids rail-a (the learned top subject).
    const world = await buildLearnedWorld({
      policy: { providerModel: { deniedProviders: ["rail-a"] } },
    });
    await publishFully(world.learnedService, "promoted");
    const outcome = await planGeneration(world, "forbidden");
    // rail-a is forbidden ⇒ the ordering falls back to rail-b (the
    // governed pick) — the learned preference NEVER authorizes it.
    expect(outcome.decision.selectedStrategyId).toBe(GOVERNED_PICK);
    const capture = outcome.decision.learnedPolicyConsultation;
    expect(capture?.rejectedByPolicy).toContain("rail-a/model-x");
    expect(capture?.appliedToSelection).toBe(false);
    // The plan never dispatched through the forbidden route.
    const forbiddenStep = outcome.selectedPlan.steps.find(
      (step) => step.routeRef?.provider === "rail-a",
    );
    expect(forbiddenStep).toBeUndefined();
  });

  test("deterministic-first is UNTOUCHABLE: a sufficient task keeps its deterministic selection despite a promoted preference", async () => {
    const world = await buildLearnedWorld();
    await publishFully(world.learnedService, "promoted");
    const outcome = await planGeneration(world, "arithmetic", {
      kind: "arithmetic",
      input: { expression: "2+2" },
    });
    expect(outcome.selectedPlan.modelCalls).toBe(0);
    expect(outcome.selectedPlan.strategyClass).toBe("deterministic-only");
    expect(outcome.decision.deterministicSufficiency.outcome).toBe("sufficient");
    expect(outcome.decision.selectedStrategyId).toBe("deterministic-only");
    // The consultation is still recorded (honest evidence).
    expect(outcome.decision.learnedPolicyConsultation).toBeDefined();
    expect(outcome.decision.learnedPolicyConsultation?.preferredStrategyId).toBeNull();
  });

  test("a malformed (unversioned) learned output fails the planning request CLOSED", async () => {
    const healthy = await buildLearnedWorld();
    await publishFully(healthy.learnedService, "promoted");
    const view = await createLearnedPolicySource(healthy.learnedService).consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(view).not.toBeNull();
    const poisoned: ActiveLearnedPolicyView = {
      policy: { ...(view as ActiveLearnedPolicyView).policy, digest: "" },
      publication: (view as ActiveLearnedPolicyView).publication,
    };
    const world = await buildLearnedWorld({
      source: {
        async consult() {
          return poisoned;
        },
      },
    });
    await expect(planGeneration(world, "malformed")).rejects.toThrow(PlatformError);
  });

  test("a restriction-smuggled learned output is rejected with POLICY_DENIED at the seam (AC-2)", async () => {
    const healthy = await buildLearnedWorld();
    await publishFully(healthy.learnedService, "promoted");
    const view = (await createLearnedPolicySource(healthy.learnedService).consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    })) as ActiveLearnedPolicyView;
    const smuggled: ActiveLearnedPolicyView = {
      policy: {
        ...view.policy,
        // A compromised learning module smuggles a prohibition.
        preferences: [
          {
            ...view.policy.preferences[0],
            ranked: [...(view.policy.preferences[0]?.ranked ?? [])],
            // The poisoned extra field is what the boundary must catch.
            deniedProviders: ["rail-b"],
          } as never,
        ],
      },
      publication: view.publication,
    };
    const adapter = createLearnedPolicyAdapter({
      async consult() {
        return smuggled;
      },
    });
    expect.assertions(2);
    try {
      await adapter.consult({ applicationId: APP_ID, tenantId: ACTOR.tenantId });
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("POLICY_DENIED");
    }
  });

  test("the adapter seam validates and projects the healthy view (the real adapter over the real source)", async () => {
    const healthy = await buildLearnedWorld();
    await publishFully(healthy.learnedService, "promoted");
    const source = createLearnedPolicySource(healthy.learnedService);
    const adapter = createLearnedPolicyAdapter(source);
    const consulted = await adapter.consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      taskClass: "generation",
    });
    expect(consulted?.policyClass).toBe("non-authoritative-learned-planning-policy");
    expect(consulted?.publicationMode).toBe("promoted");
    expect(consulted?.preferences[0]?.ranked[0]?.subjectKey).toBe("rail-a/model-x");
    // Task-class projection through the adapter.
    const absent = await adapter.consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      taskClass: "summarize",
    });
    expect(absent?.preferences).toEqual([]);
  });
});
