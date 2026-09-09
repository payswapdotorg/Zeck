/**
 * Real-PostgreSQL model-economics integration (WORK-053).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority:
 *
 *  - the full model-economics chain over the REAL executions ledger
 *    and the REAL planner: governed execution → durable planning
 *    decision → planning-seam snapshot → derived IR
 *    (identity-verified) → constraints from the CAPTURED policy
 *    inputs + capability resolution + the verification binding →
 *    quality-aware model selection (the least expensive SUFFICIENT
 *    route; the cheaper below-assurance candidates recorded with
 *    their invalid evaluations — the durable "why the cheaper did
 *    not win" evidence) → the WORK-049-format decision record →
 *    durable append through the EXISTING store → read-time total
 *    validation → the durable provenance audit (plan → IR →
 *    decision) → deterministic re-selection (identical decisionId,
 *    bounded no-op re-append);
 *  - ALL FIVE feature records (model, effort, agent gate, service
 *    class, fresh escalation) coexist durably under one governed
 *    plan, each validating at read time;
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS select+append chains
 *    of the same inputs converge to exactly one durable row (the
 *    pure selections produce the identical decisionId; the WORK-049
 *    store's unique-index race safety serializes the appends — one
 *    insert, seven replays, never a duplicate, never a torn record).
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
  buildPlan,
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
import { auditDurableExecutionProvenance } from "../../../src/platform/execution-ir/audit";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import { validateOptimizationDecision } from "../../../src/platform/execution-ir/decision-record";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import { selectAgentStrategy } from "../../../src/platform/model-economics/agent-gate";
import {
  buildAgentGateDecisionRecord,
  buildEffortDecisionRecord,
  buildFreshEscalationDecisionRecord,
  buildModelDecisionRecord,
  buildServiceClassDecisionRecord,
} from "../../../src/platform/model-economics/decisions";
import { decideFreshEscalation } from "../../../src/platform/model-economics/escalation-hooks";
import { selectReasoningEffort } from "../../../src/platform/model-economics/effort-selection";
import { selectModelRepresentation } from "../../../src/platform/model-economics/model-selection";
import { selectServiceClass } from "../../../src/platform/model-economics/service-class";
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
  {
    provider: "rail-b",
    model: "model-y",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "200",
    expectedQuality: 0.85,
    expectedLatencyMs: 1500,
  },
];

interface EconomicsWorld {
  readonly base: ExecutionsWorld;
  readonly store: import("../../../src/platform/execution-ir/decision-store").SqlOptimizationDecisionStore;
}

async function seedEconomicsWorld(
  port: Parameters<typeof seedExecutionsWorld>[0],
): Promise<EconomicsWorld> {
  const base = await seedExecutionsWorld(port);
  const { SqlOptimizationDecisionStore } = await import(
    "../../../src/platform/execution-ir/decision-store"
  );
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

definePgSuite("model-economics decisions (real PostgreSQL)", (ctx) => {
  test("the full model-economics chain over the real executions ledger and planner", async () => {
    const world = await seedEconomicsWorld(ctx.port);

    // Wire the REAL planner over the REAL executions ledger with a
    // REAL policy authority (the WORK-049/050 chain pattern).
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

    // A governed execution through the durable lifecycle.
    const receipt = await world.base.service.createExecution(
      {
        applicationId: world.base.applicationId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "me-create-1",
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", "me-auth-1"],
      ["plan", "me-plan-1"],
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
      "me-decision-1",
    );
    expect(outcome.decision.policyInputs.outcome).toBe("allow");

    // The IR from the governed plan through the planning seam.
    const snapshot = planSource.toPlanSnapshot(outcome.selectedPlan);
    const ir = deriveExecutionIr(snapshot, digest);
    expect(ir.planId).toBe(outcome.selectedPlan.planId);

    // The governing constraints (captured policy inputs + capability
    // resolution + the verification anchor binding).
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

    // SELECT: the Work Order's assurance threshold (0.9) sits ABOVE
    // the captured policy quality floor (0.8): the cheaper routes are
    // below-assurance (recorded with their invalid evaluations), and
    // only the sufficient route is admissible.
    const candidates = [
      {
        candidateId: "rail-a-model-x",
        route: { provider: "rail-a", model: "model-x" },
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "1000",
          expectedLatencyMs: 2000,
          expectedQuality: 0.92,
          expectedReliability: 0.9,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
      {
        candidateId: "rail-b-model-y",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "200",
          expectedLatencyMs: 1500,
          expectedQuality: 0.85,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
      {
        candidateId: "rail-b-degraded",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "stronger-model" as const,
        claim: {
          expectedCostMicroUsd: "150",
          expectedLatencyMs: 1400,
          expectedQuality: 0.82,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];
    // The REAL planner's generative plan names its call-model step
    // `model` (planner-owned vocabulary, not the test's).
    const modelStepId = ir.steps.find((step) => step.stepClass === "call-model")?.id;
    expect(modelStepId).toBe("model");
    const selection = selectModelRepresentation({
      ir,
      stepId: modelStepId as string,
      candidates,
      qualityFacts: { requiredQuality: 0.9 },
      constraints,
    });
    expect(selection.kind).toBe("selected");
    expect(selection.selected?.candidateId).toBe("rail-a-model-x");
    // The cheaper candidates are below-assurance, not below the hard
    // floor — the durable comparison evidence.
    expect(
      selection.verdicts
        .find((verdict) => verdict.candidateId === "rail-b-model-y")
        ?.inadmissibleCode,
    ).toBe("quality-below-assurance");
    expect(
      selection.verdicts
        .find((verdict) => verdict.candidateId === "rail-b-degraded")
        ?.inadmissibleCode,
    ).toBe("quality-below-assurance");

    // The record: the evidence-honest corpus (all three — the two
    // below-assurance candidates with their invalid evaluations).
    const record = buildModelDecisionRecord({
      selection,
      stepId: modelStepId as string,
      candidates,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:01.000Z",
      },
      digest,
    });
    expect(record).not.toBeNull();
    expect(record?.selectedCandidateId).toBe("rail-a-model-x");
    expect(record?.qualityThreshold).toBe(0.9);
    expect(record?.candidates).toHaveLength(3);
    expect(
      record?.candidates.find((candidate) => candidate.candidateId === "rail-b-model-y")
        ?.evaluation.valid,
    ).toBe(false);
    expect(
      (record?.transformationBasis.code ?? "") as string,
    ).toMatch(/^(identity|representation-substitution)$/);

    // The durable append through the EXISTING WORK-049 store.
    const appended = await world.store.append(record as never);
    expect(appended).toEqual({ decisionId: record?.decisionId, replayed: false });

    // The durable round-trip: the served record equals the built one
    // and passes the foundation's total validation AT READ TIME.
    const durable = await world.store.get(
      world.base.applicationId,
      record?.decisionId as string,
    );
    expect(durable?.decisionId).toBe(record?.decisionId);
    expect(durable?.recordDigest).toBe(record?.recordDigest);
    expect(durable?.selectedCandidateId).toBe("rail-a-model-x");
    expect(() => validateOptimizationDecision(durable, digest)).not.toThrow();

    // The durable provenance audit: plan → IR → decision, replayable.
    const audit = await auditDurableExecutionProvenance({
      applicationId: world.base.applicationId,
      decisionId: record?.decisionId as string,
      snapshot,
      ir,
      store: world.store,
      digest,
    });
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.derivedIrId).toBe(ir.irId);

    // DETERMINISTIC RE-SELECTION: the identical inputs produce the
    // byte-identical record; the re-append is a bounded no-op.
    const replaySelection = selectModelRepresentation({
      ir,
      stepId: modelStepId as string,
      candidates,
      qualityFacts: { requiredQuality: 0.9 },
      constraints,
    });
    const replay = buildModelDecisionRecord({
      selection: replaySelection,
      stepId: modelStepId as string,
      candidates,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:01.000Z",
      },
      digest,
    });
    expect(replay?.decisionId).toBe(record?.decisionId);
    expect(replay?.recordDigest).toBe(record?.recordDigest);
    const reAppend = await world.store.append(replay as never);
    expect(reAppend).toEqual({ decisionId: replay?.decisionId, replayed: true });
  });

  test("ALL FIVE feature records coexist durably under one governed plan", async () => {
    const world = await seedEconomicsWorld(ctx.port);

    // A governed plan (the planner-independent path is legitimate for
    // the durable-semantics proof: the identity chain is what matters).
    const governed = buildPlan(
      {
        revision: 3,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
          {
            id: "generate",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch", to: "generate" },
          { from: "generate", to: "verify" },
        ],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(governed), digest);
    const constraints = [
      {
        constraintId: "policy-quality-floor",
        kind: "quality" as const,
        enforcement: "hard" as const,
        source: { authority: "policy" as const, policySetId: "ps-1" },
        payload: { minQuality: 0.85 },
      },
      {
        constraintId: "verification-anchor",
        kind: "verification" as const,
        enforcement: "hard" as const,
        source: { authority: "verification" as const },
        payload: { requiresVerificationAnchor: true },
      },
    ];
    const scope = {
      applicationId: world.base.applicationId,
      tenantId: world.base.tenantId,
      recordedAt: "2026-09-23T12:00:02.000Z",
    };
    const qualityFacts = { requiredQuality: 0.9 };

    // 1. The model-selection record.
    const modelCandidates = [
      {
        candidateId: "rail-b-cheaper",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "200",
          expectedLatencyMs: 1500,
          expectedQuality: 0.92,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];
    const modelRecord = buildModelDecisionRecord({
      selection: selectModelRepresentation({
        ir,
        stepId: "generate",
        candidates: modelCandidates,
        qualityFacts,
        constraints,
      }),
      stepId: "generate",
      candidates: modelCandidates,
      ir,
      constraints,
      scope,
      digest,
    });
    expect(modelRecord?.selectedCandidateId).toBe("rail-b-cheaper");
    expect(modelRecord?.transformationBasis.code).toBe("representation-substitution");

    // 2. The effort-selection record.
    const effortCandidates = [
      {
        candidateId: "effort-minimal",
        effort: "minimal" as const,
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "200",
          expectedLatencyMs: 900,
          expectedQuality: 0.91,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];
    const effortRecord = buildEffortDecisionRecord({
      selection: selectReasoningEffort({
        ir,
        stepId: "generate",
        candidates: effortCandidates,
        qualityFacts,
        constraints,
      }),
      stepId: "generate",
      candidates: effortCandidates,
      ir,
      constraints,
      scope,
      digest,
    });
    expect(effortRecord?.selectedCandidateId).toBe("effort-minimal");

    // 3. The agent-gate record (the zero-agent cache path wins over
    // the one-agent anchor and a positive-net but costlier N).
    const zeroAgent = [
      {
        candidateId: "cached-path",
        representationClass: "cache-reuse" as const,
        claim: {
          expectedCostMicroUsd: "50",
          expectedLatencyMs: 500,
          expectedQuality: 0.92,
          expectedReliability: 1,
          basis: { basis: "observed" as const, source: "learning.telemetry" },
        },
      },
    ];
    const oneAgent = [
      {
        candidateId: "single-agent",
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "200",
          expectedLatencyMs: 2000,
          expectedQuality: 0.95,
          expectedReliability: 0.9,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];
    const nAgent = [
      {
        candidateId: "parallel-considered",
        claim: {
          expectedCostMicroUsd: "500",
          expectedLatencyMs: 1500,
          expectedQuality: 0.95,
          expectedReliability: 0.95,
          basis: { basis: "estimated" as const, source: "learning.telemetry" },
        },
        gain: {
          expectedQualityGain: 0.3,
          expectedVerificationBurdenMicroUsd: "10000",
          agentCount: 3,
          basis: { basis: "estimated", source: "learning.telemetry" },
        },
      },
    ];
    const gateRecord = buildAgentGateDecisionRecord({
      selection: selectAgentStrategy({
        ir,
        stepId: "generate",
        zeroAgent,
        oneAgent,
        nAgent,
        qualityFacts,
        constraints,
        economics: { qualityValueMicroUsd: "1000000" },
      }),
      stepId: "generate",
      zeroAgent,
      oneAgent,
      nAgent,
      ir,
      constraints,
      scope,
      digest,
    });
    expect(gateRecord?.selectedCandidateId).toBe("cached-path");
    expect(gateRecord?.transformationBasis.code).toBe("representation-substitution");

    // 4. The service-class hook record.
    const declaredClasses = [
      {
        candidateId: "tier-economy",
        serviceClass: "economy" as const,
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "100",
          expectedLatencyMs: 3000,
          expectedQuality: 0.92,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];
    const serviceRecord = buildServiceClassDecisionRecord({
      selection: selectServiceClass({
        declaredClasses,
        qualityFacts,
        constraints,
      }),
      declaredClasses,
      ir,
      constraints,
      scope,
      digest,
    });
    expect(serviceRecord?.selectedCandidateId).toBe("tier-economy");

    // 5. The fresh-escalation record (the fresh path is strictly
    // cheaper — escalation is economically justified).
    const continuation = {
      expectedCostMicroUsd: "2000",
      expectedLatencyMs: 2000,
      expectedQuality: 0.95,
      expectedReliability: 0.9,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    };
    const freshContext = {
      expectedCostMicroUsd: "1000",
      expectedLatencyMs: 2000,
      expectedQuality: 0.95,
      expectedReliability: 0.95,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    };
    const escalationDecision = decideFreshEscalation({
      continuation,
      freshContext,
      qualityFacts,
      constraints,
    });
    expect(escalationDecision.kind).toBe("escalate-fresh-context");
    const escalationRecord = buildFreshEscalationDecisionRecord({
      decision: escalationDecision,
      continuation,
      freshContext,
      ir,
      constraints,
      scope,
      digest,
    });
    expect(escalationRecord?.selectedCandidateId).toBe("escalate-fresh-context");
    expect(escalationRecord?.transformationBasis.code).toBe("representation-substitution");

    // All five are DISTINCT decisions that coexist durably, each
    // validating at read time.
    const records = [
      modelRecord,
      effortRecord,
      gateRecord,
      serviceRecord,
      escalationRecord,
    ].filter((record) => record !== null);
    expect(records).toHaveLength(5);
    const decisionIds = new Set(records.map((record) => (record as { decisionId: string }).decisionId));
    expect(decisionIds.size).toBe(5);

    for (const record of records) {
      const appended = await world.store.append(record as never);
      expect(appended.replayed).toBe(false);
      const durable = await world.store.get(
        world.base.applicationId,
        (record as { decisionId: string }).decisionId,
      );
      expect(durable?.recordDigest).toBe((record as { recordDigest: string }).recordDigest);
      expect(() => validateOptimizationDecision(durable, digest)).not.toThrow();
    }

    // All five live under the same governed plan.
    const byPlan = await world.store.listByPlan(world.base.applicationId, ir.planId);
    expect(byPlan).toHaveLength(5);
  });

  test("CONCURRENT selections converge: N=8 simultaneous select+append chains → exactly one durable row", async () => {
    const world = await seedEconomicsWorld(ctx.port);

    const governed = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          {
            id: "generate",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [{ from: "generate", to: "verify" }],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(governed), digest);
    const constraints = [
      {
        constraintId: "verification-anchor",
        kind: "verification" as const,
        enforcement: "hard" as const,
        source: { authority: "verification" as const },
        payload: { requiresVerificationAnchor: true },
      },
    ];
    const candidates = [
      {
        candidateId: "rail-b-cheaper",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "200",
          expectedLatencyMs: 1500,
          expectedQuality: 0.92,
          expectedReliability: 1,
          basis: { basis: "estimated" as const, source: "planning.route-table" },
        },
      },
    ];

    // Eight SIMULTANEOUS independent selections of the same governed
    // facts (each a pure re-computation) followed by eight
    // simultaneous appends: the pure selection yields the identical
    // decisionId in every chain; the store's unique
    // (application_id, decision_id) index + ON CONFLICT DO NOTHING
    // serialize the identity race — exactly one durable row.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        buildModelDecisionRecord({
          selection: selectModelRepresentation({
            ir,
            stepId: "generate",
            candidates,
            qualityFacts: { requiredQuality: 0.9 },
            constraints,
          }),
          stepId: "generate",
          candidates,
          ir,
          constraints,
          scope: {
            applicationId: world.base.applicationId,
            tenantId: world.base.tenantId,
            recordedAt: "2026-09-23T12:00:03.000Z",
          },
          digest,
        }),
      ),
    );
    const decisionIds = new Set(outcomes.map((record) => record?.decisionId));
    expect(decisionIds.size).toBe(1);

    const appends = await Promise.all(
      outcomes.map((record) => world.store.append(record as never)),
    );
    expect(appends).toHaveLength(8);
    expect(appends.filter((append) => !append.replayed)).toHaveLength(1);
    expect(appends.filter((append) => append.replayed)).toHaveLength(7);

    // Exactly one durable row.
    const rows = await world.base.db.execute<{ count: string; record_digest: string }>({
      sql: "SELECT count(*) AS count, min(record_digest) AS record_digest FROM execution_ir.optimization_decision_records WHERE decision_id = $1",
      parameters: [outcomes[0]?.decisionId],
    });
    expect(rows.rows[0]?.count).toBe("1");
    expect(rows.rows[0]?.record_digest).toBe(outcomes[0]?.recordDigest);
  });
});
