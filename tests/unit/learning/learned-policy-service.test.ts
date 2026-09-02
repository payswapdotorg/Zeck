/**
 * Unit: the learned-policy lifecycle service (learning module
 * application; WORK-020 / LRN-002) over the in-memory stores.
 *
 * Proves the full observational lifecycle and its typed negative
 * guarantees:
 *
 *  - generation: versioned immutable artifacts with deterministic
 *    rollback metadata; same-basis retries CONVERGE (no version churn);
 *    a NEW population produces a NEW version; version arbitration
 *    converges on the durable winner;
 *  - shadow evaluation: revision-bound to the LATEST scorecard; retry
 *    convergence via content-derived identity;
 *  - canary evaluation: requires a durable CANARY publication of the
 *    EXACT version (fail closed) and a scorecard basis;
 *  - publication: the explicit evidence-gated step — canary requires a
 *    completed shadow, promoted requires shadow + canary; evidence is
 *    version-matched and status-qualified; replay converges;
 *  - rollback: publishes the PRIOR version verbatim (deterministic);
 *    history is never rewritten;
 *  - consultation: the ACTIVE publication projection, task-class
 *    filtered; unwired ⇒ null.
 */

import { describe, expect, test } from "vitest";
import {
  createInMemoryLearnedPolicyStore,
  createInMemoryLearningStore,
  createLearnedPolicyService,
  createLearnedPolicySource,
  createLearningService,
  createNodeDigest,
  type InMemoryLearnedPolicyStore,
  type LearnedPlanningPolicy,
  type LearnedPolicyEvaluation,
  type LearnedPolicyPublication,
  type LearnedPolicyService,
  type RecordTelemetryInput,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
const OTHER_APP_ID = "00000000-0000-7000-8000-0000000000f9";
const TENANT_ID = "00000000-0000-7000-8000-0000000000f2";

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `00000000-0000-7000-a000-${String(idCounter).padStart(12, "0")}`;
}

/** A fixed wall clock the tests can advance deterministically. */
function clock(startAt: number): () => Date {
  let tick = 0;
  return () => new Date(startAt + tick++ * 1000);
}

interface ServiceWorld {
  readonly service: LearnedPolicyService;
  readonly learnedStore: InMemoryLearnedPolicyStore;
  readonly learningStore: ReturnType<typeof createInMemoryLearningStore>;
  seedTelemetry(
    count: number,
    options?: {
      readonly route?: { provider: string; model: string };
      readonly failures?: number;
      readonly taskClass?: string;
    },
  ): Promise<void>;
}

function buildWorld(): ServiceWorld {
  const learningStore = createInMemoryLearningStore();
  const learnedStore = createInMemoryLearnedPolicyStore(learningStore);
  const service = createLearnedPolicyService({
    store: learnedStore,
    digest: createNodeDigest(),
    generateId,
    now: clock(Date.parse("2026-09-15T12:00:00Z")),
  });
  return {
    service,
    learnedStore,
    learningStore,
    async seedTelemetry(count, options = {}) {
      const route = options.route ?? { provider: "rail-a", model: "model-x" };
      const failures = options.failures ?? 0;
      for (let index = 0; index < count; index += 1) {
        const input: RecordTelemetryInput = {
          executionId: generateId(),
          applicationId: APP_ID,
          tenantId: TENANT_ID,
          taskClass: options.taskClass ?? "generation",
          capabilities: ["text-generation"],
          planId: "plan-1",
          planRevision: 1,
          strategyClass: "generative",
          routes: [route],
          tools: [],
          environments: [],
          verification: {
            resultIds: ["ver-1"],
            statuses: ["PASS"],
            evaluatorIds: ["deterministic:schema@1"],
            passCount: 1,
            failCount: 0,
            inconclusiveCount: 0,
            verified: true,
          },
          costMicroUsd: "1000",
          latencyMs: 2000,
          outcome: index < count - failures ? "execution-completed" : "execution-failed",
          evidenceRefs: [`execution:${index}:receipt`],
          subgraphs: [],
          schemaVersion: 1,
        };
        // The in-memory learning store ingests fully-shaped telemetry.
        await learningStore.ingestTelemetry(
          {
            telemetryId: generateId(),
            recordedAt: new Date(Date.parse("2026-09-15T11:00:00Z") + index * 1000).toISOString(),
            ...input,
          },
          `fingerprint-${index}`,
        );
      }
    },
  };
}

describe("learned-policy service: generation (versioned, deterministic)", () => {
  test("no telemetry population in scope fails closed (evidence over claims)", async () => {
    const world = buildWorld();
    await expect(
      world.service.generateLearnedPolicy({ applicationId: APP_ID, tenantId: TENANT_ID }),
    ).rejects.toThrow(PlatformError);
  });

  test("a population below the honest-evidence floor fails closed", async () => {
    const world = buildWorld();
    await world.seedTelemetry(3);
    await expect(
      world.service.generateLearnedPolicy({ applicationId: APP_ID, tenantId: TENANT_ID }),
    ).rejects.toThrow(/population floor/);
  });

  test("generation produces version 1 with the honest first-version rollback metadata", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const { policy, replayed } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(replayed).toBe(false);
    expect(policy.policyVersion).toBe(1);
    expect(policy.rollback).toEqual({
      rollbackToPolicyVersion: null,
      priorPolicyDigest: null,
      note: expect.stringContaining("first generated version"),
    });
    expect(policy.preferences).toHaveLength(1);
    expect(policy.preferences[0]?.ranked[0]?.subjectKey).toBe("rail-a/model-x");
    expect(policy.totalPopulation).toBe(8);
  });

  test("same-basis retries CONVERGE (no version churn, replayed: true)", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const first = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const retry = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(retry.replayed).toBe(true);
    expect(retry.policy.policyId).toBe(first.policy.policyId);
    expect(retry.policy.policyVersion).toBe(1);
    expect(world.learnedStore.policyCount()).toBe(1);
  });

  test("a NEW population produces version 2 whose rollback metadata names version 1 exactly", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const first = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    // New evidence: a second route with different outcomes.
    await world.seedTelemetry(6, { route: { provider: "rail-b", model: "model-y" } });
    const second = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(second.replayed).toBe(false);
    expect(second.policy.policyVersion).toBe(2);
    expect(second.policy.rollback.rollbackToPolicyVersion).toBe(1);
    expect(second.policy.rollback.priorPolicyDigest).toBe(first.policy.digest);
    expect(world.learnedStore.policyCount()).toBe(2);
    // The prior version is byte-identical history.
    const reread = await world.learnedStore.getLearnedPolicy(
      { applicationId: APP_ID, tenantId: TENANT_ID },
      first.policy.policyId,
    );
    expect(reread).toEqual(first.policy);
  });

  test("version arbitration: concurrent builders CONVERGE on one durable version", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    // Two service instances racing for version 1 over the shared store.
    // Whichever interleaving occurs (fingerprint replay OR the UNIQUE
    // version arbitration → IDEMPOTENCY_KEY_REUSED → re-read of the
    // durable winner), both callers hold the SAME policy and exactly
    // ONE version row exists.
    const serviceA = world.service;
    const serviceB = createLearnedPolicyService({
      store: world.learnedStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T12:00:00Z")),
    });
    const [left, right] = await Promise.all([
      serviceA.generateLearnedPolicy({ applicationId: APP_ID, tenantId: TENANT_ID }),
      serviceB.generateLearnedPolicy({ applicationId: APP_ID, tenantId: TENANT_ID }),
    ]);
    expect(new Set([left.policy.policyId, right.policy.policyId]).size).toBe(1);
    expect(left.policy.policyVersion).toBe(1);
    expect(right.policy.policyVersion).toBe(1);
    expect(left.replayed || right.replayed).toBe(true);
    expect(world.learnedStore.policyCount()).toBe(1);
  });

  test("a foreign application's population is invisible (tenant scope never dropped)", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    await expect(
      world.service.generateLearnedPolicy({ applicationId: OTHER_APP_ID, tenantId: TENANT_ID }),
    ).rejects.toThrow(/no telemetry population/i);
  });
});

describe("learned-policy service: shadow evaluation", () => {
  test("a shadow evaluation without a scorecard is honest insufficient-evidence", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const { evaluation, replayed } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    expect(replayed).toBe(false);
    expect(evaluation.status).toBe("insufficient-evidence");
    expect(evaluation.verdict).toBeNull();
    expect(evaluation.basis).toEqual({ kind: "none" });

    // Retry CONVERGES (content-derived identity).
    const retry = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    expect(retry.replayed).toBe(true);
    expect(retry.evaluation.evaluationId).toBe(evaluation.evaluationId);
    expect(world.learnedStore.evaluationCount()).toBe(1);
  });

  test("a shadow evaluation binds the EXACT latest scorecard version", async () => {
    const world = buildWorld();
    await world.seedTelemetry(10);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    const scorecard = await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const { evaluation } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    expect(evaluation.basis).toMatchObject({
      kind: "scorecard",
      scorecardId: scorecard.scorecardId,
      scorecardVersion: scorecard.scorecardVersion,
    });
  });

  test("an unknown policy id fails closed", async () => {
    const world = buildWorld();
    await expect(
      world.service.evaluateLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: "ghost-policy",
        evaluationClass: "shadow",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("learned-policy service: publication (the explicit gate)", () => {
  async function worldWithPolicy(): Promise<{
    readonly world: ServiceWorld;
    readonly policy: LearnedPlanningPolicy;
    readonly shadow: LearnedPolicyEvaluation;
  }> {
    const world = buildWorld();
    await world.seedTelemetry(12);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const { evaluation } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    return { world, policy, shadow: evaluation };
  }

  test("a canary publication REQUIRES a completed shadow evaluation of the exact version", async () => {
    const { world, policy } = await worldWithPolicy();
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [],
      }),
    ).rejects.toThrow(/explicit evaluation evidence/);

    // Evidence of a DIFFERENT policy version does not gate.
    const other: LearnedPolicyEvaluation = {
      ...((await (async () => {
        const ghost: LearnedPolicyEvaluation = {
          evaluationId: "eval-ghost",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion + 5,
          applicationId: APP_ID,
          tenantId: TENANT_ID,
          evaluationClass: "shadow",
          status: "insufficient-evidence",
          verdict: null,
          metrics: null,
          comparison: null,
          basis: { kind: "none" },
          canaryBinding: null,
          evidenceRefs: [],
          sourceExecutionIds: [],
          evaluatedAt: "2026-09-15T12:00:00Z",
          schemaVersion: 1,
        };
        return ghost;
      })()) as LearnedPolicyEvaluation),
    };
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: other.evaluationId }],
      }),
    ).rejects.toThrow(/does not exist/);
  });

  test("an insufficient-evidence evaluation never gates a publication", async () => {
    const { world, policy, shadow } = await worldWithPolicy();
    // The shadow evaluation above is insufficient-evidence (no scorecard).
    expect(shadow.status).toBe("insufficient-evidence");
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
      }),
    ).rejects.toThrow(/insufficient-evidence/);
  });

  test("the full explicit path: shadow → canary publication → canary evaluation → promoted", async () => {
    const { world, policy } = await worldWithPolicy();
    // Build a REAL scorecard so the shadow evaluation is evidence-bearing.
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const { evaluation: shadow } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    expect(shadow.status).not.toBe("insufficient-evidence");

    // Promoted WITHOUT a canary evaluation is rejected.
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "promoted",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
      }),
    ).rejects.toThrow(/BOTH a shadow and a canary/);

    // Canary publication (shadow evidence present).
    const canaryPublication = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadow.evaluationId }],
    });
    expect(canaryPublication.publicationMode).toBe("canary");

    // A canary evaluation binds the exact canary publication.
    const { evaluation: canary } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "canary",
    });
    expect(canary.evaluationClass).toBe("canary");
    expect(canary.canaryBinding?.publicationId).toBe(canaryPublication.publicationId);
    expect(canary.status).not.toBe("insufficient-evidence");

    // Promoted publication with BOTH evidence classes.
    const promoted = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "promoted",
      publishedBy: "operator-1",
      evaluationEvidence: [
        { evaluationId: shadow.evaluationId },
        { evaluationId: canary.evaluationId },
      ],
    });
    expect(promoted.publicationMode).toBe("promoted");
    expect(promoted.evaluationEvidence).toHaveLength(2);

    // The ACTIVE pointer is the promoted publication.
    const active = await world.service.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(active?.publication.publicationId).toBe(promoted.publicationId);
    expect(active?.publication.publicationMode).toBe("promoted");
    expect(active?.policy.policyId).toBe(policy.policyId);
  });

  test("a canary evaluation without a durable canary publication fails closed (no phantom canaries)", async () => {
    const { world, policy } = await worldWithPolicy();
    await expect(
      world.service.evaluateLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        evaluationClass: "canary",
      }),
    ).rejects.toThrow(/ran-in-canary/);
  });

  test("publication retries CONVERGE on the content-derived identity (journal append)", async () => {
    const { world, policy, shadow } = await worldWithPolicy();
    // Make the shadow evidence-bearing.
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const { evaluation } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    const first = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    const retry = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    expect(retry.publicationId).toBe(first.publicationId);
    const journal = await world.learnedStore.listLearnedPolicyPublications({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(journal).toHaveLength(1);
    expect(shadow).toBeDefined();
  });
});

describe("learned-policy service: rollback (deterministic)", () => {
  test("rollback publishes the PRIOR version verbatim; history stays byte-identical", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const first = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    // Publish v1 (needs evidence-bearing evaluations: scorecard first).
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const shadowV1 = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: first.policy.policyId,
      evaluationClass: "shadow",
    });
    const v1Canary = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: first.policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadowV1.evaluation.evaluationId }],
    });
    const canaryV1 = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: first.policy.policyId,
      evaluationClass: "canary",
    });
    const v1Promoted = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: first.policy.policyId,
      publicationMode: "promoted",
      publishedBy: "operator-1",
      evaluationEvidence: [
        { evaluationId: shadowV1.evaluation.evaluationId },
        { evaluationId: canaryV1.evaluation.evaluationId },
      ],
    });

    // New population → v2 → publish promoted.
    await world.seedTelemetry(6, { route: { provider: "rail-b", model: "model-y" } });
    const second = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const shadowV2 = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: second.policy.policyId,
      evaluationClass: "shadow",
    });
    const v2Canary = await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: second.policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: shadowV2.evaluation.evaluationId }],
    });
    const canaryV2 = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: second.policy.policyId,
      evaluationClass: "canary",
    });
    await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: second.policy.policyId,
      publicationMode: "promoted",
      publishedBy: "operator-1",
      evaluationEvidence: [
        { evaluationId: shadowV2.evaluation.evaluationId },
        { evaluationId: canaryV2.evaluation.evaluationId },
      ],
    });

    // ROLLBACK to v1: an ordinary journal append of v1's most recent
    // mode (promoted) with its evidence verbatim.
    const rollback = await world.service.rollbackLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      toPolicyId: first.policy.policyId,
      publishedBy: "operator-9",
    });
    expect(rollback.publicationReason).toBe("rollback");
    expect(rollback.policyId).toBe(first.policy.policyId);
    expect(rollback.policyVersion).toBe(first.policy.policyVersion);
    expect(rollback.publicationMode).toBe(v1Promoted.publicationMode);
    expect(rollback.evaluationEvidence).toEqual(v1Promoted.evaluationEvidence);
    expect(rollback.publicationId).not.toBe(v1Promoted.publicationId);
    expect(v2Canary).toBeDefined();

    // The ACTIVE pointer is the rollback entry (v1 promoted again).
    const active = await world.service.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(active?.publication.publicationId).toBe(rollback.publicationId);
    expect(active?.policy.policyVersion).toBe(1);

    // History is byte-identical: both versions, all prior entries.
    const journal = await world.learnedStore.listLearnedPolicyPublications({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(journal.map((entry) => entry.publicationReason)).toEqual([
      "initial",
      "initial",
      "initial",
      "initial",
      "rollback",
    ]);
    expect(journal[0]?.publicationId).toBe(v1Canary.publicationId);
    expect(journal[1]?.publicationId).toBe(v1Promoted.publicationId);
    expect(world.learnedStore.policyCount()).toBe(2);
    const v2After = await world.learnedStore.getLearnedPolicy(
      { applicationId: APP_ID, tenantId: TENANT_ID },
      second.policy.policyId,
    );
    expect(v2After).toEqual(second.policy);
  });

  test("rolling back to a version that was never published fails closed", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const first = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    await expect(
      world.service.rollbackLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        toPolicyId: first.policy.policyId,
        publishedBy: "operator-1",
      }),
    ).rejects.toThrow(/never published/);
  });

  test("an unknown rollback target fails closed", async () => {
    const world = buildWorld();
    await expect(
      world.service.rollbackLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        toPolicyId: "ghost-policy",
        publishedBy: "operator-1",
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("learned-policy service: consultation (the READ seam)", () => {
  test("no publication ⇒ null (an unpublished optimization influences nothing)", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(
      await world.service.consultLearnedPolicy({ applicationId: APP_ID, tenantId: TENANT_ID }),
    ).toBeNull();
  });

  test("the task-class projection filters preferences (honest absence, never a default)", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8, { taskClass: "generation" });
    await world.seedTelemetry(7, {
      taskClass: "summarize",
      route: { provider: "rail-b", model: "model-y" },
    });
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    // Publish (needs an evidence-bearing shadow evaluation).
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const { evaluation } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    const projection = await world.service.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      taskClass: "summarize",
    });
    expect(projection?.policy.preferences).toHaveLength(1);
    expect(projection?.policy.preferences[0]?.taskClass).toBe("summarize");
    expect(projection?.policy.preferences[0]?.ranked[0]?.subjectKey.startsWith("rail-b/")).toBe(
      true,
    );
    // A task class with no preference projects an EMPTY preference set.
    const absent = await world.service.consultLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      taskClass: "translation",
    });
    expect(absent?.policy.preferences).toEqual([]);
  });

  test("the learned-policy source adapter exposes consult ONLY (no mutation surface)", async () => {
    const world = buildWorld();
    const source = createLearnedPolicySource(world.service);
    expect(Object.keys(source)).toEqual(["consult"]);
    expect(await source.consult({ applicationId: APP_ID, tenantId: TENANT_ID })).toBeNull();
  });

  test("a foreign application's active publication is unreachable (scope)", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const learningService = createLearningService({
      store: world.learningStore,
      digest: createNodeDigest(),
      generateId,
      now: clock(Date.parse("2026-09-15T13:00:00Z")),
    });
    await learningService.buildScorecard({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      definitionId: "route-outcome-by-task-class",
    });
    const { evaluation } = await world.service.evaluateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      evaluationClass: "shadow",
    });
    await world.service.publishLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      policyId: policy.policyId,
      publicationMode: "canary",
      publishedBy: "operator-1",
      evaluationEvidence: [{ evaluationId: evaluation.evaluationId }],
    });
    expect(
      await world.service.consultLearnedPolicy({
        applicationId: OTHER_APP_ID,
        tenantId: TENANT_ID,
      }),
    ).toBeNull();
    expect(
      await world.learnedStore.getLearnedPolicy(
        { applicationId: OTHER_APP_ID, tenantId: TENANT_ID },
        policy.policyId,
      ),
    ).toBeNull();
  });

  test("scope validation: empty application/tenant ids fail closed", async () => {
    const world = buildWorld();
    await expect(
      world.service.generateLearnedPolicy({ applicationId: "", tenantId: TENANT_ID }),
    ).rejects.toThrow(PlatformError);
    await expect(
      world.service.consultLearnedPolicy({ applicationId: APP_ID, tenantId: "" }),
    ).rejects.toThrow(PlatformError);
  });
});

describe("learned-policy service: publication evidence verification (revision-bound)", () => {
  test("an evaluation of a DIFFERENT policy version cannot gate the publication", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    // Build an evaluation row for a DIFFERENT (foreign) policy+version,
    // seeded directly into the store.
    const foreign: LearnedPolicyEvaluation = {
      evaluationId: "eval-foreign-version",
      policyId: policy.policyId,
      policyVersion: policy.policyVersion + 1,
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      evaluationClass: "shadow",
      status: "inconclusive",
      verdict: "inconclusive",
      metrics: null,
      comparison: null,
      basis: {
        kind: "scorecard",
        scorecardId: "sc-1",
        scorecardVersion: 1,
        definitionId: "route-outcome-by-task-class",
        definitionVersion: 1,
        telemetrySchemaVersion: 1,
        populationWindowFrom: null,
        populationWindowTo: "2026-09-15T13:00:00Z",
      },
      canaryBinding: null,
      evidenceRefs: ["e-1"],
      sourceExecutionIds: ["exec-1"],
      evaluatedAt: "2026-09-15T13:00:00Z",
      schemaVersion: 1,
    };
    await world.learnedStore.insertLearnedPolicyEvaluation(foreign);
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: foreign.evaluationId }],
      }),
    ).rejects.toThrow(/EXACT policy version/);
  });

  test("publication requires a non-empty publishedBy actor", async () => {
    const world = buildWorld();
    await world.seedTelemetry(8);
    const { policy } = await world.service.generateLearnedPolicy({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: policy.policyId,
        publicationMode: "canary",
        publishedBy: "",
        evaluationEvidence: [{ evaluationId: "eval-x" }],
      }),
    ).rejects.toThrow(/publishedBy/);
  });

  test("an unknown policy id fails closed at publication", async () => {
    const world = buildWorld();
    await expect(
      world.service.publishLearnedPolicy({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        policyId: "ghost-policy",
        publicationMode: "canary",
        publishedBy: "operator-1",
        evaluationEvidence: [{ evaluationId: "eval-x" }],
      }),
    ).rejects.toThrow(/not found/);
  });
});

/** Compilation-only reference: the journal shape is the deployment state. */
function journalEntryShape(publication: LearnedPolicyPublication): LearnedPolicyPublication {
  return publication;
}
void journalEntryShape;
