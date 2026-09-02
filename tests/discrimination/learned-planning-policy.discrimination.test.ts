/**
 * Discrimination: the learned planning-policy boundary (WORK-020 /
 * LRN-002 CRITICAL boundaries; checkpoint contracts
 * LEARNING-NONAUTHORITY, IMPLEMENTATION-COMPLETENESS,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * SELF-HOSTING-BOUNDARY).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013 red-record pattern): STATIC mutants mutate the REAL source
 * in memory and the shared scanners must flag exactly the weakened
 * protection; RUNTIME red records observe the governed world under
 * constructed wiring scenarios (the full in-memory learned-policy
 * stack through the REAL planning adapter into the REAL planner).
 *
 * Mutant map (M-numbers continue the WORK-020 ledger):
 *   M1  the service gains an authority dep (policy);
 *   M2  the frozen non-authority class pin removed;
 *   M3  'shadow' becomes a publication mode (silent authority);
 *   M4  a learned-policy update/delete surface appears;
 *   M5  restriction vocabulary appears in the learning domain;
 *   M6  the ran-in-canary gate removed;
 *   M7  the promoted-requires-both gate removed;
 *   M8  the consultation moves BEFORE the admissibility filter;
 *   M9  the promoted-only ordering gate removed (canary orders);
 *   M10 the CURRENT-policy recheck on the ordering removed;
 *   M11 the adapter restriction-vocabulary scan removed;
 *   M12 the adapter anchor validation removed;
 *   M13 the learned branch displaces deterministic-first;
 *   M14 the durable selection is rebound to the learned preference.
 *
 * Runtime red records:
 *   R1  a canary publication NEVER changes the live selection;
 *   R2  promoted publication WITHOUT canary evidence fails closed;
 *   R3  a restriction-smuggled learned output is POLICY_DENIED at the
 *       seam (even from a compromised learning source);
 *   R4  a learned recommendation whose top subject the current policy
 *       forbids NEVER authorizes that route;
 *   R5  rollback is deterministic — the prior version's ordering
 *       returns verbatim and history is byte-identical;
 *   R6  retries converge (generation replay + publication replay).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
} from "../../src/modules/learning/public";
import {
  createLearnedPolicyAdapter,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
  type ResolvedPolicyInputs,
} from "../../src/modules/planning/public";
import type { RestrictionSet } from "../../src/modules/policies/public";
import { PlatformError } from "../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../unit/executions/fakes";
import {
  type LearningBoundaryFile,
  learnedPolicyNonAuthorityViolations,
  plannerLearnedPolicyViolations,
} from "./lib/learned-policy";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");

function collectLearningTree(): LearningBoundaryFile[] {
  const out: LearningBoundaryFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({
          path: full.slice(REPO_ROOT.length + 1),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(LEARNING_DIR);
  return out;
}

function withMutation(path: string, mutation: (content: string) => string): LearningBoundaryFile[] {
  return collectLearningTree().map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

const PLANNER_PATH = "src/modules/planning/application/planner.ts";
const ADAPTER_PATH = "src/modules/planning/adapters/learned-policy-adapter.ts";
const STRATEGY_PATH = "src/modules/planning/domain/strategy.ts";

// ---------------------------------------------------------------------------
// STATIC red records: every weakened protection is detected.
// ---------------------------------------------------------------------------

describe("discrimination: learned-policy non-authority (static mutants)", () => {
  test("the REAL learning tree passes the scanner (baseline)", () => {
    expect(learnedPolicyNonAuthorityViolations(collectLearningTree())).toEqual([]);
  });

  test("M1: the learned-policy service gaining an authority dep is detected", () => {
    const tree = withMutation(
      "src/modules/learning/application/learned-policy-service.ts",
      (content) =>
        content.replace(
          "export interface LearnedPolicyServiceDeps {",
          "export interface LearnedPolicyServiceDeps {\n  readonly policy: unknown;",
        ),
    );
    expect(tree).not.toEqual(collectLearningTree());
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain(
      "learned-policy-service-authority-deps:policy",
    );
  });

  test("M2: removing the frozen non-authority class pin is detected", () => {
    const tree = withMutation("src/modules/learning/domain/learned-planning-policy.ts", (content) =>
      content.replace("policy.policyClass !== LEARNED_POLICY_CLASS", "false"),
    );
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain("learned-policy-class-unpinned");
  });

  test("M3: 'shadow' becoming a publication mode is detected (silent authority)", () => {
    const tree = withMutation("src/modules/learning/domain/learned-planning-policy.ts", (content) =>
      content.replace(
        'export const LEARNED_POLICY_PUBLICATION_MODES = ["canary", "promoted"] as const;',
        'export const LEARNED_POLICY_PUBLICATION_MODES = ["canary", "promoted", "shadow"] as const;',
      ),
    );
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain(
      "publication-mode-vocabulary-mutated",
    );
  });

  test("M4: a learned-policy update/delete surface is detected", () => {
    const tree = withMutation(
      "src/modules/learning/adapters/in-memory-learned-policy-store.ts",
      (content) => `${content}\nasync updateLearnedPolicy() {}\n`,
    );
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain(
      "learned-policy-mutation-surface:src/modules/learning/adapters/in-memory-learned-policy-store.ts",
    );
  });

  test("M5: restriction vocabulary appearing in the learning domain is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/learned-planning-policy.ts",
      (content) => `${content}\nexport const smuggled = { deniedProviders: ["rail-b"] };\n`,
    );
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain(
      "restriction-vocabulary-in-learning",
    );
  });

  test("M6: removing the ran-in-canary gate is detected", () => {
    const tree = withMutation(
      "src/modules/learning/application/learned-policy-service.ts",
      (content) =>
        content.replace(
          "a canary evaluation requires a durable canary publication of this exact policy version (the ran-in-canary proof — fail closed)",
          "a canary evaluation may proceed without a publication (mutant)",
        ),
    );
    expect(learnedPolicyNonAuthorityViolations(tree)).toContain(
      "canary-requires-publication-gate-removed",
    );
  });

  test("M7: removing the publication evidence gates is detected", () => {
    const canaryGate = withMutation(
      "src/modules/learning/application/learned-policy-service.ts",
      (content) =>
        content.replace(
          "a canary publication requires a completed shadow evaluation of this exact policy version (shadow runs before canary)",
          "a canary publication needs no shadow evaluation (mutant)",
        ),
    );
    expect(learnedPolicyNonAuthorityViolations(canaryGate)).toContain(
      "publication-evidence-gates-removed:canary-requires-shadow",
    );

    const promotedGate = withMutation(
      "src/modules/learning/application/learned-policy-service.ts",
      (content) =>
        content.replace(
          "a promoted publication requires BOTH a shadow and a canary evaluation of this exact policy version (shadow/canary before promotion)",
          "a promoted publication needs no evidence (mutant)",
        ),
    );
    expect(learnedPolicyNonAuthorityViolations(promotedGate)).toContain(
      "publication-evidence-gates-removed:promoted-requires-both",
    );
  });
});

describe("discrimination: planner learned-policy consumption (static mutants)", () => {
  const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
  const adapterSource = readFileSync(join(REPO_ROOT, ADAPTER_PATH), "utf8");
  const strategySource = readFileSync(join(REPO_ROOT, STRATEGY_PATH), "utf8");

  test("the REAL planner/adapter/strategy pass the scanner (baseline)", () => {
    expect(plannerLearnedPolicyViolations(plannerSource, adapterSource, strategySource)).toEqual(
      [],
    );
  });

  test("M8: moving the consultation BEFORE the admissibility filter is detected", () => {
    const mutated = plannerSource.replace(
      "      const admissibleCandidates = candidates.map((candidate) =>",
      "      if (deps.learnedPolicy !== undefined) {\n        await deps.learnedPolicy.consult({\n          applicationId: input.applicationId,\n          tenantId: input.tenantId,\n          taskClass: profile.kind,\n        });\n      }\n      const admissibleCandidates = candidates.map((candidate) =>",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(plannerLearnedPolicyViolations(mutated, adapterSource, strategySource)).toContain(
      "consultation-before-admissibility",
    );
  });

  test("M9: removing the promoted-only ordering gate is detected (canary would order)", () => {
    const mutated = plannerSource.replace(
      'if (view.publicationMode === "promoted") {',
      "if (true) {",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(plannerLearnedPolicyViolations(mutated, adapterSource, strategySource)).toContain(
      "promoted-only-ordering-removed",
    );
  });

  test("M10: removing the CURRENT-policy recheck on the ordering is detected", () => {
    const mutated = plannerSource.replace(
      "const ordering = learnedOrderingSubjects(preference, effective);",
      "const ordering = preference.ranked.map((metric) => metric.subjectKey);",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(plannerLearnedPolicyViolations(mutated, adapterSource, strategySource)).toContain(
      "policy-recheck-removed",
    );
  });

  test("M11: removing the adapter's restriction-vocabulary scan is detected", () => {
    const mutated = adapterSource.replace(
      "assertLearnedOutputFreeOfRestrictions(view.policy);",
      "",
    );
    expect(mutated).not.toBe(adapterSource);
    expect(plannerLearnedPolicyViolations(plannerSource, mutated, strategySource)).toContain(
      "adapter-restriction-scan-removed",
    );
  });

  test("M12: removing the adapter's anchor validation is detected", () => {
    const mutated = adapterSource.replace("validateConsultedLearnedPolicy(consulted);", "");
    expect(mutated).not.toBe(adapterSource);
    expect(plannerLearnedPolicyViolations(plannerSource, mutated, strategySource)).toContain(
      "adapter-validation-removed",
    );
  });

  test("M13: displacing the deterministic-first branch is detected", () => {
    // The mutant inserts a learned-ordering early return BEFORE the
    // deterministic-sufficient branch — a learned preference would
    // displace a deterministic-sufficient selection (ADR-0007 removed).
    const mutated = strategySource.replace(
      '  if (sufficiency.outcome === "sufficient") {',
      '  if (learnedOrder !== undefined && learnedOrder.length > 0) {\n    const mutantOrdered = [...satisfying].sort((a, b) => compareLearnedThenCheapFirst(a, b, learnedOrder));\n    const mutantBest = mutantOrdered[0];\n    return {\n      kind: "selected",\n      selected: mutantBest,\n      deterministicFirstApplied: false,\n      rationale: "mutant: learned ordering displaces deterministic-first",\n    };\n  }\n  if (sufficiency.outcome === "sufficient") {',
    );
    expect(mutated).not.toBe(strategySource);
    expect(plannerLearnedPolicyViolations(plannerSource, adapterSource, mutated)).toContain(
      "deterministic-first-displaced",
    );
  });

  test("M14: rebinding the durable selection to the learned preference is detected", () => {
    const mutated = plannerSource.replace(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
      "selectedStrategyId: learnedPolicyConsultation?.preferredStrategyId ?? selected.strategyId,\n        selectionRationale: selection.rationale,",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(plannerLearnedPolicyViolations(mutated, adapterSource, strategySource)).toContain(
      "selection-reference-mutated",
    );
  });
});

// ---------------------------------------------------------------------------
// RUNTIME red records: the governed world under production wiring.
// ---------------------------------------------------------------------------

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

interface DiscriminationWorld {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly learnedService: LearnedPolicyService;
  readonly learningStore: ReturnType<typeof createInMemoryLearningStore>;
}

async function buildWorld(
  options: { readonly policy?: RestrictionSet; readonly source?: LearningLearnedPolicySource } = {},
): Promise<DiscriminationWorld> {
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

  // The observed population prefers rail-a (11/12 successes) over
  // rail-b (5/12) — the OPPOSITE of the governed cheap-first pick.
  for (const [route, successes, cost] of [
    [{ provider: "rail-a", model: "model-x" }, 11, "1000"],
    [{ provider: "rail-b", model: "model-y" }, 5, "200"],
  ] as const) {
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
        routes: [route],
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
        costMicroUsd: cost,
        latencyMs: 1500,
        outcome: index < successes ? "execution-completed" : "execution-failed",
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
        `fingerprint-${route.provider}-${index}`,
      );
    }
  }
  await learningService.buildScorecard({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    definitionId: "route-outcome-by-task-class",
  });

  const source =
    options.source === undefined ? createLearnedPolicySource(learnedService) : options.source;
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
          "../../src/modules/planning/adapters/in-memory-deterministic-catalog"
        );
        return DETERMINISTIC_CATALOG_SEED;
      },
    },
    sink: createPlanningSinkAdapter(executions.service),
    digest: createNodeDigest(),
    generateId: executions.generateId,
    now: clock,
    learnedPolicy: createLearnedPolicyAdapter(source),
  });
  return { planner, executions, learnedService, learningStore };
}

async function plan(
  world: DiscriminationWorld,
  key: string,
): Promise<ReturnType<Awaited<ReturnType<typeof buildWorld>>["planner"]["planExecution"]>> {
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
  return world.planner.planExecution(
    {
      applicationId: APP_ID,
      executionId,
      tenantId: ACTOR.tenantId,
      actorId: ACTOR.actorId,
      task: { kind: "generation", input: { text: "artifact-1" } },
    },
    `plan-exec-${key}`,
  );
}

async function publish(service: LearnedPolicyService, mode: "canary" | "promoted"): Promise<void> {
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
  await service.publishLearnedPolicy({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    policyId: policy.policyId,
    publicationMode: "canary",
    publishedBy: "operator-1",
    evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
  });
  if (mode === "promoted") {
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
}

describe("discrimination: learned-policy runtime red records", () => {
  test("R1: an ACTIVE canary publication NEVER changes the live selection (M-canary)", async () => {
    const world = await buildWorld();
    await publish(world.learnedService, "canary");
    const outcome = await plan(world, "r1-canary");
    expect(outcome.decision.selectedStrategyId).toBe("generative:rail-b/model-y");
    expect(outcome.decision.learnedPolicyConsultation?.appliedToSelection).toBe(false);
    expect(outcome.decision.learnedPolicyConsultation?.preferredStrategyId).toBe(
      "generative:rail-a/model-x",
    );
  });

  test("R2: a promoted publication WITHOUT canary evidence fails closed (the explicit gate)", async () => {
    const world = await buildWorld();
    const { policy } = await world.learnedService.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    const { evaluation: shadow } = await world.learnedService.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    // Only a shadow evaluation — promoted requires shadow + canary.
    await expect(
      world.learnedService.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: ACTOR.tenantId,
        policyId: policy.policyId,
        publicationMode: "promoted",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
      }),
    ).rejects.toThrow(/BOTH a shadow and a canary/);
    // Nothing was published ⇒ the planner is the baseline.
    const outcome = await plan(world, "r2-gate");
    expect(outcome.decision.learnedPolicyConsultation).toBeUndefined();
    expect(outcome.decision.selectedStrategyId).toBe("generative:rail-b/model-y");
  });

  test("R3: a restriction-smuggled learned output is POLICY_DENIED at the seam (even from a compromised source)", async () => {
    const healthy = await buildWorld();
    await publish(healthy.learnedService, "promoted");
    const view = (await createLearnedPolicySource(healthy.learnedService).consult({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    })) as ActiveLearnedPolicyView;
    const smuggled: ActiveLearnedPolicyView = {
      policy: {
        ...view.policy,
        preferences: [
          {
            ...view.policy.preferences[0],
            ranked: [...(view.policy.preferences[0]?.ranked ?? [])],
            maxCostMicroUsd: "1",
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

  test("R4: a learned recommendation whose top subject the CURRENT policy forbids NEVER authorizes it", async () => {
    const world = await buildWorld({
      policy: { providerModel: { deniedProviders: ["rail-a"] } },
    });
    await publish(world.learnedService, "promoted");
    const outcome = await plan(world, "r4-forbidden");
    expect(outcome.decision.selectedStrategyId).toBe("generative:rail-b/model-y");
    expect(outcome.decision.learnedPolicyConsultation?.rejectedByPolicy).toContain(
      "rail-a/model-x",
    );
    expect(outcome.selectedPlan.steps.some((step) => step.routeRef?.provider === "rail-a")).toBe(
      false,
    );
  });

  test("R5: rollback is deterministic — the prior version's ordering returns verbatim", async () => {
    const world = await buildWorld();
    // v1 prefers rail-a; promote it.
    await publish(world.learnedService, "promoted");
    const v1View = await world.learnedService.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(v1View?.policy.policyVersion).toBe(1);
    const promotedOutcome = await plan(world, "r5-promoted");
    expect(promotedOutcome.decision.selectedStrategyId).toBe("generative:rail-a/model-x");

    // NEW population → version 2 whose preference flips to rail-b
    // (24 fresh rail-b successes + 12 rail-a failures).
    for (const [route, count, successes, cost] of [
      [{ provider: "rail-b", model: "model-y" }, 24, 24, "200"],
      [{ provider: "rail-a", model: "model-x" }, 12, 0, "1000"],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        await world.learningStore.ingestTelemetry(
          {
            telemetryId: generateId(),
            recordedAt: new Date(Date.parse("2026-09-15T11:45:00Z") + index * 1000).toISOString(),
            executionId: generateId(),
            applicationId: APP_ID,
            tenantId: ACTOR.tenantId,
            taskClass: "generation",
            capabilities: ["text-generation"],
            planId: "plan-1",
            planRevision: 1,
            strategyClass: "generative",
            routes: [route],
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
            costMicroUsd: cost,
            latencyMs: 1500,
            outcome: index < successes ? "execution-completed" : "execution-failed",
            evidenceRefs: [`execution:v2:${index}:receipt`],
            subgraphs: [],
            schemaVersion: 1,
          },
          `fingerprint-v2-${route.provider}-${index}`,
        );
      }
    }
    await publish(world.learnedService, "promoted");
    const v2Outcome = await plan(world, "r5-v2");
    expect(v2Outcome.decision.learnedPolicyConsultation?.consultedPolicy.policyVersion).toBe(2);
    // v2 prefers rail-b — which is also the governed cheap-first pick
    // (the refinement converges with the default; honest).
    expect(v2Outcome.decision.selectedStrategyId).toBe("generative:rail-b/model-y");

    // ROLLBACK to v1: an ordinary journal append of v1's promoted mode
    // with its evidence verbatim — the selection deterministically
    // returns to v1's ordering (rail-a).
    const rollback = await world.learnedService.rollbackLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      toPolicyId: v1View?.policy.policyId as string,
      publishedBy: "operator-9",
    });
    expect(rollback.publicationReason).toBe("rollback");
    expect(rollback.policyVersion).toBe(1);
    const afterRollback = await plan(world, "r5-rollback");
    expect(afterRollback.decision.selectedStrategyId).toBe("generative:rail-a/model-x");
    expect(afterRollback.decision.learnedPolicyConsultation?.consultedPolicy.policyVersion).toBe(1);
    // The v2 policy version and its publications remain durable history.
    const v2 = await world.learnedService.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(v2?.publication.publicationId).toBe(rollback.publicationId);
  });

  test("R6: retries converge (generation replay + publication replay)", async () => {
    const world = await buildWorld();
    const first = await world.learnedService.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    const retry = await world.learnedService.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.policy.policyId).toBe(first.policy.policyId);

    await publish(world.learnedService, "canary");
    const active = await world.learnedService.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(active?.publication.publicationMode).toBe("canary");
    // Re-publishing the same logical request converges (one journal entry).
    const shadow = await world.learnedService.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      policyId: first.policy.policyId,
      evaluationClass: "shadow",
    });
    const again = await world.learnedService.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      policyId: first.policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadow.evaluation.evaluationId }],
    });
    const journal = await world.learnedService.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(again.publicationId).toBe(journal?.publication.publicationId);
  });
});
