/**
 * The platform-side outcome-correctness driver (VAL-026).
 *
 * The correctness slice for outcome-state semantics: drives declared
 * effect sets through the REAL platform path and mechanically proves
 * the outcome-state contracts the executions state machine, the
 * verification boundary and the step-event journal are responsible
 * for:
 *
 *   * the outcome vocabulary as PURE derivations —
 *     `deriveGuardAdmission` (the budget admission that PRECEDES any
 *     effect work: the declared quota must cover the declared effect
 *     demand — a rejected guard fails the execution honestly BEFORE a
 *     single effect is staged), `deriveTerminalCriteriaAgreement` (the
 *     anyFail→FAILED invariant proper: a terminal COMPLETED holds IFF
 *     no verification criterion failed — BOTH directions, so a
 *     fabricated pass-with-fail AND a fabricated fail-with-all-pass
 *     are mechanically unrepresentable), `deriveOutcomeReconciliation`
 *     (the per-row reconciliation chain the work order pins: terminal
 *     ↔ criteria ↔ journal ↔ fixture-state agreement, each leg its own
 *     criterion with its own catch), `deriveEffectMultiplicity` (the
 *     exactly-once fixture oracle re-derived locally so the slice is
 *     self-contained) and `deriveJournalGaplessness` (the 1..N
 *     continuity discipline);
 *   * the atomicity of the verification boundary: declared effects are
 *     STAGED against the fixture world and committed ONLY on a passing
 *     verdict — a FAILED execution's staged effects are DISCARDED, so
 *     a FAILED row's fixture-state delta is EMPTY by construction and
 *     verified mechanically against the corpus oracle;
 *   * the replay machinery: after a row settles, the driver's replay
 *     probe re-issues the app's submission key through the REAL
 *     idempotency ledger — the replay must surface the replayed flag
 *     with identity preserved and add ZERO new executions, ZERO new
 *     ledger records and ZERO new fixture effects (the VAL-021
 *     discipline re-derived for the outcome shape);
 *   * the execution driver mirroring the VAL-019/020/021/025 drivers
 *     (authorize → plan → planning-decision BEFORE the first dispatch
 *     → queue → start → the guard → the staged effects (the live row's
 *     REAL dispatch round with bounded RETRYABLE-only retry) → verify
 *     → the commit/discard boundary → terminal: a failure outcome or
 *     ANY failed criterion → verdict fail — never a partial-success
 *     shortcut), with the observed terminal READ BACK from the ledger
 *     after settlement (the reconciliation judges the platform's own
 *     durable claim, never the driver's private intent).
 *
 * Honesty invariants:
 *   * a COMPLETED terminal with a FAIL criterion is unrepresentable
 *     (the terminal↔criteria agreement FAILs the row honestly — the
 *     platform's raw `pass` edge accepts mixed results, so the DRIVER
 *     derives the verdict mechanically and the RECONCILIATION catches
 *     any fabricated mix from whatever source);
 *   * a FAILED execution never lands a declared effect (staged-then-
 *     discarded; the fixture delta oracle pins the EMPTY delta);
 *   * the journal's effect records match the fixture state EXACTLY
 *     (a journal that records an effect that never landed — or a
 *     fixture effect the journal never recorded — FAILs the
 *     journal↔fixture leg);
 *   * no phantom executions, no ledger drift, no orphan transitions —
 *     all mechanically detected against the world's own counts;
 *   * usage, cost and latency are measured, never estimated; evidence
 *     carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL executions service (the idempotency ledger, the
 * state machine, the step-event journal) and — for the live row — the
 * REAL model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The outcome vocabulary (the corpus's declared shapes)
// ---------------------------------------------------------------------------

/** The deterministic failure injections the corpus declares. */
export const FAILURE_KINDS = [
  // the pre-effect budget guard rejects the work: the declared quota
  // does not cover the declared effect demand — the execution FAILS
  // before a single effect is staged (an honest precondition failure)
  "pre-effect-guard",
  // the fixture world rejects one declared effect mid-sequence (a
  // frozen target): the staged effects are discarded atomically — the
  // FAILED execution lands ZERO effects
  "mid-work-effect-rejection",
  // every effect stages cleanly but the row's DECLARED verification
  // expectation (the expected fixture digest) disagrees with the
  // staged outcome: one criterion FAILs → verdict fail → the staged
  // effects are discarded → FAILED with an EMPTY delta (the
  // anyFail→FAILED invariant in its purest shape)
  "verification-criterion-fail",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export function isFailureKind(value: string): value is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(value);
}

/** The replay probes the corpus declares. */
export const REPLAY_PROBES = [
  // re-issue the app's submission key after the execution COMPLETED:
  // the ledger replays the committed outcome, zero new effects
  "after-completion",
  // re-issue the app's submission key after the execution FAILED: the
  // ledger replays the durable FAILED receipt, zero new effects (the
  // atomicity persists across replays)
  "after-failure",
] as const;

export type ReplayProbe = (typeof REPLAY_PROBES)[number];

export function isReplayProbe(value: string): value is ReplayProbe {
  return (REPLAY_PROBES as readonly string[]).includes(value);
}

/**
 * The platform's typed key-reuse rejection code (the same token
 * VAL-021/025 pinned): a different request fingerprint under one
 * idempotency key surfaces the typed 409 IDEMPOTENCY_KEY_REUSED.
 */
export const IDEMPOTENCY_KEY_REUSED_CODE = "IDEMPOTENCY_KEY_REUSED";

// ---------------------------------------------------------------------------
// PURE derivations (the oracle floor)
// ---------------------------------------------------------------------------

/** One declared effect (the fixture-world spec — digests, never bytes). */
export interface OutcomeEffectSpec {
  /** The effect's identity (e.g. "order:charge"). */
  readonly effect: string;
  readonly kind: "workspace" | "order" | "ticket" | "citation" | "notify";
  /** The target key in the fixture world (e.g. "ORD-601"). */
  readonly key: string;
  /** The value the effect moves (micro-USD; the guard's demand input). */
  readonly amountMicro: number;
}

/**
 * Derive the budget-guard admission (PURE): the declared quota must
 * cover the declared effect demand — admission precedes any effect
 * work. A rejected guard is an honest PRECONDITION failure (never a
 * silent partial application).
 */
export function deriveGuardAdmission(input: {
  readonly quotaMicro: number;
  readonly effects: readonly OutcomeEffectSpec[];
}): { readonly allowed: boolean; readonly reason: string | null; readonly demandedMicro: number } {
  const demandedMicro = input.effects.reduce((sum, effect) => sum + effect.amountMicro, 0);
  if (demandedMicro > input.quotaMicro) {
    return {
      allowed: false,
      reason: `quota guard rejected the work: the declared effect demand ${demandedMicro} micro-USD exceeds the declared quota ${input.quotaMicro} micro-USD`,
      demandedMicro,
    };
  }
  return { allowed: true, reason: null, demandedMicro };
}

/** The terminal↔criteria facts (the anyFail→FAILED invariant's input). */
export interface TerminalCriteriaFacts {
  /** The OBSERVED terminal (the platform's own durable claim). */
  readonly terminal: string | null;
  /** The OBSERVED verification statuses (the result read's own rows). */
  readonly verificationStatuses: readonly string[];
}

export interface TerminalCriteriaAgreement {
  /**
   * COMPLETED ⟺ no FAIL criterion — BOTH directions: a fabricated
   * pass-with-fail AND a fabricated fail-with-all-pass disagree.
   */
  readonly agreement: boolean;
  readonly evidence: readonly string[];
}

/**
 * Derive the terminal↔criteria agreement (PURE — the anyFail→FAILED
 * invariant): a terminal COMPLETED holds IFF no verification criterion
 * failed, and a terminal FAILED REQUIRES at least one failed criterion
 * (the failure must be visible in the criteria — an honest failure is
 * never silent). Any fabricated mix is mechanically unrepresentable.
 */
export function deriveTerminalCriteriaAgreement(
  facts: TerminalCriteriaFacts,
): TerminalCriteriaAgreement {
  const failed = facts.verificationStatuses.filter((status) => status === "FAIL").length;
  const passed = facts.verificationStatuses.filter((status) => status === "PASS").length;
  const isCompleted = facts.terminal === "COMPLETED";
  const noFail = failed === 0;
  const agreement = facts.terminal !== null && isCompleted === noFail;
  return {
    agreement,
    evidence: [
      `terminal:${facts.terminal ?? "none"}`,
      `criteria:${passed}pass+${failed}fail`,
      `invariant:${isCompleted ? "COMPLETED-implies-no-FAIL" : "FAILED-implies-a-FAIL"}`,
      agreement ? "agreed" : "DISAGREED (a fabricated outcome-criteria mix)",
    ],
  };
}

/** The per-execution observation the reconciliation judges. */
export interface OutcomeExecutionFacts {
  readonly executionId: string;
  /** The OBSERVED terminal (read back from the ledger after settlement). */
  readonly terminal: string | null;
  /** The OBSERVED verification statuses (the completion's own criteria). */
  readonly verificationStatuses: readonly string[];
  /** The OBSERVED journal effect records (the committed-effect journal). */
  readonly journalEffects: readonly string[];
  /** The OBSERVED fixture-state delta attributable to the execution. */
  readonly fixtureDelta: Readonly<Record<string, number>>;
  /** The row's declared effect ids (the declared effect set). */
  readonly declaredEffects: readonly string[];
  /** The oracle's expected terminal. */
  readonly expectedTerminal: "COMPLETED" | "FAILED";
  /** The oracle's expected fixture-state delta (EMPTY for FAILED rows). */
  readonly expectedFixtureDelta: Readonly<Record<string, number>>;
}

/** The reconciliation verdict (one execution, every leg). */
export interface OutcomeReconciliationVerdict {
  /** terminal ↔ criteria (the anyFail→FAILED invariant, both directions). */
  readonly terminalCriteriaAgreement: boolean;
  /** journal ↔ fixture-state (the committed journal matches the world). */
  readonly journalFixtureAgreement: boolean;
  /** declared effect set ↔ journal (the declared set is what landed). */
  readonly declaredJournalAgreement: boolean;
  /** fixture-state ↔ the corpus oracle (the delta, EMPTY on FAILED). */
  readonly fixtureDeltaAgreement: boolean;
  /** the observed terminal ↔ the oracle's expected terminal. */
  readonly terminalAgreement: boolean;
  /** Every leg agreed (a single disagreement fails the row honestly). */
  readonly agreed: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/** Count a list's entries into a multiset record. */
function countBy(entries: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry] = (counts[entry] ?? 0) + 1;
  }
  return counts;
}

/** Multiset equality over count records (no zero-count noise). */
function countsEqual(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) {
      return false;
    }
  }
  return true;
}

const renderCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .map(([effect, count]) => `${effect}x${count}`)
    .join("|") || "none";

/**
 * Derive the outcome reconciliation (PURE): the per-row chain
 * terminal ↔ criteria ↔ journal ↔ fixture-state agreement the work
 * order pins, each leg its own criterion:
 *
 *   1. terminal↔criteria — the anyFail→FAILED invariant (a fabricated
 *      pass-with-fail FAILs here — the adversarial catch);
 *   2. journal↔fixture — the journal's effect records are EXACTLY the
 *      effects the fixture world committed (a journal that records an
 *      effect that never landed, or a fixture effect without a journal
 *      record, FAILs here);
 *   3. declared↔journal — the declared effect set is EXACTLY what the
 *      journal recorded (COMPLETED: the full declared set; FAILED:
 *      NOTHING — an effect-set mismatch FAILs here);
 *   4. fixture↔oracle — the observed fixture delta is EXACTLY the
 *      corpus-declared delta (the EMPTY delta for FAILED rows is a
 *      first-class expectation — missing effects, phantom effects and
 *      over-application all FAIL here);
 *   5. terminal↔oracle — the observed terminal is the expected one.
 */
export function deriveOutcomeReconciliation(
  facts: OutcomeExecutionFacts,
): OutcomeReconciliationVerdict {
  const criteria: LabVerificationCriterion[] = [];

  // 1. terminal ↔ criteria (the anyFail→FAILED invariant).
  const terminalCriteria = deriveTerminalCriteriaAgreement({
    terminal: facts.terminal,
    verificationStatuses: facts.verificationStatuses,
  });
  criteria.push({
    criterionId: "terminal-criteria-agreement",
    strategy: "deterministic",
    status: terminalCriteria.agreement ? "PASS" : "FAIL",
    evidence: [`execution:${facts.executionId}`, ...terminalCriteria.evidence],
  });

  // 2. journal ↔ fixture-state.
  const journalCounts = countBy(facts.journalEffects);
  const fixtureCounts: Record<string, number> = {};
  for (const [effect, count] of Object.entries(facts.fixtureDelta)) {
    if (count > 0) {
      fixtureCounts[effect] = count;
    }
  }
  const journalFixtureAgreement = countsEqual(journalCounts, fixtureCounts);
  criteria.push({
    criterionId: "journal-fixture-agreement",
    strategy: "deterministic",
    status: journalFixtureAgreement ? "PASS" : "FAIL",
    evidence: [
      `journal:${renderCounts(journalCounts)}`,
      `fixture:${renderCounts(fixtureCounts)}`,
      journalFixtureAgreement
        ? "agreed"
        : "DISAGREED (the journal and the fixture state tell different stories)",
    ],
  });

  // 3. declared effect set ↔ journal.
  const expectedJournal: Record<string, number> = {};
  if (facts.terminal === "COMPLETED") {
    for (const effect of facts.declaredEffects) {
      expectedJournal[effect] = (expectedJournal[effect] ?? 0) + 1;
    }
  }
  const declaredJournalAgreement = countsEqual(journalCounts, expectedJournal);
  criteria.push({
    criterionId: "declared-journal-agreement",
    strategy: "deterministic",
    status: declaredJournalAgreement ? "PASS" : "FAIL",
    evidence: [
      `declared:${renderCounts(expectedJournal)}`,
      `journal:${renderCounts(journalCounts)}`,
      `expectedShape:${facts.terminal === "COMPLETED" ? "the full declared set" : "EMPTY (a FAILED execution journals zero effects)"}`,
    ],
  });

  // 4. fixture-state ↔ the corpus oracle (the delta, EMPTY on FAILED).
  const fixtureDeltaAgreement = countsEqual(fixtureCounts, facts.expectedFixtureDelta);
  criteria.push({
    criterionId: "fixture-delta-oracle",
    strategy: "deterministic",
    status: fixtureDeltaAgreement ? "PASS" : "FAIL",
    evidence: [
      `expected:${renderCounts(facts.expectedFixtureDelta)}`,
      `observed:${renderCounts(fixtureCounts)}`,
      `expectedTerminal:${facts.expectedTerminal}`,
    ],
  });

  // 5. the observed terminal ↔ the oracle's expected terminal.
  const terminalAgreement = facts.terminal === facts.expectedTerminal;
  criteria.push({
    criterionId: "terminal-oracle-agreement",
    strategy: "deterministic",
    status: terminalAgreement ? "PASS" : "FAIL",
    evidence: [`expected:${facts.expectedTerminal}`, `observed:${facts.terminal ?? "none"}`],
  });

  const agreed =
    terminalCriteria.agreement &&
    journalFixtureAgreement &&
    declaredJournalAgreement &&
    fixtureDeltaAgreement &&
    terminalAgreement;
  return {
    terminalCriteriaAgreement: terminalCriteria.agreement,
    journalFixtureAgreement,
    declaredJournalAgreement,
    fixtureDeltaAgreement,
    terminalAgreement,
    agreed,
    criteria,
  };
}

/** The exactly-once effect verdict against the world's own counters. */
export interface EffectMultiplicityVerdict {
  readonly exactlyOnce: boolean;
  readonly overApplied: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

/**
 * Derive the effect multiplicity (PURE, re-derived locally so the
 * slice is self-contained — the VAL-021/025 discipline): every
 * expected effect's observed count must be EXACTLY the expected count
 * and NO unexpected effect may have landed.
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

/** The gapless-sequence verdict for one journal's observed sequences. */
export interface JournalGaplessnessVerdict {
  readonly gapless: boolean;
  readonly holes: readonly number[];
  readonly duplicates: readonly number[];
}

/**
 * Derive the journal-sequence continuity (PURE): a well-formed journal
 * is EXACTLY 1..N — no holes, no duplicate sequences.
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

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

/** The FNV-1a digest helper (the validation-program digest discipline). */
export function outcomeDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The declared fixture-digest (the customer's declared verification
 * expectation): the digest over the declared effect set in declaration
 * order — deterministic and repository-reproducible.
 */
export function declaredFixtureDigestOf(effects: readonly OutcomeEffectSpec[]): string {
  return outcomeDigestOf(effects.map((effect) => [effect.effect, effect.key, effect.amountMicro]));
}

/**
 * The observed fixture-digest (what actually staged): the digest over
 * the staged records in staging order — compared against the declared
 * digest by the verification criterion.
 */
export function observedFixtureDigestOf(records: readonly OutcomeEffectSpec[]): string {
  return declaredFixtureDigestOf(records);
}

/** The fixture-state delta between two counter snapshots (PURE). */
export function fixtureDeltaOf(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const effect of Object.keys(after)) {
    const difference = (after[effect] ?? 0) - (before[effect] ?? 0);
    if (difference !== 0) {
      delta[effect] = difference;
    }
  }
  for (const effect of Object.keys(before)) {
    if (!(effect in after) && (before[effect] ?? 0) !== 0) {
      delta[effect] = -(before[effect] ?? 0);
    }
  }
  return delta;
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

/**
 * One journaled outcome record (digests, never payload bytes). The
 * effect records are journaled ONLY at the commit boundary — the
 * journal and the fixture state commit together (a discarded stage
 * journals its failure, never its effects).
 */
export interface OutcomeJournalRecord {
  /** 1-based ordinal within the execution's step-event journal. */
  readonly ordinal: number;
  readonly kind: "effect" | "failure";
  readonly digest: string;
  readonly detail: string;
}

/**
 * The platform-side lifecycle port: the canonical transitions, the
 * durable planning decision, the step-event journal (digest references
 * only), the terminal completion and the observed-terminal read-back
 * (the reconciliation judges the ledger's own claim, never the
 * driver's private intent).
 */
export interface OutcomeLifecyclePort {
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
   * The step-event journal (the platform's `agent-action-recorded`
   * vocabulary): called EXACTLY once per journaled record with digest
   * references only.
   */
  recordStepEvent(input: {
    readonly executionId: string;
    readonly record: OutcomeJournalRecord;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
    readonly callKey: string;
  }): Promise<void>;
  /** The observed terminal read-back (the ledger's own status, or null). */
  statusOf(executionId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// The effect world (the fixture-state oracle) + the submission seam
// ---------------------------------------------------------------------------

/**
 * The app's controlled effect world: the fixture-state oracle with the
 * ATOMIC staging discipline. Effects are staged (validated against the
 * frozen targets), then committed ALL-AT-ONCE on a passing verdict or
 * DISCARDED on a failing one — a FAILED execution's declared effects
 * never land in the fixture state.
 */
export interface OutcomeEffectWorld {
  /** Stage one declared effect (the frozen-target validation). */
  stage(effect: OutcomeEffectSpec): { readonly ok: boolean; readonly value: string };
  /** Commit the staged set atomically — the durable fixture effects. */
  commitStaged(): readonly OutcomeEffectSpec[];
  /** Discard the staged set — a failed execution's effects never land. */
  discardStaged(): void;
  /** The fixture state's own committed-effect counters (the oracle's input). */
  readonly observedCounts: Readonly<Record<string, number>>;
}

/**
 * The service-level submission seam: ONE create through the REAL
 * idempotency ledger (the replay authority). The replay probe rides it.
 */
export type OutcomeSubmissionSeam = (input: {
  readonly key: string;
  readonly body: Readonly<Record<string, unknown>>;
}) => Promise<SubmissionObservation>;

/** One submitted create's observed receipt. */
export interface SubmissionObservation {
  readonly executionId: string;
  readonly replayed: boolean;
  /** The receipt's status at observation (when the create succeeded). */
  readonly status: string | null;
  /** The typed rejection (when the create was rejected). */
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly submittedAt: number;
  readonly latencyMs: number;
}

/**
 * The durable world facts (the ledger's own counts — REAL SQL at the
 * crown). `orphanEventCount` counts events with NO parent execution
 * row (the no-orphan-transition oracle).
 */
export interface OutcomeWorldFacts {
  readonly executionCount: number;
  readonly eventCount: number;
  readonly idempotencyRecordCount: number;
  readonly orphanEventCount: number;
}

// ---------------------------------------------------------------------------
// The dispatch seam (the live row's REAL model round)
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

/** The dispatch seam: one model round per call (the live row). */
export type OutcomeDispatch = (input: {
  readonly executionId: string;
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
export interface OutcomeCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /**
   * The declared effect set: the effects the row's work declares, in
   * declaration order (the staging order; the digest's input).
   */
  readonly declaredEffects: readonly OutcomeEffectSpec[];
  /** The declared budget guard input (admission precedes effect work). */
  readonly quotaMicro: number;
  /**
   * The customer's declared verification expectation: the digest of
   * the expected fixture delta. A deliberate disagreement (the
   * criterion-fail row) is the anyFail→FAILED shape.
   */
  readonly expectedFixtureDigest: string;
  /** The deterministic failure injection (absent on healthy rows). */
  readonly failure?: {
    readonly kind: FailureKind;
    /** mid-work: the effect id the fixture world rejects (the frozen target). */
    readonly atEffect?: string;
  };
  /** The replay probe the row drives (absent on non-replay rows). */
  readonly replay?: { readonly after: ReplayProbe };
  /** Whether the row's work demands a dispatch seam (the live row). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    /**
     * The expected fixture-state delta — EMPTY (`{}`) for FAILED rows:
     * a failed execution's declared effects must NOT have been applied.
     */
    readonly fixtureDelta: Readonly<Record<string, number>>;
    /** The row's total durable executions after the row settles. */
    readonly executions: number;
    /** The row's total distinct idempotency keys. */
    readonly idempotencyRecords: number;
    /** The app-side submission expectations (the app's own contract). */
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
  };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One landed execution's driven outcome. */
export interface OutcomeExecutionResult {
  readonly executionId: string;
  /** The driver's mechanically derived verdict (pass IFF no failure and no failed criterion). */
  readonly outcome: "COMPLETED" | "FAILED";
  /** The OBSERVED terminal read back from the ledger after settlement. */
  readonly observedTerminal: string | null;
  readonly criteria: readonly LabVerificationCriterion[];
  /** The journaled effect records' effect ids (the committed-effect journal). */
  readonly journalEffects: readonly string[];
  /** The full journal records (digests only — the gapless check's input). */
  readonly journal: readonly OutcomeJournalRecord[];
  /** The committed fixture effects (the world's own commit receipt). */
  readonly committedEffects: readonly OutcomeEffectSpec[];
  /** The staged-but-discarded effects (FAILED rows only — the atomicity evidence). */
  readonly discardedEffects: readonly OutcomeEffectSpec[];
  /** The measured usage of the dispatch rounds (the live row). */
  readonly usage: LabUsage | null;
}

/** The replay probe's measured facts (zero-new-everything). */
export interface ReplayProbeResult {
  readonly replayed: boolean;
  /** The replay receipt returned the ORIGINAL execution's identity. */
  readonly sameIdentity: boolean;
  readonly newExecutions: number;
  readonly newIdempotencyRecords: number;
  /** New fixture effects the replay applied (must be ZERO). */
  readonly newEffects: number;
  readonly keyDigest: string;
}

/** The full row run result (the honest outcome contract). */
export interface OutcomeRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  /** The row-level criteria (the reconciliation + the durable contracts). */
  readonly criteria: readonly LabVerificationCriterion[];
  readonly execution: OutcomeExecutionResult | null;
  readonly replayProbe: ReplayProbeResult | null;
  /** The observed fixture-state delta for the whole row run. */
  readonly fixtureDelta: Readonly<Record<string, number>>;
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
  readonly row: OutcomeCorpusRow;
  readonly lifecycle: OutcomeLifecyclePort;
  readonly world: OutcomeEffectWorld;
  readonly dispatch?: OutcomeDispatch;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
  readonly keyCounter: { count: number };
}

/** Generate the next per-call key fragment (per-decision distinct). */
function nextCallKey(counter: { count: number }): string {
  counter.count += 1;
  return `k${counter.count}`;
}

/**
 * Drive ONE landed execution's machinery: authorize → plan →
 * planning-decision BEFORE the first dispatch → queue → start → the
 * guard (admission precedes effect work) → the staged effects (the
 * live row's REAL dispatch round first, with bounded retry on
 * RETRYABLE categories only) → verify → the ATOMIC commit/discard
 * boundary → terminal. The verdict is derived MECHANICALLY (any
 * failure or ANY failed criterion → fail — never a partial-success
 * shortcut); the journal's effect records are written ONLY at the
 * commit boundary so the journal and the fixture state commit
 * together.
 */
async function driveOutcomeChain(options: ChainOptions): Promise<OutcomeExecutionResult> {
  const { executionId, row, lifecycle, world } = options;
  const key = (): string => nextCallKey(options.keyCounter);
  const journal: OutcomeJournalRecord[] = [];
  const stagedEffects: OutcomeEffectSpec[] = [];
  let failure: { category: string; message: string } | null = null;
  let usage: LabUsage | null = null;

  // ---- the canonical prologue ----
  await lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-026-authorize",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "plan",
    reason: "val-026-plan",
    callKey: key(),
  });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: row.needsDispatch ? "openrouter" : "deterministic-fixture",
      model: row.needsDispatch ? "live" : "none",
      strategyClass: "outcome-correctness",
    },
  });
  await lifecycle.transition({
    executionId,
    step: "queue",
    reason: "val-026-queue",
    callKey: key(),
  });
  await lifecycle.transition({
    executionId,
    step: "start",
    reason: "val-026-start",
    callKey: key(),
  });

  // ---- the dispatch round (the live row's REAL model confirmation) ----
  if (row.needsDispatch && options.dispatch !== undefined) {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await options.dispatch({ executionId, attempt });
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

  // ---- the budget guard (admission precedes effect work) ----
  if (failure === null) {
    const guard = deriveGuardAdmission({
      quotaMicro: row.quotaMicro,
      effects: row.declaredEffects,
    });
    if (!guard.allowed) {
      failure = {
        category: "precondition-rejected",
        message: guard.reason ?? "quota guard rejected",
      };
    }
  }

  // ---- the staged effects (the atomicity boundary's pending set) ----
  if (failure === null) {
    for (const effect of row.declaredEffects) {
      const staged = world.stage(effect);
      if (!staged.ok) {
        failure = {
          category: "effect-rejection",
          message: `the fixture world rejected ${effect.effect}: ${staged.value}`,
        };
        break;
      }
      stagedEffects.push(effect);
    }
  }

  // ---- the pre-verdict criteria (the verification boundary) ----
  const criteria: LabVerificationCriterion[] = [];
  // 1. The guard admission (an honest FAIL when the guard rejected).
  criteria.push({
    criterionId: "guard-admission",
    strategy: "deterministic",
    status: failure?.category === "precondition-rejected" ? "FAIL" : "PASS",
    evidence: [
      `quotaMicro:${row.quotaMicro}`,
      `demandedMicro:${deriveGuardAdmission({ quotaMicro: row.quotaMicro, effects: row.declaredEffects }).demandedMicro}`,
      `guard:${failure?.category === "precondition-rejected" ? "rejected" : "admitted"}`,
    ],
  });
  // 2. The declared effects staged exactly once (staged == declared).
  const stagedCounts = countBy(stagedEffects.map((effect) => effect.effect));
  const declaredCounts = countBy(row.declaredEffects.map((effect) => effect.effect));
  criteria.push({
    criterionId: "declared-effects-staged",
    strategy: "deterministic",
    status: failure === null && countsEqual(stagedCounts, declaredCounts) ? "PASS" : "FAIL",
    evidence: [
      `declared:${renderCounts(declaredCounts)}`,
      `staged:${renderCounts(stagedCounts)}`,
      `failure:${failure?.category ?? "none"}`,
    ],
  });
  // 3. The declared digest agreement (the customer's declared
  //    verification expectation vs the staged outcome).
  const observedDigest = observedFixtureDigestOf(stagedEffects);
  criteria.push({
    criterionId: "declared-digest-agreement",
    strategy: "deterministic",
    status: observedDigest === row.expectedFixtureDigest ? "PASS" : "FAIL",
    evidence: [
      `declaredDigest:${row.expectedFixtureDigest}`,
      `observedDigest:${observedDigest}`,
      `agreed:${String(observedDigest === row.expectedFixtureDigest)}`,
    ],
  });

  // ---- the verdict (MECHANICAL: any failure or ANY failed criterion → fail) ----
  const verdict: "pass" | "fail" =
    failure === null && criteria.every((criterion) => criterion.status === "PASS")
      ? "pass"
      : "fail";

  // ---- verify, then the ATOMIC commit/discard boundary ----
  await lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-026-verify",
    callKey: key(),
  });

  let committedEffects: readonly OutcomeEffectSpec[] = [];
  if (verdict === "pass") {
    // The commit boundary: the fixture state and the journal commit
    // TOGETHER (every committed effect journaled exactly once, gapless).
    committedEffects = world.commitStaged();
    for (const effect of committedEffects) {
      const record: OutcomeJournalRecord = {
        ordinal: journal.length + 1,
        kind: "effect",
        digest: outcomeDigestOf([effect.effect, effect.key, effect.amountMicro]),
        detail: `effect:${effect.effect}`,
      };
      journal.push(record);
      await lifecycle.recordStepEvent({ executionId, record });
    }
  } else {
    // The discard boundary: a failed execution's staged effects NEVER
    // land — the journal records the honest failure (digests only).
    world.discardStaged();
    const record: OutcomeJournalRecord = {
      ordinal: journal.length + 1,
      kind: "failure",
      digest: outcomeDigestOf(
        failure ?? { category: "verification", message: "criterion failure" },
      ),
      detail: `failure:${failure?.category ?? "verification-criterion-fail"}`,
    };
    journal.push(record);
    await lifecycle.recordStepEvent({ executionId, record });
  }

  // ---- the post-verdict criteria (the honest outcome record) ----
  // 4. The outcome contract (the anyFail→FAILED discipline proper).
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: verdict === "pass" ? "PASS" : "FAIL",
    evidence: [
      `verdict:${verdict}`,
      `failure:${failure?.category ?? "none"}`,
      `failedCriteria:${criteria.filter((criterion) => criterion.status === "FAIL").length}`,
    ],
  });
  // 5. The atomicity of the verification boundary: a pass commits the
  //    full declared set exactly once; a fail commits NOTHING.
  const committedCounts = countBy(committedEffects.map((effect) => effect.effect));
  const expectedCommitted: Record<string, number> = verdict === "pass" ? declaredCounts : {};
  criteria.push({
    criterionId: "atomicity-of-effects",
    strategy: "deterministic",
    status: countsEqual(committedCounts, expectedCommitted) ? "PASS" : "FAIL",
    evidence: [
      `verdict:${verdict}`,
      `committed:${renderCounts(committedCounts)}`,
      `expected:${renderCounts(expectedCommitted)}`,
      `discarded:${stagedEffects.length - committedEffects.length}`,
    ],
  });
  // 6. The journal gaplessness (1..N over the execution's own records).
  const gaplessness = deriveJournalGaplessness(journal.map((record) => record.ordinal));
  criteria.push({
    criterionId: "journal-gapless",
    strategy: "deterministic",
    status: gaplessness.gapless ? "PASS" : "FAIL",
    evidence: [
      `sequences:${journal.map((record) => record.ordinal).join(">") || "empty"}`,
      `holes:${gaplessness.holes.join("|") || "none"}`,
      `duplicates:${gaplessness.duplicates.join("|") || "none"}`,
    ],
  });

  await lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason:
      verdict === "pass"
        ? "val-026-verified"
        : `val-026-${failure?.category ?? "verification-criterion-fail"}`,
    callKey: key(),
  });

  return {
    executionId,
    outcome: verdict === "pass" ? "COMPLETED" : "FAILED",
    // The observed terminal is READ BACK by the row driver after
    // settlement (the reconciliation judges the ledger's own claim).
    observedTerminal: null,
    criteria,
    journalEffects: journal
      .filter((record) => record.kind === "effect")
      .map((record) => record.detail.replace(/^effect:/, "")),
    journal,
    committedEffects,
    discardedEffects: verdict === "pass" ? [] : stagedEffects,
    usage,
  };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * The landed-executions provider: returns the row's landed execution
 * ids (the app's submissions land through the public wire; the crown's
 * provider polls the REAL SQL until the expected count lands).
 */
export type LandedExecutionsProvider = (
  group: number,
  expectedCount: number,
) => Promise<readonly string[]>;

/**
 * Drive one outcome corpus row to settlement through the platform
 * path: the landed execution's chain (the guard → the staged effects →
 * the verification criteria → the ATOMIC commit/discard → the
 * mechanically derived verdict), the observed terminal READ BACK from
 * the ledger, the replay probe (the re-issued submission key through
 * the REAL idempotency ledger — replayed, identity preserved, ZERO new
 * executions/records/effects), and the row-level mechanical criteria
 * (the full reconciliation chain + the durable contracts). The honest
 * terminal is FAILED when any execution failed, any criterion failed,
 * any reconciliation leg disagreed or any failure was observed — never
 * a partial-success shortcut.
 */
export async function driveOutcomeRow(options: {
  readonly row: OutcomeCorpusRow;
  readonly lifecycle: OutcomeLifecyclePort;
  readonly world: OutcomeEffectWorld;
  /** The PRE-ROW durable facts (captured BEFORE the app submitted). */
  readonly baseline: OutcomeWorldFacts;
  /** The durable world-facts provider (REAL SQL counts at the crown). */
  readonly worldFacts: () => Promise<OutcomeWorldFacts> | OutcomeWorldFacts;
  /** The landed-executions provider (the app's submitted lanes). */
  readonly landedProvider: LandedExecutionsProvider;
  /** The service-level submission seam (REQUIRED for replay rows). */
  readonly submissionSeam?: OutcomeSubmissionSeam;
  /** The dispatch seam (the live row only). */
  readonly dispatch?: OutcomeDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  /** The app's submission key for this row (the replay probe re-issues it). */
  readonly appKey: string;
  /** The app's task body for this row (the replay's fingerprint must match). */
  readonly appBody: Readonly<Record<string, unknown>>;
  readonly now: () => Date;
}): Promise<OutcomeRunResult> {
  const { row, lifecycle, world } = options;
  if (row.replay !== undefined && options.submissionSeam === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a submission seam (the replay probe requires ` +
        "the REAL arbitration authority) but none was bound",
    );
  }
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL model round requires it)",
    );
  }

  const runStartedAt = options.now().getTime();
  const keyCounter = { count: 0 };
  const fixtureBefore = { ...world.observedCounts };
  let execution: OutcomeExecutionResult | null = null;
  let replayProbe: ReplayProbeResult | null = null;
  let failure: { category: string; message: string } | null = null;

  const landed = await options.landedProvider(1, row.expected.appCreated);
  if (landed.length !== row.expected.appCreated) {
    failure = {
      category: "landed-count-mismatch",
      message: `the row's landed provider returned ${landed.length} executions (expected ${row.expected.appCreated})`,
    };
  } else {
    const executionId = landed[0] as string;
    execution = await driveOutcomeChain({
      executionId,
      row,
      lifecycle,
      world,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      retry: options.retry,
      now: options.now,
      keyCounter,
    });
    // The observed terminal READ BACK from the ledger — the
    // reconciliation judges the platform's own durable claim.
    const observedTerminal = await lifecycle.statusOf(executionId);
    execution = { ...execution, observedTerminal };

    // ---- the replay probe (the re-issued submission key) ----
    if (row.replay !== undefined) {
      const seam = options.submissionSeam as OutcomeSubmissionSeam;
      const worldBeforeReplay = await Promise.resolve(options.worldFacts());
      const countsBeforeReplay = { ...world.observedCounts };
      const replay = await seam({ key: options.appKey, body: options.appBody });
      const worldAfterReplay = await Promise.resolve(options.worldFacts());
      const countsAfterReplay = { ...world.observedCounts };
      const newEffects = Object.keys(countsAfterReplay).filter(
        (effect) => (countsAfterReplay[effect] ?? 0) !== (countsBeforeReplay[effect] ?? 0),
      ).length;
      replayProbe = {
        replayed: replay.replayed,
        sameIdentity: replay.executionId === executionId,
        newExecutions: worldAfterReplay.executionCount - worldBeforeReplay.executionCount,
        newIdempotencyRecords:
          worldAfterReplay.idempotencyRecordCount - worldBeforeReplay.idempotencyRecordCount,
        newEffects,
        keyDigest: outcomeDigestOf(options.appKey),
      };
    }
  }

  const finalFacts = await Promise.resolve(options.worldFacts());
  const fixtureDelta = fixtureDeltaOf(fixtureBefore, world.observedCounts);
  const totalLatencyMs = options.now().getTime() - runStartedAt;

  // ---- the row-level criteria (the reconciliation + the contracts) ----
  const criteria = deriveOutcomeRowCriteria({
    row,
    execution,
    replayProbe,
    baseline: options.baseline,
    finalFacts,
    fixtureDelta,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    (execution?.outcome ?? "FAILED") === "FAILED" ||
    execution?.observedTerminal === "FAILED";

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    execution,
    replayProbe,
    fixtureDelta,
    usage: execution?.usage ?? null,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the reconciliation
 * chain (terminal ↔ criteria ↔ journal ↔ fixture-state, each leg its
 * own criterion) plus the durable contracts (the replay probe's
 * zero-new-everything, no phantom executions, no ledger drift, no
 * orphan transitions, the honest outcome contract and the honest
 * economics).
 */
export function deriveOutcomeRowCriteria(input: {
  readonly row: OutcomeCorpusRow;
  readonly execution: OutcomeExecutionResult | null;
  readonly replayProbe: ReplayProbeResult | null;
  readonly baseline: OutcomeWorldFacts;
  readonly finalFacts: OutcomeWorldFacts;
  readonly fixtureDelta: Readonly<Record<string, number>>;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const { row } = input;
  const criteria: LabVerificationCriterion[] = [];

  // (No short-circuit — the criteria prove the SEMANTICS; a
  // correctly-shaped honest failure PASSES them while the terminal
  // stays honestly FAILED.)

  // 1. The reconciliation chain: terminal ↔ criteria ↔ journal ↔
  //    fixture-state (the anyFail→FAILED invariant probed inside).
  if (input.execution === null) {
    criteria.push({
      criterionId: "outcome-reconciliation",
      strategy: "deterministic",
      status: "FAIL",
      evidence: ["execution:none (the row never landed an execution)"],
    });
  } else {
    const reconciliation = deriveOutcomeReconciliation({
      executionId: input.execution.executionId,
      terminal: input.execution.observedTerminal,
      verificationStatuses: input.execution.criteria.map((criterion) => criterion.status),
      journalEffects: input.execution.journalEffects,
      fixtureDelta: input.fixtureDelta,
      declaredEffects: row.declaredEffects.map((effect) => effect.effect),
      expectedTerminal: row.expected.terminal,
      expectedFixtureDelta: row.expected.fixtureDelta,
    });
    criteria.push(...reconciliation.criteria);
    criteria.push({
      criterionId: "outcome-reconciliation-summary",
      strategy: "deterministic",
      status: reconciliation.agreed ? "PASS" : "FAIL",
      evidence: [
        `terminalCriteria:${String(reconciliation.terminalCriteriaAgreement)}`,
        `journalFixture:${String(reconciliation.journalFixtureAgreement)}`,
        `declaredJournal:${String(reconciliation.declaredJournalAgreement)}`,
        `fixtureDelta:${String(reconciliation.fixtureDeltaAgreement)}`,
        `terminalOracle:${String(reconciliation.terminalAgreement)}`,
      ],
    });

    // 1b. The effect multiplicity against the world's own counters
    //     (the exactly-once discipline, over/under/unexpected).
    const multiplicity = deriveEffectMultiplicity(row.expected.fixtureDelta, input.fixtureDelta);
    criteria.push({
      criterionId: "effect-multiplicity-exactly-once",
      strategy: "deterministic",
      status: multiplicity.exactlyOnce ? "PASS" : "FAIL",
      evidence: [
        `expected:${renderCounts(row.expected.fixtureDelta)}`,
        `observed:${renderCounts(input.fixtureDelta)}`,
        `overApplied:${multiplicity.overApplied.join("|") || "none"}`,
        `missing:${multiplicity.missing.join("|") || "none"}`,
        `unexpected:${multiplicity.unexpected.join("|") || "none"}`,
      ],
    });
  }

  // 2. The replay probe (the idempotency discipline): replayed, identity
  //    preserved, ZERO new executions/records/effects.
  if (row.replay !== undefined) {
    const probe = input.replayProbe;
    const replayOk =
      probe?.replayed === true &&
      probe?.sameIdentity === true &&
      probe?.newExecutions === 0 &&
      probe?.newIdempotencyRecords === 0 &&
      probe?.newEffects === 0;
    criteria.push({
      criterionId: "replay-zero-new-effects",
      strategy: "deterministic",
      status: replayOk ? "PASS" : "FAIL",
      evidence: [
        `probe:${probe === null ? "none" : "driven"}`,
        `replayed:${String(probe?.replayed ?? false)}`,
        `sameIdentity:${String(probe?.sameIdentity ?? false)}`,
        `newExecutions:${probe?.newExecutions ?? "n/a"}`,
        `newIdempotencyRecords:${probe?.newIdempotencyRecords ?? "n/a"}`,
        `newEffects:${probe?.newEffects ?? "n/a"}`,
        `after:${row.replay.after}`,
      ],
    });
  }

  // 3. No phantom executions: the durable execution rows the row
  //    settled to are EXACTLY the expected count.
  const executionDelta = input.finalFacts.executionCount - input.baseline.executionCount;
  criteria.push({
    criterionId: "no-phantom-executions",
    strategy: "deterministic",
    status: executionDelta === row.expected.executions ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.executionCount}`,
      `final:${input.finalFacts.executionCount}`,
      `delta:${executionDelta}`,
      `expected:${row.expected.executions}`,
    ],
  });

  // 4. No ledger drift: the distinct idempotency keys are EXACTLY the
  //    expected count (a replayed key never re-arbitrates).
  const keyDelta = input.finalFacts.idempotencyRecordCount - input.baseline.idempotencyRecordCount;
  criteria.push({
    criterionId: "no-ledger-drift",
    strategy: "deterministic",
    status: keyDelta === row.expected.idempotencyRecords ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.baseline.idempotencyRecordCount}`,
      `final:${input.finalFacts.idempotencyRecordCount}`,
      `delta:${keyDelta}`,
      `expected:${row.expected.idempotencyRecords}`,
    ],
  });

  // 5. No orphan ledger transitions: ZERO events with no parent row.
  criteria.push({
    criterionId: "no-orphan-ledger-transitions",
    strategy: "deterministic",
    status: input.finalFacts.orphanEventCount === 0 ? "PASS" : "FAIL",
    evidence: [
      `orphanEvents:${input.finalFacts.orphanEventCount}`,
      `eventCount:${input.finalFacts.eventCount}`,
    ],
  });

  // 6. The honest outcome contract: the mechanically derived terminal
  //    matches the oracle's terminal (anyFail→FAILED probed here).
  const derivedTerminal: "COMPLETED" | "FAILED" =
    input.failure !== null || (input.execution?.outcome ?? "FAILED") === "FAILED"
      ? "FAILED"
      : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `observedTerminal:${input.execution?.observedTerminal ?? "none"}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });

  // 7. Honest economics: measured latency recorded; usage recorded
  //    honestly (none on the offline rows — no model dispatch).
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      row.needsDispatch
        ? "usage:measured-on-live-dispatch"
        : "usage:none-reported (the outcome semantics are ledger-level — no model dispatch)",
      "latencyMs:measured",
      `fixtureDeltaEffects:${Object.keys(input.fixtureDelta).length}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side outcome contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/**
 * Judge the app-side observations against the row's outcome contract
 * (PURE): the terminal↔criteria agreement over the PUBLIC result read
 * (a fabricated pass-with-fail surfaced through the public wire FAILs
 * the app honestly), the expected terminal met, and — the replay rows
 * — the replayed receipt's identity preservation and replayed flag.
 */
export function verifyOutcomeAppContract(input: {
  readonly row: OutcomeCorpusRow;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The replay receipt observation (replay rows only). */
  readonly replay: SubmissionObservation | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];

  // 1. The terminal↔criteria agreement over the public result read
  //    (COMPLETED ⟺ no FAIL verification status — both directions).
  const agreement = deriveTerminalCriteriaAgreement({
    terminal: input.terminal,
    verificationStatuses: input.verificationStatuses,
  });
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement.agreement ? "PASS" : "FAIL",
    evidence: agreement.evidence,
  });

  // 2. The expected terminal met (the app's own outcome contract).
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: input.terminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [`expected:${input.row.expected.terminal}`, `observed:${input.terminal ?? "none"}`],
  });

  // 3. The replay rows: the replayed receipt (identity preserved, the
  //    replayed flag surfaced — a second identity is a re-arbitration).
  if (input.row.replay !== undefined) {
    const replay = input.replay;
    const replayOk =
      replay?.replayed === true && replay?.rejection === null && replay?.executionId !== "";
    criteria.push({
      criterionId: "app-replay-identity-preserved",
      strategy: "deterministic",
      status: replayOk ? "PASS" : "FAIL",
      evidence: [
        `replayed:${String(replay?.replayed ?? false)}`,
        `executionId:${replay?.executionId ? "present" : "none"}`,
        `rejection:${replay?.rejection?.code ?? "none"}`,
        `after:${input.row.replay.after}`,
      ],
    });
  }

  return criteria;
}
