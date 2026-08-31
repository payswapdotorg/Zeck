/**
 * Planner composition-consultation integration tests (planning module
 * application; WORK-017).
 *
 * Wires the REAL planner over the REAL in-memory executions service
 * with a REAL composition-recommendation seam (the learning advisor
 * over the in-memory stores) — proving:
 *
 *  - M18 (runtime): the LIVE selection is IDENTICAL with and without
 *    recommendations (the consultation is post-selection evidence);
 *  - M23 (runtime): a deterministic-sufficient task keeps its
 *    deterministic selection regardless of GLOWING generative
 *    recommendations;
 *  - M5 (runtime): a recommendation referencing a policy-forbidden
 *    tool never becomes the recorded preference;
 *  - the durable decision record carries the composition consultation
 *    (validated closed shape) when the seam is wired, and omits it
 *    when unwired;
 *  - unwired seam ⇒ zero composition interaction (planning works
 *    without recommendation history).
 */

import { describe, expect, test } from "vitest";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import {
  CONSULTED_COMPOSITION_CLASS,
  type CompositionRecommendations,
  type ConsultedCompositionRecommendation,
  createCompositionRecommendationsAdapter,
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

function recommendation(
  overrides: Partial<ConsultedCompositionRecommendation> = {},
): ConsultedCompositionRecommendation {
  return {
    recommendationClass: CONSULTED_COMPOSITION_CLASS,
    taskClass: "generation",
    contextCapabilities: ["text-generation"],
    contextStrategyClass: "generative",
    toolVersions: [{ toolId: "compose-tool", version: "1.0.0" }],
    toolCapabilityIds: ["text-generation"],
    status: "supported",
    rank: 1,
    confidenceLevel: "low",
    population: 10,
    successCount: 10,
    successRate: 1,
    meanCostMicroUsd: "100",
    meanLatencyMs: 500,
    setId: "set-1",
    setVersion: 1,
    analysisVersion: 1,
    compositionSchemaVersion: 1,
    recommendationSchemaVersion: 1,
    evaluationWindowFrom: "2026-08-01T00:00:00Z",
    evaluationWindowTo: "2026-08-31T00:00:00Z",
    evidenceRefs: ["execution:1:receipt"],
    sourceExecutionIds: ["exec-1"],
    ...overrides,
  };
}

function seam(
  recommendations: readonly ConsultedCompositionRecommendation[],
): CompositionRecommendations & { calls: number } {
  return {
    calls: 0,
    async consult() {
      this.calls += 1;
      return recommendations;
    },
  } as CompositionRecommendations & { calls: number };
}

interface World {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly composition?: CompositionRecommendations & { calls: number };
}

function buildWorld(
  options: {
    readonly recommendations?: readonly ConsultedCompositionRecommendation[];
    readonly policy?: RestrictionSet;
  } = {},
): World {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const composition =
    options.recommendations === undefined ? undefined : seam(options.recommendations);
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
    now: () => new Date("2026-09-15T12:00:00Z"),
    ...(composition === undefined ? {} : { compositionRecommendations: composition }),
  });
  return { planner, executions, composition };
}

async function executionInPlanning(world: World, key: string): Promise<string> {
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task: { kind: "generation", input: { text: "artifact-1" } } },
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

function planInput(executionId: string, key: string) {
  return {
    applicationId: APP_ID,
    executionId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    task: { kind: "generation", input: { text: "artifact-1" } },
    idempotencyKey: `plan-${key}`,
  };
}

describe("planner: the composition consultation (advisory evidence)", () => {
  test("unwired seam ⇒ zero composition interaction; the decision omits the capture", async () => {
    const world = buildWorld();
    const executionId = await executionInPlanning(world, "unwired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "unwired"),
      "plan-unwired",
    );
    expect(outcome.decision.compositionConsultation).toBeUndefined();
  });

  test("the wired seam is consulted and the capture is recorded on the DURABLE decision", async () => {
    const world = buildWorld({ recommendations: [recommendation()] });
    const executionId = await executionInPlanning(world, "wired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "wired"),
      "plan-wired",
    );
    expect(world.composition?.calls).toBe(1);
    const capture = outcome.decision.compositionConsultation;
    expect(capture).toBeDefined();
    expect(capture?.consulted).toHaveLength(1);
    expect(capture?.consulted[0]?.setId).toBe("set-1");
  });

  test("M18 (runtime): the LIVE selection is IDENTICAL with and without recommendations", async () => {
    const plain = buildWorld();
    const recommended = buildWorld({ recommendations: [recommendation()] });
    const plainExecution = await executionInPlanning(plain, "plain");
    const recommendedExecution = await executionInPlanning(recommended, "recommended");
    const plainOutcome = await plain.planner.planExecution(
      planInput(plainExecution, "plain"),
      "plan-plain",
    );
    const recommendedOutcome = await recommended.planner.planExecution(
      planInput(recommendedExecution, "recommended"),
      "plan-recommended",
    );
    expect(recommendedOutcome.decision.selectedStrategyId).toBe(
      plainOutcome.decision.selectedStrategyId,
    );
    expect(recommendedOutcome.selectedPlan.planId).toBe(plainOutcome.selectedPlan.planId);
  });

  test("M23 (runtime): a deterministic-sufficient task keeps the deterministic selection despite GLOWING recommendations", async () => {
    const world = buildWorld({
      recommendations: [
        recommendation({
          population: 100,
          successCount: 100,
          toolCapabilityIds: ["text-generation"],
        }),
      ],
    });
    const receipt = await world.executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "arithmetic", input: { expression: "2+2" } } },
      "create-arithmetic",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-arithmetic",
    );
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-arithmetic",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "arithmetic", input: { expression: "2+2" } },
      },
      "plan-arithmetic-1",
    );
    // Zero-model deterministic plan — the glowing recommendation could
    // not displace it.
    expect(outcome.selectedPlan.steps.every((step) => step.routeRef === undefined)).toBe(true);
    expect(outcome.decision.deterministicSufficiency.outcome).toBe("sufficient");
  });

  test("M5 (runtime): a recommendation referencing a policy-forbidden tool is never preferred", async () => {
    const world = buildWorld({
      recommendations: [
        recommendation({
          toolVersions: [{ toolId: "forbidden-tool", version: "1.0.0" }],
          toolCapabilityIds: ["text-generation"],
          population: 50,
          successCount: 50,
          successRate: 1,
        }),
      ],
      policy: { tool: { deniedTools: ["forbidden-tool"] } },
    });
    const executionId = await executionInPlanning(world, "forbidden");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "forbidden"),
      "plan-forbidden",
    );
    const capture = outcome.decision.compositionConsultation;
    expect(capture?.preferredStrategyId).toBeNull();
    expect(capture?.consulted).toHaveLength(1);
  });

  test("a malformed recommendation fails the planning request CLOSED (never silently degraded)", async () => {
    const malformed = recommendation({ setId: "" });
    const world = buildWorld({ recommendations: [malformed] });
    const executionId = await executionInPlanning(world, "malformed");
    await expect(
      world.planner.planExecution(planInput(executionId, "malformed"), "plan-malformed"),
    ).rejects.toThrow();
  });

  test("the adapter seam validates learning signals (the real adapter over a fake source)", async () => {
    const adapter = createCompositionRecommendationsAdapter({
      async consult() {
        // The learning signal shape (context + confidence + set anchors).
        return [
          {
            recommendationClass: CONSULTED_COMPOSITION_CLASS,
            context: {
              taskClass: "generation",
              capabilities: ["text-generation"],
              strategyClass: "generative",
              contextStrategy: "unknown",
            },
            composition: { steps: [], edges: [] },
            toolVersions: [{ toolId: "compose-tool", version: "1.0.0" }],
            toolCapabilityIds: ["text-generation"],
            status: "supported",
            statusReason: "adequate-population",
            rank: 1,
            confidence: { level: "low", reasonCode: "adequate-population", detail: "ok" },
            population: 10,
            successCount: 10,
            successRate: 1,
            verificationPassRate: null,
            verificationTotal: 0,
            meanCostMicroUsd: "100",
            meanLatencyMs: 500,
            failureModes: [],
            evaluationWindowFrom: "2026-08-01T00:00:00Z",
            evaluationWindowTo: "2026-08-31T00:00:00Z",
            sourceExecutionIds: ["exec-1"],
            evidenceRefs: ["execution:1:receipt"],
            deterministicEvidence: {
              subgraphObservationCount: 0,
              fullyDeterministicExecutionCount: 0,
            },
            compositionSchemaVersion: 1,
            recommendationSchemaVersion: 1,
            setId: "set-1",
            setVersion: 1,
            analysisVersion: 1,
          },
        ] as never[];
      },
    });
    const consulted = await adapter.consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      taskClass: "generation",
    });
    expect(consulted).toHaveLength(1);
    expect(consulted[0]?.recommendationClass).toBe(CONSULTED_COMPOSITION_CLASS);
    expect(consulted[0]?.setId).toBe("set-1");
    expect(consulted[0]?.toolVersions[0]?.toolId).toBe("compose-tool");

    // A malformed (unversioned) signal fails closed at the seam.
    const strict = createCompositionRecommendationsAdapter({
      async consult() {
        return [
          {
            recommendationClass: CONSULTED_COMPOSITION_CLASS,
            context: {
              taskClass: "generation",
              capabilities: [],
              strategyClass: "generative",
              contextStrategy: "unknown",
            },
            toolVersions: [{ toolId: "x", version: "1.0.0" }],
            toolCapabilityIds: [],
            status: "supported",
            rank: 1,
            confidence: { level: "low", reasonCode: "ok", detail: "ok" },
            population: 5,
            successCount: 5,
            successRate: 1,
            meanCostMicroUsd: "1",
            meanLatencyMs: 1,
            evaluationWindowFrom: "2026-08-01T00:00:00Z",
            evaluationWindowTo: "2026-08-31T00:00:00Z",
            evidenceRefs: ["e"],
            sourceExecutionIds: ["s"],
            compositionSchemaVersion: 1,
            recommendationSchemaVersion: 1,
            setId: "",
            setVersion: 1,
            analysisVersion: 1,
          },
        ] as never[];
      },
    });
    await expect(
      strict.consult({ applicationId: APP_ID, tenantId: ACTOR.tenantId }),
    ).rejects.toThrow();
  });
});
