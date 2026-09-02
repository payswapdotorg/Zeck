/**
 * Deterministicization consultation capture (planning module domain;
 * WORK-021 / DTR-001..DTR-004, ADR-0008, `spec/architecture.md` §19;
 * the runtime-consumption half of `spec/deterministicization-contract.md`).
 *
 * THE PLANNING-SIDE READ SEAM OF DETERMINISTICIZATION LEARNING. When
 * the planner is wired with a deterministicization-signal source, it
 * consults the application's deterministicization candidates (the
 * WORK-021 lifecycle's output: validated replacement candidates in
 * their rollout/decision lifecycle states) and records the
 * consultation INSIDE the durable planning decision — as EVIDENCE:
 *
 *  - the LIVE selection is computed BEFORE the consultation and is
 *    never changed by it (the pipeline order is the protection: task →
 *    policy → capabilities → deterministic sufficiency → candidates →
 *    selection → THEN the deterministicization consultation capture —
 *    a promoted replacement is an input to FUTURE plan composition,
 *    never a live-route rewrite; DTR-003's "without changing
 *    execution identity" is preserved structurally: the consultation
 *    is a post-selection capture, and no field of it feeds the
 *    selection);
 *  - every consulted candidate carries the FULL provenance/contract
 *    anchors (candidate id + lifecycle status + class, the
 *    subgraph identity, the population, the corpus digest, the
 *    non-empty source-execution provenance, the contract digest, the
 *    incumbent binding + rollback target, the shadow/canary measured
 *    deltas, the promotion/rollback decision anchors) — an
 *    unprovenanced or unversioned candidate fails closed in
 *    `validateConsultedDeterministicizationSignal` and never enters a
 *    durable decision record;
 *  - only a PROMOTED candidate carries the deterministic direction
 *    (its replacement has passed the full validation + rollout gate);
 *    shadow/canary/validated/deferred/rolled-back candidates are
 *    recorded as DIVERGENCE EVIDENCE only — their implied preference
 *    is null (a candidate that has not passed the promotion gate can
 *    never influence even the implied preference: M-canary, the
 *    WORK-020 discipline);
 *  - `preferredStrategyId` records WHICH admissible candidate the
 *    promoted replacements imply (see
 *    `deterministicizationPreferredCandidateId` — the admissible
 *    candidate with the FEWEST generative steps, the plan most
 *    aligned with eliminating generative work) — the recorded
 *    disagreement between the implied preference and the governed
 *    selection is consultation evidence, exactly like the
 *    WORK-014/017/020/022 consultations;
 *  - the signal class is pinned to the frozen non-authoritative class
 *    (DETERMINISTICIZATION CANDIDATE ≠ AUTHORIZATION — the §10
 *    invariant; learning owns the lifecycle, planning owns the
 *    decision, the sandbox owns execution admission).
 *
 * Deterministic-first is untouched (ADR-0007/§17): the consultation
 * records what the promoted replacements imply among ADMISSIBLE
 * candidates only; a deterministic-sufficient selection is NEVER
 * replaced by a generative preference — the sufficiency decision
 * precedes the consultation and the consultation cannot revisit it.
 *
 * This file is pure domain: no side effects, no learning module
 * import (the port/adapter seam lives in ports/adapters — the
 * consumer-side mirror discipline).
 */

import { PlatformError } from "../../../shared/errors";
import type { CandidateStrategy } from "./strategy";

/** The frozen non-authority class carried by consulted candidates. */
export const CONSULTED_DETERMINISTICIZATION_CLASS =
  "non-authoritative-deterministicization-candidate" as const;

/**
 * The consulted candidate lifecycle states that can cross the seam
 * (the learning service filters to the rollout-relevant states;
 * proposed/rejected candidates carry no planning-relevant evidence —
 * the consumer-side mirror re-validates the closed vocabulary).
 */
export const CONSULTED_DETERMINISTICIZATION_STATUSES = [
  "validating",
  "validated",
  "shadow",
  "canary",
  "promoted",
  "deferred",
  "rolled-back",
] as const;

export type ConsultedDeterministicizationStatus =
  (typeof CONSULTED_DETERMINISTICIZATION_STATUSES)[number];

/** The candidate classes that can cross the seam (the contract's five). */
export const CONSULTED_DETERMINISTICIZATION_CLASSES = [
  "removal",
  "deterministic-replacement",
  "hybrid-split",
  "pipeline-replacement",
  "tool-extraction",
] as const;

export type ConsultedDeterministicizationClass =
  (typeof CONSULTED_DETERMINISTICIZATION_CLASSES)[number];

/** One rollout-phase delta projection carried on a consulted candidate. */
export interface ConsultedRolloutDelta {
  readonly population: number;
  readonly matchedCount: number;
  readonly costDeltaMicroUsd: string;
  readonly qualityDelta: number;
  readonly latencyDeltaMs: number;
}

/**
 * A deterministicization candidate as captured in a durable planning
 * decision. Consumer-side mirror of the learning module's public
 * `DeterministicizationSignal` (planning validates what it consumes —
 * the provenance/contract anchors are enforced HERE too).
 */
export interface ConsultedDeterministicizationSignal {
  readonly signalClass: typeof CONSULTED_DETERMINISTICIZATION_CLASS;
  readonly candidateId: string;
  readonly candidateClass: ConsultedDeterministicizationClass;
  readonly status: ConsultedDeterministicizationStatus;
  readonly taskClass: string;
  readonly subgraphId: string;
  readonly computationType: string;
  /** The observation population behind the candidate (>= 1). */
  readonly population: number;
  /** The evaluation-corpus digest (the candidate's revision binding). */
  readonly corpusDigest: string;
  /** NON-EMPTY source-execution provenance (the identity requirement). */
  readonly sourceExecutionIds: readonly string[];
  readonly contractDigest: string;
  readonly incumbentStrategyClass: string;
  readonly incumbentDescriptionDigest: string;
  readonly rollbackTarget: string;
  readonly shadow: ConsultedRolloutDelta | null;
  readonly canary: ConsultedRolloutDelta | null;
  readonly promotionDecisionId: string | null;
  readonly promotedBy: string | null;
  readonly promotedAt: string | null;
  readonly rollbackDecisionId: string | null;
  readonly restoredIncumbent: string | null;
}

/** The deterministicization consultation capture recorded on the decision. */
export interface DeterministicizationConsultation {
  readonly consulted: readonly ConsultedDeterministicizationSignal[];
  /** The preference the promoted candidates imply (null: none). */
  readonly preferredStrategyId: string | null;
  /** Whether the implied preference agrees with the governed selection. */
  readonly agreesWithSelection: boolean;
  readonly consultedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted deterministicization candidate ${key} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Fail-closed validation of a consulted deterministicization candidate
 * (the consumer-side provenance boundary): the signal class, the
 * closed class/status vocabularies, the non-empty source-execution
 * provenance, the corpus/contract/incumbent digest anchors and the
 * honest rollout anchors must all be present. An unprovenanced
 * candidate is rejected — it never enters a decision record.
 */
export function validateConsultedDeterministicizationSignal(
  value: unknown,
): asserts value is ConsultedDeterministicizationSignal {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted deterministicization candidate must be an object",
    });
  }
  const signal = value;
  if (signal.signalClass !== CONSULTED_DETERMINISTICIZATION_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted deterministicization candidate must carry the frozen non-authority class (a candidate is never an authorization)",
      details: { expected: CONSULTED_DETERMINISTICIZATION_CLASS },
    });
  }
  for (const key of [
    "candidateId",
    "taskClass",
    "subgraphId",
    "computationType",
    "corpusDigest",
    "contractDigest",
    "incumbentStrategyClass",
    "incumbentDescriptionDigest",
    "rollbackTarget",
  ] as const) {
    requireString(signal, key);
  }
  if (
    typeof signal.candidateClass !== "string" ||
    !(CONSULTED_DETERMINISTICIZATION_CLASSES as readonly string[]).includes(signal.candidateClass)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted deterministicization candidate class must be the closed five-class vocabulary",
    });
  }
  if (
    typeof signal.status !== "string" ||
    !(CONSULTED_DETERMINISTICIZATION_STATUSES as readonly string[]).includes(signal.status)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted deterministicization candidate status must be the rollout-relevant lifecycle vocabulary",
    });
  }
  if (
    typeof signal.population !== "number" ||
    !Number.isInteger(signal.population) ||
    signal.population < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted deterministicization candidate population must be a positive integer (provenance is never omitted)",
      details: { field: "population" },
    });
  }
  // THE provenance-presence enforcement at the consumer seam: without
  // source-execution provenance a candidate is never consulted.
  const executions = signal.sourceExecutionIds;
  if (
    !Array.isArray(executions) ||
    executions.length === 0 ||
    executions.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted deterministicization candidate sourceExecutionIds must be non-empty (provenance to source executions is identity)",
      details: { field: "sourceExecutionIds" },
    });
  }
  const anchorKeys = ["promotionDecisionId", "promotedBy", "promotedAt"] as const;
  for (const key of anchorKeys) {
    const value = signal[key];
    if (value !== null && (typeof value !== "string" || value.length === 0)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} must be a non-empty string or null`,
        details: { field: key },
      });
    }
  }
  for (const key of ["rollbackDecisionId", "restoredIncumbent"] as const) {
    const value = signal[key];
    if (value !== null && (typeof value !== "string" || value.length === 0)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} must be a non-empty string or null`,
        details: { field: key },
      });
    }
  }
  for (const key of ["shadow", "canary"] as const) {
    const delta = signal[key];
    if (delta === null || delta === undefined) {
      continue;
    }
    if (!isRecord(delta)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} delta must be an object or null`,
        details: { field: key },
      });
    }
    if (
      typeof delta.population !== "number" ||
      !Number.isInteger(delta.population) ||
      delta.population < 0
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} population must be a non-negative integer`,
        details: { field: key },
      });
    }
    if (
      typeof delta.matchedCount !== "number" ||
      !Number.isInteger(delta.matchedCount) ||
      delta.matchedCount < 0 ||
      delta.matchedCount > delta.population
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} matchedCount must be in [0, population]`,
        details: { field: key },
      });
    }
    if (
      typeof delta.costDeltaMicroUsd !== "string" ||
      !/^[0-9]{1,19}$/.test(delta.costDeltaMicroUsd)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} costDeltaMicroUsd must be an integer micro-USD string`,
        details: { field: key },
      });
    }
    if (
      typeof delta.qualityDelta !== "number" ||
      delta.qualityDelta < 0 ||
      delta.qualityDelta > 1
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} qualityDelta must be in [0,1]`,
        details: { field: key },
      });
    }
    if (typeof delta.latencyDeltaMs !== "number" || !Number.isInteger(delta.latencyDeltaMs)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `consulted deterministicization candidate ${key} latencyDeltaMs must be an integer`,
        details: { field: key },
      });
    }
  }
}

/** Validate a full consultation capture (round-trip). */
export function validateDeterministicizationConsultation(
  value: unknown,
): asserts value is DeterministicizationConsultation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization consultation must be an object",
    });
  }
  const consultation = value;
  const consulted = consultation.consulted;
  if (!Array.isArray(consulted)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization consultation consulted must be an array (may be empty)",
    });
  }
  for (const signal of consulted) {
    validateConsultedDeterministicizationSignal(signal);
  }
  if (
    consultation.preferredStrategyId !== null &&
    (typeof consultation.preferredStrategyId !== "string" ||
      consultation.preferredStrategyId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "deterministicization consultation preferredStrategyId must be a non-empty string or null",
    });
  }
  if (typeof consultation.agreesWithSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deterministicization consultation agreesWithSelection must be a boolean",
    });
  }
  requireString(consultation, "consultedAt");
}

function countGenerativeSteps(candidate: CandidateStrategy): number {
  return candidate.plan.steps.filter((step) =>
    ["generate", "call-model", "call-agent"].includes(step.stepClass),
  ).length;
}

/**
 * The preference the consulted candidates imply among ADMISSIBLE
 * candidates (pure, recorded as evidence — never applied to the live
 * selection):
 *
 *  - only a PROMOTED candidate carries the deterministic direction
 *    (its replacement passed the full gate; shadow/canary/deferred/
 *    rolled-back candidates are divergence evidence — their
 *    preference is null, M-canary);
 *  - with any promoted candidate consulted, the implied preference is
 *    the admissible candidate with the FEWEST generative steps (the
 *    plan most aligned with eliminating generative work);
 *  - ties break on the candidate's position in the input order
 *    (deterministic);
 *  - with no promoted candidate (or no admissible candidate), the
 *    implied preference is null.
 *
 * Inadmissible candidates NEVER qualify (M17: a consulted candidate
 * cannot authorize a forbidden route — the preference is recorded
 * evidence only).
 */
export function deterministicizationPreferredCandidateId(
  candidates: readonly CandidateStrategy[],
  signals: readonly ConsultedDeterministicizationSignal[],
): string | null {
  const anyPromoted = signals.some((signal) => signal.status === "promoted");
  if (!anyPromoted) {
    return null;
  }
  const admissible = candidates.filter((candidate) => candidate.admissible);
  if (admissible.length === 0) {
    return null;
  }
  let preferred: CandidateStrategy | null = null;
  for (const candidate of admissible) {
    if (preferred === null) {
      preferred = candidate;
      continue;
    }
    if (countGenerativeSteps(candidate) < countGenerativeSteps(preferred)) {
      preferred = candidate;
    }
  }
  return preferred === null ? null : preferred.strategyId;
}

/** Build the consultation capture (validating every candidate again). */
export function buildDeterministicizationConsultation(input: {
  readonly candidates: readonly CandidateStrategy[];
  readonly signals: readonly ConsultedDeterministicizationSignal[];
  readonly selectedStrategyId: string;
  readonly consultedAt: string;
}): DeterministicizationConsultation {
  for (const signal of input.signals) {
    validateConsultedDeterministicizationSignal(signal);
  }
  const preferredStrategyId = deterministicizationPreferredCandidateId(
    input.candidates,
    input.signals,
  );
  return {
    consulted: input.signals.map((signal) => ({ ...signal })),
    preferredStrategyId,
    agreesWithSelection: preferredStrategyId === input.selectedStrategyId,
    consultedAt: input.consultedAt,
  };
}
