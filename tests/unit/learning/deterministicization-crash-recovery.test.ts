/**
 * Crash-injection proofs — the durable, recoverable deterministicization
 * operation state + the STABLE content-derived operation keys (WORK-021;
 * checkpoint contract CONCURRENCY-CRASH-SAFETY; the WORK-024 discipline
 * the architect's review bar set).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck
 * process dies mid-lifecycle-operation. What survives a process crash:
 *   - the DURABLE STATE (the deterministicization store — candidates,
 *     stage evidence, rollouts, the decision journal, and the
 *     deterministicization_operations ledger);
 * What dies: the in-flight service process (its closures, its unwritten
 * intents). A "restart" is a NEW service instance booted over the
 * surviving world (`boot()`).
 *
 * The injector arms ONE durable-boundary crash point per process (a
 * store method, before/after its durable commit) and THROWS a
 * ProcessCrashError through the awaited call — every armed point below
 * is OUTSIDE the service's best-effort regions, so the crash always
 * propagates and the process genuinely dies mid-flight. The test then
 * reboots (a fresh process, no plan) and re-issues the SAME logical
 * operation (the content-derived coordinates are identical by
 * construction — the same request replays the same identities).
 *
 * THE PROOF RECORDS (the lifecycle's critical boundaries):
 *   REGISTRATION   C1 claim-before | C2 insert-after | C3 complete-before |
 *                  C4 double crash
 *   STAGE EVIDENCE C5 insert-after | C6 transition-after | C7 checkpoint-after
 *   SHADOW ROLLOUT C8 begin-insert-after | C9 conclude-after
 *   PROMOTION      C10 decision-after | C11 transition-after (top-level
 *                  idempotent replay — the recorded decision is the
 *                  authority, the gate is NEVER re-run)
 *   ROLLBACK       C12 decision-after
 *   DISCIPLINE     C13 a durably FAILED operation fails closed on retry |
 *                  C14 the attempts ledger is honest across repeated
 *                  crashes | C15 the operation row is the discriminator
 *                  (COMPLETED replays with zero new side effects)
 */

import { describe, expect, test } from "vitest";
import {
  createDeterministicizationService,
  createNodeDigest,
  type DeterministicizationService,
  type ExecutionOutcomeTelemetry,
  InMemoryDeterministicizationStore,
} from "../../../src/modules/learning/public";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
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
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    executionId: `exec-${index}`,
    taskClass: "summarize",
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

function proposalRequest() {
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
  };
}

function stageRuns(count: number, outcome: "success" | "failure" = "success") {
  return Array.from({ length: count }, (_, index) => ({
    runKey: `run-${index}`,
    sandboxExecutionId: `sbx-${index}`,
    inputDigest: `${index}`.padStart(64, "0"),
    outputDigest: "e".repeat(64),
    outcome: outcome as "success" | "failure",
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

/** One armed durable-boundary crash point (per process). */
interface CrashPoint {
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/**
 * Wrap the durable store so the process dies at the planned point.
 * `before` = the durable commit did NOT happen; `after` = the commit DID
 * happen and the process died immediately after. The wrapper records the
 * firing so a vacuous proof (a point the service never reaches) fails
 * its `crashed()` assertion.
 */
function crashing(
  store: InMemoryDeterministicizationStore,
  point: CrashPoint | null,
): { proxy: InMemoryDeterministicizationStore; crashed: () => boolean } {
  let fired = false;
  if (point === null) {
    return { proxy: store, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, target);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`store.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

interface SurvivingWorld {
  readonly store: InMemoryDeterministicizationStore;
  /** Boot one Zeck process over the surviving world (the restart primitive). */
  boot(point: CrashPoint | null): {
    service: DeterministicizationService;
    crashed: () => boolean;
  };
}

function world(): SurvivingWorld {
  const store = new InMemoryDeterministicizationStore(telemetryPopulation(24));
  return {
    store,
    boot: (point) => {
      const process = crashing(store, point);
      const service = createDeterministicizationService({
        store: process.proxy,
        digest: createNodeDigest(),
        generateId,
        now: clock(),
      });
      return { service, crashed: process.crashed };
    },
  };
}

/** Drive a candidate to the given phase WITHOUT crash injection. */
async function drive(
  service: DeterministicizationService,
  to: "validated" | "canary" | "promoted",
): Promise<string> {
  const { candidate } = await service.proposeCandidate(proposalRequest());
  const candidateId = candidate.candidateId;
  const evidence = (
    kind: "offline-replay" | "differential-evaluation" | "property-tests" | "mutation-tests",
  ) =>
    service.recordStageEvidence({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId,
      stageKind: kind,
      runs: kind === "mutation-tests" ? stageRuns(24, "failure") : stageRuns(24),
      ...(kind === "differential-evaluation"
        ? { pairs: differentialPairs(24), incumbentCostMicroUsd: "4800" }
        : {}),
      recordedBy: "validator-1",
    });
  await evidence("offline-replay");
  await evidence("differential-evaluation");
  await evidence("property-tests");
  await evidence("mutation-tests");
  if (to === "validated") {
    return candidateId;
  }
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
  if (to === "canary") {
    return candidateId;
  }
  await service.applyPromotion({
    applicationId: APP_ID,
    tenantId: TENANT_ID,
    candidateId,
    decidedBy: "architect-1",
  });
  return candidateId;
}

describe("deterministicization crash recovery: registration", () => {
  test("C1: a crash BEFORE the operation claim leaves NOTHING durable; the retry does the full work", async () => {
    const w = world();
    const dying = w.boot({ method: "beginOperation", when: "before" });
    await expect(dying.service.proposeCandidate(proposalRequest())).rejects.toThrow(
      "simulated process crash",
    );
    expect(dying.crashed()).toBe(true);
    // Nothing durable: no candidate, no operation row.
    expect(w.store.candidates.size).toBe(0);
    expect(w.store.operations.size).toBe(0);
    // Restart: the full work happens exactly once.
    const restarted = w.boot(null);
    const outcome = await restarted.service.proposeCandidate(proposalRequest());
    expect(outcome.replayed).toBe(false);
    expect(outcome.candidate.status).toBe("proposed");
    expect(w.store.candidates.size).toBe(1);
  });

  test("C2: a crash AFTER the claim (row PENDING, work not done) — the retry RESUMES the same key", async () => {
    const w = world();
    const dying = w.boot({ method: "beginOperation", when: "after" });
    await expect(dying.service.proposeCandidate(proposalRequest())).rejects.toThrow(
      "simulated process crash",
    );
    expect(dying.crashed()).toBe(true);
    // The claim is durable; the candidate is not.
    expect(w.store.candidates.size).toBe(0);
    expect(w.store.operations.size).toBe(1);
    const pending = [...w.store.operations.values()][0];
    expect(pending?.status).toBe("pending");
    expect(pending?.operationKind).toBe("candidate-registration");
    // Restart: the SAME key resumes (attempts bumped), the work lands, COMPLETED.
    const restarted = w.boot(null);
    const outcome = await restarted.service.proposeCandidate(proposalRequest());
    expect(outcome.candidate.status).toBe("proposed");
    expect(w.store.candidates.size).toBe(1);
    const row = [...w.store.operations.values()][0];
    expect(row?.status).toBe("completed");
    expect(row?.attempts).toBe(2);
    expect(row?.completedAt).not.toBeNull();
  });

  test("C3: a crash AFTER the durable insert but BEFORE completion — the retry replays the durable outcome", async () => {
    const w = world();
    const dying = w.boot({ method: "insertCandidate", when: "after" });
    await expect(dying.service.proposeCandidate(proposalRequest())).rejects.toThrow(
      "simulated process crash",
    );
    expect(dying.crashed()).toBe(true);
    // The candidate IS durable; the operation row is PENDING.
    expect(w.store.candidates.size).toBe(1);
    const pending = [...w.store.operations.values()][0];
    expect(pending?.status).toBe("pending");
    // Restart: the retry replays the durable candidate and completes the row.
    const restarted = w.boot(null);
    const outcome = await restarted.service.proposeCandidate(proposalRequest());
    expect(outcome.replayed).toBe(true);
    expect(w.store.candidates.size).toBe(1);
    expect([...w.store.operations.values()][0]?.status).toBe("completed");
  });

  test("C4: a DOUBLE crash (crash again on the first retry's completion) converges on the second retry", async () => {
    const w = world();
    const first = w.boot({ method: "beginOperation", when: "after" });
    await expect(first.service.proposeCandidate(proposalRequest())).rejects.toThrow(
      "simulated process crash",
    );
    // The second process dies AFTER the durable insert, BEFORE completion.
    const second = w.boot({ method: "completeOperation", when: "before" });
    await expect(second.service.proposeCandidate(proposalRequest())).rejects.toThrow(
      "simulated process crash",
    );
    expect(w.store.candidates.size).toBe(1);
    const still = [...w.store.operations.values()][0];
    expect(still?.status).toBe("pending");
    expect(still?.attempts).toBe(2);
    // The third process finishes the tail.
    const third = w.boot(null);
    const outcome = await third.service.proposeCandidate(proposalRequest());
    expect(outcome.replayed).toBe(true);
    const row = [...w.store.operations.values()][0];
    expect(row?.status).toBe("completed");
    expect(row?.attempts).toBe(3);
    expect(w.store.candidates.size).toBe(1);
  });
});

describe("deterministicization crash recovery: stage evidence", () => {
  test("C5: a crash AFTER the evidence insert — the retry converges (ONE evidence record, ONE operation)", async () => {
    const w = world();
    const registered = await w.boot(null).service.proposeCandidate(proposalRequest());
    const id = registered.candidate.candidateId;
    const dying = w.boot({ method: "insertStageEvidence", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    await expect(dying.service.recordStageEvidence(request)).rejects.toThrow(
      "simulated process crash",
    );
    expect(w.store.stageEvidence.size).toBe(1);
    // Restart: converges — the SAME evidence row, status transitions applied.
    const restarted = w.boot(null);
    const outcome = await restarted.service.recordStageEvidence(request);
    expect(outcome.replayed).toBe(true);
    expect(w.store.stageEvidence.size).toBe(1);
    expect(w.store.candidates.get(id)?.status).toBe("validating");
    const op = [...w.store.operations.values()].find(
      (row) => row.operationKind === "stage-evidence",
    );
    expect(op?.status).toBe("completed");
  });

  test("C6: a crash AFTER the status transition — the retry converges through the idempotent tail", async () => {
    const w = world();
    const registered = await w.boot(null).service.proposeCandidate(proposalRequest());
    const id = registered.candidate.candidateId;
    const dying = w.boot({ method: "transitionCandidateStatus", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    await expect(dying.service.recordStageEvidence(request)).rejects.toThrow(
      "simulated process crash",
    );
    expect(w.store.stageEvidence.size).toBe(1);
    // Restart: converges (the transition may already be applied — the
    // store's expected-status arbitration tolerates the duplicate).
    const restarted = w.boot(null);
    const outcome = await restarted.service.recordStageEvidence(request);
    expect(outcome.replayed).toBe(true);
    expect(w.store.candidates.get(id)?.status).toBe("validating");
    expect(w.store.stageEvidence.size).toBe(1);
  });

  test("C7: a crash AFTER the checkpoint write — the retry completes the operation with the checkpoint intact", async () => {
    const w = world();
    const registered = await w.boot(null).service.proposeCandidate(proposalRequest());
    const id = registered.candidate.candidateId;
    const dying = w.boot({ method: "recordOperationCheckpoint", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    await expect(dying.service.recordStageEvidence(request)).rejects.toThrow(
      "simulated process crash",
    );
    const op = [...w.store.operations.values()].find(
      (row) => row.operationKind === "stage-evidence",
    );
    expect(op?.status).toBe("pending");
    expect(op?.checkpoint).toMatchObject({ stageKind: "offline-replay" });
    // Restart: completes; the checkpoint facts are preserved on the row.
    const restarted = w.boot(null);
    const outcome = await restarted.service.recordStageEvidence(request);
    expect(outcome.replayed).toBe(true);
    const row = [...w.store.operations.values()].find((r) => r.operationKind === "stage-evidence");
    expect(row?.status).toBe("completed");
    expect(row?.checkpoint).toMatchObject({ stageKind: "offline-replay" });
    expect(w.store.stageEvidence.size).toBe(1);
  });
});

describe("deterministicization crash recovery: shadow rollout", () => {
  test("C8: a crash AFTER the rollout insert — the retry converges (ONE rollout, ONE operation, status moved)", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "validated");
    const dying = w.boot({ method: "insertRollout", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      requestedBy: "operator-1",
    };
    await expect(dying.service.beginShadowRollout(request)).rejects.toThrow(
      "simulated process crash",
    );
    expect(w.store.rollouts.size).toBe(1);
    // Restart: converges.
    const restarted = w.boot(null);
    const outcome = await restarted.service.beginShadowRollout(request);
    expect(outcome.replayed).toBe(true);
    expect(w.store.rollouts.size).toBe(1);
    expect(w.store.candidates.get(id)?.status).toBe("shadow");
  });

  test("C9: a crash AFTER the conclusion write — the retry replays the concluded deltas (first writer wins)", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "validated");
    await w.boot(null).service.beginShadowRollout({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      requestedBy: "operator-1",
    });
    const dying = w.boot({ method: "concludeRollout", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      mode: "shadow" as const,
      population: 12,
      matchedCount: 12,
      costDeltaMicroUsd: "2200",
      qualityDelta: 1,
      latencyDeltaMs: -140,
      evidenceRefs: ["ev-shadow"],
      requestedBy: "operator-1",
    };
    await expect(dying.service.concludeShadowRollout(request)).rejects.toThrow(
      "simulated process crash",
    );
    const rollout = [...w.store.rollouts.values()][0];
    expect(rollout?.status).toBe("concluded");
    expect(rollout?.population).toBe(12);
    // Restart: the conclusion converges on the committed deltas — a
    // DIFFERENT delta payload on the retry does NOT rewrite them.
    const restarted = w.boot(null);
    await restarted.service.concludeShadowRollout({
      ...request,
      population: 999,
      matchedCount: 7,
      costDeltaMicroUsd: "1",
    });
    const committed = [...w.store.rollouts.values()][0];
    expect(committed?.population).toBe(12);
    expect(committed?.matchedCount).toBe(12);
    expect(committed?.costDeltaMicroUsd).toBe("2200");
  });
});

describe("deterministicization crash recovery: promotion and rollback", () => {
  test("C10: a crash AFTER the decision append but BEFORE the status move — the retry converges (ONE decision, promoted)", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "canary");
    const dying = w.boot({ method: "appendDecision", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      decidedBy: "architect-1",
    };
    await expect(dying.service.applyPromotion(request)).rejects.toThrow("simulated process crash");
    // The decision IS durable; the candidate is NOT yet promoted.
    expect(w.store.decisions.size).toBe(1);
    expect([...w.store.decisions.values()][0]?.kind).toBe("promoted");
    expect(w.store.candidates.get(id)?.status).toBe("canary");
    // Restart: converges — the same decision id, the status moves, ONE decision.
    const restarted = w.boot(null);
    const outcome = await restarted.service.applyPromotion(request);
    expect(outcome.decision.kind).toBe("promoted");
    expect(w.store.decisions.size).toBe(1);
    expect(w.store.candidates.get(id)?.status).toBe("promoted");
    const op = [...w.store.operations.values()].find((row) => row.operationKind === "promotion");
    expect(op?.status).toBe("completed");
    expect(op?.attempts).toBe(2);
  });

  test("C11: a crash AFTER the status move (fully promoted) — the retry replays the RECORDED decision without re-running the gate", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "canary");
    const dying = w.boot({ method: "transitionCandidateStatus", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      decidedBy: "architect-1",
    };
    await expect(dying.service.applyPromotion(request)).rejects.toThrow("simulated process crash");
    expect(w.store.candidates.get(id)?.status).toBe("promoted");
    expect(w.store.decisions.size).toBe(1);
    const recorded = [...w.store.decisions.values()][0];
    // Restart: the durable outcome IS the authority — the promotion
    // decision returns verbatim; the gate evaluation is never re-run
    // (no new durable rows of any kind appear below).
    const restarted = w.boot(null);
    const before = w.store.stageEvidence.size;
    const outcome = await restarted.service.applyPromotion(request);
    expect(outcome.replayed).toBe(true);
    expect(outcome.decision.decisionId).toBe(recorded?.decisionId);
    expect(outcome.decision.rationale).toBe(recorded?.rationale);
    // No new durable rows of any kind.
    expect(w.store.decisions.size).toBe(1);
    expect(w.store.stageEvidence.size).toBe(before);
  });

  test("C12: a crash during ROLLBACK after the decision append — the retry converges; the incumbent restoration is durable", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "promoted");
    const dying = w.boot({ method: "appendDecision", when: "after" });
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      rationale: "canary quality degraded after a corpus shift",
      decidedBy: "architect-1",
    };
    await expect(dying.service.rollbackCandidate(request)).rejects.toThrow(
      "simulated process crash",
    );
    expect(w.store.decisions.size).toBe(2); // the promotion + the rollback
    expect(w.store.candidates.get(id)?.status).toBe("promoted");
    // Restart: converges — ONE rollback decision, status rolled-back,
    // the incumbent restoration target recorded.
    const restarted = w.boot(null);
    const outcome = await restarted.service.rollbackCandidate(request);
    expect(outcome.decision.kind).toBe("rolled-back");
    expect(outcome.decision.incumbentRestoredTo).toBe("incumbent:generative-route@v1");
    expect(w.store.decisions.size).toBe(2);
    expect(w.store.candidates.get(id)?.status).toBe("rolled-back");
  });
});

describe("deterministicization crash recovery: the operations-ledger discipline", () => {
  test("C13: a durably FAILED operation fails CLOSED on retry (the typed failure replays)", async () => {
    const w = world();
    const registered = await w.boot(null).service.proposeCandidate(proposalRequest());
    const id = registered.candidate.candidateId;
    // Arm a crash on the FIRST process; then FAIL the operation durably
    // through the store (the honest terminal-failure path).
    const request = {
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    const dying = w.boot({ method: "beginOperation", when: "after" });
    await expect(dying.service.recordStageEvidence(request)).rejects.toThrow(
      "simulated process crash",
    );
    const op = [...w.store.operations.values()].find(
      (row) => row.operationKind === "stage-evidence",
    );
    expect(op).not.toBeNull();
    if (op === undefined) throw new Error("operation row missing");
    await w.store.failOperation(
      APP_ID,
      op.operationKey,
      "operator-initiated abort",
      "2026-09-20T13:00:00Z",
    );
    // The retry hits the FAILED row and fails closed with the recorded reason.
    const restarted = w.boot(null);
    await expect(restarted.service.recordStageEvidence(request)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("operator-initiated abort"),
    });
    // The FAILED row is terminal-immutable: no completion, no rewrite.
    const row = [...w.store.operations.values()].find((r) => r.operationKind === "stage-evidence");
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBe("operator-initiated abort");
  });

  test("C14: the attempts ledger is honest across REPEATED crashes (monotonic, one per process)", async () => {
    const w = world();
    for (let round = 0; round < 3; round += 1) {
      const dying = w.boot({ method: "beginOperation", when: "after" });
      await expect(dying.service.proposeCandidate(proposalRequest())).rejects.toThrow(
        "simulated process crash",
      );
      expect(dying.crashed()).toBe(true);
    }
    const row = [...w.store.operations.values()][0];
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(3);
    expect(w.store.candidates.size).toBe(0);
    // The fourth process completes the tail: attempts 4, ONE candidate.
    const final = w.boot(null);
    const outcome = await final.service.proposeCandidate(proposalRequest());
    expect(outcome.candidate.status).toBe("proposed");
    const done = [...w.store.operations.values()][0];
    expect(done?.attempts).toBe(4);
    expect(done?.status).toBe("completed");
    expect(w.store.candidates.size).toBe(1);
  });

  test("C15: a COMPLETED operation replays with ZERO new durable side effects", async () => {
    const w = world();
    const id = await drive(w.boot(null).service, "promoted");
    const restart = w.boot(null);
    const outcome = await restart.service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      rationale: "post-promotion audit rollback",
      decidedBy: "auditor-1",
    });
    expect(outcome.decision.kind).toBe("rolled-back");
    // The rollback is ONE new decision (a NEW logical operation) — but
    // re-issuing the SAME rollback replays with zero new rows.
    const after = {
      candidates: w.store.candidates.size,
      evidence: w.store.stageEvidence.size,
      rollouts: w.store.rollouts.size,
      decisions: w.store.decisions.size,
      operations: w.store.operations.size,
    };
    const again = await w.boot(null).service.rollbackCandidate({
      applicationId: APP_ID,
      tenantId: TENANT_ID,
      candidateId: id,
      rationale: "post-promotion audit rollback",
      decidedBy: "auditor-1",
    });
    expect(again.replayed).toBe(true);
    expect(w.store.decisions.size).toBe(after.decisions);
    expect(w.store.operations.size).toBe(after.operations);
    expect(w.store.candidates.size).toBe(after.candidates);
    expect(w.store.stageEvidence.size).toBe(after.evidence);
    expect(w.store.rollouts.size).toBe(after.rollouts);
  });
});
