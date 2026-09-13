/**
 * The economic-baseline application's deterministic fixtures
 * (VAL-040, AC2 + the AC6 discrimination battery's controlled
 * fakes).
 *
 * The controlled world the driver and the app execute against:
 *
 *   * the recorded-replay executor — the deterministic
 *     platform-path executor binding for the OFFLINE rows: each
 *     dispatch attempt replays the row's RECORDED accounting facts
 *     (settled usage tokens in the RAIL's manifest-declared currency,
 *     recorded latencies, recorded verdicts) — zero network, zero
 *     credentials, zero randomness, exactly reproducible from the
 *     repository. The DISCRIMINATION variants: `conflateCurrency`
 *     (usage denominated in a currency that mismatches the pinned
 *     price's — or sits outside the pinned FX table — the
 *     mixed-currency conflation catch), `estimateOnly` (the rounds
 *     report ONLY planner quotes, no measured usage — the
 *     estimate-backed cost-per-resolution catch), `dropFailedRounds`
 *     (the executor refuses the failed rounds — the post-hoc arm
 *     exclusion catch), `truncateSamples` (the executor stops after
 *     fewer rounds than the statistical minimum — the sample-size
 *     violation catch) and `mutatePriceEntry` (the arm prices against
 *     a MUTATED manifest table with a stale digest — the
 *     unpinned-pricing catch);
 *   * the tick clock — the deterministic injectable clock;
 *   * the fake ledger + the fake submission seam — the platform's
 *     OWN create/replay semantics (the first insert's synchronous
 *     critical section wins; a same-fingerprint re-issue REPLAYS the
 *     committed receipt; a different fingerprint gets the typed 409
 *     IDEMPOTENCY_KEY_REUSED — never a second execution);
 *   * the fake lifecycle — the REAL state machine's frozen table
 *     mirrored (CREATED → authorize → … → verify → pass/fail), the
 *     per-call idempotency keys, the gapless per-execution event
 *     journal, the durable arm-decision records and the
 *     observed-terminal read-back, plus the FABRICATING variant that
 *     flips a fail verdict into a COMPLETED terminal (the adversarial
 *     anyFail→FAILED probe);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam: the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary and
 *     the fabrication knobs (a COMPLETED terminal with a FAIL
 *     verification status; a terminal override).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import { ECONOMIC_CORPUS } from "./corpus";
import type {
  EconomicCorpusRow,
  EconomicExecutor,
  EconomicJournalRecord,
  EconomicLifecyclePort,
  EconomicWorldFacts,
} from "./driver";
import { economicDigestOf } from "./driver";
import type { PriceCurrency, PriceManifestRevision } from "./pricing";
import { computeManifestDigest, manifestRevisionOf, resolveListPrice } from "./pricing";

// ---------------------------------------------------------------------------
// The tick clock (deterministic wall-clock)
// ---------------------------------------------------------------------------

/** The deterministic injectable clock (advances with simulated roundtrips). */
export interface TickClock {
  readonly now: () => Date;
  /** Advance the clock synchronously (no yield). */
  readonly advance: (ms: number) => void;
  /** Advance by the step and yield one microtask (the roundtrip seam). */
  readonly tick: (ms?: number) => Promise<void>;
}

/** Create the tick clock: every `tick` advances `stepMs` and yields. */
export function createTickClock(stepMs = 5): TickClock {
  let elapsedMs = 0;
  return {
    now: () => new Date(1_000_000 + elapsedMs),
    advance: (ms) => {
      elapsedMs += ms;
    },
    tick: async (ms) => {
      elapsedMs += ms ?? stepMs;
      await Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// The recorded-replay executor (the offline platform-path binding)
// ---------------------------------------------------------------------------

/** The recorded-replay executor's discrimination knobs. */
export interface ReplayExecutorKnobs {
  /**
   * The mixed-currency conflation: usage denominated in a currency
   * that mismatches the pinned price's denomination (or sits outside
   * the pinned FX table — e.g. GBP) — the normalization FAILS.
   */
  readonly conflateCurrency?: PriceCurrency;
  /**
   * The estimate-backed shape: the rounds report ONLY planner quotes
   * (no measured usage) — the cost-per-resolved is refused (never
   * estimate-backed) and the comparison FAILS.
   */
  readonly estimateOnly?: boolean;
  /**
   * The post-hoc arm exclusion: the executor refuses (skips) every
   * FAILED round — the executed slice drops the non-resolved tasks
   * and the slice-conformance oracle FAILS.
   */
  readonly dropFailedRounds?: boolean;
  /**
   * The sample-size violation: the executor skips every round after
   * the first `truncateSamples` — the executed sample falls below the
   * declared statistical minimum and the sufficiency oracle FAILS.
   */
  readonly truncateSamples?: number;
}

/**
 * Create the recorded-replay executor: the deterministic
 * platform-path binding for the OFFLINE rows. Each attempt replays
 * the row's recorded accounting facts — the usage tokens denominated
 * in the RAIL's manifest-declared currency (the honest shape; the
 * knobs denature it), the recorded latencies and the recorded
 * verdicts.
 */
export function createRecordedReplayExecutor(options: {
  readonly row: EconomicCorpusRow;
  readonly clock?: TickClock;
  readonly knobs?: ReplayExecutorKnobs;
}): EconomicExecutor {
  const { row } = options;
  if (row.replay === undefined) {
    throw new Error(`corpus row ${row.rowId} has no recorded replay rounds (a live row?)`);
  }
  const manifest = manifestRevisionOf(row.arm.priceRevision);
  if (manifest === null) {
    throw new Error(`the arm's price revision ${row.arm.priceRevision} is not pinned`);
  }
  const railCurrency: PriceCurrency | null =
    resolveListPrice(manifest, row.arm.provider, row.arm.model, "input")?.currency ?? null;
  const dispatched = new Set<string>();
  const executedOrder: string[] = [];
  return async ({ taskId, attempt }) => {
    if (options.clock !== undefined) {
      await options.clock.tick();
    }
    const round = row.replay?.find((candidate) => candidate.taskId === taskId);
    if (round === undefined) {
      return {
        kind: "failure",
        category: "slice-task-missing",
        message: `no recorded round for task ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, missing: true }),
      };
    }
    const recorded = round.attempts[attempt - 1];
    if (recorded === undefined) {
      // The replay's recorded attempt sequence is exhausted: a
      // further retry is an honest non-retryable stop (the recorded
      // rounds drive exactly their own attempts).
      return {
        kind: "failure",
        category: "replay-exhausted",
        message: `the recorded replay for ${taskId} has no attempt ${attempt}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, exhausted: true }),
      };
    }
    const requestDigest = economicDigestOf({ taskId, attempt, usage: recorded.usage });
    const final = round.attempts[round.attempts.length - 1];
    const isFinalAttempt = attempt === round.attempts.length;

    // The post-hoc arm exclusion: the executor refuses the round when
    // its recorded outcome is a FAILURE (the executed slice drops the
    // non-resolved tasks — the conformance oracle catches it).
    if (options.knobs?.dropFailedRounds === true && final?.outcome === "failure") {
      return {
        kind: "skipped",
        skipReason: `post-hoc exclusion of the failed round ${taskId}`,
        latencyMs: 0,
        requestDigest,
      };
    }
    // The sample-size violation: the executor skips every round after
    // the first `truncateSamples` dispatched rounds.
    if (options.knobs?.truncateSamples !== undefined) {
      if (!dispatched.has(taskId)) {
        if (executedOrder.length >= options.knobs.truncateSamples) {
          return {
            kind: "skipped",
            skipReason: `sample truncated after ${options.knobs.truncateSamples} rounds`,
            latencyMs: 0,
            requestDigest,
          };
        }
        dispatched.add(taskId);
        executedOrder.push(taskId);
      }
    }

    // The honest currency: the RAIL's manifest-declared denomination
    // (the conflation knob denatures it — a mismatched or
    // FX-external currency fails normalization mechanically).
    const currency: PriceCurrency = options.knobs?.conflateCurrency ?? railCurrency ?? "USD";
    const usage =
      options.knobs?.estimateOnly === true
        ? undefined
        : {
            inputTokens: recorded.usage.inputTokens,
            outputTokens: recorded.usage.outputTokens,
            currency,
          };
    if (recorded.outcome === "success") {
      return {
        kind: "success",
        content: round.responseText ?? "confirm",
        ...(usage === undefined ? {} : { usage }),
        // The estimate-backed shape: the planner quote rides INSTEAD
        // of the measured usage (the estimate-separation catch).
        ...(options.knobs?.estimateOnly === true
          ? {
              estimateQuote: {
                inputTokens: recorded.usage.inputTokens,
                outputTokens: recorded.usage.outputTokens,
              },
            }
          : round.estimateQuote !== undefined && isFinalAttempt
            ? { estimateQuote: round.estimateQuote }
            : {}),
        latencyMs: recorded.latencyMs,
        requestDigest,
      };
    }
    return {
      kind: "failure",
      category: recorded.category ?? "unknown",
      message: `the recorded round ${taskId} failed at attempt ${attempt} (${recorded.category ?? "unknown"})`,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: recorded.latencyMs,
      requestDigest,
    };
  };
}

// ---------------------------------------------------------------------------
// The mutated manifest (the unpinned-pricing discrimination)
// ---------------------------------------------------------------------------

/**
 * Build a MUTATED manifest revision for the discrimination battery:
 * one pinned price edited IN PLACE while the recorded digest stays
 * STALE (the "price correction applied in place" shape — the
 * manifest-integrity digest disagreement catch). The honest
 * correction is a NEW revision (see PRICE_MANIFEST rev-002).
 */
export function mutatedManifestOf(
  revision: string,
  mutation: {
    readonly provider: string;
    readonly tier: "input" | "output";
    readonly price: string;
  },
): PriceManifestRevision {
  const base = manifestRevisionOf(revision);
  if (base === null) {
    throw new Error(`unknown manifest revision ${revision}`);
  }
  const tables = base.tables.map((entry) =>
    entry.provider === mutation.provider && entry.tier === mutation.tier
      ? { ...entry, price: mutation.price }
      : entry,
  );
  // The digest is NOT recomputed — the in-place mutation is exactly
  // the shape the content-addressing must catch.
  return { ...base, tables, digest: base.digest };
}

/** Build a corrected-price revision the HONEST way (a NEW revision, digest recomputed). */
export function correctedManifestRevision(
  base: PriceManifestRevision,
  mutation: {
    readonly provider: string;
    readonly tier: "input" | "output";
    readonly price: string;
  },
  newRevision: string,
): PriceManifestRevision {
  const tables = base.tables.map((entry) =>
    entry.provider === mutation.provider && entry.tier === mutation.tier
      ? { ...entry, price: mutation.price }
      : entry,
  );
  return {
    revision: newRevision,
    tables,
    fx: base.fx,
    digest: computeManifestDigest(tables, base.fx),
    supersedes: base.revision,
  };
}

// ---------------------------------------------------------------------------
// The fake ledger + the fake submission seam (the create/replay semantics)
// ---------------------------------------------------------------------------

/** One durable execution row the fake ledger holds. */
export interface FakeExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
  /** The durable event types on the execution's ledger. */
  readonly events: string[];
}

/** The fake ledger the seam and the lifecycle share (the durable world). */
export interface FakeLedger {
  /** key → { fingerprint, executionId } (the idempotency records). */
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
  /** executionId → the durable row. */
  readonly rows: Map<string, FakeExecutionRow>;
  readonly clock: TickClock;
  /** Append one event envelope (the event-count oracle). */
  appendEvent(): void;
  /** The next synthetic execution id. */
  nextId(): string;
  /** The durable world facts (the row-count oracles). */
  facts(): EconomicWorldFacts;
}

/** Create the shared fake ledger (the seam + the lifecycle ride it). */
export function createFakeLedger(clock: TickClock): FakeLedger {
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const rows = new Map<string, FakeExecutionRow>();
  let events = 0;
  let sequence = 0;
  return {
    records,
    rows,
    clock,
    appendEvent() {
      events += 1;
    },
    nextId() {
      sequence += 1;
      return `fake-exec-${sequence}`;
    },
    facts: () => ({
      executionCount: rows.size,
      eventCount: events,
      idempotencyRecordCount: records.size,
      orphanEventCount: 0,
    }),
  };
}

const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);

/** The fake submission seam (the platform's create/replay semantics, typed for economics rows). */
export type FakeSubmissionSeam = (input: {
  readonly key: string;
  readonly body: Readonly<Record<string, unknown>>;
}) => Promise<{
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string | null;
  readonly rejection: { readonly code: string; readonly status: number } | null;
  readonly latencyMs: number;
}>;

/** Create the fake submission seam over the shared fake ledger. */
export function createFakeSubmissionSeam(options: {
  readonly ledger: FakeLedger;
}): FakeSubmissionSeam {
  const { ledger } = options;
  return async ({ key, body }) => {
    const submittedAt = ledger.clock.now().getTime();
    await ledger.clock.tick();
    const fingerprint = fingerprintOf(body);
    const existing = ledger.records.get(key);
    if (existing !== undefined && existing.fingerprint === fingerprint) {
      const row = ledger.rows.get(existing.executionId);
      return {
        executionId: existing.executionId,
        replayed: true,
        status: row?.status ?? "CREATED",
        rejection: null,
        latencyMs: ledger.clock.now().getTime() - submittedAt,
      };
    }
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      return {
        executionId: "",
        replayed: false,
        status: null,
        rejection: { code: "IDEMPOTENCY_KEY_REUSED", status: 409 },
        latencyMs: ledger.clock.now().getTime() - submittedAt,
      };
    }
    const id = ledger.nextId();
    ledger.records.set(key, { fingerprint, executionId: id });
    ledger.rows.set(id, {
      id,
      key,
      taskRowId: String((body as { rowId?: unknown } | null)?.rowId ?? ""),
      status: "CREATED",
      createdAt: ledger.clock.now().getTime(),
      events: ["execution.created"],
    });
    ledger.appendEvent();
    return {
      executionId: id,
      replayed: false,
      status: "CREATED",
      rejection: null,
      latencyMs: ledger.clock.now().getTime() - submittedAt,
    };
  };
}

// ---------------------------------------------------------------------------
// The fake lifecycle (the REAL state machine's frozen table)
// ---------------------------------------------------------------------------

/** The frozen transition table mirror (the REAL machine's own edges). */
const FAKE_TRANSITIONS: Readonly<Record<string, string>> = {
  "CREATED|authorize": "AUTHORIZED",
  "AUTHORIZED|plan": "PLANNING",
  "PLANNING|queue": "QUEUED",
  "QUEUED|start": "RUNNING",
  "RUNNING|verify": "VERIFYING",
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

/** The fake lifecycle's own observable journal. */
export interface FakeLifecycleJournal {
  readonly transitions: { executionId: string; step: string; callKey: string }[];
  readonly decisions: {
    executionId: string;
    provider: string;
    model: string;
    armDecision: Readonly<Record<string, unknown>>;
  }[];
  readonly stepEvents: { executionId: string; record: EconomicJournalRecord }[];
  readonly completions: {
    executionId: string;
    verdict: string;
    criteria: LabVerificationCriterion[];
  }[];
  /** Every callKey the lifecycle saw (the per-decision-distinct discipline). */
  readonly callKeys: string[];
}

export interface FakeLifecycle extends EconomicLifecyclePort {
  readonly journal: FakeLifecycleJournal;
}

/**
 * The fake lifecycle: mirrors the REAL state machine's frozen table
 * (illegal edges throw INVALID_STATE_TRANSITION; terminal states are
 * immutable), the durable planning decisions (the ARM DECISION facts
 * journaled — the before-dispatch evidence) and the gapless
 * per-execution event journal, with the observed-terminal read-back.
 *
 * The `fabricatePassWithFail` variant is the ADVERSARIAL
 * anyFail→FAILED probe: a driver verdict of `fail` is fabricated into
 * a COMPLETED terminal (a pass-with-fail the app-side agreement must
 * catch at the customer boundary).
 */
export function createFakeLifecycle(options: {
  readonly ledger: FakeLedger;
  readonly fabricatePassWithFail?: boolean;
}): FakeLifecycle {
  const { ledger } = options;
  const journal: FakeLifecycleJournal = {
    transitions: [],
    decisions: [],
    stepEvents: [],
    completions: [],
    callKeys: [],
  };

  const port: EconomicLifecyclePort = {
    async transition({ executionId, step, reason, callKey }) {
      void reason;
      journal.transitions.push({ executionId, step, callKey });
      journal.callKeys.push(callKey);
      await ledger.clock.tick();
      const row = ledger.rows.get(executionId);
      if (row === undefined) {
        throw Object.assign(new Error(`unknown execution ${executionId}`), {
          code: "PROVIDER_ERROR",
        });
      }
      const next = FAKE_TRANSITIONS[`${row.status}|${step}`];
      if (next === undefined) {
        throw Object.assign(new Error(`command ${step} is not legal from ${row.status}`), {
          code: "INVALID_STATE_TRANSITION",
        });
      }
      row.status = next;
      ledger.appendEvent();
    },
    async recordPlanningDecision({ executionId, route, armDecision }) {
      journal.decisions.push({
        executionId,
        provider: route.provider,
        model: route.model,
        armDecision: { ...armDecision },
      });
      await ledger.clock.tick();
      ledger.appendEvent();
    },
    async recordStepEvent({ executionId, record }) {
      // Mirrors the REAL platform's physical terminal immutability: a
      // terminal execution accepts NO further step events.
      const row = ledger.rows.get(executionId);
      if (row === undefined) {
        throw Object.assign(new Error(`unknown execution ${executionId}`), {
          code: "PROVIDER_ERROR",
        });
      }
      if (TERMINAL.has(row.status)) {
        throw Object.assign(
          new Error(
            `execution is terminal in ${row.status}; the ledger accepts no further step events`,
          ),
          { code: "INVALID_STATE_TRANSITION" },
        );
      }
      journal.stepEvents.push({ executionId, record });
      await ledger.clock.tick();
      ledger.appendEvent();
    },
    async complete({ executionId, verdict, criteria }) {
      journal.completions.push({ executionId, verdict, criteria: [...criteria] });
      await ledger.clock.tick();
      const row = ledger.rows.get(executionId);
      if (row === undefined) {
        throw Object.assign(new Error(`unknown execution ${executionId}`), {
          code: "PROVIDER_ERROR",
        });
      }
      if (row.status !== "VERIFYING") {
        throw Object.assign(new Error(`command ${verdict} is not legal from ${row.status}`), {
          code: "INVALID_STATE_TRANSITION",
        });
      }
      // The ADVERSARIAL fabrication: a fail verdict is flipped into a
      // COMPLETED terminal (a pass-with-fail shape the app-side
      // agreement must catch — never an honest representation).
      const fabricated =
        options.fabricatePassWithFail === true && verdict === "fail" ? "COMPLETED" : null;
      row.status = fabricated ?? (verdict === "pass" ? "COMPLETED" : "FAILED");
      ledger.appendEvent();
    },
    async statusOf(executionId) {
      return ledger.rows.get(executionId)?.status ?? null;
    },
  };
  return Object.assign(port, { journal });
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary:
 *
 *  - POST /executions — the create/replay semantics (the first
 *    insert's synchronous critical section wins; a same-fingerprint
 *    re-issue replays the committed receipt — the replayed row's OWN
 *    terminal; a different fingerprint gets the typed 409
 *    IDEMPOTENCY_KEY_REUSED);
 *  - GET /executions/:id — the row settles to its honest outcome on
 *    the read path (the fake simulates the platform driving's
 *    completion), unless an override knob is set;
 *  - GET /executions/:id/results — the honest result package: the
 *    COMPLETED rows carry all-PASS verification statuses.
 *
 * Discrimination knobs: `terminal`/`verificationStatuses` override the
 * honest outcome; `fabricatePassWithFail` settles a FAILED-expected
 * row into a COMPLETED terminal WITH a FAIL verification status (the
 * app-level adversarial probe).
 */
export function createEconomicFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** Override the honest verification statuses (the discrimination knob). */
  readonly verificationStatuses?: readonly string[];
  /** The adversarial knob: COMPLETED terminal WITH a FAIL status. */
  readonly fabricatePassWithFail?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  /** The row's honest outcome shape (derived from the corpus itself). */
  const honestOutcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const row = ECONOMIC_CORPUS.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    // The honest FAILED shape: the failure criterion FAILs visibly.
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
      // The ADVERSARIAL fabrication: the FAILED-expected row settles
      // COMPLETED while its verification carries a FAIL status.
      return { terminal: "COMPLETED", statuses: ["FAIL", "PASS"] };
    }
    return {
      terminal: options.terminal ?? honest.terminal,
      statuses:
        options.verificationStatuses === undefined
          ? honest.statuses
          : [...options.verificationStatuses],
    };
  };

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    await clock.tick();

    if (url.endsWith("/executions") && method === "POST") {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "";
      if (key.length === 0) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "POST routes require an Idempotency-Key header",
          retryable: false,
        });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "null")) as Record<
        string,
        unknown
      >;
      const fingerprint = fingerprintOf(body);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row = rows.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: row?.status ?? "CREATED",
          createdAt: new Date(row?.createdAt ?? 0).toISOString(),
          replayed: true,
          lastEventSequence: 1,
        });
      }
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          retryable: false,
        });
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        taskRowId: String((body.task as { rowId?: unknown } | null)?.rowId ?? ""),
        status: "CREATED",
        createdAt: clock.now().getTime(),
        events: ["execution.created"],
      });
      records.set(key, { fingerprint, executionId: id });
      return jsonResponse(201, {
        executionId: id,
        applicationId: body.applicationId ?? "app-1",
        status: "CREATED",
        createdAt: new Date(clock.now().getTime()).toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const row = rows.get(execMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      // The row settles on the read path (the fake simulates the
      // platform driving's completion) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "economic-baseline.experiment.v1", input: "experiment" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null && method === "GET") {
      const row = rows.get(resultMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const outcome = outcomeFor(row.taskRowId);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "economic-baseline",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "22", currency: "usd" } : null,
        usage: pass ? { inputTokens: 120, outputTokens: 30 } : null,
        outputArtifacts: [],
        verification: outcome.statuses.map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        warnings: [],
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };

  return {
    transport,
    get createdExecutions() {
      return createdExecutions;
    },
    rows,
    records,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
