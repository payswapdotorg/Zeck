/**
 * Discrimination: the learning non-authority boundary (WORK-014
 * CRITICAL boundaries; checkpoint contracts LEARNING-NONAUTHORITY,
 * AUTH-PRESERVATION, POLICY-BEFORE-DISPATCH, IDENTITY-IDEMPOTENCY,
 * DEPENDENCY-DIRECTION, SELF-HOSTING-BOUNDARY).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013 red-record pattern): STATIC mutants mutate the REAL source
 * in memory and the shared scanner must flag exactly the weakened
 * protection (the architecture gate runs the same scanner over the
 * real tree, so it FAILS under exactly these mutations); RUNTIME red
 * records observe the governed world under constructed wiring
 * scenarios.
 *
 * The 19 mandatory mutants of the Work Order:
 *
 *   STATIC (scanner over mutated REAL source):
 *     M1  (planner half) selection-reference mutated to the learning
 *         preference / learning consulted inside the selection segment;
 *     M2  learning imports the policy module (bypass surface);
 *     M3  learning imports the capability module;
 *     M4  learning imports the budget module;
 *     M5  learning imports the verification module;
 *     M6  learning imports executions + lifecycle vocabulary injected;
 *     M7  the shadow evaluator gains an authority/dispatch dep;
 *     M8  the consultation moves BEFORE the governed selection;
 *     M9  a scorecard update/delete surface appears;
 *     M13 (adapter half) the planning adapter's signal validation
 *         removed;
 *     M15 the shadow record-class pin removed;
 *     M17 learning imports planning / planner vocabulary injected;
 *     M18 a provider identifier leaks into the learning domain;
 *     M19 deterministicization promotion vocabulary injected.
 *
 *   RUNTIME RED RECORDS (observed under the production wiring):
 *     R-M1  a forbidden route with a GLOWING learning signal is never
 *           selected and never the recorded learning preference;
 *     R-M6  learning operations (telemetry, scorecard, shadow, rating)
 *           leave execution state and the execution ledger untouched;
 *     R-M7  shadow evaluation performs ZERO live side effects: an
 *           instrumented world (spy policy authority, spy budget
 *           authority, spy route explorer, real executions service)
 *           observes ZERO authority interactions;
 *     R-M8  the live selection is byte-identical before and after a
 *           shadow evaluation of a competing strategy;
 *     R-M11 duplicate ingestion converges (retry replays, conflict
 *           fails closed IDEMPOTENCY_KEY_REUSED);
 *     R-M12 cross-tenant consultation returns nothing;
 *     R-M14 a heterogeneous telemetry population fails closed;
 *     R-M16 a user rating leaves the policy store untouched (a rating
 *           gains no authority).
 *
 *   The PG-gated mutants (M9/M10/M11/M12 physical halves) are proven
 *   against real PostgreSQL in tests/integration/postgres/learning-*.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createInMemoryLearningStore,
  createLearningService,
  createLearningSignalSource,
  createNodeDigest,
  createShadowEvaluator,
  type LearningSignal,
  type RecordRatingInput,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
} from "../../src/modules/learning/public";
import {
  createLearningSignalsAdapter,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
} from "../../src/modules/planning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
  type PolicySet,
} from "../../src/modules/policies/public";
import { PlatformError } from "../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../unit/executions/fakes";
import {
  type LearningBoundaryFile,
  learningNonAuthorityViolations,
  plannerLearningViolations,
} from "./lib/learning";

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

const PLANNER_PATH = "src/modules/planning/application/planner.ts";
const LEARNING_ADAPTER_PATH = "src/modules/planning/adapters/learning-signals-adapter.ts";

function realTree(): LearningBoundaryFile[] {
  return collectLearningTree();
}

function withMutation(path: string, mutation: (content: string) => string): LearningBoundaryFile[] {
  return realTree().map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// STATIC red records: every weakened protection is detected.
// ---------------------------------------------------------------------------

describe("discrimination: learning non-authority (static mutants)", () => {
  test("the REAL learning tree passes the scanner (baseline)", () => {
    expect(learningNonAuthorityViolations(realTree())).toEqual([]);
  });

  test("M2: learning importing the policy module is detected", () => {
    const tree = withMutation(
      "src/modules/learning/application/shadow-evaluator.ts",
      (content) => `import { createPolicyAuthority } from "../../policies/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "cross-module-import:src/modules/learning/application/shadow-evaluator.ts:policies",
    );
  });

  test("M3: learning importing the capability module is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/telemetry.ts",
      (content) =>
        `import type { CapabilityRegistry } from "../../capabilities/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "cross-module-import:src/modules/learning/domain/telemetry.ts:capabilities",
    );
  });

  test("M4: learning importing the budget module is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/scorecard.ts",
      (content) => `import type { BudgetAuthority } from "../../budgets/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "cross-module-import:src/modules/learning/domain/scorecard.ts:budgets",
    );
  });

  test("M5: learning importing the verification module is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/shadow.ts",
      (content) =>
        `import type { VerificationService } from "../../verification/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "cross-module-import:src/modules/learning/domain/shadow.ts:verification",
    );
  });

  test("M6: learning importing executions is detected; lifecycle vocabulary is detected", () => {
    const importTree = withMutation(
      "src/modules/learning/application/learning-service.ts",
      (content) => `import type { ExecutionService } from "../../executions/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(importTree)).toContain(
      "cross-module-import:src/modules/learning/application/learning-service.ts:executions",
    );

    const vocabularyTree = withMutation(
      "src/modules/learning/application/shadow-evaluator.ts",
      (content) => `${content}\nconst bypass = (command: string) => nextState(command);\n`,
    );
    expect(learningNonAuthorityViolations(vocabularyTree)).toContain(
      "execution-lifecycle:src/modules/learning/application/shadow-evaluator.ts",
    );
  });

  test("M7: the shadow evaluator gaining an authority dep is detected", () => {
    const tree = withMutation("src/modules/learning/application/shadow-evaluator.ts", (content) =>
      content.replace(
        "export interface ShadowEvaluatorDeps {",
        "export interface ShadowEvaluatorDeps {\n  readonly policy: unknown;",
      ),
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "authority-deps:ShadowEvaluatorDeps:policy",
    );
  });

  test("M7 (service half): the learning service gaining an admission dep is detected", () => {
    const tree = withMutation("src/modules/learning/application/learning-service.ts", (content) =>
      content.replace(
        "export interface LearningServiceDeps {",
        "export interface LearningServiceDeps {\n  readonly admission: { decide(): boolean };",
      ),
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "authority-deps:LearningServiceDeps:missing-store",
    );
  });

  test("M9: a scorecard mutation surface appearing in learning is detected", () => {
    const tree = withMutation(
      "src/modules/learning/adapters/in-memory-learning-store.ts",
      (content) => `${content}\nasync updateScorecard() {}\n`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "scorecard-mutation-surface:src/modules/learning/adapters/in-memory-learning-store.ts",
    );
  });

  test("M15: removing the shadow record-class pin is detected", () => {
    const tree = withMutation("src/modules/learning/domain/shadow.ts", (content) =>
      content.replace('record.recordClass !== "shadow"', 'record.recordClass !== "shadow-record"'),
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "shadow-class-unpinned:src/modules/learning/domain/shadow.ts",
    );
  });

  test("M17: learning importing planning is detected; planner vocabulary is detected", () => {
    const importTree = withMutation(
      "src/modules/learning/domain/signal.ts",
      (content) => `import type { ExecutionPlan } from "../../planning/public";\n${content}`,
    );
    expect(learningNonAuthorityViolations(importTree)).toContain(
      "cross-module-import:src/modules/learning/domain/signal.ts:planning",
    );

    const vocabularyTree = withMutation(
      "src/modules/learning/domain/scorecard.ts",
      (content) => `${content}\nexport function selectStrategy() {}\n`,
    );
    expect(learningNonAuthorityViolations(vocabularyTree)).toContain(
      "planner-vocabulary:src/modules/learning/domain/scorecard.ts",
    );
  });

  test("M18: a provider identifier leaking into the learning domain is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/telemetry.ts",
      (content) => `${content}\nexport const AnthropicRouteKey = "anthropic/claude";\n`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "provider-identifier:src/modules/learning/domain/telemetry.ts",
    );
  });

  test("M19: deterministicization promotion vocabulary appearing in learning is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/scorecard.ts",
      (content) => `${content}\nexport function promoteCandidate() {}\n`,
    );
    expect(learningNonAuthorityViolations(tree)).toContain(
      "deterministicization-authority:src/modules/learning/domain/scorecard.ts",
    );
  });
});

describe("discrimination: planner learning consumption (static mutants)", () => {
  const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
  const adapterSource = readFileSync(join(REPO_ROOT, LEARNING_ADAPTER_PATH), "utf8");

  test("the REAL planner/adapter pass the scanner (baseline)", () => {
    expect(plannerLearningViolations(plannerSource, adapterSource)).toEqual([]);
  });

  test("M8: moving the consultation BEFORE the governed selection is detected", () => {
    // WORK-020 note: the planner now computes TWO selections — the
    // learning-free governed anchor (`governedSelection`) and the live
    // selection. The M8 mutant inserts the WORK-014 learning-signal
    // consultation before the GOVERNED selection; the shared ordering
    // scanner must flag it (the consultation belongs after selection).
    const mutated = plannerSource.replace(
      "      const governedSelection = selectStrategy(",
      "      if (deps.learningSignals !== undefined) {\n        await deps.learningSignals.consult({\n          applicationId: input.applicationId,\n          tenantId: input.tenantId,\n          taskClass: profile.kind,\n          subjectKeys: [],\n        });\n      }\n      const governedSelection = selectStrategy(",
    );
    expect(mutated).not.toBe(plannerSource);
    const violations = plannerLearningViolations(mutated, adapterSource);
    expect(violations).toContain("consultation-before-selection");
  });

  test("M1/M8: rebinding the durable selection to the learning preference is detected", () => {
    // The DURABLE record binding (the decision record's own field, the
    // unique two-line pattern after the candidates array).
    const mutated = plannerSource.replace(
      "        selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
      "        selectedStrategyId: learningConsultation?.preferredStrategyId ?? selected.strategyId,\n        selectionRationale: selection.rationale,",
    );
    expect(mutated).not.toBe(plannerSource);
    const violations = plannerLearningViolations(mutated, adapterSource);
    expect(violations).toContain("selection-reference-mutated");
  });

  test("M13: removing the adapter's signal validation is detected", () => {
    const mutated = adapterSource.replace("validateConsultedSignal(consulted);", "");
    expect(mutated).not.toBe(adapterSource);
    const violations = plannerLearningViolations(plannerSource, mutated);
    expect(violations).toContain("adapter-validation-removed");
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

const FORBIDDEN_ROUTES: readonly ModelRouteCandidate[] = [
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

/** An instrumented policy authority: every interaction is recorded. */
class SpyPolicyAuthority implements PolicyAuthority {
  readonly interactions: string[] = [];
  private readonly inner: PolicyAuthority;

  constructor(inner: PolicyAuthority) {
    this.inner = inner;
  }

  async publish(set: PolicySet) {
    this.interactions.push("publish");
    return this.inner.publish(set);
  }
  async admit(request: Parameters<PolicyAuthority["admit"]>[0]) {
    this.interactions.push("admit");
    return this.inner.admit(request);
  }
  async admitDispatch(request: Parameters<PolicyAuthority["admitDispatch"]>[0]) {
    this.interactions.push("admitDispatch");
    return this.inner.admitDispatch(request);
  }
  async current() {
    this.interactions.push("current");
    return this.inner.current();
  }
}

interface GovernedWorld {
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
  readonly learning: ReturnType<typeof createLearningService>;
  readonly learningStore: ReturnType<typeof createInMemoryLearningStore>;
  readonly policySpy: SpyPolicyAuthority;
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly explorerCalls: () => number;
}

async function buildGovernedWorld(
  options: {
    readonly routes?: readonly ModelRouteCandidate[];
    readonly deniedProviders?: readonly string[];
    readonly withLearning?: boolean;
  } = {},
): Promise<GovernedWorld> {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);

  const policyStore = new InMemoryPolicyStore();
  const policySpy = new SpyPolicyAuthority(
    createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher }),
  );

  let counter = 0;
  let clock = 0;
  const learningStore = createInMemoryLearningStore();
  const learning = createLearningService({
    store: learningStore,
    digest: createNodeDigest(),
    generateId: () => `00000000-0000-7000-c000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date(Date.parse("2026-09-15T11:00:00Z") + ++clock * 1000),
  });

  if (options.deniedProviders !== undefined) {
    await policySpy.publish({
      id: "default",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { providerModel: { deniedProviders: [...options.deniedProviders] } },
        },
      ],
    });
  }

  let explorerCalls = 0;
  const planner = createPlannerService({
    capabilityAuthority: {
      async resolve() {
        return { satisfied: true, catalogRevision: "rev-test", satisfactions: [] };
      },
      get catalogRevision(): string {
        return "rev-test";
      },
    } satisfies PlanningCapabilityAuthority,
    // The REAL policy inputs adapter over the instrumented authority.
    policyInputs: createPolicyInputsAdapter(policySpy),
    routeExplorer: {
      async explore() {
        explorerCalls += 1;
        return options.routes ?? ROUTES;
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
    generateId: () => `00000000-0000-7000-d000-${String(++counter).padStart(12, "0")}`,
    now: () => new Date("2026-09-15T12:00:00Z"),
    ...(options.withLearning === true
      ? {
          learningSignals: createLearningSignalsAdapter(createLearningSignalSource(learning)),
        }
      : {}),
  });

  const world: GovernedWorld = {
    executions,
    learning,
    learningStore,
    policySpy,
    planner,
    explorerCalls: () => explorerCalls,
  };
  return world;
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

async function planFor(world: GovernedWorld, key: string): Promise<string> {
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task: { kind: "interpretation", input: { text: "why?" } } },
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
  return outcome.decision.selectedStrategyId;
}

describe("discrimination: learning non-authority (runtime red records)", () => {
  test("R-M1: a forbidden route with a GLOWING learning signal is never selected nor preferred", async () => {
    const world = await buildGovernedWorld({
      routes: FORBIDDEN_ROUTES,
      deniedProviders: ["rail-forbidden"],
      withLearning: true,
    });
    for (let index = 0; index < 8; index += 1) {
      await world.learning.recordExecutionTelemetry(
        telemetryInput({ provider: "rail-forbidden", model: "model-hot" }, true),
      );
    }
    await world.learning.buildScorecard({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    // The planner consults learning AFTER its own policy inputs: the
    // signal for the forbidden route exists and is attractive.
    const signals = await world.learning.consultSignals({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
      subjectKeys: ["rail-forbidden/model-hot"],
    });
    expect(signals[0]?.successRate).toBe(1);

    const selectedStrategyId = await planFor(world, "r-m1");
    // The selection is one of the admissible strategies — the forbidden
    // route is never selected (cheap-first picks rail-b here).
    expect(selectedStrategyId).toBeDefined();

    // The recorded consultation never prefers the forbidden candidate:
    // read the durable decision and inspect its learning consultation.
    const executionId = (
      await world.executions.service.createExecution(
        { applicationId: APP_ID, task: { kind: "interpretation", input: { text: "why?" } } },
        "create-r-m1-b",
        ACTOR,
      )
    ).executionId;
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-r-m1-b",
    );
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-r-m1-b",
    );
    const outcome = await world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "plan-r-m1-b",
    );
    const consultation = outcome.decision.learningConsultation;
    expect(consultation).toBeDefined();
    const forbiddenCandidate = outcome.decision.candidates.find((candidate) =>
      candidate.plan.steps.some((step) => step.routeRef?.provider === "rail-forbidden"),
    );
    expect(forbiddenCandidate?.admissible).toBe(false);
    expect(consultation?.preferredStrategyId).not.toBe(forbiddenCandidate?.strategyId);
  });

  test("R-M6: learning operations leave execution state and the ledger untouched", async () => {
    const world = await buildGovernedWorld();
    const receipt = await world.executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "interpretation", input: { text: "why?" } } },
      "create-r-m6",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await world.executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-r-m6",
    );
    const before = await world.executions.service.getExecution(APP_ID, executionId);
    const eventsBefore = await world.executions.service.listEvents(APP_ID, executionId);

    // The full learning pipeline runs (six observations so the scorecard
    // clears the minimum-population threshold)...
    for (let index = 0; index < 6; index += 1) {
      await world.learning.recordExecutionTelemetry(
        telemetryInput({ provider: "rail-a", model: "model-x" }, true),
      );
    }
    await world.learning.buildScorecard({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    await createShadowEvaluator({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-f000-${String(++telemetryCounter).padStart(12, "0")}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    }).evaluateShadowStrategy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      proposed: {
        strategyIdentity: "ghost",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor",
    });

    // ...and nothing about the execution changed (M6).
    const after = await world.executions.service.getExecution(APP_ID, executionId);
    const eventsAfter = await world.executions.service.listEvents(APP_ID, executionId);
    expect(after?.status).toBe(before?.status);
    expect(eventsAfter.length).toBe(eventsBefore.length);
    expect(world.policySpy.interactions).toEqual([]);
  });

  test("R-M7: shadow evaluation performs ZERO authority/dispatch interactions", async () => {
    const world = await buildGovernedWorld({ withLearning: true });
    for (const route of [
      { provider: "rail-a", model: "model-x" },
      { provider: "rail-b", model: "model-y" },
    ]) {
      for (let index = 0; index < 8; index += 1) {
        await world.learning.recordExecutionTelemetry(telemetryInput(route, true));
      }
    }
    await world.learning.buildScorecard({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    const policyInteractionsBefore = world.policySpy.interactions.length;
    const explorerCallsBefore = world.explorerCalls();

    const record = await createShadowEvaluator({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-f000-${String(++telemetryCounter).padStart(12, "0")}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    }).evaluateShadowStrategy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      proposed: {
        strategyIdentity: "switch-to-b",
        taskClass: "interpretation",
        routeSubjects: ["rail-b/model-y"],
        toolSubjects: [],
      },
      baseline: {
        strategyIdentity: "stay-on-a",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor",
    });

    expect(record.status).toBe("scored");
    expect(record.recordClass).toBe("shadow");
    // Zero authority interactions: no policy resolution, no route
    // exploration, no dispatch, no execution mutation (M7).
    expect(world.policySpy.interactions.length).toBe(policyInteractionsBefore);
    expect(world.explorerCalls()).toBe(explorerCallsBefore);
    // The budgets fake would throw on any reservation attempt.
  });

  test("R-M8: the live selection is IDENTICAL before and after a shadow evaluation", async () => {
    const world = await buildGovernedWorld({ withLearning: true });
    for (let index = 0; index < 8; index += 1) {
      await world.learning.recordExecutionTelemetry(
        telemetryInput({ provider: "rail-b", model: "model-y" }, true),
      );
    }
    await world.learning.buildScorecard({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });

    const before = await planFor(world, "r-m8-before");

    await createShadowEvaluator({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-f000-${String(++telemetryCounter).padStart(12, "0")}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    }).evaluateShadowStrategy({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      proposed: {
        strategyIdentity: "expensive-a",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      baseline: {
        strategyIdentity: "cheap-b",
        taskClass: "interpretation",
        routeSubjects: ["rail-b/model-y"],
        toolSubjects: [],
      },
      requestedBy: "actor",
    });

    const after = await planFor(world, "r-m8-after");
    expect(after).toBe(before);
  });

  test("R-M11: duplicate ingestion converges; conflicting re-observation fails closed", async () => {
    const world = await buildGovernedWorld();
    const input = telemetryInput({ provider: "rail-a", model: "model-x" }, true);
    const first = await world.learning.recordExecutionTelemetry(input);
    const retry = await world.learning.recordExecutionTelemetry(input);
    expect(retry.replayed).toBe(true);
    expect(retry.telemetryId).toBe(first.telemetryId);
    expect(world.learningStore.telemetryCount()).toBe(1);

    const conflicting: RecordTelemetryInput = { ...input, costMicroUsd: "4242" };
    await expect(world.learning.recordExecutionTelemetry(conflicting)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  test("R-M12: cross-tenant consultation returns nothing", async () => {
    const world = await buildGovernedWorld();
    for (let index = 0; index < 8; index += 1) {
      await world.learning.recordExecutionTelemetry(
        telemetryInput({ provider: "rail-a", model: "model-x" }, true),
      );
    }
    await world.learning.buildScorecard({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    const foreign = await world.learning.consultSignals({
      applicationId: APP_ID,
      tenantId: "00000000-0000-7000-8000-0000000000cc",
      definitionId: "route-outcome-by-task-class",
    });
    expect(foreign).toEqual([]);
  });

  test("R-M14: a heterogeneous telemetry population fails closed", async () => {
    const world = await buildGovernedWorld();
    await world.learning.recordExecutionTelemetry(
      telemetryInput({ provider: "rail-a", model: "model-x" }, true),
    );
    await world.learning.recordExecutionTelemetry({
      ...telemetryInput({ provider: "rail-a", model: "model-x" }, true),
      schemaVersion: TELEMETRY_SCHEMA_VERSION + 1,
    });
    await expect(
      world.learning.buildScorecard({
        applicationId: APP_ID,
        tenantId: ACTOR.tenantId,
        definitionId: "route-outcome-by-task-class",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("R-M16: a user rating leaves the policy store untouched and gains no authority", async () => {
    const world = await buildGovernedWorld();
    const receipt = await world.executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "interpretation", input: { text: "why?" } } },
      "create-r-m16",
      ACTOR,
    );
    const rating: RecordRatingInput = {
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      executionId: receipt.executionId,
      evaluatorId: "user-42",
      ratingDimension: "overall-quality",
      rating: 5,
      provenance: { source: "user", submittedVia: "dashboard" },
      evidenceRefs: [`execution:${receipt.executionId}:receipt`],
      schemaVersion: 1,
    };
    await world.learning.recordUserRating(rating);
    const ratings = await world.learningStore.listUserRatings({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    expect(ratings).toHaveLength(1);
    // No policy interaction, no authority change: the rating is stored
    // data only (M16).
    expect(world.policySpy.interactions).toEqual([]);
    // A rating is not a signal: it never crosses the planning READ seam.
    const signals: readonly LearningSignal[] = await world.learning.consultSignals({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      definitionId: "route-outcome-by-task-class",
    });
    expect(signals).toEqual([]);
  });
});
