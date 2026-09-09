/**
 * Shared fixtures for the context-economics unit suites (WORK-052):
 * a governed plan → derived IR → compiled variant carrying REAL
 * memoization-hook annotations (through the WORK-050 compiler, the
 * fixed annotation contract this plane consumes), plus the common
 * scope/policy/fact builders.
 */

import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import {
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
} from "../../../../src/platform/execution-compiler/catalog";
import { compileExecutionIr } from "../../../../src/platform/execution-compiler/pipeline";
import type { ExecutionIrVariant } from "../../../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr, type ExecutionIr } from "../../../../src/platform/execution-ir/ir";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

export const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
export const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
export const OTHER_TENANT_ID = "00000000-0000-7000-8000-0000000000dd";
export const OTHER_APPLICATION_ID = "00000000-0000-7000-8000-0000000000ee";
export const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";

export const SCOPE = { tenantId: TENANT_ID, applicationId: APPLICATION_ID };
export const OTHER_TENANT_SCOPE = {
  tenantId: OTHER_TENANT_ID,
  applicationId: OTHER_APPLICATION_ID,
};

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

export function constraints(): OptimizationConstraint[] {
  return [
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

/** A compiled variant over the representative governed IR. */
export function compiledVariant(ir?: ExecutionIr): ExecutionIrVariant {
  const result = compileExecutionIr({
    ir: ir ?? governedIr(),
    constraints: constraints(),
    config: {
      passes: DEFAULT_PIPELINE_PASSES,
      maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
      qualityThreshold: 0.8,
    },
    digest: nodeDigest,
  });
  return result.output;
}

/** A permissive policy fact set (freshness bounds in epoch-ms deltas). */
export function permissivePolicy(): {
  reuseAllowed: boolean;
  prefixCacheAllowed: boolean;
  coalescingAllowed: boolean;
  maxEntryAgeMs: number;
  maxPrefixAgeMs: number;
  maxJoinAgeMs: number;
} {
  return {
    reuseAllowed: true,
    prefixCacheAllowed: true,
    coalescingAllowed: true,
    maxEntryAgeMs: 60_000,
    maxPrefixAgeMs: 60_000,
    maxJoinAgeMs: 60_000,
  };
}
