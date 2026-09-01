/**
 * Codebase-opportunity consultation capture (planning module domain;
 * WORK-022 / DTR-005, ADR-0008, ADR-0010, `spec/architecture.md` §19).
 *
 * THE PLANNING-SIDE READ SEAM OF CODEBASE-OPPORTUNITY LEARNING. When the
 * planner is wired with an opportunity-signal source, it consults the
 * application's advisory opportunity findings (the WORK-022 analyzer's
 * output: deterministic-replacement candidates, ai-addition signals,
 * hybrid-decomposition evidence …) and records the consultation INSIDE
 * the durable planning decision — as EVIDENCE:
 *
 *  - the LIVE selection is computed BEFORE the consultation and is
 *    never changed by it (the pipeline order is the protection: task →
 *    policy → capabilities → deterministic sufficiency → candidates →
 *    selection → THEN the opportunity consultation capture — M17: a
 *    codebase finding can never change live routing, never authorize a
 *    forbidden candidate and never bypass the deterministic-first
 *    preference — the finding is advisory evidence, never command);
 *  - every consulted finding carries the FULL version/provenance
 *    anchors (analysis id + version, repository + revision, target
 *    node ids, evidence refs, confidence level + population, the
 *    deterministic-equivalence potential) — an unversioned or
 *    unprovenanced finding fails closed in
 *    `validateConsultedOpportunitySignal` and never enters a durable
 *    decision record (M11/M12/M13/M27/M28);
 *  - `preferredStrategyId` records WHICH admissible candidate the
 *    consulted findings would imply (see
 *    `opportunityPreferredCandidateId`) — the recorded disagreement
 *    between the implied preference and the governed selection is
 *    consultation evidence, exactly like the WORK-014/WORK-017
 *    consultations;
 *  - the signal class is pinned to the frozen non-authoritative class
 *    (OPPORTUNITY FINDING ≠ AUTHORIZATION — the §17 invariant).
 *
 * Deterministic-first is untouched (ADR-0007/§17): the consultation
 * records what the findings imply among ADMISSIBLE candidates only; a
 * deterministic-sufficient selection is NEVER replaced by a generative
 * preference (M17) — the sufficiency decision precedes the consultation
 * and the consultation cannot revisit it.
 *
 * This file is pure domain: no side effects, no learning module import
 * (the port/adapter seam lives in ports/adapters — the consumer-side
 * mirror discipline).
 */

import { PlatformError } from "../../../shared/errors";
import type { CandidateStrategy } from "./strategy";

/** The frozen non-authority class carried by consulted opportunity findings. */
export const CONSULTED_OPPORTUNITY_CLASS = "non-authoritative-opportunity-finding" as const;

/**
 * An opportunity finding as captured in a durable planning decision.
 * Consumer-side mirror of the learning module's public
 * `OpportunitySignal` (planning validates what it consumes — the
 * version/provenance anchors are enforced HERE too).
 */
export interface ConsultedOpportunitySignal {
  readonly signalClass: typeof CONSULTED_OPPORTUNITY_CLASS;
  readonly findingId: string;
  readonly analysisId: string;
  /** The analyzer ruleset identity (M13 versioning basis). */
  readonly analysisVersion: number;
  readonly class: string;
  /** The finding's advisory lifecycle state (advisory | candidate | verified). */
  readonly state: string;
  readonly confidenceLevel: string;
  readonly population: number;
  /** Full source provenance (M11/M12/M28). */
  readonly repository: string;
  readonly revision: string;
  readonly targetNodeIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  /** The honest impact bases (measured | estimated | unknown). */
  readonly costImpactBasis: string;
  readonly latencyImpactBasis: string;
  readonly deterministicEquivalencePotential: string;
}

/** The opportunity consultation capture recorded on the planning decision. */
export interface OpportunityConsultation {
  readonly consulted: readonly ConsultedOpportunitySignal[];
  /** The preference the consulted findings imply (null: none). */
  readonly preferredStrategyId: string | null;
  /** Whether the implied preference agrees with the governed selection. */
  readonly agreesWithSelection: boolean;
  readonly consultedAt: string;
}

/**
 * The finding classes that imply LESS generative work in a plan
 * (learning says: "this generative subgraph is a replacement /
 * removal candidate" — the composition-direction signal).
 */
const DETERMINISTIC_DIRECTION_CLASSES: readonly string[] = [
  "deterministic-replacement",
  "ai-removal",
  "tool-replacement",
];

/**
 * The finding classes that imply MORE generative work in a plan
 * (learning says: "this deterministic subgraph is failing at semantic
 * work — add AI" — ADR-0008's `deterministic -> AI` direction).
 */
const GENERATIVE_DIRECTION_CLASSES: readonly string[] = ["ai-addition"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted opportunity finding ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

function requireNonEmptyStringList(
  container: Record<string, unknown>,
  key: string,
): readonly string[] {
  const list = container[key];
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `consulted opportunity finding ${key} must be non-empty (M11/M27 provenance)`,
      details: { field: key },
    });
  }
  return [...list];
}

/**
 * Fail-closed validation of a consulted opportunity finding (the
 * consumer-side M11/M12/M13/M27/M28 boundary): the signal class, the
 * full version/provenance basis and the honest impact bases must be
 * present. An unversioned or unprovenanced finding is rejected — it
 * never enters a decision record.
 */
export function validateConsultedOpportunitySignal(
  value: unknown,
): asserts value is ConsultedOpportunitySignal {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted opportunity finding must be an object",
    });
  }
  const signal = value;
  if (signal.signalClass !== CONSULTED_OPPORTUNITY_CLASS) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted opportunity finding must carry the frozen non-authority class (a finding is never an authorization)",
      details: { expected: CONSULTED_OPPORTUNITY_CLASS },
    });
  }
  for (const key of [
    "findingId",
    "analysisId",
    "class",
    "state",
    "confidenceLevel",
    "repository",
    "revision",
    "costImpactBasis",
    "latencyImpactBasis",
    "deterministicEquivalencePotential",
  ] as const) {
    requireString(signal, key, key);
  }
  if (
    typeof signal.analysisVersion !== "number" ||
    !Number.isInteger(signal.analysisVersion) ||
    signal.analysisVersion < 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "consulted opportunity finding analysisVersion must be a positive integer (M13 versioning basis)",
      details: { field: "analysisVersion" },
    });
  }
  if (
    typeof signal.population !== "number" ||
    !Number.isInteger(signal.population) ||
    signal.population < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "consulted opportunity finding population must be a non-negative integer",
      details: { field: "population" },
    });
  }
  for (const key of ["targetNodeIds", "reasonCodes", "evidenceRefs"] as const) {
    requireNonEmptyStringList(signal, key);
  }
}

/** Validate a full opportunity consultation capture (round-trip). */
export function validateOpportunityConsultation(
  value: unknown,
): asserts value is OpportunityConsultation {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "opportunity consultation must be an object",
    });
  }
  const consultation = value;
  const consulted = consultation.consulted;
  if (!Array.isArray(consulted)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "opportunity consultation consulted must be an array (may be empty)",
    });
  }
  for (const signal of consulted) {
    validateConsultedOpportunitySignal(signal);
  }
  if (
    consultation.preferredStrategyId !== null &&
    (typeof consultation.preferredStrategyId !== "string" ||
      consultation.preferredStrategyId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "opportunity consultation preferredStrategyId must be a non-empty string or null",
    });
  }
  if (typeof consultation.agreesWithSelection !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "opportunity consultation agreesWithSelection must be a boolean",
    });
  }
  requireString(consultation, "consultedAt", "consultedAt");
}

function countGenerativeSteps(candidate: CandidateStrategy): number {
  return candidate.plan.steps.filter((step) =>
    ["generate", "call-model", "call-agent"].includes(step.stepClass),
  ).length;
}

/**
 * The preference the consulted findings imply among ADMISSIBLE
 * candidates (pure, recorded as evidence — never applied to the live
 * selection):
 *
 *  - when any consulted finding carries a DETERMINISTIC direction
 *    (deterministic-replacement / ai-removal / tool-replacement), the
 *    implied preference is the admissible candidate with the FEWEST
 *    generative steps (the plan most aligned with removing generative
 *    work);
 *  - when any consulted finding carries a GENERATIVE direction
 *    (ai-addition) and none carries a deterministic direction, the
 *    implied preference is the admissible candidate with the MOST
 *    generative steps;
 *  - ties break on the candidate's position in the input order
 *    (deterministic);
 *  - with no direction-bearing finding (or no admissible candidate),
 *    the implied preference is null.
 *
 * Inadmissible candidates NEVER qualify (M17: a consulted finding
 * cannot authorize a forbidden route — the preference is recorded
 * evidence only).
 */
export function opportunityPreferredCandidateId(
  candidates: readonly CandidateStrategy[],
  findings: readonly ConsultedOpportunitySignal[],
): string | null {
  const deterministicDirection = findings.some((finding) =>
    DETERMINISTIC_DIRECTION_CLASSES.includes(finding.class),
  );
  const generativeDirection = findings.some((finding) =>
    GENERATIVE_DIRECTION_CLASSES.includes(finding.class),
  );
  if (!deterministicDirection && !generativeDirection) {
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
    const candidateGenerative = countGenerativeSteps(candidate);
    const preferredGenerative = countGenerativeSteps(preferred);
    const better = deterministicDirection
      ? candidateGenerative < preferredGenerative
      : candidateGenerative > preferredGenerative;
    if (better) {
      preferred = candidate;
    }
  }
  return preferred === null ? null : preferred.strategyId;
}

/** Build the consultation capture (validating every finding again). */
export function buildOpportunityConsultation(input: {
  readonly candidates: readonly CandidateStrategy[];
  readonly findings: readonly ConsultedOpportunitySignal[];
  readonly selectedStrategyId: string;
  readonly consultedAt: string;
}): OpportunityConsultation {
  for (const signal of input.findings) {
    validateConsultedOpportunitySignal(signal);
  }
  const preferredStrategyId = opportunityPreferredCandidateId(input.candidates, input.findings);
  return {
    consulted: input.findings.map((signal) => ({ ...signal })),
    preferredStrategyId,
    agreesWithSelection: preferredStrategyId === input.selectedStrategyId,
    consultedAt: input.consultedAt,
  };
}
