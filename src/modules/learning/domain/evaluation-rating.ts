/**
 * Evaluation ratings on opportunity findings (learning module domain;
 * WORK-022 / HUM-002; ADR-0009, ADR-0012, `spec/architecture.md` §19).
 *
 * A rating is EVALUATION EVIDENCE. It is NOT authorization, NOT
 * policy, NOT a verification PASS and NOT deployment approval (§14).
 *
 * The durable datum records the complete §14 set:
 *   WHO  (rater)  · WHEN (recordedAt)  · WHAT (candidate pair:
 *   finding + optional counterpart)  · WHERE (execution binding +
 *   source revision binding)  · THE QUESTION (question)  · THE ANSWER
 *   (answer)  · CONTEXT (context: repository, node ids, class,
 *   population).
 *
 * THE ANSWER VOCABULARY IS PREFERENCE-ONLY (M10): 'prefer-candidate' |
 * 'prefer-baseline' | 'no-difference' | 'insufficient-information'.
 * There is NO PASS/FAIL vocabulary here — a rating can never
 * fabricate a verification result (the physical CHECK in migration
 * 0016 pins the same vocabulary).
 *
 * Ratings are IMMUTABLE evidence (append-only rows, no update path).
 * A rating NEVER changes authorization or policy, and NEVER advances
 * a finding state by itself: the advisory->candidate transition
 * REFERENCES rating evidence; the rating itself grants nothing (M9).
 *
 * Idempotency: the durable identity is (finding_id, rater,
 * question_kind) — a duplicate submission converges (replayed); a
 * conflicting re-rating of the same question fails closed
 * (`IDEMPOTENCY_KEY_REUSED`) rather than forking "truth".
 *
 * This file is pure domain: no side effects, no imports outside
 * `shared`.
 */

import { PlatformError } from "../../../shared/errors";
import type { EvaluationQuestionKind } from "./human-evaluation";
import { isEvaluationQuestionKind } from "./human-evaluation";

/** Frozen evaluation-rating schema version. */
export const EVALUATION_RATING_SCHEMA_VERSION = 1;

/**
 * The preference-only answer vocabulary (M10: no verification PASS can
 * be fabricated by a rating).
 */
export const EVALUATION_RATING_ANSWERS = [
  "prefer-candidate",
  "prefer-baseline",
  "no-difference",
  "insufficient-information",
] as const;

export type EvaluationRatingAnswer = (typeof EVALUATION_RATING_ANSWERS)[number];

export function isEvaluationRatingAnswer(value: string): value is EvaluationRatingAnswer {
  return (EVALUATION_RATING_ANSWERS as readonly string[]).includes(value);
}

/** The immutable evaluation-rating datum (migration 0016 shape). */
export interface EvaluationRatingRecord {
  readonly ratingId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The analysis the rated findings belong to (scope binding). */
  readonly analysisId: string;
  /** The rated candidate finding (Mandatory — M27). */
  readonly findingId: string;
  /** The counterpart finding when the question compares a pair (§14). */
  readonly counterpartFindingId: string | null;
  /** The analysis EXECUTION the rating is attributable to (Mandatory). */
  readonly executionId: string;
  /** The prompt this rating answers, when prompted (M25 binding). */
  readonly promptId: string | null;
  /** WHO rated (attributable rater identity — Mandatory). */
  readonly rater: string;
  /** The question kind the rater answered (the question text is on the prompt/analysis). */
  readonly questionKind: EvaluationQuestionKind;
  /** THE ANSWER (preference-only vocabulary — M10). */
  readonly answer: EvaluationRatingAnswer;
  /** Optional rater confidence in [0,1] (recorded, never inferred). */
  readonly confidence?: number;
  /** Optional free-form rationale (never authority). */
  readonly rationale?: string;
  /** The source revision the rating was formed against (M12/M28 — stale revisions are detectable). */
  readonly sourceRevision: string;
  /** The evaluation CONTEXT (§14: repository, node ids, class, population). */
  readonly context: {
    readonly repository: string;
    readonly targetNodeIds: readonly string[];
    readonly findingClass: string;
    readonly population: number;
  };
  /** Evidence references backing the rating context (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
  readonly provenance: {
    /** Submission channel identity (opaque string, Mandatory). */
    readonly submittedVia: string;
  };
  readonly recordedAt: string;
  readonly schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  container: Record<string, unknown>,
  key: string,
  what: string,
  max = 256,
): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `rating ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Closed-shape validation of an evaluation rating. Fails closed: rater,
 * candidate pair, execution, source revision, question, answer, context
 * and evidence refs are ALL MANDATORY (the §14 set — M9/M10/M11/M12/
 * M27/M28 are unrepresentable-as-absent).
 */
export function validateEvaluationRating(value: unknown): asserts value is EvaluationRatingRecord {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "rating must be an object" });
  }
  const rating = value;
  requireString(rating, "ratingId", "ratingId");
  requireString(rating, "applicationId", "applicationId");
  requireString(rating, "tenantId", "tenantId");
  requireString(rating, "analysisId", "analysisId (scope binding)");
  requireString(rating, "findingId", "findingId (the rated candidate — M27)");
  if (
    rating.counterpartFindingId !== null &&
    rating.counterpartFindingId !== undefined &&
    (typeof rating.counterpartFindingId !== "string" || rating.counterpartFindingId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating counterpartFindingId must be a non-empty string or null",
    });
  }
  requireString(rating, "executionId", "executionId (the analysis execution binding)");
  if (
    rating.promptId !== null &&
    rating.promptId !== undefined &&
    (typeof rating.promptId !== "string" || rating.promptId.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating promptId must be a non-empty string or null",
    });
  }
  requireString(rating, "rater", "rater (attributable rater identity)");
  if (typeof rating.questionKind !== "string" || !isEvaluationQuestionKind(rating.questionKind)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating questionKind must be the closed question vocabulary",
    });
  }
  if (typeof rating.answer !== "string" || !isEvaluationRatingAnswer(rating.answer)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "rating answer must be the preference-only vocabulary (a rating is never a verification PASS — M10)",
      details: { allowed: EVALUATION_RATING_ANSWERS },
    });
  }
  if (
    rating.confidence !== undefined &&
    (typeof rating.confidence !== "number" || rating.confidence < 0 || rating.confidence > 1)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating confidence must be in [0,1] when present",
    });
  }
  if (
    rating.rationale !== undefined &&
    (typeof rating.rationale !== "string" || rating.rationale.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating rationale must be a non-empty string when present",
    });
  }
  requireString(
    rating,
    "sourceRevision",
    "sourceRevision (M12/M28: revision binding is mandatory)",
  );
  const context = rating.context;
  if (
    !isRecord(context) ||
    typeof context.repository !== "string" ||
    context.repository.length === 0 ||
    !Array.isArray(context.targetNodeIds) ||
    context.targetNodeIds.length === 0 ||
    context.targetNodeIds.some((id) => typeof id !== "string" || id.length === 0) ||
    typeof context.findingClass !== "string" ||
    context.findingClass.length === 0 ||
    typeof context.population !== "number" ||
    !Number.isInteger(context.population) ||
    context.population < 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "rating context must carry repository, non-empty targetNodeIds, class and integer population (§14)",
    });
  }
  const evidenceRefs = rating.evidenceRefs;
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length === 0 ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating evidenceRefs must be non-empty (M11: evidence references are mandatory)",
      details: { field: "evidenceRefs" },
    });
  }
  const provenance = rating.provenance;
  if (
    !isRecord(provenance) ||
    typeof provenance.submittedVia !== "string" ||
    provenance.submittedVia.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating provenance must record the submission channel",
    });
  }
  requireString(rating, "recordedAt", "recordedAt");
  if (rating.schemaVersion !== EVALUATION_RATING_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating schemaVersion must match the frozen rating schema",
      details: { expected: EVALUATION_RATING_SCHEMA_VERSION },
    });
  }
}

/**
 * The canonical fingerprint basis of a rating: everything except
 * `ratingId`/`recordedAt` — identical re-submissions converge; the
 * same durable identity with a different fingerprint fails closed.
 */
export function evaluationRatingFingerprintBasis(
  rating: Omit<EvaluationRatingRecord, "ratingId" | "recordedAt">,
): Readonly<Record<string, unknown>> {
  return {
    applicationId: rating.applicationId,
    tenantId: rating.tenantId,
    analysisId: rating.analysisId,
    findingId: rating.findingId,
    counterpartFindingId: rating.counterpartFindingId,
    executionId: rating.executionId,
    promptId: rating.promptId,
    rater: rating.rater,
    questionKind: rating.questionKind,
    answer: rating.answer,
    confidence: rating.confidence ?? null,
    rationale: rating.rationale ?? null,
    sourceRevision: rating.sourceRevision,
    context: {
      repository: rating.context.repository,
      targetNodeIds: [...rating.context.targetNodeIds],
      findingClass: rating.context.findingClass,
      population: rating.context.population,
    },
    evidenceRefs: [...rating.evidenceRefs],
    provenance: { submittedVia: rating.provenance.submittedVia },
    schemaVersion: rating.schemaVersion,
  };
}
