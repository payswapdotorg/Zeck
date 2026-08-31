/**
 * Learning consultation tests (planning module; WORK-014 / INT-006,
 * TOL-003).
 *
 * Wires the REAL planner over the REAL in-memory executions service
 * (the fakes module) with the FULL learning stack behind the planning
 * learning-seam: the real learning service over the in-memory store,
 * the real signal source projection and the real planning adapter.
 *
 * Required-test mapping:
 *  - INT-006: the planner READS versioned learning signals and records
 *    the consultation inside the durable decision record;
 *  - M1/M8: the LIVE selection is never changed by learning (identical
 *    selectedStrategyId with and without the seam; a forbidden route
 *    with a glowing signal is neither selected NOR preferred);
 *  - M13: an unversioned signal fails the planning request closed
 *    (never silently consumed);
 *  - deterministic-first is untouched (a sufficient deterministic task
 *    stays zero-model even when learning prefers a generative route);
 *  - the consultation is recorded only when the seam is wired.
 */

import { describe, expect, test } from "vitest";
import {
  createInMemoryLearningStore,
  createLearningService,
  createLearningSignalSource,
  type LearningSignal,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
} from "../../../src/modules/learning/public";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import {
  createLearningSignalsAdapter,
  createNodeDigest,
  createPlannerService,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
  type ResolvedPolicyInputs,
} from "../../../src/modules/planning/public";
import type { RestrictionSet } from "../../../src/modules/policies/public";
import { ACTOR, createInMemoryExecutions } from "../executions/fakes";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";

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

const GLOWING_ROUTE: readonly ModelRouteCandidate[] = [
  {
    provider: "rail-forbidden",
    model: "model-hot",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "100",
    expectedQuality: 0.99,
    expectedLatencyMs: 900,
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

function spyCapabilityAuthority(satisfied = true): PlanningCapabilityAuthority {
  return {
    async resolve() {
      if (satisfied) {
        return { satisfied: true, catalogRevision: "rev-test", satisfactions: [] };
      }
      return { satisfied: false, catalogRevision: "rev-test", unmet: [] };
    },
    get catalogRevision(): string {
      return "rev-test";
    },
  };
}

function spyPolicyInputs(
  effective: RestrictionSet = {},
  outcome: "allow" | "deny" = "allow",
): PlanningPolicyInputs {
  return {
    async effective(): Promise<ResolvedPolicyInputs> {
      if (outcome === "deny") {
        return {
          outcome: "deny",
          denial: { kind: "prohibited", scope: "platform", reason: "test" },
        };
      }
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

interface WorldOptions {
  readonly routes?: readonly ModelRouteCandidate[];
  readonly policy?: RestrictionSet;
  readonly learning?: boolean;
}

interface World {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly learning: ReturnType<typeof createLearningService>;
  readonly learningStore: ReturnType<typeof createInMemoryLearningStore>;
  readonly planningTask: Record<string, unknown>;
}

function buildWorld(options: WorldOptions = {}): World {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const learningStore = createInMemoryLearningStore();
  let counter = 0;
  let clock = 0;
  const learning = createLearningService({
    store: learningStore,
    digest: createNodeDigest(),
    generateId: () => `00000000-0000-7000-c000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date(Date.parse("2026-09-15T11:00:00Z") + ++clock * 1000),
  });
  const planner = createPlannerService({
    capabilityAuthority: spyCapabilityAuthority(),
    policyInputs: spyPolicyInputs(options.policy),
    routeExplorer: {
      async explore() {
        return options.routes ?? ROUTES;
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
    generateId: () => `00000000-0000-7000-d000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date("2026-09-15T12:00:00Z"),
    ...(options.learning === true
      ? {
          learningSignals: createLearningSignalsAdapter(createLearningSignalSource(learning)),
        }
      : {}),
  });
  return { planner, executions, learning, learningStore, planningTask: {} };
}

async function executionInPlanning(
  world: World,
  task: Record<string, unknown>,
  key: string,
): Promise<string> {
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
  return executionId;
}

let telemetryCounter = 0;

function telemetryInput(
  route: { provider: string; model: string },
  succeeded: boolean,
): RecordTelemetryInput {
  telemetryCounter += 1;
  const executionId = `00000000-0000-7000-e000-${String(telemetryCounter).padStart(12, "0")}`;
  return {
    executionId,
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    taskClass: "interpretation",
    capabilities: ["text-generation"],
    planId: "plan-digest-1",
    planRevision: 1,
    strategyClass: "generative",
    routes: [route],
    tools: [],
    environments: [],
    verification: {
      resultIds: [`ver-${telemetryCounter}`],
      statuses: [succeeded ? "PASS" : "FAIL"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: succeeded ? 1 : 0,
      failCount: succeeded ? 0 : 1,
      inconclusiveCount: 0,
      verified: succeeded,
    },
    costMicroUsd: "1000",
    latencyMs: 2000,
    outcome: succeeded ? "execution-completed" : "execution-failed",
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
  };
}

async function seedLearningHistory(
  world: World,
  route: { provider: string; model: string },
): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await world.learning.recordExecutionTelemetry(telemetryInput(route, index < 7));
  }
  await world.learning.buildScorecard({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    definitionId: "route-outcome-by-task-class",
  });
}

describe("planner learning consultation (INT-006)", () => {
  test("the consultation is recorded with its full versioned basis", async () => {
    const world = buildWorld({ learning: true });
    await seedLearningHistory(world, { provider: "rail-b", model: "model-y" });
    const executionId = await executionInPlanning(
      world,
      { kind: "interpretation", input: { text: "why?" } },
      "consult-1",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "plan-consult-1",
    );

    const consultation = outcome.decision.learningConsultation;
    expect(consultation).toBeDefined();
    expect(consultation?.consulted.length).toBeGreaterThanOrEqual(1);
    // M13: every consulted signal carries the version anchors.
    for (const signal of consultation?.consulted ?? []) {
      expect(signal.scorecardVersion).toBe(1);
      expect(signal.definitionId).toBe("route-outcome-by-task-class");
      expect(signal.definitionVersion).toBe(1);
      expect(signal.telemetrySchemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
      expect(signal.signalClass).toBe("non-authoritative-evidence-signal");
    }
  });

  test("M8: the live selection is IDENTICAL with and without the learning seam", async () => {
    const plainWorld = buildWorld({ learning: false });
    const learningWorld = buildWorld({ learning: true });
    await seedLearningHistory(learningWorld, { provider: "rail-b", model: "model-y" });

    for (const [world, key] of [
      [plainWorld, "plain"],
      [learningWorld, "learning"],
    ] as const) {
      const executionId = await executionInPlanning(
        world,
        { kind: "interpretation", input: { text: "why?" } },
        key,
      );
      const outcome = await world.planner.planExecution(
        {
          applicationId: APP_ID,
          executionId,
          tenantId: ACTOR.tenantId,
          actorId: ACTOR.actorId,
          task: { kind: "interpretation", input: { text: "why?" } },
        },
        `plan-${key}`,
      );
      // Cheap-first cascade selects rail-b/model-y regardless of learning.
      expect(outcome.decision.selectedStrategyId).toBeDefined();
      if (world === plainWorld) {
        expect(outcome.decision.learningConsultation).toBeUndefined();
      } else {
        // The recorded agreement is honest: learning also prefers the
        // historically-successful cheap route here.
        expect(outcome.decision.learningConsultation?.agreesWithSelection).toBe(true);
        expect(outcome.decision.learningConsultation?.preferredStrategyId).toBe(
          outcome.decision.selectedStrategyId,
        );
      }
      if (world === plainWorld) {
        // capture the baseline selection for comparison
        (globalThis as { __plainSelection?: string }).__plainSelection =
          outcome.decision.selectedStrategyId;
      } else {
        expect(outcome.decision.selectedStrategyId).toBe(
          (globalThis as { __plainSelection?: string }).__plainSelection,
        );
      }
    }
  });

  test("M1: a forbidden route with a GLOWING learning signal is neither selected nor preferred", async () => {
    // Policy forbids rail-forbidden outright.
    const world = buildWorld({
      learning: true,
      routes: GLOWING_ROUTE,
      policy: {
        providerModel: { deniedProviders: ["rail-forbidden"] },
      },
    });
    // Learning history says rail-forbidden/model-hot succeeds 8/8.
    await seedLearningHistory(world, { provider: "rail-forbidden", model: "model-hot" });

    const executionId = await executionInPlanning(
      world,
      { kind: "interpretation", input: { text: "why?" } },
      "forbidden-1",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "plan-forbidden-1",
    );

    // The live selection uses the admissible route.
    const selectedCandidate = outcome.decision.candidates.find(
      (candidate) => candidate.strategyId === outcome.decision.selectedStrategyId,
    );
    expect(selectedCandidate?.admissible).toBe(true);
    expect(
      selectedCandidate?.plan.steps.some((step) => step.routeRef?.provider === "rail-forbidden"),
    ).toBe(false);

    // The forbidden candidate is recorded as inadmissible...
    const forbiddenCandidate = outcome.decision.candidates.find((candidate) =>
      candidate.plan.steps.some((step) => step.routeRef?.provider === "rail-forbidden"),
    );
    expect(forbiddenCandidate?.admissible).toBe(false);
    expect(forbiddenCandidate?.inadmissibleReason).toBe("policy-forbidden-route");

    // ...and learning's preference never names it (the preference only
    // considers ADMISSIBLE candidates).
    const consultation = outcome.decision.learningConsultation;
    expect(consultation).toBeDefined();
    expect(consultation?.preferredStrategyId).not.toBe(forbiddenCandidate?.strategyId);
  });

  test("M13: an unversioned signal fails the planning request closed", async () => {
    const world = buildWorld({ learning: true });
    // Wire a hostile seam that returns an UNVERSIONED signal.
    const hostileSignal = {
      signalClass: "non-authoritative-evidence-signal",
      subjectKind: "route",
      subjectKey: "rail-b/model-y",
      taskClass: "interpretation",
      population: 8,
      successCount: 7,
      successRate: 0.875,
      meanCostMicroUsd: "200",
      meanLatencyMs: 1500,
      uncertaintyLevel: "low",
      uncertaintyReasonCode: "adequate-population",
      scorecardId: "",
      scorecardVersion: 0,
      definitionId: "route-outcome-by-task-class",
      definitionVersion: 0,
      telemetrySchemaVersion: 0,
      populationWindowFrom: null,
      populationWindowTo: "2026-09-15T13:00:00Z",
      evidenceRefs: ["ev-1"],
      signalSchemaVersion: 1,
    } as unknown as LearningSignal;

    const hostilePlanner = createPlannerService({
      capabilityAuthority: spyCapabilityAuthority(),
      policyInputs: spyPolicyInputs(),
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
      sink: createPlanningSinkAdapter(world.executions.service),
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-f000-${String(++telemetryCounter).padStart(12, "0")}`,
      now: () => new Date("2026-09-15T12:00:00Z"),
      learningSignals: {
        async consult() {
          return [hostileSignal];
        },
      },
    });

    const executionId = await executionInPlanning(
      world,
      { kind: "interpretation", input: { text: "why?" } },
      "unversioned-1",
    );
    await expect(
      hostilePlanner.planExecution(
        {
          applicationId: APP_ID,
          executionId,
          tenantId: ACTOR.tenantId,
          actorId: ACTOR.actorId,
          task: { kind: "interpretation", input: { text: "why?" } },
        },
        "plan-unversioned-1",
      ),
    ).rejects.toThrow(/versioned scorecard basis|M13|positive integer/);
  });

  test("deterministic-first is untouched: a sufficient deterministic task stays zero-model", async () => {
    const world = buildWorld({ learning: true });
    // Learning history glows for a generative route — irrelevant when
    // deterministic sufficiency holds (ADR-0007 mandatory preference).
    await seedLearningHistory(world, { provider: "rail-b", model: "model-y" });

    const executionId = await executionInPlanning(
      world,
      { kind: "arithmetic", input: { expression: "2+2" } },
      "deterministic-1",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "arithmetic", input: { expression: "2+2" } },
      },
      "plan-deterministic-1",
    );
    expect(outcome.selectedPlan.modelCalls).toBe(0);
    expect(outcome.selectedPlan.strategyClass).toBe("deterministic-only");
    expect(outcome.decision.deterministicSufficiency.outcome).toBe("sufficient");
    // Zero-model plans consult no route subjects: the consultation is
    // recorded EMPTY (nothing to consult), never fabricated.
    expect(outcome.decision.learningConsultation?.consulted).toEqual([]);
    expect(outcome.decision.learningConsultation?.preferredStrategyId).toBeNull();
  });

  test("the consultation survives the durable round-trip through the executions ledger", async () => {
    const world = buildWorld({ learning: true });
    await seedLearningHistory(world, { provider: "rail-b", model: "model-y" });
    const executionId = await executionInPlanning(
      world,
      { kind: "interpretation", input: { text: "why?" } },
      "roundtrip-1",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "plan-roundtrip-1",
    );
    // Replaying the SAME idempotency key replays the DURABLE decision
    // (consultation included).
    const replay = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "plan-roundtrip-1",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.decision.learningConsultation?.consulted.length).toBe(
      outcome.decision.learningConsultation?.consulted.length,
    );
  });
});
