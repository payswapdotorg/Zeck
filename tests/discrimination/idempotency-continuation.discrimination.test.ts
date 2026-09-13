/**
 * VAL-021 acceptance criterion 6 — discrimination tests proving the
 * idempotency-and-continuation semantics against controlled fakes:
 *
 *   * forged replay claims — a "replay" claiming a different identity
 *     FAILS the submission contract mechanically (identity preservation
 *     is asserted, never trusted); a client claiming a replay with a
 *     DIFFERENT fingerprint still gets the typed key-reuse rejection
 *     (the arbitration is the LEDGER's, never the client's claim);
 *   * journal gaps — a synthetic journal with a hole (a silently
 *     dropped effect) and one with a duplicate sequence (a
 *     double-written record) both FAIL the gapless criterion; the real
 *     driver produces neither shape;
 *   * double-resume attempts — the stale worker's second resume is
 *     DENIED by the state machine (admitted only from WAITING_*); a
 *     platform that ADMITS it is detected by the resume-exactly-once
 *     criterion and fails the run honestly;
 *   * escalation loops — an authority that always re-escalates is
 *     terminated at the depth bound with the honest FAILED (exactly
 *     max-depth routings, distinct ledger keys per depth); an
 *     incomplete causal chain never passes the routing criterion.
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_ESCALATION_DEPTH,
  CORPUS_RETRY_POLICY,
  OFFLINE_CORPUS_ROWS,
} from "../../benchmarks/validation/apps/idempotency-continuation/corpus";
import {
  createScriptedEscalationAuthority,
  createSettlementWorld,
  receiveEscalation,
} from "../../benchmarks/validation/apps/idempotency-continuation/fixtures";
import {
  buildCausalChain,
  type ContinuationCorpusRow,
  causalChainComplete,
  deriveIdempotencyContinuationCriteria,
  deriveJournalGaplessness,
  driveIdempotencyContinuationExecution,
  IDEMPOTENCY_KEY_REUSED_CODE,
  type IdempotencyContinuationLifecyclePort,
  isRetryableDispatchCategory,
  verifySubmissionContract,
} from "../../benchmarks/validation/platform/idempotency-continuation";

const noSleep = async () => {};

function recordingLifecycle(options?: { readonly admitEveryResume?: boolean }): {
  readonly lifecycle: IdempotencyContinuationLifecyclePort & {
    readonly resumeAttempts: string[];
    readonly escalations: { callKey: string; gateId: string }[];
  };
} {
  const resumeAttempts: string[] = [];
  const escalations: { callKey: string; gateId: string }[] = [];
  // The fake mirrors the REAL state machine's resume legality.
  let status = "CREATED";
  let resumed = false;
  const lifecycle: IdempotencyContinuationLifecyclePort = {
    async transition({ step }) {
      // The ATTEMPT is recorded before the legality check (a denied
      // resume still happened — the fake mirrors the REAL machine's
      // journal-then-fail discipline).
      resumeAttempts.push(step);
      if (step === "resume" && status !== "WAITING_USER" && !(options?.admitEveryResume === true)) {
        throw new Error(`INVALID_STATE_TRANSITION: resume illegal from ${status}`);
      }
      if (step === "authorize") status = "AUTHORIZED";
      if (step === "plan") status = "PLANNING";
      if (step === "queue") status = "QUEUED";
      if (step === "start") status = "RUNNING";
      if (step === "wait-user") status = "WAITING_USER";
      if (step === "resume") {
        status = "RUNNING";
        resumed = true;
      }
      if (step === "verify") status = "VERIFYING";
    },
    async recordPlanningDecision() {},
    async recordDispatchAttempt() {},
    async recordEffect() {},
    async recordInterruption() {},
    async recordResumeDenied() {},
    async recordEscalation({ gateId, callKey }) {
      const seen = escalations.find((record) => record.callKey === callKey);
      if (seen !== undefined) {
        return { routed: false, replayed: true };
      }
      escalations.push({ callKey, gateId });
      return { routed: true, replayed: false };
    },
    async complete() {
      status = "COMPLETED";
    },
    async attemptNoOpResume() {
      return { replayed: true };
    },
  };
  void resumed;
  return { lifecycle: Object.assign(lifecycle, { resumeAttempts, escalations }) };
}

const row = (rowId: string): ContinuationCorpusRow => {
  const found = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (found === undefined) throw new Error(`missing corpus row ${rowId}`);
  return found;
};

describe("idempotency-continuation discrimination (VAL-021 AC6)", () => {
  test("forged replay claims: a replay claiming a DIFFERENT identity FAILs the submission contract (identity is asserted, never trusted)", () => {
    const criteria = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 1, rejectedSubmissions: 0 },
      firstExecutionId: "exec-real",
      observations: [
        { executionId: "exec-real", replayed: false, status: "CREATED", rejection: null },
        { executionId: "exec-rogue", replayed: true, status: "CREATED", rejection: null },
      ],
    });
    const identity = criteria.find((c) => c.criterionId === "replay-identity-preserved");
    expect(identity?.status).toBe("FAIL");
    // The counts criterion still PASSES (the shapes match) — the
    // FORGERY is exactly the identity violation.
    expect(criteria.find((c) => c.criterionId === "submission-counts")?.status).toBe("PASS");
  });

  test("forged replay claims: a missing replayed flag FAILs the counts contract (the flag is part of the contract, not optional)", () => {
    const criteria = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 1, rejectedSubmissions: 0 },
      firstExecutionId: "exec-real",
      observations: [
        { executionId: "exec-real", replayed: false, status: "CREATED", rejection: null },
        { executionId: "exec-real", replayed: false, status: "CREATED", rejection: null },
      ],
    });
    // The replayed count is 0 against the expected 1 — the counts
    // criterion catches the missing flag.
    expect(criteria.find((c) => c.criterionId === "submission-counts")?.status).toBe("FAIL");
  });

  test("forged replay claims: the arbitration is the LEDGER's — a different fingerprint under a seen key is the typed rejection regardless of the client's claim", () => {
    // The ledger decision table: a seen key + a different fingerprint is
    // the rejection — there is NO client-side override.
    const conflictCriteria = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 0, rejectedSubmissions: 1 },
      firstExecutionId: "exec-real",
      observations: [
        { executionId: "exec-real", replayed: false, status: "CREATED", rejection: null },
        {
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: IDEMPOTENCY_KEY_REUSED_CODE, status: 409 },
        },
      ],
    });
    expect(conflictCriteria.every((c) => c.status === "PASS")).toBe(true);

    // A generic rejection (the wrong code, the wrong status) FAILs the
    // typed-rejection criterion — the typed token is the contract.
    const genericCriteria = verifySubmissionContract({
      expected: { submissions: 2, replayedSubmissions: 0, rejectedSubmissions: 1 },
      firstExecutionId: "exec-real",
      observations: [
        { executionId: "exec-real", replayed: false, status: "CREATED", rejection: null },
        {
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: "PROVIDER_ERROR", status: 500 },
        },
      ],
    });
    expect(genericCriteria.find((c) => c.criterionId === "typed-rejection-surfaced")?.status).toBe(
      "FAIL",
    );
  });

  test("journal gaps: a synthetic hole and a synthetic duplicate sequence both FAIL the gapless derivation; the real driver's journal is gapless", async () => {
    // (a) A hole: sequence 3 was silently dropped.
    const hole = deriveJournalGaplessness([1, 2, 4]);
    expect(hole.gapless).toBe(false);
    expect(hole.holes).toEqual([3]);
    // (b) A duplicate: sequence 2 was double-written.
    const duplicate = deriveJournalGaplessness([1, 2, 2, 3]);
    expect(duplicate.gapless).toBe(false);
    expect(duplicate.duplicates).toEqual([2]);

    // (c) The criteria derivation FAILs on the holed journal.
    const continueRow = row("continuation-resume-once");
    const holed = deriveIdempotencyContinuationCriteria({
      row: continueRow,
      attempts: [],
      journaledAttempts: 0,
      effects: [
        { sequence: 1, effect: "settle:INV-107", attempt: null, digest: "aaaaaaaa" },
        { sequence: 3, effect: "settle:INV-108", attempt: null, digest: "bbbbbbbb" },
      ],
      effectCounts: { "settle:INV-107": 1, "settle:INV-108": 1 },
      segments: 2,
      waitUserCycles: 1,
      resumeAdmitted: 1,
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    expect(holed.find((c) => c.criterionId === "journal-sequence-gapless")?.status).toBe("FAIL");

    // (d) The real driver produces a gapless journal.
    const result = await driveContinueRow();
    expect(result.criteria.find((c) => c.criterionId === "journal-sequence-gapless")?.status).toBe(
      "PASS",
    );
    expect(result.effects.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  test("double-resume attempts: the stale worker's second resume is DENIED (admitted only from WAITING_*); a platform admitting it is caught mechanically", async () => {
    // (a) The honest platform: the denial is journaled, the run completes.
    const denied = await driveStaleWorkerRow(false);
    expect(denied.result.terminal).toBe("COMPLETED");
    expect(denied.result.staleWorkerDenied).toBe(true);
    expect(denied.result.resumeAdmitted).toBe(1);
    expect(denied.lifecycle.resumeAttempts.filter((step) => step === "resume").length).toBe(2);
    expect(
      denied.result.criteria.find((c) => c.criterionId === "resume-exactly-once")?.status,
    ).toBe("PASS");

    // (b) The violating platform: the double resume is ADMITTED — the
    // resume-exactly-once criterion detects it (2 admissions against
    // 1 park) and the terminal is the honest FAILED.
    const admitted = await driveStaleWorkerRow(true);
    expect(admitted.result.terminal).toBe("FAILED");
    expect(admitted.result.failure?.category).toBe("double-resume-admitted");
    expect(admitted.result.resumeAdmitted).toBe(2);
    expect(
      admitted.result.criteria.find((c) => c.criterionId === "resume-exactly-once")?.status,
    ).toBe("FAIL");
  });

  test("escalation loops: an authority that always re-escalates is terminated at the depth bound — exactly max-depth routings with DISTINCT ledger keys, never an infinite loop", async () => {
    const escalateRow = row("escalation-routed-once");
    const { lifecycle } = recordingLifecycle();
    const authority = createScriptedEscalationAuthority({
      authority: "settlement-ops-oncall",
      decisions: { 1: "re-escalate", 2: "re-escalate", 3: "re-escalate", 4: "re-escalate" },
    });
    const original = lifecycle.recordEscalation.bind(lifecycle);
    lifecycle.recordEscalation = async (input) => {
      const outcome = await original(input);
      if (outcome.routed) {
        receiveEscalation(authority, {
          gateId: input.gateId,
          authority: input.authority,
          causalChain: input.causalChain,
        });
      }
      return outcome;
    };
    const world = createSettlementWorld();
    const result = await driveIdempotencyContinuationExecution({
      executionId: "exec-loop-disc",
      row: escalateRow,
      provider: "p",
      model: "m",
      lifecycle,
      world,
      escalationSource: authority,
      retry: {
        maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
        backoffMs: 0,
        sleep: noSleep,
      },
      maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
      now: () => new Date(1_000),
    });
    // The loop TERMINATED at the bound (the run ends — no infinite loop).
    expect(result.failure?.category).toBe("escalation-depth-exceeded");
    expect(result.terminal).toBe("FAILED");
    // Exactly max-depth routings — the depth-3 decision never routed.
    expect(lifecycle.escalations).toHaveLength(CORPUS_ESCALATION_DEPTH);
    // Every routed escalation carried a DISTINCT ledger key (the
    // distinct-payload discipline — a re-escalation is a NEW decision).
    const keys = lifecycle.escalations.map((record) => record.callKey);
    expect(new Set(keys).size).toBe(keys.length);
    // The over-routing is mechanically detected.
    expect(result.criteria.find((c) => c.criterionId === "escalation-routing")?.status).toBe(
      "FAIL",
    );
  });

  test("escalation chains: an incomplete causal chain never passes the routing criterion (all three causes required, digests well-formed)", () => {
    expect(
      buildCausalChain({ submission: { a: 1 }, gateProposal: { b: 2 }, decision: { c: 3 } }).length,
    ).toBe(3);
    const complete = buildCausalChain({ submission: "s", gateProposal: "g", decision: "d" });
    const incomplete = complete.slice(0, 2);
    expect(causalChainComplete(complete)).toBe(true);
    expect(causalChainComplete(incomplete)).toBe(false);
    expect(
      causalChainComplete([
        ...complete.slice(0, 2),
        { cause: "escalation-decision", digest: "not-a-digest" },
      ]),
    ).toBe(false);
  });

  test("retry taxonomy: the retryable set is exactly the three documented categories; everything else never retries", () => {
    expect(isRetryableDispatchCategory("transport-failure")).toBe(true);
    expect(isRetryableDispatchCategory("rate-limit")).toBe(true);
    expect(isRetryableDispatchCategory("provider-unavailable")).toBe(true);
    expect(isRetryableDispatchCategory("invalid-request")).toBe(false);
    expect(isRetryableDispatchCategory("auth")).toBe(false);
    expect(isRetryableDispatchCategory("malformed-response")).toBe(false);
    expect(isRetryableDispatchCategory("")).toBe(false);
  });

  test("effect-multiplicity discrimination: a double-settled invoice and an unexpected settlement both FAIL (the replay that re-applied is caught against the fixture counters)", () => {
    const duplicateRow = row("duplicate-submission-replay");
    const doubleSettled = deriveIdempotencyContinuationCriteria({
      row: duplicateRow,
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
    expect(
      doubleSettled.find((c) => c.criterionId === "effect-multiplicity-exactly-once")?.status,
    ).toBe("FAIL");

    const unexpected = deriveIdempotencyContinuationCriteria({
      row: duplicateRow,
      attempts: [],
      journaledAttempts: 0,
      effects: [
        { sequence: 1, effect: "settle:INV-101", attempt: null, digest: "aaaaaaaa" },
        { sequence: 2, effect: "settle:INV-999", attempt: null, digest: "cccccccc" },
      ],
      effectCounts: { "settle:INV-101": 1, "settle:INV-999": 1 },
      segments: 1,
      waitUserCycles: 0,
      resumeAdmitted: 0,
      staleWorkerDenied: null,
      escalations: [],
      failure: null,
      usage: null,
    });
    const multiplicity = unexpected.find(
      (c) => c.criterionId === "effect-multiplicity-exactly-once",
    );
    expect(multiplicity?.status).toBe("FAIL");
    expect(multiplicity?.evidence.join(" ")).toContain("unexpected:settle:INV-999");
  });
});

// ---------------------------------------------------------------------------
// Helpers driving the stale-worker and continuation rows over the fake stack
// ---------------------------------------------------------------------------

async function driveContinueRow(): Promise<
  Awaited<ReturnType<typeof driveIdempotencyContinuationExecution>>
> {
  const { lifecycle } = recordingLifecycle();
  const world = createSettlementWorld();
  return driveIdempotencyContinuationExecution({
    executionId: "exec-continue-disc",
    row: row("continuation-resume-once"),
    provider: "p",
    model: "m",
    lifecycle,
    world,
    retry: { maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts, backoffMs: 0, sleep: noSleep },
    maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
    now: () => new Date(1_000),
  });
}

async function driveStaleWorkerRow(admitEveryResume: boolean): Promise<{
  result: Awaited<ReturnType<typeof driveIdempotencyContinuationExecution>>;
  lifecycle: ReturnType<typeof recordingLifecycle>["lifecycle"];
}> {
  const { lifecycle } = recordingLifecycle({ admitEveryResume });
  const world = createSettlementWorld();
  const result = await driveIdempotencyContinuationExecution({
    executionId: "exec-stale-disc",
    row: row("continuation-stale-worker-denied"),
    provider: "p",
    model: "m",
    lifecycle,
    world,
    retry: { maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts, backoffMs: 0, sleep: noSleep },
    maxEscalationDepth: CORPUS_ESCALATION_DEPTH,
    now: () => new Date(1_000),
  });
  return { result, lifecycle };
}
