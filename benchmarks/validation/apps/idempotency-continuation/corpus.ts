/**
 * The idempotency-and-continuation corpus (VAL-021, AC1): the declared
 * rows of the duplicate/replay/retry/escalation/continuation
 * application. Per row: the submission pattern (duplicate / conflict /
 * retry / escalate / continue), the expected ledger outcome (the
 * replayed/rejected submission counts, the wait-user/resume cycles,
 * the escalation routing, the bounded-retry attempt sequence) and the
 * expected effect multiplicity (the exactly-once settlement contract).
 *
 * Every offline row is deterministically reproducible through the
 * app's fixtures (the ledger-level rows need no provider at all — the
 * duplicate/conflict/storm semantics are pure ledger arbitration);
 * the live rows are env-gated on the authorized rail and demand REAL
 * model dispatches where the continuation semantics require them (the
 * continuation supervisor's confirmation round).
 *
 * The pinned policies: the bounded dispatch-retry budget is TWO extra
 * attempts (the program's bounded-retry precedent); the escalation
 * depth bound is TWO (an escalation loop terminates honestly there).
 */

import type {
  ContinuationCorpusRow,
  ContinuationSegmentSpec,
} from "../../platform/idempotency-continuation";
import { notify, settle } from "./fixtures";

/** The pinned bounded-retry budget the corpus oracles assume. */
export const CORPUS_RETRY_POLICY = {
  maxExtraAttempts: 2,
} as const;

/** The pinned escalation depth bound (a loop terminates honestly here). */
export const CORPUS_ESCALATION_DEPTH = 2;

/** The declared escalation authority of the escalate rows. */
export const ESCALATION_AUTHORITY = "settlement-ops-oncall";

/** The task kind every row's submission carries (the app's task vocabulary). */
export const IDEMPOTENCY_TASK_KIND = "idempotency-continuation.settlement.v1";

/** The offline rows (deterministic — always drivable, zero credentials). */
export const OFFLINE_CORPUS_ROWS: readonly ContinuationCorpusRow[] = [
  {
    rowId: "duplicate-submission-replay",
    pattern: "duplicate",
    description:
      "A duplicate submission (the SAME idempotency key + the SAME request fingerprint): the ledger REPLAYS the durable outcome — the identity is preserved, the replayed flag is surfaced and ZERO new effects land (the settlement applies exactly once across both submissions).",
    segments: [{ dispatch: false, effects: [settle("INV-101", 12_500)], continueAfter: false }],
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "duplicate-submission-replay", invoice: "INV-101" },
    submissions: { count: 2 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-101": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "conflicting-replay-rejected",
    pattern: "conflict",
    description:
      "A conflicting replay (the SAME idempotency key + a DIFFERENT request fingerprint — a mutated settlement task): the ledger rejects it with the typed IDEMPOTENCY_KEY_REUSED (409) — never a second execution; the original completes; the mutated task's effect NEVER lands.",
    segments: [{ dispatch: false, effects: [settle("INV-102", 8_800)], continueAfter: false }],
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "conflicting-replay-rejected", invoice: "INV-102" },
    submissions: {
      count: 2,
      // The conflicting task body: a DIFFERENT settlement (a different
      // fingerprint — the same key must never silently adopt it).
      conflictingTask: {
        kind: IDEMPOTENCY_TASK_KIND,
        rowId: "conflicting-replay-rejected",
        invoice: "INV-999",
        amountMicro: 999_999,
      },
    },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-102": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 1,
    },
  },
  {
    rowId: "retry-storm-converged",
    pattern: "retry",
    description:
      "A retry storm at the ledger level (FIVE rapid identical creates under the SAME key): the idempotency ledger converges them — ONE durable execution, FOUR replays, zero new effects (the settlement applies exactly once across the whole storm).",
    segments: [{ dispatch: false, effects: [settle("INV-103", 15_000)], continueAfter: false }],
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "retry-storm-converged", invoice: "INV-103" },
    submissions: { count: 5 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-103": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 4,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "retry-storm-bounded-dispatch",
    pattern: "retry",
    description:
      "A retry storm at the dispatch level (a transient transport fault twice, then recovery): the bounded retry policy drives exactly three attempts — every attempt journaled EXACTLY once with a gapless sequence — and the settlement effect applies exactly once (only after the successful attempt).",
    segments: [
      {
        dispatch: true,
        effects: [settle("INV-104", 9_900), notify("INV-104")],
        continueAfter: false,
      },
    ],
    needsDispatch: true,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "retry-storm-bounded-dispatch", invoice: "INV-104" },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-104": 1, "notify:INV-104": 1 },
      attemptOutcomes: ["failure", "failure", "success"],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "retry-storm-exhausted",
    pattern: "retry",
    description:
      "A retry storm that never recovers (the transport fault persists): the bounded policy stops at exactly 1 + 2 attempts (never an infinite loop), every attempt journaled exactly once, ZERO effects land and the terminal is the honest FAILED.",
    segments: [{ dispatch: true, effects: [settle("INV-105", 7_700)], continueAfter: false }],
    needsDispatch: true,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "retry-storm-exhausted", invoice: "INV-105" },
    submissions: { count: 1 },
    expected: {
      terminal: "FAILED",
      effects: {},
      attemptOutcomes: ["failure", "failure", "failure"],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "escalation-routed-once",
    pattern: "escalate",
    description:
      "An escalation (a gated refund proposal the scripted authority escalates): the escalation ROUTES to the declared authority carrying the full causal chain (submission digest → gate-proposal digest → decision digest); the idempotent re-escalation (the SAME key) REPLAYS — the authority receives it exactly once; the gated refund NEVER executes; the settlement completes honestly.",
    segments: [
      {
        dispatch: false,
        effects: [settle("INV-106", 4_400)],
        continueAfter: false,
      },
    ],
    escalation: {
      gateId: "refund-gate-1",
      proposal: { refundId: "REF-201", invoiceId: "INV-106", amountMicro: 4_400 },
      authority: ESCALATION_AUTHORITY,
    },
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "escalation-routed-once", invoice: "INV-106" },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-106": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 1,
      reEscalationReplayed: true,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "continuation-resume-once",
    pattern: "continue",
    description:
      "A continuation (the execution parks in WAITING_USER after the first settlement segment, the external continuation input arrives, the execution resumes EXACTLY once and completes the second segment): both segments' effects apply exactly once — the resume never redoes segment 1's committed work.",
    segments: [
      { dispatch: false, effects: [settle("INV-107", 11_000)], continueAfter: true },
      {
        dispatch: false,
        effects: [settle("INV-108", 6_600), notify("INV-108")],
        continueAfter: false,
      },
    ],
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "continuation-resume-once", invoices: ["INV-107", "INV-108"] },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-107": 1, "settle:INV-108": 1, "notify:INV-108": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 1,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "continuation-stale-worker-denied",
    pattern: "continue",
    description:
      "The stale-worker denial (the double-resume attempt): the successor resumes the WAITING_USER execution; the STALE worker then re-issues its own resume against the now-RUNNING execution — the REAL state machine DENIES it (resume is legal only from the WAITING_* states) and the denial is journaled as resume-denied evidence; zero extra effects land.",
    segments: [
      { dispatch: false, effects: [settle("INV-109", 3_300)], continueAfter: true },
      { dispatch: false, effects: [settle("INV-110", 5_500)], continueAfter: false },
    ],
    needsDispatch: false,
    staleWorkerProbe: true,
    noOpResumeProbe: false,
    submissionDigestInput: {
      rowId: "continuation-stale-worker-denied",
      invoices: ["INV-109", "INV-110"],
    },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-109": 1, "settle:INV-110": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 1,
      staleWorkerDenied: true,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "continuation-noop-resume-replay",
    pattern: "continue",
    description:
      "The no-op resume replay after terminal (the VAL-014 ledger-key discipline): after the execution COMPLETES, the EXACT completion transition is re-issued under the SAME idempotency key — the platform's ledger REPLAYS it (zero state change, zero new effects, the identity-preserving replay).",
    segments: [{ dispatch: false, effects: [settle("INV-111", 2_200)], continueAfter: false }],
    needsDispatch: false,
    staleWorkerProbe: false,
    noOpResumeProbe: true,
    submissionDigestInput: { rowId: "continuation-noop-resume-replay", invoice: "INV-111" },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-111": 1 },
      attemptOutcomes: [],
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: true,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
];

/** The live rows (env-gated on the authorized rail; REAL model dispatches). */
export const LIVE_CORPUS_ROWS: readonly ContinuationCorpusRow[] = [
  {
    rowId: "live-continuation-supervised",
    pattern: "continue",
    description:
      "A REAL continuation (env-gated): the continuation supervisor's confirmation is a REAL model dispatch per segment — segment 1's REAL round, the GENUINE wait-user park, the resume, segment 2's REAL round — with both segments' effects applying exactly once and the usage/cost measured (never estimated).",
    segments: [
      { dispatch: true, effects: [settle("INV-201", 21_000)], continueAfter: true },
      {
        dispatch: true,
        effects: [settle("INV-202", 13_000), notify("INV-202")],
        continueAfter: false,
      },
    ],
    needsDispatch: true,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: {
      rowId: "live-continuation-supervised",
      invoices: ["INV-201", "INV-202"],
    },
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the continuation supervisor's REAL confirmation rounds demand REAL model dispatches",
    },
    submissions: { count: 1 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-201": 1, "settle:INV-202": 1, "notify:INV-202": 1 },
      // Unpinned (the honest live boundary): a transient rail failure
      // may legitimately retry within the bounded policy; the pinned
      // contract is the terminal, the continuation cycles and the
      // exactly-once effects.
      attemptOutcomes: null,
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 1,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 0,
      rejectedSubmissions: 0,
    },
  },
  {
    rowId: "live-duplicate-after-real-dispatch",
    pattern: "duplicate",
    description:
      "A duplicate submission composed with REAL work (env-gated): the first submission drives a REAL supervisor confirmation round and the settlement completes; the duplicate create (the SAME key + fingerprint) then REPLAYS the durable receipt — identity preserved, zero new REAL dispatches, zero new effects.",
    segments: [{ dispatch: true, effects: [settle("INV-203", 17_500)], continueAfter: false }],
    needsDispatch: true,
    staleWorkerProbe: false,
    noOpResumeProbe: false,
    submissionDigestInput: { rowId: "live-duplicate-after-real-dispatch", invoice: "INV-203" },
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model — the settlement's REAL confirmation round demands a REAL model dispatch",
    },
    submissions: { count: 2 },
    expected: {
      terminal: "COMPLETED",
      effects: { "settle:INV-203": 1 },
      attemptOutcomes: null,
      maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
      waitUserCycles: 0,
      staleWorkerDenied: false,
      noopResumeReplayed: false,
      escalationRouted: 0,
      reEscalationReplayed: false,
      replayedSubmissions: 1,
      rejectedSubmissions: 0,
    },
  },
];

/** The full pinned corpus (offline rows first, live rows last). */
export const CONTINUATION_CORPUS: readonly ContinuationCorpusRow[] = [
  ...OFFLINE_CORPUS_ROWS,
  ...LIVE_CORPUS_ROWS,
];

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: ContinuationCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

/**
 * The app's task body for one row (the request fingerprint's driver):
 * the row's identity + its settlement work. The conflicting task body
 * (conflict rows) is declared by the row itself.
 */
export function taskBodyFor(row: ContinuationCorpusRow): Record<string, unknown> {
  return {
    kind: IDEMPOTENCY_TASK_KIND,
    rowId: row.rowId,
    pattern: row.pattern,
    invoice: firstInvoiceOf(row),
  };
}

/** The first settlement invoice the row's segments declare (the task's discriminator). */
function firstInvoiceOf(row: ContinuationCorpusRow): string {
  const effect = row.segments
    .flatMap((segment: ContinuationSegmentSpec) => [...segment.effects])
    .find((candidate) => candidate.kind === "settle");
  return effect?.key ?? "none";
}
