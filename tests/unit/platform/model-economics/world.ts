/**
 * The shared model-economics unit-test world (WORK-053): the governed
 * Execution IR fixtures (through the REAL planning seam and the REAL
 * foundation derivation — the plane only ever runs on governed IRs),
 * the representative governing constraint sets, and the explicit-basis
 * claim builder.
 */

import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../../../src/platform/execution-ir/cost-model";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
export const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
export const RECORDED_AT = "2026-09-23T09:00:00.000Z";

interface StepSpec {
  readonly id: string;
  readonly stepClass: "retrieve" | "call-model" | "verify";
  readonly capabilityId?: string;
  readonly routeRef?: { readonly provider: string; readonly model: string };
  readonly verificationStrategy?: string;
}

function irOf(steps: readonly StepSpec[], edges: readonly { from: string; to: string }[]) {
  const plan = buildPlan(
    {
      revision: 7,
      strategyClass: "hybrid",
      steps: steps.map((step) => ({
        ...step,
        ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
        ...(step.routeRef === undefined ? {} : { routeRef: step.routeRef }),
        ...(step.verificationStrategy === undefined
          ? {}
          : { verificationStrategy: step.verificationStrategy }),
      })),
      edges,
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

/**
 * The representative governed IR: a generative step with an INCUMBENT
 * route (rail-a/model-x) plus a verification anchor — the identity
 * basis of model-economics selections is derivable from it.
 */
export function governedIr() {
  return irOf(
    [
      { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
      {
        id: "generate",
        stepClass: "call-model",
        capabilityId: "text-generation",
        routeRef: { provider: "rail-a", model: "model-x" },
      },
      { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
    ],
    [
      { from: "fetch", to: "generate" },
      { from: "generate", to: "verify" },
    ],
  );
}

/**
 * A governed IR whose generative step carries NO incumbent route (a
 * legal governed-plan shape: routes may be bound later by the
 * model-economics evidence the planner consumes).
 */
export function governedIrWithoutIncumbentRoute() {
  return irOf(
    [
      {
        id: "generate",
        stepClass: "call-model",
        capabilityId: "text-generation",
      },
      { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
    ],
    [{ from: "generate", to: "verify" }],
  );
}

/**
 * The representative governing set: a hard policy route restriction
 * (both neutral rails allowed), a hard quality floor BELOW the
 * assurance thresholds used in the tests (so the assurance/hard
 * split is exercisable), and the verification anchor binding.
 */
export function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
      payload: { providerModel: { allowedProviders: ["rail-a", "rail-b"] } },
    },
    {
      constraintId: "policy-quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
      payload: { minQuality: 0.85 },
    },
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
    },
  ];
}

/** A hard reliability floor constraint (the escalation/agent seam). */
export function reliabilityFloorConstraint(minReliability: number): OptimizationConstraint {
  return {
    constraintId: "policy-reliability-floor",
    kind: "quality",
    enforcement: "hard",
    source: { authority: "policy", policySetId: "ps-1" },
    payload: { minReliability },
  };
}

/** An explicit-basis claim builder (bounded, attributed — always). */
export function claim(input: {
  readonly cost: string;
  readonly latency: number;
  readonly quality: number;
  readonly reliability: number;
  readonly basis?: "observed" | "estimated" | "defaulted";
  readonly source?: string;
}): CostClaim {
  return {
    expectedCostMicroUsd: input.cost,
    expectedLatencyMs: input.latency,
    expectedQuality: input.quality,
    expectedReliability: input.reliability,
    basis: {
      basis: input.basis ?? "estimated",
      source: input.source ?? "planning.route-table",
    },
  };
}
