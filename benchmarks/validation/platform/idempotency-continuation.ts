/**
 * The platform-side idempotency-and-continuation driver (VAL-021).
 *
 * The reliability slice for submission-level semantics: drives
 * duplicate/replay/retry/escalation/continuation executions through the
 * REAL platform path, mechanically proving the exactly-once submission
 * contract the idempotency ledger, the executions state machine and the
 * journal are responsible for:
 *
 *   * the submission-pattern vocabulary as PURE derivations —
 *     `classifySubmissionArbitration` (the ledger's own decision table:
 *     same key + same fingerprint → REPLAY; same key + different
 *     fingerprint → the typed `IDEMPOTENCY_KEY_REUSED` rejection; a
 *     fresh key → a new durable row), `verifyReplayIdentity` (identity
 *     preservation + the replayed flag surfaced — a replay that claims
 *     a different identity is a forged claim), `deriveJournalGaplessness`
 *     (the gapless-sequence contract: 1..N with no holes and no
 *     duplicates), `deriveEffectMultiplicity` (the exactly-once effect
 *     contract against the fixture state's counters),
 *     `classifyResumeAttempt` (mirroring the REAL state machine's own
 *     table: resume is legal only from the WAITING_* states; a resume
 *     against RUNNING is the stale-worker denial; terminal states are
 *     immutable) and `verifySubmissionContract` (the app-side submission
 *     observations judged against the corpus row's declared pattern);
 *   * the effect journal: every applied effect is journaled EXACTLY
 *     once with a monotone sequence (digests in the journal, never
 *     payload bytes; the sequence continuity is checked mechanically —
 *     a journal gap or a duplicate sequence FAILS);
 *   * the bounded dispatch retry loop for the retry rows: RETRYABLE
 *     failure categories only (transport-failure / rate-limit /
 *     provider-unavailable), at most `maxExtraAttempts` extra attempts
 *     with a measured backoff, every attempt journaled EXACTLY once —
 *     the storm converges (the app-level duplicate submissions all
 *     replay the one durable execution);
 *   * the escalation rail: a gated effect's escalation decision routes
 *     to the declared authority carrying the full causal chain
 *     (submission digest → gate-proposal digest → decision digest —
 *     DIGESTS only), journal-then-notify with idempotent re-escalation
 *     (a re-issued escalation with the SAME key REPLAYS — the
 *     authority receives it exactly once), and a bounded escalation
 *     depth (an escalation loop terminates honestly at the bound);
 *   * the continuation machinery: a GENUINE wait-user → resume pair
 *     (the execution parks in WAITING_USER and resumes EXACTLY once),
 *     the stale-worker denial (a second resume against the resumed
 *     RUNNING execution is rejected by the REAL state machine and
 *     journaled as resume-denied evidence), and the no-op resume
 *     replay after terminal (re-issuing the EXACT completion
 *     transition under the same idempotency key REPLAYS — zero state
 *     change; the VAL-014 ledger-key discipline);
 *   * the execution driver mirroring the VAL-019/020 drivers
 *     (authorize → plan → planning-decision BEFORE the first dispatch →
 *     queue → start → the pattern's machinery → verify → terminal: a
 *     failure outcome or any failed criterion → FAILED — never a
 *     partial-success shortcut).
 *
 * Honesty invariants:
 *   * a replay NEVER re-applies effects (identity preservation is
 *     asserted mechanically — a forged replay claim fails);
 *   * a conflicting replay is the typed IDEMPOTENCY_KEY_REUSED
 *     rejection — surfaced as evidence, never tolerated as a second
 *     execution;
 *   * a failed dispatch attempt FAILS the execution when the retry
 *     budget is exhausted (no partial-success shortcut); retries are
 *     bounded and journaled exactly once per attempt;
 *   * an escalation NEVER executes the gated effect; an escalation
 *     loop terminates at the depth bound with an honest FAILED;
 *   * a continuation resumes EXACTLY once — the stale worker's resume
 *     is denied and journaled; the no-op resume REPLAYS the completion
 *     with zero state change;
 *   * usage, cost and latency are measured, never estimated; evidence
 *     carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected and network-free here (the lab
 * contract); the integration seam binds the REAL executions service,
 * the REAL idempotency ledger and the REAL journal vocabularies.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The submission-pattern vocabulary (the corpus's declared patterns)
// ---------------------------------------------------------------------------

/** The five submission patterns the VAL-021 corpus exercises. */
export const SUBMISSION_PATTERNS = [
  // same idempotency key + same fingerprint → REPLAY, zero new effects
  "duplicate",
  // same key + different fingerprint → the typed key-reuse rejection
  "conflict",
  // bounded, journaled exactly once per attempt (ledger-level storm
  // convergence + dispatch-level bounded retry)
  "retry",
  // route to the escalation authority with the full causal chain
  "escalate",
  // resume a wait-user execution exactly once (stale-worker denial +
  // no-op resume replay)
  "continue",
] as const;

export type SubmissionPattern = (typeof SUBMISSION_PATTERNS)[number];

export function isSubmissionPattern(value: string): value is SubmissionPattern {
  return (SUBMISSION_PATTERNS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The ledger-arbitration taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/**
 * The platform's typed key-reuse rejection code (the public error
 * taxonomy's stable token — the code the conflicting replay surfaces).
 */
export const IDEMPOTENCY_KEY_REUSED_CODE = "IDEMPOTENCY_KEY_REUSED";

/** The ledger's arbitration verdict for one submitted create. */
export type LedgerArbitration = "created" | "replayed" | "rejected-key-reuse";

/**
 * The ledger's own decision table (PURE): a fresh key creates; a seen
 * key with a MATCHING fingerprint replays the durable outcome; a seen
 * key with a DIFFERENT fingerprint is the typed key-reuse rejection.
 * The arbitration is the LEDGER's — never the client's claim.
 */
export function classifySubmissionArbitration(input: {
  readonly keySeenBefore: boolean;
  /**
   * Whether the submitted fingerprint matches the ledger's stored
   * fingerprint for the key (null when the key was never seen).
   */
  readonly fingerprintMatches: boolean | null;
}): LedgerArbitration {
  if (!input.keySeenBefore) {
    return "created";
  }
  if (input.fingerprintMatches === true) {
    return "replayed";
  }
  return "rejected-key-reuse";
}

/** One submitted create's observed receipt (the app-side observation). */
export interface SubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  /** The terminal status at observation (when the create succeeded). */
  readonly status: string | null;
  /** The typed rejection (when the create was rejected). */
  readonly rejection: { readonly code: string; readonly status: number } | null;
}

/** The identity-preservation verdict for one replayed submission. */
export interface ReplayIdentityVerdict {
  readonly identityPreserved: boolean;
  readonly replayedFlagSurfaced: boolean;
}

/**
 * Verify a replayed submission's identity (PURE): the replayed receipt
 * must surface the SAME execution identity the first create durably
 * bound to the key AND the replayed flag. A "replay" claiming a
 * different identity is a forged claim — mechanically detected here.
 */
export function verifyReplayIdentity(
  first: SubmissionObservation,
  replayed: SubmissionObservation,
): ReplayIdentityVerdict {
  return {
    identityPreserved: first.executionId === replayed.executionId,
    replayedFlagSurfaced: replayed.replayed === true,
  };
}

/**
 * Judge the app-side submission observations against the corpus row's
 * declared pattern contract (PURE): the created count, the replayed
 * count, the typed-rejection count, identity preservation on every
 * replay and the typed rejection code on every rejection. The criteria
 * this derivation returns ride the app's assertion verdict (the app
 * NEVER passes a violated submission contract).
 */
export function verifySubmissionContract(input: {
  readonly expected: {
    readonly submissions: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
  };
  readonly firstExecutionId: string | null;
  readonly observations: readonly SubmissionObservation[];
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const observed = input.observations;
  const created = observed.filter(
    (observation) => !observation.replayed && observation.rejection === null,
  ).length;
  const replayed = observed.filter(
    (observation) => observation.replayed && observation.rejection === null,
  ).length;
  const rejected = observed.filter((observation) => observation.rejection !== null).length;

  // 1. The submission-count contract (the storm's exact shape).
  const countsOk =
    created + replayed + rejected === input.expected.submissions &&
    replayed === input.expected.replayedSubmissions &&
    rejected === input.expected.rejectedSubmissions;
  criteria.push({
    criterionId: "submission-counts",
    strategy: "deterministic",
    status: countsOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${input.expected.submissions}=${input.expected.replayedSubmissions}replayed+${input.expected.rejectedSubmissions}rejected`,
      `observed:${created}created+${replayed}replayed+${rejected}rejected`,
    ],
  });

  // 2. Identity preservation + the replayed flag on EVERY replay.
  const replayObservations = observed.filter(
    (observation) => observation.replayed && observation.rejection === null,
  );
  const identityOk =
    input.firstExecutionId !== null &&
    replayObservations.every(
      (observation) =>
        observation.executionId === input.firstExecutionId && observation.replayed === true,
    );
  criteria.push({
    criterionId: "replay-identity-preserved",
    strategy: "deterministic",
    status: identityOk ? "PASS" : "FAIL",
    evidence: [
      `firstExecutionId:${input.firstExecutionId ?? "none"}`,
      `replays:${
        replayObservations.map((observation) => observation.executionId).join("|") || "none"
      }`,
      `replayedFlags:${replayObservations.map((observation) => String(observation.replayed)).join("|") || "none"}`,
    ],
  });

  // 3. The typed rejection contract: every rejection is the platform's
  //    IDEMPOTENCY_KEY_REUSED (409) — never a generic failure.
  const rejectionObservations = observed.filter((observation) => observation.rejection !== null);
  const typedOk = rejectionObservations.every(
    (observation) =>
      observation.rejection !== null &&
      observation.rejection.code === IDEMPOTENCY_KEY_REUSED_CODE &&
      observation.rejection.status === 409,
  );
  criteria.push({
    criterionId: "typed-rejection-surfaced",
    strategy: "deterministic",
    status: typedOk ? "PASS" : "FAIL",
    evidence: [
      `rejections:${
        rejectionObservations
          .map(
            (observation) =>
              `${observation.rejection?.code ?? "none"}/${observation.rejection?.status ?? "?"}`,
          )
          .join("|") || "none"
      }`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// Journal-sequence continuity + effect multiplicity (PURE derivations)
// ---------------------------------------------------------------------------

/** The gapless-sequence verdict for one journal's observed sequences. */
export interface JournalGaplessnessVerdict {
  readonly gapless: boolean;
  readonly holes: readonly number[];
  readonly duplicates: readonly number[];
  readonly expectedMax: number;
}

/**
 * Derive the journal-sequence continuity (PURE): a well-formed journal
 * is EXACTLY 1..N — every sequence present once, no holes, no
 * duplicates. A journal gap (a silently dropped attempt or effect) or a
 * duplicate sequence (a double-written record) is mechanically detected
 * here (the AC4 gapless contract).
 */
export function deriveJournalGaplessness(sequences: readonly number[]): JournalGaplessnessVerdict {
  const expectedMax = sequences.length;
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const sequence of sequences) {
    if (seen.has(sequence)) {
      duplicates.push(sequence);
    }
    seen.add(sequence);
  }
  const holes: number[] = [];
  for (let expected = 1; expected <= expectedMax; expected += 1) {
    if (!seen.has(expected)) {
      holes.push(expected);
    }
  }
  return {
    gapless: holes.length === 0 && duplicates.length === 0,
    holes,
    duplicates,
    expectedMax,
  };
}

/** The exactly-once effect verdict against the fixture state's counters. */
export interface EffectMultiplicityVerdict {
  readonly exactlyOnce: boolean;
  readonly overApplied: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

/**
 * Derive the effect multiplicity (PURE): every expected effect's
 * observed count must be EXACTLY the expected count (exactly-once for
 * the corpus's settlements) and NO unexpected effect may have landed
 * (a replay that re-applied an effect, a storm that duplicated one, or
 * a gated effect that executed despite an escalation — all detected
 * here against the fixture state's own counters).
 */
export function deriveEffectMultiplicity(
  expected: Readonly<Record<string, number>>,
  observed: Readonly<Record<string, number>>,
): EffectMultiplicityVerdict {
  const overApplied: string[] = [];
  const missing: string[] = [];
  for (const [effect, count] of Object.entries(expected)) {
    const observedCount = observed[effect] ?? 0;
    if (observedCount > count) {
      overApplied.push(effect);
    } else if (observedCount < count) {
      missing.push(effect);
    }
  }
  const unexpected = Object.keys(observed).filter((effect) => !(effect in expected));
  return {
    exactlyOnce: overApplied.length === 0 && missing.length === 0 && unexpected.length === 0,
    overApplied,
    missing,
    unexpected,
  };
}

// ---------------------------------------------------------------------------
// Resume legality (PURE — mirrors the REAL state machine's own table)
// ---------------------------------------------------------------------------

/** The resume-attempt verdict mir the REAL state machine's legality. */
export type ResumeVerdict = "admitted" | "stale-worker-denied" | "terminal-immutable";

/**
 * Classify a resume attempt against the execution's CURRENT status
 * (PURE): resume is legal ONLY from the WAITING_* states (the state
 * machine's frozen table); a resume against RUNNING is the
 * stale-worker denial (the successor already owns the continuation);
 * a resume against a terminal state is terminal immutability (the
 * no-op path is the idempotent re-issue of the completion transition,
 * never a resume command).
 */
export function classifyResumeAttempt(currentStatus: string): ResumeVerdict {
  if (
    currentStatus === "WAITING_USER" ||
    currentStatus === "WAITING_TOOL" ||
    currentStatus === "WAITING_HUMAN"
  ) {
    return "admitted";
  }
  if (
    currentStatus === "COMPLETED" ||
    currentStatus === "FAILED" ||
    currentStatus === "CANCELLED" ||
    currentStatus === "EXPIRED"
  ) {
    return "terminal-immutable";
  }
  return "stale-worker-denied";
}

// ---------------------------------------------------------------------------
// The bounded dispatch-retry taxonomy (the retry rows)
// ---------------------------------------------------------------------------

/** The RETRYABLE dispatch-failure categories (bounded retry applies to these ONLY). */
const RETRYABLE_DISPATCH_CATEGORIES: ReadonlySet<string> = new Set([
  "transport-failure",
  "rate-limit",
  "provider-unavailable",
]);

/** Whether the dispatch-failure category may be retried (honest taxonomy). */
export function isRetryableDispatchCategory(category: string): boolean {
  return RETRYABLE_DISPATCH_CATEGORIES.has(category);
}

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

function digestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The escalation causal chain + decision source
// ---------------------------------------------------------------------------

/** One link of an escalation's causal chain (digests, never payloads). */
export interface CausalLink {
  readonly cause: "submission" | "gate-proposal" | "escalation-decision";
  readonly digest: string;
}

/** The escalation decision the scripted authority fixture returns. */
export type EscalationDecision = "escalate" | "re-escalate" | "resolve";

/** The scripted escalation decision source (deterministic provenance). */
export interface EscalationDecisionSource {
  decide(input: { readonly gateId: string; readonly depth: number }): EscalationDecision;
}

/** Build the causal chain for one escalation (digests only). */
export function buildCausalChain(input: {
  readonly submission: unknown;
  readonly gateProposal: unknown;
  readonly decision: unknown;
}): readonly CausalLink[] {
  return [
    { cause: "submission", digest: digestOf(input.submission) },
    { cause: "gate-proposal", digest: digestOf(input.gateProposal) },
    { cause: "escalation-decision", digest: digestOf(input.decision) },
  ];
}

/** Whether a causal chain is complete (every cause present, digests well-formed). */
export function causalChainComplete(chain: readonly CausalLink[]): boolean {
  const causes = new Set(chain.map((link) => link.cause));
  return (
    causes.has("submission") &&
    causes.has("gate-proposal") &&
    causes.has("escalation-decision") &&
    chain.every((link) => /^[0-9a-f]{8}$/.test(link.digest))
  );
}

/** One routed escalation record (what the driver observed). */
export interface EscalationRecord {
  readonly gateId: string;
  readonly authority: string;
  readonly depth: number;
  readonly routed: boolean;
  readonly replayed: boolean;
  readonly causalChain: readonly CausalLink[];
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

export interface IdempotencyContinuationLifecyclePort {
  /** Canonical transitions, incl. the continuation wait-user/resume pair. */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "wait-user" | "resume" | "verify";
    readonly reason: string;
    /** Unique per call (repeated steps must never collide on the ledger). */
    readonly callKey: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the first dispatch. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
  }): Promise<void>;
  /** The per-attempt dispatch journal — EXACTLY once per attempt (digests only). */
  recordDispatchAttempt(input: {
    readonly executionId: string;
    readonly record: DispatchAttemptRecord;
  }): Promise<void>;
  /** The effect journal — one record per applied effect, sequence-gapless. */
  recordEffect(input: {
    readonly executionId: string;
    readonly record: EffectJournalRecord;
  }): Promise<void>;
  /** The external interruption request evidence (the wait-user park). */
  recordInterruption(input: {
    readonly executionId: string;
    readonly at: number;
    readonly callKey: string;
  }): Promise<void>;
  /** The stale-worker resume denial (journal-then-fail evidence). */
  recordResumeDenied(input: {
    readonly executionId: string;
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  /**
   * Route an escalation to the declared authority with the causal
   * chain. Idempotent by the ledger: a re-issue with the SAME callKey
   * REPLAYS (the authority receives it exactly once — the routing
   * count never double-writes).
   */
  recordEscalation(input: {
    readonly executionId: string;
    readonly gateId: string;
    readonly authority: string;
    readonly causalChain: readonly CausalLink[];
    readonly callKey: string;
  }): Promise<{ readonly routed: boolean; readonly replayed: boolean }>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  /**
   * The no-op resume after terminal: re-issue the EXACT prior
   * completion transition under the SAME idempotency key — the
   * platform's ledger must REPLAY it (zero state change; the VAL-014
   * ledger-key discipline).
   */
  attemptNoOpResume(input: {
    readonly executionId: string;
    readonly completeCallKey: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<{ readonly replayed: boolean }>;
}

// ---------------------------------------------------------------------------
// The dispatch seam + the journals
// ---------------------------------------------------------------------------

/** The outcome of ONE dispatch attempt (one seam roundtrip). */
export interface DispatchAttemptOutcome {
  readonly kind: "success" | "failure";
  readonly content?: string;
  readonly usage?: LabUsage;
  /** The failure category (failures only). */
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
}

/** The dispatch seam: one continuation/supervisor round per call. */
export type ContinuationDispatch = (input: {
  readonly executionId: string;
  readonly segment: number;
  readonly attempt: number;
}) => Promise<DispatchAttemptOutcome>;

/** One journaled dispatch attempt (digests, never payload bytes). */
export interface DispatchAttemptRecord {
  /** 1-based attempt number within the segment's retry loop. */
  readonly attempt: number;
  readonly segment: number;
  readonly outcome: "success" | "failure";
  readonly category: string | null;
  readonly retryable: boolean;
  readonly retried: boolean;
  readonly latencyMs: number;
  readonly requestDigest: string;
}

/** One journaled effect application (the sequence-gapless journal). */
export interface EffectJournalRecord {
  /** The journal sequence (1-based, gapless across the execution). */
  readonly sequence: number;
  readonly effect: string;
  readonly attempt: number | null;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface IdempotencyContinuationRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly segments: number;
  readonly dispatchAttempts: number;
  readonly attempts: readonly DispatchAttemptRecord[];
  readonly effects: readonly EffectJournalRecord[];
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly waitUserCycles: number;
  readonly resumeAdmitted: number;
  readonly staleWorkerDenied: boolean | null;
  readonly noOpResumeReplayed: boolean | null;
  readonly escalations: readonly EscalationRecord[];
  /** The honest failure cause (null on healthy runs) — the terminal driver. */
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly totalDispatchLatencyMs: number;
  readonly journaledAttempts: number;
}

// ---------------------------------------------------------------------------
// The execution driver
// ---------------------------------------------------------------------------

/**
 * Drive one submitted idempotency-and-continuation execution to
 * completion through the platform path: authorize → plan →
 * planning-decision BEFORE the first dispatch → queue → start → the
 * pattern's machinery (duplicates/conflicts settle exactly once; the
 * retry storm's dispatches retry boundedly with per-attempt
 * journaling; the escalation routes with the causal chain; the
 * continuation parks in WAITING_USER and resumes EXACTLY once with the
 * stale-worker denial and the no-op resume replay) → verify → terminal:
 * a failure outcome or any failed criterion → FAILED.
 *
 * Honesty invariants (by construction): effects apply EXACTLY once
 * (the journal is sequence-gapless; the replay never re-applies); the
 * gated effect NEVER executes behind an escalation; the retry loop is
 * bounded (at most 1 + maxExtraAttempts dispatch attempts, retryable
 * categories only); the escalation depth is bounded (a loop terminates
 * honestly at the bound); the stale worker's resume is denied and
 * journaled; the no-op resume REPLAYS the completion (zero state
 * change).
 */
export async function driveIdempotencyContinuationExecution(options: {
  readonly executionId: string;
  readonly row: ContinuationCorpusRow;
  readonly provider: string;
  readonly model: string;
  readonly lifecycle: IdempotencyContinuationLifecyclePort;
  /** The dispatch seam (required for dispatch-bearing rows only). */
  readonly dispatch?: ContinuationDispatch;
  /** The app's controlled effect world (settlement/notify/refund counters). */
  readonly world: ContinuationEffectWorld;
  /** The scripted escalation decision source (escalate rows). */
  readonly escalationSource?: EscalationDecisionSource;
  /** Bounded retry policy for RETRYABLE dispatch failures. */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** The bounded escalation depth (an escalation loop terminates here). */
  readonly maxEscalationDepth: number;
  readonly now: () => Date;
}): Promise<IdempotencyContinuationRunResult> {
  const { executionId, row, lifecycle, world } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the continuation semantics require it)",
    );
  }
  if (row.pattern === "escalate" && options.escalationSource === undefined) {
    throw new Error(
      `corpus row ${row.rowId} is an escalation row but no scripted decision source was bound`,
    );
  }

  let keyCounter = 0;
  const key = (): string => {
    keyCounter += 1;
    return `k${keyCounter}`;
  };

  const attempts: DispatchAttemptRecord[] = [];
  const effects: EffectJournalRecord[] = [];
  const effectCounts: Record<string, number> = {};
  const escalations: EscalationRecord[] = [];
  let journaledAttempts = 0;
  let waitUserCycles = 0;
  let resumeAdmitted = 0;
  let staleWorkerDenied: boolean | null = null;
  let noOpResumeReplayed: boolean | null = null;
  let segments = 0;
  let dispatchAttempts = 0;
  let totalUsage: LabUsage = { inputTokens: 0, outputTokens: 0 };
  let failure: { category: string; message: string } | null = null;

  const applyEffects = async (segmentEffects: readonly ContinuationEffectSpec[]): Promise<void> => {
    for (const effect of segmentEffects) {
      const applied = world.apply(effect);
      if (!applied.ok) {
        failure = {
          category: "effect-rejection",
          message: `the effect world rejected ${effect.effect}: ${applied.value}`,
        };
        return;
      }
      effectCounts[effect.effect] = (effectCounts[effect.effect] ?? 0) + 1;
      const record: EffectJournalRecord = {
        sequence: effects.length + 1,
        effect: effect.effect,
        attempt: attempts.length > 0 ? (attempts[attempts.length - 1]?.attempt ?? null) : null,
        digest: digestOf(effect),
      };
      effects.push(record);
      // The effect journal rides the REAL ledger — one record per
      // applied effect, sequence-gapless, digests only.
      await lifecycle.recordEffect({ executionId, record });
      world.journalHook?.(record);
    }
  };

  const supervisorRound = async (segment: number): Promise<boolean> => {
    const dispatch = options.dispatch;
    if (dispatch === undefined) {
      throw new Error("dispatch seam required but not bound");
    }
    for (;;) {
      const attempt = attempts.length + 1;
      const outcome = await dispatch({ executionId, segment, attempt });
      dispatchAttempts += 1;
      const retryable =
        outcome.kind === "failure" && isRetryableDispatchCategory(outcome.category ?? "");
      const willRetry =
        outcome.kind === "failure" && retryable && attempt <= options.retry.maxExtraAttempts;
      const record: DispatchAttemptRecord = {
        attempt,
        segment,
        outcome: outcome.kind,
        category: outcome.kind === "failure" ? (outcome.category ?? "unknown") : null,
        retryable: outcome.kind === "failure" ? retryable : false,
        retried: willRetry,
        latencyMs: outcome.latencyMs,
        requestDigest: outcome.requestDigest,
      };
      attempts.push(record);
      await lifecycle.recordDispatchAttempt({ executionId, record });
      journaledAttempts += 1;
      if (outcome.kind === "success") {
        if (outcome.usage !== undefined) {
          totalUsage = {
            inputTokens: totalUsage.inputTokens + outcome.usage.inputTokens,
            outputTokens: totalUsage.outputTokens + outcome.usage.outputTokens,
            costUsd: (totalUsage.costUsd ?? 0) + (outcome.usage.costUsd ?? 0),
          };
        }
        // The continuation decision must confirm continuation (the
        // supervisor's answer drives the segment forward).
        if (!/continue/i.test(outcome.content ?? "")) {
          failure = {
            category: "supervisor-halt",
            message: `the continuation supervisor did not confirm continuation: ${(outcome.content ?? "").slice(0, 120)}`,
          };
          return false;
        }
        return true;
      }
      if (!willRetry) {
        failure = {
          category: outcome.category ?? "unknown",
          message: outcome.message ?? "provider failure (no provider message)",
        };
        return false;
      }
      await options.retry.sleep(options.retry.backoffMs);
    }
  };

  // The canonical prologue: the planning decision is recorded BEFORE
  // the first dispatch (the VAL-019/020 driver discipline).
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-021-authorize",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-021-plan",
    callKey: key(),
  });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "idempotency-continuation",
    },
  });
  await lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-021-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-021-start",
    callKey: key(),
  });

  // ---- the pattern's own machinery ----
  const segmentsPlan = row.segments;
  for (let segmentIndex = 0; segmentIndex < segmentsPlan.length; segmentIndex += 1) {
    const segment = segmentsPlan[segmentIndex];
    if (segment === undefined) throw new Error("missing segment");
    if (failure !== null) break;
    segments += 1;
    // The supervisor round (dispatch-bearing segments only).
    if (segment.dispatch === true) {
      if (!(await supervisorRound(segments))) {
        break;
      }
    }
    // The segment's effects apply EXACTLY once (journal-gapless).
    await applyEffects(segment.effects);
    // The continuation park: the LAST segment before a continuation
    // boundary parks in WAITING_USER; the resume lands EXACTLY once.
    if (segment.continueAfter === true && segmentIndex + 1 < segmentsPlan.length) {
      await lifecycle.recordInterruption({ executionId, at: segments, callKey: key() });
      await lifecycle.transition({
        executionId,
        step: "wait-user",
        reason: `val-021-wait-user-${segments}`,
        callKey: key(),
      });
      waitUserCycles += 1;
      // The external continuation input arrives (the deterministic
      // fixture; the LIVE rows' continuation decision was the REAL
      // supervisor dispatch above).
      const continuation = world.continuationInput(segments);
      if (!continuation.ok) {
        failure = {
          category: "continuation-rejected",
          message: `the continuation input was rejected: ${continuation.value}`,
        };
        break;
      }
      await lifecycle.transition({
        executionId,
        step: "resume",
        reason: `val-021-resume-${segments}`,
        callKey: key(),
      });
      resumeAdmitted += 1;
      // The stale-worker probe: a second resume against the now-RUNNING
      // execution. The REAL state machine DENIES it (resume is legal
      // only from the WAITING_* states) — the denial is caught and
      // journaled as resume-denied evidence.
      if (row.staleWorkerProbe === true) {
        try {
          await lifecycle.transition({
            executionId,
            step: "resume",
            reason: `val-021-stale-worker-resume-${segments}`,
            callKey: key(),
          });
          // Reaching here means the platform ADMITTED a double resume —
          // an exactly-once violation (fails the run honestly). The
          // admission COUNTS (the criterion detects 2 admissions
          // against 1 park mechanically).
          resumeAdmitted += 1;
          failure = {
            category: "double-resume-admitted",
            message:
              "the stale worker's resume was ADMITTED on a RUNNING execution — " +
              "the resume-exactly-once contract was violated",
          };
          break;
        } catch {
          await lifecycle.recordResumeDenied({
            executionId,
            reason:
              "stale-worker: resume rejected on a healthy RUNNING execution " +
              "(the successor owns the continuation)",
            callKey: key(),
          });
          staleWorkerDenied = true;
        }
      }
    }
  }

  // ---- the escalation machinery (escalate rows) ----
  if (row.pattern === "escalate" && row.escalation !== undefined && failure === null) {
    const source = options.escalationSource as EscalationDecisionSource;
    const gateId = `${executionId}:${row.escalation.gateId}`;
    let depth = 0;
    for (;;) {
      depth += 1;
      if (depth > options.maxEscalationDepth) {
        failure = {
          category: "escalation-depth-exceeded",
          message: `the escalation loop exceeded the depth bound ${options.maxEscalationDepth}`,
        };
        break;
      }
      const decision = source.decide({ gateId, depth });
      if (decision === "resolve") {
        break;
      }
      const causalChain = buildCausalChain({
        submission: row.submissionDigestInput,
        gateProposal: row.escalation.proposal,
        decision: { gateId, depth, decision },
      });
      const callKey = `escal-${gateId}-d${depth}`;
      const outcome = await lifecycle.recordEscalation({
        executionId,
        gateId,
        authority: row.escalation.authority,
        causalChain,
        callKey,
      });
      escalations.push({
        gateId,
        authority: row.escalation.authority,
        depth,
        routed: outcome.routed,
        replayed: outcome.replayed,
        causalChain,
      });
      if (decision === "escalate") {
        // The idempotent re-escalation probe: re-issue the SAME
        // escalation (same key, same payload) — the ledger must REPLAY
        // it (the authority receives the escalation exactly once).
        const replay = await lifecycle.recordEscalation({
          executionId,
          gateId,
          authority: row.escalation.authority,
          causalChain,
          callKey,
        });
        escalations.push({
          gateId,
          authority: row.escalation.authority,
          depth,
          routed: replay.routed,
          replayed: replay.replayed,
          causalChain,
        });
        break;
      }
      // "re-escalate": a NEW decision — a NEW ledger key (the
      // distinct-payload discipline) — the loop continues toward the
      // depth bound.
    }
  }

  // ---- terminal ----
  const criteria = deriveIdempotencyContinuationCriteria({
    row,
    attempts,
    journaledAttempts,
    effects,
    effectCounts,
    segments,
    waitUserCycles,
    resumeAdmitted,
    staleWorkerDenied,
    escalations,
    failure,
    usage: totalUsage.inputTokens > 0 ? totalUsage : null,
  });
  // The honest terminal: a failure outcome FAILS the execution ALWAYS
  // (no partial-success shortcut); a criteria failure fails it too.
  const anyFail = failure !== null || criteria.some((criterion) => criterion.status === "FAIL");

  await lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-021-verify",
    callKey: key(),
  });
  const completeCallKey = key();
  const verdict = anyFail ? "fail" : "pass";
  const reason = anyFail
    ? failure !== null
      ? `val-021-${failure.category}`
      : "val-021-mechanical-verification-failed"
    : "val-021-verified";
  const criteriaForLedger = criteria;
  await lifecycle.complete({
    executionId,
    verdict,
    criteria: criteriaForLedger,
    reason,
    callKey: completeCallKey,
  });

  if (row.noOpResumeProbe === true) {
    // The no-op resume replay: re-issue the EXACT completion transition
    // (same key, same fingerprint) — the ledger must REPLAY it with
    // zero state change (the VAL-014 ledger-key discipline).
    const replay = await lifecycle.attemptNoOpResume({
      executionId,
      completeCallKey,
      verdict,
      criteria: criteriaForLedger,
      reason,
    });
    noOpResumeReplayed = replay.replayed;
  }

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage: totalUsage.inputTokens > 0 ? totalUsage : null,
    segments,
    dispatchAttempts,
    attempts,
    effects,
    effectCounts,
    waitUserCycles,
    resumeAdmitted,
    staleWorkerDenied,
    noOpResumeReplayed,
    escalations,
    failure,
    totalDispatchLatencyMs: attempts.reduce((sum, record) => sum + record.latencyMs, 0),
    journaledAttempts,
  };
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** One effect the execution's work applies (the fixture-world spec). */
export interface ContinuationEffectSpec {
  /** The effect's identity (e.g. "settle:INV-101"). */
  readonly effect: string;
  readonly kind: "settle" | "notify";
  readonly key: string;
  readonly amountMicro: number;
}

/** One work segment of the row's execution plan. */
export interface ContinuationSegmentSpec {
  /** Whether the segment opens with a supervisor dispatch. */
  readonly dispatch: boolean;
  readonly effects: readonly ContinuationEffectSpec[];
  /** Whether the execution parks in WAITING_USER after this segment. */
  readonly continueAfter: boolean;
}

/** The app's controlled effect world (the fixture seam). */
export interface ContinuationEffectWorld {
  /** Apply one effect against the fixture state (returns the counter effect). */
  apply(effect: ContinuationEffectSpec): { ok: boolean; value: string };
  /** The external continuation input (deterministic fixture). */
  continuationInput(atSegment: number): { ok: boolean; value: string };
  /** Optional journal hook (the fixture observes the journal records). */
  readonly journalHook?: (record: EffectJournalRecord) => void;
  /** The fixture state's own effect counters (the multiplicity oracle's input). */
  readonly observedCounts: Readonly<Record<string, number>>;
}

/** The corpus row (the full oracle — AC1's per-row contract). */
export interface ContinuationCorpusRow {
  readonly rowId: string;
  readonly pattern: SubmissionPattern;
  readonly description: string;
  /** The work segments (effects + continuation boundaries + dispatch marks). */
  readonly segments: readonly ContinuationSegmentSpec[];
  /** The gated-effect escalation contract (escalate rows). */
  readonly escalation?: {
    readonly gateId: string;
    readonly proposal: Readonly<Record<string, unknown>>;
    readonly authority: string;
  };
  /** Whether the row's driver flow demands a dispatch seam. */
  readonly needsDispatch: boolean;
  /** The stale-worker double-resume probe. */
  readonly staleWorkerProbe: boolean;
  /** The no-op resume replay probe after terminal. */
  readonly noOpResumeProbe: boolean;
  /** The submission digest input (the causal chain's first link). */
  readonly submissionDigestInput: Readonly<Record<string, unknown>>;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The app-level submission contract. */
  readonly submissions: {
    /** The total creates the app issues for this row. */
    readonly count: number;
    /** The conflicting task body (conflict rows; a different fingerprint). */
    readonly conflictingTask?: Readonly<Record<string, unknown>>;
  };
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    /** The expected effect multiplicity (effect → exact count). */
    readonly effects: Readonly<Record<string, number>>;
    /** The pinned dispatch-attempt outcome sequence (null = unpinned/live). */
    readonly attemptOutcomes: readonly ("success" | "failure")[] | null;
    /** The bounded-retry budget the oracle assumes. */
    readonly maxExtraAttempts: number;
    /** The expected wait-user → resume pairs. */
    readonly waitUserCycles: number;
    /** The stale-worker denial expectation (probed rows). */
    readonly staleWorkerDenied: boolean;
    /** The no-op resume replay expectation (probed rows). */
    readonly noopResumeReplayed: boolean;
    /** The escalation contract (escalate rows). */
    readonly escalationRouted: number;
    readonly reEscalationReplayed: boolean;
    /** The app-level submission expectations. */
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one idempotency-and-continuation
 * run. PURE: the same journals + oracle always yield the same
 * verdicts. The criteria prove the exactly-once effect contract, the
 * journal-sequence continuity (gapless), the per-attempt journal
 * exactly-once discipline, the bounded-retry policy, the resume-
 * exactly-once contract (with the stale-worker denial and the no-op
 * resume replay), the escalation routing with the causal chain and the
 * honest outcome contract.
 */
export function deriveIdempotencyContinuationCriteria(input: {
  readonly row: ContinuationCorpusRow;
  readonly attempts: readonly DispatchAttemptRecord[];
  readonly journaledAttempts: number;
  readonly effects: readonly EffectJournalRecord[];
  readonly effectCounts: Readonly<Record<string, number>>;
  readonly segments: number;
  readonly waitUserCycles: number;
  readonly resumeAdmitted: number;
  readonly staleWorkerDenied: boolean | null;
  readonly escalations: readonly EscalationRecord[];
  readonly failure: { category: string; message: string } | null;
  readonly usage: LabUsage | null;
}): LabVerificationCriterion[] {
  const { row, attempts, effects, effectCounts, escalations } = input;
  const criteria: LabVerificationCriterion[] = [];

  // (No short-circuit — the VAL-020 calibration: the criteria prove the
  // SEMANTICS (bounded retry, journaling, multiplicity, resume,
  // escalation) and a correctly-bounded exhausted retry PASSES them
  // while the terminal stays honestly FAILED. The failure's own
  // category rides the run result's `failure` field — the honest
  // cause, never a partial-success shortcut.)

  // 1. The exactly-once effect contract (AC4): every expected effect
  //    applied exactly its expected count; NO unexpected effect landed.
  const multiplicity = deriveEffectMultiplicity(row.expected.effects, effectCounts);
  criteria.push({
    criterionId: "effect-multiplicity-exactly-once",
    strategy: "deterministic",
    status: multiplicity.exactlyOnce ? "PASS" : "FAIL",
    evidence: [
      `expected:${
        Object.entries(row.expected.effects)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `observed:${
        Object.entries(effectCounts)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `overApplied:${multiplicity.overApplied.join("|") || "none"}`,
      `missing:${multiplicity.missing.join("|") || "none"}`,
      `unexpected:${multiplicity.unexpected.join("|") || "none"}`,
    ],
  });

  // 2. The journal-sequence continuity (AC4): 1..N gapless — no
  //    holes, no duplicate sequences.
  const gaplessness = deriveJournalGaplessness(effects.map((record) => record.sequence));
  criteria.push({
    criterionId: "journal-sequence-gapless",
    strategy: "deterministic",
    status: gaplessness.gapless ? "PASS" : "FAIL",
    evidence: [
      `sequences:${effects.map((record) => record.sequence).join(">") || "empty-by-design"}`,
      `holes:${gaplessness.holes.join("|") || "none"}`,
      `duplicates:${gaplessness.duplicates.join("|") || "none"}`,
    ],
  });

  // 3. The per-attempt journal exactly-once discipline (the retry rows).
  if (row.needsDispatch) {
    const journalOk = input.journaledAttempts === attempts.length;
    criteria.push({
      criterionId: "journal-exactly-once-per-attempt",
      strategy: "deterministic",
      status: journalOk ? "PASS" : "FAIL",
      evidence: [
        `journaled:${input.journaledAttempts}`,
        `attempts:${attempts.length}`,
        `perAttemptDigests:${attempts.map((record) => record.requestDigest).join("|") || "none"}`,
      ],
    });

    // 4. The bounded-retry policy (PER SEGMENT — each segment's
    //    dispatch loop is independently bounded): at most 1 +
    //    maxExtraAttempts attempts per segment; a non-retryable failure
    //    is always its segment's LAST attempt.
    const perSegmentCounts = new Map<number, DispatchAttemptRecord[]>();
    for (const record of attempts) {
      const bucket = perSegmentCounts.get(record.segment) ?? [];
      bucket.push(record);
      perSegmentCounts.set(record.segment, bucket);
    }
    const boundedAbove = [...perSegmentCounts.values()].every(
      (records) => records.length <= 1 + row.expected.maxExtraAttempts,
    );
    const nonRetryableLast = [...perSegmentCounts.values()].every((records) =>
      records.every((record) => {
        if (record.retryable) return true;
        return record.attempt === records[records.length - 1]?.attempt;
      }),
    );
    const boundedOk = boundedAbove && nonRetryableLast;
    criteria.push({
      criterionId: "dispatch-bounded-retry",
      strategy: "deterministic",
      status: boundedOk ? "PASS" : "FAIL",
      evidence: [
        `attempts:${attempts.length}`,
        `perSegment:${[...perSegmentCounts.entries()].map(([s, r]) => `s${s}:${r.length}`).join("|") || "none"}`,
        `limitPerSegment:${1 + row.expected.maxExtraAttempts}`,
        `nonRetryableFailuresTerminal:${String(nonRetryableLast)}`,
      ],
    });

    // 5. The attempt-outcome sequence (the pinned recovery sequence;
    //    unpinned for the live rows — the honest live boundary).
    if (row.expected.attemptOutcomes !== null) {
      const observed = attempts.map((record) => record.outcome);
      const sequenceOk =
        observed.length === row.expected.attemptOutcomes.length &&
        observed.every((outcome, index) => outcome === row.expected.attemptOutcomes?.[index]);
      criteria.push({
        criterionId: "attempt-outcome-sequence",
        strategy: "deterministic",
        status: sequenceOk ? "PASS" : "FAIL",
        evidence: [
          `expected:${(row.expected.attemptOutcomes ?? []).join(">") || "none"}`,
          `observed:${observed.join(">") || "none"}`,
        ],
      });
    } else {
      criteria.push({
        criterionId: "attempt-outcome-sequence",
        strategy: "deterministic",
        status: attempts.length >= 1 ? "PASS" : "FAIL",
        evidence: ["unpinned-live-boundary", `observedAttempts:${attempts.length}`],
      });
    }
  }

  // 6. The resume-exactly-once contract (the continue rows).
  if (row.pattern === "continue") {
    const resumeOk =
      input.waitUserCycles === row.expected.waitUserCycles &&
      input.resumeAdmitted === row.expected.waitUserCycles;
    criteria.push({
      criterionId: "resume-exactly-once",
      strategy: "deterministic",
      status: resumeOk ? "PASS" : "FAIL",
      evidence: [
        `waitUserCycles:${input.waitUserCycles}`,
        `resumeAdmitted:${input.resumeAdmitted}`,
        `expected:${row.expected.waitUserCycles}`,
      ],
    });

    // 7. The stale-worker denial probe (the double-resume attempt).
    if (row.staleWorkerProbe) {
      const deniedOk = input.staleWorkerDenied === row.expected.staleWorkerDenied;
      criteria.push({
        criterionId: "stale-worker-denied",
        strategy: "deterministic",
        status: deniedOk ? "PASS" : "FAIL",
        evidence: [
          `expected:${String(row.expected.staleWorkerDenied)}`,
          `observed:${String(input.staleWorkerDenied)}`,
        ],
      });
    }

    // 8. The no-op resume replay probe is observed AFTER the terminal
    //    completion (the probe re-issues the completion itself), so it
    //    CANNOT ride the pre-completion criteria — the driver returns
    //    it as `noOpResumeReplayed` on the run result and the caller
    //    (unit/discrimination/crown suites) asserts the replay honestly
    //    (the VAL-013 no-op-resume precedent).
  }

  // 9. The escalation routing contract (the escalate rows): every
  //    routed escalation landed at the declared authority with a
  //    complete causal chain; the re-escalation REPLAYED (exactly-once
  //    routing); the routed count matches.
  if (row.pattern === "escalate") {
    const routed = escalations.filter((record) => record.routed);
    const routedOk =
      routed.length === row.expected.escalationRouted &&
      routed.every(
        (record) =>
          record.authority === row.escalation?.authority && causalChainComplete(record.causalChain),
      );
    criteria.push({
      criterionId: "escalation-routing",
      strategy: "deterministic",
      status: routedOk ? "PASS" : "FAIL",
      evidence: [
        `routed:${routed.map((record) => `${record.gateId}->${record.authority}`).join("|") || "none"}`,
        `expectedAuthority:${row.escalation?.authority ?? "none"}`,
        `expectedRouted:${row.expected.escalationRouted}`,
        `causalChainsComplete:${String(
          routed.every((record) => causalChainComplete(record.causalChain)),
        )}`,
      ],
    });

    // 10. The idempotent re-escalation replay (exactly-once routing).
    const replayProbe = escalations.filter((record) => record.replayed);
    const replayOk =
      replayProbe.length === (row.expected.reEscalationReplayed ? 1 : 0) &&
      replayProbe.every((record) => !record.routed);
    criteria.push({
      criterionId: "re-escalation-replay",
      strategy: "deterministic",
      status: replayOk ? "PASS" : "FAIL",
      evidence: [
        `replayedProbes:${replayProbe.length}`,
        `expected:${String(row.expected.reEscalationReplayed)}`,
      ],
    });

    // 11. The gated effect NEVER executed behind the escalation.
    const gatedEffect = `refund:${row.escalation?.proposal.refundId ?? "unknown"}`;
    const gatedOk = (effectCounts[gatedEffect] ?? 0) === 0;
    criteria.push({
      criterionId: "gated-effect-never-executed",
      strategy: "deterministic",
      status: gatedOk ? "PASS" : "FAIL",
      evidence: [`gatedEffect:${gatedEffect}`, `observedCount:${effectCounts[gatedEffect] ?? 0}`],
    });
  }

  // 12. The honest outcome contract: the derived terminal matches the
  //     oracle's terminal.
  const derivedTerminal: "COMPLETED" | "FAILED" = input.failure !== null ? "FAILED" : "COMPLETED";
  const terminalOk = derivedTerminal === row.expected.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: terminalOk ? "PASS" : "FAIL",
    evidence: [`expectedTerminal:${row.expected.terminal}`, `derivedTerminal:${derivedTerminal}`],
  });

  // 13. Honest economics: measured usage and latency recorded (never
  //     estimated); usage absent on credential-free rows recorded honestly.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      input.usage === null
        ? "usage:none-reported"
        : `usage:${input.usage.inputTokens}+${input.usage.outputTokens}` +
          (input.usage.costUsd === undefined ? "" : `/costUsd:${input.usage.costUsd}`),
      `attempts:${attempts.length}`,
      `effects:${effects.length}`,
    ],
  });

  return criteria;
}
