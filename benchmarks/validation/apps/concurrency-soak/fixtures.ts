/**
 * The concurrency/soak application's deterministic fixtures (VAL-025,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the settlement effect world — a ledger whose counters are the
 *     exactly-once multiplicity oracle (the world itself is
 *     deliberately NOT idempotent: a double settlement double-counts,
 *     so any arbitration that re-applied an effect is mechanically
 *     visible);
 *   * the tick clock — a deterministic injectable clock that advances
 *     with every simulated platform roundtrip, making the fan-out
 *     OVERLAP mechanically observable offline (concurrent chains
 *     interleave at every await and produce overlapping windows;
 *     strictly serialized driving produces disjoint windows — the
 *     head-of-line-blocking discrimination);
 *   * the fake lifecycle — the REAL state machine's own frozen table
 *     mirrored (CREATED → authorize → … → verify → pass/fail), the
 *     admission gate (the ceiling discipline: prune-then-decide with
 *     the durable policy-denied envelope and the typed POLICY_DENIED
 *     journal-then-fail), the per-call idempotency keys and the
 *     gapless per-execution event journal;
 *   * the fake submission seam — the platform's OWN racing semantics
 *     (the first insert's synchronous critical section wins; the
 *     concurrent loser replays the winner's committed outcome with
 *     identity preserved; a different fingerprint gets the typed 409
 *     IDEMPOTENCY_KEY_REUSED), plus the LEAKY variant that admits BOTH
 *     racers (the double-arbitration discrimination catch);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam implementing the same racing semantics at
 *     the create boundary, the admission shaping on the first
 *     execution read (the authorized lanes complete; the over-ceiling
 *     lanes stay CREATED with the durable execution.policy-denied
 *     envelope visible through the public events read).
 *
 * Zero network, zero credentials: every offline corpus row is
 * reproducible through these fixtures alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  ConcurrencyEffectWorld,
  ConcurrencyLifecyclePort,
  ConcurrencySubmissionSeam,
  ConcurrencyWorldFacts,
  EffectJournalRecord,
  SoakJournalRecord,
} from "../../platform/concurrency-soak";
import {
  ADMISSION_DENIED_EVENT_TYPE,
  ADMISSION_REJECTION_CODE,
} from "../../platform/concurrency-soak";
import type { LabVerificationCriterion } from "../../platform/derive";

// ---------------------------------------------------------------------------
// The tick clock (deterministic wall-clock for the overlap derivation)
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
// The settlement effect world (the exactly-once multiplicity oracle)
// ---------------------------------------------------------------------------

/** The settlement world's own observable state (the fixture counters). */
export interface SettlementWorldState {
  /** effectId → the number of times it was settled (the double-settlement detector). */
  readonly settlements: Readonly<Record<string, number>>;
  /** The journal records the world observed (the sequence-continuity oracle). */
  readonly journal: readonly EffectJournalRecord[];
}

export interface SoakEffectWorld extends ConcurrencyEffectWorld {
  readonly state: SettlementWorldState;
}

/**
 * Create the settlement effect world. The world is deliberately
 * NON-idempotent: `settle` increments a per-invoice counter every time
 * it is called — the PLATFORM's concurrency machinery is what must
 * prevent the double settlement, and a violation is mechanically
 * visible in these counters. Each application advances the tick clock
 * (the lane's work latency — the overlap derivation's input).
 */
export function createSoakWorld(clock: TickClock): SoakEffectWorld {
  const settlements: Record<string, number> = {};
  const journal: EffectJournalRecord[] = [];
  const observedCounts: Record<string, number> = {};
  const world: SoakEffectWorld = {
    state: {
      get settlements() {
        return { ...settlements };
      },
      get journal() {
        return [...journal];
      },
    },
    observedCounts,
    apply(effect) {
      clock.advance(4);
      settlements[effect.key] = (settlements[effect.key] ?? 0) + 1;
      observedCounts[effect.effect] = (observedCounts[effect.effect] ?? 0) + 1;
      return { ok: true, value: `settled ${effect.key} for ${effect.amountMicro} micro-USD` };
    },
    journalHook(record) {
      journal.push(record);
    },
  };
  return world;
}

// ---------------------------------------------------------------------------
// The fake submission seam (the platform's OWN racing semantics)
// ---------------------------------------------------------------------------

/** One durable execution row the fake ledger holds. */
export interface FakeExecutionRow {
  readonly id: string;
  readonly key: string;
  status: string;
  readonly createdAt: number;
  /** The durable event types on the execution's ledger (incl. denial envelopes). */
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
  facts(): ConcurrencyWorldFacts;
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
 * racing semantics — the first insert's SYNCHRONOUS critical section
 * wins (atomic in single-threaded JS, mirroring the PostgreSQL unique
 * index's arbitration); a concurrent same-fingerprint submission
 * replays the winner's committed outcome (identity preserved, the
 * replayed flag surfaced); a different fingerprint gets the typed 409
 * IDEMPOTENCY_KEY_REUSED — never a second execution.
 *
 * The `leaky` variant deliberately double-admits (the discrimination
 * catch: every racing criterion FAILS against it).
 */
export function createFakeSubmissionSeam(options: {
  readonly ledger: FakeLedger;
  readonly leaky?: boolean;
}): ConcurrencySubmissionSeam {
  const { ledger } = options;
  return async ({ key, body }) => {
    const submittedAt = ledger.clock.now().getTime();
    await ledger.clock.tick();
    const fingerprint = fingerprintOf(body);
    const existing = options.leaky === true ? undefined : ledger.records.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return {
          executionId: "",
          replayed: false,
          status: null,
          rejection: { code: "IDEMPOTENCY_KEY_REUSED", status: 409 },
          submittedAt,
          latencyMs: ledger.clock.now().getTime() - submittedAt,
        };
      }
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
    const id = ledger.nextId();
    ledger.records.set(key, { fingerprint, executionId: id });
    ledger.rows.set(id, {
      id,
      key,
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
// The fake lifecycle (the REAL state machine's frozen table + the gate)
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
  readonly stepEvents: { executionId: string; record: SoakJournalRecord }[];
  readonly completions: {
    executionId: string;
    verdict: string;
    criteria: LabVerificationCriterion[];
  }[];
  /** Every callKey the lifecycle saw (the per-decision-distinct discipline). */
  readonly callKeys: string[];
}

export interface FakeLifecycle extends ConcurrencyLifecyclePort {
  readonly journal: FakeLifecycleJournal;
  /** The admission gate's admitted-and-in-flight set (the ceiling discipline). */
  readonly admittedInFlight: Set<string>;
}

/**
 * The fake lifecycle: mirrors the REAL state machine's frozen table
 * (illegal edges throw INVALID_STATE_TRANSITION; terminal states are
 * immutable), the admission gate at authorize (the prune-then-decide
 * ceiling discipline — a denial journals the DURABLE
 * execution.policy-denied envelope and throws the typed POLICY_DENIED,
 * the platform's own journal-then-fail shape), the durable planning
 * decisions and the gapless per-execution event journal.
 */
export function createFakeLifecycle(options: {
  readonly ledger: FakeLedger;
  /** The declared admission ceiling (undefined = no gate bound). */
  readonly ceiling?: number;
  /**
   * The over-denying gate discrimination: never prune the admitted set
   * (the slots never release — the slot-release wave's later
   * submissions are wrongly denied).
   */
  readonly neverRelease?: boolean;
}): FakeLifecycle {
  const { ledger } = options;
  const journal: FakeLifecycleJournal = {
    transitions: [],
    decisions: [],
    stepEvents: [],
    completions: [],
    callKeys: [],
  };
  const admittedInFlight = new Set<string>();

  const port: ConcurrencyLifecyclePort = {
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
      // The admission gate rides authorize (the prune-then-decide
      // discipline: terminal executions release their slots BEFORE the
      // decision — the synchronous check-and-add is atomic).
      if (step === "authorize" && options.ceiling !== undefined) {
        if (options.neverRelease !== true) {
          for (const id of [...admittedInFlight]) {
            const status = ledger.rows.get(id)?.status ?? "";
            if (TERMINAL.has(status)) {
              admittedInFlight.delete(id);
            }
          }
        }
        if (admittedInFlight.size >= options.ceiling) {
          // Journal-then-fail: the durable policy-denied envelope, the
          // status STAYS CREATED, the typed POLICY_DENIED error.
          row.events.push(ADMISSION_DENIED_EVENT_TYPE);
          ledger.appendEvent();
          throw Object.assign(
            new Error(
              `concurrency ceiling ${options.ceiling} reached: ${admittedInFlight.size} admitted executions in flight (load shaping)`,
            ),
            { code: ADMISSION_REJECTION_CODE },
          );
        }
        admittedInFlight.add(executionId);
      }
      if (step === "verify") {
        const next = FAKE_TRANSITIONS[`${row.status}|verify`];
        if (next === undefined) {
          throw Object.assign(new Error(`command verify is not legal from ${row.status}`), {
            code: "INVALID_STATE_TRANSITION",
          });
        }
        row.status = next;
        ledger.appendEvent();
        return;
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
      // terminal execution accepts NO further step events (the driver
      // must never journal onto a completed row — the fake rejects it
      // exactly like the real ledger does).
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
      row.status = verdict === "pass" ? "COMPLETED" : "FAILED";
      ledger.appendEvent();
    },
  };
  return Object.assign(port, { journal, admittedInFlight });
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary:
 *
 *  - POST /executions — the racing arbitration (the first insert's
 *    synchronous critical section wins; the concurrent loser replays
 *    the winner's receipt; a different fingerprint under the same key
 *    gets the typed 409 IDEMPOTENCY_KEY_REUSED);
 *  - GET /executions/:id — the admitted lanes' reads observe the
 *    settled terminal; the over-ceiling lanes observe CREATED (the
 *    admission shaping simulated at the platform's authorize step,
 *    which the first read observes);
 *  - GET /executions/:id/events — the durable event ledger, including
 *    the execution.policy-denied envelope on the denied lanes;
 *  - GET /executions/:id/results — the settled result with the PASS
 *    verification statuses.
 *
 * Discrimination variants: `leakyRace` double-admits racing creates
 * (the app's racing contract FAILS); `ceiling` shapes admission (the
 * app observes the typed denial envelopes); `terminal` overrides the
 * admitted lanes' terminal (a FAILED platform outcome fails the app).
 */
export function createConcurrencyFakeApiWorld(options: {
  readonly ceiling?: number;
  readonly leakyRace?: boolean;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly clock: TickClock;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const admitted = new Set<string>();
  const decisions = new Map<string, "admitted" | "denied">();
  let sequence = 0;
  let createdExecutions = 0;
  const terminal = options.terminal ?? "COMPLETED";
  const clock = options.clock;

  /**
   * The admission gate (the scripted arbitration the fake provides —
   * the platform's own scheduler choice is the variable under
   * observation, verified against the REAL invariants): the shaping
   * decision is made STICKILY at CREATE time — the first `ceiling`
   * lanes of the wave (by arrival at the critical section) admit while
   * the previously-admitted lanes are still IN FLIGHT; the rest deny
   * with the durable execution.policy-denied envelope. The prune (the
   * slot release) only fires when a LATER submission arrives after the
   * admitted lanes settled — the slot-release shape.
   */
  const shapeAtCreate = (executionId: string): void => {
    if (options.ceiling === undefined) {
      return;
    }
    for (const id of [...admitted]) {
      const row = rows.get(id);
      if (row !== undefined && TERMINAL.has(row.status)) {
        admitted.delete(id);
      }
    }
    if (admitted.size >= options.ceiling) {
      decisions.set(executionId, "denied");
      const row = rows.get(executionId);
      if (row !== undefined) {
        row.events.push(ADMISSION_DENIED_EVENT_TYPE);
      }
      return;
    }
    decisions.set(executionId, "admitted");
    admitted.add(executionId);
  };

  /** Reveal a lane's sticky admission decision (the envelope on denials). */
  const revealDecision = (executionId: string): "admitted" | "denied" | "ungated" => {
    if (options.ceiling === undefined) {
      return "ungated";
    }
    const decided = decisions.get(executionId);
    if (decided === "denied") {
      const row = rows.get(executionId);
      if (row !== undefined && !row.events.includes(ADMISSION_DENIED_EVENT_TYPE)) {
        row.events.push(ADMISSION_DENIED_EVENT_TYPE);
      }
      return "denied";
    }
    return "admitted";
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
      const existing = options.leakyRace === true ? undefined : records.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          return jsonResponse(409, {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            retryable: false,
          });
        }
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
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        status: "CREATED",
        createdAt: clock.now().getTime(),
        events: ["execution.created"],
      });
      records.set(key, { fingerprint, executionId: id });
      shapeAtCreate(id);
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
      const decision = revealDecision(row.id);
      // The ungated (or admitted) lane settles on the read path (the
      // fake simulates the platform driving's completion); the denied
      // lane STAYS CREATED — dispatch remains impossible, zero effects.
      if (row.status === "CREATED" && decision !== "denied") {
        row.status = terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "concurrency-soak.settlement.v1", input: "settlement" },
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
      revealDecision(row.id);
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
      revealDecision(row.id);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "concurrency-soak",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "40", currency: "usd" } : null,
        usage: pass ? { inputTokens: 30, outputTokens: 6 } : null,
        outputArtifacts: [],
        verification:
          options.verificationStatuses === undefined
            ? [
                {
                  id: "v1",
                  executionId: row.id,
                  criterionId: "row-effect-multiplicity-exactly-once",
                  strategy: "deterministic",
                  status: "PASS",
                  recordedBy: "fake-platform",
                },
              ]
            : options.verificationStatuses.map((status, index) => ({
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
