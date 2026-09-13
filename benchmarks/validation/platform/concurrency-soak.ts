/**
 * The platform-side concurrency/soak driver (VAL-025).
 *
 * The reliability slice for concurrency semantics: drives
 * same-key-race / distinct-key-fanout / over-ceiling-burst / soak-round
 * submission patterns through the REAL platform path, mechanically
 * proving the concurrency contracts the idempotency ledger, the
 * executions state machine and the journal are responsible for:
 *
 *   * the load-pattern vocabulary as PURE derivations —
 *     `deriveRaceArbitration` (the racing case's collective verdict:
 *     exactly ONE created receipt, every other racing submission either
 *     replays the winner's committed outcome with identity preserved
 *     or receives a typed rejection — the same-key conflict's
 *     IDEMPOTENCY_KEY_REUSED or a typed already-in-flight rejection —
 *     NEVER two executions), `deriveFanoutParallelism` (the
 *     no-head-of-line-blocking contract over the observed execution
 *     windows: the declared minimum concurrent overlap is met) and
 *     `deriveJournalInterleaving` (the alternative proof: one
 *     execution's journal records straddle another's — impossible
 *     under serialization), `deriveCeilingShaping` (the
 *     bounded-concurrency load-shaping contract: exactly the declared
 *     ceiling admitted, the rest typed admission denials, ZERO effects
 *     on the denied) and `deriveCeilingAdmission` (the admission
 *     gate's own decision table — the prune-then-decide discipline),
 *     `deriveSoakInvariants` (the per-round durable invariants:
 *     journal exactly-once-per-attempt, no ledger drift, no row-count
 *     leak, replayed keys never arbitrating a second transition),
 *     `deriveJournalGaplessness` and `deriveEffectMultiplicity` (the
 *     VAL-021 disciplines, re-derived locally so the slice is
 *     self-contained);
 *   * the submission-attempt journal: every seam-driven submission
 *     attempt (the racing probe pairs and the soak replay probes) is
 *     journaled EXACTLY once with per-attempt-distinct idempotency
 *     keys (digests in the journal, never payload bytes — the VAL-018
 *     lesson);
 *   * the service-level racing probe: a FRESH key's concurrent
 *     submission pair driven through the submission seam (the REAL
 *     idempotency ledger's transactional arbitration at the crown) —
 *     the ledger admits one, the loser replays the winner's committed
 *     outcome; a leaky seam that admits BOTH is mechanically caught;
 *     the app-side racing pair's convergence is verified by the LEDGER
 *     itself (the no-phantom row-count delta — a double admission
 *     leaves an extra durable row and FAILS);
 *   * the soak machinery: repeated submission rounds over the declared
 *     sustained window (the spacing is declared, the elapsed window
 *     measured — never fabricated), the durable invariants re-verified
 *     after EVERY round, and the per-round replay probe re-issuing the
 *     round's probe key (the ledger must REPLAY it — the key never
 *     arbitrates a second transition);
 *   * the execution driver mirroring the VAL-019/020/021 drivers
 *     (authorize — the admission seam, where the over-ceiling burst's
 *     typed POLICY_DENIED denial is caught and recorded with ZERO
 *     further transitions — → plan → planning-decision BEFORE the first
 *     dispatch → queue → start → the lane's effects → verify →
 *     terminal: a failure outcome or any failed criterion → FAILED —
 *     never a partial-success shortcut).
 *
 * Honesty invariants:
 *   * a racing submission NEVER yields a second durable execution
 *     (exactly-once-per-key arbitration is derived mechanically — a
 *     double admission FAILS the run);
 *   * an over-ceiling submission is NEVER silently queued past the
 *     gate: the typed admission denial is recorded, the denied
 *     execution stays CREATED with the durable policy-denied envelope
 *     and ZERO effects (a bypassed gate FAILS the shaping criterion);
 *   * the soak window is declared and measured, never fabricated; the
 *     per-round invariants are re-verified after every round (a drift
 *     or leak FAILS the round honestly);
 *   * no phantom executions (an extra durable row without a
 *     submission key) and no orphan ledger transitions (an event
 *     referencing an unknown execution) — both mechanically detected;
 *   * usage, cost and latency are measured, never estimated; evidence
 *     carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL executions service (the idempotency ledger, the
 * state machine, the step-event journal) and — for the live rows — the
 * REAL model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The load-pattern vocabulary (the corpus's declared patterns)
// ---------------------------------------------------------------------------

/** The four submission patterns the VAL-025 corpus exercises. */
export const LOAD_PATTERNS = [
  // concurrent submissions under ONE idempotency key → exactly one
  // durable execution (the ledger's transactional arbitration)
  "same-key-race",
  // independent concurrent submissions → no head-of-line blocking
  // (observed overlap or interleaved journal ordering)
  "distinct-key-fanout",
  // bounded-concurrency load shaping: submissions beyond the declared
  // ceiling receive the typed admission rejection with zero effects
  "over-ceiling-burst",
  // repeated submission rounds over a sustained window with the
  // durable invariants re-verified after every round
  "soak-rounds",
] as const;

export type LoadPattern = (typeof LOAD_PATTERNS)[number];

export function isLoadPattern(value: string): value is LoadPattern {
  return (LOAD_PATTERNS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The REAL platform tokens this slice pins (validation-local constants
// pinning the platform's own vocabulary — never reimplementing it)
// ---------------------------------------------------------------------------

/**
 * The platform's typed admission-rejection code (the canonical error
 * taxonomy's POLICY_DENIED): the token the over-ceiling burst's denied
 * submissions surface at the authorize admission seam — the platform's
 * REAL vocabulary for the throttled/queue-full admission rejection.
 */
export const ADMISSION_REJECTION_CODE = "POLICY_DENIED";

/**
 * The platform's durable admission-denial event type (the executions
 * event vocabulary's own token): the append-only envelope a denied
 * authorize transition journals (journal-then-fail) while the execution
 * STAYS CREATED — dispatch remains impossible, zero effects.
 */
export const ADMISSION_DENIED_EVENT_TYPE = "execution.policy-denied";

/**
 * The platform's typed key-reuse rejection code (the racing conflict's
 * token — the same code VAL-021 pinned for the sequential case).
 */
export const IDEMPOTENCY_KEY_REUSED_CODE = "IDEMPOTENCY_KEY_REUSED";

/**
 * The typed already-in-flight racing rejection the spec's racing
 * vocabulary admits (an alternative platform design where the loser is
 * typed-rejected instead of waiting for the winner's commit). The
 * arbitration derivation accepts it as a legal racing outcome; this
 * platform's REAL design always converges through the replay.
 */
export const ALREADY_IN_FLIGHT_CODE = "EXECUTION_ALREADY_IN_FLIGHT";

/**
 * Classify one caught admission error (the authorize transition's own
 * typed rejection). PURE: the platform's POLICY_DENIED code is the
 * typed admission denial; anything else is false (an honest unexpected
 * rejection — never a fabricated match).
 */
export function isAdmissionRejection(error: {
  readonly code?: string;
  readonly message?: string;
}): boolean {
  return error.code === ADMISSION_REJECTION_CODE;
}

// ---------------------------------------------------------------------------
// The submission observation + the race arbitration (PURE derivations)
// ---------------------------------------------------------------------------

/** One submitted create's observed receipt (the app/seam-side observation). */
export interface SubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  /** The receipt's status at observation (when the create succeeded). */
  readonly status: string | null;
  /** The typed rejection (when the create was rejected). */
  readonly rejection: { readonly code: string; readonly status: number } | null;
  /** Wall-clock submission start (the overlap derivation's input). */
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/** The racing arbitration verdict for one same-key submission group. */
export interface RaceArbitrationVerdict {
  /** Exactly one created receipt and never two distinct identities. */
  readonly exactlyOneExecution: boolean;
  readonly createdCount: number;
  readonly replayedCount: number;
  readonly rejectedCount: number;
  readonly unexpectedCount: number;
  /** Every replay preserved the winner's identity AND surfaced the flag. */
  readonly identityPreserved: boolean;
  /** Every rejection carried a typed racing code (key-reuse or in-flight). */
  readonly typedRejections: boolean;
  readonly distinctExecutionIds: readonly string[];
}

/**
 * Derive the racing arbitration verdict (PURE): under the platform's
 * own contract a same-key racing group resolves to EXACTLY ONE durable
 * execution — one created receipt; every other submission either
 * replays the winner's committed outcome (identity preserved, the
 * replayed flag surfaced) or receives a typed rejection
 * (IDEMPOTENCY_KEY_REUSED for the conflicting fingerprint; a typed
 * already-in-flight rejection for the waiting design). A group that
 * surfaces two distinct execution identities is a DOUBLE ARBITRATION —
 * mechanically failed here, never tolerated.
 */
export function deriveRaceArbitration(
  observations: readonly SubmissionObservation[],
): RaceArbitrationVerdict {
  const created = observations.filter(
    (observation) => !observation.replayed && observation.rejection === null,
  );
  const replayed = observations.filter(
    (observation) => observation.replayed && observation.rejection === null,
  );
  const rejected = observations.filter((observation) => observation.rejection !== null);
  const winnerIds = new Set(created.map((observation) => observation.executionId));
  const replayIds = new Set(replayed.map((observation) => observation.executionId));
  const distinct = [...new Set(observations.map((o) => o.executionId).filter((id) => id !== ""))];
  const identityPreserved =
    winnerIds.size <= 1 &&
    (replayed.length === 0 ||
      ([...replayIds].every((id) => winnerIds.has(id)) &&
        replayed.every((observation) => observation.executionId !== "" && observation.replayed)));
  const typedRejections = rejected.every(
    (observation) =>
      observation.rejection !== null &&
      (observation.rejection.code === IDEMPOTENCY_KEY_REUSED_CODE ||
        observation.rejection.code === ALREADY_IN_FLIGHT_CODE),
  );
  return {
    exactlyOneExecution:
      created.length === 1 &&
      winnerIds.size === 1 &&
      replayed.length + rejected.length === observations.length - 1,
    createdCount: created.length,
    replayedCount: replayed.length,
    rejectedCount: rejected.length,
    unexpectedCount: observations.length - created.length - replayed.length - rejected.length,
    identityPreserved,
    typedRejections,
    distinctExecutionIds: distinct,
  };
}

// ---------------------------------------------------------------------------
// The fan-out parallelism + journal interleaving (PURE derivations)
// ---------------------------------------------------------------------------

/** One execution's observed processing window (the overlap derivation's input). */
export interface ExecutionWindow {
  readonly executionId: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** The fan-out parallelism verdict. */
export interface FanoutParallelismVerdict {
  /** The maximum count of executions whose windows mutually overlapped. */
  readonly maxConcurrent: number;
  /** The declared minimum was met (no head-of-line blocking). */
  readonly overlapped: boolean;
}

/**
 * Derive the fan-out parallelism (PURE): independent submissions
 * proceed concurrently without head-of-line blocking — the observed
 * windows must show at least the declared minimum of MUTUALLY
 * overlapping executions (a boundary-touching handoff — one window
 * ending exactly where another starts — is SEQUENTIAL, not
 * concurrent). Serialized (head-of-line-blocked) driving produces
 * disjoint windows and FAILS here.
 */
export function deriveFanoutParallelism(
  windows: readonly ExecutionWindow[],
  options: { readonly minConcurrent: number },
): FanoutParallelismVerdict {
  let maxConcurrent = 0;
  for (const probe of windows) {
    const overlapping = windows.filter(
      (other) => other.startedAt < probe.endedAt && probe.startedAt < other.endedAt,
    ).length;
    if (overlapping > maxConcurrent) {
      maxConcurrent = overlapping;
    }
  }
  return {
    maxConcurrent,
    overlapped: windows.length === 0 ? false : maxConcurrent >= options.minConcurrent,
  };
}

/** One journaled record's execution reference (the interleaving input). */
export interface JournalTimelineEntry {
  readonly executionId: string;
  readonly ordinal: number;
}

/** The journal-interleaving verdict (the alternative no-blocking proof). */
export interface JournalInterleavingVerdict {
  /**
   * At least one execution's records STRADDLE another's (an A..B..A
   * triple in the journal timeline) — impossible under serialization.
   */
  readonly interleaved: boolean;
  readonly straddles: number;
}

/**
 * Derive the journal interleaving (PURE): a shared journal written by
 * concurrently-driven executions contains at least one straddle — one
 * execution's records with another's BETWEEN them. A strictly
 * serialized driver can never produce a straddle (each execution's
 * records are contiguous).
 */
export function deriveJournalInterleaving(
  timeline: readonly JournalTimelineEntry[],
): JournalInterleavingVerdict {
  let straddles = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const start = timeline[index];
    if (start === undefined) {
      continue;
    }
    for (let ahead = index + 2; ahead < timeline.length; ahead += 1) {
      const end = timeline[ahead];
      if (
        end !== undefined &&
        start.executionId === end.executionId &&
        timeline.slice(index + 1, ahead).some((middle) => middle.executionId !== start.executionId)
      ) {
        straddles += 1;
        break;
      }
    }
  }
  return { interleaved: straddles > 0, straddles };
}

// ---------------------------------------------------------------------------
// The ceiling shaping + the admission gate's decision table (PURE)
// ---------------------------------------------------------------------------

/** One admission attempt's observed outcome (the shaping input). */
export interface AdmissionAttempt {
  readonly executionId: string;
  readonly admitted: boolean;
  /** The typed rejection code (denials only; null on admissions). */
  readonly rejection: string | null;
}

/** The ceiling-shaping verdict. */
export interface CeilingShapingVerdict {
  /** The expected admissions/denials observed exactly; every denial typed. */
  readonly shapedCorrectly: boolean;
  readonly admitted: number;
  readonly denied: number;
  /** Every denial carried the typed admission rejection code. */
  readonly typedDenials: boolean;
}

/**
 * Derive the ceiling shaping (PURE): a burst beyond the declared
 * ceiling resolves to EXACTLY the expected admissions and typed
 * admission denials — never more admitted (a bypassed gate), never an
 * untyped denial. The expected counts default to the single-wave
 * shape (exactly the ceiling admitted, the rest denied); the
 * multi-wave rows declare their accumulated shaping contract (the
 * slot-release shape admits beyond the single-wave ceiling on freed
 * slots).
 */
export function deriveCeilingShaping(input: {
  readonly ceiling: number;
  readonly attempts: readonly AdmissionAttempt[];
  readonly expectedAdmitted?: number;
  readonly expectedDenied?: number;
}): CeilingShapingVerdict {
  const admitted = input.attempts.filter((attempt) => attempt.admitted).length;
  const denied = input.attempts.filter((attempt) => !attempt.admitted).length;
  const typedDenials = input.attempts
    .filter((attempt) => !attempt.admitted)
    .every((attempt) => attempt.rejection === ADMISSION_REJECTION_CODE);
  const expectedAdmitted = input.expectedAdmitted ?? Math.min(input.ceiling, input.attempts.length);
  const expectedDenied = input.expectedDenied ?? Math.max(0, input.attempts.length - input.ceiling);
  return {
    shapedCorrectly: admitted === expectedAdmitted && denied === expectedDenied && typedDenials,
    admitted,
    denied,
    typedDenials,
  };
}

/**
 * The admission gate's own decision table (PURE): a submission is
 * admissible only while the count of admitted-and-not-yet-terminal
 * executions is below the declared ceiling. The prune-then-decide
 * discipline: terminal executions release their slots BEFORE the
 * decision (the gate never over-denies a freed ceiling).
 */
export function deriveCeilingAdmission(input: {
  readonly admittedInFlight: number;
  readonly ceiling: number;
}): { readonly allowed: boolean; readonly reason: string | null } {
  if (input.admittedInFlight >= input.ceiling) {
    return {
      allowed: false,
      reason: `concurrency ceiling ${input.ceiling} reached: ${input.admittedInFlight} admitted executions in flight (load shaping)`,
    };
  }
  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Journal-sequence continuity + effect multiplicity (the VAL-021
// disciplines, re-derived locally — the slice stays self-contained)
// ---------------------------------------------------------------------------

/** The gapless-sequence verdict for one journal's observed sequences. */
export interface JournalGaplessnessVerdict {
  readonly gapless: boolean;
  readonly holes: readonly number[];
  readonly duplicates: readonly number[];
}

/**
 * Derive the journal-sequence continuity (PURE): a well-formed journal
 * is EXACTLY 1..N — no holes, no duplicate sequences (the AC4
 * gapless contract; a dropped or double-written record FAILS here).
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
  return { gapless: holes.length === 0 && duplicates.length === 0, holes, duplicates };
}

/** The exactly-once effect verdict against the world's own counters. */
export interface EffectMultiplicityVerdict {
  readonly exactlyOnce: boolean;
  readonly overApplied: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

/**
 * Derive the effect multiplicity (PURE): every expected effect's
 * observed count must be EXACTLY the expected count and NO unexpected
 * effect may have landed (a denied lane that applied anyway, a replay
 * that re-applied — all detected against the world's counters).
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
// The soak invariants (PURE derivation)
// ---------------------------------------------------------------------------

/** The per-round soak facts the driver observes after each round settles. */
export interface SoakRoundFacts {
  readonly round: number;
  /**
   * The durable executions the round's own driver traffic created (the
   * per-round racing probe pair's ONE execution; the app's lanes landed
   * before the round window opened and are covered by the row totals).
   */
  readonly executionsCreated: number;
  /** The distinct idempotency keys the round's driver traffic added. */
  readonly idempotencyRecords: number;
  /** The submission attempts the round's driver traffic drove. */
  readonly attempts: number;
  /** The submission attempts the driver journaled (exactly once each). */
  readonly journaledAttempts: number;
  /** The round's racing probe converged to exactly one execution. */
  readonly raceConverged: boolean;
  /** The replay probe's verdict (the round's probe key re-issued). */
  readonly replayProbe: {
    readonly replayed: boolean;
    readonly newExecutions: number;
    readonly newIdempotencyRecords: number;
  };
}

/** The soak invariants verdict (every round, re-verified). */
export interface SoakInvariantsVerdict {
  readonly journalExactlyOncePerAttempt: boolean;
  readonly noLedgerDrift: boolean;
  readonly noRowCountLeak: boolean;
  readonly raceConvergence: boolean;
  readonly keysNeverArbitratingSecondTransition: boolean;
  readonly offendingRounds: readonly number[];
}

/**
 * Derive the soak invariants (PURE): after EVERY round the durable
 * state must satisfy — journal exactly-once-per-attempt (the round's
 * journaled attempts equal its driven attempts), no ledger drift (the
 * round's idempotency records equal the expected per-round keys), no
 * row-count leak (the round's executions equal the expected per-round
 * rows), the round's racing probe converged, and the replay probes
 * never arbitrated a second transition (replayed with zero new rows).
 * A single offending round FAILS the soak.
 */
export function deriveSoakInvariants(input: {
  readonly rounds: readonly SoakRoundFacts[];
  readonly expectedExecutionsPerRound: number;
  readonly expectedKeysPerRound: number;
}): SoakInvariantsVerdict {
  const offending: number[] = [];
  let journalOk = true;
  let ledgerOk = true;
  let leakOk = true;
  let raceOk = true;
  let replayOk = true;
  for (const round of input.rounds) {
    if (round.journaledAttempts !== round.attempts) {
      journalOk = false;
      offending.push(round.round);
    }
    if (round.idempotencyRecords !== input.expectedKeysPerRound) {
      ledgerOk = false;
      offending.push(round.round);
    }
    if (round.executionsCreated !== input.expectedExecutionsPerRound) {
      leakOk = false;
      offending.push(round.round);
    }
    if (!round.raceConverged) {
      raceOk = false;
      offending.push(round.round);
    }
    if (
      !round.replayProbe.replayed ||
      round.replayProbe.newExecutions !== 0 ||
      round.replayProbe.newIdempotencyRecords !== 0
    ) {
      replayOk = false;
      offending.push(round.round);
    }
  }
  return {
    journalExactlyOncePerAttempt: journalOk,
    noLedgerDrift: ledgerOk,
    noRowCountLeak: leakOk,
    raceConvergence: raceOk,
    keysNeverArbitratingSecondTransition: replayOk,
    offendingRounds: [...new Set(offending)],
  };
}

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

/** The FNV-1a digest helper (the validation-program digest discipline). */
export function concurrencyDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

/**
 * The platform-side lifecycle port. The `authorize` transition rides
 * the REAL admission seam: at the crown the bound execution service's
 * authorization gate may deny (the typed POLICY_DENIED surfaces as a
 * thrown error carrying the code — the driver catches and classifies
 * it, never fabricating an admission).
 */
export interface ConcurrencyLifecyclePort {
  /** Canonical transitions (the admission gate rides `authorize`). */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
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
  /**
   * The submission-attempt journal (the platform's
   * `agent-action-recorded` step-event vocabulary): called EXACTLY
   * once per journaled record with digest references only.
   */
  recordStepEvent(input: {
    readonly executionId: string;
    readonly record: SoakJournalRecord;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
}

/** One journaled soak record (digests, never payload bytes). */
export interface SoakJournalRecord {
  /** 1-based ordinal within the execution's step-event journal. */
  readonly ordinal: number;
  readonly kind:
    | "submission-attempt"
    | "race-observation"
    | "replay-probe"
    | "soak-invariant"
    | "effect";
  readonly digest: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// The submission seam + the effect world + the world facts
// ---------------------------------------------------------------------------

/**
 * The service-level submission seam: ONE create through the REAL
 * idempotency ledger (the arbitration authority). The racing probes
 * and the replay probes ride it; the crown binds the REAL executions
 * service's createExecution.
 */
export type ConcurrencySubmissionSeam = (input: {
  readonly key: string;
  readonly body: Readonly<Record<string, unknown>>;
}) => Promise<SubmissionObservation>;

/** One effect the execution's work applies (the fixture-world spec). */
export interface SoakEffectSpec {
  /** The effect's identity (e.g. "settle:SOAK-R1-L0"). */
  readonly effect: string;
  readonly kind: "settle" | "notify";
  readonly key: string;
  readonly amountMicro: number;
}

/** One journaled effect application (the sequence-gapless journal). */
export interface EffectJournalRecord {
  /** The journal sequence (1-based, gapless across the execution). */
  readonly sequence: number;
  readonly effect: string;
  readonly digest: string;
}

/** The app's controlled effect world (the fixture seam). */
export interface ConcurrencyEffectWorld {
  /** Apply one effect against the fixture state (returns the counter effect). */
  apply(effect: SoakEffectSpec): { ok: boolean; value: string };
  /** Optional journal hook (the fixture observes the journal records). */
  readonly journalHook?: (record: EffectJournalRecord) => void;
  /** The fixture state's own effect counters (the multiplicity oracle's input). */
  readonly observedCounts: Readonly<Record<string, number>>;
}

/**
 * The durable world facts (the ledger's own counts — REAL SQL at the
 * crown). `orphanEventCount` counts events with NO parent execution row
 * (the no-orphan-transition oracle — an event whose execution
 * disappeared is mechanically detectable; rows are never deleted).
 */
export interface ConcurrencyWorldFacts {
  readonly executionCount: number;
  readonly eventCount: number;
  readonly idempotencyRecordCount: number;
  readonly orphanEventCount: number;
}

// ---------------------------------------------------------------------------
// The dispatch seam (the live rows' REAL model round)
// ---------------------------------------------------------------------------

/** The outcome of ONE dispatch attempt (one seam roundtrip). */
export interface DispatchAttemptOutcome {
  readonly kind: "success" | "failure";
  readonly content?: string;
  readonly usage?: LabUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
  readonly requestDigest: string;
}

/** The dispatch seam: one model round per call (the live rows). */
export type ConcurrencyDispatch = (input: {
  readonly executionId: string;
  readonly lane: number;
  readonly attempt: number;
}) => Promise<DispatchAttemptOutcome>;

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
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** The corpus row (the full oracle — AC1's per-row contract). */
export interface ConcurrencyCorpusRow {
  readonly rowId: string;
  readonly pattern: LoadPattern;
  readonly description: string;
  /**
   * The submission contract: the per-wave (burst) / per-round (soak) /
   * whole-row (race, fan-out) landed-lane count and key discipline.
   */
  readonly submissions: {
    /** The LANES per group (a racing pair's two concurrent creates land ONE lane). */
    readonly count: number;
    /** The racing rows: the pair's two concurrent creates share ONE key. */
    readonly sameKey: boolean;
  };
  /** The over-ceiling rows: the wave sizes (driven wave by wave). */
  readonly burstWaves?: readonly number[];
  /** The declared admission ceiling (over-ceiling rows). */
  readonly ceiling?: number;
  /** The soak rows: the round count and the declared inter-round spacing. */
  readonly soak?: {
    readonly rounds: number;
    readonly interRoundSpacingMs: number;
  };
  /** Whether the row's lanes demand a dispatch seam (the live rows). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /**
   * The per-lane effect spec builder: lane index (and the soak round)
   * → the effects the lane's admitted execution applies exactly once.
   */
  readonly laneEffects: (lane: number, round?: number) => readonly SoakEffectSpec[];
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    /**
     * The row's total durable executions after the pattern settles
     * (the app's lanes + the driver's racing-probe lanes).
     */
    readonly executions: number;
    /** The row's total distinct idempotency keys. */
    readonly idempotencyRecords: number;
    /** The total exactly-once effect contract. */
    readonly effects: Readonly<Record<string, number>>;
    /** The app-side submission expectations (the app's own contract). */
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** The burst rows' admission shaping contract. */
    readonly admitted?: number;
    readonly denied?: number;
    /** The fan-out rows' minimum observed concurrent overlap. */
    readonly maxConcurrent?: number;
  };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One landed execution's driven outcome. */
export interface ConcurrencyExecutionResult {
  readonly executionId: string;
  readonly outcome: "COMPLETED" | "FAILED" | "NOT-ADMITTED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly window: ExecutionWindow | null;
  readonly effects: readonly EffectJournalRecord[];
  /** The typed admission denial (over-ceiling denials only). */
  readonly denial: { readonly code: string } | null;
  /** The measured usage of the lane's dispatch rounds (live rows). */
  readonly usage: LabUsage | null;
}

/** One service-level racing probe's outcome. */
export interface RaceProbeResult {
  readonly keyDigest: string;
  readonly observations: readonly SubmissionObservation[];
  readonly verdict: RaceArbitrationVerdict;
}

/** The full row run result (the honest outcome contract). */
export interface ConcurrencyRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  /** The row-level criteria (the concurrency contracts). */
  readonly criteria: readonly LabVerificationCriterion[];
  readonly executions: readonly ConcurrencyExecutionResult[];
  readonly probes: readonly RaceProbeResult[];
  readonly rounds: readonly SoakRoundFacts[];
  /** The measured soak window (soak rows only; declared spacing, measured elapsed). */
  readonly soakWindowMs: number | null;
  readonly usage: LabUsage | null;
  readonly totalLatencyMs: number;
  /** The honest failure cause (null on healthy runs). */
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The execution chain (one landed execution's machinery)
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly lane: number;
  readonly round?: number;
  readonly row: ConcurrencyCorpusRow;
  readonly lifecycle: ConcurrencyLifecyclePort;
  readonly world: ConcurrencyEffectWorld;
  readonly dispatch?: ConcurrencyDispatch;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
  readonly keyCounter: { count: number };
  readonly journalTimeline: JournalTimelineEntry[];
  /**
   * The burst wave's admission barrier: resolves once EVERY lane of
   * the wave has had its authorize attempt settled (admitted or
   * denied). The admitted chains await it BEFORE proceeding — the
   * admission gate's decision window stays atomic (an early lane's
   * completion can never free a slot mid-wave and let a late lane
   * bypass the ceiling).
   */
  readonly admissionSettled?: Promise<void>;
  /** Signal that this chain's authorize attempt settled (the barrier). */
  readonly signalAdmission?: () => void;
}

/** Generate the next per-call key fragment (per-decision distinct). */
function nextCallKey(counter: { count: number }): string {
  counter.count += 1;
  return `k${counter.count}`;
}

/**
 * Drive ONE landed execution's machinery: authorize (the admission
 * seam — the over-ceiling denial is caught here with ZERO further
 * transitions) → plan → planning-decision BEFORE the first dispatch →
 * queue → start → the lane's effects (the dispatch round for the live
 * rows) → verify → terminal. The window is measured across the whole
 * chain (the overlap derivation's input).
 */
async function driveExecutionChain(options: ChainOptions): Promise<ConcurrencyExecutionResult> {
  const { executionId, lane, row, lifecycle, world } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const effects: EffectJournalRecord[] = [];
  let failure: { category: string; message: string } | null = null;
  let usage: LabUsage | null = null;
  const startedAt = options.now().getTime();

  // ---- the admission seam (authorize) ----
  try {
    await lifecycle.transition({
      executionId,
      step: "authorize",
      reason: `val-025-authorize-lane-${lane}`,
      callKey: key(),
    });
    options.signalAdmission?.();
    // The admission barrier: the wave's authorize window is atomic —
    // no admitted chain proceeds until every lane's attempt settled.
    if (options.admissionSettled !== undefined) {
      await options.admissionSettled;
    }
  } catch (error) {
    const code = (error as { readonly code?: string })?.code ?? "UNEXPECTED";
    if (isAdmissionRejection({ code })) {
      options.signalAdmission?.();
      // The typed admission denial: the execution STAYS CREATED with
      // the durable policy-denied envelope (the platform's own
      // journal-then-fail discipline) — ZERO further transitions,
      // ZERO effects (the honest NOT-ADMITTED outcome).
      return {
        executionId,
        outcome: "NOT-ADMITTED",
        criteria: [
          {
            criterionId: "admission-denied-zero-effects",
            strategy: "deterministic",
            status: "PASS",
            evidence: [
              `code:${ADMISSION_REJECTION_CODE}`,
              `effects:0`,
              `transitions:authorize-only`,
              `durableEnvelope:${ADMISSION_DENIED_EVENT_TYPE}`,
            ],
          },
        ],
        window: null,
        effects,
        denial: { code: ADMISSION_REJECTION_CODE },
        usage: null,
      };
    }
    // An unexpected authorize failure: the honest FAILED (never a
    // fabricated admission).
    failure = {
      category: code === "UNEXPECTED" ? "authorize-unexpected" : code,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (failure === null) {
    // ---- the canonical prologue (the planning decision BEFORE the
    // first dispatch — the VAL-019/020/021 driver discipline) ----
    await lifecycle.transition({
      executionId,
      step: "plan",
      reason: `val-025-plan-lane-${lane}`,
      callKey: key(),
    });
    await lifecycle.recordPlanningDecision({
      executionId,
      route: {
        provider: row.needsDispatch ? "openrouter" : "deterministic-fixture",
        model: row.needsDispatch ? "live" : "none",
        strategyClass: "concurrency-soak",
      },
    });
    await lifecycle.transition({
      executionId,
      step: "queue",
      reason: `val-025-queue-lane-${lane}`,
      callKey: key(),
    });
    await lifecycle.transition({
      executionId,
      step: "start",
      reason: `val-025-start-lane-${lane}`,
      callKey: key(),
    });

    // ---- the dispatch round (the live rows' REAL model round) ----
    if (row.needsDispatch && options.dispatch !== undefined) {
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ executionId, lane, attempt });
        if (outcome.kind === "success") {
          if (outcome.usage !== undefined) {
            usage = {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              ...(outcome.usage.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
            };
          }
          break;
        }
        const retryable = isRetryableDispatchCategory(outcome.category ?? "");
        if (!retryable || attempt > options.retry.maxExtraAttempts) {
          failure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await options.retry.sleep(options.retry.backoffMs);
      }
    }

    // ---- the lane's effects (exactly once, journal-gapless) ----
    if (failure === null) {
      for (const effect of row.laneEffects(lane, options.round)) {
        const applied = world.apply(effect);
        if (!applied.ok) {
          failure = {
            category: "effect-rejection",
            message: `the effect world rejected ${effect.effect}: ${applied.value}`,
          };
          break;
        }
        const record: EffectJournalRecord = {
          sequence: effects.length + 1,
          effect: effect.effect,
          digest: concurrencyDigestOf(effect),
        };
        effects.push(record);
        options.journalTimeline.push({ executionId, ordinal: record.sequence });
        await lifecycle.recordStepEvent({
          executionId,
          record: {
            ordinal: record.sequence,
            kind: "effect",
            digest: record.digest,
            detail: `effect:${record.effect}`,
          },
        });
        world.journalHook?.(record);
      }
    }
  }

  const endedAt = options.now().getTime();

  // ---- verify + terminal (the per-execution criteria) ----
  const criteria: LabVerificationCriterion[] = [];
  // 1. The lane's effects applied exactly once each (judged against
  //    the chain's own journal).
  const laneExpected: Record<string, number> = {};
  for (const effect of row.laneEffects(lane, options.round)) {
    laneExpected[effect.effect] = 1;
  }
  const laneObserved: Record<string, number> = {};
  for (const effectKey of Object.keys(laneExpected)) {
    laneObserved[effectKey] = effects.filter((record) => record.effect === effectKey).length;
  }
  const multiplicity = deriveEffectMultiplicity(laneExpected, laneObserved);
  criteria.push({
    criterionId: "lane-effects-exactly-once",
    strategy: "deterministic",
    status: failure === null && multiplicity.exactlyOnce ? "PASS" : "FAIL",
    evidence: [
      `lane:${lane}`,
      `expected:${
        Object.entries(laneExpected)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `observed:${
        Object.entries(laneObserved)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `failure:${failure?.category ?? "none"}`,
    ],
  });
  // 2. The effect journal is gapless (1..N).
  const gaplessness = deriveJournalGaplessness(effects.map((record) => record.sequence));
  criteria.push({
    criterionId: "lane-journal-gapless",
    strategy: "deterministic",
    status: gaplessness.gapless ? "PASS" : "FAIL",
    evidence: [
      `sequences:${effects.map((record) => record.sequence).join(">") || "empty-by-design"}`,
      `holes:${gaplessness.holes.join("|") || "none"}`,
      `duplicates:${gaplessness.duplicates.join("|") || "none"}`,
    ],
  });
  // 3. The honest outcome contract.
  const outcome: "COMPLETED" | "FAILED" = failure !== null ? "FAILED" : "COMPLETED";
  criteria.push({
    criterionId: "lane-outcome-contract",
    strategy: "deterministic",
    status: failure === null ? "PASS" : "FAIL",
    evidence: [
      `outcome:${outcome}`,
      `failure:${failure?.category ?? "none"}`,
      `usage:${usage === null ? "none" : `${usage.inputTokens}+${usage.outputTokens}`}`,
    ],
  });

  await lifecycle.transition({
    executionId,
    step: "verify",
    reason: `val-025-verify-lane-${lane}`,
    callKey: key(),
  });
  await lifecycle.complete({
    executionId,
    verdict: failure === null ? "pass" : "fail",
    criteria,
    reason: failure === null ? "val-025-verified" : `val-025-${failure.category}`,
    callKey: key(),
  });

  return {
    executionId,
    outcome,
    criteria,
    window: { executionId, startedAt, endedAt },
    effects,
    denial: null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * The landed-executions provider: returns the NEXT group's landed
 * execution ids (submission order). The crown's provider polls the
 * REAL SQL until the group's expected count of new executions lands
 * (multi-group rows — the burst's waves and the soak's rounds — have
 * the app submit each group only after the previous group settled).
 */
export type LandedExecutionsProvider = (
  group: number,
  expectedCount: number,
) => Promise<readonly string[]>;

/**
 * Drive one concurrency corpus row to settlement through the platform
 * path: the landed lanes' chains driven CONCURRENTLY (the fan-out
 * overlap and the journal interleaving are observed on the REAL
 * concurrent driving); the over-ceiling waves sequenced (the admission
 * gate rides each wave's authorize transitions — exactly the ceiling
 * admit, the rest deny typed with ZERO further transitions); the soak
 * rounds interleaved with the per-round racing probe, the per-round
 * invariant re-verification, the replay probe and the declared
 * spacing; the service-level racing probe (a fresh key's concurrent
 * pair) driven through the submission seam for every race row.
 *
 * The row-level criteria derive mechanically (the race arbitration,
 * the fan-out parallelism, the ceiling shaping, the soak invariants,
 * the no-phantom/no-orphan contracts, the row effect multiplicity, the
 * journal-exactly-once-per-attempt discipline) and the honest terminal
 * is FAILED when any execution failed, any criterion failed or any
 * failure was observed — never a partial-success shortcut.
 */
export async function driveConcurrencyRow(options: {
  readonly row: ConcurrencyCorpusRow;
  readonly lifecycle: ConcurrencyLifecyclePort;
  readonly world: ConcurrencyEffectWorld;
  /**
   * The PRE-ROW durable facts (captured by the caller BEFORE the app
   * submitted — the row-total deltas are measured against it).
   */
  readonly baseline: ConcurrencyWorldFacts;
  /** The durable world-facts provider (REAL SQL counts at the crown). */
  readonly worldFacts: () => Promise<ConcurrencyWorldFacts> | ConcurrencyWorldFacts;
  /** The landed-executions provider (called once per group). */
  readonly landedProvider: LandedExecutionsProvider;
  /** The service-level submission seam (REQUIRED for race and soak rows). */
  readonly submissionSeam?: ConcurrencySubmissionSeam;
  /** The dispatch seam (the live rows only). */
  readonly dispatch?: ConcurrencyDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live rows). */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** The driver's key namespace (per-run distinct). */
  readonly runSuffix: string;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<ConcurrencyRunResult> {
  const { row, lifecycle, world } = options;
  if (
    (row.pattern === "same-key-race" || row.pattern === "soak-rounds") &&
    options.submissionSeam === undefined
  ) {
    throw new Error(
      `corpus row ${row.rowId} demands a submission seam (the racing/replay probes ` +
        "require the REAL arbitration authority) but none was bound",
    );
  }
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live rows' REAL model rounds require it)",
    );
  }

  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const journalTimeline: JournalTimelineEntry[] = [];
  const executions: ConcurrencyExecutionResult[] = [];
  const probes: RaceProbeResult[] = [];
  const rounds: SoakRoundFacts[] = [];
  let journaledAttempts = 0;
  let seamAttempts = 0;
  let usageTotal: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;
  let soakWindowMs: number | null = null;
  /** The ordinal base for the seam records (distinct from the chains' effect ordinals). */
  const SEAM_ORDINAL_BASE = 9_000;

  /** Drive one service-level racing probe: N concurrent creates under ONE fresh key. */
  const driveRaceProbe = async (probeKey: string, count: number): Promise<RaceProbeResult> => {
    const seam = options.submissionSeam;
    if (seam === undefined) {
      throw new Error("submission seam required but not bound");
    }
    const body = { kind: "concurrency-soak.probe.v1", probe: probeKey };
    const attempts = Array.from({ length: count }, () =>
      seam({ key: probeKey, body }).then(
        (observation) => observation,
        (error: unknown) =>
          ({
            executionId: "",
            replayed: false,
            status: null,
            rejection: {
              code: (error as { readonly code?: string })?.code ?? "UNEXPECTED",
              status: 0,
            },
            submittedAt: options.now().getTime(),
            latencyMs: 0,
          }) satisfies SubmissionObservation,
      ),
    );
    const observations = await Promise.all(attempts);
    seamAttempts += count;
    const result: RaceProbeResult = {
      keyDigest: concurrencyDigestOf(probeKey),
      observations,
      verdict: deriveRaceArbitration(observations),
    };
    probes.push(result);
    return result;
  };

  /**
   * Journal one seam submission-attempt record (exactly once per
   * attempt — the journal-exactly-once-per-attempt discipline).
   */
  const journalSeamRecord = async (
    executionId: string,
    kind: SoakJournalRecord["kind"],
    ordinal: number,
    payload: unknown,
    detail: string,
  ): Promise<void> => {
    const record: SoakJournalRecord = {
      ordinal,
      kind,
      digest: concurrencyDigestOf(payload),
      detail,
    };
    journalTimeline.push({ executionId, ordinal });
    await lifecycle.recordStepEvent({ executionId, record });
    journaledAttempts += 1;
  };

  /** Build one chain bound to this row's shared journal timeline. */
  const chain = (
    executionId: string,
    lane: number,
    round?: number,
    admissionSettled?: Promise<void>,
    signalAdmission?: () => void,
  ) =>
    driveExecutionChain({
      executionId,
      lane,
      ...(round === undefined ? {} : { round }),
      row,
      lifecycle,
      world,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      retry: options.retry,
      now: options.now,
      keyCounter,
      journalTimeline,
      ...(admissionSettled === undefined ? {} : { admissionSettled }),
      ...(signalAdmission === undefined ? {} : { signalAdmission }),
    });

  /** Accumulate a chain's measured usage into the run total. */
  const accumulateUsage = (result: ConcurrencyExecutionResult): void => {
    if (result.usage === null) {
      return;
    }
    usageTotal =
      usageTotal === null
        ? result.usage
        : {
            inputTokens: usageTotal.inputTokens + result.usage.inputTokens,
            outputTokens: usageTotal.outputTokens + result.usage.outputTokens,
            costUsd: (usageTotal.costUsd ?? 0) + (result.usage.costUsd ?? 0),
          };
  };

  if (row.pattern === "same-key-race") {
    // The racing rows: the app's landed lane (the racing pair's ONE
    // durable execution) chained as lane 0; the service-level racing
    // probe (a fresh key's concurrent pair) re-drives the racing
    // arbitration through the REAL authority — its landed execution is
    // chained as lane 1. Both chains driven CONCURRENTLY.
    const landed = await options.landedProvider(1, 1);
    if (landed.length !== 1) {
      failure = {
        category: "landed-count-mismatch",
        message: `the racing row's landed provider returned ${landed.length} executions (expected 1)`,
      };
    } else {
      const appLanded = landed[0] as string;
      const probeKey = `val-025-probe-${options.runSuffix}-${row.rowId}`;
      const probe = await driveRaceProbe(probeKey, 2);
      const probeLanded = probe.verdict.distinctExecutionIds[0] ?? "";
      // The probe's two attempts journaled exactly once each (on the
      // app's landed execution — the row's primary).
      await journalSeamRecord(
        appLanded,
        "race-observation",
        SEAM_ORDINAL_BASE + 1,
        probe.observations[0],
        "probe:1",
      );
      await journalSeamRecord(
        appLanded,
        "race-observation",
        SEAM_ORDINAL_BASE + 2,
        probe.observations[1],
        "probe:2",
      );
      const settled = await Promise.all([
        chain(appLanded, 0),
        ...(probeLanded === "" ? [] : [chain(probeLanded, 1)]),
      ]);
      executions.push(...settled);
      for (const result of settled) {
        accumulateUsage(result);
      }
    }
  } else if (row.pattern === "distinct-key-fanout") {
    // The fan-out rows: every landed lane's chain driven CONCURRENTLY —
    // the overlap and interleaving proofs ride the real concurrent
    // driving.
    const landed = await options.landedProvider(1, row.submissions.count);
    if (landed.length !== row.submissions.count) {
      failure = {
        category: "landed-count-mismatch",
        message: `the fan-out row's landed provider returned ${landed.length} executions (expected ${row.submissions.count})`,
      };
    } else {
      const settled = await Promise.all(
        landed.map((executionId, lane) => chain(executionId, lane)),
      );
      executions.push(...settled);
      for (const result of settled) {
        accumulateUsage(result);
      }
    }
  } else if (row.pattern === "over-ceiling-burst") {
    // The burst rows: wave by wave, each wave's chains driven
    // CONCURRENTLY (the admission gate rides the wave's authorize
    // transitions — exactly the ceiling admit, the rest deny typed).
    const waves = row.burstWaves ?? [row.submissions.count];
    let laneCursor = 0;
    for (const [waveIndex, wave] of waves.entries()) {
      const waveLanded = await options.landedProvider(waveIndex + 1, wave);
      if (waveLanded.length !== wave) {
        failure = {
          category: "landed-count-mismatch",
          message: `the burst row's wave ${waveIndex + 1} landed provider returned ${waveLanded.length} executions (expected ${wave})`,
        };
        break;
      }
      // The admission barrier: every lane of the wave signals once its
      // authorize attempt settled; the barrier resolves at the last
      // signal, and only then do the admitted chains proceed.
      let releaseBarrier!: () => void;
      const admissionSettled = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let pendingAdmissions = waveLanded.length;
      const signalAdmission = (): void => {
        pendingAdmissions -= 1;
        if (pendingAdmissions <= 0) {
          releaseBarrier();
        }
      };
      const settled = await Promise.all(
        waveLanded.map((executionId, lane) =>
          chain(executionId, laneCursor + lane, undefined, admissionSettled, signalAdmission),
        ),
      );
      executions.push(...settled);
      for (const result of settled) {
        accumulateUsage(result);
      }
      laneCursor += wave;
    }
  } else if (row.pattern === "soak-rounds") {
    // The soak rows: round by round — the round's landed lanes' chains
    // driven concurrently, the per-round racing probe (a fresh key's
    // concurrent pair through the REAL authority), the per-round
    // durable invariants re-verified after EVERY round, the replay
    // probe re-issuing the round's probe key, and the declared
    // inter-round spacing sustaining the window.
    const soak = row.soak ?? { rounds: 1, interRoundSpacingMs: 0 };
    const windowStartedAt = options.now().getTime();
    for (let round = 1; round <= soak.rounds; round += 1) {
      const beforeAttempts = journaledAttempts;
      const beforeSeamAttempts = seamAttempts;
      const roundLanded = await options.landedProvider(round, row.submissions.count);
      if (roundLanded.length !== row.submissions.count) {
        failure = {
          category: "landed-count-mismatch",
          message: `the soak row's round ${round} landed provider returned ${roundLanded.length} executions (expected ${row.submissions.count})`,
        };
        break;
      }
      // The round's window opens AFTER the app's lanes landed (the
      // per-round deltas count the driver's own traffic only — the
      // timing-independent accounting: whether the app submitted
      // upfront or round-by-round, the round adds exactly the probe
      // pair's ONE execution and ONE key).
      const roundStart = await Promise.resolve(options.worldFacts());
      // The per-round racing probe: the fresh probe pair through the
      // REAL arbitration authority; its landed execution is the round's
      // last lane.
      const probeKey = `val-025-probe-${options.runSuffix}-r${round}`;
      const probe = await driveRaceProbe(probeKey, 2);
      const probeLanded = probe.verdict.distinctExecutionIds[0] ?? "";
      const primary = roundLanded[0] as string;
      // The replay probe: re-issue the round's probe key (same body) —
      // the ledger must REPLAY it (the key never arbitrates a second
      // transition; the re-issue rides the CREATE's durable outcome —
      // the timing is chain-independent).
      const seam = options.submissionSeam as ConcurrencySubmissionSeam;
      const replay = await seam({
        key: probeKey,
        body: { kind: "concurrency-soak.probe.v1", probe: probeKey },
      });
      seamAttempts += 1;
      // The round's seam records journal on the round's primary
      // execution BEFORE its chain runs (step events can never land on
      // a terminal row — the platform's physical terminal immutability).
      await journalSeamRecord(
        primary,
        "race-observation",
        SEAM_ORDINAL_BASE + 1,
        probe.observations[0],
        `r${round}:probe:1`,
      );
      await journalSeamRecord(
        primary,
        "race-observation",
        SEAM_ORDINAL_BASE + 2,
        probe.observations[1],
        `r${round}:probe:2`,
      );
      await journalSeamRecord(
        primary,
        "replay-probe",
        SEAM_ORDINAL_BASE + 3,
        replay,
        `r${round}:replay`,
      );
      const chains = roundLanded.map((id, lane) => chain(id, lane, round));
      if (probeLanded !== "") {
        chains.push(chain(probeLanded, row.submissions.count, round));
      }
      const settled = await Promise.all(chains);
      executions.push(...settled);
      for (const result of settled) {
        accumulateUsage(result);
      }
      const roundEnd = await Promise.resolve(options.worldFacts());
      const roundExecutionDelta = roundEnd.executionCount - roundStart.executionCount;
      const roundKeyDelta = roundEnd.idempotencyRecordCount - roundStart.idempotencyRecordCount;
      rounds.push({
        round,
        executionsCreated: roundExecutionDelta,
        idempotencyRecords: roundKeyDelta,
        attempts: seamAttempts - beforeSeamAttempts,
        journaledAttempts: journaledAttempts - beforeAttempts,
        raceConverged: probe.verdict.exactlyOneExecution && probe.verdict.identityPreserved,
        replayProbe: {
          replayed: replay.replayed,
          // Beyond the probe pair's own ONE execution/key: the replay
          // must have added NOTHING.
          newExecutions: roundExecutionDelta - 1,
          newIdempotencyRecords: roundKeyDelta - 1,
        },
      });
      // The per-round invariant verification rides the mechanical
      // criteria (the run result's SoakRoundFacts + the soak criteria
      // derivation, asserted by the unit/crown suites) — the platform's
      // ledger accepts no post-terminal step events by physical design,
      // so the re-verified invariants are recorded as run evidence,
      // never as terminal-row journal writes.
      if (round < soak.rounds) {
        await options.sleep(soak.interRoundSpacingMs);
      }
    }
    soakWindowMs = options.now().getTime() - windowStartedAt;
  }

  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalLatencyMs = options.now().getTime() - runStartedAt;

  // ---- the row-level criteria ----
  const criteria = deriveConcurrencyRowCriteria({
    row,
    executions,
    probes,
    rounds,
    baseline: options.baseline,
    finalFacts,
    journalTimeline,
    journaledAttempts,
    seamAttempts,
    failure,
    soakWindowMs,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    executions.some((execution) => execution.outcome === "FAILED");

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    executions,
    probes,
    rounds,
    soakWindowMs,
    usage: usageTotal,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the same journals +
 * observations + oracle always yield the same verdicts. The criteria
 * prove the race arbitration (exactly-once-per-key — the probes' direct
 * verdict AND the ledger's row-count delta), the fan-out parallelism
 * (overlap or interleaving), the ceiling shaping (exactly the ceiling
 * admitted, the rest typed-denied, zero effects on the denied), the
 * soak invariants (journal exactly-once-per-attempt, no ledger drift,
 * no row-count leak, keys never arbitrating a second transition), the
 * row effect multiplicity, the no-phantom/no-orphan contracts, the
 * journal-exactly-once-per-attempt discipline and the honest outcome
 * contract.
 */
export function deriveConcurrencyRowCriteria(input: {
  readonly row: ConcurrencyCorpusRow;
  readonly executions: readonly ConcurrencyExecutionResult[];
  readonly probes: readonly RaceProbeResult[];
  readonly rounds: readonly SoakRoundFacts[];
  readonly baseline: ConcurrencyWorldFacts;
  readonly finalFacts: ConcurrencyWorldFacts;
  readonly journalTimeline: readonly JournalTimelineEntry[];
  readonly journaledAttempts: number;
  readonly seamAttempts: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
  readonly soakWindowMs: number | null;
}): LabVerificationCriterion[] {
  const { row } = input;
  const criteria: LabVerificationCriterion[] = [];
  const expected = row.expected;

  // (No short-circuit — the VAL-020 calibration: the criteria prove
  // the SEMANTICS; a correctly-shaped honest failure PASSES them while
  // the terminal stays honestly FAILED.)

  // 1. The race arbitration (the racing rows): every service-level
  //    probe converged to EXACTLY ONE execution — one created receipt,
  //    the loser replaying the winner's committed outcome with
  //    identity preserved (or typed-rejected) — NEVER two executions.
  if (row.pattern === "same-key-race") {
    const probeOk = input.probes.every(
      (probe) =>
        probe.verdict.exactlyOneExecution &&
        probe.verdict.identityPreserved &&
        probe.verdict.typedRejections &&
        probe.verdict.distinctExecutionIds.length === 1,
    );
    criteria.push({
      criterionId: "race-arbitration-exactly-once",
      strategy: "deterministic",
      status: input.probes.length > 0 && probeOk ? "PASS" : "FAIL",
      evidence: [
        `probes:${input.probes.length}`,
        `verdicts:${
          input.probes
            .map(
              (probe) =>
                `${probe.verdict.createdCount}c+${probe.verdict.replayedCount}r+${probe.verdict.rejectedCount}x/${probe.verdict.distinctExecutionIds.length}ids`,
            )
            .join("|") || "none"
        }`,
        `identityPreserved:${String(input.probes.every((p) => p.verdict.identityPreserved))}`,
      ],
    });
  }

  // 2. The fan-out parallelism (the fan-out rows): the observed windows
  //    met the declared minimum overlap (no head-of-line blocking) OR
  //    the shared journal interleaved (a straddle).
  if (row.pattern === "distinct-key-fanout") {
    const windows = input.executions
      .map((execution) => execution.window)
      .filter((window): window is ExecutionWindow => window !== null);
    const parallelism = deriveFanoutParallelism(windows, {
      minConcurrent: expected.maxConcurrent ?? 2,
    });
    const interleaving = deriveJournalInterleaving(input.journalTimeline);
    const fanoutOk =
      windows.length === expected.executions &&
      (parallelism.overlapped || interleaving.interleaved);
    criteria.push({
      criterionId: "fanout-no-head-of-line-blocking",
      strategy: "deterministic",
      status: fanoutOk ? "PASS" : "FAIL",
      evidence: [
        `windows:${windows.length}/${expected.executions}`,
        `maxConcurrent:${parallelism.maxConcurrent}`,
        `minRequired:${expected.maxConcurrent ?? 2}`,
        `journalStraddles:${interleaving.straddles}`,
        `proof:${parallelism.overlapped ? "overlap" : interleaving.interleaved ? "interleaving" : "none"}`,
      ],
    });

    // 2b. Distinct identities: every lane's execution is distinct.
    const distinctIds = new Set(input.executions.map((e) => e.executionId)).size;
    criteria.push({
      criterionId: "fanout-distinct-identities",
      strategy: "deterministic",
      status: distinctIds === expected.executions ? "PASS" : "FAIL",
      evidence: [`distinct:${distinctIds}`, `expected:${expected.executions}`],
    });
  }

  // 3. The ceiling shaping (the burst rows): exactly the declared
  //    ceiling admitted, the rest typed-denied with ZERO effects.
  if (row.pattern === "over-ceiling-burst") {
    const attempts: AdmissionAttempt[] = input.executions.map((execution) => ({
      executionId: execution.executionId,
      admitted: execution.denial === null,
      rejection: execution.denial?.code ?? null,
    }));
    const shaping = deriveCeilingShaping({
      ceiling: row.ceiling ?? 1,
      attempts,
      ...(expected.admitted === undefined ? {} : { expectedAdmitted: expected.admitted }),
      ...(expected.denied === undefined ? {} : { expectedDenied: expected.denied }),
    });
    criteria.push({
      criterionId: "ceiling-shaped-admission",
      strategy: "deterministic",
      status: shaping.shapedCorrectly ? "PASS" : "FAIL",
      evidence: [
        `ceiling:${row.ceiling ?? 1}`,
        `admitted:${shaping.admitted}`,
        `denied:${shaping.denied}`,
        `typedDenials:${String(shaping.typedDenials)}`,
        `expectedAdmitted:${expected.admitted ?? "unpinned"}`,
        `expectedDenied:${expected.denied ?? "unpinned"}`,
      ],
    });

    // 3b. ZERO effects on the denied lanes (the multiplicity contract
    //     catches a denied lane that applied anyway).
    const deniedEffects = input.executions.filter(
      (execution) => execution.denial !== null && execution.effects.length > 0,
    );
    criteria.push({
      criterionId: "denied-zero-effects",
      strategy: "deterministic",
      status: deniedEffects.length === 0 ? "PASS" : "FAIL",
      evidence: [
        `deniedLanes:${input.executions.filter((e) => e.denial !== null).length}`,
        `deniedWithEffects:${deniedEffects.length}`,
      ],
    });
  }

  // 4. The soak invariants (the soak rows): re-verified after EVERY
  //    round — journal exactly-once-per-attempt, no ledger drift, no
  //    row-count leak, the per-round race convergence, keys never
  //    arbitrating a second transition.
  if (row.pattern === "soak-rounds") {
    const soak = row.soak ?? { rounds: 1, interRoundSpacingMs: 0 };
    const invariants = deriveSoakInvariants({
      rounds: input.rounds,
      expectedExecutionsPerRound: 1,
      expectedKeysPerRound: 1,
    });
    const soakOk =
      input.rounds.length === soak.rounds &&
      invariants.journalExactlyOncePerAttempt &&
      invariants.noLedgerDrift &&
      invariants.noRowCountLeak &&
      invariants.raceConvergence &&
      invariants.keysNeverArbitratingSecondTransition;
    criteria.push({
      criterionId: "soak-invariants-per-round",
      strategy: "deterministic",
      status: soakOk ? "PASS" : "FAIL",
      evidence: [
        `rounds:${input.rounds.length}/${soak.rounds}`,
        `journalExactlyOnce:${String(invariants.journalExactlyOncePerAttempt)}`,
        `noLedgerDrift:${String(invariants.noLedgerDrift)}`,
        `noRowCountLeak:${String(invariants.noRowCountLeak)}`,
        `raceConvergence:${String(invariants.raceConvergence)}`,
        `keysNeverReArbitrated:${String(invariants.keysNeverArbitratingSecondTransition)}`,
        `offendingRounds:${invariants.offendingRounds.join("|") || "none"}`,
        `declaredSpacingMs:${soak.interRoundSpacingMs}`,
        `measuredWindowMs:${input.soakWindowMs ?? "unmeasured"}`,
      ],
    });
  }

  // 5. The row effect multiplicity: every expected effect applied
  //    exactly its expected count; NO unexpected effect landed.
  const observedCounts: Record<string, number> = {};
  for (const execution of input.executions) {
    for (const record of execution.effects) {
      observedCounts[record.effect] = (observedCounts[record.effect] ?? 0) + 1;
    }
  }
  const multiplicity = deriveEffectMultiplicity(expected.effects, observedCounts);
  criteria.push({
    criterionId: "row-effect-multiplicity-exactly-once",
    strategy: "deterministic",
    status: multiplicity.exactlyOnce ? "PASS" : "FAIL",
    evidence: [
      `expected:${
        Object.entries(expected.effects)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `observed:${
        Object.entries(observedCounts)
          .map(([e, c]) => `${e}x${c}`)
          .join("|") || "none"
      }`,
      `overApplied:${multiplicity.overApplied.join("|") || "none"}`,
      `missing:${multiplicity.missing.join("|") || "none"}`,
      `unexpected:${multiplicity.unexpected.join("|") || "none"}`,
    ],
  });

  // 6. Journal exactly-once-per-attempt: every seam-driven submission
  //    attempt journaled EXACTLY once (a double-write or a drop FAILS).
  const journalOk = input.journaledAttempts === input.seamAttempts;
  criteria.push({
    criterionId: "journal-exactly-once-per-attempt",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [
      `journaled:${input.journaledAttempts}`,
      `seamAttempts:${input.seamAttempts}`,
      `timelineEntries:${input.journalTimeline.length}`,
    ],
  });

  // 7. No phantom executions: the durable execution rows the pattern
  //    settled to are EXACTLY the expected count (a phantom row — an
  //    execution without a submission key — FAILS; this is the
  //    LEDGER-side race convergence proof: a double admission leaves
  //    an extra durable row).
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  const phantomOk = executionDelta === expected.executions;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: phantomOk ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${expected.executions}`,
    ],
  });

  // 8. No orphan ledger transitions: ZERO events with no parent
  //    execution row (an event whose execution disappeared).
  const orphanOk = input.finalFacts.orphanEventCount === 0;
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: orphanOk ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });

  // 9. No ledger drift: the distinct idempotency keys the pattern
  //    settled to are EXACTLY the expected count (a racing group of N
  //    submissions under one key leaves exactly ONE record).
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  const driftOk = keyDelta === expected.idempotencyRecords;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: driftOk ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${expected.idempotencyRecords}`,
    ],
  });

  // 10. The honest outcome contract: the derived terminal matches the
  //     oracle's terminal.
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null || input.executions.some((e) => e.outcome === "FAILED")
      ? "FAILED"
      : "COMPLETED";
  const terminalOk = derivedTerminal === expected.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: terminalOk ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });

  // 11. Honest economics: measured latency recorded; usage recorded
  //     honestly (none on the offline rows — no model dispatch).
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      row.needsDispatch
        ? "usage:measured-on-live-dispatch"
        : "usage:none-reported (the concurrency semantics are ledger-level — no model dispatch)",
      "latencyMs:measured",
      `soakWindowMs:${input.soakWindowMs ?? "n/a"}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side submission contract (PURE verification of app receipts)
// ---------------------------------------------------------------------------

/** The expected submission counts one app run is judged by. */
export interface ExpectedSubmissionCounts {
  /** The total concurrent submissions the app run issues. */
  readonly submissions: number;
  readonly created: number;
  readonly replayed: number;
  readonly rejected: number;
}

/**
 * Judge the app-side submission observations against the declared
 * submission contract (PURE): the created/replayed/rejected counts,
 * identity preservation on every replay, distinct identities on every
 * fan-out lane, the typed rejection codes and (the burst rows) the
 * admission shaping counts. The criteria ride the app's assertion
 * verdict (the app NEVER passes a violated submission contract).
 */
export function verifyConcurrencySubmissionContract(input: {
  readonly expected: ExpectedSubmissionCounts;
  readonly observations: readonly SubmissionObservation[];
  /** The fan-out rows: the distinct lane count the receipts must show. */
  readonly distinctLanes?: number;
  /** The burst rows: the per-execution admission classifications the app observed. */
  readonly admissionOutcomes?: readonly ("admitted" | "denied" | "unresolved")[];
  readonly expectedAdmitted?: number;
  readonly expectedDenied?: number;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const observed = input.observations;
  const created = observed.filter((o) => !o.replayed && o.rejection === null);
  const replayed = observed.filter((o) => o.replayed && o.rejection === null);
  const rejected = observed.filter((o) => o.rejection !== null);

  // 1. The submission-count contract (the pattern's exact shape).
  const countsOk =
    created.length === input.expected.created &&
    replayed.length === input.expected.replayed &&
    rejected.length === input.expected.rejected &&
    observed.length === input.expected.submissions;
  criteria.push({
    criterionId: "submission-counts",
    strategy: "deterministic",
    status: countsOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${input.expected.created}c+${input.expected.replayed}r+${input.expected.rejected}x/${input.expected.submissions}`,
      `observed:${created.length}c+${replayed.length}r+${rejected.length}x/${observed.length}`,
    ],
  });

  // 2. Identity preservation on every replay (a forged claim FAILS):
  //    every replayed receipt must carry one of the created receipts'
  //    identities (the mixed-lane groups — the soak rounds' racing
  //    pair + distinct lanes — legitimately hold several created
  //    identities; the per-key exactly-one discipline is the race
  //    arbitration derivation's job).
  const winnerIds = new Set(created.map((o) => o.executionId));
  const identityOk = replayed.length === 0 || replayed.every((o) => winnerIds.has(o.executionId));
  criteria.push({
    criterionId: "replay-identity-preserved",
    strategy: "deterministic",
    status: identityOk ? "PASS" : "FAIL",
    evidence: [
      `winnerIds:${winnerIds.size}`,
      `replayIds:${[...new Set(replayed.map((o) => o.executionId))].join("|") || "none"}`,
    ],
  });

  // 3. The typed rejection contract: every rejection carries a typed
  //    racing code — never a generic failure.
  const typedOk = rejected.every(
    (o) =>
      o.rejection !== null &&
      (o.rejection.code === IDEMPOTENCY_KEY_REUSED_CODE ||
        o.rejection.code === ALREADY_IN_FLIGHT_CODE),
  );
  criteria.push({
    criterionId: "typed-rejections-surfaced",
    strategy: "deterministic",
    status: typedOk ? "PASS" : "FAIL",
    evidence: [
      `rejections:${
        rejected
          .map((o) => `${o.rejection?.code ?? "none"}/${o.rejection?.status ?? "?"}`)
          .join("|") || "none"
      }`,
    ],
  });

  // 4. The fan-out rows: every lane's identity is DISTINCT.
  if (input.distinctLanes !== undefined) {
    const distinctIds = new Set(observed.map((o) => o.executionId).filter((id) => id !== "")).size;
    criteria.push({
      criterionId: "fanout-distinct-receipts",
      strategy: "deterministic",
      status: distinctIds === input.distinctLanes ? "PASS" : "FAIL",
      evidence: [`distinct:${distinctIds}`, `lanes:${input.distinctLanes}`],
    });
  }

  // 5. The burst rows: the admission shaping counts the app observed
  //    (the durable policy-denied envelope seen through the public
  //    events read on every denied lane; a terminal on every admitted).
  if (input.admissionOutcomes !== undefined) {
    const admitted = input.admissionOutcomes.filter((o) => o === "admitted").length;
    const denied = input.admissionOutcomes.filter((o) => o === "denied").length;
    const unresolved = input.admissionOutcomes.filter((o) => o === "unresolved").length;
    const shapingOk =
      unresolved === 0 &&
      admitted === (input.expectedAdmitted ?? 0) &&
      denied === (input.expectedDenied ?? 0);
    criteria.push({
      criterionId: "app-admission-shaping-counts",
      strategy: "deterministic",
      status: shapingOk ? "PASS" : "FAIL",
      evidence: [
        `admitted:${admitted}`,
        `denied:${denied}`,
        `unresolved:${unresolved}`,
        `expectedAdmitted:${input.expectedAdmitted ?? "?"}`,
        `expectedDenied:${input.expectedDenied ?? "?"}`,
      ],
    });
  }

  return criteria;
}
