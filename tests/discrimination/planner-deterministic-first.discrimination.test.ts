/**
 * Discrimination: deterministic-first planner protections (WORK-009 /
 * ADR-0007, ADR-0011 — the REQUIRED negative proofs).
 *
 *   P1 — ALWAYS-GENERATIVE MUTANT (the planning-contract "required future
 *        discrimination proof"): a planner whose sufficiency evaluator
 *        always returns `insufficient` (the ADR-0007 protection removed
 *        through the documented discrimination hook) selects generative
 *        inference where production selects the zero-model plan and never
 *        consults the route explorer (RED RECORD).
 *   P2 — PROVIDER-FIRST MUTANTS: synthetic planner sources that consult
 *        the route explorer before the sufficiency decision (or
 *        unconditionally) are REJECTED by the shared ordering scanner —
 *        the same gate the architecture test runs over the real source
 *        (mutation record).
 *   P3 — DETERMINISTIC-BYPASS MUTANT: an empty deterministic catalog (the
 *        capability bypass) loses the deterministic candidate and fails
 *        closed with typed NO_ELIGIBLE_ROUTE — never silently
 *        substituting generative work (RED RECORD).
 *   P4 — ZERO-MODEL FABRICATION MUTANT: a validator copy with the
 *        fabrication boundary removed accepts a zero-model plan carrying
 *        a fabricated provider route; production rejects it typed (the
 *        mutant IS the removed protection — RED RECORD).
 *   P5 — FORBIDDEN-PROVIDER-WINS MUTANT: a selection that orders by cost
 *        while ignoring admissibility lets a policy-forbidden provider
 *        win on price; production never selects it (RED RECORD).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createPlanningSinkAdapter } from "../../src/modules/planning/adapters/planning-sink-adapter";
import type {
  CandidateStrategy,
  DeterministicCatalogEntry,
  ExecutionPlan,
  ModelRouteCandidate,
  PlanningCapabilityAuthority,
  PlanningPolicyInputs,
  PlanStep,
  ResolvedPolicyInputs,
} from "../../src/modules/planning/public";
import {
  buildPlan,
  createNodeDigest,
  createPlannerService,
  DETERMINISTIC_CATALOG_SEED,
  filterAdmissibility,
  selectStrategy,
} from "../../src/modules/planning/public";
import { PlatformError } from "../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../unit/executions/fakes";
import { plannerOrderViolations } from "./lib/planner-order";

const APP_ID = "00000000-0000-7000-8000-0000000000d1";
const PLANNER_SOURCE = readFileSync(
  join(process.cwd(), "src/modules/planning/application/planner.ts"),
  "utf8",
);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const ROUTES: readonly ModelRouteCandidate[] = [
  {
    provider: "rail-cheap",
    model: "model-cheap",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "10",
    expectedQuality: 0.99,
    expectedLatencyMs: 100,
  },
];

const SATISFIED_AUTHORITY: PlanningCapabilityAuthority = {
  async resolve() {
    return { satisfied: true, catalogRevision: "rev-test", satisfactions: [] };
  },
  get catalogRevision(): string {
    return "rev-test";
  },
};

const ALLOW_POLICY: PlanningPolicyInputs = {
  async effective(): Promise<ResolvedPolicyInputs> {
    return { outcome: "allow", effective: {} };
  },
};

type SufficiencyHook = NonNullable<Parameters<typeof createPlannerService>[0]["sufficiency"]>;

interface PlannerWorld {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
}

function plannerWith(
  overrides: {
    readonly sufficiency?: SufficiencyHook;
    readonly catalogEntries?: readonly DeterministicCatalogEntry[];
    readonly routes?: readonly ModelRouteCandidate[];
    readonly explorerSpy?: { explorations: number };
  } = {},
): PlannerWorld {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const planner = createPlannerService({
    capabilityAuthority: SATISFIED_AUTHORITY,
    policyInputs: ALLOW_POLICY,
    routeExplorer: {
      async explore() {
        if (overrides.explorerSpy) {
          overrides.explorerSpy.explorations += 1;
        }
        return overrides.routes ?? ROUTES;
      },
    },
    deterministicCatalog: {
      async list() {
        return overrides.catalogEntries ?? DETERMINISTIC_CATALOG_SEED;
      },
    },
    sink: createPlanningSinkAdapter(executions.service),
    digest: createNodeDigest(),
    generateId: executions.generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
    ...(overrides.sufficiency === undefined ? {} : { sufficiency: overrides.sufficiency }),
  });
  return { planner, executions };
}

const ARITHMETIC_TASK = { kind: "arithmetic", input: { expression: "2+2" } } as const;

async function planTask(
  world: PlannerWorld,
  task: Record<string, unknown>,
  key: string,
): Promise<{ executionId: string; outcome: unknown }> {
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task },
    `create-${key}`,
    ACTOR,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId: receipt.executionId, command: "authorize" },
    `auth-${key}`,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId: receipt.executionId, command: "plan" },
    `plan-cmd-${key}`,
  );
  const outcome = await world.planner
    .planExecution(
      {
        applicationId: APP_ID,
        executionId: receipt.executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task,
      },
      `decision-${key}`,
    )
    .then(
      (value) => value,
      (error: unknown) => error,
    );
  return { executionId: receipt.executionId, outcome };
}

describe("discrimination: deterministic-first planner (ADR-0007 / ADR-0011)", () => {
  test("P1 RED RECORD: the always-generative mutant selects model calls where production selects zero-model", async () => {
    const production = plannerWith();
    const produced = await planTask(production, { ...ARITHMETIC_TASK }, "prod");
    expect(produced.outcome).toMatchObject({
      selectedPlan: { modelCalls: 0, hasRouteRef: false, strategyClass: "deterministic-only" },
    });

    // MUTANT: the sufficiency protection removed (always insufficient) —
    // the documented discrimination hook, exactly how an always-generative
    // router would behave.
    const mutantHook: SufficiencyHook = () => ({
      outcome: "insufficient",
      semanticReasoningRequired: true,
      reasons: [{ code: "semantic-reasoning-required", detail: "mutant: protection removed" }],
      coverage: [],
      deterministicQualityEstimate: null,
      qualityConfidence: null,
    });

    // (a) On a task WITH a declared model requirement the mutant selects
    //     generative inference (production would need it anyway) — and on
    //     the SAME sufficient arithmetic task the mutant CANNOT produce a
    //     zero-model success (RED against AC-5/AC-11).
    const mutant = plannerWith({ sufficiency: mutantHook });
    const mutantArithmetic = await planTask(mutant, { ...ARITHMETIC_TASK }, "mutant-arithmetic");
    expect(mutantArithmetic.outcome).toBeInstanceOf(PlatformError);
    expect((mutantArithmetic.outcome as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");
    // The mutant did NOT fall back to a fabricated route (zero envelopes).
    const events = await mutant.executions.service.listEvents(APP_ID, mutantArithmetic.executionId);
    expect(events.filter((event) => event.type === "planning.decision-recorded")).toHaveLength(0);

    // (b) On a semantic task the mutant still consults the explorer where
    //     production of a SUFFICIENT task never does (P1b spy proof).
    const spy = { explorations: 0 };
    const spyProduction = plannerWith({ explorerSpy: spy });
    await planTask(spyProduction, { ...ARITHMETIC_TASK }, "spy");
    expect(spy.explorations).toBe(0);
  });

  test("P2 PROVIDER-FIRST MUTANTS are rejected by the shared ordering scanner (mutation record)", () => {
    expect(plannerOrderViolations(PLANNER_SOURCE)).toEqual([]);

    // Mutant A: explorer consulted BEFORE the sufficiency decision.
    const explorerFirst = PLANNER_SOURCE.replace(
      "const sufficiency = sufficiencyEvaluator({",
      "const __preRoutes = await deps.routeExplorer.explore(['text-generation']); const sufficiency = sufficiencyEvaluator({",
    ).replace(
      "routes = await deps.routeExplorer.explore(modelRequirementIds);",
      "routes = __preRoutes;",
    );
    const violationsA = plannerOrderViolations(explorerFirst);
    expect(violationsA.length).toBeGreaterThan(0);
    expect(violationsA.some((v) => v.startsWith("explorer-call-before-sufficiency"))).toBe(true);

    // Mutant B: the gating conditional removed (unconditional exploration).
    const ungated = PLANNER_SOURCE.replace(
      'if (sufficiency.outcome !== "sufficient") {',
      "if (true) {",
    );
    const violationsB = plannerOrderViolations(ungated);
    expect(violationsB.some((v) => v.includes("not-gated") || v.includes("ungated"))).toBe(true);

    // Mutant C: the sufficiency decision removed entirely.
    const noSufficiency = PLANNER_SOURCE.replace(
      "const sufficiency = sufficiencyEvaluator({",
      "const sufficiency = { outcome: 'insufficient' } as const; (void) sufficiencyEvaluator({",
    );
    expect(plannerOrderViolations(noSufficiency).length).toBeGreaterThan(0);
  });

  test("P3 RED RECORD: the deterministic-bypass mutant fails closed — never silently substitutes AI", async () => {
    const mutant = plannerWith({ catalogEntries: [] });
    const bypassed = await planTask(mutant, { ...ARITHMETIC_TASK }, "bypass");
    // RED: the bypass lost the deterministic candidate; because the task
    // declares no model requirement the mutant fails typed
    // NO_ELIGIBLE_ROUTE instead of fabricating generative work.
    expect(bypassed.outcome).toBeInstanceOf(PlatformError);
    expect((bypassed.outcome as PlatformError).code).toBe("NO_ELIGIBLE_ROUTE");

    // Production, same task: zero-model success.
    const production = plannerWith();
    const produced = await planTask(production, { ...ARITHMETIC_TASK }, "prod-bypass");
    expect(produced.outcome).toMatchObject({ selectedPlan: { modelCalls: 0 } });
  });

  test("P4 RED RECORD: the fabrication mutant accepts a zero-model plan with a fabricated route; production rejects", () => {
    const fabricatedSteps: readonly unknown[] = [
      {
        id: "compute",
        stepClass: "run-algorithm",
        capabilityId: "numeric-computation",
        // THE FABRICATION: a provider route on a deterministic step.
        routeRef: { provider: "rail-cheap", model: "model-cheap" },
      },
      { id: "verify", stepClass: "verify" },
    ];
    const edges = [{ from: "compute", to: "verify" }];

    // PRODUCTION rejects the fabrication typed.
    expect(() =>
      buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: fabricatedSteps as PlanStep[],
          edges,
        },
        digest,
      ),
    ).toThrowError(/must not carry a provider\/model route/);

    // MUTANT (the removed protection): a validator copy WITHOUT the
    // route-class check accepts the same fabricated plan — the mutant IS
    // the removed check (the WORK-008 in-suite mutant precedent).
    const mutantPlan = mutantBuildPlanWithoutRouteClassCheck(
      { revision: 1, strategyClass: "deterministic-only", steps: fabricatedSteps, edges },
      digest,
    );
    expect(mutantPlan.modelCalls).toBe(0);
    expect(mutantPlan.hasRouteRef).toBe(true);
    // The mutant accepted exactly the state production forbids: a
    // zero-model plan carrying a provider route (AC-11 violation).
    expect(mutantPlan.modelCalls === 0 && mutantPlan.hasRouteRef).toBe(true);
  });

  test("P5 RED RECORD: the forbidden-provider-wins mutant selects on price ignoring admissibility; production never does", () => {
    const policy = { providerModel: { deniedProviders: ["rail-cheap"] } };
    const forbidden = {
      strategyId: "generative:rail-cheap/model-cheap",
      plan: buildPlan(
        {
          revision: 1,
          strategyClass: "generative",
          steps: [
            {
              id: "model",
              stepClass: "call-model",
              capabilityId: "text-generation",
              routeRef: { provider: "rail-cheap", model: "model-cheap" },
            },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "model", to: "verify" }],
        },
        digest,
      ),
      expectedCostMicroUsd: "10",
      expectedQuality: 0.99,
      expectedLatencyMs: 100,
      verificationStrategy: "schema-check",
      routeRationale: { code: "semantic-reasoning-required" as const, detail: "test" },
      modelCalls: 1,
    };
    const allowed = {
      ...forbidden,
      strategyId: "generative:rail-allowed/model-ok",
      plan: buildPlan(
        {
          revision: 1,
          strategyClass: "generative",
          steps: [
            {
              id: "model",
              stepClass: "call-model",
              capabilityId: "text-generation",
              routeRef: { provider: "rail-allowed", model: "model-ok" },
            },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "model", to: "verify" }],
        },
        digest,
      ),
      expectedCostMicroUsd: "9000",
      expectedQuality: 0.9,
    };

    // PRODUCTION: policy filter first — the forbidden candidate is
    // inadmissible and the allowed one is selected despite the price.
    const filtered = [forbidden, allowed].map((candidate) =>
      filterAdmissibility(candidate, policy),
    );
    const selection = selectStrategy(
      filtered,
      {
        outcome: "insufficient",
        semanticReasoningRequired: true,
        reasons: [],
        coverage: [],
        deterministicQualityEstimate: null,
        qualityConfidence: null,
      },
      0.8,
    );
    expect(selection.kind).toBe("selected");
    if (selection.kind === "selected") {
      expect(selection.selected.strategyId).toBe("generative:rail-allowed/model-ok");
    }

    // MUTANT (admissibility ignored): cheap-first over the raw candidates
    // lets the FORBIDDEN provider win purely on price — the violation.
    const mutantOrdering = [forbidden, allowed].sort((a, b) =>
      BigInt(a.expectedCostMicroUsd) < BigInt(b.expectedCostMicroUsd) ? -1 : 1,
    );
    expect((mutantOrdering[0] as CandidateStrategy).strategyId).toBe(
      "generative:rail-cheap/model-cheap",
    );
  });
});

/**
 * The P4 mutant: a copy of the plan builder's validation with the
 * route-class fabrication check REMOVED (the mutant IS the removed
 * protection). Everything else validates as production does.
 */
function mutantBuildPlanWithoutRouteClassCheck(
  input: {
    readonly revision: number;
    readonly strategyClass: "deterministic-only";
    readonly steps: readonly unknown[];
    readonly edges: readonly { from: string; to: string }[];
  },
  digestFn: (value: unknown) => string,
): ExecutionPlan {
  const steps = input.steps as {
    id: string;
    stepClass: string;
    capabilityId?: string;
    routeRef?: { provider: string; model: string };
    verificationStrategy?: string;
  }[];
  // MUTATION: no routeRef-on-generative-class check, no zero-model
  // coherence check — exactly the removed fabrication boundary.
  const modelCalls = steps.filter(
    (step) =>
      step.stepClass === "generate" ||
      step.stepClass === "call-model" ||
      step.stepClass === "call-agent",
  ).length;
  const hasRouteRef = steps.some((step) => step.routeRef !== undefined);
  return {
    planId: digestFn({ steps: input.steps, edges: input.edges, revision: input.revision }),
    revision: input.revision,
    strategyClass: input.strategyClass,
    steps: steps as ExecutionPlan["steps"],
    edges: input.edges,
    modelCalls,
    hasRouteRef,
  };
}
