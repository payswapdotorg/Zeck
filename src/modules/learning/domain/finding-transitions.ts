/**
 * Finding-state transitions: advisory -> candidate -> verified
 * (learning module domain; WORK-022 / HUM-003, DTR-004; ADR-0008).
 *
 * THE NO-AUTO-PROMOTION MODEL (§18): the distinct states are
 *  - `advisory`  — the analyzer's output (evidence-backed, confidence-
 *                  qualified, NEVER applied to anything);
 *  - `candidate` — the finding has attached evaluation evidence (a
 *                  human/developer rating) — still not verified;
 *  - `verified`  — deterministic EQUIVALENCE has been demonstrated by
 *                  differential-equivalence evidence (M15: candidate
 *                  replacement != verified equivalent replacement);
 *  - `promoted`  — NOT a state of this module AT ALL. Promotion into
 *                  production is owned by the normal validation/
 *                  promotion gate OUTSIDE learning (the §18 rule). A
 *                  learning-side 'promoted' transition is
 *                  unrepresentable by construction (no code path, no
 *                  vocabulary, no physical column value).
 *
 * TRANSITIONS ARE SINGLE-STEP FORWARD ONLY:
 *   advisory -> candidate  requires RATING evidence (a human rating is
 *                          evaluation evidence — M9: it grants nothing
 *                          beyond candidacy);
 *   candidate -> verified  requires VERIFIED-EQUIVALENCE evidence: a
 *                          differential comparison with PASS status,
 *                          bound to the SAME source revision, over
 *                          comparable populations (M15/M16: a
 *                          candidate never silently becomes verified;
 *                          a rating alone can NEVER produce verified);
 *   verified -> (anything) — terminal in this module (M8: nothing here
 *                          promotes it further).
 *
 * A low-confidence finding can NEVER reach 'verified': the
 * verified-equivalence transition additionally requires the finding's
 * confidence to be at least 'medium' (M8: tiny/sparse evidence cannot
 * certify equivalence) — the equivalence evidence itself must carry
 * the observed populations.
 *
 * This file is pure domain: no side effects, no imports outside
 * `shared`.
 */

import { PlatformError } from "../../../shared/errors";
import type { OpportunityFinding } from "./opportunity-analysis";
import { isFindingState } from "./opportunity-analysis";

/** Frozen finding-transition schema version. */
export const FINDING_TRANSITION_SCHEMA_VERSION = 1;

/** The closed transition-evidence vocabulary. */
export const FINDING_TRANSITION_EVIDENCE_KINDS = ["rating", "verified-equivalence"] as const;

export type FindingTransitionEvidenceKind = (typeof FINDING_TRANSITION_EVIDENCE_KINDS)[number];

export function isFindingTransitionEvidenceKind(
  value: string,
): value is FindingTransitionEvidenceKind {
  return (FINDING_TRANSITION_EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** The legal single-step forward transitions (the frozen table). */
export const FINDING_TRANSITION_TABLE: readonly {
  readonly from: OpportunityFinding["state"];
  readonly to: OpportunityFinding["state"];
  readonly evidenceKind: FindingTransitionEvidenceKind;
}[] = [
  { from: "advisory", to: "candidate", evidenceKind: "rating" },
  { from: "candidate", to: "verified", evidenceKind: "verified-equivalence" },
];

/**
 * The verified-equivalence evidence (§9/M15/M16 — the ONLY evidence
 * that can carry a candidate to verified):
 *  - a differential comparison of baseline vs candidate;
 *  - comparisonStatus PASS (INCONCLUSIVE/FAIL never verify);
 *  - the comparison ran against the SAME source revision as the
 *    finding's provenance (M28: stale revisions never verify);
 *  - the compared populations are comparable (M14: incomparable
 *    evidence populations are never combined — comparability is an
 *    explicit, recorded claim);
 *  - the observed population sizes (recorded, honest).
 */
export interface VerifiedEquivalenceEvidence {
  readonly comparisonId: string;
  /** The revision the differential comparison ran against. */
  readonly comparedRevision: string;
  /** Baseline (current strategy) observations in the comparison. */
  readonly baselineObservations: number;
  /** Candidate (deterministic strategy) observations in the comparison. */
  readonly candidateObservations: number;
  readonly comparisonStatus: "PASS" | "FAIL" | "INCONCLUSIVE";
  /** Explicit recorded comparability claim (population/schema parity). */
  readonly populationsComparable: boolean;
  /** Evidence references of the comparison records (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
}

/** One recorded finding transition (immutable journal row). */
export interface FindingTransitionRecord {
  readonly transitionId: string;
  readonly findingId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly fromState: OpportunityFinding["state"];
  readonly toState: OpportunityFinding["state"];
  readonly evidenceKind: FindingTransitionEvidenceKind;
  /** Evidence references backing the transition (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
  /** Required when (and only when) toState is 'verified'. */
  readonly verifiedEquivalence: VerifiedEquivalenceEvidence | null;
  readonly requestedBy: string;
  readonly recordedAt: string;
  readonly schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `transition ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/** Fail-closed validation of verified-equivalence evidence (M15). */
export function validateVerifiedEquivalenceEvidence(
  value: unknown,
): asserts value is VerifiedEquivalenceEvidence {
  if (!isRecord(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "verified-equivalence evidence must be an object (M15: equivalence is never claimed without evidence)",
    });
  }
  const evidence = value;
  requireString(evidence, "comparisonId", "comparisonId");
  requireString(
    evidence,
    "comparedRevision",
    "comparedRevision (the revision the comparison ran against)",
  );
  for (const key of ["baselineObservations", "candidateObservations"] as const) {
    const count = evidence[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `verified-equivalence ${key} must be a positive integer (observed comparison populations)`,
        details: { field: key },
      });
    }
  }
  if (
    typeof evidence.comparisonStatus !== "string" ||
    !["PASS", "FAIL", "INCONCLUSIVE"].includes(evidence.comparisonStatus)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "verified-equivalence comparisonStatus must be PASS | FAIL | INCONCLUSIVE",
    });
  }
  if (typeof evidence.populationsComparable !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "verified-equivalence populationsComparable must be an explicit boolean claim (M14)",
    });
  }
  const refs = evidence.evidenceRefs;
  if (
    !Array.isArray(refs) ||
    refs.length === 0 ||
    refs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "verified-equivalence evidenceRefs must be non-empty (M11)",
      details: { field: "evidenceRefs" },
    });
  }
}

/**
 * Validate one requested transition against the CURRENT finding and
 * the frozen table (the domain legality oracle — the store/SQL
 * triggers are the physical twin).
 *
 * Fails closed with typed `PROVIDER_ERROR` carrying the mutant id in
 * `details.mutant` for the discrimination suite:
 *   M8  — a low/inconclusive-confidence finding cannot verify;
 *   M9  — rating evidence can only produce 'candidate';
 *   M15 — verified without equivalence evidence is rejected;
 *   M16 — skipping states (advisory->verified) is rejected;
 *   M28 — a comparison against a different revision never verifies;
 *   M14 — incomparable populations never verify.
 */
export function validateFindingTransition(input: {
  readonly finding: OpportunityFinding;
  readonly toState: string;
  readonly evidenceKind: string;
  readonly evidenceRefs: readonly string[];
  readonly verifiedEquivalence: unknown;
  readonly requestedBy: string;
}): FindingTransitionRecord {
  const { finding } = input;
  if (typeof input.toState !== "string" || !isFindingState(input.toState)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "transition toState must be the closed state vocabulary (advisory | candidate | verified — never 'promoted')",
      details: { mutant: "M18" },
    });
  }
  if (
    typeof input.evidenceKind !== "string" ||
    !isFindingTransitionEvidenceKind(input.evidenceKind)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition evidenceKind must be 'rating' | 'verified-equivalence'",
    });
  }
  if (typeof input.requestedBy !== "string" || input.requestedBy.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition requestedBy must be a non-empty actor identity",
    });
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length === 0 ||
    input.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "transition evidenceRefs must be non-empty (M11: a transition without evidence is unrepresentable)",
      details: { mutant: "M15" },
    });
  }
  const toState = input.toState as OpportunityFinding["state"];

  // The single-step forward table (M16: state skipping rejected).
  const edge = FINDING_TRANSITION_TABLE.find(
    (candidate) => candidate.from === finding.state && candidate.to === toState,
  );
  if (edge === undefined) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "illegal finding transition (single-step forward only: advisory->candidate->verified; 'promoted' is not a learning state — the promotion gate is outside this module)",
      details: { from: finding.state, to: toState, mutant: toState === "verified" ? "M16" : "M18" },
    });
  }
  if (edge.evidenceKind !== input.evidenceKind) {
    // M9: a rating can only ever produce 'candidate'.
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `transition ${finding.state}->${toState} requires ${edge.evidenceKind} evidence (a rating is evaluation evidence — it grants nothing beyond candidacy)`,
      details: { expected: edge.evidenceKind, mutant: "M9" },
    });
  }

  let verifiedEquivalence: VerifiedEquivalenceEvidence | null = null;
  if (toState === "verified") {
    // M15: verified requires the differential-equivalence evidence.
    if (!isRecord(input.verifiedEquivalence)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "verified-equivalence evidence is REQUIRED for candidate->verified (a candidate replacement is NOT a verified equivalent replacement — M15)",
        details: { mutant: "M15" },
      });
    }
    validateVerifiedEquivalenceEvidence(input.verifiedEquivalence);
    verifiedEquivalence = input.verifiedEquivalence as VerifiedEquivalenceEvidence;
    // M28: the comparison must be bound to the finding's source revision.
    if (verifiedEquivalence.comparedRevision !== finding.provenance.revision) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "verified-equivalence comparison revision does not match the finding's source revision (M28: stale revisions never verify)",
        details: {
          expected: finding.provenance.revision,
          got: verifiedEquivalence.comparedRevision,
          mutant: "M28",
        },
      });
    }
    // M14: incomparable populations never verify.
    if (!verifiedEquivalence.populationsComparable) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "verified-equivalence requires comparable populations (M14: incomparable evidence populations are never combined)",
        details: { mutant: "M14" },
      });
    }
    if (verifiedEquivalence.comparisonStatus !== "PASS") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `verified-equivalence comparison status ${verifiedEquivalence.comparisonStatus} cannot verify (only PASS verifies)`,
        details: { mutant: "M15" },
      });
    }
    // M8: sparse-confidence findings cannot certify equivalence.
    if (finding.confidence.level === "low" || finding.confidence.level === "inconclusive") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "a low-confidence finding cannot be verified (M8: tiny or sparse evidence never certifies equivalence — re-analyze with a larger population first)",
        details: { level: finding.confidence.level, mutant: "M8" },
      });
    }
    if (
      verifiedEquivalence.baselineObservations < finding.confidence.population ||
      verifiedEquivalence.candidateObservations < finding.confidence.population
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "verified-equivalence comparison populations are smaller than the finding's evidence population (the comparison must cover at least the observed population)",
        details: {
          population: finding.confidence.population,
          baseline: verifiedEquivalence.baselineObservations,
          candidate: verifiedEquivalence.candidateObservations,
        },
      });
    }
  } else if (input.verifiedEquivalence !== null && input.verifiedEquivalence !== undefined) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "equivalence evidence is only legal on the candidate->verified transition",
    });
  }

  return {
    transitionId: "",
    findingId: finding.findingId,
    applicationId: finding.applicationId,
    tenantId: finding.tenantId,
    fromState: finding.state,
    toState,
    evidenceKind: input.evidenceKind,
    evidenceRefs: [...input.evidenceRefs],
    verifiedEquivalence,
    requestedBy: input.requestedBy,
    recordedAt: "",
    schemaVersion: FINDING_TRANSITION_SCHEMA_VERSION,
  };
}

/** Fail-closed closed-shape validation of a transition journal row (round-trip). */
export function validateFindingTransitionRecord(
  value: unknown,
): asserts value is FindingTransitionRecord {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "transition must be an object" });
  }
  const transition = value;
  for (const key of [
    "transitionId",
    "findingId",
    "applicationId",
    "tenantId",
    "requestedBy",
    "recordedAt",
  ] as const) {
    requireString(transition, key, key);
  }
  if (
    typeof transition.fromState !== "string" ||
    !isFindingState(transition.fromState) ||
    typeof transition.toState !== "string" ||
    !isFindingState(transition.toState)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition states must be the closed vocabulary",
    });
  }
  if (
    typeof transition.evidenceKind !== "string" ||
    !isFindingTransitionEvidenceKind(transition.evidenceKind)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition evidenceKind must be the closed vocabulary",
    });
  }
  const legal = FINDING_TRANSITION_TABLE.some(
    (edge) =>
      edge.from === transition.fromState &&
      edge.to === transition.toState &&
      edge.evidenceKind === transition.evidenceKind,
  );
  if (!legal) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition is not a legal single-step forward edge of the frozen table",
      details: { from: transition.fromState, to: transition.toState },
    });
  }
  if (
    !Array.isArray(transition.evidenceRefs) ||
    transition.evidenceRefs.length === 0 ||
    transition.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition evidenceRefs must be non-empty (M11)",
    });
  }
  if (transition.toState === "verified") {
    if (!isRecord(transition.verifiedEquivalence)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "verified transitions must carry the verified-equivalence evidence (M15)",
      });
    }
    validateVerifiedEquivalenceEvidence(transition.verifiedEquivalence);
  }
  if (transition.schemaVersion !== FINDING_TRANSITION_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "transition schemaVersion must match the frozen schema",
      details: { expected: FINDING_TRANSITION_SCHEMA_VERSION },
    });
  }
}
