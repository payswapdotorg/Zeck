/**
 * Shadow evaluation model tests (learning module domain; WORK-014 /
 * INT-006; ADR-0008/0009).
 *
 * Required-test mapping:
 *  - subject scoring against scorecard entries (task-class-bound);
 *  - §13: uncertainty is NOT collapsed — overlapping success-rate
 *    intervals produce `inconclusive`, never a forced winner;
 *  - M15: the record class is pinned to 'shadow' — a speculative result
 *    presented as a production outcome is unrepresentable;
 *  - M13: the evaluation basis must be versioned (scorecard version,
 *    definition version, telemetry schema version) or the honest 'none';
 *  - statuses: scored / insufficient-evidence / no-baseline /
 *    incompatible-schema vocabulary.
 */

import { describe, expect, test } from "vitest";
import type { ScorecardEntry as ScorecardEntryType } from "../../../src/modules/learning/public";
import {
  compareShadowScores,
  type Scorecard,
  SHADOW_EVALUATION_STATUSES,
  type ShadowEvaluationRecord,
  type ShadowStrategyDescription,
  scoreShadowSubjects,
  validateShadowEvaluationRecord,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

function strategy(
  routeSubjects: readonly string[],
  taskClass = "interpretation",
): ShadowStrategyDescription {
  return {
    strategyIdentity: "proposed-strategy-1",
    descriptionDigest: "deadbeef",
    taskClass,
    routeSubjects,
    toolSubjects: [],
  };
}

function scorecard(entries: readonly ScorecardEntryType[]): Scorecard {
  return {
    scorecardId: "sc-1",
    definitionId: "route-outcome-by-task-class",
    definitionVersion: 1,
    scorecardVersion: 1,
    applicationId: APP,
    tenantId: TENANT,
    telemetrySchemaVersion: 1,
    populationFrom: null,
    populationTo: "2026-09-15T13:00:00Z",
    totalPopulation: entries.reduce((sum, entry) => sum + entry.population, 0),
    entries,
    computedAt: "2026-09-15T13:00:00Z",
    digest: "digest",
  };
}

function entry(
  subjectKey: string,
  population: number,
  successCount: number,
  taskClass = "interpretation",
): ScorecardEntryType {
  return {
    subjectKind: "route",
    subjectKey,
    taskClass,
    population,
    successCount,
    successRate: successCount / population,
    verificationPassRate: null,
    meanCostMicroUsd: "1000",
    meanLatencyMs: 1500,
    uncertainty: {
      level: "low",
      reasonCode: "adequate-population",
      detail: "test",
    },
    sourceExecutionIds: Array.from({ length: population }, (_, i) => `exec-${subjectKey}-${i}`),
    evidenceRefs: Array.from({ length: population }, (_, i) => `ev-${subjectKey}-${i}`),
  };
}

describe("shadow subject scoring", () => {
  test("scores only task-class-matching subjects from the evaluation basis", () => {
    const card = scorecard([
      entry("rail-a/model-x", 100, 95),
      entry("rail-a/model-x", 50, 10, "generation"),
    ]);
    const scores = scoreShadowSubjects(strategy(["rail-a/model-x"]), card);
    expect(scores).toHaveLength(1);
    expect(scores[0]?.subjectKey).toBe("rail-a/model-x");
    expect(scores[0]?.successRate).toBeCloseTo(0.95, 10);
    expect(scores[0]?.population).toBe(100);
    expect(scores[0]?.spread).toBeGreaterThan(0);
  });

  test("unknown subjects score nothing (honest insufficiency, never fabrication)", () => {
    const card = scorecard([entry("rail-a/model-x", 100, 95)]);
    expect(scoreShadowSubjects(strategy(["rail-z/model-9"]), card)).toEqual([]);
  });
});

describe("shadow comparison honesty (§13)", () => {
  test("overlapping intervals are inconclusive, never a forced winner", () => {
    const proposed = [
      {
        subjectKind: "route",
        subjectKey: "a",
        population: 100,
        successCount: 90,
        successRate: 0.9,
        uncertainty: "low" as const,
        spread: 0.1,
      },
    ];
    const baseline = [
      {
        subjectKind: "route",
        subjectKey: "b",
        population: 100,
        successCount: 88,
        successRate: 0.88,
        uncertainty: "low" as const,
        spread: 0.1,
      },
    ];
    const comparison = compareShadowScores(proposed, baseline);
    // |0.9 - 0.88| = 0.02 <= 0.1 + 0.1: overlap ⇒ inconclusive.
    expect(comparison?.preferred).toBe("inconclusive");
    expect(comparison?.rationale).toContain("overlap");
  });

  test("a clear separation produces a winner with the honest uncertainty", () => {
    const proposed = [
      {
        subjectKind: "route",
        subjectKey: "a",
        population: 100,
        successCount: 95,
        successRate: 0.95,
        uncertainty: "low" as const,
        spread: 0.02,
      },
    ];
    const baseline = [
      {
        subjectKind: "route",
        subjectKey: "b",
        population: 100,
        successCount: 50,
        successRate: 0.5,
        uncertainty: "low" as const,
        spread: 0.02,
      },
    ];
    const comparison = compareShadowScores(proposed, baseline);
    expect(comparison?.preferred).toBe("proposed");
    expect(comparison?.rationale).toContain("never production authority");
  });

  test("no baseline leaves the comparison undefined (no invented contest)", () => {
    expect(compareShadowScores([], undefined)).toBeUndefined();
  });

  test("a proposed strategy with no scored subject is honestly inconclusive", () => {
    const comparison = compareShadowScores(
      [],
      [
        {
          subjectKind: "route",
          subjectKey: "b",
          population: 10,
          successCount: 5,
          successRate: 0.5,
          uncertainty: "material" as const,
          spread: 0.3,
        },
      ],
    );
    expect(comparison?.preferred).toBe("inconclusive");
    expect(comparison?.uncertainty).toBe("high");
  });
});

describe("shadow record validation", () => {
  function record(overrides: Partial<ShadowEvaluationRecord> = {}): ShadowEvaluationRecord {
    return {
      shadowId: "shadow-1",
      recordClass: "shadow",
      applicationId: APP,
      tenantId: TENANT,
      proposed: strategy(["rail-a/model-x"]),
      evaluationBasis: {
        kind: "scorecard",
        scorecardId: "sc-1",
        scorecardVersion: 1,
        definitionId: "route-outcome-by-task-class",
        definitionVersion: 1,
        telemetrySchemaVersion: 1,
        populationWindowFrom: null,
        populationWindowTo: "2026-09-15T13:00:00Z",
      },
      proposedScores: [],
      baselineScores: [],
      status: "insufficient-evidence",
      evidenceRefs: [],
      sourceExecutionIds: [],
      requestedBy: "actor-1",
      recordedAt: "2026-09-15T13:10:00Z",
      schemaVersion: 1,
      ...overrides,
    };
  }

  test("M15: the record class is pinned to 'shadow'", () => {
    expect(() => validateShadowEvaluationRecord(record())).not.toThrow();
    expect(() =>
      validateShadowEvaluationRecord(record({ recordClass: "production" as never })),
    ).toThrow(PlatformError);
  });

  test("M13: the evaluation basis must carry the version anchors", () => {
    const unversioned = {
      ...record(),
      evaluationBasis: {
        kind: "scorecard",
        scorecardId: "sc-1",
        scorecardVersion: 0,
        definitionId: "route-outcome-by-task-class",
        definitionVersion: 1,
        telemetrySchemaVersion: 1,
        populationWindowFrom: null,
        populationWindowTo: "2026-09-15T13:00:00Z",
      },
    };
    expect(() => validateShadowEvaluationRecord(unversioned)).toThrow(PlatformError);
  });

  test("a 'none' basis is legal only with the honest insufficient-evidence status", () => {
    expect(() =>
      validateShadowEvaluationRecord(
        record({ evaluationBasis: { kind: "none" }, status: "insufficient-evidence" }),
      ),
    ).not.toThrow();
    expect(() =>
      validateShadowEvaluationRecord(
        record({ evaluationBasis: { kind: "none" }, status: "scored" }),
      ),
    ).toThrow(PlatformError);
  });

  test("the status vocabulary is the honest closed set", () => {
    expect(SHADOW_EVALUATION_STATUSES).toEqual([
      "scored",
      "insufficient-evidence",
      "incompatible-schema",
      "no-baseline",
    ]);
    expect(() => validateShadowEvaluationRecord(record({ status: "winner" as never }))).toThrow(
      PlatformError,
    );
  });
});
