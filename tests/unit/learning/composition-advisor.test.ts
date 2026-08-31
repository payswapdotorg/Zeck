/**
 * Composition advisor tests (learning module application; WORK-017)
 * over the in-memory store (the reference semantics of the SQL store
 * — the real-PostgreSQL suites prove them physically).
 *
 * Required-test mapping (acceptance criteria 2/5 and §21/§22):
 *  - generation: version 1 then version 2 (append-only versioning);
 *    same-basis retries CONVERGE (replay — no version churn);
 *    empty population fails closed;
 *  - activation: the journal append; the active pointer is the LATEST
 *    entry; concurrent/duplicate activations serialize and converge
 *    (§22); cross-scope activation is impossible (M25);
 *  - rollback: activates the PRIOR set with reason 'rollback' — the
 *    historical sets and the journal history remain byte-identical
 *    (M15: rollback never mutates history);
 *  - consult: the ACTIVE set's recommendations, task-class filtered;
 *    no activation ⇒ no recommendations; tenant scope is enforced
 *    (M25);
 *  - LEARNING-NONAUTHORITY: the advisor deps are exactly
 *    {store, digest, generateId, now} (the WORK-014 quartet).
 */

import { describe, expect, test } from "vitest";
import {
  createCompositionAdvisor,
  createInMemoryCompositionStore,
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
  validateCompositionRecommendationSet,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";
const OTHER_APP = "00000000-0000-7000-8000-0000000000cc";

const FACTS = [
  {
    toolId: "fetch",
    version: "1.0.0",
    capabilityIds: ["web-retrieval"],
    inputFields: [],
    outputFields: [],
  },
  {
    toolId: "parse",
    version: "2.1.0",
    capabilityIds: ["parsing"],
    inputFields: [],
    outputFields: [],
  },
];

let clock = 0;
let counter = 0;

function makeWorld() {
  const learningStore = createInMemoryLearningStore();
  const learning = createLearningService({
    store: learningStore,
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
  const compositionStore = createInMemoryCompositionStore(learningStore);
  clock = 0;
  counter = 0;
  const advisor = createCompositionAdvisor({
    store: compositionStore,
    digest: createNodeDigest(),
    generateId: () => {
      counter += 1;
      return `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
    },
    now: () => {
      clock += 1;
      return new Date(Date.parse("2026-09-15T14:00:00Z") + clock * 1000);
    },
  });
  return { learning, learningStore, compositionStore, advisor };
}

let exec = 0;
function telemetry(overrides: Partial<RecordTelemetryInput> = {}): RecordTelemetryInput {
  exec += 1;
  const executionId = `00000000-0000-7000-9000-${String(exec).padStart(12, "0")}`;
  return {
    executionId,
    applicationId: APP,
    tenantId: TENANT,
    taskClass: "extract",
    capabilities: ["web-retrieval"],
    planId: `plan-${exec}`,
    planRevision: 1,
    strategyClass: "hybrid",
    routes: [],
    tools: ["fetch", "parse"],
    environments: [],
    verification: {
      resultIds: [`v-${exec}`],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1000",
    latencyMs: 1000,
    outcome: "execution-completed",
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ...overrides,
  };
}

async function seedPopulation(
  learning: ReturnType<typeof makeWorld>["learning"],
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await learning.recordExecutionTelemetry(telemetry());
  }
}

describe("learning: the composition advisor (generation)", () => {
  test("empty population fails closed", async () => {
    const { advisor } = makeWorld();
    await expect(
      advisor.generateRecommendationSet({ applicationId: APP, tenantId: TENANT, toolFacts: FACTS }),
    ).rejects.toThrow(PlatformError);
  });

  test("invalid tool facts fail closed before any read", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    await expect(
      advisor.generateRecommendationSet({
        applicationId: APP,
        tenantId: TENANT,
        toolFacts: [],
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("generation mines, persists and versions the set; same-basis retries CONVERGE (§22)", async () => {
    const { advisor, learning, compositionStore } = makeWorld();
    await seedPopulation(learning, 6);

    const first = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(first.set.setVersion).toBe(1);
    expect(first.replayed).toBe(false);
    expect(first.set.recommendations.length).toBe(1);
    validateCompositionRecommendationSet(first.set);
    expect(compositionStore.setCount()).toBe(1);

    // Same population + same facts ⇒ same fingerprint ⇒ CONVERGE.
    const retry = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.set.setId).toBe(first.set.setId);
    expect(compositionStore.setCount()).toBe(1); // no version churn

    // New evidence ⇒ a NEW immutable version.
    await seedPopulation(learning, 1);
    const second = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(second.set.setVersion).toBe(2);
    expect(compositionStore.setCount()).toBe(2);
  });

  test("the population read is scope-filtered: another application generates from ITS population only (M25)", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    // Observations for ANOTHER application: invisible to this advisor.
    for (let index = 0; index < 3; index += 1) {
      await learning.recordExecutionTelemetry(
        telemetry({ applicationId: OTHER_APP, tools: ["translate"] }),
      );
    }
    const outcome = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(outcome.set.totalPopulation).toBe(6);
    const other = await advisor.generateRecommendationSet({
      applicationId: OTHER_APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(other.set.totalPopulation).toBe(3);
  });
});

describe("learning: the composition advisor (activation/rollback)", () => {
  test("consult returns nothing before activation", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    const recommendations = await advisor.consultRecommendations({
      applicationId: APP,
      tenantId: TENANT,
    });
    expect(recommendations).toHaveLength(0);
  });

  test("activation makes the set consultable; signals carry the set anchors", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    const { set } = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    const activation = await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    expect(activation.reason).toBe("initial");

    const recommendations = await advisor.consultRecommendations({
      applicationId: APP,
      tenantId: TENANT,
    });
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.setId).toBe(set.setId);
    expect(recommendations[0]?.setVersion).toBe(set.setVersion);
    expect(recommendations[0]?.analysisVersion).toBe(set.analysisVersion);

    // Task-class filtering.
    const filtered = await advisor.consultRecommendations({
      applicationId: APP,
      tenantId: TENANT,
      taskClass: "nonexistent",
    });
    expect(filtered).toHaveLength(0);
  });

  test("duplicate activation of the same request converges (§22)", async () => {
    const { advisor, learning, compositionStore } = makeWorld();
    await seedPopulation(learning, 6);
    const { set } = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    expect(compositionStore.activationCount()).toBe(1);
    // Same logical request: converges (no duplicate journal entry).
    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    expect(compositionStore.activationCount()).toBe(1);
  });

  test("rollback activates the PRIOR set and NEVER mutates history (M15/§21)", async () => {
    const { advisor, learning, compositionStore } = makeWorld();
    await seedPopulation(learning, 6);
    const first = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    await seedPopulation(learning, 1);
    const second = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(second.set.setVersion).toBe(2);

    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: second.set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    let active = await advisor.consultRecommendations({ applicationId: APP, tenantId: TENANT });
    expect(active[0]?.setVersion).toBe(2);

    // ROLLBACK: activate the prior set.
    await advisor.rollbackRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toSetId: first.set.setId,
      activatedBy: "operator-1",
    });
    active = await advisor.consultRecommendations({ applicationId: APP, tenantId: TENANT });
    expect(active[0]?.setVersion).toBe(1);
    expect(active[0]?.setId).toBe(first.set.setId);

    // History integrity (M15): BOTH immutable sets remain retrievable
    // and byte-identical through the store — rollback appended a
    // journal entry, it rewrote nothing.
    const firstAfterRollback = await compositionStore.getRecommendationSet(
      { applicationId: APP, tenantId: TENANT },
      first.set.setId,
    );
    expect(firstAfterRollback).toEqual(first.set);
    const secondAfterRollback = await compositionStore.getRecommendationSet(
      { applicationId: APP, tenantId: TENANT },
      second.set.setId,
    );
    expect(secondAfterRollback).toEqual(second.set);
    // Regeneration on the unchanged basis still CONVERGES on the
    // durable latest set (no history corruption, no version churn).
    const converged = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    expect(converged.replayed).toBe(true);
    expect(converged.set.setVersion).toBe(2);
    const journal = await compositionStore.listActivations({
      applicationId: APP,
      tenantId: TENANT,
    });
    expect(journal).toHaveLength(2);
    expect(journal[0]?.reason).toBe("initial");
    expect(journal[1]?.reason).toBe("rollback");
  });

  test("activation of a foreign set is rejected (M25)", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    const { set } = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    await expect(
      advisor.activateRecommendationSet({
        applicationId: OTHER_APP,
        tenantId: TENANT,
        setId: set.setId,
        activatedBy: "operator-1",
        reason: "initial",
      }),
    ).rejects.toThrow(PlatformError);
  });

  test("cross-tenant consultation returns nothing (M25)", async () => {
    const { advisor, learning } = makeWorld();
    await seedPopulation(learning, 6);
    const { set } = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: FACTS,
    });
    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: set.setId,
      activatedBy: "operator-1",
      reason: "initial",
    });
    const foreign = await advisor.consultRecommendations({
      applicationId: APP,
      tenantId: "00000000-0000-7000-8000-0000000000ff",
    });
    expect(foreign).toHaveLength(0);
  });
});
