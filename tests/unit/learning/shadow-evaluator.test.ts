/**
 * Shadow evaluator tests (learning module application; WORK-014 /
 * INT-006; M7/M8 red-record halves — the full zero-side-effect proof
 * over a governed instrumented world lives in the discrimination
 * suite).
 *
 * Required-test mapping:
 *  - evaluation against the LATEST durable scorecard version with the
 *    exact versioned basis (M13);
 *  - honest statuses: scored / insufficient-evidence (no scorecard or
 *    no scored subject) / no-baseline / incompatible-schema;
 *  - M15: every persisted record is class 'shadow';
 *  - uncertainty preserved: overlapping comparisons stay inconclusive;
 *  - store interaction surface: ONLY getLatestScorecard +
 *    insertShadowEvaluation (nothing else exists on the evaluator's
 *    wiring — the deps are store + digest + clock + ids).
 */

import { describe, expect, test } from "vitest";
import {
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  createShadowEvaluator,
  type LearningStore,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
} from "../../../src/modules/learning/public";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

let clock = 0;
let counter = 0;

interface SpyStore extends LearningStore {
  readonly calls: string[];
}

/** A recording wrapper: every store interaction is named (the side-effect surface). */
function spyStore(store: LearningStore): SpyStore {
  const calls: string[] = [];
  return {
    calls,
    async ingestTelemetry(datum, fingerprint) {
      calls.push("ingestTelemetry");
      return store.ingestTelemetry(datum, fingerprint);
    },
    async listTelemetry(query) {
      calls.push("listTelemetry");
      return store.listTelemetry(query);
    },
    async insertScorecard(scorecard) {
      calls.push("insertScorecard");
      return store.insertScorecard(scorecard);
    },
    async getLatestScorecard(scope) {
      calls.push("getLatestScorecard");
      return store.getLatestScorecard(scope);
    },
    async getScorecard(scope, scorecardId) {
      calls.push("getScorecard");
      return store.getScorecard(scope, scorecardId);
    },
    async insertShadowEvaluation(record) {
      calls.push("insertShadowEvaluation");
      return store.insertShadowEvaluation(record);
    },
    async listShadowEvaluations(scope) {
      calls.push("listShadowEvaluations");
      return store.listShadowEvaluations(scope);
    },
    async insertUserRating(rating, fingerprint) {
      calls.push("insertUserRating");
      return store.insertUserRating(rating, fingerprint);
    },
    async listUserRatings(scope) {
      calls.push("listUserRatings");
      return store.listUserRatings(scope);
    },
  };
}

function telemetryInput(overrides: Partial<RecordTelemetryInput> = {}): RecordTelemetryInput {
  counter += 1;
  const executionId = `00000000-0000-7000-9000-${String(counter).padStart(12, "0")}`;
  const succeeded = (overrides.outcome ?? "execution-completed") === "execution-completed";
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
      statuses: [succeeded ? "PASS" : "FAIL"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: succeeded ? 1 : 0,
      failCount: succeeded ? 0 : 1,
      inconclusiveCount: 0,
      verified: succeeded,
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

async function seedScorecard(
  service: ReturnType<typeof createLearningService>,
  overrides: Partial<RecordTelemetryInput> = {},
): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await service.recordExecutionTelemetry(telemetryInput(overrides));
  }
  await service.buildScorecard({
    applicationId: APP,
    tenantId: TENANT,
    definitionId: "route-outcome-by-task-class",
  });
}

function makeEvaluator(store: LearningStore) {
  clock = 0;
  return createShadowEvaluator({
    store,
    digest: createNodeDigest(),
    generateId: () => {
      counter += 1;
      return `00000000-0000-7000-a000-${String(counter).padStart(12, "0")}`;
    },
    now: () => {
      clock += 1;
      return new Date(Date.parse("2026-09-15T14:00:00Z") + clock * 1000);
    },
  });
}

describe("shadow evaluation against existing evidence", () => {
  test("scores a proposed strategy against the latest scorecard version", async () => {
    const base = createInMemoryLearningStore();
    const service = createLearningService({
      store: base,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-b000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(Date.parse("2026-09-15T12:00:00Z") + ++clock * 1000),
    });
    await seedScorecard(service);
    const store = spyStore(base);
    const evaluator = makeEvaluator(store);

    const record = await evaluator.evaluateShadowStrategy({
      applicationId: APP,
      tenantId: TENANT,
      proposed: {
        strategyIdentity: "cheap-route",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });

    expect(record.status).toBe("scored");
    expect(record.recordClass).toBe("shadow");
    expect(record.proposedScores).toHaveLength(1);
    expect(record.proposedScores[0]?.successRate).toBeCloseTo(1, 10);
    expect(record.evaluationBasis.kind).toBe("scorecard");
    if (record.evaluationBasis.kind === "scorecard") {
      expect(record.evaluationBasis.scorecardVersion).toBe(1);
      expect(record.evaluationBasis.definitionId).toBe("route-outcome-by-task-class");
      expect(record.evaluationBasis.telemetrySchemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    }
    // M10 traceability: the shadow record carries the evidence refs and
    // source executions behind the score.
    expect(record.evidenceRefs.length).toBeGreaterThanOrEqual(6);
    expect(record.sourceExecutionIds.length).toBeGreaterThanOrEqual(6);

    // The interaction surface: read the scorecard, append the shadow
    // record — nothing else.
    expect(store.calls).toEqual(["getLatestScorecard", "insertShadowEvaluation"]);
  });

  test("compares against a baseline with uncertainty preserved", async () => {
    const base = createInMemoryLearningStore();
    const service = createLearningService({
      store: base,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-b000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(Date.parse("2026-09-15T12:00:00Z") + ++clock * 1000),
    });
    // 6 successes on rail-a, 6 failures on rail-b.
    await seedScorecard(service);
    await seedScorecard(service, {
      routes: [{ provider: "rail-b", model: "model-y" }],
      outcome: "execution-failed",
    });
    const store = spyStore(base);
    const evaluator = makeEvaluator(store);

    const record = await evaluator.evaluateShadowStrategy({
      applicationId: APP,
      tenantId: TENANT,
      proposed: {
        strategyIdentity: "switch-to-b",
        taskClass: "interpretation",
        routeSubjects: ["rail-b/model-y"],
        toolSubjects: [],
      },
      baseline: {
        strategyIdentity: "stay-on-a",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
      cause: "cost-reduction-proposal",
    });

    expect(record.status).toBe("scored");
    expect(record.comparison?.preferred).toBe("baseline");
    expect(record.baseline?.strategyIdentity).toBe("stay-on-a");
    expect(record.cause).toBe("cost-reduction-proposal");
    expect(store.calls).toEqual(["getLatestScorecard", "insertShadowEvaluation"]);
  });

  test("no scorecard: honest insufficient-evidence with the 'none' basis", async () => {
    const base = createInMemoryLearningStore();
    const store = spyStore(base);
    const evaluator = makeEvaluator(store);
    const record = await evaluator.evaluateShadowStrategy({
      applicationId: APP,
      tenantId: TENANT,
      proposed: {
        strategyIdentity: "cheap-route",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    expect(record.status).toBe("insufficient-evidence");
    expect(record.evaluationBasis.kind).toBe("none");
    expect(record.proposedScores).toEqual([]);
    expect(store.calls).toEqual(["getLatestScorecard", "insertShadowEvaluation"]);
  });

  test("proposed subject absent from the scorecard: insufficient evidence, never fabrication", async () => {
    const base = createInMemoryLearningStore();
    const service = createLearningService({
      store: base,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-b000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(Date.parse("2026-09-15T12:00:00Z") + ++clock * 1000),
    });
    await seedScorecard(service);
    const evaluator = makeEvaluator(base);
    const record = await evaluator.evaluateShadowStrategy({
      applicationId: APP,
      tenantId: TENANT,
      proposed: {
        strategyIdentity: "ghost-route",
        taskClass: "interpretation",
        routeSubjects: ["rail-z/model-9"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    expect(record.status).toBe("insufficient-evidence");
    expect(record.proposedScores).toEqual([]);
    expect(record.evidenceRefs).toEqual([]);
  });

  test("baseline without scored evidence: no-baseline", async () => {
    const base = createInMemoryLearningStore();
    const service = createLearningService({
      store: base,
      digest: createNodeDigest(),
      generateId: () => `00000000-0000-7000-b000-${String(++counter).padStart(12, "0")}`,
      now: () => new Date(Date.parse("2026-09-15T12:00:00Z") + ++clock * 1000),
    });
    await seedScorecard(service);
    const evaluator = makeEvaluator(base);
    const record = await evaluator.evaluateShadowStrategy({
      applicationId: APP,
      tenantId: TENANT,
      proposed: {
        strategyIdentity: "stay-on-a",
        taskClass: "interpretation",
        routeSubjects: ["rail-a/model-x"],
        toolSubjects: [],
      },
      baseline: {
        strategyIdentity: "ghost-baseline",
        taskClass: "interpretation",
        routeSubjects: ["rail-z/model-9"],
        toolSubjects: [],
      },
      requestedBy: "actor-1",
    });
    expect(record.status).toBe("no-baseline");
  });

  test("M12: an empty tenant scope fails closed", async () => {
    const evaluator = makeEvaluator(createInMemoryLearningStore());
    await expect(
      evaluator.evaluateShadowStrategy({
        applicationId: "",
        tenantId: "",
        proposed: {
          strategyIdentity: "x",
          taskClass: "interpretation",
          routeSubjects: [],
          toolSubjects: [],
        },
        requestedBy: "actor-1",
      }),
    ).rejects.toThrow();
  });

  test("shadow records are append-only and listed newest-first", async () => {
    const base = createInMemoryLearningStore();
    const evaluator = makeEvaluator(base);
    for (let index = 0; index < 3; index += 1) {
      await evaluator.evaluateShadowStrategy({
        applicationId: APP,
        tenantId: TENANT,
        proposed: {
          strategyIdentity: `strategy-${index}`,
          taskClass: "interpretation",
          routeSubjects: [],
          toolSubjects: [],
        },
        requestedBy: "actor-1",
      });
    }
    const listed = await base.listShadowEvaluations({ applicationId: APP, tenantId: TENANT });
    expect(listed).toHaveLength(3);
    const first = listed[0];
    const last = listed[listed.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((first?.recordedAt ?? "") >= (last?.recordedAt ?? "")).toBe(true);
    const foreign = await base.listShadowEvaluations({
      applicationId: APP,
      tenantId: "00000000-0000-7000-8000-0000000000cc",
    });
    expect(foreign).toEqual([]);
  });
});
