/**
 * The shared failure-recovery unit-test world (WORK-055): the governed
 * Execution IR fixtures (through the REAL planning seam and the REAL
 * foundation derivation — the plane only ever runs on governed IRs),
 * the representative governing constraint sets, the economics-planes
 * selection fixtures (the model-economics and substrate-economics
 * results the re-route facts consume, built through the planes' OWN
 * functions), and the explicit-basis claim builders.
 */

import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../../../src/platform/execution-ir/cost-model";
import {
  deriveExecutionIr,
  type ExecutionIr,
  type IrDigestPort,
} from "../../../../src/platform/execution-ir/ir";
import type {
  FailureAttribution,
  FailureObservation,
} from "../../../../src/platform/failure-recovery/attribution";
import { attributeFailure } from "../../../../src/platform/failure-recovery/attribution";
import { decideFreshEscalation } from "../../../../src/platform/model-economics/escalation-hooks";
import { selectModelRepresentation } from "../../../../src/platform/model-economics/model-selection";
import type { ModelCandidate } from "../../../../src/platform/model-economics/vocabulary";
import {
  deriveSelectionConstraints,
  selectSubstrate,
} from "../../../../src/platform/substrate-economics/selection";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
export const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
export const RECORDED_AT = "2026-09-23T09:00:00.000Z";
export const OBSERVED_AT = "2026-09-23T08:59:00.000Z";

/** The shared digest port (injected, never ambient). */
export const digest: IrDigestPort = nodeDigest;

/** A governed IR with a generative step carrying an incumbent route. */
export function governedIr(): ExecutionIr {
  const plan = buildPlan(
    {
      revision: 7,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "generate",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
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

/** The governing constraint set (hard quality floor + budget ceiling). */
export function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "planning" },
      payload: { minQuality: 0.8 },
    },
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
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

// ---------------------------------------------------------------------------
// The observation/attribution fixtures
// ---------------------------------------------------------------------------

/** A representative failure observation (infrastructure). */
export function infraObservation(): FailureObservation {
  return {
    signal: "transport-unreachable",
    component: "edge-gateway",
    stepId: "generate",
    routeRef: { provider: "rail-a", model: "model-x" },
    detail: "the edge gateway reported the upstream unreachable after 3 attempts",
    observedAt: OBSERVED_AT,
    observationDigest: digest.sha256Hex("observation:transport-unreachable:edge-gateway"),
  };
}

/** An attributed infrastructure failure (transient). */
export function infraAttribution(): FailureAttribution {
  return attributeFailure(
    infraObservation(),
    "infrastructure",
    { kind: "infrastructure", transient: true },
    digest,
  );
}

/** An attributed intelligence failure (verification-driven). */
export function intelligenceAttribution(): FailureAttribution {
  return attributeFailure(
    {
      signal: "verification-failed",
      component: "verification-authority",
      stepId: "verify",
      detail: "the schema-check verifier returned FAIL on the generated output",
      observedAt: OBSERVED_AT,
      observationDigest: digest.sha256Hex("observation:verification-failed:verify"),
    },
    "intelligence",
    { kind: "intelligence", observedQuality: 0.4, verificationId: "verif-1" },
    digest,
  );
}

/** An attributed provider failure (rate-limited). */
export function providerAttribution(): FailureAttribution {
  return attributeFailure(
    {
      signal: "provider-rate-limited",
      component: "provider-gateway",
      stepId: "generate",
      routeRef: { provider: "rail-a", model: "model-x" },
      detail: "the provider rail rejected the call with a rate limit",
      observedAt: OBSERVED_AT,
      observationDigest: digest.sha256Hex("observation:provider-rate-limited:rail-a"),
    },
    "provider",
    { kind: "provider", providerErrorClass: "rate-limited" },
    digest,
  );
}

/** An attributed resource-budget failure. */
export function budgetAttribution(): FailureAttribution {
  return attributeFailure(
    {
      signal: "resource-exhausted",
      component: "budget-authority",
      stepId: "generate",
      detail: "the per-execution budget ceiling was reached",
      observedAt: OBSERVED_AT,
      observationDigest: digest.sha256Hex("observation:resource-exhausted:budget"),
    },
    "resource",
    { kind: "resource", resourceKind: "budget" },
    digest,
  );
}

// ---------------------------------------------------------------------------
// The economics-planes fixtures (built through the planes' OWN functions)
// ---------------------------------------------------------------------------

/** The model-route candidate corpus the re-route facts consume. */
export const MODEL_CANDIDATES: readonly ModelCandidate[] = [
  {
    candidateId: "rail-b-model-y",
    route: { provider: "rail-b", model: "model-y" },
    representationClass: "sufficient-model",
    claim: claim("300", 1800, 0.9, 0.95, "model-economics:alternative-route-table"),
  },
  {
    candidateId: "rail-c-model-z",
    route: { provider: "rail-c", model: "model-z" },
    representationClass: "stronger-model",
    claim: claim("900", 2600, 0.95, 0.97, "model-economics:alternative-route-table"),
  },
];

/** The explicit-basis claim builder. */
export function claim(
  expectedCostMicroUsd: string,
  expectedLatencyMs: number,
  expectedQuality: number,
  expectedReliability: number,
  source: string,
): CostClaim {
  return {
    expectedCostMicroUsd,
    expectedLatencyMs,
    expectedQuality,
    expectedReliability,
    basis: { basis: "estimated", source },
  };
}

/** A model-economics selection over the alternative-route corpus (via the plane's own function). */
export function modelRerouteFacts(governing: readonly OptimizationConstraint[]) {
  const selection = selectModelRepresentation({
    ir: governedIr(),
    stepId: "generate",
    candidates: [...MODEL_CANDIDATES],
    qualityFacts: { requiredQuality: 0.85 },
    constraints: governing,
  });
  return { selection, declaredCandidates: [...MODEL_CANDIDATES] };
}

/** A substrate-economics selection result (via the plane's own function). */
export function substrateRerouteFacts(governing: readonly OptimizationConstraint[]) {
  const derived = deriveSelectionConstraints(governing);
  return selectSubstrate(
    {
      candidates: substrateCorpus(),
      constraints: derived.constraints,
      sourceConstraintIds: derived.sourceConstraintIds,
      recordedAt: RECORDED_AT,
    },
    nodeDigest,
  );
}

/** The representative substrate-fact corpus (the WORK-054 fixture shape). */
export function substrateCorpus(): unknown[] {
  return [
    {
      substrateId: "mid-container-b",
      version: "2.0.0",
      adapterRef: "substrate-adapter-02",
      isolation: "container",
      execution: {
        expectedCostMicroUsd: "200",
        expectedLatencyMs: 2000,
        expectedQuality: 0.88,
        expectedReliability: 0.93,
        basis: { basis: "observed", source: "substrate-observer:container-fleet" },
      },
      startup: {
        cold: {
          readinessMs: 4000,
          startupCostMicroUsd: "60",
          basis: { basis: "estimated", source: "substrate-facts:container-cold" },
        },
        snapshot: {
          readinessMs: 1200,
          startupCostMicroUsd: "25",
          basis: { basis: "observed", source: "substrate-observer:snapshot" },
        },
      },
      description: null,
    },
    {
      substrateId: "std-microvm-a",
      version: "1.2.0",
      adapterRef: "substrate-adapter-01",
      isolation: "microvm",
      execution: {
        expectedCostMicroUsd: "400",
        expectedLatencyMs: 3000,
        expectedQuality: 0.9,
        expectedReliability: 0.95,
        basis: { basis: "observed", source: "substrate-fleet-telemetry" },
      },
      startup: {
        cold: {
          readinessMs: 9000,
          startupCostMicroUsd: "120",
          basis: { basis: "estimated", source: "substrate-facts:measured-corpus" },
        },
      },
      description: null,
    },
  ];
}

/** A fresh-escalation decision via the model-economics hook (the escalation justification). */
export function freshEscalationDecision(justified: boolean) {
  return decideFreshEscalation({
    continuation: claim(
      justified ? "1500" : "400",
      5000,
      justified ? 0.7 : 0.9,
      0.9,
      "recovery:continuation-path",
    ),
    freshContext: claim("600", 5200, 0.92, 0.94, "recovery:fresh-context-path"),
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
  });
}
