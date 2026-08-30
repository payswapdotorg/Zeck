/**
 * Subgraph-level planning evidence (planning module domain; WORK-009 /
 * DTR-001, DTR-004, ACR-002).
 *
 * Every emitted `SubgraphObservation` describes one plan subgraph (step
 * path) with the structured fields later deterministicization discovery
 * and codebase-opportunity analysis (WORK-021/WORK-022) consume:
 * computation type, expected cost/quality, verification strategy,
 * repeated-use opportunity and deterministicization potential — each with
 * its basis recorded (evidence, not vibes).
 *
 * LEARNING-NONAUTHORITY: observations are EVIDENCE ONLY. Nothing in this
 * module grants learning the right to authorize, promote or substitute at
 * runtime — future systems re-enter through the normal authority gates
 * (policy, verification, budgets). This file contains no side effects.
 */

import type { DeterministicCatalogEntry } from "../ports/deterministic-catalog";
import type { ExecutionPlan, PlanStep, PlanStepClass } from "./plan";

export const COMPUTATION_TYPES = [
  "deterministic",
  "generative",
  "hybrid",
  "retrieval",
  "tool",
  "human",
  "verification",
] as const;

export type ComputationType = (typeof COMPUTATION_TYPES)[number];

export interface OpportunityScore {
  /** 0..1 — 0 means no opportunity, 1 means maximal. */
  readonly score: number;
  /** Machine-readable basis for the score (auditable evidence). */
  readonly basis: string;
}

export interface SubgraphObservation {
  /** Stable identity: the ordered step path it covers. */
  readonly subgraphId: string;
  readonly stepPath: readonly string[];
  readonly computationType: ComputationType;
  readonly expectedCostMicroUsd: string;
  readonly expectedQuality: number;
  readonly verificationStrategy: string;
  readonly repeatedUseOpportunity: OpportunityScore;
  readonly deterministicizationPotential: OpportunityScore;
}

/** Map a step class to its computation type for evidence purposes. */
export function computationTypeOfStep(step: PlanStep): ComputationType {
  switch (step.stepClass) {
    case "retrieve":
      return "retrieval";
    case "call-tool":
      return "tool";
    case "ask-user":
    case "ask-human":
      return "human";
    case "verify":
    case "compare":
      return "verification";
    case "generate":
    case "call-model":
    case "call-agent":
      return "generative";
    default:
      return "deterministic";
  }
}

function isGenerativeClass(stepClass: PlanStepClass): boolean {
  return stepClass === "generate" || stepClass === "call-model" || stepClass === "call-agent";
}

/**
 * Emit subgraph observations for a plan: one observation per step, plus
 * one whole-plan observation whenever the plan mixes computation types
 * (the hybrid subgraph — exactly what deterministicization discovery
 * wants to see). Pure; catalog entries supply deterministic estimates.
 */
export function emitSubgraphEvidence(
  plan: ExecutionPlan,
  catalog: readonly DeterministicCatalogEntry[],
  routeCosts: Readonly<
    Record<string, { readonly costMicroUsd: string; readonly quality: number }>
  > = {},
): readonly SubgraphObservation[] {
  const catalogById = new Map(catalog.map((entry) => [entry.capabilityId, entry]));
  const observations: SubgraphObservation[] = [];

  for (const step of plan.steps) {
    const computationType = computationTypeOfStep(step);
    const catalogEntry =
      step.capabilityId === undefined ? undefined : catalogById.get(step.capabilityId);
    let expectedCostMicroUsd = "0";
    let expectedQuality = 1;
    if (catalogEntry !== undefined) {
      expectedCostMicroUsd = catalogEntry.expectedCostMicroUsd;
      expectedQuality = catalogEntry.expectedQuality;
    }
    if (step.routeRef !== undefined) {
      const routeKey = `${step.routeRef.provider}\u0000${step.routeRef.model}`;
      const route = routeCosts[routeKey];
      if (route !== undefined) {
        expectedCostMicroUsd = route.costMicroUsd;
        expectedQuality = route.quality;
      } else {
        // Route estimate unknown to the explorer snapshot: record the
        // unknown honestly (quality estimate 0 = unestimated, cost "0" is
        // an estimate marker, basis discloses it).
        expectedCostMicroUsd = "0";
        expectedQuality = 0;
      }
    }

    observations.push({
      subgraphId: `step:${step.id}`,
      stepPath: [step.id],
      computationType,
      expectedCostMicroUsd,
      expectedQuality,
      verificationStrategy:
        step.verificationStrategy ?? catalogEntry?.verificationStrategy ?? "unspecified",
      repeatedUseOpportunity: repeatedUseScore(computationType, step.id),
      deterministicizationPotential: deterministicizationScore(computationType, catalogEntry),
    });
  }

  const types = new Set(plan.steps.map((step) => computationTypeOfStep(step)));
  const hasGenerative = plan.steps.some((step) => isGenerativeClass(step.stepClass));
  if (types.size > 1 && hasGenerative) {
    // The hybrid whole-plan observation: deterministic work surrounding
    // generative reasoning — the primary deterministicization surface.
    const totalCost = observations
      .filter((observation) => observation.computationType !== "verification")
      .reduce((sum, observation) => sum + BigInt(observation.expectedCostMicroUsd), 0n);
    const minQuality = Math.min(...observations.map((observation) => observation.expectedQuality));
    observations.push({
      subgraphId: "plan:whole",
      stepPath: plan.steps.map((step) => step.id),
      computationType: "hybrid",
      expectedCostMicroUsd: totalCost.toString(10),
      expectedQuality: minQuality,
      verificationStrategy: "composite: per-step strategies carried on the plan",
      repeatedUseOpportunity: {
        score: 0.8,
        basis:
          "hybrid composition with deterministic pre/post-processing is a strong repeated-subgraph signal",
      },
      deterministicizationPotential: {
        score: 0.6,
        basis:
          "generative steps inside a deterministic envelope are primary deterministicization candidates once replay/differential evidence accumulates (DTR-002)",
      },
    });
  }

  return observations;
}

function repeatedUseScore(computationType: ComputationType, stepId: string): OpportunityScore {
  switch (computationType) {
    case "deterministic":
      return {
        score: 0.9,
        basis: `deterministic step ${stepId} has stable input/output semantics — directly reusable`,
      };
    case "retrieval":
      return {
        score: 0.7,
        basis: `retrieval step ${stepId} repeats across tasks with similar information needs`,
      };
    case "verification":
      return {
        score: 0.8,
        basis: `verification step ${stepId} is a recurring quality gate`,
      };
    case "tool":
      return {
        score: 0.6,
        basis: `tool step ${stepId} is invocable wherever the same tool capability is required`,
      };
    case "generative":
      return {
        score: 0.5,
        basis: `generative step ${stepId} recurs semantically but must be learned before reuse`,
      };
    case "hybrid":
      return {
        score: 0.8,
        basis: "hybrid subgraphs repeat across executions with shared deterministic envelopes",
      };
    case "human":
      return {
        score: 0.2,
        basis: `human step ${stepId} is rate-limited by user effort, not by reuse`,
      };
  }
}

function deterministicizationScore(
  computationType: ComputationType,
  catalogEntry: DeterministicCatalogEntry | undefined,
): OpportunityScore {
  switch (computationType) {
    case "deterministic":
    case "verification":
      return {
        score: 0.0,
        basis: "already deterministic — no deterministicization potential",
      };
    case "generative":
      return {
        score: 0.7,
        basis:
          "generative step is the deterministicization target class; promotion requires replay + differential + property evidence (DTR-002) and stays non-authoritative (DTR-004)",
      };
    case "hybrid":
      return {
        score: 0.6,
        basis: "the generative portion of the hybrid subgraph is the deterministicization surface",
      };
    case "retrieval":
      return {
        score: catalogEntry === undefined ? 0.3 : 0.2,
        basis: "retrieval quality gains may come from indexing rather than inference",
      };
    case "tool":
      return {
        score: 0.2,
        basis:
          "tool behavior is governed elsewhere (WORK-010); replacement potential is tool-level",
      };
    case "human":
      return {
        score: 0.1,
        basis: "human ratings are evaluation evidence, not execution surface",
      };
  }
}
