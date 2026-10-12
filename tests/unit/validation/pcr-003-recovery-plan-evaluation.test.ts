/**
 * PCR-003 acceptance tests (the oracles): the three-arm replay
 * evaluation's config pinning, corpus + arm-configuration integrity,
 * the declared ladder's composition through the REAL plan composer, the
 * threshold-verdict derivation honesty, the violations-scan
 * discriminations and the percentile convention.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the corpus digest stable; the
 *     targeted cell family IS the capstone's complete multi-provider
 *     enumeration; the base revision pinned;
 *   * the plan wiring: the declared economics compose EXACTLY the
 *     bounded ladder [same-provider retry, alternate-provider failover]
 *     through the REAL PCR-001 composer, with the honest inadmissible
 *     retry verdict at the second frame and the bound-reached terminal;
 *   * the verdict honesty (the truth discipline): a mediated-better
 *     aggregate derives `met`; an optimized-better aggregate derives
 *     `missed` WITH attribution (a fabricated pass is unrepresentable);
 *     a higher cost derives `documented-tradeoff` with attribution; a
 *     violation flips the hard gate to `delivery-blocking`; the
 *     PCR-004 eligibility statement follows the measured resolution
 *     verdict mechanically (both directions);
 *   * the violations scan's discriminations: an over-bound occurrence,
 *     an over-budget occurrence, an unregistered route, an over-bound
 *     plan and an incoherent task outcome are each CAUGHT with their
 *     named kinds (and a clean run records zero);
 *   * the digest discipline: the corpus digest is deterministic and
 *     discriminating (a corpus change is a different digest).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createEvaluationDigestPort,
} from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/canonical";
import {
  ARM_ATTEMPT_BOUNDS,
  ARM_IDS,
  BASE_REVISION,
  CORPUS_VERSION,
  EVALUATION_ID,
  EXPECTED_MEDIATED_LADDER,
  evaluationCorpusForm,
  MEDIATED_PLAN_CONFIGURATION,
  MEDIATED_PLAN_CONSTRAINTS,
  MEDIATED_PLAN_PROVIDER_ALTERNATES,
  MEDIATED_PLAN_QUALITY_FACTS,
  MEDIATED_PLAN_RETRY_CLAIM,
  MEDIATED_PLAN_STEP_ID,
  pinnedEvaluationCorpusDigest,
  TARGETED_CELL_IDS,
  TARGETED_CELLS,
  TASK_KIND,
  THRESHOLDS,
} from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/corpus";
import {
  type AttemptEvidence,
  aggregateEvaluation,
  type CellEvaluationResult,
  type OccurrenceEvidence,
  type PlanEvidence,
  percentileOf,
  scanViolations,
  type ViolationRecord,
} from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/driver";
import { hermeticCell } from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/fixtures";
import { EVALUATION_GOVERNED_IR } from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/governed-ir";
import { allSweepCells } from "../../../experiments/ppr-027/sweep";
import { createIrPlanSource } from "../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../src/modules/planning/public";
import { canonicalJson as platformCanonicalJson } from "../../../src/platform/execution-ir/canonical";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import { attributeFailure } from "../../../src/platform/failure-recovery/attribution";
import { composeRecoveryPlan } from "../../../src/platform/failure-recovery/plan";
import { selectModelRepresentation } from "../../../src/platform/model-economics/model-selection";

// ---------------------------------------------------------------------------
// The corpus + configuration consistency (config pinning)
// ---------------------------------------------------------------------------

describe("PCR-003 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "benchmarks/validation/apps/economic-recovery-plan-evaluation/config.json",
        ),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly corpusRevision: string;
      readonly tasks: readonly {
        readonly kind: string;
        readonly cellId: string;
        readonly capstoneCellId: string;
        readonly arms: readonly string[];
      }[];
      readonly evaluation: {
        readonly evaluationId: string;
        readonly baseRevision: string;
        readonly corpusDigest: string;
        readonly arms: readonly { readonly armId: string; readonly attemptBound: number }[];
        readonly thresholds: Record<string, unknown>;
      };
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("recovery-plan-evaluation:three-arm-fresh-replay");
    expect(config.corpusRevision).toBe(CORPUS_VERSION);
    expect(config.tasks.map((task) => task.cellId)).toEqual([...TARGETED_CELL_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(TASK_KIND);
      expect(task.arms).toEqual([...ARM_IDS]);
    }
    expect(config.evaluation.evaluationId).toBe(EVALUATION_ID);
    expect(config.evaluation.baseRevision).toBe(BASE_REVISION);
    expect(config.evaluation.corpusDigest).toBe(pinnedEvaluationCorpusDigest());
    expect(config.evaluation.arms.map((arm) => arm.armId)).toEqual([...ARM_IDS]);
    expect(config.evaluation.thresholds).toEqual(THRESHOLDS as unknown as Record<string, unknown>);
    expect(JSON.stringify(config)).not.toContain("sk-");
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the targeted cell family IS the capstone's complete multi-provider enumeration", () => {
    // The exact-revision rule's targeting: every multi cell of the
    // capstone's own sweep enumeration, never a hand-picked subset.
    const capstoneMulti = allSweepCells()
      .filter((cell) => cell.providerConfig === "multi")
      .map((cell) => cell.cellId);
    expect(TARGETED_CELLS.map((cell) => cell.capstoneCellId)).toEqual(capstoneMulti);
    expect(TARGETED_CELLS).toHaveLength(51);
    expect(new Set(TARGETED_CELL_IDS).size).toBe(TARGETED_CELL_IDS.length);
    for (const cell of TARGETED_CELLS) {
      expect(cell.providerConfig).toBe("multi");
      expect(cell.providerIds).toEqual(["supply-a", "supply-b", "supply-c"]);
      expect(cell.cellId).toBe(`pcr003-${cell.capstoneCellId}`);
    }
  });

  test("the corpus digest is stable and discriminating", () => {
    const first = pinnedEvaluationCorpusDigest();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedEvaluationCorpusDigest()).toBe(first);
    // A corpus change is a different digest (the discrimination).
    const mutated = { ...evaluationCorpusForm(), version: "tampered" };
    const mutatedDigest = createHash("sha256").update(platformCanonicalJson(mutated)).digest("hex");
    expect(mutatedDigest).not.toBe(first);
  });

  test("the arm attempt bounds are the pre-registered economics", () => {
    expect(ARM_ATTEMPT_BOUNDS["un-retried-direct"]).toBe(1);
    expect(ARM_ATTEMPT_BOUNDS["strong-optimized"]).toBe(3);
    // The mediated-with-plan ladder: the initial dispatch + the bounded
    // plan (maxPlanSteps 2) = 3 total attempts — the strong baseline's
    // own attempt bound.
    expect(ARM_ATTEMPT_BOUNDS["mediated-with-plan"]).toBe(
      1 + MEDIATED_PLAN_CONFIGURATION.maxPlanSteps,
    );
    expect(ARM_ATTEMPT_BOUNDS["mediated-with-plan"]).toBe(ARM_ATTEMPT_BOUNDS["strong-optimized"]);
    expect(MEDIATED_PLAN_CONFIGURATION.planMode).toBe("on");
    expect(MEDIATED_PLAN_CONFIGURATION.maxRetryAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The declared ladder composes through the REAL plan composer
// ---------------------------------------------------------------------------

describe("PCR-003 the declared plan wiring composes the bounded ladder through the REAL composer", () => {
  const nodeDigest = createNodeDigest();
  const planSource = createIrPlanSource();

  function governedIr() {
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
          {
            id: MEDIATED_PLAN_STEP_ID,
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "supply-a", model: "synth-text" },
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch", to: MEDIATED_PLAN_STEP_ID },
          { from: MEDIATED_PLAN_STEP_ID, to: "verify" },
        ],
      },
      (value) => nodeDigest.sha256Hex(platformCanonicalJson(value)),
    );
    return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
  }

  /** Compose the plan exactly as the wired seam's frame projection does, for each fault class. */
  function composeForRootFailure(category: "rate-limit" | "timeout" | "provider-unavailable") {
    const mapping = {
      "rate-limit": {
        signal: "provider-rate-limited",
        failureClass: "provider",
        evidence: { kind: "provider", providerErrorClass: "rate-limited" },
      },
      timeout: {
        signal: "transport-timeout",
        failureClass: "infrastructure",
        evidence: { kind: "infrastructure", transient: true },
      },
      "provider-unavailable": {
        signal: "provider-capacity",
        failureClass: "provider",
        evidence: { kind: "provider", providerErrorClass: "capacity" },
      },
    } as const;
    const entry = mapping[category];
    const model = "synth-text";
    const supplies = ["supply-a", "supply-b", "supply-c"];
    const attribution = attributeFailure(
      {
        signal: entry.signal,
        component: "model-rail",
        stepId: MEDIATED_PLAN_STEP_ID,
        routeRef: { provider: "supply-a", model },
        detail: "the synthetic supply failed (test projection)",
        observedAt: "2026-10-12T00:00:00Z",
        observationDigest: nodeDigest.sha256Hex(`pcr-003-test:${category}`),
      },
      entry.failureClass,
      entry.evidence,
      nodeDigest,
    );
    const frames = [];
    for (let index = 0; index < MEDIATED_PLAN_CONFIGURATION.maxPlanSteps; index += 1) {
      const incumbentSupply = supplies[index % supplies.length] ?? "supply-a";
      const alternates = MEDIATED_PLAN_PROVIDER_ALTERNATES.filter(
        (alternate) => alternate.providerId !== incumbentSupply,
      ).map((alternate) => ({
        candidateId: `${alternate.providerId}-${model}`,
        route: { provider: alternate.providerId, model },
        representationClass: "sufficient-model" as const,
        claim: alternate.claim,
      }));
      frames.push({
        attribution,
        context: {
          executionId: "exec-pcr003-test",
          stepId: MEDIATED_PLAN_STEP_ID,
          attemptsUsed: 1 + index,
          incumbentRoute: { provider: incumbentSupply, model },
        },
        facts: {
          retry: { nextAttempt: 2 + index, claim: MEDIATED_PLAN_RETRY_CLAIM },
          reroute: {
            model: null,
            substrate: null,
            provider:
              alternates.length === 0
                ? null
                : {
                    selection: selectModelRepresentation({
                      ir: governedIr(),
                      stepId: MEDIATED_PLAN_STEP_ID,
                      candidates: alternates,
                      qualityFacts: MEDIATED_PLAN_QUALITY_FACTS,
                      constraints: MEDIATED_PLAN_CONSTRAINTS,
                    }),
                    declaredCandidates: alternates,
                  },
          },
          escalation: null,
        },
      });
    }
    return composeRecoveryPlan({
      frames,
      qualityFacts: MEDIATED_PLAN_QUALITY_FACTS,
      constraints: MEDIATED_PLAN_CONSTRAINTS,
      configuration: MEDIATED_PLAN_CONFIGURATION,
      digest: nodeDigest,
    });
  }

  test("every fault class composes EXACTLY [same-provider retry, alternate-provider failover] with the bound-reached terminal", () => {
    for (const category of ["rate-limit", "timeout", "provider-unavailable"] as const) {
      const plan = composeForRootFailure(category);
      expect(plan.steps, category).toHaveLength(2);
      expect(plan.steps[0]?.move, category).toEqual({ kind: "retry" });
      expect(plan.steps[1]?.move, category).toEqual({ kind: "re-route", dimension: "provider" });
      expect(
        plan.steps[1]?.facts.reroute.provider?.selection.selected?.route.provider,
        category,
      ).toBe("supply-c");
      expect(plan.terminal.kind, category).toBe("bound-reached");
      // The honest inadmissible retry verdict at the second frame (the
      // attempt economics that force the failover move).
      const retryVerdict = plan.steps[1]?.selection.verdicts.find(
        (verdict) => verdict.strategy === "retry",
      );
      expect(retryVerdict?.admissible, category).toBe(false);
      expect(retryVerdict?.inadmissibleCode, category).toBe("retry-attempt-bound");
    }
  });

  test("the composed ladder matches the corpus's declared EXPECTED_MEDIATED_LADDER", () => {
    const plan = composeForRootFailure("rate-limit");
    expect(plan.steps.map((step) => step.move.kind)).toEqual(
      EXPECTED_MEDIATED_LADDER.steps.map((step) => step.move.kind),
    );
    expect(plan.terminal.kind).toBe(EXPECTED_MEDIATED_LADDER.terminal);
    const failoverRoute = plan.steps[1]?.facts.reroute.provider?.selection.selected?.route.provider;
    expect(failoverRoute).toBe("supply-c");
  });

  test("the retry claim is the cheapest admissible candidate (the deterministic order composes the retry first)", () => {
    const plan = composeForRootFailure("rate-limit");
    const selected = plan.steps[0]?.selection.selected;
    expect(selected?.strategy).toBe("retry");
    const retryCost = Number(selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd);
    const failoverCost = Number(
      plan.steps[0]?.selection.verdicts.find(
        (verdict) => verdict.candidateId === "reroute-provider",
      )?.evaluation?.expectedSuccessfulResolutionCostMicroUsd,
    );
    expect(retryCost).toBeLessThan(failoverCost);
  });
});

// ---------------------------------------------------------------------------
// The verdict-derivation honesty (the truth discipline)
// ---------------------------------------------------------------------------

/** A minimal synthetic cell result for the aggregate-derivation oracles. */
function syntheticCell(options: {
  readonly cellId: string;
  readonly mediatedTasksResolved: number;
  readonly optimizedTasksResolved: number;
  readonly mediatedNano: number;
  readonly optimizedNano: number;
  readonly violations?: readonly ViolationRecord[];
}): CellEvaluationResult {
  const taskCount = 10;
  const summaryOf = (armId: (typeof ARM_IDS)[number], resolved: number, nano: number) => ({
    armId,
    cellId: options.cellId,
    tasksTotal: taskCount,
    tasksResolved: resolved,
    requestsTotal: taskCount,
    requestsResolved: resolved,
    attemptsTotal: taskCount,
    supplyDispatches: taskCount,
    durableReplaysOrCacheHits: 0,
    substrateDeterministic: 0,
    nanoCost: nano,
    microPerResolvedTask: resolved > 0 ? nano / resolved / 1000 : null,
    microPerResolvedRequest: resolved > 0 ? nano / resolved / 1000 : null,
    faultsByCategory: { rateLimit: 0, timeout: 0, unavailable: 0 },
    faultsTotal: 0,
  });
  return {
    cellId: options.cellId,
    capstoneCellId: options.cellId,
    subjectId: "synthetic",
    dimensions: { volume: "S", repetitions: 1, providerConfig: "multi", modality: "mono" },
    corpus: { tasks: taskCount, requests: taskCount },
    arms: {
      "un-retried-direct": summaryOf("un-retried-direct", 5, 500_000),
      "strong-optimized": summaryOf(
        "strong-optimized",
        options.optimizedTasksResolved,
        options.optimizedNano,
      ),
      "mediated-with-plan": summaryOf(
        "mediated-with-plan",
        options.mediatedTasksResolved,
        options.mediatedNano,
      ),
    },
    attempts: [],
    occurrences: [],
    plans: [],
    decisionRecordCount: 0,
    violations: options.violations ?? [],
    digest: `digest-${options.cellId}`,
    wallMs: 0,
    notes: [],
  };
}

describe("PCR-003 the threshold-verdict derivation honesty", () => {
  test("a mediated-better aggregate derives met; the PCR-004 eligibility is NOT eligible", () => {
    const aggregate = aggregateEvaluation([
      syntheticCell({
        cellId: "cell-a",
        mediatedTasksResolved: 10,
        optimizedTasksResolved: 9,
        mediatedNano: 100_000,
        optimizedNano: 100_000,
      }),
    ]);
    expect(aggregate.verdicts.resolution.verdict).toBe("met");
    expect(aggregate.verdicts.resolution.deltaPercentagePoints).toBeGreaterThan(0);
    expect(aggregate.verdicts.cost.verdict).toBe("met");
    expect(aggregate.verdicts.violations.verdict).toBe("met");
    expect(aggregate.verdicts.pcr004Eligibility.sequentialPlansReachedResolutionThreshold).toBe(
      true,
    );
    expect(aggregate.verdicts.pcr004Eligibility.hedgedModeEligible).toBe(false);
    expect(aggregate.verdicts.pcr004Eligibility.statement).toContain("NOT eligible");
    expect(aggregate.verdicts.pcr004Eligibility.statement).toContain("REACHED");
  });

  test("an optimized-better aggregate derives missed WITH attribution (a fabricated pass is unrepresentable)", () => {
    const aggregate = aggregateEvaluation([
      syntheticCell({
        cellId: "cell-b",
        mediatedTasksResolved: 8,
        optimizedTasksResolved: 10,
        mediatedNano: 100_000,
        optimizedNano: 100_000,
      }),
    ]);
    expect(aggregate.verdicts.resolution.verdict).toBe("missed");
    expect(aggregate.verdicts.resolution.deltaPercentagePoints).toBeLessThan(0);
    expect(aggregate.verdicts.resolution.attribution).toContain("8/10");
    expect(aggregate.verdicts.resolution.attribution).toContain("10/10");
    expect(aggregate.verdicts.pcr004Eligibility.sequentialPlansReachedResolutionThreshold).toBe(
      false,
    );
    expect(aggregate.verdicts.pcr004Eligibility.hedgedModeEligible).toBe(true);
    expect(aggregate.verdicts.pcr004Eligibility.statement).toContain("IS eligible");
  });

  test("a higher mediated cost derives documented-tradeoff WITH attribution (never a silent regression)", () => {
    const aggregate = aggregateEvaluation([
      syntheticCell({
        cellId: "cell-c",
        mediatedTasksResolved: 10,
        optimizedTasksResolved: 10,
        mediatedNano: 120_000,
        optimizedNano: 100_000,
      }),
    ]);
    expect(aggregate.verdicts.cost.verdict).toBe("documented-tradeoff");
    expect(aggregate.verdicts.cost.attribution).toContain("documented tradeoff");
    expect(aggregate.verdicts.cost.attribution).toContain("retry step");
  });

  test("any violation flips the hard gate to delivery-blocking", () => {
    const aggregate = aggregateEvaluation([
      syntheticCell({
        cellId: "cell-d",
        mediatedTasksResolved: 10,
        optimizedTasksResolved: 10,
        mediatedNano: 100_000,
        optimizedNano: 100_000,
        violations: [
          {
            kind: "attempt-bound-exceeded",
            armId: "mediated-with-plan",
            cellId: "cell-d",
            detail: "synthetic violation",
          },
        ],
      }),
    ]);
    expect(aggregate.verdicts.violations.count).toBe(1);
    expect(aggregate.verdicts.violations.verdict).toBe("delivery-blocking");
    expect(aggregate.verdicts.violations.records[0]?.kind).toBe("attempt-bound-exceeded");
  });

  test("the aggregate digest is deterministic over identical cells and discriminating over different ones", () => {
    const first = aggregateEvaluation([
      syntheticCell({
        cellId: "x",
        mediatedTasksResolved: 9,
        optimizedTasksResolved: 9,
        mediatedNano: 1,
        optimizedNano: 1,
      }),
    ]);
    const second = aggregateEvaluation([
      syntheticCell({
        cellId: "x",
        mediatedTasksResolved: 9,
        optimizedTasksResolved: 9,
        mediatedNano: 1,
        optimizedNano: 1,
      }),
    ]);
    const different = aggregateEvaluation([
      syntheticCell({
        cellId: "x",
        mediatedTasksResolved: 8,
        optimizedTasksResolved: 9,
        mediatedNano: 1,
        optimizedNano: 1,
      }),
    ]);
    expect(first.digest).toBe(second.digest);
    expect(different.digest).not.toBe(first.digest);
  });
});

// ---------------------------------------------------------------------------
// The violations-scan discriminations (the hard gate's oracle)
// ---------------------------------------------------------------------------

describe("PCR-003 the violations-scan discriminations", () => {
  const cell = hermeticCell();

  const occurrenceOf = (overrides: Partial<OccurrenceEvidence>): OccurrenceEvidence => ({
    armId: "mediated-with-plan",
    cellId: cell.cellId,
    baseTaskId: "task",
    requestIndex: 0,
    rep: 1,
    logicalKey: "subject:task:0",
    surface: "text-generation",
    outcome: "resolved",
    resolutionClass: "resolved-first-attempt",
    attempts: 1,
    totalLatencyMs: 10,
    costNanoUsd: 1000,
    attemptStreamKeys: ["key"],
    ...overrides,
  });

  const attemptOf = (overrides: Partial<AttemptEvidence>): AttemptEvidence => ({
    armId: "mediated-with-plan",
    cellId: cell.cellId,
    streamKey: "key",
    baseTaskId: "task",
    requestIndex: 0,
    rep: 1,
    attempt: 1,
    providerId: "supply-a",
    surface: "text-generation",
    modalityClass: "text",
    outcome: "success",
    failureCategory: null,
    retryable: null,
    latencyMs: 10,
    costNanoUsd: 1000,
    inputTokens: 10,
    outputTokens: 5,
    attribution: null,
    strategyVerdict: null,
    ...overrides,
  });

  const scanOf = (overrides: {
    readonly occurrences?: readonly OccurrenceEvidence[];
    readonly attempts?: readonly AttemptEvidence[];
    readonly plans?: readonly PlanEvidence[];
    readonly invalidPlanArtifacts?: readonly string[];
    readonly mediatedTasksTotal?: number;
    readonly mediatedTasksResolved?: number;
  }) =>
    scanViolations({
      cell,
      armRuns: [
        {
          armId: "mediated-with-plan",
          occurrences: overrides.occurrences ?? [occurrenceOf({})],
          attempts: overrides.attempts ?? [attemptOf({})],
        },
      ],
      mediatedPlans: overrides.plans ?? [],
      invalidPlanArtifacts: overrides.invalidPlanArtifacts ?? [],
      mediatedTasksTotal: overrides.mediatedTasksTotal ?? 1,
      mediatedTasksResolved: overrides.mediatedTasksResolved ?? 1,
    });

  test("a clean run records zero violations", () => {
    expect(scanOf({})).toEqual([]);
  });

  test("an over-bound occurrence is caught (the mediated arm's 3-attempt bound)", () => {
    const violations = scanOf({
      occurrences: [occurrenceOf({ attempts: 4 })],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("attempt-bound-exceeded");
    expect(violations[0]?.detail).toContain("took 4 attempts");
  });

  test("an over-budget occurrence is caught (the declared per-execution ceiling)", () => {
    const violations = scanOf({
      occurrences: [occurrenceOf({ costNanoUsd: 10_000_001 })],
    });
    expect(violations[0]?.kind).toBe("budget-ceiling-exceeded");
  });

  test("an unregistered route is caught (the route policy)", () => {
    const violations = scanOf({
      attempts: [attemptOf({ providerId: "supply-z" })],
    });
    expect(violations[0]?.kind).toBe("route-policy-violation");
    expect(violations[0]?.detail).toContain("supply-z");
  });

  test("the deterministic substrate route is admitted for the mediated arm only", () => {
    expect(scanOf({ attempts: [attemptOf({ providerId: "deterministic" })] })).toEqual([]);
    const directViolations = scanViolations({
      cell,
      armRuns: [
        {
          armId: "un-retried-direct",
          occurrences: [],
          attempts: [attemptOf({ armId: "un-retried-direct", providerId: "deterministic" })],
        },
      ],
      mediatedPlans: [],
      invalidPlanArtifacts: [],
      mediatedTasksTotal: 0,
      mediatedTasksResolved: 0,
    });
    expect(directViolations[0]?.kind).toBe("route-policy-violation");
  });

  test("an over-bound plan is caught (the configured step bound)", () => {
    const violations = scanOf({
      plans: [
        {
          executionId: "exec",
          planSteps: [
            {
              move: "retry",
              dimension: null,
              candidateId: "a",
              strategy: "retry",
              claimCostMicroUsd: "1",
              failoverRoute: null,
            },
            {
              move: "retry",
              dimension: null,
              candidateId: "b",
              strategy: "retry",
              claimCostMicroUsd: "1",
              failoverRoute: null,
            },
            {
              move: "retry",
              dimension: null,
              candidateId: "c",
              strategy: "retry",
              claimCostMicroUsd: "1",
              failoverRoute: null,
            },
          ],
          terminal: "bound-reached",
          rootFailureClass: "provider",
          rootFailureSignal: "provider-rate-limited",
          rootObservationDigest: "d".repeat(64),
        },
      ],
    });
    expect(violations[0]?.kind).toBe("plan-bound-exceeded");
    expect(violations[0]?.detail).toContain("3 steps");
  });

  test("an invalid plan artifact is caught", () => {
    const violations = scanOf({ invalidPlanArtifacts: ["tampered plan content"] });
    expect(violations[0]?.kind).toBe("plan-artifact-invalid");
    expect(violations[0]?.detail).toContain("tampered plan content");
  });

  test("an incoherent task↔request outcome is caught (both directions)", () => {
    const runnerSaysFailed = scanOf({ mediatedTasksTotal: 2, mediatedTasksResolved: 1 });
    expect(runnerSaysFailed[0]?.kind).toBe("task-outcome-incoherent");
    const evidenceSaysFailed = scanOf({
      occurrences: [occurrenceOf({ outcome: "failed", resolutionClass: "failed" })],
      mediatedTasksTotal: 1,
      mediatedTasksResolved: 1,
    });
    expect(evidenceSaysFailed[0]?.kind).toBe("task-outcome-incoherent");
  });
});

// ---------------------------------------------------------------------------
// The percentile convention (the tail-accounting arithmetic)
// ---------------------------------------------------------------------------

describe("PCR-003 the percentile convention", () => {
  test("the ceil-index convention over known arrays; empty input is null", () => {
    expect(percentileOf([], 0.95)).toBeNull();
    expect(percentileOf([10], 0.95)).toBe(10);
    // 20 samples sorted: p95 index = ceil(20*0.95)-1 = 18 (the 19th).
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentileOf(samples, 0.95)).toBe(19);
    expect(percentileOf(samples, 0.99)).toBe(20);
    // 3 samples: p95 = ceil(2.85)-1 = 2 (the last).
    expect(percentileOf([5, 1, 9], 0.95)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary disciplines (VAL-002 AC7 — the app tree never
// imports src/**; every locally-implemented or captured platform need is
// pinned byte-for-byte against the platform's own implementation)
// ---------------------------------------------------------------------------

describe("PCR-003 the boundary disciplines (byte-for-byte pins)", () => {
  test("the app-local canonical serializer is byte-identical to the platform's (the WORK-008 discipline)", () => {
    const corpus = [
      evaluationCorpusForm(),
      { b: 2, a: 1, nested: { z: "last", a: [3, 1, 2], m: null } },
      { strings: ['quote"', "back\\slash", "newline\n", "tab\t", "ctrl\x01"] },
      { numbers: [0, -1, 0.5, 1e-7, 123.456789] },
      [[], [[]], [null, true, false]],
      "a bare string",
      42,
    ];
    for (const value of corpus) {
      expect(canonicalJson(value)).toBe(platformCanonicalJson(value));
    }
    // The closed universe rejects identically (fail-closed, never a guess).
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { x: Number.NEGATIVE_INFINITY }]) {
      expect(() => canonicalJson(bad)).toThrow();
      expect(() => platformCanonicalJson(bad)).toThrow();
    }
  });

  test("the app-local digest port is byte-identical to the platform's createNodeDigest()", () => {
    const appPort = createEvaluationDigestPort();
    const platformPort = createNodeDigest();
    const corpus = [
      "",
      "pcr-003",
      "ppr-027:fault:rate-limit:stream-key:1",
      JSON.stringify(evaluationCorpusForm()),
      "unicode: ünïcödé — em-dash — 中文",
    ];
    for (const value of corpus) {
      expect(appPort.sha256Hex(value)).toBe(platformPort.sha256Hex(value));
      expect(appPort.sha256Hex(value)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the pinned governed IR is the byte-exact output of a LIVE platform construction (drift-visible)", () => {
    const nodeDigest = createNodeDigest();
    const planSource = createIrPlanSource();
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
          {
            id: MEDIATED_PLAN_STEP_ID,
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "supply-a", model: "synth-text" },
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch", to: MEDIATED_PLAN_STEP_ID },
          { from: MEDIATED_PLAN_STEP_ID, to: "verify" },
        ],
      },
      (value) => nodeDigest.sha256Hex(platformCanonicalJson(value)),
    );
    const liveIr = deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
    // Deep equality AND content-addressed identity — the capture is exact;
    // any platform-side drift in the governed IR's derivation fails here.
    expect(EVALUATION_GOVERNED_IR).toEqual(liveIr);
    expect(EVALUATION_GOVERNED_IR.irId).toBe(liveIr.irId);
    expect(EVALUATION_GOVERNED_IR.irId).toMatch(/^[0-9a-f]{64}$/);
    // The generative step the seam resolves is present and generative.
    const step = EVALUATION_GOVERNED_IR.steps.find(
      (candidate) => candidate.id === MEDIATED_PLAN_STEP_ID,
    );
    expect(step?.stepClass).toBe("call-model");
  });

  test("the app tree imports no src/** (the customer boundary — VAL-002 AC7)", () => {
    const appDir = join(
      process.cwd(),
      "benchmarks/validation/apps/economic-recovery-plan-evaluation",
    );
    const violations: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "results") {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
            const specifier = match[1] ?? "";
            if (/\/src\/|^\.\.\/src/.test(specifier)) {
              violations.push(`${full}: ${specifier}`);
            }
          }
        }
      }
    };
    visit(appDir);
    expect(violations).toEqual([]);
  });
});
