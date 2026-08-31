/**
 * User/human rating evidence (learning module domain; WORK-014 / §12 of
 * the Work Order; ADR-0009, ADR-0012).
 *
 * A user rating is a LEARNING DATUM, never an authority. The architecture
 * allows future user feedback; this file fixes the durable shape the
 * future HUM flows (WORK-022) will write:
 *
 *  - WHO rated: `evaluatorId` + provenance (actor identity, mandatory);
 *  - WHAT was rated: `executionId` (mandatory target binding — a rating
 *    with no source execution is unrepresentable, M10) + optional
 *    artifact ref;
 *  - ON WHICH dimension: `ratingDimension` (explicit criteria/rating
 *    dimension, mandatory);
 *  - WHEN: `recordedAt`;
 *  - PROVENANCE: source ("user" | "human"), optional request reference
 *    (the WORK-013 human-evaluation request it answers), submission
 *    channel.
 *
 * Ratings are IMMUTABLE evidence (append-only rows, no update path;
 * migration 0009 makes the physical rows immutable). A rating NEVER
 * changes authorization or policy (M16): the learning module owns no
 * policy surface — see the architecture test that pins the import
 * boundary and the discrimination red-records.
 *
 * Idempotency: the durable identity is
 * (execution_id, evaluator_id, rating_dimension) — a duplicate
 * submission converges (replayed); a conflicting re-rating of the same
 * dimension fails closed (`IDEMPOTENCY_KEY_REUSED`) rather than forking
 * "truth".
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";

/** Frozen rating-record schema version. */
export const RATING_SCHEMA_VERSION = 1;

/** Who produced the rating (provenance vocabulary). */
export const RATING_SOURCES = ["user", "human"] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/** The bounded scalar scale (inclusive) — explicit, not implicit. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** The immutable rating datum (migration 0009 shape). */
export interface UserRatingRecord {
  readonly ratingId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Target execution — MANDATORY (ratings never orphan, M10). */
  readonly executionId: string;
  /** Optional artifact the rating targets. */
  readonly targetArtifactRef?: string;
  /** Actor/evaluator identity (WHO). */
  readonly evaluatorId: string;
  /** Explicit criteria/rating dimension (e.g. "overall-quality"). */
  readonly ratingDimension: string;
  /** Scalar rating on the bounded [RATING_MIN, RATING_MAX] scale. */
  readonly rating: number;
  /** Optional rater confidence in [0,1] (recorded, never inferred). */
  readonly confidence?: number;
  /** Optional free-form rationale (never used as authority). */
  readonly rationale?: string;
  readonly provenance: {
    readonly source: RatingSource;
    /** WORK-013 human-evaluation request this rating answers, if any. */
    readonly requestRef?: string;
    /** Submission channel identity (opaque string). */
    readonly submittedVia: string;
  };
  /** Evidence references backing the rating context (M11, non-empty). */
  readonly evidenceRefs: readonly string[];
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
      message: `rating ${what} must be a non-empty string`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Closed-shape validation of a rating datum. Fails closed: evaluator,
 * target execution, dimension, evidence refs and provenance are all
 * MANDATORY (the actor/target/criteria/timestamp/provenance set of the
 * Work Order §12).
 */
export function validateUserRating(value: unknown): asserts value is UserRatingRecord {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "rating must be an object" });
  }
  const rating = value;
  requireString(rating, "ratingId", "ratingId");
  requireString(rating, "applicationId", "applicationId");
  requireString(rating, "tenantId", "tenantId");
  requireString(rating, "executionId", "executionId (target execution binding, M10)");
  requireString(rating, "evaluatorId", "evaluatorId (actor identity)");
  requireString(rating, "ratingDimension", "ratingDimension (criteria dimension)");
  const scalar = rating.rating;
  if (
    typeof scalar !== "number" ||
    !Number.isInteger(scalar) ||
    scalar < RATING_MIN ||
    scalar > RATING_MAX
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `rating must be an integer on the bounded [${RATING_MIN}, ${RATING_MAX}] scale`,
      details: { got: scalar },
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
  const provenance = rating.provenance;
  if (!isRecord(provenance)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating provenance must record actor source and submission channel",
    });
  }
  if (
    typeof provenance.source !== "string" ||
    !(RATING_SOURCES as readonly string[]).includes(provenance.source)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating provenance source must be 'user' or 'human'",
      details: { allowed: RATING_SOURCES },
    });
  }
  requireString(provenance, "submittedVia", "provenance submittedVia");
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
  requireString(rating, "recordedAt", "recordedAt");
  if (rating.schemaVersion !== RATING_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "rating schemaVersion must match the frozen rating schema",
      details: { expected: RATING_SCHEMA_VERSION },
    });
  }
}

/**
 * The canonical fingerprint basis of a rating: everything except
 * `ratingId`/`recordedAt` — identical re-submissions converge; the same
 * durable identity with a different fingerprint fails closed.
 */
export function ratingFingerprintBasis(
  rating: Omit<UserRatingRecord, "ratingId" | "recordedAt">,
): Readonly<Record<string, unknown>> {
  return {
    applicationId: rating.applicationId,
    tenantId: rating.tenantId,
    executionId: rating.executionId,
    targetArtifactRef: rating.targetArtifactRef ?? null,
    evaluatorId: rating.evaluatorId,
    ratingDimension: rating.ratingDimension,
    rating: rating.rating,
    confidence: rating.confidence ?? null,
    rationale: rating.rationale ?? null,
    provenance: {
      source: rating.provenance.source,
      requestRef: rating.provenance.requestRef ?? null,
      submittedVia: rating.provenance.submittedVia,
    },
    evidenceRefs: [...rating.evidenceRefs],
    schemaVersion: rating.schemaVersion,
  };
}
