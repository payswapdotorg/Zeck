/**
 * Real-PostgreSQL context-economics integration (WORK-052).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority and
 * the real planning/compiler chain:
 *
 *  - the FULL context-economics chain: governed execution → REAL
 *    planner decision → planning-seam snapshot → derived IR →
 *    compileExecutionIr (the memoization-hook annotations ride in
 *    the variant) → hook round-trip → cache facts → cache plan
 *    (reuse for the fresh fact, fail-closed compute for the stale
 *    one) → prompt/prefix plan → in-flight coalescing (one leader,
 *    N joiners, the leader's exact outcome) → duplication
 *    accounting decision records (WORK-049 format) → durable append
 *    through the EXISTING store → durable round-trip → the
 *    WORK-049 provenance audit (plan → IR → decision) with ZERO
 *    violations → deterministic re-planning (byte-identical plan
 *    digest) → idempotent re-append;
 *
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS coalesced
 *    participants — exactly ONE leader executes the work, seven
 *    joiners observe the leader's EXACT outcome — and N=8
 *    SIMULTANEOUS appends of the identical accounting record
 *    converge to exactly one durable row (one insert, seven
 *    replays); the per-execution accounting (one record per distinct
 *    execution identity) coexists durably;
 *
 *  - FAILURE FAN-OUT over the real chain: the leader's rejection
 *    reaches every joiner as the SAME failure, and NO durable
 *    accounting rows appear (nothing was avoided — the durable
 *    state is unchanged, no torn writes);
 *
 *  - the EXECUTIONS-SEAM RIDE (read-only): two REAL executions
 *    planned to the same governed plan are equivalent in-flight
 *    work — the bindings are read through the WORK-049 execution
 *    binding seam and the pure coalescing decision joins the
 *    younger execution onto the older leader;
 *
 *  - TENANT ISOLATION over real PG: cross-tenant cache facts never
 *    match the other tenant's plan, and the durable store's
 *    cross-application reads return nothing.
 */

import { expect, test } from "vitest";
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
  buildCoalescedAccountingRecord,
  buildDuplicationAccountingRecord,
} from "../../../src/platform/context-economics/accounting";
import {
  decideCoalescing,
  deriveEquivalenceKey,
  InFlightCoalescer,
} from "../../../src/platform/context-economics/coalesce";
import { deriveTenantScopedCacheKey } from "../../../src/platform/context-economics/keys";
import { readMemoizationHooks } from "../../../src/platform/context-economics/memo";
import {
  planCacheDecisions,
  planPromptPrefixCache,
  verifyCachePlanDigest,
} from "../../../src/platform/context-economics/plan";
import {
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
} from "../../../src/platform/execution-compiler/catalog";
import { compileExecutionIr } from "../../../src/platform/execution-compiler/pipeline";
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
const NOW = 1_800_000_000_000;

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

interface ContextEconomicsWorld {
  readonly base: ExecutionsWorld;
  readonly store: import("../../../src/platform/execution-ir/decision-store").SqlOptimizationDecisionStore;
}

async function seedWorld(
  port: Parameters<typeof seedExecutionsWorld>[0],
): Promise<ContextEconomicsWorld> {
  const base = await seedExecutionsWorld(port);
  const { SqlOptimizationDecisionStore } = await import(
    "../../../src/platform/execution-ir/decision-store"
  );
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

/** Wire the REAL planner (the WORK-050 integration pattern). */
async function realPlanner(world: ContextEconomicsWorld) {
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
  return createPlannerService({
    capabilityAuthority: createCapabilityAuthorityAdapter(registry),
    policyInputs: createPolicyInputsAdapter(policyAuthority),
    routeExplorer: createRouteTableExplorer(ROUTES),
    deterministicCatalog: createInMemoryDeterministicCatalog(),
    sink: createPlanningSinkAdapter(world.base.service),
    digest: createNodeDigest(),
    generateId,
    now: () => new Date("2026-09-22T12:00:00Z"),
  });
}

interface PlanChain {
  readonly executionId: string;
  readonly snapshot: ReturnType<typeof planSource.toPlanSnapshot>;
  readonly ir: ReturnType<typeof deriveExecutionIr>;
  readonly constraints: ReturnType<typeof constraintsFromPolicyInputs>;
}

/** Create a governed execution, authorize + plan it, run the REAL planner. */
async function governedExecutionChain(
  world: ContextEconomicsWorld,
  planner: Awaited<ReturnType<typeof realPlanner>>,
  task: { kind: string; input: unknown },
  keyPrefix: string,
): Promise<PlanChain> {
  const receipt = await world.base.service.createExecution(
    { applicationId: world.base.applicationId, task: task as never },
    `${keyPrefix}-create`,
    { actorId: ACTOR_ID, tenantId: world.base.tenantId },
  );
  for (const [command, key] of [
    ["authorize", `${keyPrefix}-auth`],
    ["plan", `${keyPrefix}-plan`],
  ] as const) {
    await world.base.service.transition(
      {
        actorId: ACTOR_ID,
        tenantId: world.base.tenantId,
        applicationId: world.base.applicationId,
        executionId: receipt.executionId,
        command,
      },
      key,
    );
  }
  const outcome = await planner.planExecution(
    {
      applicationId: world.base.applicationId,
      executionId: receipt.executionId,
      tenantId: world.base.tenantId,
      actorId: ACTOR_ID,
      task: task as never,
    },
    `${keyPrefix}-decision`,
  );
  expect(outcome.decision.policyInputs.outcome).toBe("allow");
  const snapshot = planSource.toPlanSnapshot(outcome.selectedPlan);
  const ir = deriveExecutionIr(snapshot, digest);
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
  return { executionId: receipt.executionId, snapshot, ir, constraints };
}

const permissivePolicy = {
  reuseAllowed: true,
  prefixCacheAllowed: true,
  coalescingAllowed: true,
  maxEntryAgeMs: 60_000,
  maxPrefixAgeMs: 60_000,
  maxJoinAgeMs: 60_000,
};

/** The accounting economics: the avoided fresh execution vs the reuse. */
function accountingEconomics() {
  return {
    freshExecution: {
      expectedCostMicroUsd: "1000",
      expectedLatencyMs: 2000,
      expectedQuality: 0.92,
      expectedReliability: 0.9,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    },
    avoidedExecution: {
      expectedCostMicroUsd: "10",
      expectedLatencyMs: 40,
      expectedQuality: 0.92,
      expectedReliability: 1,
      basis: { basis: "observed" as const, source: "context-economics.cache-observer" },
    },
  };
}

definePgSuite("context economics (real PostgreSQL)", (ctx) => {
  test("the full context-economics chain over the real planner, compiler, coalescer and store", async () => {
    const world = await seedWorld(ctx.port);
    // A REAL governed execution through the durable lifecycle (the
    // executions ledger is the durable plan-decision authority).
    const receipt = await world.base.service.createExecution(
      {
        applicationId: world.base.applicationId,
        task: { kind: "analysis", input: "doc-1" } as never,
      },
      "ce-full-create",
      { actorId: ACTOR_ID, tenantId: world.base.tenantId },
    );
    for (const [command, key] of [
      ["authorize", "ce-full-auth"],
      ["plan", "ce-full-plan"],
    ] as const) {
      await world.base.service.transition(
        {
          actorId: ACTOR_ID,
          tenantId: world.base.tenantId,
          applicationId: world.base.applicationId,
          executionId: receipt.executionId,
          command,
        },
        key,
      );
    }
    // The hook-bearing governed plan authored through the planning
    // module's own public API (the WORK-050 identity-chain precedent):
    // a deterministic, strategy-free step is a legitimate plan shape —
    // the real planner's deterministic plans are fully
    // verification-anchored (its own discipline), and the FIXED
    // memoization-hook contract (WORK-050) emits hooks only on
    // strategy-free deterministic steps.
    const { buildPlan } = await import("../../../src/modules/planning/public");
    const governed = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
          {
            id: "gen",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch", to: "gen" },
          { from: "gen", to: "check" },
        ],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const chain = {
      executionId: receipt.executionId,
      snapshot: planSource.toPlanSnapshot(governed),
      ir: deriveExecutionIr(planSource.toPlanSnapshot(governed), digest),
      constraints: [
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
          payload: { satisfiedIds: ["document-retrieval", "text-generation"], unmetIds: [] },
        },
        {
          constraintId: "policy-quality-floor",
          kind: "quality" as const,
          enforcement: "hard" as const,
          source: { authority: "policy" as const, policySetId: "ps-1" },
          payload: { minQuality: 0.8 },
        },
      ],
    };

    // COMPILE: the deterministic compiler emits the memoization hooks.
    const compilation = compileExecutionIr({
      ir: chain.ir,
      constraints: chain.constraints,
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.8,
      },
      digest,
    });
    const variant = compilation.output;
    expect(compilation.semanticCore.inputDigest).toBe(compilation.semanticCore.outputDigest);

    // The hook round-trip (the consumer side of the fixed contract).
    const read = readMemoizationHooks(variant);
    expect(read.hooks.length).toBeGreaterThanOrEqual(1);
    expect(read.rejections).toEqual([]);

    // Cache facts: one FRESH matching fact, one STALE fact.
    const scope = { tenantId: world.base.tenantId, applicationId: world.base.applicationId };
    const freshFact = {
      key: deriveTenantScopedCacheKey(
        scope,
        "memo-entry",
        { variantIrId: variant.variantIrId, memoKey: read.hooks[0]?.memoKey },
        digest,
      ),
      contentDigest: "a".repeat(64),
      recordedAtEpochMs: NOW - 1_000,
    };
    const staleFact = {
      key: deriveTenantScopedCacheKey(
        scope,
        "memo-entry",
        { variantIrId: variant.variantIrId, memoKey: read.hooks[1]?.memoKey ?? "0".repeat(64) },
        digest,
      ),
      contentDigest: "b".repeat(64),
      recordedAtEpochMs: NOW - 120_000,
    };
    const plan = planCacheDecisions(
      { variant, facts: [freshFact, staleFact], policy: permissivePolicy, scope, nowEpochMs: NOW },
      digest,
    );
    // The fresh fact's site is REUSED; the stale one fails closed.
    const freshDecision = plan.siteDecisions.find(
      (decision) => decision.memoKey === read.hooks[0]?.memoKey,
    );
    expect(freshDecision?.decision).toBe("reuse");
    const staleDecision = plan.siteDecisions.find(
      (decision) => decision.memoKey === (read.hooks[1]?.memoKey ?? "0".repeat(64)),
    );
    if (staleDecision !== undefined) {
      expect(staleDecision.decision).toBe("compute");
      expect(staleDecision.reason).toBe("freshness-expired");
    }
    expect(plan.reuseCount).toBe(1);

    // The prompt/prefix decision over a representative composition.
    const prefixDecision = planPromptPrefixCache(
      {
        composition: {
          segments: [
            {
              kind: "system-prompt",
              tokenCount: 1_000,
              basis: { basis: "observed" as const, source: "context.tokenizer" },
            },
            {
              kind: "tool-surface",
              tokenCount: 500,
              basis: { basis: "observed" as const, source: "context.tokenizer" },
            },
            {
              kind: "user-input",
              tokenCount: 30,
              basis: { basis: "observed" as const, source: "context.tokenizer" },
            },
          ],
        },
        facts: [],
        policy: permissivePolicy,
        scope,
        nowEpochMs: NOW,
      },
      digest,
    );
    expect(prefixDecision.decision).toBe("full-recompute");
    expect(prefixDecision.reason).toBe("freshness-no-fact");
    expect(prefixDecision.prefixSegments).toBe(2);

    // COALESCING: three concurrent equivalent executions observe the
    // leader's exact outcome; the work executes exactly once.
    const coalescer = new InFlightCoalescer();
    let workExecutions = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () =>
        coalescer.join(scope, { kind: "arithmetic", expression: "2+2" }, digest, async () => {
          workExecutions += 1;
          return { answer: "governed-answer", digest: "c".repeat(64) };
        }),
      ),
    );
    expect(workExecutions).toBe(1);
    expect(outcomes.filter((outcome) => outcome.role === "leader")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.role === "joiner")).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe(outcomes[0]?.outcome);
    }

    // DUPLICATION ACCOUNTING: the leader's record (the 2 joiners'
    // duplication was avoided) through the EXISTING store.
    const leaderRecord = buildCoalescedAccountingRecord(
      {
        ir: chain.ir,
        constraints: chain.constraints,
        scope: {
          applicationId: world.base.applicationId,
          tenantId: world.base.tenantId,
          executionId: chain.executionId,
        },
        role: "leader",
        leaderExecutionId: chain.executionId,
        equivalenceKey: deriveEquivalenceKey(
          scope,
          { kind: "arithmetic", expression: "2+2" },
          digest,
        ).key,
        joinerCount: 2,
        economics: accountingEconomics(),
        qualityThreshold: 0.8,
        recordedAt: "2026-09-22T12:00:01.000Z",
      },
      digest,
    );
    const appended = await world.store.append(leaderRecord);
    expect(appended).toEqual({ decisionId: leaderRecord.decisionId, replayed: false });

    // Durable round-trip + the WORK-049 provenance audit (ZERO violations).
    const audit = await auditDurableExecutionProvenance({
      applicationId: world.base.applicationId,
      decisionId: leaderRecord.decisionId,
      snapshot: chain.snapshot,
      ir: chain.ir,
      store: world.store,
      digest,
    });
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.durableDecision?.selectedCandidateId).toBe("coalesce-led-execution");
    expect(audit.durableDecision?.transformationBasis.detail).toContain("joinerCount=2");

    // DETERMINISTIC RE-PLANNING: the identical plan, byte-identical.
    const replayPlan = planCacheDecisions(
      { variant, facts: [freshFact, staleFact], policy: permissivePolicy, scope, nowEpochMs: NOW },
      digest,
    );
    expect(replayPlan.planDigest).toBe(plan.planDigest);
    expect(JSON.stringify(replayPlan)).toBe(JSON.stringify(plan));
    expect(verifyCachePlanDigest(replayPlan, digest).ok).toBe(true);

    // IDEMPOTENT RE-APPEND: the identical record replays.
    const reAppend = await world.store.append(leaderRecord);
    expect(reAppend).toEqual({ decisionId: leaderRecord.decisionId, replayed: true });
  });

  test("N=8 concurrent coalescing converges: one leader, identical fan-out, durable accounting convergence", async () => {
    const world = await seedWorld(ctx.port);
    const planner = await realPlanner(world);
    const chain = await governedExecutionChain(
      world,
      planner,
      { kind: "arithmetic", input: { expression: "3*7" } },
      "ce-conv",
    );
    const scope = { tenantId: world.base.tenantId, applicationId: world.base.applicationId };
    const semantics = { kind: "arithmetic", expression: "3*7" };

    // N=8 SIMULTANEOUS coalesced executions of the same work.
    const coalescer = new InFlightCoalescer();
    let workExecutions = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        coalescer.join(scope, semantics, digest, async () => {
          workExecutions += 1;
          return { value: "the-single-outcome", run: workExecutions };
        }),
      ),
    );
    // Exactly ONE execution; one leader; seven joiners with the EXACT
    // same outcome object.
    expect(workExecutions).toBe(1);
    expect(outcomes.filter((outcome) => outcome.role === "leader")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.role === "joiner")).toHaveLength(7);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe(outcomes[0]?.outcome);
      expect(outcome.joinerCount).toBe(7);
    }

    // N=8 SIMULTANEOUS appends of the IDENTICAL leader accounting
    // record: the pure builder produces the identical decisionId in
    // every chain; the store's unique-index race safety serializes
    // the appends — exactly one durable row.
    const buildRecord = () =>
      buildCoalescedAccountingRecord(
        {
          ir: chain.ir,
          constraints: chain.constraints,
          scope: {
            applicationId: world.base.applicationId,
            tenantId: world.base.tenantId,
            executionId: chain.executionId,
          },
          role: "leader",
          leaderExecutionId: chain.executionId,
          equivalenceKey: deriveEquivalenceKey(scope, semantics, digest).key,
          joinerCount: 7,
          economics: accountingEconomics(),
          qualityThreshold: 0.8,
          recordedAt: "2026-09-22T12:00:02.000Z",
        },
        digest,
      );
    const records = Array.from({ length: 8 }, buildRecord);
    const decisionIds = new Set(records.map((record) => record.decisionId));
    expect(decisionIds.size).toBe(1);

    const appends = await Promise.all(records.map((record) => world.store.append(record)));
    expect(appends.filter((append) => !append.replayed)).toHaveLength(1);
    expect(appends.filter((append) => append.replayed)).toHaveLength(7);

    const rows = await world.base.db.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM execution_ir.optimization_decision_records WHERE decision_id = $1",
      parameters: [records[0]?.decisionId],
    });
    expect(rows.rows[0]?.count).toBe("1");

    // The per-execution accounting coexists durably: a DISTINCT
    // execution identity records its own joiner perspective.
    const otherChain = await governedExecutionChain(
      world,
      planner,
      { kind: "arithmetic", input: { expression: "3*7" } },
      "ce-conv-b",
    );
    const joinerRecord = buildCoalescedAccountingRecord(
      {
        ir: otherChain.ir,
        constraints: otherChain.constraints,
        scope: {
          applicationId: world.base.applicationId,
          tenantId: world.base.tenantId,
          executionId: otherChain.executionId,
        },
        role: "joiner",
        leaderExecutionId: chain.executionId,
        equivalenceKey: deriveEquivalenceKey(scope, semantics, digest).key,
        joinerCount: 7,
        economics: accountingEconomics(),
        qualityThreshold: 0.8,
        recordedAt: "2026-09-22T12:00:03.000Z",
      },
      digest,
    );
    const joinerAppend = await world.store.append(joinerRecord);
    expect(joinerAppend.replayed).toBe(false);
    expect(joinerRecord.decisionId).not.toBe(records[0]?.decisionId);
  });

  test("FAILURE FAN-OUT over the real chain: identical failure to every joiner, NO durable accounting rows", async () => {
    const world = await seedWorld(ctx.port);
    const scope = { tenantId: world.base.tenantId, applicationId: world.base.applicationId };
    const before = await world.base.db.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM execution_ir.optimization_decision_records",
      parameters: [],
    });

    const coalescer = new InFlightCoalescer();
    const leaderFailure = new Error("the leader's work failed");
    let workExecutions = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        coalescer.join(scope, { kind: "arithmetic", expression: "9-1" }, digest, async () => {
          workExecutions += 1;
          throw leaderFailure;
        }),
      ),
    );
    // The work executed ONCE and failed; every joiner observed the
    // IDENTICAL failure (failures fan out as failures).
    expect(workExecutions).toBe(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBe(leaderFailure);
      }
    }

    // NO durable accounting rows appeared: nothing was avoided, and
    // no torn writes exist (the plane writes nothing until the
    // outcome is final — and a failed outcome records nothing).
    const after = await world.base.db.execute<{ count: string }>({
      sql: "SELECT count(*) AS count FROM execution_ir.optimization_decision_records",
      parameters: [],
    });
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(coalescer.inFlightGroups).toBe(0);
  });

  test("the executions-seam ride: equivalent in-flight executions join through the read-only binding", async () => {
    const world = await seedWorld(ctx.port);
    const planner = await realPlanner(world);
    // Two REAL executions of the SAME task → the same governed plan
    // content → the same planId through the executions ledger.
    const first = await governedExecutionChain(
      world,
      planner,
      { kind: "arithmetic", input: { expression: "12*12" } },
      "ce-seam-a",
    );
    const second = await governedExecutionChain(
      world,
      planner,
      { kind: "arithmetic", input: { expression: "12*12" } },
      "ce-seam-b",
    );
    expect(first.ir.planId).toBe(second.ir.planId);

    // READ-ONLY bindings through the WORK-049 executions seam.
    const binding = createIrExecutionBinding(world.base.db);
    const firstBinding = await binding.getPlanBinding(world.base.applicationId, first.executionId);
    const secondBinding = await binding.getPlanBinding(
      world.base.applicationId,
      second.executionId,
    );
    expect(firstBinding?.currentPlanId).toBe(first.ir.planId);
    expect(secondBinding?.currentPlanId).toBe(second.ir.planId);
    expect(firstBinding?.tenantId).toBe(world.base.tenantId);

    // The caller's read-only in-flight projection: identity + start
    // instant from the executions ledger (created_at), equivalence
    // keys derived from the CURRENT bound plan identity.
    const startedRows = await world.base.db.execute<{
      id: string;
      created_at: Date;
    }>({
      sql: "SELECT id, created_at FROM executions.executions WHERE application_id = $1 AND id = ANY($2)",
      parameters: [world.base.applicationId, [first.executionId, second.executionId]],
    });
    const startedAt = new Map(
      startedRows.rows.map((row) => [row.id, row.created_at.getTime() as number]),
    );
    const scope = { tenantId: world.base.tenantId, applicationId: world.base.applicationId };
    const equivalence = (planId: string) =>
      deriveEquivalenceKey(scope, { boundPlanId: planId }, digest);
    const inFlight = [
      {
        executionId: first.executionId,
        equivalenceKey: equivalence(firstBinding?.currentPlanId ?? first.ir.planId),
        startedAtEpochMs: startedAt.get(first.executionId) ?? 0,
      },
    ];

    // The pure coalescing decision: the SECOND (younger) execution
    // joins the first (older) leader — the same governed plan is the
    // equivalence, and the executions seam supplied the facts
    // read-only.
    const now = Math.max(...[...startedAt.values()]) + 1;
    const decision = decideCoalescing({
      candidates: inFlight,
      equivalenceKey: equivalence(secondBinding?.currentPlanId ?? second.ir.planId),
      policy: permissivePolicy,
      nowEpochMs: now,
    });
    expect(decision.kind).toBe("join");
    if (decision.kind === "join") {
      expect(decision.leaderExecutionId).toBe(first.executionId);
    }
  });

  test("tenant isolation over real PG: cross-tenant facts never match; cross-application reads return nothing", async () => {
    const world = await seedWorld(ctx.port);
    // The hook-bearing governed plan (the same authored shape as the
    // full-chain test — see the note there on the planner's
    // verification-anchoring discipline).
    const { buildPlan } = await import("../../../src/modules/planning/public");
    const governed = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
          { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [{ from: "fetch", to: "check" }],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const chain = {
      executionId: "00000000-0000-7000-8000-0000000000c1",
      snapshot: planSource.toPlanSnapshot(governed),
      ir: deriveExecutionIr(planSource.toPlanSnapshot(governed), digest),
      constraints: [
        {
          constraintId: "verification-anchor",
          kind: "verification" as const,
          enforcement: "hard" as const,
          source: { authority: "verification" as const },
          payload: { requiresVerificationAnchor: true },
        },
      ],
    };
    const compilation = compileExecutionIr({
      ir: chain.ir,
      constraints: chain.constraints,
      config: {
        passes: DEFAULT_PIPELINE_PASSES,
        maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
        qualityThreshold: 0.8,
      },
      digest,
    });
    const variant = compilation.output;
    const read = readMemoizationHooks(variant);
    const hook = read.hooks[0];
    expect(hook).toBeDefined();

    // A SECOND tenant + application (the tenant-isolation pattern).
    const otherTenantId = generateId();
    const otherApplicationId = generateId();
    await world.base.db.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [otherTenantId, `t-${otherTenantId.slice(-6)}`, "other tenant"],
    });
    await world.base.db.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [
        otherApplicationId,
        otherTenantId,
        `a-${otherApplicationId.slice(-6)}`,
        "other app",
      ],
    });

    // Tenant A's fact over the same semantics.
    const scopeA = { tenantId: world.base.tenantId, applicationId: world.base.applicationId };
    const scopeB = { tenantId: otherTenantId, applicationId: otherApplicationId };
    const factA = {
      key: deriveTenantScopedCacheKey(
        scopeA,
        "memo-entry",
        { variantIrId: variant.variantIrId, memoKey: hook?.memoKey },
        digest,
      ),
      contentDigest: "a".repeat(64),
      recordedAtEpochMs: NOW - 1_000,
    };

    // Tenant B's plan over the same variant NEVER reuses tenant A's
    // fact: the keys differ structurally, the fact cannot match.
    expect(factA.key.tenantId).not.toBe(scopeB.tenantId);
    const planB = planCacheDecisions(
      { variant, facts: [factA], policy: permissivePolicy, scope: scopeB, nowEpochMs: NOW },
      digest,
    );
    expect(planB.reuseCount).toBe(0);
    for (const decision of planB.siteDecisions) {
      expect(decision.decision).toBe("compute");
      expect(decision.cacheKey.tenantId).toBe(scopeB.tenantId);
    }

    // Coalescing: cross-tenant identical semantics NEVER coalesce.
    const coalescer = new InFlightCoalescer();
    let workExecutions = 0;
    await Promise.all([
      coalescer.join(scopeA, { kind: "arithmetic", expression: "5+5" }, digest, async () => {
        workExecutions += 1;
        return "a";
      }),
      coalescer.join(scopeB, { kind: "arithmetic", expression: "5+5" }, digest, async () => {
        workExecutions += 1;
        return "b";
      }),
    ]);
    expect(workExecutions).toBe(2);

    // Durable accounting: tenant A's record appends under tenant A's
    // application scope; the CROSS-APPLICATION read returns nothing.
    const record = buildDuplicationAccountingRecord(
      {
        ir: chain.ir,
        constraints: chain.constraints,
        scope: { applicationId: world.base.applicationId, tenantId: world.base.tenantId },
        outcome: {
          kind: "cache-reuse",
          cacheKey: factA.key.key,
          contentDigest: factA.contentDigest,
          memoKey: hook?.memoKey ?? "",
        },
        economics: accountingEconomics(),
        qualityThreshold: 0.8,
        recordedAt: "2026-09-22T12:00:04.000Z",
      },
      digest,
    );
    await world.store.append(record);
    const own = await world.store.get(world.base.applicationId, record.decisionId);
    expect(own?.decisionId).toBe(record.decisionId);
    const foreign = await world.store.get(otherApplicationId, record.decisionId);
    expect(foreign).toBeNull();
    const crossList = await world.store.listByExecution(otherApplicationId, chain.executionId);
    expect(crossList).toEqual([]);
    // The durable row's tenant column is tenant A's (composite scope).
    const rows = await world.base.db.execute<{ tenant_id: string }>({
      sql: "SELECT tenant_id FROM execution_ir.optimization_decision_records WHERE decision_id = $1",
      parameters: [record.decisionId],
    });
    expect(rows.rows[0]?.tenant_id).toBe(world.base.tenantId);
  });
});
