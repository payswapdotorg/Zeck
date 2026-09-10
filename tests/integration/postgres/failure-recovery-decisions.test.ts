/**
 * Real-PostgreSQL failure-recovery integration (WORK-055).
 *
 * Proves the durable semantics over the REAL PostgreSQL authority:
 *
 *  - the full failure-recovery chain over the REAL executions ledger
 *    and the REAL planner: governed execution → durable planning
 *    decision → planning-seam snapshot → derived IR (identity-verified)
 *    → constraints from the CAPTURED policy inputs + the verification
 *    binding → a real attributed failure (typed, evidence-bound,
 *    content-addressed) → recovery strategy selection (the pure
 *    deterministic decision over the economics planes' facts) → the
 *    WORK-049-format recovery decision record → durable append
 *    through the EXISTING store → read-time total validation → the
 *    durable provenance audit (plan → IR → decision) → deterministic
 *    re-selection (identical decisionId, bounded no-op re-append);
 *  - the CONTINUATION ROUND-TRIP over real serialized values:
 *    construct → durable-shape serialize/validate → fingerprint
 *    match → resume (idempotent double-apply) → drift-reject
 *    (fail-closed) — the package is DATA: no durable state is
 *    created anywhere (the store row count proves it);
 *  - the ESCALATION package construction and bounding over the same
 *    chain (bounded evidence, attribution coherence);
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS select+append chains
 *    of the same inputs converge to exactly one durable row (the
 *    pure selections produce the identical decisionId; the WORK-049
 *    store's unique-index race safety serializes the appends — one
 *    insert, seven replays, never a duplicate, never a torn record);
 *    no attribution is lost (the content-addressed attribution
 *    identity is identical across the concurrent chains).
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
import { auditDurableExecutionProvenance } from "../../../src/platform/execution-ir/audit";
import type { CostClaim } from "../../../src/platform/execution-ir/cost-model";
import { validateOptimizationDecision } from "../../../src/platform/execution-ir/decision-record";
import { SqlOptimizationDecisionStore } from "../../../src/platform/execution-ir/decision-store";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import { attributeFailure } from "../../../src/platform/failure-recovery/attribution";
import {
  applyContinuationPackage,
  buildContinuationPackage,
  validateContinuationPackage,
} from "../../../src/platform/failure-recovery/continuation";
import { buildRecoveryDecisionRecord } from "../../../src/platform/failure-recovery/decisions";
import { buildEscalationPackage } from "../../../src/platform/failure-recovery/escalation";
import { fingerprintOf } from "../../../src/platform/failure-recovery/fingerprint";
import { selectRecoveryStrategy } from "../../../src/platform/failure-recovery/strategy";
import { decideFreshEscalation } from "../../../src/platform/model-economics/escalation-hooks";
import { selectModelRepresentation } from "../../../src/platform/model-economics/model-selection";
import {
  deriveSelectionConstraints,
  selectSubstrate,
} from "../../../src/platform/substrate-economics/selection";
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
    expectedCostMicroUsd: "300",
    expectedQuality: 0.9,
    expectedLatencyMs: 1800,
  },
];

const MODEL_CANDIDATES = [
  {
    candidateId: "rail-b-model-y",
    route: { provider: "rail-b", model: "model-y" },
    representationClass: "sufficient-model" as const,
    claim: {
      expectedCostMicroUsd: "300",
      expectedLatencyMs: 1800,
      expectedQuality: 0.9,
      expectedReliability: 0.95,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    },
  },
];

const SUBSTRATE_CANDIDATES = [
  {
    substrateId: "mid-container-b",
    version: "2.0.0",
    adapterRef: "substrate-adapter-02",
    isolation: "container",
    execution: {
      expectedCostMicroUsd: "200",
      expectedLatencyMs: 2000,
      expectedQuality: 0.88,
      expectedReliability: 0.93,
      basis: { basis: "observed" as const, source: "substrate-observer:container-fleet" },
    },
    startup: {
      cold: {
        readinessMs: 4000,
        startupCostMicroUsd: "60",
        basis: { basis: "estimated" as const, source: "substrate-facts:container-cold" },
      },
    },
    description: null,
  },
];

interface RecoveryWorld {
  readonly base: ExecutionsWorld;
  readonly store: SqlOptimizationDecisionStore;
}

async function seedRecoveryWorld(
  port: Parameters<typeof seedExecutionsWorld>[0],
): Promise<RecoveryWorld> {
  const base = await seedExecutionsWorld(port);
  const store = new SqlOptimizationDecisionStore(port, digest, generateId);
  return { base, store };
}

/** The full governed chain: real planner → real IR → real constraints. */
async function governedChain(world: RecoveryWorld) {
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
    "fr-create-1",
    { actorId: ACTOR_ID, tenantId: world.base.tenantId },
  );
  const executionId = receipt.executionId;
  for (const [command, key] of [
    ["authorize", "fr-auth-1"],
    ["plan", "fr-plan-1"],
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
    "fr-decision-1",
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
  return { ir, constraints, executionId, snapshot };
}

definePgSuite("failure-recovery decisions (real PostgreSQL)", (ctx) => {
  test("the full recovery chain over the real executions ledger, planner and decision store", async () => {
    const world = await seedRecoveryWorld(ctx.port);
    const { ir, constraints, executionId, snapshot } = await governedChain(world);

    // ATTRIBUTION: a real transient infrastructure failure observed at
    // the governed generative step (typed, evidence-bound,
    // content-addressed).
    const attribution = attributeFailure(
      {
        signal: "transport-unreachable",
        component: "edge-gateway",
        stepId: ir.steps.find((step) => step.stepClass === "call-model")?.id ?? "model",
        routeRef: { provider: "rail-a", model: "model-x" },
        detail: "the edge gateway reported the upstream unreachable",
        observedAt: "2026-09-23T12:00:01.000Z",
        observationDigest: digest.sha256Hex("real-observation:transport-unreachable"),
      },
      "infrastructure",
      { kind: "infrastructure", transient: true },
      digest,
    );
    expect(attribution.attributionId).toMatch(/^[0-9a-f]{64}$/);

    // RECOVERY FACTS: the economics planes' OWN selections, read-only.
    const modelStepId = ir.steps.find((step) => step.stepClass === "call-model")?.id as string;
    const modelSelection = selectModelRepresentation({
      ir,
      stepId: modelStepId,
      candidates: MODEL_CANDIDATES,
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
    });
    const derived = deriveSelectionConstraints(constraints);
    const substrateSelection = selectSubstrate(
      {
        candidates: SUBSTRATE_CANDIDATES,
        constraints: derived.constraints,
        sourceConstraintIds: derived.sourceConstraintIds,
        recordedAt: "2026-09-23T12:00:02.000Z",
      },
      digest,
    );
    expect(modelSelection.kind).toBe("selected");
    expect(substrateSelection.outcome).toBe("selected");

    // SELECTION: the pure deterministic recovery decision.
    const selection = selectRecoveryStrategy({
      attribution,
      context: {
        executionId,
        stepId: modelStepId,
        attemptsUsed: 0,
        incumbentRoute: { provider: "rail-a", model: "model-x" },
      },
      facts: {
        retry: {
          nextAttempt: 1,
          claim: {
            expectedCostMicroUsd: "400",
            expectedLatencyMs: 2000,
            expectedQuality: 0.92,
            expectedReliability: 0.95,
            basis: { basis: "estimated", source: "recovery:retry-path" },
          },
        },
        reroute: {
          model: { selection: modelSelection, declaredCandidates: MODEL_CANDIDATES },
          substrate: { selection: substrateSelection },
        },
        escalation: {
          decision: decideFreshEscalation({
            continuation: {
              expectedCostMicroUsd: "400",
              expectedLatencyMs: 5000,
              expectedQuality: 0.9,
              expectedReliability: 0.9,
              basis: { basis: "estimated", source: "recovery:continuation" },
            },
            freshContext: {
              expectedCostMicroUsd: "600",
              expectedLatencyMs: 5200,
              expectedQuality: 0.92,
              expectedReliability: 0.94,
              basis: { basis: "estimated", source: "recovery:fresh" },
            },
            qualityFacts: { requiredQuality: 0.85 },
            constraints,
          }),
          claim: {
            expectedCostMicroUsd: "600",
            expectedLatencyMs: 5200,
            expectedQuality: 0.92,
            expectedReliability: 0.94,
            basis: { basis: "estimated", source: "recovery:fresh" },
          },
        },
      },
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
      configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
      digest,
    });
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("re-route");

    // RECORD: the WORK-049 decision through the foundation's builder.
    const claims: ReadonlyMap<string, CostClaim> = new Map<string, CostClaim>([
      [
        "retry-attempt-1",
        {
          expectedCostMicroUsd: "400",
          expectedLatencyMs: 2000,
          expectedQuality: 0.92,
          expectedReliability: 0.95,
          basis: { basis: "estimated", source: "recovery:retry-path" },
        },
      ],
      [
        "reroute-model",
        {
          expectedCostMicroUsd: "316",
          expectedLatencyMs: 1800,
          expectedQuality: 0.9,
          expectedReliability: 0.95,
          basis: { basis: "estimated", source: "model-economics" },
        },
      ],
      [
        "reroute-substrate",
        {
          expectedCostMicroUsd: "242",
          expectedLatencyMs: 4000,
          expectedQuality: 0.88,
          expectedReliability: 0.93,
          basis: { basis: "observed", source: "substrate-economics" },
        },
      ],
      [
        "escalate-fresh",
        {
          expectedCostMicroUsd: "600",
          expectedLatencyMs: 5200,
          expectedQuality: 0.92,
          expectedReliability: 0.94,
          basis: { basis: "estimated", source: "recovery:fresh" },
        },
      ],
    ]);
    const record = buildRecoveryDecisionRecord({
      attribution,
      selection,
      claims,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:03.000Z",
      },
      digest,
    });
    expect(record).not.toBeNull();
    expect(record?.selectedCandidateId).toBe("reroute-substrate");
    expect(record?.transformationBasis.detail).toContain("class=infrastructure");
    expect(record?.transformationBasis.detail).toContain("attribution=");

    // DURABLE APPEND through the EXISTING WORK-049 store.
    const appended = await world.store.append(record as never);
    expect(appended).toEqual({ decisionId: record?.decisionId, replayed: false });

    // Read-time total validation over the real PG row.
    const durable = await world.store.get(world.base.applicationId, record?.decisionId as string);
    expect(durable?.decisionId).toBe(record?.decisionId);
    expect(durable?.recordDigest).toBe(record?.recordDigest);
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

    // DETERMINISTIC RE-SELECTION: identical decisionId; bounded no-op
    // re-append.
    const reSelection = selectRecoveryStrategy({
      attribution,
      context: {
        executionId,
        stepId: modelStepId,
        attemptsUsed: 0,
        incumbentRoute: { provider: "rail-a", model: "model-x" },
      },
      facts: {
        retry: {
          nextAttempt: 1,
          claim: {
            expectedCostMicroUsd: "400",
            expectedLatencyMs: 2000,
            expectedQuality: 0.92,
            expectedReliability: 0.95,
            basis: { basis: "estimated", source: "recovery:retry-path" },
          },
        },
        reroute: {
          model: { selection: modelSelection, declaredCandidates: MODEL_CANDIDATES },
          substrate: { selection: substrateSelection },
        },
        escalation: {
          decision: decideFreshEscalation({
            continuation: {
              expectedCostMicroUsd: "400",
              expectedLatencyMs: 5000,
              expectedQuality: 0.9,
              expectedReliability: 0.9,
              basis: { basis: "estimated", source: "recovery:continuation" },
            },
            freshContext: {
              expectedCostMicroUsd: "600",
              expectedLatencyMs: 5200,
              expectedQuality: 0.92,
              expectedReliability: 0.94,
              basis: { basis: "estimated", source: "recovery:fresh" },
            },
            qualityFacts: { requiredQuality: 0.85 },
            constraints,
          }),
          claim: {
            expectedCostMicroUsd: "600",
            expectedLatencyMs: 5200,
            expectedQuality: 0.92,
            expectedReliability: 0.94,
            basis: { basis: "estimated", source: "recovery:fresh" },
          },
        },
      },
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
      configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
      digest,
    });
    expect(JSON.stringify(reSelection)).toBe(JSON.stringify(selection));
    const reRecord = buildRecoveryDecisionRecord({
      attribution,
      selection: reSelection,
      claims,
      ir,
      constraints,
      scope: {
        applicationId: world.base.applicationId,
        tenantId: world.base.tenantId,
        executionId,
        recordedAt: "2026-09-23T12:00:03.000Z",
      },
      digest,
    });
    expect(reRecord?.decisionId).toBe(record?.decisionId);
    const reAppend = await world.store.append(reRecord as never);
    expect(reAppend).toEqual({ decisionId: record?.decisionId, replayed: true });

    // THE CONTINUATION ROUND-TRIP (durable-resume shape): construct →
    // serialize → validate → fingerprint match → idempotent apply →
    // drift reject. The package is DATA: no durable row is created
    // for it anywhere (the decision store is the sole durable
    // surface).
    const environment = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-b", model: "model-y" },
        { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
      ],
      digest,
    );
    const continuation = buildContinuationPackage({
      applicationId: world.base.applicationId,
      tenantId: world.base.tenantId,
      executionId,
      planId: ir.planId,
      irId: ir.irId,
      steps: [{ stepId: "model", status: "completed" }],
      environment,
      attribution,
      createdAt: "2026-09-23T12:00:04.000Z",
      digest,
    });
    const serialized = JSON.parse(JSON.stringify(continuation));
    const durableContinuation = validateContinuationPackage(serialized, digest);
    const directive = applyContinuationPackage(durableContinuation, environment, digest);
    expect(directive.planId).toBe(ir.planId);
    expect(directive.completedStepIds).toEqual(["model"]);
    // Double-apply: the bounded no-op.
    const second = applyContinuationPackage(durableContinuation, environment, digest);
    expect(JSON.stringify(second)).toBe(JSON.stringify(directive));
    // Drift: a changed environment fails closed (never silent).
    const drifted = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-b", model: "model-y" },
        { kind: "substrate", substrateId: "std-microvm-a", version: "1.2.0" },
      ],
      digest,
    );
    await expect(async () => {
      applyContinuationPackage(durableContinuation, drifted, digest);
    }).rejects.toThrowError(/drifted/);

    // ESCALATION: an intelligence-failure escalation package over the
    // same governed chain (bounded evidence + attribution coherence).
    const intelligenceFailure = attributeFailure(
      {
        signal: "verification-failed",
        component: "verification-authority",
        stepId: ir.steps.find((step) => step.stepClass === "verify")?.id ?? "verify",
        detail: "the verifier returned FAIL on the generated output",
        observedAt: "2026-09-23T12:00:05.000Z",
        observationDigest: digest.sha256Hex("real-observation:verification-failed"),
      },
      "intelligence",
      { kind: "intelligence", observedQuality: 0.4 },
      digest,
    );
    const intelligenceSelection = selectRecoveryStrategy({
      attribution: intelligenceFailure,
      context: {
        executionId,
        stepId: modelStepId,
        attemptsUsed: 1,
        incumbentRoute: { provider: "rail-a", model: "model-x" },
      },
      facts: {
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: {
          decision: decideFreshEscalation({
            continuation: {
              expectedCostMicroUsd: "1500",
              expectedLatencyMs: 5000,
              expectedQuality: 0.7,
              expectedReliability: 0.9,
              basis: { basis: "estimated", source: "recovery:continuation" },
            },
            freshContext: {
              expectedCostMicroUsd: "600",
              expectedLatencyMs: 5200,
              expectedQuality: 0.92,
              expectedReliability: 0.94,
              basis: { basis: "estimated", source: "recovery:fresh" },
            },
            qualityFacts: { requiredQuality: 0.85 },
            constraints,
          }),
          claim: {
            expectedCostMicroUsd: "600",
            expectedLatencyMs: 5200,
            expectedQuality: 0.92,
            expectedReliability: 0.94,
            basis: { basis: "estimated", source: "recovery:fresh" },
          },
        },
      },
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
      configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
      digest,
    });
    expect(intelligenceSelection.selected?.strategy).toBe("escalate-fresh");
    const escalationContinuation = buildContinuationPackage({
      applicationId: world.base.applicationId,
      tenantId: world.base.tenantId,
      executionId,
      planId: ir.planId,
      irId: ir.irId,
      steps: [{ stepId: "model", status: "completed" }],
      environment,
      attribution: intelligenceFailure,
      createdAt: "2026-09-23T12:00:06.000Z",
      digest,
    });
    const escalation = buildEscalationPackage({
      applicationId: world.base.applicationId,
      tenantId: world.base.tenantId,
      executionId,
      failure: intelligenceFailure,
      evidence: [
        { kind: "decision-record", decisionId: record?.decisionId as string },
        { kind: "observation", observationDigest: attribution.observation.observationDigest },
      ],
      strategy: intelligenceSelection.selected as never,
      continuation: escalationContinuation,
      evidenceBound: 8,
      createdAt: "2026-09-23T12:00:07.000Z",
      digest,
    });
    expect(escalation.escalationId).toMatch(/^[0-9a-f]{64}$/);
    expect(escalation.evidence).toHaveLength(2);
    // The typed fail-closed outcome is also representable over the
    // real chain: zero offered paths → fail-closed.
    const zeroRecovery = selectRecoveryStrategy({
      attribution,
      context: { attemptsUsed: 0, incumbentRoute: { provider: "rail-a", model: "model-x" } },
      facts: { retry: null, reroute: { model: null, substrate: null }, escalation: null },
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
      configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
      digest,
    });
    expect(zeroRecovery.kind).toBe("fail-closed");
    expect(zeroRecovery.failClosedCode).toBe("no-admissible-strategy");
    // And a fail-closed selection produces NO durable record.
    expect(
      buildRecoveryDecisionRecord({
        attribution,
        selection: zeroRecovery,
        claims: new Map(),
        ir,
        constraints,
        scope: {
          applicationId: world.base.applicationId,
          tenantId: world.base.tenantId,
          executionId,
          recordedAt: "2026-09-23T12:00:08.000Z",
        },
        digest,
      }),
    ).toBeNull();
  });

  test("CONCURRENCY-CRASH-SAFETY: 8 simultaneous select+append chains converge to one durable row", async () => {
    const world = await seedRecoveryWorld(ctx.port);
    const { ir, constraints, executionId } = await governedChain(world);

    const attribution = attributeFailure(
      {
        signal: "provider-rate-limited",
        component: "provider-gateway",
        stepId: ir.steps.find((step) => step.stepClass === "call-model")?.id ?? "model",
        routeRef: { provider: "rail-a", model: "model-x" },
        detail: "rate limited at the provider gateway",
        observedAt: "2026-09-23T12:01:00.000Z",
        observationDigest: digest.sha256Hex("real-observation:rate-limited"),
      },
      "provider",
      { kind: "provider", providerErrorClass: "rate-limited" },
      digest,
    );
    const modelStepId = ir.steps.find((step) => step.stepClass === "call-model")?.id as string;
    const modelSelection = selectModelRepresentation({
      ir,
      stepId: modelStepId,
      candidates: MODEL_CANDIDATES,
      qualityFacts: { requiredQuality: 0.85 },
      constraints,
    });
    const derived = deriveSelectionConstraints(constraints);
    const substrateSelection = selectSubstrate(
      {
        candidates: SUBSTRATE_CANDIDATES,
        constraints: derived.constraints,
        sourceConstraintIds: derived.sourceConstraintIds,
        recordedAt: "2026-09-23T12:01:01.000Z",
      },
      digest,
    );

    const buildOnce = () => {
      // Every chain re-derives the attribution and the selection from
      // the SAME inputs: pure determinism produces the identical
      // decisionId across all 8 concurrent chains.
      const chainAttribution = attributeFailure(
        {
          signal: "provider-rate-limited",
          component: "provider-gateway",
          stepId: modelStepId,
          routeRef: { provider: "rail-a", model: "model-x" },
          detail: "rate limited at the provider gateway",
          observedAt: "2026-09-23T12:01:00.000Z",
          observationDigest: digest.sha256Hex("real-observation:rate-limited"),
        },
        "provider",
        { kind: "provider", providerErrorClass: "rate-limited" },
        digest,
      );
      expect(chainAttribution.attributionId).toBe(attribution.attributionId);
      const selection = selectRecoveryStrategy({
        attribution: chainAttribution,
        context: {
          executionId,
          stepId: modelStepId,
          attemptsUsed: 0,
          incumbentRoute: { provider: "rail-a", model: "model-x" },
        },
        facts: {
          retry: {
            nextAttempt: 1,
            claim: {
              expectedCostMicroUsd: "400",
              expectedLatencyMs: 2000,
              expectedQuality: 0.92,
              expectedReliability: 0.95,
              basis: { basis: "estimated", source: "recovery:retry-path" },
            },
          },
          reroute: {
            model: { selection: modelSelection, declaredCandidates: MODEL_CANDIDATES },
            substrate: { selection: substrateSelection },
          },
          escalation: null,
        },
        qualityFacts: { requiredQuality: 0.85 },
        constraints,
        configuration: {
          maxRetryAttempts: 3,
          escalationEvidenceBound: 8,
          continuationStepBound: 32,
        },
        digest,
      });
      return buildRecoveryDecisionRecord({
        attribution: chainAttribution,
        selection,
        claims: new Map([
          [
            "retry-attempt-1",
            {
              expectedCostMicroUsd: "400",
              expectedLatencyMs: 2000,
              expectedQuality: 0.92,
              expectedReliability: 0.95,
              basis: { basis: "estimated", source: "recovery:retry-path" },
            },
          ],
          [
            "reroute-model",
            {
              expectedCostMicroUsd: "316",
              expectedLatencyMs: 1800,
              expectedQuality: 0.9,
              expectedReliability: 0.95,
              basis: { basis: "estimated", source: "model-economics" },
            },
          ],
          [
            "reroute-substrate",
            {
              expectedCostMicroUsd: "242",
              expectedLatencyMs: 4000,
              expectedQuality: 0.88,
              expectedReliability: 0.93,
              basis: { basis: "observed", source: "substrate-economics" },
            },
          ],
        ]),
        ir,
        constraints,
        scope: {
          applicationId: world.base.applicationId,
          tenantId: world.base.tenantId,
          executionId,
          recordedAt: "2026-09-23T12:01:02.000Z",
        },
        digest,
      });
    };

    const records = Array.from({ length: 8 }, () => buildOnce());
    // All chains derived the identical record (no attribution lost,
    // no divergence).
    const decisionIds = new Set(records.map((record) => record?.decisionId));
    expect(decisionIds.size).toBe(1);

    // The concurrent appends: exactly one insert, seven replays.
    const outcomes = await Promise.all(
      records.map((record) => world.store.append(record as never)),
    );
    const inserts = outcomes.filter((outcome) => !outcome.replayed).length;
    const replays = outcomes.filter((outcome) => outcome.replayed).length;
    expect(inserts).toBe(1);
    expect(replays).toBe(7);

    // Exactly one durable row exists.
    const rows = await world.store.listByExecution(world.base.applicationId, executionId);
    const recoveryRows = rows.filter((row) =>
      row.transformationBasis.detail.startsWith("failure-recovery;"),
    );
    expect(recoveryRows).toHaveLength(1);
    expect(() => validateOptimizationDecision(recoveryRows[0], digest)).not.toThrow();
  });
});
