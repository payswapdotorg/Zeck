/**
 * Learning service tests (learning module application; WORK-014 /
 * LRN-001, INT-006) over the in-memory store (the reference semantics
 * of the SQL store — the real-PostgreSQL suites prove them physically).
 *
 * Required-test mapping:
 *  - telemetry ingestion: validate → fingerprint → idempotent append;
 *  - IDENTITY-IDEMPOTENCY (learning axis): same execution + same
 *    fingerprint converges (replayed); same execution + different
 *    fingerprint fails closed IDEMPOTENCY_KEY_REUSED (one authoritative
 *    observation per execution never forks);
 *  - scorecard building: version 1 then version 2 (append-only
 *    versioning, M9); no new evidence ⇒ typed no-op error (no version
 *    churn without new evidence);
 *  - consultSignals: versioned signals filtered by task class/subjects;
 *  - ratings: converge-or-fail-closed semantics.
 */

import { describe, expect, test } from "vitest";
import {
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  type ExecutionOutcomeTelemetry,
  type RecordRatingInput,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";
const OTHER_TENANT = "00000000-0000-7000-8000-0000000000cc";

let clock = 0;
let counter = 0;

function makeService() {
  const store = createInMemoryLearningStore();
  clock = 0;
  counter = 0;
  const service = createLearningService({
    store,
    digest: createNodeDigest(),
    generateId: () => {
      counter += 1;
      return `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
    },
    now: () => {
      clock += 1;
      return new Date(Date.parse("2026-09-15T12:00:00Z") + clock * 1000);
    },
  });
  return { service, store };
}

function telemetryInput(overrides: Partial<RecordTelemetryInput> = {}): RecordTelemetryInput {
  counter += 1;
  const executionId = `00000000-0000-7000-9000-${String(counter).padStart(12, "0")}`;
  return {
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
      resultIds: [`ver-${counter}`],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1000",
    latencyMs: 2000,
    outcome: "execution-completed",
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("learning service telemetry ingestion", () => {
  test("ingests a valid observation and converges identical retries", async () => {
    const { service } = makeService();
    const input = telemetryInput();
    const first = await service.recordExecutionTelemetry(input);
    expect(first.replayed).toBe(false);

    const retry = await service.recordExecutionTelemetry(input);
    expect(retry.replayed).toBe(true);
    expect(retry.telemetryId).toBe(first.telemetryId);
    expect(retry.fingerprint).toBe(first.fingerprint);
  });

  test("a conflicting re-observation of the same execution fails closed", async () => {
    const { service } = makeService();
    const input = telemetryInput();
    await service.recordExecutionTelemetry(input);
    const conflicting = telemetryInput({ ...input, costMicroUsd: "9999" });
    await expect(service.recordExecutionTelemetry(conflicting)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  test("an invalid observation is rejected before any durable write", async () => {
    const { store, service } = makeService();
    const orphan = telemetryInput();
    delete (orphan as { executionId?: string }).executionId;
    await expect(service.recordExecutionTelemetry(orphan)).rejects.toThrow(PlatformError);
    expect(store.telemetryCount()).toBe(0);
  });
});

describe("learning service scorecards", () => {
  test("builds version 1 then version 2; consultSignals carry the latest basis", async () => {
    const { service } = makeService();
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(telemetryInput());
    }
    const version1 = await service.buildScorecard({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
    });
    expect(version1.scorecardVersion).toBe(1);
    expect(version1.entries[0]?.population).toBe(6);

    // New evidence -> version 2.
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(
        telemetryInput({
          routes: [{ provider: "rail-a", model: "model-x" }],
          outcome: "execution-failed",
        }),
      );
    }
    const version2 = await service.buildScorecard({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
    });
    expect(version2.scorecardVersion).toBe(2);
    // Cumulative snapshot: version 2 covers ALL 12 observations.
    expect(version2.totalPopulation).toBe(12);
    expect(version2.entries[0]?.population).toBe(12);
    expect(version2.populationFrom).toBeNull();

    // The signals carry the LATEST version basis (M13).
    const signals = await service.consultSignals({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
      taskClass: "interpretation",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.scorecardVersion).toBe(2);
    expect(signals[0]?.subjectKey).toBe("rail-a/model-x");
    // Version 2 is the cumulative snapshot (12 observations, 6 success).
    expect(signals[0]?.population).toBe(12);
    expect(signals[0]?.successCount).toBe(6);
  });

  test("no new evidence is a typed no-op error (no version churn)", async () => {
    const { service } = makeService();
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(telemetryInput());
    }
    await service.buildScorecard({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
    });
    await expect(
      service.buildScorecard({
        applicationId: APP,
        tenantId: TENANT,
        definitionId: "route-outcome-by-task-class",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("an empty scope cannot build a scorecard (evidence over claims)", async () => {
    const { service } = makeService();
    await expect(
      service.buildScorecard({
        applicationId: APP,
        tenantId: TENANT,
        definitionId: "route-outcome-by-task-class",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("M12: another tenant's scope sees nothing", async () => {
    const { service } = makeService();
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(telemetryInput());
    }
    const signals = await service.consultSignals({
      applicationId: APP,
      tenantId: OTHER_TENANT,
      definitionId: "route-outcome-by-task-class",
    });
    expect(signals).toEqual([]);
    await expect(
      service.buildScorecard({
        applicationId: APP,
        tenantId: OTHER_TENANT,
        definitionId: "route-outcome-by-task-class",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("subject-key filtering restricts consulted signals", async () => {
    const { service } = makeService();
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(
        telemetryInput({
          routes: [{ provider: "rail-a", model: "model-x" }],
        }),
      );
    }
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(
        telemetryInput({
          routes: [{ provider: "rail-b", model: "model-y" }],
        }),
      );
    }
    await service.buildScorecard({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
    });
    const signals = await service.consultSignals({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "route-outcome-by-task-class",
      subjectKeys: ["rail-b/model-y"],
    });
    expect(signals.map((signal) => signal.subjectKey)).toEqual(["rail-b/model-y"]);
  });
});

describe("learning service ratings", () => {
  function ratingInput(overrides: Partial<RecordRatingInput> = {}): RecordRatingInput {
    return {
      applicationId: APP,
      tenantId: TENANT,
      executionId: "00000000-0000-7000-9000-000000000001",
      evaluatorId: "user-7",
      ratingDimension: "overall-quality",
      rating: 4,
      provenance: { source: "user", submittedVia: "dashboard" },
      evidenceRefs: ["execution:00000000-0000-7000-9000-000000000001:receipt"],
      schemaVersion: 1,
      ...overrides,
    };
  }

  test("records a rating and converges identical resubmissions", async () => {
    const { service } = makeService();
    const first = await service.recordUserRating(ratingInput());
    expect(first.replayed).toBe(false);
    const retry = await service.recordUserRating(ratingInput());
    expect(retry.replayed).toBe(true);
    expect(retry.ratingId).toBe(first.ratingId);
  });

  test("a conflicting re-rating of the same identity fails closed", async () => {
    const { service } = makeService();
    await service.recordUserRating(ratingInput());
    await expect(service.recordUserRating(ratingInput({ rating: 2 }))).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  test("a different dimension is a different durable identity", async () => {
    const { service } = makeService();
    await service.recordUserRating(ratingInput());
    const other = await service.recordUserRating(ratingInput({ ratingDimension: "usefulness" }));
    expect(other.replayed).toBe(false);
    expect(other.ratingId).not.toBe("");
  });
});

describe("telemetry list scoping (the population read)", () => {
  test("the store returns only in-scope observations", async () => {
    const { service, store } = makeService();
    for (let index = 0; index < 6; index += 1) {
      await service.recordExecutionTelemetry(telemetryInput());
    }
    await service.recordExecutionTelemetry(telemetryInput({ tenantId: OTHER_TENANT }));
    const population = await store.listTelemetry({
      applicationId: APP,
      tenantId: TENANT,
      recordedFrom: null,
      recordedTo: "2999-01-01T00:00:00Z",
    });
    expect(population).toHaveLength(6);
    expect(population.every((datum: ExecutionOutcomeTelemetry) => datum.tenantId === TENANT)).toBe(
      true,
    );
  });
});
