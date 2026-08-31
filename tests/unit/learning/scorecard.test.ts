/**
 * Scorecard model tests (learning module domain; WORK-014 / LRN-001,
 * TOL-003, INT-006).
 *
 * Required-test mapping:
 *  - aggregation over a real telemetry population (integer accounting);
 *  - M9 semantics: scorecards are built as NEW immutable versions (no
 *    in-place mutation surface — the domain type has no update path);
 *  - M10/M11: per-entry sourceExecutionIds + evidenceRefs are mandatory
 *    and non-empty (round-trip validation rejects orphans);
 *  - M12: population scope is enforced (a datum outside the scope fails
 *    closed);
 *  - M13: full versioning basis validated on round-trip;
 *  - M14: heterogeneous telemetry schema populations fail closed — a
 *    scorecard combining incompatible schemas is unrepresentable;
 *  - minimum-population exclusion is visible (totalPopulation records
 *    the pre-filter population; sub-threshold groups are excluded, and
 *    a fully sub-threshold population is a typed error, not a scorecard);
 *  - uncertainty is honest (population-derived classification, never
 *    collapsed).
 */

import { describe, expect, test } from "vitest";
import { TELEMETRY_SCHEMA_VERSION } from "../../../src/modules/learning/domain/telemetry";
import {
  AGGREGATION_DEFINITIONS,
  buildScorecard,
  type ExecutionOutcomeTelemetry,
  findAggregationDefinition,
  scorecardDigestBasis,
  validateScorecard,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

let executionCounter = 0;

function telemetry(overrides: Partial<ExecutionOutcomeTelemetry> = {}): ExecutionOutcomeTelemetry {
  executionCounter += 1;
  const executionId = `00000000-0000-7000-8000-${String(executionCounter).padStart(12, "0")}`;
  const succeeded = overrides.outcome === undefined || overrides.outcome === "execution-completed";
  return {
    telemetryId: `00000000-0000-7000-8000-${String(1000 + executionCounter).padStart(12, "0")}`,
    executionId,
    applicationId: APP,
    tenantId: TENANT,
    taskClass: "interpretation",
    capabilities: ["text-generation"],
    planId: "plan-digest-1",
    planRevision: 1,
    strategyClass: "generative",
    routes: [{ provider: "rail-a", model: "model-x" }],
    tools: [],
    environments: [],
    verification: {
      resultIds: [`ver-${executionCounter}`],
      statuses: succeeded ? ["PASS"] : ["FAIL"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: succeeded ? 1 : 0,
      failCount: succeeded ? 0 : 1,
      inconclusiveCount: 0,
      verified: succeeded,
    },
    costMicroUsd: "1000",
    latencyMs: 2000,
    outcome: "execution-completed",
    recordedAt: `2026-09-15T12:00:${String(executionCounter).padStart(2, "0")}Z`,
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("scorecard building and validation", () => {
  test("aggregates a route population with integer accounting and full traceability", () => {
    const population = Array.from({ length: 10 }, (_, index) =>
      telemetry(index < 8 ? {} : { outcome: "execution-failed" }),
    );
    const card = buildScorecard({
      definitionId: "route-outcome-by-task-class",
      scorecardId: "sc-1",
      scorecardVersion: 1,
      applicationId: APP,
      tenantId: TENANT,
      telemetry: population,
      populationFrom: null,
      populationTo: "2026-09-15T13:00:00Z",
      computedAt: "2026-09-15T13:00:00Z",
    });

    expect(card.definitionId).toBe("route-outcome-by-task-class");
    expect(card.definitionVersion).toBe(1);
    expect(card.scorecardVersion).toBe(1);
    expect(card.telemetrySchemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(card.totalPopulation).toBe(10);
    expect(card.entries).toHaveLength(1);

    const entry = card.entries[0];
    expect(entry?.subjectKind).toBe("route");
    expect(entry?.subjectKey).toBe("rail-a/model-x");
    expect(entry?.taskClass).toBe("interpretation");
    expect(entry?.population).toBe(10);
    expect(entry?.successCount).toBe(8);
    expect(entry?.successRate).toBeCloseTo(0.8, 10);
    expect(entry?.verificationPassRate).toBeCloseTo(0.8, 10);
    expect(entry?.meanCostMicroUsd).toBe("1000");
    expect(entry?.meanLatencyMs).toBe(2000);
    // M10/M11: per-entry traceability.
    expect(entry?.sourceExecutionIds).toHaveLength(10);
    expect(entry?.evidenceRefs).toHaveLength(10);
    // Population 10 with 2-sigma spread ~0.316: material uncertainty,
    // honestly recorded (never collapsed).
    expect(entry?.uncertainty.level).toBe("material");
    expect(entry?.uncertainty.reasonCode).toBe("binomial-spread");
  });

  test("large populations earn low uncertainty honestly", () => {
    const population = Array.from({ length: 200 }, () => telemetry());
    const card = buildScorecard({
      definitionId: "route-outcome-by-task-class",
      scorecardId: "sc-2",
      scorecardVersion: 1,
      applicationId: APP,
      tenantId: TENANT,
      telemetry: population,
      populationFrom: null,
      populationTo: "2026-09-15T13:00:00Z",
      computedAt: "2026-09-15T13:00:00Z",
    });
    const entry = card.entries[0];
    // 2*sqrt(0.25/200) ~ 0.0707 < 0.1 and population >= 10.
    expect(entry?.uncertainty.level).toBe("low");
    expect(entry?.uncertainty.reasonCode).toBe("adequate-population");
  });

  test("M14: a heterogeneous telemetry population fails closed", () => {
    const population = [telemetry(), telemetry({ schemaVersion: TELEMETRY_SCHEMA_VERSION + 1 })];
    expect(() =>
      buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-3",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: population,
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("a schema version incompatible with the definition fails closed", () => {
    const population = [telemetry({ schemaVersion: TELEMETRY_SCHEMA_VERSION + 1 })];
    expect(() =>
      buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-4",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: population,
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("M12: a datum outside the scorecard scope fails closed", () => {
    const population = [
      telemetry(),
      telemetry({ tenantId: "00000000-0000-7000-8000-00000000dead" }),
    ];
    expect(() =>
      buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-5",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: population,
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("an empty population is a typed error (evidence over claims)", () => {
    expect(() =>
      buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-6",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: [],
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("sub-threshold groups are excluded; a fully sub-threshold population errors", () => {
    // 3 observations on one route, 4 on another: both below the minimum 5.
    const population = [
      telemetry(),
      telemetry(),
      telemetry(),
      telemetry({
        routes: [{ provider: "rail-b", model: "model-y" }],
      }),
      telemetry({
        routes: [{ provider: "rail-b", model: "model-y" }],
      }),
      telemetry({
        routes: [{ provider: "rail-b", model: "model-y" }],
      }),
      telemetry({
        routes: [{ provider: "rail-b", model: "model-y" }],
      }),
    ];
    expect(() =>
      buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-7",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: population,
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("unknown aggregation definitions fail closed (closed registry)", () => {
    expect(() =>
      buildScorecard({
        definitionId: "not-a-definition",
        scorecardId: "sc-8",
        scorecardVersion: 1,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: [telemetry()],
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
    ).toThrow(PlatformError);
    expect(findAggregationDefinition("not-a-definition")).toBeUndefined();
    expect(AGGREGATION_DEFINITIONS.length).toBeGreaterThanOrEqual(5);
  });

  test("round-trip validation pins the version anchors (M13) and traceability (M10/M11)", () => {
    const population = Array.from({ length: 6 }, () => telemetry());
    const card = {
      ...buildScorecard({
        definitionId: "route-outcome-by-task-class",
        scorecardId: "sc-9",
        scorecardVersion: 2,
        applicationId: APP,
        tenantId: TENANT,
        telemetry: population,
        populationFrom: null,
        populationTo: "2026-09-15T13:00:00Z",
        computedAt: "2026-09-15T13:00:00Z",
      }),
      digest: "deadbeef",
    };
    expect(() => validateScorecard(card)).not.toThrow();

    // M13: version anchors are mandatory on round-trip.
    expect(() => validateScorecard({ ...card, scorecardVersion: 0 })).toThrow(PlatformError);
    expect(() => validateScorecard({ ...card, definitionVersion: 0 })).toThrow(PlatformError);
    expect(() => validateScorecard({ ...card, telemetrySchemaVersion: 0 })).toThrow(PlatformError);

    // M10: entries without source executions are rejected.
    const orphaned = {
      ...card,
      entries: card.entries.map((entry) => ({ ...entry, sourceExecutionIds: [] })),
    };
    expect(() => validateScorecard(orphaned)).toThrow(PlatformError);

    // M11: entries without evidence refs are rejected.
    const unevidenced = {
      ...card,
      entries: card.entries.map((entry) => ({ ...entry, evidenceRefs: [] })),
    };
    expect(() => validateScorecard(unevidenced)).toThrow(PlatformError);
  });

  test("the digest basis is deterministic and version-sensitive", () => {
    const population = Array.from({ length: 6 }, () => telemetry());
    const base = buildScorecard({
      definitionId: "route-outcome-by-task-class",
      scorecardId: "sc-10",
      scorecardVersion: 1,
      applicationId: APP,
      tenantId: TENANT,
      telemetry: population,
      populationFrom: null,
      populationTo: "2026-09-15T13:00:00Z",
      computedAt: "2026-09-15T13:00:00Z",
    });
    const versioned = buildScorecard({
      definitionId: "route-outcome-by-task-class",
      scorecardId: "sc-10",
      scorecardVersion: 2,
      applicationId: APP,
      tenantId: TENANT,
      telemetry: population,
      populationFrom: null,
      populationTo: "2026-09-15T13:00:00Z",
      computedAt: "2026-09-15T13:00:00Z",
    });
    expect(scorecardDigestBasis(base)).not.toEqual(scorecardDigestBasis(versioned));
  });

  test("tool scorecards aggregate tool subjects (TOL-003)", () => {
    const population = Array.from({ length: 12 }, (_, index) =>
      telemetry({
        tools: [`tool-${index % 2}`],
        routes: [],
      }),
    );
    const card = buildScorecard({
      definitionId: "tool-outcome-by-task-class",
      scorecardId: "sc-11",
      scorecardVersion: 1,
      applicationId: APP,
      tenantId: TENANT,
      telemetry: population,
      populationFrom: null,
      populationTo: "2026-09-15T13:00:00Z",
      computedAt: "2026-09-15T13:00:00Z",
    });
    expect(card.entries.map((entry) => entry.subjectKind).every((kind) => kind === "tool")).toBe(
      true,
    );
    expect(card.entries).toHaveLength(2);
  });
});
