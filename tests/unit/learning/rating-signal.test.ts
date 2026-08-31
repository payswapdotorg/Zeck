/**
 * Rating + signal model tests (learning module domain; WORK-014 / §12,
 * INT-006; ADR-0009/ADR-0012).
 *
 * Required-test mapping:
 *  - ratings preserve actor/target/criteria/timestamp/provenance (the
 *    full §12 set) — closed-shape validation;
 *  - M10: ratings are bound to their target execution (orphans rejected);
 *  - M16 provenance: source + submission channel are mandatory;
 *  - the bounded rating scale is enforced;
 *  - rating fingerprint determinism;
 *  - learning signals: versioned basis (M13), non-authority class,
 *    evidence refs (M11).
 */

import { describe, expect, test } from "vitest";
import {
  LEARNING_SIGNAL_CLASS,
  LEARNING_SIGNAL_SCHEMA_VERSION,
  type LearningSignal,
  ratingFingerprintBasis,
  signalFromScorecardEntry,
  type UserRatingRecord,
  validateLearningSignal,
  validateUserRating,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";
const EXECUTION = "00000000-0000-7000-8000-0000000000d1";

function validRating(): UserRatingRecord {
  return {
    ratingId: "rating-1",
    applicationId: APP,
    tenantId: TENANT,
    executionId: EXECUTION,
    evaluatorId: "user-77",
    ratingDimension: "overall-quality",
    rating: 4,
    provenance: {
      source: "user",
      submittedVia: "dashboard",
    },
    evidenceRefs: [`execution:${EXECUTION}:receipt`],
    recordedAt: "2026-09-15T12:00:00Z",
    schemaVersion: 1,
  };
}

describe("user rating evidence", () => {
  test("a fully-provenanced rating validates", () => {
    expect(() => validateUserRating(validRating())).not.toThrow();
  });

  test("M10: a rating without a target execution is rejected", () => {
    const rating = validRating();
    delete (rating as { executionId?: string }).executionId;
    expect(() => validateUserRating(rating)).toThrow(PlatformError);
  });

  test("the §12 provenance set is mandatory (actor, target, dimension, evidence)", () => {
    const cases: [string, (rating: UserRatingRecord) => void][] = [
      ["evaluator", (rating) => delete (rating as { evaluatorId?: string }).evaluatorId],
      ["dimension", (rating) => delete (rating as { ratingDimension?: string }).ratingDimension],
      [
        "evidence",
        (rating) => ((rating as unknown as { evidenceRefs: string[] }).evidenceRefs = []),
      ],
    ];
    for (const [what, mutate] of cases) {
      const rating = validRating();
      mutate(rating);
      expect(() => validateUserRating(rating), `missing ${what}`).toThrow(PlatformError);
    }
    const noProvenance = validRating();
    delete (noProvenance as { provenance?: unknown }).provenance;
    expect(() => validateUserRating(noProvenance)).toThrow(PlatformError);
  });

  test("the rating scale is bounded [1, 5] integers", () => {
    for (const rating of [0, 6, 3.5]) {
      const record = validRating();
      (record as { rating: number }).rating = rating;
      expect(() => validateUserRating(record)).toThrow(PlatformError);
    }
    for (const rating of [1, 3, 5]) {
      const record = validRating();
      (record as { rating: number }).rating = rating;
      expect(() => validateUserRating(record)).not.toThrow();
    }
  });

  test("provenance source vocabulary is user|human", () => {
    const rating = validRating();
    (rating.provenance as { source: string }).source = "admin";
    expect(() => validateUserRating(rating)).toThrow(PlatformError);
  });

  test("the rating fingerprint basis is deterministic and content-sensitive", () => {
    const basis = ratingFingerprintBasis(validRating());
    expect(ratingFingerprintBasis(validRating())).toEqual(basis);
    const mutated = validRating();
    (mutated as { rating: number }).rating = 2;
    expect(ratingFingerprintBasis(mutated)).not.toEqual(basis);
  });
});

describe("learning signals (the planning READ seam payload)", () => {
  function basis() {
    return {
      scorecardId: "sc-1",
      scorecardVersion: 2,
      definitionId: "route-outcome-by-task-class",
      definitionVersion: 1,
      telemetrySchemaVersion: 1,
      populationWindowFrom: null,
      populationWindowTo: "2026-09-15T13:00:00Z",
    };
  }

  function entry() {
    return {
      subjectKind: "route",
      subjectKey: "rail-a/model-x",
      taskClass: "interpretation",
      population: 12,
      successCount: 10,
      successRate: 10 / 12,
      verificationPassRate: null,
      meanCostMicroUsd: "800",
      meanLatencyMs: 1400,
      uncertainty: { level: "low" as const, reasonCode: "adequate-population" },
      evidenceRefs: ["ev-1", "ev-2"],
    };
  }

  test("a scorecard entry projects into a fully versioned non-authoritative signal", () => {
    const signal = signalFromScorecardEntry(entry(), basis());
    expect(signal.signalClass).toBe(LEARNING_SIGNAL_CLASS);
    expect(signal.scorecardVersion).toBe(2);
    expect(signal.telemetrySchemaVersion).toBe(1);
    expect(signal.signalSchemaVersion).toBe(LEARNING_SIGNAL_SCHEMA_VERSION);
    expect(() => validateLearningSignal(signal)).not.toThrow();
  });

  test("M13: an unversioned signal is rejected (never consumed)", () => {
    const signal: LearningSignal = signalFromScorecardEntry(entry(), basis());
    const unversioned = { ...signal, scorecardVersion: 0 } as LearningSignal;
    expect(() => validateLearningSignal(unversioned)).toThrow(PlatformError);
    const noDefinition = { ...signal, definitionId: "" } as LearningSignal;
    expect(() => validateLearningSignal(noDefinition)).toThrow(PlatformError);
  });

  test("the non-authority class is pinned: an 'authorization' class is rejected", () => {
    const signal: LearningSignal = signalFromScorecardEntry(entry(), basis());
    const mutiny = { ...signal, signalClass: "authorization" } as unknown as LearningSignal;
    expect(() => validateLearningSignal(mutiny)).toThrow(PlatformError);
  });

  test("M11: a signal without evidence references is rejected", () => {
    const signal: LearningSignal = signalFromScorecardEntry(entry(), basis());
    const unevidenced = { ...signal, evidenceRefs: [] } as LearningSignal;
    expect(() => validateLearningSignal(unevidenced)).toThrow(PlatformError);
  });
});
