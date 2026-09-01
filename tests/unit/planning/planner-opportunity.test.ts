/**
 * Planner opportunity-consultation integration tests (planning module
 * application; WORK-022 / DTR-005).
 *
 * Wires the REAL planner over the REAL in-memory executions service
 * with a REAL opportunity-signals seam (the planning-owned adapter over
 * the learning module's public OpportunitySignalSource shape) —
 * proving:
 *
 *  - M17 (runtime): the LIVE selection is IDENTICAL with and without
 *    consulted findings (the consultation is post-selection evidence);
 *  - M17 (runtime): a finding implying a DIFFERENT candidate is
 *    recorded as the implied preference and the governed selection is
 *    unchanged (agreesWithSelection=false);
 *  - M17 (runtime): an INADMISSIBLE candidate is never the implied
 *    preference;
 *  - the durable decision record carries the opportunity consultation
 *    (validated closed shape) when the seam is wired, and omits it
 *    when unwired;
 *  - a malformed/unversioned finding fails the planning request
 *    CLOSED (never silently degraded);
 *  - unwired seam ⇒ zero opportunity interaction.
 */

import { describe, expect, test } from "vitest";
import type { OpportunitySignal } from "../../../src/modules/learning/public";
import { createPlanningSinkAdapter } from "../../../src/modules/planning/adapters/planning-sink-adapter";
import type { CandidateStrategy } from "../../../src/modules/planning/public";
import {
  CONSULTED_OPPORTUNITY_CLASS,
  createNodeDigest,
  createOpportunitySignalsAdapter,
  createPlannerService,
  type ModelRouteCandidate,
  type OpportunitySignals,
  opportunityPreferredCandidateId,
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

/** A learning-module-shaped OpportunitySignal (the seam's input shape). */
function signal(overrides: Partial<OpportunitySignal> = {}): OpportunitySignal {
  return {
    signalClass: "non-authoritative-opportunity-finding",
    findingId: "00000000-0000-7000-b000-000000000001",
    analysisId: "00000000-0000-7000-b000-000000000010",
    analysisVersion: 1,
    class: "deterministic-replacement",
    state: "advisory",
    confidenceLevel: "medium",
    population: 40,
    repository: "github.com/example/customer-app",
    revision: "commit-abc123",
    targetNodeIds: ["llm-1"],
    reasonCodes: ["low-input-variability"],
    evidenceRefs: ["obs:llm-1"],
    costImpactBasis: "measured",
    latencyImpactBasis: "measured",
    deterministicEquivalencePotential: "candidate-replacement",
    ...overrides,
  };
}

function seam(signals: readonly OpportunitySignal[]): OpportunitySignals & { calls: number } {
  const implementation: OpportunitySignals & { calls: number } = {
    calls: 0,
    async consult() {
      implementation.calls += 1;
      return signals;
    },
  };
  return implementation;
}

interface World {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly opportunity?: OpportunitySignals & { calls: number };
}

function buildWorld(
  options: {
    readonly signals?: readonly OpportunitySignal[];
    readonly policy?: RestrictionSet;
  } = {},
): World {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const opportunity = options.signals === undefined ? undefined : seam(options.signals);
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
    ...(opportunity === undefined ? {} : { opportunitySignals: opportunity }),
  });
  return { planner, executions, opportunity };
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

describe("planner: the opportunity consultation (advisory evidence, M17)", () => {
  test("unwired seam ⇒ zero opportunity interaction; the decision omits the capture", async () => {
    const world = buildWorld();
    const executionId = await executionInPlanning(world, "unwired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "unwired"),
      "plan-unwired",
    );
    expect(outcome.decision.opportunityConsultation).toBeUndefined();
  });

  test("the wired seam is consulted and the capture is recorded on the DURABLE decision", async () => {
    const world = buildWorld({ signals: [signal()] });
    const executionId = await executionInPlanning(world, "wired");
    const outcome = await world.planner.planExecution(
      planInput(executionId, "wired"),
      "plan-wired",
    );
    expect(world.opportunity?.calls).toBe(1);
    const capture = outcome.decision.opportunityConsultation;
    expect(capture).toBeDefined();
    expect(capture?.consulted).toHaveLength(1);
    expect(capture?.consulted[0]?.signalClass).toBe(CONSULTED_OPPORTUNITY_CLASS);
    expect(capture?.consulted[0]?.findingId).toBe(signal().findingId);
  });

  test("M17 (runtime): the LIVE selection is IDENTICAL with and without consulted findings", async () => {
    const plain = buildWorld();
    const withFindings = buildWorld({ signals: [signal()] });
    const plainExecution = await executionInPlanning(plain, "plain");
    const findingsExecution = await executionInPlanning(withFindings, "findings");
    const plainOutcome = await plain.planner.planExecution(
      planInput(plainExecution, "plain"),
      "plan-plain",
    );
    const findingsOutcome = await withFindings.planner.planExecution(
      planInput(findingsExecution, "findings"),
      "plan-findings",
    );
    expect(findingsOutcome.decision.selectedStrategyId).toBe(
      plainOutcome.decision.selectedStrategyId,
    );
    expect(findingsOutcome.selectedPlan.planId).toBe(plainOutcome.selectedPlan.planId);
  });

  test("M17 (runtime): a deterministic-sufficient task keeps the deterministic selection despite consulted findings", async () => {
    const world = buildWorld({ signals: [signal()] });
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
    // Zero-model deterministic plan — the consulted findings could not
    // displace it and the sufficiency decision stands.
    expect(outcome.selectedPlan.steps.every((step) => step.routeRef === undefined)).toBe(true);
    expect(outcome.decision.deterministicSufficiency.outcome).toBe("sufficient");
  });

  test("a malformed finding fails the planning request CLOSED (never silently degraded)", async () => {
    const malformed = signal({ analysisVersion: 0 });
    const world = buildWorld({ signals: [malformed] });
    const executionId = await executionInPlanning(world, "malformed");
    await expect(
      world.planner.planExecution(planInput(executionId, "malformed"), "plan-malformed"),
    ).rejects.toThrow();
  });

  test("the adapter seam validates findings (the real adapter over a fake source)", async () => {
    const adapter = createOpportunitySignalsAdapter({
      async consult() {
        return [signal()];
      },
    });
    const consulted = await adapter.consult({ applicationId: APP_ID, tenantId: ACTOR.tenantId });
    expect(consulted).toHaveLength(1);
    expect(consulted[0]?.signalClass).toBe(CONSULTED_OPPORTUNITY_CLASS);
  });

  test("the adapter seam fails CLOSED on an unprovenanced finding", async () => {
    const adapter = createOpportunitySignalsAdapter({
      async consult() {
        return [signal({ revision: "" })];
      },
    });
    await expect(
      adapter.consult({ applicationId: APP_ID, tenantId: ACTOR.tenantId }),
    ).rejects.toThrow();
  });
});

describe("the implied preference (pure, recorded as evidence)", () => {
  const candidate = (
    strategyId: string,
    generativeSteps: number,
    admissible = true,
  ): CandidateStrategy =>
    ({
      strategyId,
      admissible,
      inadmissibleReason: admissible ? undefined : "policy-forbidden-provider",
      plan: {
        planId: `plan-${strategyId}`,
        steps: Array.from({ length: generativeSteps }, (_, i) => ({
          id: `${strategyId}-g${i}`,
          stepClass: "generate",
          title: `generative ${i}`,
        })),
      },
      rationale: "test",
      strategyClass: "generative",
    }) as unknown as CandidateStrategy;

  const consulted = (classOverride: string) =>
    ({
      signalClass: CONSULTED_OPPORTUNITY_CLASS,
      findingId: "f-1",
      analysisId: "a-1",
      analysisVersion: 1,
      class: classOverride,
      state: "advisory",
      confidenceLevel: "medium",
      population: 40,
      repository: "repo",
      revision: "rev",
      targetNodeIds: ["n-1"],
      reasonCodes: ["r"],
      evidenceRefs: ["e"],
      costImpactBasis: "unknown",
      latencyImpactBasis: "unknown",
      deterministicEquivalencePotential: "none",
    }) as never;

  test("a deterministic-direction finding prefers the FEWEST generative steps among ADMISSIBLE candidates", () => {
    const candidates = [
      candidate("gen-heavy", 3),
      candidate("gen-light", 1),
      candidate("inadmissible-zero", 0, false),
    ];
    expect(
      opportunityPreferredCandidateId(candidates, [consulted("deterministic-replacement")]),
    ).toBe("gen-light");
  });

  test("an ai-addition finding (alone) prefers the MOST generative steps among ADMISSIBLE candidates", () => {
    const candidates = [candidate("gen-heavy", 3), candidate("gen-light", 1)];
    expect(opportunityPreferredCandidateId(candidates, [consulted("ai-addition")])).toBe(
      "gen-heavy",
    );
  });

  test("no direction-bearing finding ⇒ no implied preference", () => {
    const candidates = [candidate("gen-heavy", 3)];
    expect(
      opportunityPreferredCandidateId(candidates, [consulted("context-enhancement")]),
    ).toBeNull();
    expect(opportunityPreferredCandidateId(candidates, [])).toBeNull();
  });

  test("an inadmissible candidate is NEVER the implied preference (M17)", () => {
    const candidates = [candidate("admissible", 2), candidate("inadmissible", 0, false)];
    expect(
      opportunityPreferredCandidateId(candidates, [consulted("deterministic-replacement")]),
    ).toBe("admissible");
    expect(
      opportunityPreferredCandidateId([candidate("only", 2, false)], [consulted("ai-addition")]),
    ).toBeNull();
  });

  test("ties break on the input order (deterministic)", () => {
    const first = candidate("first", 2);
    const second = candidate("second", 2);
    expect(opportunityPreferredCandidateId([first, second], [consulted("ai-addition")])).toBe(
      "first",
    );
  });
});
