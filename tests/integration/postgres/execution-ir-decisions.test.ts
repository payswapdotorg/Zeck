/**
 * Real-PostgreSQL Execution IR integration (WORK-049).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority:
 *
 *  - migration 0030 ships with the tree (the harness applies it);
 *  - the durable decision-record round-trip: append → get /
 *    listByPlan / listByExecution, idempotent re-append (bounded
 *    no-op), identity conflict on content drift, tenant isolation;
 *  - the FULL foundation chain over the REAL executions ledger and the
 *    REAL planner: governed execution → durable planning decision →
 *    planning-seam snapshot → derived IR → constraints from the
 *    captured policy inputs + capability resolution + the budgets seam
 *    → cost model evaluation → decision record → durable append →
 *    deterministic durable provenance audit (plan → IR → decision,
 *    replayable);
 *  - the executions binding seam reads the current plan binding from
 *    the durable ledger;
 *  - PostgreSQL remains the SOLE durable authority (the only store
 *    implementation; append-only evidence, no state machine).
 */

import { expect, test } from "vitest";
import { createIrBudgetConstraints } from "../../../src/modules/budgets/adapters/ir-cost-constraints";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../../../src/modules/capabilities/public";
import { createIrExecutionBinding } from "../../../src/modules/executions/adapters/ir-execution-binding";
import {
  capabilityConstraintFromResolution,
  constraintsFromPolicyInputs,
  createIrPlanSource,
} from "../../../src/modules/planning/adapters/ir-plan-source";
import type { BuildPlanInput } from "../../../src/modules/planning/public";
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
import { auditDurableExecutionProvenance } from "../../../src/platform/execution-ir/audit";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import type { CandidateRepresentation } from "../../../src/platform/execution-ir/cost-model";
import { selectCandidate } from "../../../src/platform/execution-ir/cost-model";
import { buildOptimizationDecision } from "../../../src/platform/execution-ir/decision-record";
import {
  DecisionIdentityConflictError,
  SqlOptimizationDecisionStore,
} from "../../../src/platform/execution-ir/decision-store";
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

interface IrWorld {
  readonly base: ExecutionsWorld;
  readonly store: SqlOptimizationDecisionStore;
}

async function seedIrWorld(port: Parameters<typeof seedExecutionsWorld>[0]): Promise<IrWorld> {
  const base = await seedExecutionsWorld(port);
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

definePgSuite("execution-ir decisions (real PostgreSQL)", (ctx) => {
  test("migration 0030 shipped and the table enforces its closed vocabulary", async () => {
    const world = await seedIrWorld(ctx.port);
    const applied = await world.base.db.execute<{ version: number; name: string }>({
      sql: "SELECT version, name FROM platform.schema_migrations WHERE version = 30",
      parameters: [],
    });
    expect(applied.rows[0]?.name).toBe("execution_ir_decision_records");
    // A row outside the transformation-basis vocabulary is unrepresentable.
    await expect(
      world.base.db.execute({
        sql: `INSERT INTO execution_ir.optimization_decision_records
                    (id, application_id, tenant_id, decision_id, plan_id, ir_id,
                     plan_revision, selected_candidate_id, quality_threshold,
                     transformation_basis_code, payload, record_digest)
              VALUES ($1, $2, $3, $4, $5, $6, 1, 'c', 0.9, 'constant-folding', '{}', $7)`,
        parameters: [
          generateId(),
          world.base.applicationId,
          world.base.tenantId,
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
          "d".repeat(64),
        ],
      }),
    ).rejects.toThrow(/check constraint/i);
  });

  test("the full foundation chain over the real executions ledger and planner", async () => {
    const world = await seedIrWorld(ctx.port);

    // Wire the REAL planner over the REAL executions ledger (the
    // planning-decisions pattern) with a REAL policy authority.
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
      now: () => new Date("2026-09-20T12:00:00Z"),
    });

    // A governed execution in PLANNING.
    const receipt = await world.base.service.createExecution(
      {
        applicationId: world.base.applicationId,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "ir-create-1",
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    const executionId = receipt.executionId;
    for (const [command, key] of [
      ["authorize", "ir-auth-1"],
      ["plan", "ir-plan-1"],
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

    // The durable planning decision (through the single write path).
    const outcome = await planner.planExecution(
      {
        applicationId: world.base.applicationId,
        executionId,
        tenantId: world.base.tenantId,
        actorId: ACTOR_ID,
        task: { kind: "interpretation", input: { text: "why?" } },
      },
      "ir-decision-1",
    );
    expect(outcome.decision.policyInputs.outcome).toBe("allow");
    expect(outcome.selectedPlan.modelCalls).toBeGreaterThan(0);

    // The executions binding seam reads the durable plan binding.
    const binding = await createIrExecutionBinding(ctx.port).getPlanBinding(
      world.base.applicationId,
      executionId,
    );
    expect(binding).not.toBeNull();
    expect(binding?.currentPlanId).toBe(outcome.selectedPlan.planId);
    expect(binding?.planningDecisionId).toBe(outcome.decision.decisionId);
    expect(binding?.status).toBe("PLANNING");

    // The budgets seam (read-only ceilings): set a budget through the
    // REAL budget authority, then read it through the seam.
    await world.base.db.execute({
      sql: `INSERT INTO budgets.budgets (id, application_id, tenant_id, scope_kind, user_id, limit_micro_usd)
            VALUES ($1, $2, $3, 'monthly', '', 20000000)`,
      parameters: [generateId(), world.base.applicationId, world.base.tenantId],
    });
    const budgetConstraints = await createIrBudgetConstraints(ctx.port).costConstraints(
      world.base.applicationId,
    );
    expect(budgetConstraints?.budgets).toHaveLength(1);
    expect(budgetConstraints?.budgets[0]).toMatchObject({
      scopeKind: "monthly",
      limitMicroUsd: "20000000",
    });

    // Derive the IR from the governed plan through the planning seam.
    const snapshot = planSource.toPlanSnapshot(outcome.selectedPlan);
    const ir = deriveExecutionIr(snapshot, digest);
    expect(ir.planId).toBe(outcome.selectedPlan.planId);

    // Constraints from the CAPTURED governing inputs (policy + capability
    // resolution) plus the budgets authority's read-only ceiling.
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
    // The captured policy inputs yield the cost ceiling, quality floor,
    // latency ceiling constraints.
    expect(constraints.map((constraint) => constraint.constraintId)).toEqual(
      expect.arrayContaining([
        "policy-cost-ceiling",
        "policy-quality-floor",
        "policy-latency-ceiling",
        "capability-satisfaction",
        "budget-monthly",
        "verification-anchor",
      ]),
    );

    // Candidate representations over the REAL route table (the claims
    // come from the planner's own route facts).
    const candidates = [
      {
        candidateId: "base-model-route",
        representationClass: "sufficient-model" as const,
        description: "The governed plan's selected model route, untransformed.",
        variantIrId: ir.irId,
        claim: {
          expectedCostMicroUsd: "1000",
          expectedLatencyMs: 2000,
          expectedQuality: 0.92,
          expectedReliability: 0.9,
          basis: {
            basis: "estimated" as const,
            source: "planning.route-table",
          },
        },
      },
      {
        candidateId: "deterministic-replacement",
        representationClass: "deterministic-computation" as const,
        description:
          "Candidate deterministic replacement for the retrieval subgraph (WORK-050 will compile it).",
        claim: {
          expectedCostMicroUsd: "100",
          expectedLatencyMs: 500,
          expectedQuality: 0.86,
          expectedReliability: 1,
          basis: {
            basis: "observed" as const,
            source: "learning.telemetry",
          },
        },
      },
    ];
    const selection = selectCandidate(candidates, 0.8);
    expect(selection.selected?.candidateId).toBe("deterministic-replacement");

    // Build the decision record (validated fail-closed) and append it.
    const record = buildOptimizationDecision(
      {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        ir,
        constraints,
        candidates,
        qualityThreshold: 0.8,
        selectedCandidateId: selection.selected?.candidateId as string,
        transformationBasis: {
          code: "representation-substitution",
          detail:
            "The deterministic replacement candidate has lower expected successful-resolution cost (100 micro-USD at reliability 1.0) while meeting the 0.8 quality threshold; the base model route remains recorded as the compared candidate.",
        },
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const appended = await world.store.append(record);
    expect(appended).toEqual({ decisionId: record.decisionId, replayed: false });

    // Round-trip: the durable record equals the built record.
    const durable = await world.store.get(world.base.applicationId, record.decisionId);
    expect(durable?.decisionId).toBe(record.decisionId);
    expect(durable?.recordDigest).toBe(record.recordDigest);
    expect(durable?.selectedCandidateId).toBe("deterministic-replacement");

    // The durable provenance audit: plan → IR → decision, replayable.
    const audit = await auditDurableExecutionProvenance({
      applicationId: world.base.applicationId,
      decisionId: record.decisionId,
      snapshot,
      ir,
      store: world.store,
      digest,
    });
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.derivedIrId).toBe(ir.irId);
    expect(audit.durableDecision?.decisionId).toBe(record.decisionId);
  });

  test("idempotent re-append is a bounded no-op; content drift is a typed conflict", async () => {
    const world = await seedIrWorld(ctx.port);
    const { record, ir } = await buildDecisionFor(world, "idem-plan");
    const first = await world.store.append(record);
    expect(first.replayed).toBe(false);
    const second = await world.store.append(record);
    expect(second.replayed).toBe(true);
    expect(second.decisionId).toBe(record.decisionId);
    // Exactly one durable row.
    const rows = await world.base.db.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM execution_ir.optimization_decision_records WHERE decision_id = $1",
      parameters: [record.decisionId],
    });
    expect(rows.rows[0]?.count).toBe("1");

    // Same decision identity (the content digest is unchanged),
    // DIFFERENT record content (the volatile timestamp is covered by
    // recordDigest but not by decisionId): fail closed — never an
    // overwrite.
    const drifted = buildOptimizationDecision(
      {
        applicationId: record.applicationId,
        tenantId: record.tenantId,
        executionId: record.executionId,
        ir,
        constraints: record.constraints,
        candidates: record.candidates.map(
          (candidate): CandidateRepresentation => ({
            candidateId: candidate.candidateId,
            representationClass:
              candidate.representationClass as CandidateRepresentation["representationClass"],
            claim: candidate.claim,
          }),
        ),
        qualityThreshold: record.qualityThreshold,
        selectedCandidateId: record.selectedCandidateId,
        transformationBasis: record.transformationBasis,
        recordedAt: "2027-01-01T00:00:00.000Z",
      },
      digest,
    );
    expect(drifted.decisionId).toBe(record.decisionId);
    expect(drifted.recordDigest).not.toBe(record.recordDigest);
    await expect(world.store.append(drifted)).rejects.toBeInstanceOf(DecisionIdentityConflictError);
  });

  test("tenant isolation: another application's decisions are invisible", async () => {
    const world = await seedIrWorld(ctx.port);
    const { record } = await buildDecisionFor(world, "iso-plan");
    await world.store.append(record);

    // A DIFFERENT application in the same authority.
    const otherApplicationId = generateId();
    await world.base.db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [
        otherApplicationId,
        world.base.tenantId,
        `a-${otherApplicationId.slice(-6)}`,
        "other app",
      ],
    });
    expect(await world.store.get(otherApplicationId, record.decisionId)).toBeNull();
    expect(await world.store.listByPlan(otherApplicationId, record.planId)).toEqual([]);
    expect(await world.store.listByExecution(otherApplicationId, record.executionId ?? "")).toEqual(
      [],
    );
  });

  test("the store is the sole durable authority: listByPlan/listByExecution read paths", async () => {
    const world = await seedIrWorld(ctx.port);
    const first = (await buildDecisionFor(world, "list-plan-1")).record;
    const second = (await buildDecisionFor(world, "list-plan-2")).record;
    await world.store.append(first);
    await world.store.append(second);
    const byPlan = await world.store.listByPlan(world.base.applicationId, first.planId);
    expect(byPlan.map((record) => record.decisionId).sort()).toEqual(
      [first.decisionId, second.decisionId].sort(),
    );
    // Each record binds to its own execution: the execution read path
    // returns exactly that execution's decisions.
    const byExecution = await world.store.listByExecution(
      world.base.applicationId,
      first.executionId as string,
    );
    expect(byExecution).toHaveLength(1);
    expect(byExecution[0]?.decisionId).toBe(first.decisionId);
    const secondByExecution = await world.store.listByExecution(
      world.base.applicationId,
      second.executionId as string,
    );
    expect(secondByExecution).toHaveLength(1);
    expect(secondByExecution[0]?.decisionId).toBe(second.decisionId);
  });
});

/** Build a valid decision (and its IR) bound to a fresh governed plan. */
async function buildDecisionFor(
  world: IrWorld,
  planIdSeed: string,
): Promise<{
  record: ReturnType<typeof buildOptimizationDecision>;
  ir: ReturnType<typeof deriveExecutionIr>;
}> {
  const plan: BuildPlanInput = {
    revision: 1,
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
  };
  const { buildPlan } = await import("../../../src/modules/planning/public");
  const governed = buildPlan(plan, (value) => digest.sha256Hex(canonicalJson(value)));
  void planIdSeed;
  const ir = deriveExecutionIr(planSource.toPlanSnapshot(governed), digest);
  const record = buildOptimizationDecision(
    {
      applicationId: world.base.applicationId,
      tenantId: world.base.tenantId,
      executionId: await executionIn(world, "ir-exec"),
      ir,
      constraints: [
        {
          constraintId: "verification-anchor",
          kind: "verification",
          enforcement: "hard",
          source: { authority: "verification" },
          payload: { requiresVerificationAnchor: true },
        },
        {
          constraintId: "capability-satisfaction",
          kind: "capability",
          enforcement: "hard",
          source: { authority: "capability", catalogRevision: "r1" },
          payload: {
            satisfiedIds: ["document-retrieval", "text-generation"],
            unmetIds: [],
          },
        },
      ],
      candidates: [
        {
          candidateId: "base-model-route",
          representationClass: "sufficient-model",
          claim: {
            expectedCostMicroUsd: "500000",
            expectedLatencyMs: 2000,
            expectedQuality: 0.93,
            expectedReliability: 0.9,
            basis: { basis: "estimated", source: "planning.route-table" },
          },
        },
      ],
      qualityThreshold: 0.9,
      selectedCandidateId: "base-model-route",
      transformationBasis: {
        code: "identity",
        detail: "The derived IR itself is the base representation.",
      },
      recordedAt: "2026-09-20T12:00:00.000Z",
    },
    digest,
  );
  return { record, ir };
}

async function executionIn(world: IrWorld, key: string): Promise<string> {
  const receipt = await world.base.service.createExecution(
    { applicationId: world.base.applicationId, task: { kind: "summarize", input: "a1" } },
    `ir-${key}-${Math.random().toString(36).slice(2, 8)}`,
    { actorId: ACTOR_ID, tenantId: world.base.tenantId },
  );
  const executionId = receipt.executionId;
  await world.base.service.transition(
    {
      actorId: ACTOR_ID,
      tenantId: world.base.tenantId,
      applicationId: world.base.applicationId,
      executionId,
      command: "authorize",
    },
    `ir-auth-${key}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return executionId;
}
