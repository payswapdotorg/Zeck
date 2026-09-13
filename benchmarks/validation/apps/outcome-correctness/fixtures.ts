/**
 * The outcome-correctness application's deterministic fixtures
 * (VAL-026, AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fixture effect world — the effect-state oracle with the
 *     ATOMIC staging discipline: effects are staged (validated against
 *     the frozen targets), committed ALL-AT-ONCE on a passing verdict
 *     or DISCARDED on a failing one, and the committed counters are
 *     deliberately NON-idempotent (a double application
 *     double-counts, so any machinery that re-applied an effect is
 *     mechanically visible). The discrimination variants: `dropStaged`
 *     silently drops one staged effect from the commit (the
 *     missing-effect catch) and `phantom` applies one extra undeclared
 *     effect at commit (the phantom-effect catch);
 *   * the tick clock — the deterministic injectable clock that
 *     advances with every simulated platform roundtrip;
 *   * the fake ledger + the fake submission seam — the platform's OWN
 *     create semantics (the first insert's synchronous critical
 *     section wins; a same-fingerprint re-issue REPLAYS the committed
 *     outcome with identity preserved; a different fingerprint gets
 *     the typed 409 IDEMPOTENCY_KEY_REUSED — never a second
 *     execution), plus the LEAKY variant that re-arbitrates a replayed
 *     key (the double-arbitration discrimination catch);
 *   * the fake lifecycle — the REAL state machine's own frozen table
 *     mirrored (CREATED → authorize → … → verify → pass/fail), the
 *     per-call idempotency keys, the gapless per-execution event
 *     journal and the observed-terminal read-back, plus the
 *     FABRICATING variant that flips a fail verdict to a COMPLETED
 *     terminal (the adversarial anyFail→FAILED probe: a fabricated
 *     pass-with-fail the reconciliation must catch);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam: the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary (the
 *     COMPLETED rows settle with all-PASS verification statuses; the
 *     FAILED rows settle with the honest FAIL criterion visible in the
 *     result read) and the fabrication knobs (a COMPLETED terminal
 *     with a FAIL verification status; a replay that mints a second
 *     execution).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type { LabVerificationCriterion } from "../../platform/derive";
import type {
  OutcomeEffectSpec,
  OutcomeEffectWorld,
  OutcomeJournalRecord,
  OutcomeLifecyclePort,
  OutcomeSubmissionSeam,
  OutcomeWorldFacts,
} from "../../platform/outcome-correctness";
import { IDEMPOTENCY_KEY_REUSED_CODE } from "../../platform/outcome-correctness";
import { OUTCOME_CORPUS } from "./corpus";

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
// The fixture effect world (the atomic staging oracle)
// ---------------------------------------------------------------------------

/** The fixture world's own observable state (the oracle's view). */
export interface OutcomeFixtureWorldState {
  /** effectId → the committed count (the double-application detector). */
  readonly committedCounts: Readonly<Record<string, number>>;
  /** The staged-but-uncommitted set (the atomicity boundary's pending set). */
  readonly staged: readonly OutcomeEffectSpec[];
  /** The discarded sets the world observed (FAILED rows' atomicity evidence). */
  readonly discards: readonly OutcomeEffectSpec[];
}

export interface OutcomeFixtureWorld extends OutcomeEffectWorld {
  readonly state: OutcomeFixtureWorldState;
}

/**
 * Create the fixture effect world. The world is deliberately
 * NON-idempotent on commit (a double application double-counts) and
 * enforces the ATOMIC staging discipline:
 *
 *   * `stage` validates the effect against the frozen targets (a
 *     frozen target rejects — the mid-work failure shape);
 *   * `commitStaged` applies the staged set to the durable counters
 *     ALL-AT-ONCE and returns the committed set;
 *   * `discardStaged` drops the staged set — a failed execution's
 *     effects never land.
 *
 * Discrimination variants: `dropStaged` silently drops one staged
 * effect at commit (the missing-effect catch); `phantom` applies one
 * extra undeclared effect at commit (the phantom-effect catch).
 */
export function createOutcomeFixtureWorld(options: {
  readonly clock: TickClock;
  /** The frozen target effect ids (the mid-work rejection shape). */
  readonly frozenEffects?: readonly string[];
  /** Discrimination: silently drop this staged effect at commit. */
  readonly dropStaged?: string;
  /** Discrimination: apply this extra undeclared effect at commit. */
  readonly phantom?: string;
}): OutcomeFixtureWorld {
  const committedCounts: Record<string, number> = {};
  const staged: OutcomeEffectSpec[] = [];
  const discards: OutcomeEffectSpec[] = [];
  const frozen = new Set(options.frozenEffects ?? []);
  const observedCounts: Record<string, number> = committedCounts;
  return {
    state: {
      get committedCounts() {
        return { ...committedCounts };
      },
      get staged() {
        return [...staged];
      },
      get discards() {
        return [...discards];
      },
    },
    observedCounts,
    stage(effect) {
      options.clock.advance(3);
      if (frozen.has(effect.effect)) {
        return {
          ok: false,
          value: `the target ${effect.key} is frozen (effect ${effect.effect} is rejected)`,
        };
      }
      staged.push(effect);
      return { ok: true, value: `staged ${effect.effect} on ${effect.key}` };
    },
    commitStaged() {
      const committed: OutcomeEffectSpec[] = [];
      for (const effect of staged) {
        if (options.dropStaged === effect.effect) {
          // The sloppy-world discrimination: the staged effect silently
          // never lands (the fixture-delta oracle catches it).
          continue;
        }
        committedCounts[effect.effect] = (committedCounts[effect.effect] ?? 0) + 1;
        committed.push(effect);
        options.clock.advance(2);
      }
      if (options.phantom !== undefined) {
        // The leaky-world discrimination: an undeclared effect lands
        // (the phantom-effect oracle catches it).
        committedCounts[options.phantom] = (committedCounts[options.phantom] ?? 0) + 1;
      }
      staged.length = 0;
      return committed;
    },
    discardStaged() {
      discards.push(...staged);
      staged.length = 0;
    },
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
  facts(): OutcomeWorldFacts;
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
      // The fake never orphans an event (the discrimination injects
      // synthetic facts into the PURE derivation instead).
      orphanEventCount: 0,
    }),
  };
}

const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);

/**
 * The fake submission seam: ONE create through the platform's OWN
 * create/replay semantics — the first insert's SYNCHRONOUS critical
 * section wins; a same-fingerprint re-issue REPLAYS the committed
 * outcome (identity preserved, the replayed flag surfaced — the
 * replayed row's OWN terminal, whatever it is); a different
 * fingerprint under the same key gets the typed 409
 * IDEMPOTENCY_KEY_REUSED — never a second execution.
 *
 * The `leakyReplay` variant deliberately RE-ARBITRATES a replayed key
 * (a second durable execution — the double-arbitration discrimination
 * catch).
 */
export function createFakeSubmissionSeam(options: {
  readonly ledger: FakeLedger;
  readonly leakyReplay?: boolean;
}): OutcomeSubmissionSeam {
  const { ledger } = options;
  return async ({ key, body }) => {
    const submittedAt = ledger.clock.now().getTime();
    await ledger.clock.tick();
    const fingerprint = fingerprintOf(body);
    const existing = ledger.records.get(key);
    if (
      existing !== undefined &&
      existing.fingerprint === fingerprint &&
      options.leakyReplay !== true
    ) {
      const row = ledger.rows.get(existing.executionId);
      return {
        executionId: existing.executionId,
        replayed: true,
        status: row?.status ?? "CREATED",
        rejection: null,
        submittedAt,
        latencyMs: ledger.clock.now().getTime() - submittedAt,
      };
    }
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      return {
        executionId: "",
        replayed: false,
        status: null,
        rejection: { code: IDEMPOTENCY_KEY_REUSED_CODE, status: 409 },
        submittedAt,
        latencyMs: ledger.clock.now().getTime() - submittedAt,
      };
    }
    // A fresh key — or the LEAKY re-arbitration of a replayed key.
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
      submittedAt,
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
  readonly decisions: { executionId: string; provider: string; model: string }[];
  readonly stepEvents: { executionId: string; record: OutcomeJournalRecord }[];
  readonly completions: {
    executionId: string;
    verdict: string;
    criteria: LabVerificationCriterion[];
  }[];
  /** Every callKey the lifecycle saw (the per-decision-distinct discipline). */
  readonly callKeys: string[];
}

export interface FakeLifecycle extends OutcomeLifecyclePort {
  readonly journal: FakeLifecycleJournal;
}

/**
 * The fake lifecycle: mirrors the REAL state machine's frozen table
 * (illegal edges throw INVALID_STATE_TRANSITION; terminal states are
 * immutable), the durable planning decisions and the gapless
 * per-execution event journal, with the observed-terminal read-back.
 *
 * The `fabricatePassWithFail` variant is the ADVERSARIAL anyFail→FAILED
 * probe: a driver verdict of `fail` is fabricated into a COMPLETED
 * terminal (a pass-with-fail the reconciliation must catch — the row
 * must FAIL honestly on the terminal↔criteria disagreement).
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

  const port: OutcomeLifecyclePort = {
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
    async recordPlanningDecision({ executionId, route }) {
      journal.decisions.push({
        executionId,
        provider: route.provider,
        model: route.model,
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
      // COMPLETED terminal (a pass-with-fail shape the reconciliation
      // must catch — never an honest representation).
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
 *    COMPLETED rows carry all-PASS verification statuses; the FAILED
 *    rows carry the honest FAIL criterion visible in the result read.
 *
 * Discrimination knobs: `terminal`/`verificationStatuses` override the
 * honest outcome; `fabricatePassWithFail` settles a FAILED-expected
 * row into a COMPLETED terminal WITH a FAIL verification status (the
 * app-level adversarial probe); `leakyReplay` mints a SECOND execution
 * on a replayed key (the identity-preservation catch).
 */
export function createOutcomeFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** Override the honest verification statuses (the discrimination knob). */
  readonly verificationStatuses?: readonly string[];
  /** The adversarial knob: COMPLETED terminal WITH a FAIL status. */
  readonly fabricatePassWithFail?: boolean;
  /** The leaky knob: a replayed key mints a SECOND execution. */
  readonly leakyReplay?: boolean;
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
    const row = OUTCOME_CORPUS.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    // The honest FAILED shape: the failure criterion FAILs visibly and
    // the atomicity criterion PASSes (the empty delta verified).
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
      if (
        existing !== undefined &&
        existing.fingerprint === fingerprint &&
        options.leakyReplay !== true
      ) {
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
        task: { kind: "outcome-correctness.effect.v1", input: "effects" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    const eventsMatch = url.match(/\/executions\/([^/]+)\/events$/);
    if (eventsMatch !== null && method === "GET") {
      const row = rows.get(eventsMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      return jsonResponse(
        200,
        row.events.map((type, index) => ({
          eventId: `${row.id}-ev-${index + 1}`,
          executionId: row.id,
          type,
          sequence: index + 1,
          occurredAt: new Date(row.createdAt + index).toISOString(),
          payload: {},
        })),
      );
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
          strategyClass: "outcome-correctness",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "40", currency: "usd" } : null,
        usage: pass ? { inputTokens: 30, outputTokens: 6 } : null,
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
