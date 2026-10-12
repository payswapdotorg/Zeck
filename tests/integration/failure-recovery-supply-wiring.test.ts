/**
 * Integration: the PCR-002 default-off plan-composition wiring at the
 * TRACED retry/failover seam (ACR-008 §6 — the program's honesty
 * anchors).
 *
 * The traced seam is `experiments/ppr-027/compose.ts` —
 * `dispatchWithPolicyRetry`, the platform-side provider-selection
 * policy of the PPR-027 mediated arm: attempt 1 round-robins across the
 * registered supplies; the ONE policy retry fails over to the NEXT
 * supply on a retryable provider failure. THIS suite drives the REAL
 * wired stack (the real API world, the real model gateway, the real
 * synthetic supply transport) through the deterministic draw profiles:
 *
 *  - PLAN MODE OFF (the default — absent AND explicit) byte-preserves
 *    the traced posture: the observable dispatch sequence (supplies
 *    addressed, attempt numbers, outcomes, usage, cost facts, policy
 *    retry flags) is IDENTICAL with and without the recovery wiring;
 *  - PLAN MODE ON (an evaluation/tenant configuration ONLY, in a
 *    hermetic fixture) composes the bounded recovery plan through the
 *    PCR-001 composer, executes its dispatch-representable steps and
 *    appends every plan step's decision record through the EXISTING
 *    WORK-049 seam (validated by the foundation's own total
 *    validation).
 */

import { describe, expect, test } from "vitest";
import { composeExperimentStack, type ExperimentStack } from "../../experiments/ppr-027/compose";
import type { SubjectDefinition, SubjectEdge } from "../../experiments/ppr-027/config";
import { drawnFault } from "../../experiments/ppr-027/transport";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../src/modules/planning/public";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../src/platform/execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../../src/platform/execution-ir/decision-record";
import { validateOptimizationDecision } from "../../src/platform/execution-ir/decision-record";
import { deriveExecutionIr, type ExecutionIr } from "../../src/platform/execution-ir/ir";
import type { RecoveryPlan } from "../../src/platform/failure-recovery/plan";
import { ACTOR_ID } from "../unit/api/world";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

// ---------------------------------------------------------------------------
// The hermetic fixtures
// ---------------------------------------------------------------------------

const EDGE: SubjectEdge = { edgeId: "edge-1", surface: "text-generation", modalityClass: "text" };

const SUBJECT: SubjectDefinition = {
  subjectId: "pcr-002-integration",
  name: "PCR-002 integration subject",
  repository: "pcr-002/integration",
  upstreamRevision: "integration",
  integrationRevision: "integration",
  evidenceRecord: "pcr-002-integration",
  requestCountBasis: "resolved-corpus-narrative",
  tokenTotalsBasis: "resolved-corpus-narrative",
  edges: [EDGE],
  tasks: [],
  certifiedTotals: { requests: 0, inputTokens: 0, outputTokens: 0 },
};

const WORKLOAD = { edgeId: "edge-1", inputTokens: 500, outputTokens: 200 };

/** The governed Execution IR through the REAL planning seam (a generative step). */
function governedIr(): ExecutionIr {
  const plan = buildPlan(
    {
      revision: 1,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "generate",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "supply-a", model: "synth-text" },
        },
        { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: [
        { from: "fetch", to: "generate" },
        { from: "generate", to: "verify" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "planning" },
      payload: { minQuality: 0.8 },
    },
    {
      constraintId: "budget-ceiling",
      kind: "budget",
      enforcement: "hard",
      source: { authority: "budget", budgetId: "budget-1", scopeKind: "per-execution" },
      payload: { maxCostMicroUsd: "1000000" },
    },
  ];
}

function claim(expectedCostMicroUsd: string, expectedLatencyMs: number, source: string): CostClaim {
  return {
    expectedCostMicroUsd,
    expectedLatencyMs,
    expectedQuality: 0.92,
    expectedReliability: 0.95,
    basis: { basis: "estimated", source },
  };
}

// ---------------------------------------------------------------------------
// The deterministic draw profiles (the transport's draws are pure
// functions of (streamKey, attempt, providerId) — scanned, never guessed)
// ---------------------------------------------------------------------------

type FaultShape = "retryable" | "non-retryable" | "clean";

function faultShapeOf(transportStreamKey: string, attempt: number, providerId: string): FaultShape {
  const fault = drawnFault({
    providerId,
    edge: EDGE,
    request: WORKLOAD,
    streamKey: transportStreamKey,
    attempt,
  });
  if (fault === null) {
    return "clean";
  }
  return fault.retryable ? "retryable" : "non-retryable";
}

/**
 * Scan for a task stream key whose draw profile matches the wanted
 * shapes, in order. The entries address the TRANSPORT stream key
 * (`${taskStreamKey}:d${occurrence}` — the physical-dispatch
 * occurrence suffix) at the given attempt and supply.
 */
function streamKeyWithProfile(
  wanted: readonly {
    occurrence: number;
    attempt: number;
    providerId: string;
    shape: FaultShape;
  }[],
): string {
  for (let index = 0; index < 200_000; index += 1) {
    const candidate = `pcr002-${index}`;
    if (
      wanted.every(
        (entry) =>
          faultShapeOf(`${candidate}:d${entry.occurrence}`, entry.attempt, entry.providerId) ===
          entry.shape,
      )
    ) {
      return candidate;
    }
  }
  throw new Error("no stream key matched the wanted draw profile");
}

/**
 * The three-request battery (the traced posture's full decision table,
 * driven in this order so the round-robin addresses supply-a, supply-b,
 * supply-c on the first attempts; the one policy retry of request 2
 * fails over b→a under the round-robin's post-increment indexing):
 *  1. a CLEAN first attempt on supply-a (no retry);
 *  2. a RETRYABLE first-attempt failure on supply-b whose ONE failover
 *     retry (to supply-a) succeeds (the traced posture's happy
 *     recovery);
 *  3. a NON-RETRYABLE first-attempt failure on supply-c (no retry —
 *     the honest terminal).
 */
const CLEAN_KEY = streamKeyWithProfile([
  { occurrence: 1, attempt: 1, providerId: "supply-a", shape: "clean" },
]);
const RETRYABLE_KEY = streamKeyWithProfile([
  { occurrence: 2, attempt: 1, providerId: "supply-b", shape: "retryable" },
  { occurrence: 2, attempt: 2, providerId: "supply-a", shape: "clean" },
]);
const NON_RETRYABLE_KEY = streamKeyWithProfile([
  { occurrence: 3, attempt: 1, providerId: "supply-c", shape: "non-retryable" },
]);

const NO_OP_SLEEPER = async (): Promise<void> => {};

async function drive(stack: ExperimentStack, streamKey: string): Promise<void> {
  await stack.world.executions.createExecution(
    {
      applicationId: stack.applicationId,
      task: {
        kind: "ppr-027.workload",
        edgeId: "edge-1",
        surface: "text-generation",
        role: "text",
        inputTokens: WORKLOAD.inputTokens,
        outputTokens: WORKLOAD.outputTokens,
        streamKey,
      },
      constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 30_000 },
      metadata: { origin: "pcr-002-integration", streamKey },
    },
    `pcr-002-integration-${streamKey}`,
    { actorId: ACTOR_ID, tenantId: stack.world.tenantId },
  );
}

/** The deterministic projection of the dispatch-facts journal (wall-clock latency and execution identity excluded). */
function dispatchSequence(stack: ExperimentStack) {
  return stack.dispatchFacts().map((fact) => ({
    providerId: fact.providerId,
    attempt: fact.attempt,
    outcome: fact.outcome,
    usage: fact.usage,
    costNanoUsd: fact.costNanoUsd,
    policyRetry: fact.policyRetry,
  }));
}

async function withStack(
  recovery: Parameters<typeof composeExperimentStack>[0]["recovery"],
  driveKeys: readonly string[],
): Promise<ExperimentStack> {
  const stack = await composeExperimentStack({
    subject: SUBJECT,
    providerConfig: "multi",
    providerIds: ["supply-a", "supply-b", "supply-c"],
    retryCooldownMs: 1,
    sleeper: NO_OP_SLEEPER,
    ...(recovery === undefined ? {} : { recovery }),
  });
  try {
    for (const key of driveKeys) {
      await drive(stack, key);
    }
    return stack;
  } catch (error) {
    await stack.close();
    throw error;
  }
}

describe("the PCR-002 default-off wiring at the traced retry/failover seam (ACR-008 §6)", () => {
  test("PLAN MODE OFF BYTE-PRESERVES the traced one-failover-retry posture (the honesty anchor)", async () => {
    // The BASE stack: no recovery wiring at all (the pre-PCR-002
    // configuration — the traced posture as it lived at the base).
    const base = await withStack(undefined, [CLEAN_KEY, RETRYABLE_KEY, NON_RETRYABLE_KEY]);
    try {
      // The WIRED stack: the recovery wiring present with plan mode
      // explicitly OFF (the default-off configuration).
      const wiredOff = await withStack({ planMode: "off" }, [
        CLEAN_KEY,
        RETRYABLE_KEY,
        NON_RETRYABLE_KEY,
      ]);
      try {
        // The traced posture's decision table, asserted on the REAL
        // wired seam (the journal's deterministic projection):
        const sequence = dispatchSequence(base);
        expect(sequence).toEqual([
          // 1. clean first attempt on supply-a: resolved, no retry.
          {
            providerId: "supply-a",
            attempt: 1,
            outcome: "provider-success",
            usage: { inputTokens: 500, outputTokens: 200 },
            costNanoUsd: 0,
            policyRetry: false,
          },
          // 2. retryable failure on supply-b: the ONE policy retry
          //    fails over to supply-a (the round-robin's next supply)
          //    and resolves.
          {
            providerId: "supply-a",
            attempt: 2,
            outcome: "provider-success",
            usage: { inputTokens: 500, outputTokens: 200 },
            costNanoUsd: 0,
            policyRetry: true,
          },
          // 3. non-retryable failure on supply-c: no retry (the honest
          //    terminal — the traced posture never retries it).
          {
            providerId: "supply-c",
            attempt: 1,
            outcome: "provider-failure",
            usage: { inputTokens: 0, outputTokens: 0 },
            costNanoUsd: 0,
            policyRetry: false,
          },
        ]);
        // THE BYTE-PRESERVATION PROOF: the wired off-mode stack's
        // observable dispatch sequence is byte-identical to the base's.
        expect(JSON.stringify(dispatchSequence(wiredOff))).toBe(JSON.stringify(sequence));
      } finally {
        await wiredOff.close();
      }
    } finally {
      await base.close();
    }
  }, 60_000);

  test("PLAN MODE ON (an evaluation/tenant configuration only, hermetic fixture) composes, executes and records through the EXISTING WORK-049 seam", async () => {
    const composedPlans: RecoveryPlan[] = [];
    const decisionRecords: OptimizationDecisionRecord[] = [];
    const stack = await composeExperimentStack({
      subject: SUBJECT,
      providerConfig: "multi",
      providerIds: ["supply-a", "supply-b", "supply-c"],
      retryCooldownMs: 1,
      sleeper: NO_OP_SLEEPER,
      recovery: {
        planMode: "on",
        plan: {
          planConfiguration: {
            maxRetryAttempts: 3,
            escalationEvidenceBound: 8,
            continuationStepBound: 32,
            maxPlanSteps: 4,
            planMode: "on",
          },
          qualityFacts: { requiredQuality: 0.85 },
          constraints: constraints(),
          retryClaim: claim("400", 2000, "recovery:retry-path"),
          providerAlternates: [
            { providerId: "supply-b", claim: claim("300", 1600, "model-economics:alternate-b") },
            { providerId: "supply-c", claim: claim("310", 1900, "model-economics:alternate-c") },
          ],
          ir: governedIr(),
          stepId: "generate",
          digest: nodeDigest,
          onPlanComposed: (plan) => {
            composedPlans.push(plan);
          },
          onDecisionRecords: (records) => {
            decisionRecords.push(...records);
          },
        },
      },
    });
    try {
      // A retryable first-attempt failure on supply-a whose
      // provider-failover re-route (the declared cheapest alternate,
      // supply-b) resolves on attempt 2.
      const key = streamKeyWithProfile([
        { occurrence: 1, attempt: 1, providerId: "supply-a", shape: "retryable" },
        { occurrence: 1, attempt: 2, providerId: "supply-b", shape: "clean" },
      ]);
      await drive(stack, key);
      // The plan composed through the PCR-001 composer: bounded steps,
      // dispatch-representable moves, the typed terminal.
      expect(composedPlans).toHaveLength(1);
      const plan = composedPlans[0];
      if (plan === undefined) {
        throw new Error("the plan was not observed");
      }
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.length).toBeLessThanOrEqual(4);
      // The declared economics (the failover alternates cheaper than
      // the retry claim) compose the multi-provider failover ladder —
      // the exact governed answer to the PPR-027 multi-provider gap.
      expect(plan.steps[0]?.move).toEqual({ kind: "re-route", dimension: "provider" });
      for (const step of plan.steps) {
        expect(step.move.kind === "re-route" || step.move.kind === "retry").toBe(true);
      }
      // Every composed plan step's decision was recorded through the
      // EXISTING WORK-049 seam — the records pass the foundation's OWN
      // total validation (real values, never a parallel shape).
      expect(decisionRecords).toHaveLength(plan.steps.length);
      for (const record of decisionRecords) {
        const validated = validateOptimizationDecision(record, nodeDigest);
        expect(validated.applicationId).toBe(stack.applicationId);
        expect(validated.transformationBasis.detail).toContain("failure-recovery");
        expect(validated.transformationBasis.detail).toContain("attribution=");
      }
      // The seam EXECUTED the composed plan: the failover re-route
      // dispatched on the step's own selected route (supply-b) and
      // resolved on attempt 2 — the bounded multi-move recovery the
      // PPR-027 gap named.
      const sequence = dispatchSequence(stack);
      expect(sequence).toEqual([
        {
          providerId: "supply-b",
          attempt: 2,
          outcome: "provider-success",
          usage: { inputTokens: 500, outputTokens: 200 },
          costNanoUsd: 0,
          policyRetry: true,
        },
      ]);
    } finally {
      await stack.close();
    }
  }, 60_000);
});
