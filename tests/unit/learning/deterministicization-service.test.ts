/**
 * Unit: the deterministicization lifecycle service (learning module
 * application; WORK-021 / DTR-001..DTR-004) over the in-memory store.
 *
 * Proves the full governed lifecycle and its typed negative
 * guarantees:
 *
 *  - discovery reads ONLY the telemetry population (advisory, durable
 *    nothing);
 *  - candidate proposal: content-derived identity; retries CONVERGE
 *    (replayed); MANDATORY provenance fail-closes at the boundary;
 *  - stage evidence: honest status + metrics per stage; write-once per
 *    stage (a different basis for a settled stage is
 *    IDEMPOTENCY_KEY_REUSED); the lifecycle moves proposed →
 *    validating → validated as the four stages settle passing;
 *  - shadow/canary: the shadow phase requires a validated candidate;
 *    the canary phase requires a CONCLUDED shadow with an adequate
 *    population (fail closed); conclusions converge (first writer
 *    wins);
 *  - promotion: THE GATE — fail-closed on unknown/insufficient
 *    evidence (AC6's runtime red), promotes with the full gate
 *    evaluation + rationale; replay converges;
 *  - rejection/deferral/rollback: decisions carry rationale (DTR-004);
 *    a candidate whose evidence passes the gate is not rejectable as
 *    'rejected'; rollback restores the incumbent and the journal is
 *    append-only;
 *  - consultation: the advisory signal projection carries the
 *    promotion/rollback anchors; proposed/rejected candidates never
 *    cross the seam;
 *  - the durable operations ledger: one row per logical operation
 *    with a STABLE content-derived key; PENDING re-claims bump the
 *    attempts ledger; terminal rows replay without new side effects.
 */

import { describe, expect, test } from "vitest";
import {
  createDeterministicizationService,
  createDeterministicizationSignalSource,
  createNodeDigest,
  type DeterministicizationService,
  type ExecutionOutcomeTelemetry,
  InMemoryDeterministicizationStore,
} from "../../../src/modules/learning/public";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
const OTHER_APP_ID = "00000000-0000-7000-8000-0000000000f9";
const TENANT_ID = "00000000-0000-7000-8000-0000000000f2";

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `00000000-0000-7000-a000-${String(idCounter).padStart(12, "0")}`;
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse("2026-09-20T12:00:00Z") + tick++ * 1000);
}

function telemetryPopulation(count: number): ExecutionOutcomeTelemetry[] {
  return Array.from({ length: count }, (_, index) => ({
    telemetryId: `tel-${index}`,
    executionId: `exec-${index}`,
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    taskClass: "summarize",
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
    costMicroUsd: "200",
    latencyMs: 150,
    outcome: index === 4 ? "execution-failed" : "execution-completed",
    recordedAt: `2026-09-1${index % 9}T12:00:00Z`,
    evidenceRefs: [`ev-${index}`],
    subgraphs: [
      {
        subgraphId: "sg-normalize-entity",
        stepPath: ["plan", "normalize-entity"],
        computationType: "generative",
      },
    ],
    schemaVersion: 1,
  }));
}

interface ServiceWorld {
  readonly service: DeterministicizationService;
  readonly store: InMemoryDeterministicizationStore;
}

function world(
  telemetry: readonly ExecutionOutcomeTelemetry[] = telemetryPopulation(24),
): ServiceWorld {
  const store = new InMemoryDeterministicizationStore(telemetry);
  const service = createDeterministicizationService({
    store,
    digest: createNodeDigest(),
    generateId,
    now: clock(),
  });
  return { service, store };
}

const CONTRACT = {
  inputFields: [{ name: "value", type: "number" as const, required: true }],
  outputFields: [{ name: "doubled", type: "number" as const, required: true }],
  acceptanceCriterion: {
    kind: "exact-output" as const,
    description: "the replacement must reproduce the incumbent output exactly on the corpus",
  },
  compute: {
    pureComputeOnly: true as const,
    networkEgress: "none" as const,
    allowedHosts: [] as readonly string[],
    timeoutMs: 5000,
  },
};

function proposalRequest(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateClass: "deterministic-replacement" as const,
    subgraph: {
      subgraphId: "sg-normalize-entity",
      stepPath: ["plan", "normalize-entity"],
      computationType: "generative",
      taskClass: "summarize",
      routes: [{ provider: "rail-a", model: "model-x" }],
      tools: [],
    },
    provenance: {
      sourceExecutionIds: Array.from({ length: 24 }, (_, index) => `exec-${index}`),
      evidenceRefs: Array.from({ length: 6 }, (_, index) => `ev-${index}`),
      corpusDigest: "b".repeat(64),
      windowFrom: "2026-09-10T12:00:00Z",
      windowTo: "2026-09-18T12:00:00Z",
      population: 24,
    },
    recurrence: { occurrenceCount: 24, totalCostMicroUsd: "4800", errorRate: 1 / 24 },
    incumbent: {
      strategyClass: "generative-route",
      routes: [{ provider: "rail-a", model: "model-x" }],
      descriptionDigest: "c".repeat(64),
      rollbackTarget: "incumbent:generative-route@v1",
    },
    contract: CONTRACT,
    program: {
      language: "javascript-v1" as const,
      source: "console.log(JSON.stringify({ doubled: INPUT.value * 2 }));",
      sourceDigest: "d".repeat(64),
    },
    proposedBy: "agent-1",
    ...overrides,
  };
}

function stageRuns(count: number, outcome: "success" | "failure" = "success") {
  return Array.from({ length: count }, (_, index) => ({
    runKey: `run-${index}`,
    sandboxExecutionId: `sbx-${index}`,
    inputDigest: `${index}`.padEnd(64, "0"),
    outputDigest: outcome === "success" ? "e".repeat(64) : null,
    outcome,
    failureClass: outcome === "failure" ? "assertion-mismatch" : null,
    costMicroUsd: "10",
    latencyMs: 12,
  }));
}

function differentialPairs(count: number, accepted = true) {
  return Array.from({ length: count }, (_, index) => ({
    inputDigest: `${index}`.padStart(64, "0"),
    incumbentOutputDigest: "4".repeat(64),
    replacementOutputDigest: "5".repeat(64),
    accepted,
  }));
}

async function proposeFullCandidate(service: DeterministicizationService) {
  return service.proposeCandidate(proposalRequest());
}

async function driveToValidated(service: DeterministicizationService, candidateId: string) {
  await service.recordStageEvidence({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    stageKind: "offline-replay",
    runs: stageRuns(24),
    recordedBy: "validator-1",
  });
  await service.recordStageEvidence({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    stageKind: "differential-evaluation",
    runs: stageRuns(24),
    pairs: differentialPairs(24),
    incumbentCostMicroUsd: "4800",
    recordedBy: "validator-1",
  });
  await service.recordStageEvidence({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    stageKind: "property-tests",
    runs: stageRuns(24),
    recordedBy: "validator-1",
  });
  await service.recordStageEvidence({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    stageKind: "mutation-tests",
    runs: stageRuns(24, "failure"),
    recordedBy: "validator-1",
  });
}

async function driveToPromoted(service: DeterministicizationService, candidateId: string) {
  await driveToValidated(service, candidateId);
  await service.beginShadowRollout({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeShadowRollout({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    mode: "shadow",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2200",
    qualityDelta: 1,
    latencyDeltaMs: -140,
    evidenceRefs: ["ev-shadow"],
    requestedBy: "operator-1",
  });
  await service.beginCanaryPhase({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    requestedBy: "operator-1",
  });
  await service.concludeCanaryPhase({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    mode: "canary",
    population: 12,
    matchedCount: 12,
    costDeltaMicroUsd: "2100",
    qualityDelta: 1,
    latencyDeltaMs: -130,
    evidenceRefs: ["ev-canary"],
    requestedBy: "operator-1",
  });
  return service.applyPromotion({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    decidedBy: "architect-1",
  });
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

describe("deterministicization service: discovery (DTR-001)", () => {
  test("discovery reads the telemetry population and mines recurring AI subgraphs", async () => {
    const { service } = world();
    const { discovered, population } = await service.discoverCandidates({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(population).toBe(24);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.subgraphId).toBe("sg-normalize-entity");
    expect(discovered[0]?.sourceExecutionIds).toHaveLength(24);
  });

  test("discovery writes NOTHING durable (advisory only)", async () => {
    const { service, store } = world();
    await service.discoverCandidates({ applicationId: APP_ID, tenantId: TENANT_ID });
    expect(store.candidates.size).toBe(0);
    expect(store.stageEvidence.size).toBe(0);
    expect(store.operations.size).toBe(0);
  });

  test("discovery is scope-bound (another application sees nothing)", async () => {
    const { service } = world();
    const { discovered } = await service.discoverCandidates({
      applicationId: OTHER_APP_ID,
      tenantId: TENANT_ID,
    });
    expect(discovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Candidate proposal.
// ---------------------------------------------------------------------------

describe("deterministicization service: candidate proposal", () => {
  test("a proposal is durably registered with a content-derived identity", async () => {
    const { service } = world();
    const { candidate, replayed } = await proposeFullCandidate(service);
    expect(replayed).toBe(false);
    expect(candidate.status).toBe("proposed");
    expect(candidate.candidateId).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.provenance.sourceExecutionIds).toHaveLength(24);
  });

  test("the SAME proposal basis CONVERGES on retry (content identity)", async () => {
    const { service } = world();
    const first = await proposeFullCandidate(service);
    const second = await service.proposeCandidate(proposalRequest());
    expect(second.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(second.replayed).toBe(true);
  });

  test("a provenance-less proposal fails closed at the boundary", async () => {
    const { service } = world();
    const request = proposalRequest({
      provenance: {
        sourceExecutionIds: [],
        evidenceRefs: [],
        corpusDigest: "",
        windowFrom: "",
        windowTo: "",
        population: 0,
      },
    });
    await expect(service.proposeCandidate(request)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("provenance sourceExecutionIds"),
    });
  });
});

// ---------------------------------------------------------------------------
// Stage evidence + the validated lifecycle.
// ---------------------------------------------------------------------------

describe("deterministicization service: validation evidence (DTR-002)", () => {
  test("evidence records settle per stage; the lifecycle reaches validated", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const replay = await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "offline-replay",
      runs: stageRuns(24),
      recordedBy: "validator-1",
    });
    expect(replay.evidence.status).toBe("passed");
    expect(replay.evidence.metrics.population).toBe(24);
    expect(replay.replayed).toBe(false);

    await driveToValidated(service, candidate.candidateId);
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.candidate.status).toBe("validated");
    expect(view.evidence).toHaveLength(4);
  });

  test("the mutation stage counts CAUGHT mutants as passing evidence", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const outcome = await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "mutation-tests",
      runs: stageRuns(24, "failure"),
      recordedBy: "validator-1",
    });
    expect(outcome.evidence.status).toBe("passed");
    expect(outcome.evidence.metrics.mutationCaughtCount).toBe(24);
    expect(outcome.evidence.metrics.mutationMissedCount).toBe(0);
  });

  test("an identical evidence submission replays (converges)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    const first = await service.recordStageEvidence(request);
    const second = await service.recordStageEvidence(request);
    expect(second.evidence.evidenceId).toBe(first.evidence.evidenceId);
    expect(second.replayed).toBe(true);
  });

  test("a DIFFERENT basis for a settled stage is IDEMPOTENCY_KEY_REUSED (write-once)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "offline-replay",
      runs: stageRuns(24),
      recordedBy: "validator-1",
    });
    await expect(
      service.recordStageEvidence({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        stageKind: "offline-replay",
        runs: stageRuns(20),
        recordedBy: "validator-1",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: expect.stringContaining("already settled"),
    });
  });

  test("empty runs record honest INSUFFICIENCY (never fabricated)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const outcome = await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "offline-replay",
      runs: [],
      recordedBy: "validator-1",
    });
    expect(outcome.evidence.status).toBe("insufficient");
    expect(outcome.evidence.metrics.population).toBe(0);
  });

  test("a terminal candidate no longer accepts evidence", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await service.rejectCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the observed mapping is unstable across the corpus",
      decidedBy: "architect-1",
    });
    await expect(
      service.recordStageEvidence({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        stageKind: "offline-replay",
        runs: stageRuns(24),
        recordedBy: "validator-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("scope isolation: another application's candidate is unreachable", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await expect(
      service.getCandidate({
        applicationId: OTHER_APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("not found within the application scope"),
    });
  });
});

// ---------------------------------------------------------------------------
// Shadow / canary rollout (DTR-003).
// ---------------------------------------------------------------------------

describe("deterministicization service: shadow/canary rollout (DTR-003)", () => {
  test("the shadow phase requires a validated candidate (fail closed)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await expect(
      service.beginShadowRollout({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        requestedBy: "operator-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("the full rollout records MEASURABLE deltas and concludes once", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToValidated(service, candidate.candidateId);
    const shadow = await service.beginShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      requestedBy: "operator-1",
    });
    expect(shadow.rollout.mode).toBe("shadow");
    expect(shadow.rollout.status).toBe("observing");
    expect(shadow.replayed).toBe(false);

    const concluded = await service.concludeShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      mode: "shadow",
      population: 12,
      matchedCount: 12,
      costDeltaMicroUsd: "2200",
      qualityDelta: 1,
      latencyDeltaMs: -140,
      evidenceRefs: ["ev-shadow"],
      requestedBy: "operator-1",
    });
    expect(concluded.rollout.status).toBe("concluded");
    expect(concluded.rollout.costDeltaMicroUsd).toBe("2200");

    // a duplicate conclusion converges on the committed row
    const again = await service.concludeShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      mode: "shadow",
      population: 999,
      matchedCount: 999,
      costDeltaMicroUsd: "0",
      qualityDelta: 0,
      latencyDeltaMs: 0,
      evidenceRefs: ["ev-shadow"],
      requestedBy: "operator-1",
    });
    expect(again.rollout.costDeltaMicroUsd).toBe("2200");
  });

  test("the canary phase requires a CONCLUDED shadow with an adequate population", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToValidated(service, candidate.candidateId);
    await service.beginShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      requestedBy: "operator-1",
    });
    // shadow still observing → canary admission fails closed
    await expect(
      service.beginCanaryPhase({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        requestedBy: "operator-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("CONCLUDED shadow rollout"),
    });
    // conclude with a population below the floor → canary admission fails closed
    await service.concludeShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      mode: "shadow",
      population: 3,
      matchedCount: 3,
      costDeltaMicroUsd: "200",
      qualityDelta: 1,
      latencyDeltaMs: -100,
      evidenceRefs: ["ev-shadow"],
      requestedBy: "operator-1",
    });
    await expect(
      service.beginCanaryPhase({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        requestedBy: "operator-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("below the configured canary-admission floor"),
    });
  });
});

// ---------------------------------------------------------------------------
// Promotion, rejection, deferral, rollback (DTR-002/DTR-003/DTR-004).
// ---------------------------------------------------------------------------

describe("deterministicization service: the promotion gate", () => {
  test("promotion FAILS CLOSED on unknown/insufficient evidence (AC6 runtime red)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await expect(
      service.applyPromotion({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        decidedBy: "architect-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("promotion gate failed closed"),
    });
    // the candidate stays un-promoted (no silent replacement)
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.candidate.status).toBe("proposed");
    expect(view.decisions).toHaveLength(0);
  });

  test("the all-green lifecycle PROMOTES with the gate evaluation + rationale recorded", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const { decision } = await driveToPromoted(service, candidate.candidateId);
    expect(decision.kind).toBe("promoted");
    expect(decision.rationale).toContain("promotion gate passed");
    expect(decision.gate.verdict).toBe("promote");
    expect(decision.gate.stageEvidenceIds).toHaveLength(4);
    expect(decision.gate.rolloutIds).toHaveLength(2);

    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.candidate.status).toBe("promoted");
    expect(view.decisions).toHaveLength(1);
  });

  test("promotion replays idempotently (no second decision row)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const first = await driveToPromoted(service, candidate.candidateId);
    const second = await service.applyPromotion({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      decidedBy: "architect-1",
    });
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.replayed).toBe(true);
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.decisions).toHaveLength(1);
  });

  test("a candidate whose evidence passes the gate is not rejectable (honest states)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToPromoted(service, candidate.candidateId);
    // a promoted candidate is rolled back, not rejected
    await expect(
      service.rejectCandidate({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        rationale: "try again",
        decidedBy: "architect-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("rejection records the fail-closed gate + rationale (DTR-004)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const { decision } = await service.rejectCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the observed mapping is unstable across the corpus",
      decidedBy: "architect-1",
    });
    expect(decision.kind).toBe("rejected");
    expect(decision.gate.verdict).toBe("not-promoted");
    expect(decision.gate.reasons.length).toBeGreaterThan(0);
    expect(decision.rationale).toContain("unstable");
    expect(decision.incumbentRestoredTo).toBeNull();
  });

  test("a rationale-less decision is unrepresentable (DTR-004)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await expect(
      service.rejectCandidate({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        rationale: "",
        decidedBy: "architect-1",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("rationale"),
    });
  });

  test("deferral waits for more evidence and re-enters validation", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      stageKind: "offline-replay",
      runs: stageRuns(24),
      recordedBy: "validator-1",
    });
    const { decision } = await service.deferCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the differential corpus is too small; collect more executions",
      decidedBy: "architect-1",
    });
    expect(decision.kind).toBe("deferred");
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.candidate.status).toBe("deferred");
    // deferred re-enters validation: the remaining stages settle
    await driveToValidated(service, candidate.candidateId);
    const after = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(after.candidate.status).toBe("validated");
  });

  test("ROLLBACK restores the incumbent (append-only, reversible production)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToPromoted(service, candidate.candidateId);
    const { decision } = await service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the canary quality degraded beyond the configured maximum in production",
      decidedBy: "architect-1",
    });
    expect(decision.kind).toBe("rolled-back");
    expect(decision.incumbentRestoredTo).toBe("incumbent:generative-route@v1");
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    expect(view.candidate.status).toBe("rolled-back");
    // the journal is append-only: promotion AND rollback recorded
    expect(view.decisions.map((entry) => entry.kind)).toEqual(["promoted", "rolled-back"]);
  });

  test("a retried rejection replays its recorded decision (exactly-once)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    const first = await service.rejectCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the observed mapping is unstable across the corpus",
      decidedBy: "architect-1",
    });
    const second = await service.rejectCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the observed mapping is unstable across the corpus",
      decidedBy: "architect-1",
    });
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.replayed).toBe(true);
  });

  test("a retried rollback replays its recorded decision (exactly-once)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToPromoted(service, candidate.candidateId);
    const first = await service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the canary quality degraded beyond the configured maximum in production",
      decidedBy: "architect-1",
    });
    const second = await service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "the canary quality degraded beyond the configured maximum in production",
      decidedBy: "architect-1",
    });
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.replayed).toBe(true);
    const view = await service.getCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
    });
    // exactly one promoted + one rolled-back entry
    expect(view.decisions.map((entry) => entry.kind)).toEqual(["promoted", "rolled-back"]);
  });

  test("rollback requires a promoted candidate (fail closed)", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await expect(
      service.rollbackCandidate({
        applicationId: APP_ID,
        tenantId: TENANT_ID,
        candidateId: candidate.candidateId,
        rationale: "not promoted yet",
        decidedBy: "architect-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

// ---------------------------------------------------------------------------
// The consultation seam (planning's read surface).
// ---------------------------------------------------------------------------

describe("deterministicization service: the advisory signal consultation", () => {
  test("promoted candidates cross the seam with FULL anchors; proposed ones never do", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    // proposed → filtered out
    const before = await service.consultDeterministicizationSignals({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(before).toEqual([]);

    await driveToPromoted(service, candidate.candidateId);
    const after = await service.consultDeterministicizationSignals({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    expect(after).toHaveLength(1);
    const signal = after[0] as unknown as Record<string, unknown>;
    expect(signal.signalClass).toBe("non-authoritative-deterministicization-candidate");
    expect(signal.status).toBe("promoted");
    expect(signal.corpusDigest).toBe("b".repeat(64));
    expect(signal.sourceExecutionIds).toHaveLength(24);
    expect(signal.rollbackTarget).toBe("incumbent:generative-route@v1");
    expect(signal.canary).toMatchObject({ population: 12, matchedCount: 12 });
    expect(signal.promotionDecisionId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("after rollback the signal carries the restored incumbent anchor", async () => {
    const { service } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToPromoted(service, candidate.candidateId);
    await service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: candidate.candidateId,
      rationale: "quality degradation in production",
      decidedBy: "architect-1",
    });
    const signals = await service.consultDeterministicizationSignals({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
    });
    const signal = signals[0] as unknown as Record<string, unknown>;
    expect(signal.status).toBe("rolled-back");
    expect(signal.restoredIncumbent).toBe("incumbent:generative-route@v1");
  });

  test("the signal source adapter (the public read seam) projects the same evidence", async () => {
    const { service } = world();
    const source = createDeterministicizationSignalSource(service);
    const { candidate } = await proposeFullCandidate(service);
    await driveToPromoted(service, candidate.candidateId);
    const signals = await source.consult({ applicationId: APP_ID, tenantId: TENANT_ID });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.candidateId).toBe(candidate.candidateId);
    // cross-application consultation returns nothing
    const other = await source.consult({ applicationId: OTHER_APP_ID, tenantId: TENANT_ID });
    expect(other).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The durable operations ledger (crash-safety discriminator).
// ---------------------------------------------------------------------------

describe("deterministicization service: the durable operations ledger", () => {
  test("every governed operation owns ONE durable row with a STABLE content-derived key", async () => {
    const { service, store } = world();
    const { candidate } = await proposeFullCandidate(service);
    await driveToValidated(service, candidate.candidateId);
    const keys = [...store.operations.keys()];
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      expect(key.startsWith("dtr-")).toBe(true);
    }
    // all completed
    expect([...store.operations.values()].every((row) => row.status === "completed")).toBe(true);
  });

  test("a PENDING re-claim bumps the attempts ledger; a terminal row replays without a bump", async () => {
    const { store } = world();
    const begin = await store.beginOperation({
      operationId: "00000000-0000-7000-8000-0000000000e1",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: null,
      operationKind: "candidate-registration",
      operationKey: "dtr-candidate-registration:test-key",
      createdAt: "2026-09-20T12:00:00Z",
    });
    expect(begin.status).toBe("begun");
    expect(begin.record.attempts).toBe(1);
    const reclaim = await store.beginOperation({
      operationId: "00000000-0000-7000-8000-0000000000e2",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: null,
      operationKind: "candidate-registration",
      operationKey: "dtr-candidate-registration:test-key",
      createdAt: "2026-09-20T12:01:00Z",
    });
    expect(reclaim.status).toBe("existing");
    expect(reclaim.record.attempts).toBe(2);
    await store.completeOperation(
      APP_ID,
      "dtr-candidate-registration:test-key",
      "2026-09-20T12:02:00Z",
    );
    const terminal = await store.beginOperation({
      operationId: "00000000-0000-7000-8000-0000000000e3",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: null,
      operationKind: "candidate-registration",
      operationKey: "dtr-candidate-registration:test-key",
      createdAt: "2026-09-20T12:03:00Z",
    });
    expect(terminal.status).toBe("existing");
    expect(terminal.record.attempts).toBe(2);
    expect(terminal.record.status).toBe("completed");
  });

  test("a failed operation fails closed on retry (the typed failure replays)", async () => {
    const { store } = world();
    await store.beginOperation({
      operationId: "00000000-0000-7000-8000-0000000000e4",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: null,
      operationKind: "promotion",
      operationKey: "dtr-promotion:failed-key",
      createdAt: "2026-09-20T12:00:00Z",
    });
    await store.failOperation(
      APP_ID,
      "dtr-promotion:failed-key",
      "the gate failed closed",
      "2026-09-20T12:01:00Z",
    );
    await expect(
      store.completeOperation(APP_ID, "dtr-promotion:failed-key", "2026-09-20T12:02:00Z"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("an operation key claimed by another application scope fails closed (TENANT_SCOPE_VIOLATION)", async () => {
    const { store } = world();
    await store.beginOperation({
      operationId: "00000000-0000-7000-8000-0000000000e5",
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: null,
      operationKind: "rollback",
      operationKey: "dtr-rollback:scoped-key",
      createdAt: "2026-09-20T12:00:00Z",
    });
    await expect(
      store.beginOperation({
        operationId: "00000000-0000-7000-8000-0000000000e6",
        applicationId: OTHER_APP_ID,
        tenantId: TENANT_ID,
        candidateId: null,
        operationKind: "rollback",
        operationKey: "dtr-rollback:scoped-key",
        createdAt: "2026-09-20T12:01:00Z",
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});
