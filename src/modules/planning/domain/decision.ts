/**
 * The durable planning decision record (planning module domain; WORK-009).
 *
 * A `PlanningDecisionRecord` is the COMPLETE, auditable planning decision:
 * the structured task profile, the policy inputs that constrained it, the
 * capability resolution, the explicit deterministic-sufficiency decision,
 * EVERY candidate strategy considered (with admissibility verdicts and
 * typed inadmissibility reasons), the selected plan, the selection
 * rationale and the subgraph-level evidence for later deterministicization
 * learning (DTR-001/DTR-004).
 *
 * The record is validated by `validatePlanningDecision` — the planning
 * authority's closed-shape check — BEFORE it is handed to the executions
 * ledger for durable append (the executions module owns the single write
 * path; this module owns decision semantics). The record carries a
 * content digest so downstream consumers can verify integrity.
 */

import { PlatformError } from "../../../shared/errors";
import type { RestrictionSet } from "../../policies/public";
import { canonicalJson } from "./canonical";
import type { LearningConsultation } from "./learning-consultation";
import { validateLearningConsultation } from "./learning-consultation";
import type { ExecutionPlan } from "./plan";
import type { CandidateStrategy, RouteRationale } from "./strategy";
import type { SubgraphObservation } from "./subgraph-evidence";
import type { DeterministicSufficiencyDecision } from "./sufficiency";
import type { TaskProfile } from "./task-profile";

/** Frozen planner identity (evidence schema version). */
export const PLANNER_VERSION = "zeck-planner-1";

/** The policy inputs captured on a durable planning decision (AC-8). */
export interface PolicyInputsCapture {
  readonly outcome: "allow" | "deny";
  /** Effective restriction set at planning time (when allowed). */
  readonly effective?: RestrictionSet;
  /** Policy-set identity provenance (id/version/contentHash). */
  readonly policySetId?: string;
  readonly policySetVersion?: number;
  readonly policyContentHash?: string;
  /** sha256 over the canonical effective restriction set. */
  readonly restrictionSetDigest?: string;
  /** Applied scopes in precedence order (folded contributions). */
  readonly appliedScopes?: readonly string[];
}

/** The capability resolution captured on a durable planning decision. */
export interface CapabilityResolutionCapture {
  readonly satisfied: boolean;
  readonly catalogRevision: string;
  readonly satisfiedIds: readonly string[];
  readonly unmetIds: readonly string[];
}

export interface PlanningDecisionRecord {
  readonly decisionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly plannerVersion: string;
  readonly taskProfile: TaskProfile;
  readonly policyInputs: PolicyInputsCapture;
  readonly capabilityResolution: CapabilityResolutionCapture;
  readonly deterministicSufficiency: DeterministicSufficiencyDecision;
  readonly candidates: readonly CandidateStrategy[];
  readonly selectedStrategyId: string;
  readonly selectionRationale: string;
  readonly subgraphEvidence: readonly SubgraphObservation[];
  /**
   * OPTIONAL learning consultation capture (WORK-014 / INT-006): the
   * versioned learning signals consulted AFTER the governed selection,
   * recorded as evidence. Absent when no learning seam is wired. The
   * consultation never alters `selectedStrategyId` — it records what
   * learning would have preferred (M1/M8/M13).
   */
  readonly learningConsultation?: LearningConsultation;
  /** Prior decision this one replaces (verification-triggered replanning). */
  readonly replanOf?: string;
  readonly recordedAt: string;
  /** sha256 over the canonical record form (integrity for consumers). */
  readonly recordDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `planning decision ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Closed-shape validation of a planning decision record. Fails closed
 * with typed `PROVIDER_ERROR`; every mandatory field of the planning
 * evidence contract must be present (AC-8: the decision is auditable).
 */
export function validatePlanningDecision(value: unknown): asserts value is PlanningDecisionRecord {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must be an object",
    });
  }
  const record = value;

  requireString(record, "decisionId", "decisionId");
  requireString(record, "executionId", "executionId");
  requireString(record, "applicationId", "applicationId");
  requireString(record, "tenantId", "tenantId");
  const plannerVersion = requireString(record, "plannerVersion", "plannerVersion");
  if (plannerVersion !== PLANNER_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision plannerVersion does not match the frozen planner identity",
      details: { got: plannerVersion, expected: PLANNER_VERSION },
    });
  }
  if (!isRecord(record.taskProfile) || typeof record.taskProfile.profileDigest !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must carry a structured taskProfile",
    });
  }
  if (!isRecord(record.policyInputs) || typeof record.policyInputs.outcome !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must capture policy inputs",
    });
  }
  if (
    !isRecord(record.capabilityResolution) ||
    typeof record.capabilityResolution.satisfied !== "boolean" ||
    typeof record.capabilityResolution.catalogRevision !== "string"
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must capture the capability resolution",
    });
  }
  if (
    !isRecord(record.deterministicSufficiency) ||
    typeof record.deterministicSufficiency.outcome !== "string" ||
    !Array.isArray(record.deterministicSufficiency.reasons)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must carry the deterministic-sufficiency decision",
    });
  }
  if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must record at least one candidate strategy",
    });
  }
  for (const candidate of record.candidates) {
    if (!isRecord(candidate) || typeof candidate.strategyId !== "string") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "each recorded candidate must carry a strategyId",
      });
    }
  }
  const selectedStrategyId = requireString(record, "selectedStrategyId", "selectedStrategyId");
  if (
    !(record.candidates as unknown as { strategyId: string }[]).some(
      (candidate) => candidate.strategyId === selectedStrategyId,
    )
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "selectedStrategyId must reference one of the recorded candidates",
    });
  }
  requireString(record, "selectionRationale", "selectionRationale");
  if (!Array.isArray(record.subgraphEvidence) || record.subgraphEvidence.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision must emit subgraph-level evidence (DTR-001/DTR-004)",
    });
  }
  if (record.replanOf !== undefined && typeof record.replanOf !== "string") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "planning decision replanOf must be a string when present",
    });
  }
  if (record.learningConsultation !== undefined) {
    // WORK-014: the consultation capture is part of the closed shape —
    // validated (M13 version anchors) whenever present.
    validateLearningConsultation(record.learningConsultation);
  }
  requireString(record, "recordedAt", "recordedAt");
  requireString(record, "recordDigest", "recordDigest");
}

/** Canonical record form (the digest-covered bytes). */
export function canonicalDecisionForm(
  record: Omit<PlanningDecisionRecord, "recordDigest">,
): string {
  return canonicalJson(record);
}

/** Compute the record digest (server-derived identity). */
export function decisionRecordDigest(
  record: Omit<PlanningDecisionRecord, "recordDigest">,
  digest: (value: unknown) => string,
): string {
  return digest(record);
}

/** Select a candidate by strategyId (typed failure when absent). */
export function candidateById(
  candidates: readonly CandidateStrategy[],
  strategyId: string,
): CandidateStrategy {
  const found = candidates.find((candidate) => candidate.strategyId === strategyId);
  if (found === undefined) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "candidate not found for strategyId",
      details: { strategyId },
    });
  }
  return found;
}

export type { ExecutionPlan, RouteRationale };
