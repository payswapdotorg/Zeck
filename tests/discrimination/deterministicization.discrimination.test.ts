/**
 * Discrimination: the deterministicization boundary (WORK-021 /
 * DTR-001..DTR-004 CRITICAL boundaries; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, CONCURRENCY-CRASH-SAFETY,
 * SELF-HOSTING-BOUNDARY, EXECUTION-PROVENANCE).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013 red-record pattern): STATIC mutants mutate the REAL source
 * in memory and the shared scanners must flag exactly the weakened
 * protection; RUNTIME red records observe the governed world under
 * constructed wiring scenarios (the full in-memory deterministicization
 * lifecycle through the REAL planning adapter into the REAL planner).
 *
 * Mutant map (the WORK-021 D-ledger):
 *   D1  (AC6) the promotion gate's verdict becomes a constant 'promote'
 *       — silently replacing uncertain AI work without validation;
 *   D2  (AC6) the gate stops flagging MISSING stage records (unknown
 *       evidence would pass silently);
 *   D3  the gate amplifies an 'insufficient' record into a pass;
 *   D4  the gate's canary match-rate threshold check is removed;
 *   D5  the gate config validation is removed (nonsense thresholds);
 *   D6  the service ignores the gate verdict (advisory-then-promote);
 *   D7  the domain provenance-presence enforcement is removed;
 *   D8  the program-required check is removed (a replacement-less
 *       replacement);
 *   D9  the lifecycle service gains an authority dep (policy);
 *   D10 a deterministicization update/delete surface appears;
 *   D11 planner/execution state vocabulary appears in learning
 *       deterministicization code (the second-authority mutant);
 *   D12 the tools executor bypasses the sandbox dispatch;
 *   D13 the tools executor's pre-dispatch confinement is removed;
 *   D14 a SECOND executor implementation appears (a local runner);
 *   D15 the planner consults deterministicization BEFORE the selection;
 *   D16 the planning consultation drops the promoted-only direction
 *       gate (a canary candidate would imply the preference);
 *   D17 the planning adapter's fail-closed validation is removed;
 *   D18 the durable selection is rebound to the implied preference;
 *   D19 the rollback decision loses the incumbent restoration target.
 *
 * Runtime red records:
 *   R1  (AC6) a candidate with NO validation evidence NEVER promotes
 *       (the gate fails closed listing every missing stage);
 *   R2  an 'insufficient' stage record fails closed exactly like a
 *       missing one (never amplified);
 *   R3   a surviving mutant in the mutation stage blocks promotion;
 *   R4  a provenance-less proposal is rejected at the boundary;
 *   R5  rollback restores the incumbent (the restoration target is
 *       durable; the rolled-back lifecycle is TERMINAL and
 *       re-validation is a NEW candidate with fresh provenance);
 *   R6  a canary-phase consultation NEVER implies the planning
 *       preference (divergence evidence only);
 *   R7  an unprovenanced candidate fails closed at the planning seam.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDeterministicizationService,
  createDeterministicizationSignalSource,
  createNodeDigest,
  type DeterministicizationService,
  type ExecutionOutcomeTelemetry,
  InMemoryDeterministicizationStore,
} from "../../src/modules/learning/public";
import {
  createDeterministicizationSignalsAdapter,
  createPlannerService,
  createNodeDigest as createPlanningNodeDigest,
  createPlanningSinkAdapter,
  type ModelRouteCandidate,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
  type ResolvedPolicyInputs,
} from "../../src/modules/planning/public";
import type { RestrictionSet } from "../../src/modules/policies/public";
import { ACTOR, createInMemoryExecutions } from "../unit/executions/fakes";
import {
  type DtrBoundaryFile,
  deterministicizationExecutorSurfaceViolations,
  deterministicizationNonAuthorityViolations,
  plannerDeterministicizationViolations,
} from "./lib/deterministicization";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");
const TOOLS_DIR = join(REPO_ROOT, "src/modules/tools");
const PLANNER_PATH = "src/modules/planning/application/planner.ts";
const DTR_ADAPTER_PATH = "src/modules/planning/adapters/deterministicization-signals-adapter.ts";
const CONSULTATION_PATH = "src/modules/planning/domain/deterministicization-consultation.ts";

function collectTree(root: string): DtrBoundaryFile[] {
  const out: DtrBoundaryFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ path: full.slice(REPO_ROOT.length + 1), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

function withMutation(
  tree: readonly DtrBoundaryFile[],
  path: string,
  mutation: (content: string) => string,
): DtrBoundaryFile[] {
  return tree.map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// STATIC red records: every weakened protection is detected.
// ---------------------------------------------------------------------------

describe("discrimination: deterministicization non-authority (static mutants)", () => {
  test("the REAL learning/tools trees pass the scanners (baseline)", () => {
    expect(deterministicizationNonAuthorityViolations(collectTree(LEARNING_DIR))).toEqual([]);
    expect(
      deterministicizationExecutorSurfaceViolations([
        ...collectTree(LEARNING_DIR),
        ...collectTree(TOOLS_DIR),
      ]),
    ).toEqual([]);
  });

  test("D1 (AC6): the promotion gate verdict becoming a constant 'promote' is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization-gate.ts",
      (content) =>
        content.replace(
          'verdict: reasons.length === 0 ? "promote" : "not-promoted",',
          'verdict: "promote",',
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain("dtr-gate-verdict-bypassed");
  });

  test("D2 (AC6): removing the missing-stage-record check is detected (unknown evidence passes silently)", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization-gate.ts",
      (content) =>
        content.replace(
          "insufficient-evidence: no ${" +
            "stage} evidence record exists (unknown evidence fails closed)",
          "unknown stages are fine (mutant)",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-gate-stage-check-removed",
    );
  });

  test("D3: amplifying an 'insufficient' record into a pass is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization-gate.ts",
      (content) =>
        content.replace(
          "insufficient-evidence: the ${" +
            "stage} record honestly records insufficiency (never amplified into confidence)",
          "insufficient records count as passing (mutant)",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-gate-insufficient-amplified",
    );
  });

  test("D4: removing the canary match-rate threshold check is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization-gate.ts",
      (content) =>
        // The applied check is short-circuited away (the canary quality
        // delta is never compared against the configured minimum).
        content.replace("rollout.qualityDelta < config.minimumCanaryMatchRate", "false"),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-gate-canary-threshold-removed",
    );
  });

  test("D5: removing the gate-config validation is detected (nonsense thresholds)", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization-gate.ts",
      (content) =>
        content.replace(
          "function validatePromotionGateConfig",
          "function validatePromotionGateConfigMutant",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain("dtr-gate-config-validated");
  });

  test("D6: the service ignoring the gate verdict (advisory-then-promote) is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/application/deterministicization-service.ts",
      (content) => content.replace('evaluation.verdict !== "promote"', "false"),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-service-gate-failclosed",
    );
  });

  test("D7: removing the domain provenance-presence enforcement is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization.ts",
      (content) =>
        content.replace(
          'requireNonEmptyStringList(provenance, "sourceExecutionIds", "provenance sourceExecutionIds");',
          "",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-provenance-presence-removed",
    );
  });

  test("D8: removing the program-required check is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/domain/deterministicization.ts",
      (content) => content.replace('candidate.candidateClass !== "removal"', "false"),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-program-required-removed",
    );
  });

  test("D9: the lifecycle service gaining an authority dep is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/application/deterministicization-service.ts",
      (content) =>
        content.replace(
          "export interface DeterministicizationServiceDeps {",
          "export interface DeterministicizationServiceDeps {\n  readonly policy: unknown;",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-service-authority-deps:policy",
    );
  });

  test("D10: a deterministicization update/delete surface is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/adapters/in-memory-deterministicization-store.ts",
      (content) => `${content}\nasync updateDeterministicizationCandidate() {}\n`,
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-mutation-surface:src/modules/learning/adapters/in-memory-deterministicization-store.ts",
    );
  });

  test("D11: planner/execution state vocabulary in learning deterministicization code is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/application/deterministicization-service.ts",
      (content) => `${content}\nexport async function recordPlanningDecision() {}\n`,
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-planner-execution-vocabulary:src/modules/learning/application/deterministicization-service.ts",
    );
  });

  test("D12: the tools executor bypassing the sandbox dispatch is detected", () => {
    const tree = withMutation(
      collectTree(TOOLS_DIR),
      "src/modules/tools/adapters/deterministic-replacement-sandbox-executor.ts",
      (content) => content.replace("service.dispatchSandboxExecution", "localDispatchMutant"),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-executor-dispatch-bypassed",
    );
  });

  test("D13: removing the executor's pre-dispatch confinement is detected", () => {
    const tree = withMutation(
      collectTree(TOOLS_DIR),
      "src/modules/tools/adapters/deterministic-replacement-sandbox-executor.ts",
      (content) =>
        content.replace(
          "replacementConfinementCheck(dispatch.contract, environment)",
          "confinementMutant(dispatch.contract, environment)",
        ),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-executor-confinement-removed",
    );
  });

  test("D14: a SECOND executor implementation appearing is flagged", () => {
    const tree = [
      ...collectTree(TOOLS_DIR),
      {
        path: "src/modules/tools/adapters/local-dtr-executor.ts",
        content:
          "import type { DeterministicReplacementExecutor } from '../ports/deterministic-replacement-executor';\nexport class LocalDtrExecutor implements DeterministicReplacementExecutor {\n  async execute() { return { outcome: 'success', stdout: '{}', outputDigest: null, durationMs: 0, sandboxExecutionId: 'x' } as never; }\n}\n",
      },
    ];
    expect(deterministicizationExecutorSurfaceViolations(tree)).toContain(
      "dtr-second-executor-surface:src/modules/tools/adapters/local-dtr-executor.ts",
    );
  });
});

describe("discrimination: planner deterministicization consumption (static mutants)", () => {
  const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
  const adapterSource = readFileSync(join(REPO_ROOT, DTR_ADAPTER_PATH), "utf8");
  const consultationSource = readFileSync(join(REPO_ROOT, CONSULTATION_PATH), "utf8");

  test("the REAL planner/adapter/consultation pass the scanner (baseline)", () => {
    expect(
      plannerDeterministicizationViolations({ plannerSource, adapterSource, consultationSource }),
    ).toEqual([]);
  });

  test("D15: moving the consultation BEFORE the governed selection is detected", () => {
    const mutated = plannerSource.replace(
      "      const admissibleCandidates = candidates.map((candidate) =>",
      "      if (deps.deterministicizationSignals !== undefined) {\n        await deps.deterministicizationSignals.consult({\n          applicationId: input.applicationId,\n          tenantId: input.tenantId,\n        });\n      }\n      const admissibleCandidates = candidates.map((candidate) =>",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(
      plannerDeterministicizationViolations({
        plannerSource: mutated,
        adapterSource,
        consultationSource,
      }),
    ).toContain("dtr-consultation-before-selection");
  });

  test("D16: dropping the promoted-only direction gate is detected (canary would imply)", () => {
    const mutated = consultationSource.replace(
      'signals.some((signal) => signal.status === "promoted")',
      "true",
    );
    expect(mutated).not.toBe(consultationSource);
    expect(
      plannerDeterministicizationViolations({
        plannerSource,
        adapterSource,
        consultationSource: mutated,
      }),
    ).toContain("dtr-promoted-only-direction");
  });

  test("D17: removing the adapter's fail-closed validation is detected", () => {
    const mutated = adapterSource.replace(
      "validateConsultedDeterministicizationSignal(consulted);",
      "",
    );
    expect(mutated).not.toBe(adapterSource);
    expect(
      plannerDeterministicizationViolations({
        plannerSource,
        adapterSource: mutated,
        consultationSource,
      }),
    ).toContain("dtr-adapter-validation-removed");
  });

  test("D18: rebinding the durable selection to the implied preference is detected", () => {
    const mutated = plannerSource.replace(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale:",
      "selectedStrategyId: deterministicizationConsultation?.preferredStrategyId ?? selected.strategyId,\n        selectionRationale:",
    );
    expect(mutated).not.toBe(plannerSource);
    expect(
      plannerDeterministicizationViolations({
        plannerSource: mutated,
        adapterSource,
        consultationSource,
      }),
    ).toContain("dtr-selection-reference-mutated");
  });

  test("D19: the rollback decision losing the incumbent restoration is detected", () => {
    const tree = withMutation(
      collectTree(LEARNING_DIR),
      "src/modules/learning/application/deterministicization-service.ts",
      (content) => content.replaceAll("candidate.incumbent.rollbackTarget", "null"),
    );
    expect(deterministicizationNonAuthorityViolations(tree)).toContain(
      "dtr-rollback-restoration-removed",
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
  return new Date(Date.parse("2026-09-20T12:00:00Z") + ++tick * 1000);
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

function telemetryPopulation(count: number): ExecutionOutcomeTelemetry[] {
  return Array.from({ length: count }, (_, index) => ({
    telemetryId: `tel-${index}`,
    executionId: `exec-${index}`,
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    taskClass: "summarize",
    capabilities: ["text-generation"],
    planId: `plan-${index}`,
    planRevision: 1,
    strategyClass: "generative-route",
    routes: [{ provider: "rail-a", model: "model-x" }],
    tools: [],
    environments: [],
    verification: {
      resultIds: [],
      statuses: [],
      evaluatorIds: [],
      passCount: 0,
      failCount: 0,
      inconclusiveCount: 0,
      verified: null,
    },
    costMicroUsd: "200",
    latencyMs: 150,
    outcome: index === 4 ? "execution-failed" : "execution-completed",
    recordedAt: `2026-09-1${index % 9}T12:00:00Z`,
    evidenceRefs: [`ev-${index}`],
    subgraphs: [
      {
        subgraphId: "sg-normalize-entity",
        stepPath: ["plan", "normalize-entity"],
        computationType: "generative",
      },
    ],
    schemaVersion: 1,
  }));
}

const CONTRACT = {
  inputFields: [{ name: "value", type: "number" as const, required: true }],
  outputFields: [{ name: "doubled", type: "number" as const, required: true }],
  acceptanceCriterion: {
    kind: "exact-output" as const,
    description: "the replacement must reproduce the incumbent output exactly on the corpus",
  },
  compute: {
    pureComputeOnly: true as const,
    networkEgress: "none" as const,
    allowedHosts: [] as readonly string[],
    timeoutMs: 5000,
  },
};

function proposalRequest() {
  return {
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateClass: "deterministic-replacement" as const,
    subgraph: {
      subgraphId: "sg-normalize-entity",
      stepPath: ["plan", "normalize-entity"],
      computationType: "generative",
      taskClass: "summarize",
      routes: [{ provider: "rail-a", model: "model-x" }],
      tools: [],
    },
    provenance: {
      sourceExecutionIds: Array.from({ length: 24 }, (_, index) => `exec-${index}`),
      evidenceRefs: Array.from({ length: 6 }, (_, index) => `ev-${index}`),
      corpusDigest: "b".repeat(64),
      windowFrom: "2026-09-10T12:00:00Z",
      windowTo: "2026-09-18T12:00:00Z",
      population: 24,
    },
    recurrence: { occurrenceCount: 24, totalCostMicroUsd: "4800", errorRate: 1 / 24 },
    incumbent: {
      strategyClass: "generative-route",
      routes: [{ provider: "rail-a", model: "model-x" }],
      descriptionDigest: "c".repeat(64),
      rollbackTarget: "incumbent:generative-route@v1",
    },
    contract: CONTRACT,
    program: {
      language: "javascript-v1" as const,
      source: "console.log(JSON.stringify({ doubled: INPUT.value * 2 }));",
      sourceDigest: "d".repeat(64),
    },
    proposedBy: "agent-1",
  };
}

function stageRuns(count: number, outcome: "success" | "failure" = "success") {
  return Array.from({ length: count }, (_, index) => ({
    runKey: `run-${index}`,
    sandboxExecutionId: `sbx-${index}`,
    inputDigest: `${index}`.padStart(64, "0"),
    outputDigest: "e".repeat(64),
    outcome,
    failureClass: outcome === "failure" ? "assertion-mismatch" : null,
    costMicroUsd: "10",
    latencyMs: 12,
  }));
}

function lifecycleWorld(telemetryCount = 24): { readonly service: DeterministicizationService } {
  const store = new InMemoryDeterministicizationStore(telemetryPopulation(telemetryCount));
  const service = createDeterministicizationService({
    store,
    digest: createNodeDigest(),
    generateId,
    now: clock,
  });
  return { service };
}

async function driveTo(
  service: DeterministicizationService,
  to: "validated" | "canary" | "promoted",
): Promise<string> {
  const { candidate } = await service.proposeCandidate(proposalRequest());
  const candidateId = candidate.candidateId;
  const stages: Array<
    "offline-replay" | "differential-evaluation" | "property-tests" | "mutation-tests"
  > = ["offline-replay", "differential-evaluation", "property-tests", "mutation-tests"];
  for (const stage of stages) {
    await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId,
      stageKind: stage,
      runs: stage === "mutation-tests" ? stageRuns(24, "failure") : stageRuns(24),
      ...(stage === "differential-evaluation"
        ? {
            pairs: Array.from({ length: 24 }, (_, index) => ({
              inputDigest: `${index}`.padStart(64, "0"),
              incumbentOutputDigest: "4".repeat(64),
              replacementOutputDigest: "5".repeat(64),
              accepted: true,
            })),
          }
        : {}),
      recordedBy: "validator-1",
    });
  }
  if (to === "validated") {
    return candidateId;
  }
  await service.beginShadowRollout({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeShadowRollout({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateId,
    mode: "shadow",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2200",
    qualityDelta: 1,
    latencyDeltaMs: -140,
    evidenceRefs: ["ev-shadow"],
    requestedBy: "operator-1",
  });
  await service.beginCanaryPhase({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeCanaryPhase({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateId,
    mode: "canary",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2100",
    qualityDelta: 1,
    latencyDeltaMs: -130,
    evidenceRefs: ["ev-canary"],
    requestedBy: "operator-1",
  });
  if (to === "canary") {
    return candidateId;
  }
  await service.applyPromotion({
    applicationId: APP_ID,
    tenantId: ACTOR.tenantId,
    candidateId,
    decidedBy: "architect-1",
  });
  return candidateId;
}

describe("discrimination: deterministicization runtime red records", () => {
  test("R1 (AC6): a candidate with NO validation evidence NEVER promotes (fail closed, reasons listed)", async () => {
    const { service } = lifecycleWorld();
    const { candidate } = await service.proposeCandidate(proposalRequest());
    // Drive ONLY the rollout phases (no offline evidence at all) —
    // impossible via the honest path; simulate by direct status driving
    // through the store-free path: instead consult the gate directly.
    // The honest path: applyPromotion on a proposed candidate.
    const failure = service.applyPromotion({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId: candidate.candidateId,
      decidedBy: "architect-1",
    });
    await expect(failure).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("the promotion gate failed closed"),
    });
    const outcome = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId: candidate.candidateId,
    });
    // Nothing promoted, no decision recorded (the fail-closed path
    // writes NO durable decision).
    expect(outcome.candidate.status).toBe("proposed");
    expect(outcome.decisions).toHaveLength(0);
  });

  test("R2: an 'insufficient' stage record fails closed exactly like a missing one (never amplified)", async () => {
    const { service } = lifecycleWorld();
    const id = await driveTo(service, "canary");
    // Overwrite is impossible (write-once per stage); instead consult
    // the pure gate directly with an honest insufficient record.
    const { getCandidate } = service;
    const { evidence, rollouts } = await getCandidate({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId: id,
    });
    // Replace one stage's record with an honest insufficient variant
    // (the same identity basis, zero runs).
    const replay = evidence.find((record) => record.stageKind === "offline-replay");
    expect(replay).toBeDefined();
    if (replay === undefined) {
      return;
    }
    const insufficient = {
      ...replay,
      status: "insufficient" as const,
      runs: [],
      metrics: {
        ...replay.metrics,
        population: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        acceptanceRate: 0,
      },
    };
    const { evaluatePromotionGate, DEFAULT_PROMOTION_GATE_CONFIG } = await import(
      "../../src/modules/learning/domain/deterministicization-gate"
    );
    const candidate = (
      await getCandidate({
        applicationId: APP_ID,
        tenantId: ACTOR.tenantId,
        candidateId: id,
      })
    ).candidate;
    const verdict = evaluatePromotionGate({
      candidate,
      stageEvidence: evidence.map((record) =>
        record.stageKind === "offline-replay" ? insufficient : record,
      ),
      rollouts,
      config: DEFAULT_PROMOTION_GATE_CONFIG,
    });
    expect(verdict.verdict).toBe("not-promoted");
    expect(
      verdict.reasons.some((reason) => reason.includes("honestly records insufficiency")),
    ).toBe(true);
  });

  test("R3: a surviving mutant in the mutation stage blocks promotion", async () => {
    const { service } = lifecycleWorld();
    const { candidate } = await service.proposeCandidate(proposalRequest());
    const candidateId = candidate.candidateId;
    // The mutation stage carries one SURVIVING mutant (outcome success
    // on a mutated program = the checks failed to discriminate).
    const [survivor] = stageRuns(1, "success");
    expect(survivor).toBeDefined();
    if (survivor === undefined) {
      return;
    }
    await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId,
      stageKind: "mutation-tests",
      runs: [...stageRuns(23, "failure"), survivor],
      recordedBy: "validator-1",
    });
    const { getCandidate } = service;
    const { evidence } = await getCandidate({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId,
    });
    const mutation = evidence.find((record) => record.stageKind === "mutation-tests");
    expect(mutation?.status).toBe("failed");
    expect(mutation?.metrics.mutationMissedCount).toBe(1);
  });

  test("R4: a provenance-less proposal is rejected at the boundary (unrepresentable)", async () => {
    const { service } = lifecycleWorld();
    const request = proposalRequest();
    await expect(
      service.proposeCandidate({
        ...request,
        provenance: {
          ...request.provenance,
          sourceExecutionIds: [],
          corpusDigest: "",
        },
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("provenance sourceExecutionIds"),
    });
  });

  test("R5: rollback restores the incumbent (the restoration target is durable; the rolled-back lifecycle is terminal and re-validation is a NEW candidate)", async () => {
    const { service } = lifecycleWorld();
    const id = await driveTo(service, "promoted");
    const { decision } = await service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      candidateId: id,
      rationale: "canary quality degraded after a corpus shift",
      decidedBy: "architect-1",
    });
    expect(decision.kind).toBe("rolled-back");
    expect(decision.incumbentRestoredTo).toBe("incumbent:generative-route@v1");
    const signals = await service.consultDeterministicizationSignals({
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
    });
    const signal = signals.find((entry) => entry.candidateId === id);
    expect(signal?.status).toBe("rolled-back");
    expect(signal?.restoredIncumbent).toBe("incumbent:generative-route@v1");
    // The incumbent restoration is DURABLE (the prior implementation is
    // the recorded rollback target); the candidate's replacement
    // lifecycle is TERMINAL — a rolled-back candidate can never
    // re-enter the rollout phases (the rollout epochs are single-shot
    // and write-once per candidate).
    await expect(
      service.beginShadowRollout({
        applicationId: APP_ID,
        tenantId: ACTOR.tenantId,
        candidateId: id,
        requestedBy: "operator-1",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      message: expect.stringContaining("the shadow phase requires a validated candidate"),
    });
    await expect(
      service.recordStageEvidence({
        applicationId: APP_ID,
        tenantId: ACTOR.tenantId,
        candidateId: id,
        stageKind: "offline-replay",
        runs: stageRuns(1),
        recordedBy: "validator-1",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      message: expect.stringContaining("no longer accepts validation evidence"),
    });
    // Reversibility is systemic, not per-candidate: the incumbent is
    // restored (above) and re-validation of the SAME subgraph is a NEW
    // candidate (fresh provenance → fresh identity → a fresh single-
    // epoch lifecycle).
    const fresh = proposalRequest();
    const { candidate: renewed } = await service.proposeCandidate({
      ...fresh,
      provenance: {
        ...fresh.provenance,
        corpusDigest: "f".repeat(64),
        windowFrom: "2026-09-19T12:00:00Z",
        windowTo: "2026-09-20T12:00:00Z",
      },
      recurrence: { occurrenceCount: 30, totalCostMicroUsd: "6000", errorRate: 0 },
    });
    expect(renewed.candidateId).not.toBe(id);
    expect(renewed.status).toBe("proposed");
    const rolledBackSignal = signals.find((entry) => entry.candidateId === id);
    expect(rolledBackSignal?.status).toBe("rolled-back");
  });

  test("R6: a canary-phase consultation NEVER implies the planning preference (divergence evidence only)", async () => {
    const { service } = lifecycleWorld();
    await driveTo(service, "canary");
    const source = createDeterministicizationSignalSource(service);
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
          return [];
        },
      },
      sink: createPlanningSinkAdapter(executions.service),
      digest: createPlanningNodeDigest(),
      generateId: executions.generateId,
      now: clock,
      deterministicizationSignals: createDeterministicizationSignalsAdapter(source),
    });
    const receipt = await executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "generation", input: { text: "artifact-1" } } },
      "create-dtr-r6",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-dtr-r6",
    );
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-dtr-r6",
    );
    const decision = await planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task: { kind: "generation", input: { text: "artifact-1" } },
      },
      "plan-exec-dtr-r6",
    );
    // The consultation recorded the canary candidate as EVIDENCE with a
    // NULL implied preference (a non-promoted candidate never carries
    // the deterministic direction).
    const consultation = decision.decision.deterministicizationConsultation;
    expect(consultation).toBeDefined();
    expect(consultation?.preferredStrategyId).toBeNull();
    expect(consultation?.consulted.length).toBe(1);
    expect(consultation?.consulted[0]?.status).toBe("canary");
    // The decision landed on the durable ledger too (the executions
    // planning-decision event).
    const events = await executions.service.listEvents(APP_ID, executionId);
    const recorded = events.find((event) => event.cause === "planning-decision");
    expect(recorded).toBeDefined();
    const ledgerConsultation = (
      recorded?.payload as {
        deterministicizationConsultation?: {
          preferredStrategyId: string | null;
          consulted: readonly unknown[];
        };
      }
    )?.deterministicizationConsultation;
    expect(ledgerConsultation).toBeDefined();
    expect(ledgerConsultation?.preferredStrategyId).toBeNull();
    expect(ledgerConsultation?.consulted.length).toBe(1);
  });

  test("R7: an unprovenanced candidate fails closed at the planning seam (never enters a decision record)", async () => {
    const { service } = lifecycleWorld();
    await driveTo(service, "promoted");
    const source = createDeterministicizationSignalSource(service);
    // A compromised source returns an unprovenanced candidate.
    const compromised: typeof source = {
      consult: async () =>
        [
          {
            signalClass: "non-authoritative-deterministicization-candidate",
            candidateId: "unprovenanced",
            candidateClass: "deterministic-replacement",
            status: "promoted",
            taskClass: "summarize",
            subgraphId: "sg-normalize-entity",
            computationType: "generative",
            population: 1,
            corpusDigest: "x".repeat(64),
            sourceExecutionIds: [],
            contractDigest: "y".repeat(64),
            incumbentStrategyClass: "generative-route",
            incumbentDescriptionDigest: "z".repeat(64),
            rollbackTarget: "incumbent:generative-route@v1",
            shadow: null,
            canary: null,
            promotionDecisionId: null,
            promotedBy: null,
            promotedAt: null,
            rollbackDecisionId: null,
            restoredIncumbent: null,
          },
        ] as never,
    };
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
          return [];
        },
      },
      sink: createPlanningSinkAdapter(executions.service),
      digest: createPlanningNodeDigest(),
      generateId: executions.generateId,
      now: clock,
      deterministicizationSignals: createDeterministicizationSignalsAdapter(compromised),
    });
    const receipt = await executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "generation", input: { text: "artifact-1" } } },
      "create-dtr-r7",
      ACTOR,
    );
    const executionId = receipt.executionId;
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      "authorize-dtr-r7",
    );
    await executions.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      "plan-dtr-r7",
    );
    // The planning request FAILS CLOSED: an unprovenanced candidate
    // never enters a durable decision record.
    await expect(
      planner.planExecution(
        {
          applicationId: APP_ID,
          executionId,
          tenantId: ACTOR.tenantId,
          actorId: ACTOR.actorId,
          task: { kind: "generation", input: { text: "artifact-1" } },
        },
        "plan-exec-dtr-r7",
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("sourceExecutionIds must be non-empty"),
    });
    // And NO planning decision was recorded for that execution.
    const events = await executions.service.listEvents(APP_ID, executionId);
    expect(events.filter((event) => event.cause === "planning-decision")).toHaveLength(0);
  });
});
