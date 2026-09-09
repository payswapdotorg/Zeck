/**
 * Real-PostgreSQL Execution Compiler integration (WORK-050).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority:
 *
 *  - the FULL E1.1 stage-2 chain over the REAL executions ledger and
 *    the REAL planner: governed execution → durable planning decision
 *    → planning-seam snapshot → derived IR (identity-verified) →
 *    constraints from the CAPTURED policy inputs + capability
 *    resolution + the budgets seam + the verification binding →
 *    compileExecutionIr (bounded deterministic pipeline, total output
 *    validation, semantic-core equivalence proof) → the representation
 *    decision record (WORK-049 format, ladder selection) → durable
 *    append through the EXISTING store → deterministic re-compilation
 *    (byte-identical) → the durable provenance audit (plan → IR →
 *    decision), replayable with zero violations;
 *  - determinism over the real chain: identical inputs produce the
 *    identical output variant and the identical decision record;
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS compile+append chains
 *    of the same governed plan converge to exactly one durable row
 *    (the pure compiler produces the identical decisionId; the
 *    WORK-049 store's unique-index race safety serializes the appends
 *    — one insert, seven replays, never a duplicate, never a torn
 *    record);
 *  - a DIFFERENT governed plan compiles to a different decision that
 *    coexists durably (no cross-plan interference);
 *  - the idempotent re-append of a compiler-produced record is a
 *    bounded no-op.
 */

import { expect, test } from "vitest";
import { createIrBudgetConstraints } from "../../../src/modules/budgets/adapters/ir-cost-constraints";
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
import {
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
  type RepresentationClaims,
} from "../../../src/platform/execution-compiler/catalog";
import { compileExecutionIr } from "../../../src/platform/execution-compiler/pipeline";
import { validateExecutionIrVariant } from "../../../src/platform/execution-compiler/variant";
import { auditDurableExecutionProvenance } from "../../../src/platform/execution-ir/audit";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
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

interface CompilerWorld {
  readonly base: ExecutionsWorld;
  readonly store: import("../../../src/platform/execution-ir/decision-store").SqlOptimizationDecisionStore;
}

async function seedCompilerWorld(
  port: Parameters<typeof seedExecutionsWorld>[0],
): Promise<CompilerWorld> {
  const base = await seedExecutionsWorld(port);
  const { SqlOptimizationDecisionStore } = await import(
    "../../../src/platform/execution-ir/decision-store"
  );
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

function ladderClaims(): RepresentationClaims {
  return {
    base: {
      candidateId: "base-model-route",
      representationClass: "sufficient-model",
      claim: {
        // The governed plan's selected route facts (the planner's own
        // route-table estimates — the legitimate claim source).
        expectedCostMicroUsd: "1000",
        expectedLatencyMs: 2000,
        expectedQuality: 0.92,
        expectedReliability: 0.9,
        basis: { basis: "estimated" as const, source: "planning.route-table" },
      },
    },
    compiled: {
      candidateId: "compiled-variant",
      representationClass: "deterministic-computation",
      claim: {
        // The compiled representation's claim (observed basis — the
        // estimation-basis contract is exactly the seam later E1.1
        // stages wire to real telemetry).
        expectedCostMicroUsd: "100",
        expectedLatencyMs: 500,
        expectedQuality: 0.86,
        expectedReliability: 1,
        basis: { basis: "observed" as const, source: "learning.telemetry" },
      },
    },
  };
}

definePgSuite("execution compiler decisions (real PostgreSQL)", (ctx) => {
  test("the full stage-2 chain over the real executions ledger and planner", async () => {
    const world = await seedCompilerWorld(ctx.port);

    // Wire the REAL planner over the REAL executions ledger with a
    // REAL policy authority (the WORK-049 chain pattern).
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
      now: () => new Date("2026-09-22T12:00:00Z"),
    });

    // A governed execution through the durable lifecycle.
    const receipt = await world.base.service.createExecution(
      {
        applicationId: world.base.applicationId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "ec-create-1",
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", "ec-auth-1"],
      ["plan", "ec-plan-1"],
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

    // The REAL planner outcome: a governed plan with a captured allow
    // decision.
    const outcome = await planner.planExecution(
      {
        applicationId: world.base.applicationId,
        executionId,
        tenantId: world.base.tenantId,
        actorId: ACTOR_ID,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "ec-decision-1",
    );
    expect(outcome.decision.policyInputs.outcome).toBe("allow");

    // The budgets seam (read-only ceilings through the real authority).
    await world.base.db.execute({
      sql: `INSERT INTO budgets.budgets (id, application_id, tenant_id, scope_kind, user_id, limit_micro_usd)
            VALUES ($1, $2, $3, 'monthly', '', 20000000)`,
      parameters: [generateId(), world.base.applicationId, world.base.tenantId],
    });
    const budgetConstraints = await createIrBudgetConstraints(ctx.port).costConstraints(
      world.base.applicationId,
    );
    expect(budgetConstraints?.budgets).toHaveLength(1);

    // The IR from the governed plan through the planning seam.
    const snapshot = planSource.toPlanSnapshot(outcome.selectedPlan);
    const ir = deriveExecutionIr(snapshot, digest);
    expect(ir.planId).toBe(outcome.selectedPlan.planId);

    // The governing constraints (captured policy inputs + capability
    // resolution + budget ceiling + verification anchor).
    const constraints = [
      ...constraintsFromPolicyInputs(outcome.decision.policyInputs),
      capabilityConstraintFromResolution(outcome.decision.capabilityResolution),
      {
        constraintId: "budget-monthly",
        kind: "budget" as const,
        enforcement: "hard" as const,
        source: {
          authority: "budget" as const,
          budgetId: budgetConstraints?.budgets[0]?.budgetId ?? "unknown",
          scopeKind: "monthly" as const,
        },
        payload: { maxCostMicroUsd: budgetConstraints?.budgets[0]?.limitMicroUsd ?? "0" },
      },
      {
        constraintId: "verification-anchor",
        kind: "verification" as const,
        enforcement: "hard" as const,
        source: { authority: "verification" as const },
        payload: { requiresVerificationAnchor: true },
      },
    ];
    expect(constraints.length).toBeGreaterThanOrEqual(4);

    // COMPILE: the deterministic execution compiler over the real
    // governed IR with the ladder claims.
    const result = compileExecutionIr({
      ir,
      constraints,
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.8,
        representationClaims: ladderClaims(),
      },
      digest,
      decisionScope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
      },
      recordedAt: "2026-09-22T12:00:01.000Z",
    });

    // The output is a fully valid variant over the WORK-049 invariant
    // rules (total validation inside the pipeline; re-proven here).
    expect(() => validateExecutionIrVariant(result.output, digest)).not.toThrow();
    // The preserved governed chain.
    expect(result.output.sourcePlanId).toBe(ir.planId);
    expect(result.output.sourceIrId).toBe(ir.irId);
    // The equivalence proof: the semantic core digests are EQUAL.
    expect(result.semanticCore.inputDigest).toBe(result.semanticCore.outputDigest);
    // The compilation changed the representation (annotation passes
    // applied over the governed plan).
    expect(result.changed).toBe(true);
    // The ladder decision: the cheaper sufficient compiled variant
    // wins on expected successful-resolution cost (100 < ceil(1000/0.9)).
    expect(result.ladderOutcome).toBe("selected");
    expect(result.decisionRecord).not.toBeNull();
    expect(result.decisionRecord?.selectedCandidateId).toBe("compiled-variant");
    expect(
      result.decisionRecord?.selectedExpectation.expectedSuccessfulResolutionCostMicroUsd,
    ).toBe("100");
    // The decision record carries the compiler's transformation basis
    // with the exact provenance.
    expect(result.decisionRecord?.transformationBasis.code).toBe("representation-substitution");
    expect(result.decisionRecord?.transformationBasis.detail).toContain(result.output.variantIrId);
    expect(result.decisionRecord?.irId).toBe(ir.irId);
    expect(result.decisionRecord?.planId).toBe(ir.planId);

    // The durable append through the EXISTING WORK-049 store.
    const appended = await world.store.append(result.decisionRecord as never);
    expect(appended).toEqual({ decisionId: result.decisionRecord?.decisionId, replayed: false });

    // The durable round-trip: the served record equals the built one.
    const durable = await world.store.get(
      world.base.applicationId,
      result.decisionRecord?.decisionId as string,
    );
    expect(durable?.decisionId).toBe(result.decisionRecord?.decisionId);
    expect(durable?.recordDigest).toBe(result.decisionRecord?.recordDigest);
    expect(durable?.selectedCandidateId).toBe("compiled-variant");

    // The durable provenance audit: plan → IR → decision, replayable,
    // zero violations (the decision references the BASE IR and the
    // candidates carry the variant identities — the WORK-049 audit
    // chain holds for compiler-produced records).
    const audit = await auditDurableExecutionProvenance({
      applicationId: world.base.applicationId,
      decisionId: result.decisionRecord?.decisionId as string,
      snapshot,
      ir,
      store: world.store,
      digest,
    });
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.derivedIrId).toBe(ir.irId);

    // DETERMINISTIC RE-COMPILATION over the real chain: the identical
    // inputs produce the byte-identical output and record (the
    // EXECUTION-PROVENANCE replay).
    const replay = compileExecutionIr({
      ir,
      constraints,
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.8,
        representationClaims: ladderClaims(),
      },
      digest,
      decisionScope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
      },
      recordedAt: "2026-09-22T12:00:01.000Z",
    });
    expect(replay.output.variantIrId).toBe(result.output.variantIrId);
    expect(replay.traceDigest).toBe(result.traceDigest);
    expect(replay.decisionRecord?.decisionId).toBe(result.decisionRecord?.decisionId);
    expect(replay.decisionRecord?.recordDigest).toBe(result.decisionRecord?.recordDigest);
    // And the replayed record re-appends as a bounded no-op.
    const reAppend = await world.store.append(replay.decisionRecord as never);
    expect(reAppend).toEqual({ decisionId: replay.decisionRecord?.decisionId, replayed: true });
  });

  test("CONCURRENT compilations converge: N=8 simultaneous compile+append chains → exactly one durable row", async () => {
    const world = await seedCompilerWorld(ctx.port);

    // A governed plan (the planner-independent path is legitimate for
    // the concurrency proof: the identity chain is what matters).
    const { buildPlan } = await import("../../../src/modules/planning/public");
    const governed = buildPlan(
      {
        revision: 2,
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
        constraintId: "verification-anchor",
        kind: "verification" as const,
        enforcement: "hard" as const,
        source: { authority: "verification" as const },
        payload: { requiresVerificationAnchor: true },
      },
      {
        constraintId: "capability-satisfaction",
        kind: "capability" as const,
        enforcement: "hard" as const,
        source: { authority: "capability" as const, catalogRevision: "r1" },
        payload: {
          satisfiedIds: ["document-retrieval", "text-generation"],
          unmetIds: [],
        },
      },
      {
        constraintId: "policy-quality-floor",
        kind: "quality" as const,
        enforcement: "hard" as const,
        source: { authority: "policy" as const, policySetId: "ps-1" },
        payload: { minQuality: 0.8 },
      },
    ];

    // Eight SIMULTANEOUS independent compilations of the same governed
    // IR (each a pure re-computation) followed by eight simultaneous
    // appends. The pure compiler yields the identical decisionId in
    // every chain; the store's unique (application_id, decision_id)
    // index + ON CONFLICT DO NOTHING serialize the identity race:
    // exactly one durable row — never a duplicate, never a torn
    // record, never a raw error.
    const receipt = await world.base.service.createExecution(
      { applicationId: world.base.applicationId, task: { kind: "summarize", input: "c1" } },
      "ec-concurrent-1",
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        compileExecutionIr({
          ir,
          constraints,
          config: {
            passes: DEFAULT_PIPELINE_PASSES,
            maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
            qualityThreshold: 0.8,
            representationClaims: ladderClaims(),
          },
          digest,
          decisionScope: {
            applicationId: world.base.applicationId,
            tenantId: world.base.tenantId,
            executionId: receipt.executionId,
          },
          recordedAt: "2026-09-22T12:00:02.000Z",
        }),
      ),
    );
    // Every compilation produced the identical output and record.
    const decisionIds = new Set(outcomes.map((outcome) => outcome.decisionRecord?.decisionId));
    const variantIds = new Set(outcomes.map((outcome) => outcome.output.variantIrId));
    expect(decisionIds.size).toBe(1);
    expect(variantIds.size).toBe(1);

    const appends = await Promise.all(
      outcomes.map((outcome) => world.store.append(outcome.decisionRecord as never)),
    );
    expect(appends).toHaveLength(8);
    const inserted = appends.filter((append) => !append.replayed);
    const replayed = appends.filter((append) => append.replayed);
    expect(inserted).toHaveLength(1);
    expect(replayed).toHaveLength(7);

    // Exactly one durable row.
    const rows = await world.base.db.execute<{ count: string; record_digest: string }>({
      sql: "SELECT count(*) AS count, min(record_digest) AS record_digest FROM execution_ir.optimization_decision_records WHERE decision_id = $1",
      parameters: [outcomes[0]?.decisionRecord?.decisionId],
    });
    expect(rows.rows[0]?.count).toBe("1");
    expect(rows.rows[0]?.record_digest).toBe(outcomes[0]?.decisionRecord?.recordDigest);
  });

  test("a different governed plan compiles to a different decision that coexists durably", async () => {
    const world = await seedCompilerWorld(ctx.port);
    const { buildPlan } = await import("../../../src/modules/planning/public");

    const compilePlan = async (
      steps: Parameters<typeof buildPlan>[0]["steps"],
      edges: Parameters<typeof buildPlan>[0]["edges"],
    ) => {
      const governed = buildPlan({ revision: 1, strategyClass: "hybrid", steps, edges }, (value) =>
        digest.sha256Hex(canonicalJson(value)),
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
      const result = compileExecutionIr({
        ir,
        constraints,
        config: {
          passes: DEFAULT_PIPELINE_PASSES,
          maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
          qualityThreshold: 0.8,
          representationClaims: ladderClaims(),
        },
        digest,
        decisionScope: { applicationId: world.base.applicationId, tenantId: world.base.tenantId },
        recordedAt: "2026-09-22T12:00:03.000Z",
      });
      await world.store.append(result.decisionRecord as never);
      return { ir, result };
    };

    const first = await compilePlan(
      [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "generate",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [
        { from: "fetch", to: "generate" },
        { from: "generate", to: "verify" },
      ],
    );
    const second = await compilePlan(
      [
        {
          id: "gen2",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-b", model: "model-y" },
        },
        { id: "verify2", stepClass: "verify", verificationStrategy: "schema-check-2" },
      ],
      [{ from: "gen2", to: "verify2" }],
    );

    // Different plans → different IRs, variants and decisions.
    expect(first.ir.irId).not.toBe(second.ir.irId);
    expect(first.result.output.variantIrId).not.toBe(second.result.output.variantIrId);
    expect(first.result.decisionRecord?.decisionId).not.toBe(
      second.result.decisionRecord?.decisionId,
    );

    // Both coexist durably, each under its own plan.
    const firstList = await world.store.listByPlan(world.base.applicationId, first.ir.planId);
    const secondList = await world.store.listByPlan(world.base.applicationId, second.ir.planId);
    expect(firstList).toHaveLength(1);
    expect(secondList).toHaveLength(1);
    expect(firstList[0]?.decisionId).toBe(first.result.decisionRecord?.decisionId);
    expect(secondList[0]?.decisionId).toBe(second.result.decisionRecord?.decisionId);
  });
});
