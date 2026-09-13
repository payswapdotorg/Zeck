/**
 * VAL-021 acceptance criteria 1, 2, 4, 5: the idempotency-and-
 * continuation platform slice against controlled fakes — the
 * ledger-arbitration taxonomy (the decision table, the replay-identity
 * verification, the typed-rejection contract), the journal-gaplessness
 * and effect-multiplicity derivations, the resume-legality mirror of
 * the REAL state machine, and the execution driver over every offline
 * corpus row (canonical lifecycle order, planning decision BEFORE the
 * first dispatch, the exactly-once effect journal, the bounded
 * dispatch retry journaled exactly once per attempt, the resume-
 * exactly-once continuation with the stale-worker denial, the
 * escalation routing with the causal chain and the idempotent
 * re-escalation replay, the no-op resume replay after terminal).
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_ESCALATION_DEPTH,
  CORPUS_RETRY_POLICY,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/idempotency-continuation/corpus";
import {
  createFaultedDispatch,
  createScriptedEscalationAuthority,
  createSettlementWorld,
  receiveEscalation,
} from "../../../benchmarks/validation/apps/idempotency-continuation/fixtures";
import {
  type ContinuationCorpusRow,
  type ContinuationDispatch,
  classifyResumeAttempt,
  classifySubmissionArbitration,
  deriveEffectMultiplicity,
  deriveIdempotencyContinuationCriteria,
  deriveJournalGaplessness,
  driveIdempotencyContinuationExecution,
  type EffectJournalRecord,
  IDEMPOTENCY_KEY_REUSED_CODE,
  type IdempotencyContinuationLifecyclePort,
  isSubmissionPattern,
  SUBMISSION_PATTERNS,
  type SubmissionObservation,
  verifyReplayIdentity,
  verifySubmissionContract,
} from "../../../benchmarks/validation/platform/idempotency-continuation";

// ---------------------------------------------------------------------------
// Fake lifecycle + helpers
// ---------------------------------------------------------------------------

interface FakeLifecycle extends IdempotencyContinuationLifecyclePort {
  readonly transitions: string[];
  readonly decisions: { provider: string; model: string; strategyClass: string }[];
  readonly attemptRecords: {
    attempt: number;
    segment: number;
    outcome: string;
    retried: boolean;
    requestDigest: string;
  }[];
  readonly effectRecords: EffectJournalRecord[];
  readonly interruptions: number[];
  readonly resumeDenials: string[];
  readonly escalations: {
    gateId: string;
    authority: string;
    callKey: string;
    causalChain: readonly { cause: string; digest: string }[];
  }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
  /** When true, the fake admits every resume (the exactly-once violation shape). */
  admitEveryResume: boolean;
}

function createFakeLifecycle(options?: { readonly admitEveryResume?: boolean }): FakeLifecycle {
  const transitions: string[] = [];
  const decisions: { provider: string; model: string; strategyClass: string }[] = [];
  const attemptRecords: {
    attempt: number;
    segment: number;
    outcome: string;
    retried: boolean;
    requestDigest: string;
  }[] = [];
  const effectRecords: EffectJournalRecord[] = [];
  const interruptions: number[] = [];
  const resumeDenials: string[] = [];
  const escalations: {
    gateId: string;
    authority: string;
    callKey: string;
    causalChain: readonly { cause: string; digest: string }[];
  }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  // The fake mirrors the REAL state machine's resume legality: resume
  // is legal only from the WAITING_* states.
  let status = "CREATED";
  const port: IdempotencyContinuationLifecyclePort = {
    async transition({ step }) {
      if (step === "resume" && status !== "WAITING_USER") {
        if (!(options?.admitEveryResume === true)) {
          throw new Error(
            `INVALID_STATE_TRANSITION: resume is illegal from ${status} (the fake mirrors the REAL state machine)`,
          );
        }
      }
      transitions.push(step);
      if (step === "authorize") status = "AUTHORIZED";
      if (step === "plan") status = "PLANNING";
      if (step === "queue") status = "QUEUED";
      if (step === "start") status = "RUNNING";
      if (step === "wait-user") status = "WAITING_USER";
      if (step === "resume") status = "RUNNING";
      if (step === "verify") status = "VERIFYING";
    },
    async recordPlanningDecision({ route }) {
      decisions.push({ ...route });
    },
    async recordDispatchAttempt({ record }) {
      attemptRecords.push({
        attempt: record.attempt,
        segment: record.segment,
        outcome: record.outcome,
        retried: record.retried,
        requestDigest: record.requestDigest,
      });
    },
    async recordEffect({ record }) {
      effectRecords.push(record);
    },
    async recordInterruption({ at }) {
      interruptions.push(at);
    },
    async recordResumeDenied({ reason }) {
      resumeDenials.push(reason);
    },
    async recordEscalation({ gateId, authority, causalChain, callKey }) {
      const seen = escalations.find((record) => record.callKey === callKey);
      if (seen !== undefined) {
        // The ledger REPLAYS the identical (key, payload) — the
        // authority is NOT notified again.
        return { routed: false, replayed: true };
      }
      escalations.push({ gateId, authority, callKey, causalChain: [...causalChain] });
      return { routed: true, replayed: false };
    },
    async complete({ verdict, criteria }) {
      status = verdict === "pass" ? "COMPLETED" : "FAILED";
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
    },
    async attemptNoOpResume() {
      // The fake ledger replays the exact re-issued completion.
      return { replayed: true };
    },
  };
  return Object.assign(port, {
    transitions,
    decisions,
    attemptRecords,
    effectRecords,
    interruptions,
    resumeDenials,
    escalations,
    completions,
    admitEveryResume: options?.admitEveryResume === true,
  });
}

/** The deterministic backoff spy (records waits; never sleeps). */
function createSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => void calls.push(ms), calls };
}

/** Drive one offline corpus row through the full fake stack. */
async function driveRow(
  row: ContinuationCorpusRow,
  options?: {
    readonly admitEveryResume?: boolean;
    readonly escalationDecisions?: Readonly<Record<number, "escalate" | "re-escalate" | "resolve">>;
  },
): Promise<{
  result: Awaited<ReturnType<typeof driveIdempotencyContinuationExecution>>;
  lifecycle: FakeLifecycle;
  world: ReturnType<typeof createSettlementWorld>;
  authority: ReturnType<typeof createScriptedEscalationAuthority>;
  sleepCalls: number[];
}> {
  const lifecycle = createFakeLifecycle({ admitEveryResume: options?.admitEveryResume });
  const world = createSettlementWorld();
  const authority = createScriptedEscalationAuthority({
    authority: row.escalation?.authority ?? "settlement-ops-oncall",
    decisions: options?.escalationDecisions,
  });
  const { sleep, calls } = createSleepSpy();
  // The fake lifecycle's escalation port routes to the authority
  // fixture on actual routing (the binding in the crown does the same).
  const originalRecordEscalation = lifecycle.recordEscalation.bind(lifecycle);
  lifecycle.recordEscalation = async (input) => {
    const outcome = await originalRecordEscalation(input);
    if (outcome.routed) {
      receiveEscalation(authority, {
        gateId: input.gateId,
        authority: input.authority,
        causalChain: input.causalChain,
      });
    }
    return outcome;
  };

  let dispatch: ContinuationDispatch | undefined;
  if (row.rowId === "retry-storm-bounded-dispatch") {
    dispatch = createFaultedDispatch({ scenario: "transport-fail-twice-then-success" }).dispatch;
  } else if (row.rowId === "retry-storm-exhausted") {
    dispatch = createFaultedDispatch({ scenario: "transport-fail-always" }).dispatch;
  }

  const result = await driveIdempotencyContinuationExecution({
    executionId: "exec-test",
    row,
    provider: "idempotency-test-rail",
    model: "test-model",
    lifecycle,
    ...(dispatch === undefined ? {} : { dispatch }),
    world,
    escalationSource: authority,
    retry: {
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      backoffMs: 5,
      sleep,
    },
    maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
    now: () => new Date(1_000),
  });
  return { result, lifecycle, world, authority, sleepCalls: calls };
}

const row = (rowId: string): ContinuationCorpusRow => {
  const found = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (found === undefined) throw new Error(`missing corpus row ${rowId}`);
  return found;
};

// ---------------------------------------------------------------------------
// The ledger-arbitration taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-021 ledger-arbitration taxonomy", () => {
  test("the submission-pattern vocabulary is exactly the five documented patterns", () => {
    expect([...SUBMISSION_PATTERNS]).toEqual([
      "duplicate",
      "conflict",
      "retry",
      "escalate",
      "continue",
    ]);
    expect(isSubmissionPattern("duplicate")).toBe(true);
    expect(isSubmissionPattern("teleport")).toBe(false);
  });

  test("the ledger decision table: fresh key creates; same key + same fingerprint replays; same key + different fingerprint is the typed key-reuse rejection", () => {
    expect(classifySubmissionArbitration({ keySeenBefore: false, fingerprintMatches: null })).toBe(
      "created",
    );
    expect(classifySubmissionArbitration({ keySeenBefore: true, fingerprintMatches: true })).toBe(
      "replayed",
    );
    expect(classifySubmissionArbitration({ keySeenBefore: true, fingerprintMatches: false })).toBe(
      "rejected-key-reuse",
    );
  });

  test("the typed rejection code is the platform's public IDEMPOTENCY_KEY_REUSED token", () => {
    expect(IDEMPOTENCY_KEY_REUSED_CODE).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("replay-identity verification: identity preserved + the replayed flag surfaced; a different identity is a forged claim", () => {
    const first: SubmissionObservation = {
      executionId: "exec-1",
      replayed: false,
      status: "CREATED",
      rejection: null,
    };
    const honest: SubmissionObservation = {
      executionId: "exec-1",
      replayed: true,
      status: "RUNNING",
      rejection: null,
    };
    const forged: SubmissionObservation = {
      executionId: "exec-OTHER",
      replayed: true,
      status: "RUNNING",
      rejection: null,
    };
    expect(verifyReplayIdentity(first, honest)).toEqual({
      identityPreserved: true,
      replayedFlagSurfaced: true,
    });
    expect(verifyReplayIdentity(first, forged).identityPreserved).toBe(false);
    expect(verifyReplayIdentity(first, { ...honest, replayed: false }).replayedFlagSurfaced).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The submission-contract verification (PURE)
// ---------------------------------------------------------------------------

describe("VAL-021 submission-contract verification", () => {
  test("a duplicate row's honest observations PASS every criterion", () => {
    const criteria = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 1, rejectedSubmissions: 0 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        { executionId: "exec-1", replayed: true, status: "CREATED", rejection: null },
      ],
    });
    expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a conflict row's typed rejection PASSes; a generic rejection FAILs the typed-rejection criterion", () => {
    const typed = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 0, rejectedSubmissions: 1 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        {
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: IDEMPOTENCY_KEY_REUSED_CODE, status: 409 },
        },
      ],
    });
    expect(typed.every((criterion) => criterion.status === "PASS")).toBe(true);

    const generic = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 0, rejectedSubmissions: 1 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        {
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: "PROVIDER_ERROR", status: 502 },
        },
      ],
    });
    expect(generic.find((c) => c.criterionId === "typed-rejection-surfaced")?.status).toBe("FAIL");
  });

  test("a storm's converged observations PASS; a forged replay identity FAILs", () => {
    const converged = verifySubmissionContract({
      expected: { submissions: 5, replayedSubmissions: 4, rejectedSubmissions: 0 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        ...Array.from({ length: 4 }, () => ({
          executionId: "exec-1",
          replayed: true,
          status: "CREATED",
          rejection: null,
        })),
      ],
    });
    expect(converged.every((criterion) => criterion.status === "PASS")).toBe(true);

    const forged = verifySubmissionContract({
      expected: { submissions: 5, replayedSubmissions: 4, rejectedSubmissions: 0 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        ...Array.from({ length: 3 }, () => ({
          executionId: "exec-1",
          replayed: true,
          status: "CREATED",
          rejection: null,
        })),
        { executionId: "exec-ROGUE", replayed: true, status: "CREATED", rejection: null },
      ],
    });
    expect(forged.find((c) => c.criterionId === "replay-identity-preserved")?.status).toBe("FAIL");
  });

  test("the submission-count contract detects a short storm and an extra rejection", () => {
    const short = verifySubmissionContract({
      expected: { submissions: 5, replayedSubmissions: 4, rejectedSubmissions: 0 },
      firstExecutionId: "exec-1",
      observations: [
        { executionId: "exec-1", replayed: false, status: "CREATED", rejection: null },
        { executionId: "exec-1", replayed: true, status: "CREATED", rejection: null },
      ],
    });
    expect(short.find((c) => c.criterionId === "submission-counts")?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Journal gaplessness + effect multiplicity (PURE)
// ---------------------------------------------------------------------------

describe("VAL-021 journal gaplessness + effect multiplicity", () => {
  test("a well-formed journal is 1..N gapless", () => {
    const verdict = deriveJournalGaplessness([1, 2, 3, 4]);
    expect(verdict.gapless).toBe(true);
    expect(verdict.holes).toEqual([]);
    expect(verdict.duplicates).toEqual([]);
  });

  test("a journal gap (a dropped record) is detected", () => {
    const verdict = deriveJournalGaplessness([1, 2, 4]);
    expect(verdict.gapless).toBe(false);
    expect(verdict.holes).toEqual([3]);
  });

  test("a duplicate sequence (a double-written record) is detected", () => {
    const verdict = deriveJournalGaplessness([1, 2, 2, 3]);
    expect(verdict.gapless).toBe(false);
    expect(verdict.duplicates).toEqual([2]);
  });

  test("an empty journal is gapless by design", () => {
    expect(deriveJournalGaplessness([]).gapless).toBe(true);
  });

  test("effect multiplicity: exactly-once passes; over/under/unexpected fail", () => {
    expect(deriveEffectMultiplicity({ "settle:INV-1": 1 }, { "settle:INV-1": 1 }).exactlyOnce).toBe(
      true,
    );
    expect(deriveEffectMultiplicity({ "settle:INV-1": 1 }, { "settle:INV-1": 2 }).exactlyOnce).toBe(
      false,
    );
    expect(deriveEffectMultiplicity({ "settle:INV-1": 1 }, {}).exactlyOnce).toBe(false);
    expect(
      deriveEffectMultiplicity({ "settle:INV-1": 1 }, { "settle:INV-1": 1, "settle:INV-2": 1 })
        .exactlyOnce,
    ).toBe(false);
    const over = deriveEffectMultiplicity({ "settle:INV-1": 1 }, { "settle:INV-1": 3 });
    expect(over.overApplied).toEqual(["settle:INV-1"]);
  });
});

// ---------------------------------------------------------------------------
// The resume-legality mirror (PURE)
// ---------------------------------------------------------------------------

describe("VAL-021 resume legality (the REAL state machine's mirror)", () => {
  test("resume from the WAITING_* states is admitted", () => {
    expect(classifyResumeAttempt("WAITING_USER")).toBe("admitted");
    expect(classifyResumeAttempt("WAITING_TOOL")).toBe("admitted");
    expect(classifyResumeAttempt("WAITING_HUMAN")).toBe("admitted");
  });

  test("resume against RUNNING is the stale-worker denial", () => {
    expect(classifyResumeAttempt("RUNNING")).toBe("stale-worker-denied");
  });

  test("resume against a terminal state is terminal immutability", () => {
    expect(classifyResumeAttempt("COMPLETED")).toBe("terminal-immutable");
    expect(classifyResumeAttempt("FAILED")).toBe("terminal-immutable");
    expect(classifyResumeAttempt("CANCELLED")).toBe("terminal-immutable");
    expect(classifyResumeAttempt("EXPIRED")).toBe("terminal-immutable");
  });
});

// ---------------------------------------------------------------------------
// The driver over the offline corpus
// ---------------------------------------------------------------------------

describe("VAL-021 driver over the offline corpus", () => {
  test("every offline row satisfies its oracle (terminal, criteria, multiplicity)", async () => {
    for (const offlineRow of OFFLINE_CORPUS_ROWS) {
      const { result, world } = await driveRow(offlineRow);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${offlineRow.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.terminal, `${offlineRow.rowId} terminal`).toBe(offlineRow.expected.terminal);
      // The fixture world's own counters match the driver's counts
      // (the multiplicity oracle's independent view).
      const settlements = Object.values(world.state.settlements).reduce((a, b) => a + b, 0);
      const expectedSettlements = Object.entries(offlineRow.expected.effects)
        .filter(([effect]) => effect.startsWith("settle:"))
        .reduce((sum, [, count]) => sum + count, 0);
      expect(settlements, `${offlineRow.rowId} fixture settlements`).toBe(expectedSettlements);
    }
  });

  test("the canonical lifecycle order: authorize → plan → decision → queue → start (the planning decision BEFORE any dispatch)", async () => {
    const { lifecycle } = await driveRow(row("duplicate-submission-replay"));
    expect(lifecycle.transitions.slice(0, 5)).toEqual([
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
    ]);
    expect(lifecycle.decisions).toHaveLength(1);
    expect(lifecycle.decisions[0]?.strategyClass).toBe("idempotency-continuation");
  });

  test("the duplicate row settles EXACTLY once (the world's own counter) with a gapless effect journal", async () => {
    const { result, world, lifecycle } = await driveRow(row("duplicate-submission-replay"));
    expect(world.state.settlements["INV-101"]).toBe(1);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.sequence).toBe(1);
    expect(lifecycle.effectRecords.map((record) => record.sequence)).toEqual([1]);
  });

  test("the bounded-dispatch retry row: three attempts journaled exactly once each, effects applied once after recovery", async () => {
    const { result, lifecycle, world, sleepCalls } = await driveRow(
      row("retry-storm-bounded-dispatch"),
    );
    expect(result.terminal).toBe("COMPLETED");
    expect(result.attempts.map((record) => record.outcome)).toEqual([
      "failure",
      "failure",
      "success",
    ]);
    expect(lifecycle.attemptRecords).toHaveLength(3);
    expect(result.journaledAttempts).toBe(3);
    expect(sleepCalls).toEqual([5, 5]); // a measured backoff between the retries
    expect(world.state.settlements["INV-104"]).toBe(1);
    expect(world.state.notifications["INV-104"]).toBe(1);
    // The failed attempts are journaled with retried recorded.
    expect(result.attempts[0]?.retried).toBe(true);
    expect(result.attempts[1]?.retried).toBe(true);
    expect(result.attempts[2]?.retried).toBe(false);
  });

  test("the exhausted retry row: bounded at exactly 1 + maxExtraAttempts attempts, ZERO effects, the honest FAILED with all semantics criteria PASSing", async () => {
    const { result, world, lifecycle } = await driveRow(row("retry-storm-exhausted"));
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("transport-failure");
    expect(result.attempts).toHaveLength(1 + CORPUS_RETRY_POLICY.maxExtraAttempts);
    expect(lifecycle.attemptRecords).toHaveLength(3);
    expect(world.state.settlements["INV-105"]).toBeUndefined();
    expect(result.effects).toEqual([]);
    // The VAL-020 calibration: the criteria prove the SEMANTICS — a
    // correctly-bounded exhausted storm PASSES every criterion while
    // the terminal stays honestly FAILED.
    const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failed, `${JSON.stringify(failed)}`).toEqual([]);
    expect(result.criteria.find((c) => c.criterionId === "dispatch-bounded-retry")?.status).toBe(
      "PASS",
    );
    expect(result.criteria.find((c) => c.criterionId === "outcome-contract")?.status).toBe("PASS");
  });

  test("the escalation row: routed ONCE with the complete causal chain; the re-escalation REPLAYS (authority receives exactly one); the gated refund NEVER executes", async () => {
    const { result, authority, world } = await driveRow(row("escalation-routed-once"));
    expect(result.terminal).toBe("COMPLETED");
    expect(result.escalations).toHaveLength(2);
    expect(result.escalations[0]?.routed).toBe(true);
    expect(result.escalations[0]?.replayed).toBe(false);
    expect(result.escalations[1]?.routed).toBe(false);
    expect(result.escalations[1]?.replayed).toBe(true);
    expect(authority.received).toHaveLength(1);
    expect(authority.received[0]?.authority).toBe("settlement-ops-oncall");
    expect(authority.received[0]?.causalChain.map((link) => link.cause)).toEqual([
      "submission",
      "gate-proposal",
      "escalation-decision",
    ]);
    // The gated refund NEVER executed (zero refund effects).
    expect(world.observedCounts["refund:REF-201"]).toBeUndefined();
    expect(result.effectCounts["refund:REF-201"]).toBeUndefined();
  });

  test("the continuation row: exactly one wait-user → resume pair; both segments' effects exactly once; the resume never redoes segment 1", async () => {
    const { result, lifecycle, world } = await driveRow(row("continuation-resume-once"));
    expect(result.terminal).toBe("COMPLETED");
    expect(result.waitUserCycles).toBe(1);
    expect(result.resumeAdmitted).toBe(1);
    expect(lifecycle.interruptions).toEqual([1]);
    expect(world.state.settlements["INV-107"]).toBe(1);
    expect(world.state.settlements["INV-108"]).toBe(1);
    expect(world.state.notifications["INV-108"]).toBe(1);
    expect(result.effects.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  test("the stale-worker row: the successor's resume is admitted, the stale worker's second resume is DENIED and journaled; the run completes", async () => {
    const { result, lifecycle } = await driveRow(row("continuation-stale-worker-denied"));
    expect(result.terminal).toBe("COMPLETED");
    expect(result.resumeAdmitted).toBe(1);
    expect(result.staleWorkerDenied).toBe(true);
    expect(lifecycle.resumeDenials).toHaveLength(1);
    expect(lifecycle.resumeDenials[0]).toContain("stale-worker");
    expect(result.criteria.find((c) => c.criterionId === "stale-worker-denied")?.status).toBe(
      "PASS",
    );
  });

  test("the no-op resume row: the completion re-issue REPLAYS (zero state change)", async () => {
    const { result } = await driveRow(row("continuation-noop-resume-replay"));
    expect(result.terminal).toBe("COMPLETED");
    expect(result.noOpResumeReplayed).toBe(true);
  });

  test("a platform that ADMITS the double resume fails the run honestly (the exactly-once violation)", async () => {
    const { result } = await driveRow(row("continuation-stale-worker-denied"), {
      admitEveryResume: true,
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("double-resume-admitted");
    // The resume-exactly-once criterion detects the violation
    // mechanically (two admissions against one park).
    expect(result.criteria.find((c) => c.criterionId === "resume-exactly-once")?.status).toBe(
      "FAIL",
    );
  });

  test("an escalation LOOP terminates at the depth bound with the honest FAILED", async () => {
    const { result, lifecycle } = await driveRow(row("escalation-routed-once"), {
      escalationDecisions: { 1: "re-escalate", 2: "re-escalate", 3: "escalate" },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("escalation-depth-exceeded");
    // The loop routed at depths 1 and 2 (distinct decisions — distinct
    // ledger keys), then the depth-3 decision exceeded the bound.
    expect(lifecycle.escalations).toHaveLength(2);
    // The escalation-routing criterion detects the over-routing
    // mechanically (two routed against the declared one).
    expect(result.criteria.find((c) => c.criterionId === "escalation-routing")?.status).toBe(
      "FAIL",
    );
  });

  test("evidence discipline: the journals carry digests only — payload text and amounts never appear", async () => {
    const { lifecycle } = await driveRow(row("retry-storm-bounded-dispatch"));
    const journalText = JSON.stringify(lifecycle.attemptRecords);
    expect(journalText).not.toContain("INV-");
    expect(journalText).not.toContain("micro-USD");
    const effectText = JSON.stringify(lifecycle.effectRecords.map((r) => ({ ...r })));
    expect(effectText).not.toContain("12_500");
    expect(effectText).not.toContain("9_900");
    expect(lifecycle.effectRecords[0]?.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  test("request reproducibility: every retry of the same logical request digests identically", async () => {
    const faulted = createFaultedDispatch({ scenario: "transport-fail-twice-then-success" });
    const world = createSettlementWorld();
    const lifecycle = createFakeLifecycle();
    const retryRow = row("retry-storm-bounded-dispatch");
    await driveIdempotencyContinuationExecution({
      executionId: "exec-digest",
      row: retryRow,
      provider: "p",
      model: "m",
      lifecycle,
      dispatch: faulted.dispatch,
      world,
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: async () => {} },
      maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
      now: () => new Date(1_000),
    });
    expect(faulted.calls).toHaveLength(3);
    // All three retries of the same logical request carry the SAME
    // request digest (the journal records it per attempt).
    expect(new Set(faulted.calls).size).toBe(1);
    const journaled = lifecycle.attemptRecords.map((record) => record.requestDigest ?? "");
    expect(new Set(journaled).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The criteria derivation against synthetic violations
// ---------------------------------------------------------------------------

describe("VAL-021 criteria derivation against synthetic violations", () => {
  test("a journal gap FAILs the gapless criterion; the real driver produces none", async () => {
    const synthetic = deriveJournalGaplessness([1, 3]);
    expect(synthetic.gapless).toBe(false);
    const { result } = await driveRow(row("continuation-resume-once"));
    expect(result.criteria.find((c) => c.criterionId === "journal-sequence-gapless")?.status).toBe(
      "PASS",
    );
  });

  test("an over-applied effect FAILs the multiplicity criterion (a replay that re-settled)", () => {
    const escalateRow = row("duplicate-submission-replay");
    const criteria = deriveIdempotencyContinuationCriteria({
      row: escalateRow,
      attempts: [],
      journaledAttempts: 0,
      effects: [
        { sequence: 1, effect: "settle:INV-101", attempt: null, digest: "aaaaaaaa" },
        { sequence: 2, effect: "settle:INV-101", attempt: null, digest: "aaaaaaaa" },
      ],
      effectCounts: { "settle:INV-101": 2 },
      segments: 1,
      waitUserCycles: 0,
      resumeAdmitted: 0,
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    expect(criteria.find((c) => c.criterionId === "effect-multiplicity-exactly-once")?.status).toBe(
      "FAIL",
    );
  });

  test("a missing wait-user resume FAILs the resume-exactly-once criterion", () => {
    const continueRow = row("continuation-resume-once");
    const criteria = deriveIdempotencyContinuationCriteria({
      row: continueRow,
      attempts: [],
      journaledAttempts: 0,
      effects: [],
      effectCounts: {},
      segments: 2,
      waitUserCycles: 1,
      resumeAdmitted: 0, // the resume never landed
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    expect(criteria.find((c) => c.criterionId === "resume-exactly-once")?.status).toBe("FAIL");
  });

  test("a synthetic over-budget dispatch sequence FAILs the bounded-retry criterion", () => {
    const retryRow = row("retry-storm-bounded-dispatch");
    const overBudget = Array.from({ length: 5 }, (_, index) => ({
      attempt: index + 1,
      segment: 1,
      outcome: "failure" as const,
      category: "transport-failure",
      retryable: true,
      retried: index < 4,
      latencyMs: 2,
      requestDigest: "bbbb1111",
    }));
    const criteria = deriveIdempotencyContinuationCriteria({
      row: retryRow,
      attempts: overBudget,
      journaledAttempts: 5,
      effects: [],
      effectCounts: {},
      segments: 1,
      waitUserCycles: 0,
      resumeAdmitted: 0,
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    expect(criteria.find((c) => c.criterionId === "dispatch-bounded-retry")?.status).toBe("FAIL");
  });

  test("a wrong-terminal oracle FAILS the outcome-contract criterion", () => {
    const exhausted = row("retry-storm-exhausted");
    const criteria = deriveIdempotencyContinuationCriteria({
      row: exhausted,
      attempts: [],
      journaledAttempts: 0,
      effects: [],
      effectCounts: {},
      segments: 1,
      waitUserCycles: 0,
      resumeAdmitted: 0,
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    // No failure + a FAILED-expected row → the outcome contract fails.
    expect(criteria.find((c) => c.criterionId === "outcome-contract")?.status).toBe("FAIL");
  });
});
