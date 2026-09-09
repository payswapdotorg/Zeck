/**
 * Shared fixtures for the substrate-economics unit suites (WORK-054):
 * a governed plan → derived IR (through the planning module's public
 * buildPlan — the WORK-052 helper precedent), the governing constraint
 * set WITH the hard quality floor the selection derivation requires,
 * and the representative substrate-fact corpus.
 */

import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr, type ExecutionIr } from "../../../../src/platform/execution-ir/ir";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
export const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";

export function governedIr(
  steps?: Parameters<typeof buildPlan>[0]["steps"],
  edges?: Parameters<typeof buildPlan>[0]["edges"],
): ExecutionIr {
  const plan = buildPlan(
    {
      revision: 1,
      strategyClass: "hybrid",
      steps: steps ?? [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: edges ?? [
        { from: "fetch", to: "gen" },
        { from: "gen", to: "check" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

/** The governing constraint set WITH the hard quality floor (the selection derivation requires it). */
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
      constraintId: "capability-satisfaction",
      kind: "capability",
      enforcement: "hard",
      source: { authority: "capability", catalogRevision: "r1" },
      payload: {
        satisfiedIds: ["document-retrieval", "text-generation"],
        unmetIds: [],
      },
    },
  ];
}

/** The representative substrate-fact corpus (explicit-basis candidates). */
export function substrateCorpus(): unknown[] {
  return [
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
        basis: { basis: "observed", source: "substrate-observer:fleet-telemetry" },
      },
      startup: {
        cold: {
          readinessMs: 9000,
          startupCostMicroUsd: "120",
          basis: { basis: "estimated", source: "substrate-facts:measured-corpus" },
        },
        warm: {
          readinessMs: 400,
          startupCostMicroUsd: "15",
          basis: { basis: "observed", source: "substrate-observer:warm-pool" },
        },
      },
      description: null,
    },
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
      substrateId: "cheap-process-c",
      version: "1.0.1",
      adapterRef: "substrate-adapter-03",
      isolation: "process",
      execution: {
        expectedCostMicroUsd: "50",
        expectedLatencyMs: 1000,
        expectedQuality: 0.6,
        expectedReliability: 0.8,
        basis: { basis: "estimated", source: "substrate-observer:process-class" },
      },
      startup: {
        cold: {
          readinessMs: 100,
          startupCostMicroUsd: "1",
          basis: { basis: "defaulted", source: "substrate-facts:process-default" },
        },
      },
      description: null,
    },
  ];
}
