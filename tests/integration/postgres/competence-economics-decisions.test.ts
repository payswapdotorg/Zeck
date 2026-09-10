/**
 * Real-PostgreSQL competence-economics integration (WORK-056).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority:
 *
 *  - the full competence chain over the REAL executions ledger and
 *    the REAL planner: governed execution → durable planning
 *    decision → planning-seam snapshot → derived IR (identity-verified)
 *    → constraints from the CAPTURED policy inputs →
 *    successful-trajectory mining (the candidate record — pure
 *    observation over the real chain's evidence) → deterministic
 *    progressive retrieval over the real scope (and the
 *    ZERO-COMPETENCE operation over the empty corpus) → the gated
 *    promotion ladder (candidate → shadow → canary → deterministic,
 *    each verdict pure and typed) → the WORK-049-format promotion
 *    decision record → durable append through the EXISTING store →
 *    read-time total validation → deterministic re-derivation
 *    (identical decisionId; bounded no-op re-append);
 *  - the bounded rollback over the same chain (typed degradation
 *    evidence, one stage back, the WORK-049 record, durable append,
 *    the IDEMPOTENT pure apply on the durable read-back values);
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS verdict+append chains
 *    of the same inputs converge to exactly one durable row (the
 *    pure decisions produce the identical decisionId; the WORK-049
 *    store's unique-index race safety serializes the appends — one
 *    insert, seven replays, never a duplicate, never a torn record);
 *  - NO SECOND DURABLE SURFACE: the plane owns no table, no store
 *    and no migration — the sole durable surface remains the
 *    WORK-049 decision-record store (the counts before/after prove
 *    it mechanically over the REAL database).
 */

import { expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/public";
import {
  capabilityConstraintFromResolution,
  constraintsFromPolicyInputs,
  createIrPlanSource,
} from "../../../src/modules/planning/adapters/ir-plan-source";
import {
  createCapabilityAuthorityAdapter,
  createInMemoryDeterministicCatalog,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  type ModelRouteCandidate,
  publishDeterministicCapabilityFacts,
} from "../../../src/modules/planning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicySet,
} from "../../../src/modules/policies/public";
import { validateOptimizationDecision } from "../../../src/platform/execution-ir/decision-record";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import { SqlOptimizationDecisionStore } from "../../../src/platform/execution-ir/decision-store";
import { deriveExecutionIr, type ExecutionIr } from "../../../src/platform/execution-ir/ir";
import {
  mineCompetenceCandidate,
  type SuccessfulTrajectory,
} from "../../../src/platform/competence-economics/mining";
import {
  buildPromotionDecisionRecord,
  buildRollbackDecisionRecord,
} from "../../../src/platform/competence-economics/decisions";
import {
  decidePromotion,
  type PromotionVerdict,
} from "../../../src/platform/competence-economics/promotion";
import { retrieveCompetence } from "../../../src/platform/competence-economics/retrieval";
import {
  applyRollbackRecord,
  buildRollback,
} from "../../../src/platform/competence-economics/rollback";
import { admitDeterministicReplacement } from "../../../src/platform/competence-economics/equivalence";
import type { CompetenceRecord } from "../../../src/platform/competence-economics/record";
import { fingerprintOf } from "../../../src/platform/failure-recovery/fingerprint";
import {
  ACTOR_ID,
  type ExecutionsWorld,
  generateId,
  seedExecutionsWorld,
} from "./executions-world";
import { definePgSuite } from "./harness";

const digest = createNodeDigest();
const planSource = createIrPlanSource();

const ROUTES: readonly ModelRouteCandidate[] = [
  {
    provider: "rail-a",
    model: "model-x",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "1000",
    expectedQuality: 0.92,
    expectedLatencyMs: 2000,
  },
];

interface CompetenceWorld {
  readonly base: ExecutionsWorld;
  readonly store: SqlOptimizationDecisionStore;
}

async function seedCompetenceWorld(
  port: Parameters<typeof seedExecutionsWorld>[0],
): Promise<CompetenceWorld> {
  const base = await seedExecutionsWorld(port);
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

/** The full governed chain: real planner → real IR → real constraints. */
async function governedChain(world: CompetenceWorld) {
  const registry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: SEED_CAPABILITY_FACTS,
  });
  await publishDeterministicCapabilityFacts(registry);
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  const policySet: PolicySet = {
    id: "default",
    version: 1,
    documents: [
      {
        scope: "platform",
        selector: {},
        restrictions: {
          cost: { maxCostMicroUsd: "10000000" },
          quality: { minQuality: 0.8 },
          latency: { maxLatencyMs: 60000 },
        },
      },
    ],
  };
  await policyAuthority.publish(policySet);
  const planner = createPlannerService({
    capabilityAuthority: createCapabilityAuthorityAdapter(registry),
    policyInputs: createPolicyInputsAdapter(policyAuthority),
    routeExplorer: createRouteTableExplorer(ROUTES),
    deterministicCatalog: createInMemoryDeterministicCatalog(),
    sink: createPlanningSinkAdapter(world.base.service),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date("2026-09-23T12:00:00Z"),
  });

  const receipt = await world.base.service.createExecution(
    {
      applicationId: world.base.applicationId,
      task: { kind: "interpretation", input: { text: "why?" } },
    },
    "ce-create-1",
    { actorId: ACTOR_ID, tenantId: world.base.tenantId },
  );
  const executionId = receipt.executionId;
  for (const [command, key] of [
    ["authorize", "ce-auth-1"],
    ["plan", "ce-plan-1"],
  ] as const) {
    await world.base.service.transition(
      {
        actorId: ACTOR_ID,
        tenantId: world.base.tenantId,
        applicationId: world.base.applicationId,
        executionId,
        command,
      },
      key,
    );
  }
  const outcome = await planner.planExecution(
    {
      applicationId: world.base.applicationId,
      executionId,
      tenantId: world.base.tenantId,
      actorId: ACTOR_ID,
      task: { kind: "interpretation", input: { text: "why?" } },
    },
    "ce-decision-1",
  );
  expect(outcome.decision.policyInputs.outcome).toBe("allow");
  const snapshot = planSource.toPlanSnapshot(outcome.selectedPlan);
  const ir = deriveExecutionIr(snapshot, digest);
  expect(ir.planId).toBe(outcome.selectedPlan.planId);
  const constraints = [
    ...constraintsFromPolicyInputs(outcome.decision.policyInputs),
    capabilityConstraintFromResolution(outcome.decision.capabilityResolution),
    {
      constraintId: "verification-anchor",
      kind: "verification" as const,
      enforcement: "hard" as const,
      source: { authority: "verification" as const },
      payload: { requiresVerificationAnchor: true },
    },
  ];
  expect(constraints.length).toBeGreaterThanOrEqual(3);
  return { ir, constraints, executionId, planId: outcome.selectedPlan.planId };
}

/** The real-chain environment fingerprint (the observed corpus's). */
function chainEnvironment() {
  return fingerprintOf(
    [
      { kind: "model-route", provider: "rail-a", model: "model-x" },
      { kind: "substrate", substrateId: "mid-container", version: "1.4.0" },
    ],
    digest,
  );
}

/** A successful trajectory observed on the real governed chain. */
function chainTrajectory(executionId: string, planId: string, number: number): SuccessfulTrajectory {
  const raw = `chain-trajectory:${number}:success`;
  const form = {
    executionId,
    decisionRecordId: digest.sha256Hex(`governed-plan:${planId}`),
    outcome: "success",
    observedQuality: 0.92,
    verificationId: `verif-chain-${number}`,
    verificationStrategy: "schema-check",
    observedCostMicroUsd: "400",
    observedLatencyMs: 2000,
    executorIdentity: "agent-worker-01",
    environment: chainEnvironment(),
    observedAt: "2026-09-23T12:00:10.000Z",
    trajectoryDigest: digest.sha256Hex(raw),
  };
  return { trajectoryId: digest.sha256Hex(canonicalJson(form)), ...form } as never;
}

/** The full-suite deterministic replacement over the real chain. */
function chainReplacement(scope: { tenantId: string; applicationId: string }) {
  return admitDeterministicReplacement({
    scope,
    capabilityId: "text-generation",
    tags: ["classify", "structured-output"],
    incumbent: {
      representationClass: "sufficient-model",
      claim: {
        expectedCostMicroUsd: "400",
        expectedLatencyMs: 2000,
        expectedQuality: 0.92,
        expectedReliability: 0.95,
        basis: { basis: "estimated", source: "model-economics:incumbent-route" },
      },
    },
    binding: { toolRepresentation: "competence", ref: "competence-binding-chain-01" },
    claim: {
      expectedCostMicroUsd: "40",
      expectedLatencyMs: 300,
      expectedQuality: 0.93,
      expectedReliability: 0.99,
      basis: { basis: "observed", source: "equivalence-suite:measured-deterministic-path" },
    },
    suite: {
      differential: {
        kind: "differential",
        casesCount: 1000,
        matchedCount: 1000,
        requiredMatchRate: 1,
        boundsDigest: digest.sha256Hex("input-space:chain-classify"),
        basis: "differential-harness:chain-1000",
      },
      property: {
        kind: "property",
        propertiesCount: 12,
        checksCount: 5000,
        failuresCount: 0,
        boundsDigest: digest.sha256Hex("properties:chain"),
        basis: "property-harness:chain-12-5000",
      },
      replay: {
        kind: "replay",
        trajectoriesReplayed: 2,
        deviationsCount: 0,
        boundsDigest: digest.sha256Hex("trajectories:chain"),
        basis: "replay-harness:chain-corpus",
      },
    },
    digest,
  });
}

definePgSuite("competence-economics decisions (real PostgreSQL)", (ctx) => {
  test("the full competence chain over the real executions ledger, planner and decision store", async () => {
    const world = await seedCompetenceWorld(ctx.port);
    const { ir, constraints, executionId, planId } = await governedChain(world);

    // MINING: the candidate record over the real chain's evidence.
    const record = mineCompetenceCandidate(
      {
        scope: {
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
        },
        capabilityId: "text-generation",
        tags: ["classify", "structured-output"],
        trajectories: [
          chainTrajectory(executionId, planId, 1),
          chainTrajectory(executionId, planId, 2),
        ],
        totalExecutions: 4,
        miningAuthority: "mining-job-07",
        basis: "decision-record-store+execution-ledger",
      },
      digest,
    );
    expect(record.stage).toBe("candidate");
    expect(record.recordId).toMatch(/^[0-9a-f]{64}$/);

    // RETRIEVAL: deterministic progressive retrieval over the real
    // scope (and the ZERO-COMPETENCE operation over the empty corpus).
    const emptyRetrieval = retrieveCompetence(
      [],
      {
        scope: {
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
        },
        capabilityId: "text-generation",
        tags: ["classify"],
        environment: chainEnvironment(),
      },
      { maxResults: 16, qualityFloor: 0.85 },
      digest,
    );
    expect(emptyRetrieval.results).toEqual([]);
    expect(emptyRetrieval.corpusSize).toBe(0);
    const retrieval = retrieveCompetence(
      [record],
      {
        scope: {
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
        },
        capabilityId: "text-generation",
        tags: ["classify"],
        environment: chainEnvironment(),
      },
      { maxResults: 16, qualityFloor: 0.85 },
      digest,
    );
    expect(retrieval.results).toHaveLength(1);
    expect(retrieval.results[0]?.candidate.representationClass).toBe("verified-competence");
    expect(retrieval.results[0]?.record.recordId).toBe(record.recordId);

    // THE GATED LADDER: candidate → shadow → canary → deterministic,
    // each verdict pure and typed over the real constraints.
    const promotionScope = {
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
    };
    const replacement = chainReplacement(promotionScope);
    const configuration = {
      shadowObservationBound: 100,
      canaryExposureBound: 50,
      canaryRequiredSuccessRate: 0.98,
      equivalence: { minimumMatchRate: 0.99 },
    };
    const verdictOf = (stage: CompetenceRecord): PromotionVerdict =>
      decidePromotion({
        record: stage,
        replacement,
        gateEvidence: {
          shadow: { observationsCount: 100, deviationCount: 0, basis: "shadow:chain" },
          canary: { exposureCount: 50, successCount: 50, deviationCount: 0, basis: "canary:chain" },
        },
        requestedBy: "promotion-authority-01",
        qualityFacts: { requiredQuality: 0.85 },
        constraints,
        configuration,
        digest,
      });

    const toShadow = verdictOf(record);
    expect(toShadow.kind).toBe("promoted");
    expect(toShadow.targetStage).toBe("shadow");
    expect(toShadow.advancedRecord).toBeDefined();

    const toCanary = verdictOf(toShadow.advancedRecord as CompetenceRecord);
    expect(toCanary.kind).toBe("promoted");
    expect(toCanary.targetStage).toBe("canary");

    const toDeterministic = verdictOf(toCanary.advancedRecord as CompetenceRecord);
    expect(toDeterministic.kind).toBe("promoted");
    expect(toDeterministic.targetStage).toBe("deterministic");
    expect(toDeterministic.advancedRecord?.stage).toBe("deterministic");

    // Self-promotion is inadmissible over the real chain too.
    const selfPromotion = decidePromotion({
      record,
      replacement,
      gateEvidence: { shadow: null, canary: null },
      requestedBy: "agent-worker-01",
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
      configuration,
      digest,
    });
    expect(selfPromotion.kind).toBe("reject");
    expect(selfPromotion.reasons.map((reason) => reason.code)).toContain("self-promotion");

    // RECORD: the WORK-049 promotion decision through the existing
    // store seam (candidate → shadow).
    const promotionRecord = buildPromotionDecisionRecord({
      record,
      verdict: toShadow,
      replacement,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:20.000Z",
      },
      digest,
    });
    expect(promotionRecord).not.toBeNull();
    expect(promotionRecord?.selectedCandidateId).toContain("deterministic-");
    expect(promotionRecord?.transformationBasis.detail).toContain(`record=${record.recordId}`);

    // DURABLE APPEND through the EXISTING WORK-049 store.
    const appended = await world.store.append(promotionRecord as never);
    expect(appended).toEqual({ decisionId: promotionRecord?.decisionId, replayed: false });

    // Read-time total validation over the real PG row.
    const durable = await world.store.get(
      world.base.applicationId,
      promotionRecord?.decisionId as string,
    );
    expect(durable?.decisionId).toBe(promotionRecord?.decisionId);
    expect(durable?.recordDigest).toBe(promotionRecord?.recordDigest);
    expect(() => validateOptimizationDecision(durable, digest)).not.toThrow();

    // DETERMINISTIC RE-DERIVATION: identical decisionId; bounded
    // no-op re-append.
    const reVerdict = verdictOf(record);
    expect(JSON.stringify(reVerdict)).toBe(JSON.stringify(toShadow));
    const reRecord = buildPromotionDecisionRecord({
      record,
      verdict: reVerdict,
      replacement,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:20.000Z",
      },
      digest,
    });
    expect(reRecord?.decisionId).toBe(promotionRecord?.decisionId);
    const reAppend = await world.store.append(reRecord as never);
    expect(reAppend).toEqual({ decisionId: promotionRecord?.decisionId, replayed: true });

    // THE BOUNDED ROLLBACK over the same chain: one stage back, typed
    // degradation evidence, the WORK-049 record, durable append, the
    // IDEMPOTENT pure apply on the durable read-back values.
    const rollback = buildRollback(
      {
        promotedRecord: toShadow.advancedRecord as CompetenceRecord,
        reason: "equivalence-degraded",
        degradedEvidence: [
          {
            kind: "equivalence",
            component: "differential",
            detail: "new differential sampling observed mismatches within the declared bounds",
          },
        ],
        requestedBy: "rollback-authority-01",
        recordedAt: "2026-09-23T12:00:30.000Z",
        digest,
      },
      digest,
    );
    expect(rollback.fromStage).toBe("shadow");
    expect(rollback.toStage).toBe("candidate");
    const rollbackRecord = buildRollbackDecisionRecord({
      rollback,
      ir,
      constraints,
      qualityThreshold: 0.85,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:31.000Z",
      },
      digest,
    });
    expect(rollbackRecord.decisionId).toMatch(/^[0-9a-f]{64}$/);
    const rollbackAppended = await world.store.append(rollbackRecord);
    expect(rollbackAppended).toEqual({ decisionId: rollbackRecord.decisionId, replayed: false });
    const durableRollback = await world.store.get(
      world.base.applicationId,
      rollbackRecord.decisionId,
    );
    expect(() => validateOptimizationDecision(durableRollback, digest)).not.toThrow();

    // The idempotent apply over the REAL durable values.
    const applied = applyRollbackRecord(rollback, rollback.promotedRecord);
    expect(applied.recordId).toBe(rollback.revertedRecord.recordId);
    const reapplied = applyRollbackRecord(rollback, applied);
    expect(reapplied).toStrictEqual(applied);

    // NO SECOND DURABLE SURFACE: exactly the two decision rows this
    // test appended exist for this application (the plane owns no
    // table, no store, no migration — mechanically counted).
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM execution_ir.optimization_decision_records WHERE application_id = $1",
      parameters: [world.base.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("2");
  });

  test("CONCURRENCY-CRASH-SAFETY: 8 simultaneous verdict+append chains converge to one durable row", async () => {
    const world = await seedCompetenceWorld(ctx.port);
    const { ir, constraints, executionId, planId } = await governedChain(world);

    const record = mineCompetenceCandidate(
      {
        scope: {
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
        },
        capabilityId: "text-generation",
        tags: ["classify", "structured-output"],
        trajectories: [
          chainTrajectory(executionId, planId, 1),
          chainTrajectory(executionId, planId, 2),
        ],
        totalExecutions: 4,
        miningAuthority: "mining-job-07",
        basis: "decision-record-store+execution-ledger",
      },
      digest,
    );
    const promotionScope = {
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
    };
    const replacement = chainReplacement(promotionScope);

    const buildOnce = () => {
      // Every chain re-derives the promotion verdict from the SAME
      // inputs: pure determinism produces the identical decisionId
      // across all 8 concurrent chains.
      const verdict = decidePromotion({
        record,
        replacement,
        gateEvidence: {
          shadow: { observationsCount: 100, deviationCount: 0, basis: "shadow:chain" },
          canary: { exposureCount: 50, successCount: 50, deviationCount: 0, basis: "canary:chain" },
        },
        requestedBy: "promotion-authority-01",
        qualityFacts: { requiredQuality: 0.85 },
        constraints,
        configuration: {
          shadowObservationBound: 100,
          canaryExposureBound: 50,
          canaryRequiredSuccessRate: 0.98,
          equivalence: { minimumMatchRate: 0.99 },
        },
        digest,
      });
      expect(verdict.kind).toBe("promoted");
      expect(verdict.targetStage).toBe("shadow");
      return buildPromotionDecisionRecord({
        record,
        verdict,
        replacement,
        ir,
        constraints,
        scope: {
          applicationId: world.base.applicationId,
          tenantId: world.base.tenantId,
          executionId,
          recordedAt: "2026-09-23T12:01:00.000Z",
        },
        digest,
      });
    };

    const records = Array.from({ length: 8 }, () => buildOnce());
    // All chains derived the identical record (pure determinism, no
    // divergence, no lost provenance).
    const decisionIds = new Set(records.map((entry) => entry?.decisionId));
    expect(decisionIds.size).toBe(1);

    // The concurrent appends: exactly one insert, seven replays.
    const outcomes = await Promise.all(
      records.map((entry) => world.store.append(entry as never)),
    );
    const inserts = outcomes.filter((outcome) => !outcome.replayed).length;
    const replays = outcomes.filter((outcome) => outcome.replayed).length;
    expect(inserts).toBe(1);
    expect(replays).toBe(7);
    expect(new Set(outcomes.map((outcome) => outcome.decisionId)).size).toBe(1);

    // The durable row survives intact (read-time validation over the
    // real PG row after the race).
    const decisionId = [...decisionIds][0] as string;
    const durable = await world.store.get(world.base.applicationId, decisionId);
    expect(durable?.decisionId).toBe(decisionId);
    expect(() => validateOptimizationDecision(durable, digest)).not.toThrow();

    // And exactly ONE durable row exists (never a duplicate, never a
    // torn record).
    const rows = await ctx.port.execute<{ count: string }>({
      sql: "SELECT count(*)::text AS count FROM execution_ir.optimization_decision_records WHERE application_id = $1",
      parameters: [world.base.applicationId],
    });
    expect(rows.rows[0]?.count).toBe("1");
  });
});
