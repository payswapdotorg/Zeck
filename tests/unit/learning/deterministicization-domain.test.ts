/**
 * Unit: the deterministicization domain model + discovery + promotion
 * gate (learning module domain; WORK-021 / DTR-001, DTR-002, DTR-004).
 *
 * Proves the closed-shape validation vocabulary and the pure functions:
 *
 *  - the five candidate classes and the lifecycle status vocabulary;
 *  - candidate validation fail-closes on: missing provenance (the
 *    identity requirement), missing incumbent binding, missing
 *    explicit acceptance criterion, missing program for non-removal
 *    classes, non-pure compute declarations, egress/host mismatch;
 *  - the candidate identity basis is content-derived and stable
 *    (equal basis ⇒ equal identity inputs; any semantic change
 *    diverges);
 *  - discovery: recurrence mining over validated telemetry — AI-work
 *    filtering (generative/hybrid only), provenance retention
 *    (source executions + evidence refs + window), deterministic
 *    DESC-cost ordering, the recurrence floor, task-class filtering;
 *  - the promotion gate: fail-closed on every axis — missing stage
 *    evidence, insufficient-stage records, below-floor populations,
 *    differential acceptance, property pass rate, surviving mutants,
 *    live rollouts, canary match rate, quality degradation; and the
 *    honest ALL-green verdict with the evidence bindings returned.
 */

import { describe, expect, test } from "vitest";
import {
  AI_COMPUTATION_TYPES,
  CANDIDATE_STATUS_TRANSITIONS,
  candidateIdentityBasis,
  DEFAULT_DISCOVERY_CONFIG,
  DEFAULT_PROMOTION_GATE_CONFIG,
  DETERMINISTICIZATION_CANDIDATE_CLASSES,
  DETERMINISTICIZATION_CANDIDATE_STATUSES,
  type DeterministicizationCandidate,
  discoverDeterminizationCandidates,
  discoveryCorpusBasis,
  type ExecutionOutcomeTelemetry,
  evaluatePromotionGate,
  type PromotionDecisionRecord,
  promotionGateConfigBasis,
  type ReplacementContract,
  type RolloutRecord,
  type StageEvidenceRecord,
  stageEvidenceIdentityBasis,
  VALIDATION_STAGE_KINDS,
  type ValidationRunObservation,
  validateDeterministicizationCandidate,
  validatePromotionDecisionRecord,
  validateReplacementContract,
  validateRolloutRecord,
  validateStageEvidenceRecord,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
const TENANT_ID = "00000000-0000-7000-8000-0000000000f2";

function expectTyped(block: () => unknown, messagePart: string): void {
  try {
    block();
    expect.unreachable("expected a typed failure");
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).message).toContain(messagePart);
  }
}

// ---------------------------------------------------------------------------
// Fixtures (validated shapes).
// ---------------------------------------------------------------------------

function validContract(): ReplacementContract {
  return {
    inputFields: [{ name: "value", type: "number", required: true }],
    outputFields: [{ name: "doubled", type: "number", required: true }],
    acceptanceCriterion: {
      kind: "exact-output",
      description: "the replacement must reproduce the incumbent output exactly on the corpus",
    },
    compute: {
      pureComputeOnly: true,
      networkEgress: "none",
      allowedHosts: [],
      timeoutMs: 5000,
    },
  };
}

function validCandidate(): DeterministicizationCandidate {
  return {
    candidateId: "a".repeat(64),
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateClass: "deterministic-replacement",
    status: "proposed",
    subgraph: {
      subgraphId: "sg-normalize-entity",
      stepPath: ["plan", "normalize-entity"],
      computationType: "generative",
      taskClass: "summarize",
      routes: [{ provider: "rail-a", model: "model-x" }],
      tools: [],
    },
    provenance: {
      sourceExecutionIds: ["exec-1", "exec-2", "exec-3", "exec-4", "exec-5", "exec-6"],
      evidenceRefs: ["ev-1", "ev-2"],
      corpusDigest: "b".repeat(64),
      windowFrom: "2026-09-01T00:00:00Z",
      windowTo: "2026-09-02T00:00:00Z",
      population: 6,
    },
    recurrence: { occurrenceCount: 6, totalCostMicroUsd: "1200", errorRate: 0 },
    incumbent: {
      strategyClass: "generative-route",
      routes: [{ provider: "rail-a", model: "model-x" }],
      descriptionDigest: "c".repeat(64),
      rollbackTarget: "incumbent:generative-route@v1",
    },
    contract: validContract(),
    program: { language: "javascript-v1", source: "console.log(1)", sourceDigest: "d".repeat(64) },
    proposedBy: "agent-1",
    proposedAt: "2026-09-03T00:00:00Z",
    schemaVersion: 1,
  };
}

function validRuns(count: number): ValidationRunObservation[] {
  return Array.from({ length: count }, (_, index) => ({
    runKey: `run-${index}`,
    sandboxExecutionId: `sbx-${index}`,
    inputDigest: `${index}`.padEnd(64, "0"),
    outputDigest: "e".repeat(64),
    outcome: "success" as const,
    failureClass: null,
    costMicroUsd: "10",
    latencyMs: 12,
  }));
}

function validPairs(count: number): StageEvidenceRecord["pairs"] {
  return Array.from({ length: count }, (_, index) => ({
    inputDigest: `${index}`.padEnd(64, "1"),
    incumbentOutputDigest: "4".repeat(64),
    replacementOutputDigest: "5".repeat(64),
    accepted: true,
  }));
}

function validEvidence(
  stageKind: (typeof VALIDATION_STAGE_KINDS)[number],
  overrides: Partial<StageEvidenceRecord> = {},
): StageEvidenceRecord {
  const isDifferential = stageKind === "differential-evaluation";
  const runs = isDifferential ? validRuns(24) : validRuns(24);
  const pairs = isDifferential ? validPairs(24) : [];
  const population = isDifferential ? 24 : 24;
  return {
    evidenceId: "f".repeat(64),
    candidateId: "a".repeat(64),
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    stageKind,
    status: "passed",
    basis: {
      corpusDigest: "b".repeat(64),
      sourceExecutionIds: ["exec-1"],
      population: 6,
    },
    runs,
    pairs,
    metrics: {
      population,
      acceptedCount: population,
      rejectedCount: 0,
      acceptanceRate: 1,
      incumbentCostMicroUsd: isDifferential ? "4800" : null,
      replacementCostMicroUsd: "240",
      costDeltaMicroUsd: isDifferential ? "4560" : null,
      replacementLatencyMeanMs: 12,
      propertyPassCount: stageKind === "property-tests" ? population : null,
      propertyFailCount: stageKind === "property-tests" ? 0 : null,
      mutationCaughtCount: stageKind === "mutation-tests" ? population : null,
      mutationMissedCount: stageKind === "mutation-tests" ? 0 : null,
    },
    criterionDigest: "1".repeat(64),
    evidenceRefs: ["ev-1"],
    recordedAt: "2026-09-04T00:00:00Z",
    recordedBy: "validator-1",
    schemaVersion: 1,
    ...overrides,
  };
}

function validRollout(mode: "shadow" | "canary"): RolloutRecord {
  return {
    rolloutId: "2".repeat(64),
    candidateId: "a".repeat(64),
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    mode,
    status: "concluded",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "600",
    qualityDelta: 1,
    latencyDeltaMs: -40,
    evidenceRefs: ["ev-rollout"],
    beganAt: "2026-09-05T00:00:00Z",
    concludedAt: "2026-09-06T00:00:00Z",
    schemaVersion: 1,
  };
}

// ---------------------------------------------------------------------------
// The candidate classes + lifecycle vocabulary.
// ---------------------------------------------------------------------------

describe("deterministicization domain: candidate vocabulary", () => {
  test("the five contract candidate classes are exactly the closed vocabulary", () => {
    expect([...DETERMINISTICIZATION_CANDIDATE_CLASSES]).toEqual([
      "removal",
      "deterministic-replacement",
      "hybrid-split",
      "pipeline-replacement",
      "tool-extraction",
    ]);
  });

  test("the lifecycle status vocabulary and forward-only transitions", () => {
    expect([...DETERMINISTICIZATION_CANDIDATE_STATUSES]).toEqual([
      "proposed",
      "validating",
      "validated",
      "shadow",
      "canary",
      "promoted",
      "rejected",
      "deferred",
      "rolled-back",
    ]);
    // forward-only pipeline: proposed → validating → validated → shadow → canary → promoted
    expect(CANDIDATE_STATUS_TRANSITIONS.proposed).toContain("validating");
    expect(CANDIDATE_STATUS_TRANSITIONS.validating).toContain("validated");
    expect(CANDIDATE_STATUS_TRANSITIONS.validated).toContain("shadow");
    expect(CANDIDATE_STATUS_TRANSITIONS.shadow).toContain("canary");
    expect(CANDIDATE_STATUS_TRANSITIONS.canary).toContain("promoted");
    // rollback: promoted → rolled-back (the reversible production path)
    expect(CANDIDATE_STATUS_TRANSITIONS.promoted).toEqual(["rolled-back"]);
    // rejected is terminal; deferred re-enters validation
    expect(CANDIDATE_STATUS_TRANSITIONS.rejected).toEqual([]);
    expect(CANDIDATE_STATUS_TRANSITIONS.deferred).toContain("validating");
  });
});

// ---------------------------------------------------------------------------
// Candidate validation (fail closed).
// ---------------------------------------------------------------------------

describe("deterministicization domain: candidate validation", () => {
  test("a fully-shaped candidate validates", () => {
    expect(() => validateDeterministicizationCandidate(validCandidate())).not.toThrow();
  });

  test("a candidate class outside the closed vocabulary is rejected", () => {
    const candidate = { ...validCandidate(), candidateClass: "magic-replacement" };
    expectTyped(
      () => validateDeterministicizationCandidate(candidate),
      "candidate class must be the closed five-class vocabulary",
    );
  });

  test("PROVENANCE IS IDENTITY: a candidate without source-execution provenance is unrepresentable", () => {
    const candidate = validCandidate();
    const provenance = { ...candidate.provenance, sourceExecutionIds: [] };
    expectTyped(
      () => validateDeterministicizationCandidate({ ...candidate, provenance }),
      "provenance sourceExecutionIds",
    );
  });

  test("a candidate without the evaluation-corpus digest is unrepresentable", () => {
    const candidate = validCandidate();
    const provenance = { ...candidate.provenance, corpusDigest: "" };
    expectTyped(
      () => validateDeterministicizationCandidate({ ...candidate, provenance }),
      "provenance corpusDigest",
    );
  });

  test("a candidate without the incumbent binding (the differential baseline) is rejected", () => {
    const candidate = validCandidate();
    expectTyped(
      () => validateDeterministicizationCandidate({ ...candidate, incumbent: undefined }),
      "incumbent binding is MANDATORY",
    );
  });

  test("the differential requirement is EXPLICIT: a contract without an acceptance criterion is rejected", () => {
    const contract = { ...validContract(), acceptanceCriterion: undefined };
    expectTyped(() => validateReplacementContract(contract), "acceptanceCriterion is MANDATORY");
  });

  test("a non-removal candidate without a replacement program is unrepresentable", () => {
    const candidate = { ...validCandidate(), program: null };
    expectTyped(
      () => validateDeterministicizationCandidate(candidate),
      "MUST carry a replacement program",
    );
  });

  test("a removal candidate may carry no program", () => {
    const candidate = { ...validCandidate(), candidateClass: "removal", program: null };
    expect(() => validateDeterministicizationCandidate(candidate)).not.toThrow();
  });

  test("the replacement must declare pure compute", () => {
    const contract = validContract();
    const compute = { ...contract.compute, pureComputeOnly: false };
    expectTyped(
      () => validateReplacementContract({ ...contract, compute } as never),
      "pureComputeOnly",
    );
  });

  test("egress 'none' with declared hosts is rejected (confinement basis honesty)", () => {
    const contract = validContract();
    const compute = { ...contract.compute, allowedHosts: ["example.internal"] };
    expectTyped(
      () => validateReplacementContract({ ...contract, compute }),
      "allowedHosts must match the declared egress mode",
    );
  });

  test("the candidate identity basis is content-derived: identical basis ⇒ identical object", () => {
    const candidate = validCandidate();
    const basisOne = candidateIdentityBasis(candidate);
    const basisTwo = candidateIdentityBasis({ ...validCandidate() });
    expect(basisOne).toEqual(basisTwo);
    // any semantic change diverges the basis
    const changed = {
      ...candidate,
      provenance: { ...candidate.provenance, population: 7 },
    };
    expect(candidateIdentityBasis(changed)).not.toEqual(basisOne);
    // the program source is NOT the basis (the digest is)
    const sameDigestDifferentSource = {
      ...candidate,
      program:
        candidate.program === null ? null : { ...candidate.program, source: "console.log(2)" },
    };
    expect(candidateIdentityBasis(sameDigestDifferentSource)).toEqual(basisOne);
  });

  test("the stage-evidence identity basis is content-derived over runs/pairs", () => {
    const runs = validRuns(3);
    const one = stageEvidenceIdentityBasis({
      candidateId: "a".repeat(64),
      stageKind: "offline-replay",
      corpusDigest: "b".repeat(64),
      runs,
      pairs: [],
    });
    const two = stageEvidenceIdentityBasis({
      candidateId: "a".repeat(64),
      stageKind: "offline-replay",
      corpusDigest: "b".repeat(64),
      runs,
      pairs: [],
    });
    expect(one).toEqual(two);
  });
});

// ---------------------------------------------------------------------------
// Stage evidence + rollout + decision validation.
// ---------------------------------------------------------------------------

describe("deterministicization domain: evidence/rollout/decision validation", () => {
  test("passing evidence records validate per stage", () => {
    for (const stage of VALIDATION_STAGE_KINDS) {
      expect(() => validateStageEvidenceRecord(validEvidence(stage))).not.toThrow();
    }
  });

  test("a run observation WITHOUT the sandbox execution identity is unrepresentable", () => {
    const evidence = validEvidence("offline-replay");
    const runs = evidence.runs.map((run) => ({ ...run, sandboxExecutionId: "" }));
    expectTyped(() => validateStageEvidenceRecord({ ...evidence, runs }), "run sandboxExecutionId");
  });

  test("differential pairs are ONLY representable on differential evaluation evidence", () => {
    const pairs = [
      {
        inputDigest: "3".repeat(64),
        incumbentOutputDigest: "4".repeat(64),
        replacementOutputDigest: "5".repeat(64),
        accepted: true,
      },
    ];
    const evidence = validEvidence("offline-replay", { pairs });
    expectTyped(
      () => validateStageEvidenceRecord(evidence),
      "pairs are only representable on differential evaluation evidence",
    );
    const differential = validEvidence("differential-evaluation", { pairs });
    expect(() => validateStageEvidenceRecord(differential)).not.toThrow();
  });

  test("no evidence is recorded as no evidence: runs may be empty only when status is insufficient", () => {
    const insufficient = validEvidence("offline-replay", {
      status: "insufficient",
      runs: [],
      metrics: {
        population: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        acceptanceRate: 0,
        incumbentCostMicroUsd: null,
        replacementCostMicroUsd: null,
        costDeltaMicroUsd: null,
        replacementLatencyMeanMs: null,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    expect(() => validateStageEvidenceRecord(insufficient)).not.toThrow();
    const passed = validEvidence("offline-replay", { runs: [] });
    expectTyped(
      () => validateStageEvidenceRecord(passed),
      "runs must be non-empty unless the honest status is 'insufficient'",
    );
  });

  test("an observing rollout must not carry concludedAt; a concluded one must", () => {
    const observing = validRollout("shadow");
    expectTyped(
      () =>
        validateRolloutRecord({
          ...observing,
          status: "observing",
          population: 0,
          matchedCount: 0,
          concludedAt: "2026-09-06T00:00:00Z",
        }),
      "an observing rollout must not carry concludedAt",
    );
    const concluded = validRollout("canary");
    expectTyped(
      () => validateRolloutRecord({ ...concluded, population: 0, matchedCount: 0 }),
      "a concluded rollout must carry a positive population",
    );
  });

  test("every decision carries its rationale (DTR-004); gate verdict and kind must agree", () => {
    const decision: PromotionDecisionRecord = {
      decisionId: "6".repeat(64),
      candidateId: "a".repeat(64),
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      kind: "rejected",
      rationale: "the differential acceptance rate was below the configured floor",
      gate: {
        gateConfigDigest: "7".repeat(64),
        verdict: "not-promoted",
        reasons: ["differential-acceptance: rate 0.500 is below the configured minimum 0.95"],
        stageEvidenceIds: [],
        rolloutIds: [],
        evaluatedAt: "2026-09-07T00:00:00Z",
      },
      incumbentRestoredTo: null,
      decidedBy: "architect-1",
      decidedAt: "2026-09-07T00:00:00Z",
      schemaVersion: 1,
    };
    expect(() => validatePromotionDecisionRecord(decision)).not.toThrow();
    expectTyped(() => validatePromotionDecisionRecord({ ...decision, rationale: "" }), "rationale");
    // a promoted decision with a fail-closed gate is unrepresentable
    expectTyped(
      () =>
        validatePromotionDecisionRecord({
          ...decision,
          kind: "promoted",
        }),
      "decision kind must agree with the gate verdict",
    );
    // only rollback decisions record the incumbent restoration target
    expectTyped(
      () =>
        validatePromotionDecisionRecord({
          ...decision,
          incumbentRestoredTo: "incumbent:generative-route@v1",
        }),
      "only rollback decisions record an incumbent restoration target",
    );
  });

  test("a rollback decision must record the incumbent restoration target", () => {
    const rollback: PromotionDecisionRecord = {
      decisionId: "8".repeat(64),
      candidateId: "a".repeat(64),
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      kind: "rolled-back",
      rationale: "canary quality degraded beyond the configured maximum",
      gate: {
        gateConfigDigest: "9".repeat(64),
        verdict: "not-promoted",
        reasons: ["quality-degradation"],
        stageEvidenceIds: [],
        rolloutIds: [],
        evaluatedAt: "2026-09-07T00:00:00Z",
      },
      incumbentRestoredTo: null,
      decidedBy: "architect-1",
      decidedAt: "2026-09-07T00:00:00Z",
      schemaVersion: 1,
    };
    expectTyped(
      () => validatePromotionDecisionRecord(rollback),
      "rollback decision must record the incumbent restoration target",
    );
  });
});

// ---------------------------------------------------------------------------
// Discovery (DTR-001).
// ---------------------------------------------------------------------------

function telemetryDatum(overrides: {
  readonly index: number;
  readonly taskClass?: string;
  readonly subgraphId?: string;
  readonly computationType?: string;
  readonly outcome?: ExecutionOutcomeTelemetry["outcome"];
  readonly costMicroUsd?: string;
}): ExecutionOutcomeTelemetry {
  const { index } = overrides;
  return {
    telemetryId: `tel-${index}`,
    executionId: `exec-${index}`,
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    taskClass: overrides.taskClass ?? "summarize",
    capabilities: ["text-generation"],
    planId: `plan-${index}`,
    planRevision: 1,
    strategyClass: "generative-route",
    routes: [{ provider: "rail-a", model: "model-x" }],
    tools: [],
    environments: [],
    verification: {
      resultIds: [],
      statuses: [],
      evaluatorIds: [],
      passCount: 0,
      failCount: 0,
      inconclusiveCount: 0,
      verified: null,
    },
    costMicroUsd: overrides.costMicroUsd ?? "200",
    latencyMs: 150,
    outcome: overrides.outcome ?? "execution-completed",
    recordedAt: `2026-09-0${(index % 8) + 1}T12:00:00Z`,
    evidenceRefs: [`ev-${index}`],
    subgraphs: [
      {
        subgraphId: overrides.subgraphId ?? "sg-normalize-entity",
        stepPath: ["plan", "normalize-entity"],
        computationType: overrides.computationType ?? "generative",
      },
    ],
    schemaVersion: 1,
  };
}

describe("deterministicization discovery (DTR-001)", () => {
  test("AI_COMPUTATION_TYPES is exactly generative + hybrid", () => {
    expect([...AI_COMPUTATION_TYPES]).toEqual(["generative", "hybrid"]);
  });

  test("recurring AI subgraphs are mined with FULL provenance and honest recurrence", () => {
    const population = Array.from({ length: 6 }, (_, index) =>
      telemetryDatum({ index, outcome: index === 3 ? "execution-failed" : "execution-completed" }),
    );
    const discovered = discoverDeterminizationCandidates(population);
    expect(discovered).toHaveLength(1);
    const subgraph = discovered[0] as unknown as Record<string, unknown>;
    expect(subgraph.subgraphId).toBe("sg-normalize-entity");
    expect(subgraph.occurrenceCount).toBe(6);
    expect(subgraph.errorRate).toBeCloseTo(1 / 6);
    expect(subgraph.totalCostMicroUsd).toBe("1200");
    expect(subgraph.sourceExecutionIds).toHaveLength(6);
    expect(subgraph.evidenceRefs).toHaveLength(6);
    expect(subgraph.strong).toBe(true);
    expect(
      (subgraph.reasonCodes as readonly string[]).some((code) => code.startsWith("recurrence:")),
    );
  });

  test("deterministic/retrieval subgraphs are NOT AI work (no discovery)", () => {
    const population = Array.from({ length: 6 }, (_, index) =>
      telemetryDatum({ index, computationType: "deterministic" }),
    );
    expect(discoverDeterminizationCandidates(population)).toEqual([]);
  });

  test("the recurrence floor filters sub-graphs below it (recurring means recurring)", () => {
    const population = Array.from({ length: 4 }, (_, index) => telemetryDatum({ index }));
    expect(discoverDeterminizationCandidates(population)).toEqual([]);
    expect(discoverDeterminizationCandidates(population, { minimumRecurrence: 4 })).toHaveLength(1);
  });

  test("a sub-graph below the DEFAULT floor is discovered as weak when the configured floor allows it", () => {
    const population = Array.from({ length: 4 }, (_, index) => telemetryDatum({ index }));
    const discovered = discoverDeterminizationCandidates(population, { minimumRecurrence: 3 });
    expect(discovered).toHaveLength(1);
    expect((discovered[0] as unknown as Record<string, unknown>).strong).toBe(false);
  });

  test("task-class filtering partitions the population (per-class recurrence)", () => {
    const population = [
      ...Array.from({ length: 5 }, (_, index) => telemetryDatum({ index, taskClass: "summarize" })),
      ...Array.from({ length: 5 }, (_, index) =>
        telemetryDatum({ index: index + 5, taskClass: "translate" }),
      ),
    ];
    expect(
      discoverDeterminizationCandidates(population, {
        ...DEFAULT_DISCOVERY_CONFIG,
        taskClass: "summarize",
      }),
    ).toHaveLength(1);
    expect(discoverDeterminizationCandidates(population)).toHaveLength(2);
  });

  test("ordering is DESC aggregated observed cost, then subgraph id (deterministic)", () => {
    const population = [
      ...Array.from({ length: 5 }, (_, index) =>
        telemetryDatum({ index, subgraphId: "sg-cheap", costMicroUsd: "10" }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        telemetryDatum({ index: index + 5, subgraphId: "sg-costly", costMicroUsd: "900" }),
      ),
    ];
    const discovered = discoverDeterminizationCandidates(population);
    expect(discovered.map((entry) => entry.subgraphId)).toEqual(["sg-costly", "sg-cheap"]);
  });

  test("the discovery corpus basis is content-derived (the candidate identity binds to it)", () => {
    const basis = discoveryCorpusBasis({
      subgraphId: "sg-normalize-entity",
      taskClass: "summarize",
      computationType: "generative",
      sourceExecutionIds: ["exec-1", "exec-2"],
      evidenceRefs: ["ev-1", "ev-2"],
      windowFrom: "2026-09-01T00:00:00Z",
      windowTo: "2026-09-02T00:00:00Z",
    });
    expect(basis.corpusSchema).toBe(1);
    expect(basis.sourceExecutionIds).toEqual(["exec-1", "exec-2"]);
  });

  test("the default discovery config is the shipped floor", () => {
    expect(DEFAULT_DISCOVERY_CONFIG.minimumRecurrence).toBe(5);
  });

  test("an invalid discovery config fails closed", () => {
    expectTyped(
      () => discoverDeterminizationCandidates([], { minimumRecurrence: 0 }),
      "minimumRecurrence must be a positive integer",
    );
  });
});

// ---------------------------------------------------------------------------
// The promotion gate (DTR-002 fail-closed evaluation).
// ---------------------------------------------------------------------------

function gateInput(
  overrides: {
    readonly candidateStatus?: DeterministicizationCandidate["status"];
    readonly stageEvidence?: readonly StageEvidenceRecord[];
    readonly rollouts?: readonly RolloutRecord[];
  } = {},
) {
  return {
    candidate: { ...validCandidate(), status: overrides.candidateStatus ?? "canary" },
    stageEvidence:
      overrides.stageEvidence ?? VALIDATION_STAGE_KINDS.map((stage) => validEvidence(stage)),
    rollouts: overrides.rollouts ?? [validRollout("shadow"), validRollout("canary")],
    config: DEFAULT_PROMOTION_GATE_CONFIG,
  };
}

describe("deterministicization promotion gate (DTR-002)", () => {
  test("the all-green evidence package promotes with its revision bindings", () => {
    const evaluation = evaluatePromotionGate(gateInput());
    expect(evaluation.verdict).toBe("promote");
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.stageEvidenceIds).toHaveLength(4);
    expect(evaluation.rolloutIds).toHaveLength(2);
  });

  test("a candidate not in the canary phase never promotes (shadow/canary before promotion)", () => {
    const evaluation = evaluatePromotionGate(gateInput({ candidateStatus: "validated" }));
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain(
      "promotion requires the completed shadow and canary phases",
    );
  });

  test("MISSING stage evidence fails closed (unknown evidence never promotes)", () => {
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: VALIDATION_STAGE_KINDS.slice(0, 3).map((stage) => validEvidence(stage)),
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("no mutation-tests evidence record exists");
  });

  test("an INSUFFICIENT stage record fails closed exactly like a missing one", () => {
    const insufficient = validEvidence("offline-replay", {
      status: "insufficient",
      runs: [],
      metrics: {
        population: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        acceptanceRate: 0,
        incumbentCostMicroUsd: null,
        replacementCostMicroUsd: null,
        costDeltaMicroUsd: null,
        replacementLatencyMeanMs: null,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: [
          insufficient,
          validEvidence("differential-evaluation"),
          validEvidence("property-tests"),
          validEvidence("mutation-tests"),
        ],
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("honestly records insufficiency");
  });

  test("FAILED stage evidence blocks promotion", () => {
    const failed = validEvidence("property-tests", {
      status: "failed",
      metrics: {
        population: 4,
        acceptedCount: 3,
        rejectedCount: 1,
        acceptanceRate: 0.75,
        incumbentCostMicroUsd: null,
        replacementCostMicroUsd: null,
        costDeltaMicroUsd: null,
        replacementLatencyMeanMs: null,
        propertyPassCount: 3,
        propertyFailCount: 1,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: [
          validEvidence("offline-replay"),
          validEvidence("differential-evaluation"),
          failed,
          validEvidence("mutation-tests"),
        ],
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("failed-evidence");
  });

  test("below-floor populations fail closed (evidence is never amplified)", () => {
    const small = validEvidence("offline-replay", {
      metrics: {
        population: 5,
        acceptedCount: 5,
        rejectedCount: 0,
        acceptanceRate: 1,
        incumbentCostMicroUsd: null,
        replacementCostMicroUsd: null,
        costDeltaMicroUsd: null,
        replacementLatencyMeanMs: null,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: [
          small,
          validEvidence("differential-evaluation"),
          validEvidence("property-tests"),
          validEvidence("mutation-tests"),
        ],
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("population 5 is below the configured floor 20");
  });

  test("a surviving mutant blocks promotion (mutation discrimination)", () => {
    const missed = validEvidence("mutation-tests", {
      metrics: {
        population: 4,
        acceptedCount: 3,
        rejectedCount: 1,
        acceptanceRate: 0.75,
        incumbentCostMicroUsd: null,
        replacementCostMicroUsd: null,
        costDeltaMicroUsd: null,
        replacementLatencyMeanMs: null,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: 3,
        mutationMissedCount: 1,
      },
    });
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: [
          validEvidence("offline-replay"),
          validEvidence("differential-evaluation"),
          validEvidence("property-tests"),
          missed,
        ],
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("mutant(s) survived");
  });

  test("a live rollout never promotes; a degraded canary never promotes", () => {
    const observing = {
      ...validRollout("shadow"),
      status: "observing" as const,
      concludedAt: null,
    };
    const evaluation = evaluatePromotionGate(
      gateInput({ rollouts: [observing, validRollout("canary")] }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("shadow rollout is still observing");

    const degraded = { ...validRollout("canary"), matchedCount: 11, qualityDelta: 11 / 12 };
    const evaluationTwo = evaluatePromotionGate(
      gateInput({ rollouts: [validRollout("shadow"), degraded] }),
    );
    expect(evaluationTwo.verdict).toBe("not-promoted");
    expect(evaluationTwo.reasons.join(" ")).toContain("quality-degradation");
  });

  test("the differential acceptance rate floor is enforced", () => {
    const differential = validEvidence("differential-evaluation", {
      pairs: [
        {
          inputDigest: "3".repeat(64),
          incumbentOutputDigest: "4".repeat(64),
          replacementOutputDigest: "5".repeat(64),
          accepted: true,
        },
      ],
      metrics: {
        population: 24,
        acceptedCount: 22,
        rejectedCount: 2,
        acceptanceRate: 22 / 24,
        incumbentCostMicroUsd: "400",
        replacementCostMicroUsd: "10",
        costDeltaMicroUsd: "390",
        replacementLatencyMeanMs: 8,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    const evaluation = evaluatePromotionGate(
      gateInput({
        stageEvidence: [
          validEvidence("offline-replay"),
          differential,
          validEvidence("property-tests"),
          validEvidence("mutation-tests"),
        ],
      }),
    );
    expect(evaluation.verdict).toBe("not-promoted");
    expect(evaluation.reasons.join(" ")).toContain("differential-acceptance");
  });

  test("the thresholds are CONFIGURABLE (a relaxed config promotes the same evidence)", () => {
    const differential = validEvidence("differential-evaluation", {
      pairs: [
        {
          inputDigest: "3".repeat(64),
          incumbentOutputDigest: "4".repeat(64),
          replacementOutputDigest: "5".repeat(64),
          accepted: true,
        },
      ],
      metrics: {
        population: 20,
        acceptedCount: 18,
        rejectedCount: 2,
        acceptanceRate: 0.9,
        incumbentCostMicroUsd: "400",
        replacementCostMicroUsd: "10",
        costDeltaMicroUsd: "390",
        replacementLatencyMeanMs: 8,
        propertyPassCount: null,
        propertyFailCount: null,
        mutationCaughtCount: null,
        mutationMissedCount: null,
      },
    });
    const evidence = [
      validEvidence("offline-replay"),
      differential,
      validEvidence("property-tests"),
      validEvidence("mutation-tests"),
    ];
    const relaxed = evaluatePromotionGate({
      candidate: { ...validCandidate(), status: "canary" },
      stageEvidence: evidence,
      rollouts: [validRollout("shadow"), validRollout("canary")],
      config: { ...DEFAULT_PROMOTION_GATE_CONFIG, minimumAcceptanceRate: 0.85 },
    });
    expect(relaxed.verdict).toBe("promote");
  });

  test("a gate config basis is revision-bound (digestable)", () => {
    expect(promotionGateConfigBasis(DEFAULT_PROMOTION_GATE_CONFIG).gateConfigSchema).toBe(1);
  });
});
