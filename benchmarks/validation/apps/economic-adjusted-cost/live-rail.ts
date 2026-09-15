/**
 * The VAL-044 live-rail seam (the live-review lane repair): the REAL
 * dispatch executor binding for the three control arms' LIVE corpus
 * rows — the seam the live synthesis row was declared against
 * (`needsDispatch: true`) but never had (the Task-78/79 live-review
 * finding: the live row's arm references carried DECLARATION digests
 * while the input-integrity oracle re-derived RECORDED digests over
 * the live arm rows' empty placeholder traces — DIGEST-DISAGREED ×3,
 * pre-dispatch, deterministic).
 *
 * THE SEAM (mirroring the VAL-041/042/043 live rows' own dispatch
 * bindings): each arm's live corpus row is driven over the
 * operator-authorized OpenRouter text rail — the pinned model
 * meta-llama/llama-3.3-70b-instruct, max_tokens 64 pinned explicitly,
 * every arm priced at its own pinned manifest revision (rev-001,
 * USD per-1M metered) — and the MEASURED traces (per-attempt usage,
 * latency, outcome, the settling response) are RECORDED into the arm
 * corpora's live rows: the live arm rows' replay entries ARE the
 * record, exactly the shape the arms' offline corpora hold. After the
 * recording, the arm references re-derive through the corpus's own
 * `armReferenceOf` (RECORDED digests over the MEASURED facts) and the
 * synthesis driver's input-integrity oracle re-derives the SAME facts
 * from the SAME records — digest-verified, field-identical, never a
 * re-measurement masquerade.
 *
 * Honesty contracts (mechanical, never bent):
 *   - the three arms' request characters mirror their own live rows'
 *     dispatch bindings (VAL-041 direct: the plain confirm prompt,
 *     temperature UNSET; VAL-042 optimized: the COMPRESSED prompt on
 *     the routed pinned rail at temperature 0 with the verbose payload
 *     as the compression bound's raw baseline, plus the driver's own
 *     semantically-safe response cache — a cacheable round replays
 *     the stored REAL response with no second dispatch, a fresh-only
 *     collision dispatches; VAL-043 competing: the aggregate interface
 *     — one request per round, the reported usage the aggregate);
 *   - the client-side bounded retry mirrors the arm drivers (RETRYABLE
 *     categories only — transport-failure / rate-limit /
 *     provider-unavailable — up to two extra attempts with the
 *     live pacing backoff; every attempt, failed or settled, is
 *     recorded as its own trace fact);
 *   - a provider success that does not confirm is a supervisor-halt
 *     FAILURE (the arm dispatch bindings' own contract — the honest
 *     unresolved round, never a fabricated confirmation);
 *   - the recording REFUSES a second drive (a live slice is measured
 *     ONCE per process — double-driving would conflate records) and
 *     touches ONLY live rows that declare `needsDispatch: true`;
 *   - digest-only discipline everywhere (no payload bytes journaled
 *     beyond the settling confirmation word the offline traces
 *     themselves hold); no credential ever enters any record.
 *
 * The total live cost of one recording is tiny by construction: at
 * most 11 fresh requests (4 direct + 3 optimized fresh dispatches —
 * the fourth optimized round is the cache hit — + 4 competing), each
 * a ~64-token completion on the pinned per-1M metered rail — well
 * under $0.01 even with every retry boundary exhausted.
 */

import { isRetryableDispatchCategory } from "../economic-baseline/driver";
import {
  competitorConfigFor,
  routeForClass as competitorRouteForClass,
} from "../economic-controls-competing/competitor-config";
import { COMPETING_CORPUS } from "../economic-controls-competing/corpus";
import type {
  CompetingCorpusRow,
  CompetitorTraceRound,
} from "../economic-controls-competing/driver";
import { DIRECT_CORPUS } from "../economic-controls-direct/corpus";
import type { DirectCorpusRow, DirectTraceRound } from "../economic-controls-direct/driver";
import { OPTIMIZED_CORPUS } from "../economic-controls-optimized/corpus";
import type {
  OptimizedCorpusRow,
  OptimizedRecordedRound,
} from "../economic-controls-optimized/driver";
import { inventoryFor, routeForClass } from "../economic-controls-optimized/optimizations";
import { armReferenceOf, honestInputsOf, LIVE_CORPUS_ROWS } from "./corpus";
import type { ArmInputReference, ArmLabel, RecordedArmInput } from "./driver";
import { recordedArmFactsOf } from "./driver";

// ---------------------------------------------------------------------------
// The dispatch seam (the raw rail completion — INJECTED by the test)
// ---------------------------------------------------------------------------

/** One raw rail completion request (the pinned rail's own shape). */
export interface LiveRailCompletionRequest {
  readonly model: string;
  readonly maxTokens: number;
  /** UNSET (absent) = the provider's documented default applies. */
  readonly temperature?: number;
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
}

/** One raw rail completion result (the provider's own report). */
export interface LiveRailCompletionResult {
  readonly kind: "success" | "failure";
  readonly content?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** The provider's OWN reported charge (a cross-check observation, never the basis). */
    readonly costUsd?: number;
  };
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
}

/** The raw dispatch seam: one REAL provider request per call (BYOK). */
export type LiveRailDispatch = (
  request: LiveRailCompletionRequest,
) => Promise<LiveRailCompletionResult>;

// ---------------------------------------------------------------------------
// The arm request characters (the 041/042/043 live dispatch bindings' own)
// ---------------------------------------------------------------------------

/** The DIRECT arm's request preamble (the VAL-041 live binding's own). */
const DIRECT_SYSTEM = [
  "You are the settlement confirmation supervisor for the direct-provider experiment round.",
  "Decide and answer with the single word: confirm",
].join(" ");

/** The OPTIMIZED arm's COMPRESSED preamble (the VAL-042 live binding's own). */
const COMPACT_SYSTEM = [
  "You are the settlement confirmation supervisor for the optimized baseline experiment round.",
  "Decide and answer with the single word: confirm",
].join(" ");

/** The OPTIMIZED arm's UNCOMPRESSED baseline (the compression bound's raw payload). */
const VERBOSE_SYSTEM = [
  "You are the settlement confirmation supervisor of a strongly optimized non-Zeck baseline validation",
  "experiment running against the governed economic validation program of the platform. At each round",
  "boundary you receive the committed round progress of the optimized baseline stack together with the",
  "routed content identity of the settlement document, and you must decide whether the round's settlement",
  "should be confirmed for the accounting rails. Answer with the single word: confirm",
].join(" ");

/** The COMPETING arm's request preamble (the VAL-043 live binding's own). */
const COMPETITOR_SYSTEM = [
  "You are the settlement confirmation supervisor for the competing-stack experiment round.",
  "Decide and answer with the single word: confirm",
].join(" ");

/** The pinned completion budget every arm's live dispatch carries (the 402 lesson). */
const MAX_TOKENS = 64;

// ---------------------------------------------------------------------------
// The measured-attempt observations (the recording's working shape)
// ---------------------------------------------------------------------------

/** One observed dispatch attempt (the pre-recording shape). */
interface ObservedAttempt {
  readonly outcome: "success" | "failure";
  readonly category?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly content?: string;
  readonly costUsd?: number;
  readonly latencyMs: number;
}

/**
 * The bounded client-side request loop (the arm drivers' own): one
 * attempt per call, retried on RETRYABLE categories only up to the
 * declared extra attempts with the live backoff; a provider success
 * that does not confirm is a NON-retryable supervisor-halt failure
 * (the live dispatch bindings' own contract).
 */
async function dispatchWithBoundedRetry(options: {
  readonly dispatch: LiveRailDispatch;
  readonly request: LiveRailCompletionRequest;
  readonly maxExtraAttempts: number;
  readonly backoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<readonly ObservedAttempt[]> {
  const attempts: ObservedAttempt[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await options.dispatch(options.request);
    if (outcome.kind === "success" && /confirm/i.test(outcome.content ?? "")) {
      attempts.push({
        outcome: "success",
        ...(outcome.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
              },
            }),
        ...(outcome.content === undefined ? {} : { content: outcome.content }),
        ...(outcome.usage?.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
        latencyMs: outcome.latencyMs,
      });
      break;
    }
    const category =
      outcome.kind === "success" ? "supervisor-halt" : (outcome.category ?? "provider-failure");
    attempts.push({
      outcome: "failure",
      category,
      ...(outcome.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
            },
          }),
      ...(outcome.usage?.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
      latencyMs: outcome.latencyMs,
    });
    if (!isRetryableDispatchCategory(category) || attempt > options.maxExtraAttempts) {
      break;
    }
    await options.sleep(options.backoffMs);
  }
  return attempts;
}

// ---------------------------------------------------------------------------
// The trace-recording seams (the live arm rows' replay entries ARE the record)
// ---------------------------------------------------------------------------

/** The mutable view of one direct trace entry (the live record's write seam). */
type WritableDirectTraceRound = {
  readonly taskId: string;
  recorded?: DirectTraceRound["recorded"];
};

/** Record one measured direct round into its live corpus trace (ONCE). */
function recordDirectTrace(
  row: DirectCorpusRow,
  taskId: string,
  recorded: NonNullable<DirectTraceRound["recorded"]>,
): void {
  const entry = row.directReplay.find((plan) => plan.taskId === taskId) as
    | WritableDirectTraceRound
    | undefined;
  if (entry === undefined) {
    throw new Error(`the direct live row ${row.rowId} declares no trace plan for ${taskId}`);
  }
  if (entry.recorded !== undefined) {
    throw new Error(
      `the direct live trace ${row.rowId}/${taskId} already holds a record (a live slice is measured once)`,
    );
  }
  entry.recorded = recorded;
}

/** The mutable view of one optimized round plan (the live record's write seam). */
type WritableOptimizedRecordedRound = {
  readonly taskId: string;
  recorded?: OptimizedRecordedRound["recorded"];
};

/** Record one measured optimized fresh dispatch into its live plan (ONCE). */
function recordOptimizedTrace(
  row: OptimizedCorpusRow,
  taskId: string,
  recorded: NonNullable<OptimizedRecordedRound["recorded"]>,
): void {
  const entry = row.optimizedReplay.find((plan) => plan.taskId === taskId) as
    | WritableOptimizedRecordedRound
    | undefined;
  if (entry === undefined) {
    throw new Error(`the optimized live row ${row.rowId} declares no round plan for ${taskId}`);
  }
  if (entry.recorded !== undefined) {
    throw new Error(
      `the optimized live plan ${row.rowId}/${taskId} already holds a record (a live slice is measured once)`,
    );
  }
  entry.recorded = recorded;
}

/** The mutable view of one competing trace entry (the live record's write seam). */
type WritableCompetitorTraceRound = {
  readonly taskId: string;
  recorded?: CompetitorTraceRound["recorded"];
};

/** Record one measured competing request into its live corpus trace (ONCE). */
function recordCompetingTrace(
  row: CompetingCorpusRow,
  taskId: string,
  recorded: NonNullable<CompetitorTraceRound["recorded"]>,
): void {
  const entry = row.competingReplay.find((plan) => plan.taskId === taskId) as
    | WritableCompetitorTraceRound
    | undefined;
  if (entry === undefined) {
    throw new Error(`the competing live row ${row.rowId} declares no trace plan for ${taskId}`);
  }
  if (entry.recorded !== undefined) {
    throw new Error(
      `the competing live trace ${row.rowId}/${taskId} already holds a record (a live slice is measured once)`,
    );
  }
  entry.recorded = recorded;
}

/** The settling attempt of one recorded attempt sequence (undefined on none). */
function settledAttemptOf(attempts: readonly ObservedAttempt[]): ObservedAttempt | undefined {
  return attempts[attempts.length - 1];
}

/** The trace-shaped attempts of one observed attempt sequence. */
function traceAttemptsOf(attempts: readonly ObservedAttempt[]): readonly {
  outcome: "success" | "failure";
  category?: string;
  usage?: { readonly inputTokens: number; readonly outputTokens: number };
  latencyMs: number;
}[] {
  return attempts.map((attempt) => ({
    outcome: attempt.outcome,
    ...(attempt.category === undefined ? {} : { category: attempt.category }),
    ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
    latencyMs: attempt.latencyMs,
  }));
}

// ---------------------------------------------------------------------------
// The live-arm driving + recording (the repair's core)
// ---------------------------------------------------------------------------

/** One arm's driving statistics (the honest per-arm summary). */
interface ArmDrivingStats {
  readonly dispatched: number;
  readonly recordedRounds: number;
  readonly cacheHits: number;
  readonly wallclockMs: number;
}

/** One arm's measured record (the honest summary the console reports). */
export interface LiveArmMeasuredRecord {
  readonly armLabel: ArmLabel;
  readonly corpusRowId: string;
  /** The REAL fresh requests dispatched for the arm (cache hits excluded). */
  readonly dispatchedRequests: number;
  /** The semantically-safe cache hits served (the optimized arm only). */
  readonly cacheHits: number;
  /** The rounds a measured trace was recorded for. */
  readonly recordedRounds: number;
  /** The re-derived RECORDED facts (the same derivation the oracle runs). */
  readonly runCount: number;
  readonly resolvedCount: number;
  readonly measuredCostMicroUsd: string;
  /** The RECORDED digest over the measured facts (the reference the synthesis carries). */
  readonly recordedDigest: string;
  /** The arm's driving wallclock (ms). */
  readonly latencyMs: number;
}

/** The full live-arms recording (the synthesis row's measured input basis). */
export interface LiveArmsRecording {
  readonly arms: readonly LiveArmMeasuredRecord[];
  /** The arm references re-derived over the MEASURED traces (RECORDED digests). */
  readonly references: readonly ArmInputReference[];
  /** The synthesis input bundles (the driver's input-integrity oracle verifies these). */
  readonly inputs: readonly RecordedArmInput[];
  readonly totalDispatches: number;
  readonly totalMeasuredMicroUsd: string;
  readonly totalLatencyMs: number;
}

/** Resolve the live synthesis row (the corpus's single live declaration). */
function liveSynthesisRow(): (typeof LIVE_CORPUS_ROWS)[number] {
  const row = LIVE_CORPUS_ROWS[0];
  if (row === undefined || !row.needsDispatch) {
    throw new Error("the adjusted-cost corpus declares no dispatch-needing live synthesis row");
  }
  return row;
}

/** The live arm corpus row ids, in the live row's pre-registered arm-set order. */
function liveArmRowIds(): readonly { readonly armLabel: ArmLabel; readonly corpusRowId: string }[] {
  return liveSynthesisRow().armSet.map((reference) => ({
    armLabel: reference.armLabel,
    corpusRowId: reference.corpusRowId,
  }));
}

/** Drive the DIRECT arm's live slice over the rail and record the measured traces. */
async function driveDirectArm(options: {
  readonly dispatch: LiveRailDispatch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly row: DirectCorpusRow;
  readonly maxExtraAttempts: number;
  readonly backoffMs: number;
  readonly paceMs: number;
}): Promise<ArmDrivingStats> {
  if (!options.row.needsDispatch) {
    throw new Error(`the direct row ${options.row.rowId} does not declare a live dispatch gate`);
  }
  const startedAt = Date.now();
  let dispatched = 0;
  let recordedRounds = 0;
  for (const [index, taskId] of options.row.arm.corpusSlice.entries()) {
    if (index > 0) {
      await options.sleep(options.paceMs);
    }
    dispatched += 1;
    const attempts = await dispatchWithBoundedRetry({
      dispatch: options.dispatch,
      // temperature UNSET — the direct provider's documented default
      // (the VAL-041 live binding's own posture).
      request: {
        model: options.row.arm.model,
        maxTokens: MAX_TOKENS,
        messages: [
          { role: "system", content: DIRECT_SYSTEM },
          {
            role: "user",
            content: `Round ${taskId} of the direct-provider control experiment (the direct rail dispatch, attempt 1). Confirm the settlement round.`,
          },
        ],
      },
      maxExtraAttempts: options.maxExtraAttempts,
      backoffMs: options.backoffMs,
      sleep: options.sleep,
    });
    const settled = settledAttemptOf(attempts);
    recordDirectTrace(options.row, taskId, {
      attempts: traceAttemptsOf(attempts),
      ...(settled?.outcome === "success" && settled.content !== undefined
        ? { responseText: settled.content }
        : {}),
      ...(settled?.costUsd === undefined ? {} : { reportedChargeUsd: settled.costUsd }),
    });
    recordedRounds += 1;
  }
  return { dispatched, recordedRounds, cacheHits: 0, wallclockMs: Date.now() - startedAt };
}

/** Drive the OPTIMIZED arm's live slice over the rail (routed + compressed + cached). */
async function driveOptimizedArm(options: {
  readonly dispatch: LiveRailDispatch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly row: OptimizedCorpusRow;
  readonly maxExtraAttempts: number;
  readonly backoffMs: number;
  readonly paceMs: number;
}): Promise<ArmDrivingStats> {
  if (!options.row.needsDispatch) {
    throw new Error(`the optimized row ${options.row.rowId} does not declare a live dispatch gate`);
  }
  const startedAt = Date.now();
  const inventory = inventoryFor(options.row.optimizationInventoryRevision);
  // The driver's own semantically-safe response cache (the VAL-042
  // component's exact semantics: successful CACHEABLE rounds only).
  const stored = new Map<string, string>();
  let dispatched = 0;
  let recordedRounds = 0;
  let cacheHits = 0;
  let firstFreshRound = true;
  for (const taskId of options.row.arm.corpusSlice) {
    const plan = options.row.optimizedReplay.find((candidate) => candidate.taskId === taskId);
    if (plan === undefined) {
      throw new Error(
        `the optimized live row ${options.row.rowId} declares no round plan for ${taskId}`,
      );
    }
    const key = `${plan.taskClass}:${plan.contentDigest}`;
    const cached = stored.get(key);
    if (plan.cachePolicy === "cacheable" && cached !== undefined) {
      // The REAL cache hit: the stored REAL response replays with no
      // second dispatch and no second charge — the extractor re-derives
      // the hit from the storing round's own record.
      cacheHits += 1;
      continue;
    }
    if (!firstFreshRound) {
      await options.sleep(options.paceMs);
    }
    firstFreshRound = false;
    const route = routeForClass(inventory, plan.taskClass);
    dispatched += 1;
    // The COMPRESSED prompt (what the optimized stack sends) and the
    // VERBOSE baseline (what it would have sent uncompressed — the
    // raw token count for the compression bound's denominator).
    const compactUser = `Round ${taskId} of the optimized baseline experiment (content identity ${plan.contentDigest}, attempt 1). Confirm the settlement round.`;
    const verboseUser = `This is round ${taskId} of the strongly optimized non-Zeck baseline experiment (the dispatch attempt number 1, the routed content identity ${plan.contentDigest} of the settlement document). Please confirm the settlement round now for the accounting rails.`;
    const attempts = await dispatchWithBoundedRetry({
      dispatch: options.dispatch,
      request: {
        model: route.model,
        maxTokens: MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: COMPACT_SYSTEM },
          { role: "user", content: compactUser },
        ],
      },
      maxExtraAttempts: options.maxExtraAttempts,
      backoffMs: options.backoffMs,
      sleep: options.sleep,
    });
    const settled = settledAttemptOf(attempts);
    recordOptimizedTrace(options.row, taskId, {
      attempts: traceAttemptsOf(attempts),
      rawInputTokens: Math.ceil((VERBOSE_SYSTEM.length + verboseUser.length) / 4),
      ...(settled?.outcome === "success" && settled.content !== undefined
        ? { responseText: settled.content }
        : {}),
    });
    recordedRounds += 1;
    if (
      settled?.outcome === "success" &&
      settled.content !== undefined &&
      plan.cachePolicy === "cacheable"
    ) {
      stored.set(key, settled.content);
    }
  }
  return { dispatched, recordedRounds, cacheHits, wallclockMs: Date.now() - startedAt };
}

/** Drive the COMPETING arm's live slice over the rail (the aggregate interface). */
async function driveCompetingArm(options: {
  readonly dispatch: LiveRailDispatch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly row: CompetingCorpusRow;
  readonly maxExtraAttempts: number;
  readonly backoffMs: number;
  readonly paceMs: number;
}): Promise<ArmDrivingStats> {
  if (!options.row.needsDispatch) {
    throw new Error(`the competing row ${options.row.rowId} does not declare a live dispatch gate`);
  }
  const startedAt = Date.now();
  const config = competitorConfigFor(options.row.competitorConfigRevision);
  let dispatched = 0;
  let recordedRounds = 0;
  for (const [index, taskId] of options.row.arm.corpusSlice.entries()) {
    const plan = options.row.competingReplay.find((candidate) => candidate.taskId === taskId);
    if (plan === undefined) {
      throw new Error(
        `the competing live row ${options.row.rowId} declares no trace plan for ${taskId}`,
      );
    }
    if (index > 0) {
      await options.sleep(options.paceMs);
    }
    const route = competitorRouteForClass(config, plan.taskClass);
    dispatched += 1;
    const attempts = await dispatchWithBoundedRetry({
      dispatch: options.dispatch,
      // temperature UNSET — the competitor's documented default (the
      // VAL-043 live binding's own posture).
      request: {
        model: route.model,
        maxTokens: MAX_TOKENS,
        messages: [
          { role: "system", content: COMPETITOR_SYSTEM },
          {
            role: "user",
            content: `Round ${taskId} of the competing-stack experiment (the competing gateway dispatch, attempt 1). Confirm the settlement round.`,
          },
        ],
      },
      maxExtraAttempts: options.maxExtraAttempts,
      backoffMs: options.backoffMs,
      sleep: options.sleep,
    });
    const settled = settledAttemptOf(attempts);
    // The competing interface granularity: ONE aggregate measured pair
    // per request (the client-side bounded retries amortize INSIDE the
    // round's aggregate — the interface's own honest granularity).
    const reportedUsage = attempts.reduce(
      (sum, attempt) => ({
        inputTokens: sum.inputTokens + (attempt.usage?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (attempt.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    const reportedChargeUsd = attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
    recordCompetingTrace(options.row, taskId, {
      internalAttempts: traceAttemptsOf(attempts),
      reportedUsage,
      ...(reportedChargeUsd > 0 ? { reportedChargeUsd: reportedChargeUsd } : {}),
      ...(settled?.outcome === "success" && settled.content !== undefined
        ? { responseText: settled.content }
        : {}),
    });
    recordedRounds += 1;
  }
  return { dispatched, recordedRounds, cacheHits: 0, wallclockMs: Date.now() - startedAt };
}

/**
 * Drive the three arms' live corpus rows over the operator-authorized
 * rail and RECORD the measured traces (the repair's core): every arm's
 * slice dispatches REAL bounded requests on its pinned rail, the
 * measured per-attempt facts land in the arm corpora's live rows (the
 * record), and the arm references re-derive over the MEASURED facts
 * (RECORDED digests — the input-integrity oracle re-derives the same
 * facts from the same records at synthesis time). The returned input
 * bundles are what the live synthesis row consumes; the verdict stays
 * mechanically derived over whatever was actually measured.
 */
export async function driveLiveArmsAndRecord(options: {
  readonly dispatch: LiveRailDispatch;
  readonly sleep: (ms: number) => Promise<void>;
  /** The pacing between fresh requests (default 250ms). */
  readonly paceMs?: number;
  /** The bounded retry's extra attempts (default 2 — the arm drivers' own). */
  readonly maxExtraAttempts?: number;
  /** The bounded retry's backoff (default 4000ms — the live rows' own). */
  readonly backoffMs?: number;
}): Promise<LiveArmsRecording> {
  const paceMs = options.paceMs ?? 250;
  const maxExtraAttempts = options.maxExtraAttempts ?? 2;
  const backoffMs = options.backoffMs ?? 4_000;
  const armIds = liveArmRowIds();
  const directId = armIds.find((entry) => entry.armLabel === "direct");
  const optimizedId = armIds.find((entry) => entry.armLabel === "optimized");
  const competingId = armIds.find((entry) => entry.armLabel === "competing");
  if (directId === undefined || optimizedId === undefined || competingId === undefined) {
    throw new Error("the live synthesis row's pre-registered arm set is missing a control arm");
  }
  const directRow = DIRECT_CORPUS.find((row) => row.rowId === directId.corpusRowId);
  const optimizedRow = OPTIMIZED_CORPUS.find((row) => row.rowId === optimizedId.corpusRowId);
  const competingRow = COMPETING_CORPUS.find((row) => row.rowId === competingId.corpusRowId);
  if (directRow === undefined || optimizedRow === undefined || competingRow === undefined) {
    throw new Error("a live arm corpus row of the pre-registered set failed to resolve");
  }

  const startedAt = Date.now();
  // ---- the direct arm (the VAL-041 character) ----
  const directStats = await driveDirectArm({
    dispatch: options.dispatch,
    sleep: options.sleep,
    row: directRow,
    maxExtraAttempts,
    backoffMs,
    paceMs,
  });
  await options.sleep(paceMs);
  // ---- the optimized arm (the VAL-042 character) ----
  const optimizedStats = await driveOptimizedArm({
    dispatch: options.dispatch,
    sleep: options.sleep,
    row: optimizedRow,
    maxExtraAttempts,
    backoffMs,
    paceMs,
  });
  await options.sleep(paceMs);
  // ---- the competing arm (the VAL-043 character) ----
  const competingStats = await driveCompetingArm({
    dispatch: options.dispatch,
    sleep: options.sleep,
    row: competingRow,
    maxExtraAttempts,
    backoffMs,
    paceMs,
  });
  const totalLatencyMs = Date.now() - startedAt;

  // ---- the re-derivation: the arm references now carry RECORDED
  //      digests over the MEASURED facts (the same derivation the
  //      input-integrity oracle runs at synthesis time) ----
  const references = armIds.map((entry) => armReferenceOf(entry.armLabel, entry.corpusRowId));
  const inputs = honestInputsOf(references);
  const statsByArm: Readonly<Record<ArmLabel, ArmDrivingStats>> = {
    direct: directStats,
    optimized: optimizedStats,
    competing: competingStats,
  };
  const arms: LiveArmMeasuredRecord[] = references.map((reference) => {
    const resolved = recordedArmFactsOf(reference);
    if (resolved === null) {
      throw new Error(
        `the recorded facts of ${reference.armLabel}:${reference.corpusRowId} failed to re-derive`,
      );
    }
    const stats = statsByArm[reference.armLabel];
    return {
      armLabel: reference.armLabel,
      corpusRowId: reference.corpusRowId,
      dispatchedRequests: stats.dispatched,
      cacheHits: stats.cacheHits,
      recordedRounds: stats.recordedRounds,
      runCount: resolved.facts.runCount,
      resolvedCount: resolved.facts.resolvedCount,
      measuredCostMicroUsd: resolved.facts.measuredCostMicroUsd,
      recordedDigest: reference.recordedDigest,
      latencyMs: stats.wallclockMs,
    };
  });
  const totalMeasuredMicroUsd = arms.reduce(
    (sum, arm) => sum + BigInt(arm.measuredCostMicroUsd),
    0n,
  );
  return {
    arms,
    references,
    inputs,
    totalDispatches: arms.reduce((sum, arm) => sum + arm.dispatchedRequests, 0),
    totalMeasuredMicroUsd: totalMeasuredMicroUsd.toString(),
    totalLatencyMs,
  };
}
