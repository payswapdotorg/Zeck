/**
 * The workload-replay application's deterministic fixtures (VAL-031,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the frozen-baseline input world — VAL-030's pinned manifests as
 *     the READ-ONLY input: the append-only registry fixture commits
 *     the superseded RAG revision 1 first (the correction history,
 *     re-declared here as fixture facts exactly as VAL-030 froze it)
 *     and then every baseline manifest this corpus references — the
 *     replays never rewrite the manifests;
 *   * the fake replay ledger — ONE immutable trajectory identity per
 *     replay (the VAL-007/030 ledger discipline: the first observation
 *     RECORDS the identity, a same-content re-observation REPLAYS it,
 *     a different-content re-observation is REFUSED), plus the
 *     adversarial variants: the LEAKY ledger lets the k-th replay
 *     SHOULDER INTO the first replay's identity (the duplicate-replay
 *     catch) and the DROPPED ledger LOSES the k-th replay's
 *     observation (the dropped-replay catch);
 *   * the fake replay recorder — the trajectory capture with
 *     deterministic digests, ONE capture per replay, and the world's
 *     per-replay effect-ordering schedule (the varying rows'
 *     legitimately-varying trajectories: the scheduler picks either
 *     equivalent ordering per replay), plus the DRIFT variant that
 *     mutates the k-th replay's captured steps post-capture (the
 *     drifted-trajectory catch);
 *   * the inert-learning fake — the competence-system gate every
 *     dispatch round of every replay passes: every round FRESH, no
 *     caching hints, no verification shortcut (learning stays
 *     explicitly INERT across the whole population), plus the
 *     trajectory-reuse contamination variant (a reused round
 *     dispatches nothing — the under-dispatch catch);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam: the per-replay create semantics at the POST
 *     boundary (each replay lands its OWN durable execution), the
 *     honest terminal shapes at the read boundary, the world-scheduled
 *     trajectory events at the events read (the app mechanically
 *     re-derives the platform's own trajectory digest), and the
 *     discrimination knobs (a LEAKY ledger that binds the k-th
 *     replay's key to the first replay's execution; a DRIFTING events
 *     read for the k-th replay; a DROPPED trajectory read for the k-th
 *     replay; a SMOOTHED world that schedules the varying row's every
 *     replay identically; a terminal override).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  BaselineRegistryEntry,
  RecordedTrajectory,
  TrajectoryStepRecord,
} from "../../platform/longitudinal-baseline";
import {
  controlTrajectoryStepsOf,
  trajectoryDigestOf,
  trajectoryEventsOf,
} from "../../platform/longitudinal-baseline";
import type {
  ReplayLearningPort,
  ReplayLedgerFacts,
  ReplayLedgerPort,
  ReplayObservation,
  ReplayRecorderPort,
  WorkloadReplayCorpusRow,
} from "../../platform/workload-replay";
import { replayIdentityIdOf } from "../../platform/workload-replay";
import { baselineManifestFor } from "../longitudinal-baseline/corpus";
import { REFERENCED_BASELINE_ROWS, WORKLOAD_REPLAY_CORPUS } from "./corpus";

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
// The frozen-baseline input world (VAL-030's pinned manifests, read-only)
// ---------------------------------------------------------------------------

/**
 * The superseded RAG workload revision 1 — the correction history the
 * registry freezes BEFORE the corrected revision 2 (re-declared here
 * as fixture facts exactly as VAL-030's registry froze them: revision
 * 1 stays intact and verifiable after the correction; read-only
 * input, never rewritten by the replays).
 */
export const SUPERSEDED_RAG_WORKLOAD = {
  workloadId: "golden:rag-retrieval",
  revision: 1,
  dispatchRounds: 2,
  quotaMicro: 6_000,
  effects: [
    { effect: "rag:citations-attached", key: "CIT-201", amountMicro: 2_000 },
    { effect: "rag:index-updated", key: "IDX-201", amountMicro: 800 },
  ],
} as const;

/** The superseded RAG revision-1 manifest (the registry's first commit). */
export const SUPERSEDED_RAG_MANIFEST = baselineManifestFor(
  {
    appId: "portfolio:rag",
    appVersion: "v1",
    taskKind: "rag.retrieve.v1",
    integrationSurface: "sdk",
  },
  SUPERSEDED_RAG_WORKLOAD,
);

/**
 * Create the frozen-baseline registry fixture (the READ-ONLY input
 * world): the superseded RAG revision 1 committed FIRST (the
 * append-only correction history), then every baseline manifest the
 * replay corpus references, in reference order — deterministic,
 * committed with repository-reproducible stamps. The registry is
 * APPEND-ONLY: an identical re-commit is idempotent; a DIFFERENT
 * manifest under an already-committed pin is REFUSED (the replays
 * never rewrite the frozen baselines).
 */
export function createReplayBaselineRegistry(): {
  commit(
    manifest: {
      appId: string;
      appDigest: string;
      workloadId: string;
      workloadRevision: number;
      workloadDigest: string;
      manifestDigest: string;
    },
    committedAt: string,
  ): BaselineRegistryEntry;
  entryFor(pin: {
    appId: string;
    workloadId: string;
    workloadRevision: number;
  }): BaselineRegistryEntry | null;
  historyOf(appId: string, workloadId: string): readonly BaselineRegistryEntry[];
} {
  const entries: BaselineRegistryEntry[] = [];
  const pinOf = (manifest: { appId: string; workloadId: string; workloadRevision: number }) =>
    `${manifest.appId}|${manifest.workloadId}|r${manifest.workloadRevision}`;
  return {
    commit(manifest, committedAt) {
      const pin = pinOf(manifest);
      const existingIndex = entries.findIndex((entry) => pinOf(entry.manifest) === pin);
      if (existingIndex >= 0) {
        const existing = entries[existingIndex];
        if (existing === undefined) {
          throw new Error("the registry index is inconsistent");
        }
        if (existing.manifest.manifestDigest === manifest.manifestDigest) {
          return existing;
        }
        throw new Error(
          `append-only violation: the pin ${pin} is already committed with different content — ` +
            "a correction must be a NEW workload revision, never an edit",
        );
      }
      const entry: BaselineRegistryEntry = {
        workloadRevision: manifest.workloadRevision,
        manifest,
        committedAt,
      };
      entries.push(entry);
      return entry;
    },
    entryFor(pin) {
      return (
        entries.find(
          (entry) =>
            entry.manifest.appId === pin.appId &&
            entry.manifest.workloadId === pin.workloadId &&
            entry.workloadRevision === pin.workloadRevision,
        ) ?? null
      );
    },
    historyOf(appId, workloadId) {
      return entries.filter(
        (entry) => entry.manifest.appId === appId && entry.manifest.workloadId === workloadId,
      );
    },
  };
}

/**
 * Create the default frozen-baseline registry: the superseded RAG
 * revision 1 committed FIRST (the correction history), then every
 * referenced baseline manifest in reference order.
 */
export function createDefaultReplayBaselineRegistry() {
  const registry = createReplayBaselineRegistry();
  registry.commit(SUPERSEDED_RAG_MANIFEST, "2025-01-01T00:00:00.000Z");
  for (const [index, baseline] of REFERENCED_BASELINE_ROWS.entries()) {
    registry.commit(
      baseline.manifest,
      `2025-02-01T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
    );
  }
  return registry;
}

// ---------------------------------------------------------------------------
// The fake replay ledger (one immutable identity per replay)
// ---------------------------------------------------------------------------

/** The fake replay ledger (with its own facts view). */
export interface FakeReplayLedger extends ReplayLedgerPort {
  facts(): ReplayLedgerFacts;
}

/**
 * Create the fake replay ledger: ONE immutable trajectory identity per
 * replay (the VAL-007/030 ledger discipline). The first observation
 * RECORDS the identity (the stable derived form); a same-content
 * re-observation REPLAYS it (never a second identity); a
 * different-content re-observation is REFUSED (the identity's content
 * is immutable).
 *
 * The adversarial variants: `shoulderOrdinal` is the LEAKY ledger that
 * lets the k-th replay SHOULDER INTO the first recorded identity (the
 * duplicate-replay catch — the observation returns an existing
 * identity with `replayed: true` and records nothing); `dropOrdinal`
 * is the DROPPED ledger that LOSES the k-th replay's observation (the
 * dropped-replay catch — the observation carries no identity at all).
 */
export function createReplayLedger(options?: {
  readonly shoulderOrdinal?: number;
  readonly dropOrdinal?: number;
}): FakeReplayLedger {
  const identities: {
    readonly identityId: string;
    readonly replayKey: string;
    readonly contentDigest: string;
  }[] = [];
  const ordinalSegmentOf = (replayKey: string): string =>
    replayKey.slice(replayKey.lastIndexOf(":") + 1);
  return {
    async observeReplay({ replayKey, contentDigest }): Promise<ReplayObservation> {
      const segment = ordinalSegmentOf(replayKey);
      // The DROPPED ledger: the observation is lost — no identity lands.
      if (options?.dropOrdinal !== undefined && segment === `replay-${options.dropOrdinal}`) {
        return { contentDigest, identityId: null, replayed: false, refused: false, dropped: true };
      }
      // The LEAKY ledger: the replay shoulders into the first recorded
      // identity (a duplicate ledger identity for the population).
      if (
        options?.shoulderOrdinal !== undefined &&
        segment === `replay-${options.shoulderOrdinal}` &&
        identities.length > 0
      ) {
        const first = identities[0];
        if (first !== undefined) {
          return {
            contentDigest,
            identityId: first.identityId,
            replayed: true,
            refused: false,
            dropped: false,
          };
        }
      }
      const existing = identities.find((identity) => identity.replayKey === replayKey);
      if (existing !== undefined) {
        if (existing.contentDigest === contentDigest) {
          return {
            contentDigest,
            identityId: existing.identityId,
            replayed: true,
            refused: false,
            dropped: false,
          };
        }
        // The identity's content is IMMUTABLE — the honest refusal.
        return {
          contentDigest,
          identityId: existing.identityId,
          replayed: false,
          refused: true,
          dropped: false,
        };
      }
      const identityId = replayIdentityIdOf(replayKey);
      identities.push({ identityId, replayKey, contentDigest });
      return { contentDigest, identityId, replayed: false, refused: false, dropped: false };
    },
    facts(): ReplayLedgerFacts {
      return { identities: [...identities] };
    },
  };
}

// ---------------------------------------------------------------------------
// The fake replay recorder (deterministic digests + the world's schedule)
// ---------------------------------------------------------------------------

/** The fake replay recorder (with its observable capture count). */
export interface FakeReplayRecorder extends ReplayRecorderPort {
  /** The total steps captured across every replay. */
  readonly captureCount: number;
}

/**
 * Create the fake replay recorder: the trajectory capture with
 * deterministic digests, ONE capture per replay. `replayOrderPlan` is
 * the WORLD's per-replay effect-ordering schedule (the varying rows'
 * legitimately-varying trajectories: the scheduler picks
 * `plan[(ordinal - 1) % length]` for each replay and the captured
 * effect steps are re-scheduled accordingly — every replay's digest is
 * still a member of the pinned equivalence class, but the population
 * honestly VARIES).
 *
 * The DRIFT variant is the ADVERSARIAL recorder shape: `driftOrdinal`
 * mutates the k-th replay's captured steps post-capture (the last
 * step's detail mutates — the declared digest stays at record time, so
 * the recomputed digest drifts OUT of the pinned class: the
 * drifted-trajectory catch).
 */
export function createReplayRecorder(options?: {
  readonly driftOrdinal?: number;
  readonly replayOrderPlan?: readonly (readonly number[])[];
}): FakeReplayRecorder {
  const captures = new Map<string, TrajectoryStepRecord[]>();
  let totalCaptures = 0;
  const keyOf = (executionId: string, replayOrdinal: number) =>
    `${executionId}|replay-${replayOrdinal}`;

  /** The world-scheduled trajectory for one replay (the plan re-orders the effect steps). */
  const scheduled = (steps: readonly TrajectoryStepRecord[], replayOrdinal: number) => {
    const plan = options?.replayOrderPlan;
    if (plan === undefined || plan.length === 0) {
      return [...steps];
    }
    const order = plan[(replayOrdinal - 1) % plan.length];
    if (order === undefined) {
      return [...steps];
    }
    const dispatches = steps.filter((step) => step.kind === "dispatch");
    const effects = steps.filter((step) => step.kind === "effect");
    const verifications = steps.filter((step) => step.kind === "verification");
    return [
      ...dispatches,
      ...order.flatMap((index) => (effects[index] === undefined ? [] : [effects[index]])),
      ...verifications,
    ].map((step, index) => ({ ...step, ordinal: index + 1 }));
  };

  return {
    beginReplayCapture(executionId, replayOrdinal) {
      captures.set(keyOf(executionId, replayOrdinal), []);
    },
    capture(executionId, replayOrdinal, step) {
      totalCaptures += 1;
      const current = captures.get(keyOf(executionId, replayOrdinal));
      if (current === undefined) {
        captures.set(keyOf(executionId, replayOrdinal), [step]);
        return;
      }
      current.push(step);
    },
    replayCapture(executionId, replayOrdinal): RecordedTrajectory | null {
      const steps = captures.get(keyOf(executionId, replayOrdinal));
      if (steps === undefined || steps.length === 0) {
        return null;
      }
      const worldSteps = scheduled(steps, replayOrdinal);
      // The declared digest is the digest AT RECORD TIME (the
      // unmutated world-scheduled capture) — the drift is a
      // post-capture mutation.
      const declaredDigest = trajectoryDigestOf(worldSteps);
      if (options?.driftOrdinal === replayOrdinal) {
        const drifted = worldSteps.map((step, index) =>
          index === worldSteps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
        );
        return { steps: drifted, declaredDigest };
      }
      return { steps: worldSteps, declaredDigest };
    },
    get captureCount() {
      return totalCaptures;
    },
  };
}

// ---------------------------------------------------------------------------
// The inert-learning fake (the competence-system gate stays INERT)
// ---------------------------------------------------------------------------

/** The fake inert-learning gate (with its observed rounds). */
export interface FakeInertReplayLearning extends ReplayLearningPort {
  /** The rounds the gate observed, in gate order. */
  readonly gatedRounds: readonly number[];
}

/**
 * Create the inert-learning fake: the competence-system gate every
 * dispatch round of every replay passes. The honest (inert) gate
 * returns FRESH for every round and never shortcircuits the
 * verification boundary — learning stays explicitly INERT across the
 * whole replay population (the pre-learning reference facts).
 *
 * The CONTAMINATED variant is the discrimination shape:
 * `trajectory-reuse` (every round is served from a reuse cache — the
 * round dispatches NOTHING, the population under-dispatches).
 */
export function createInertReplayLearning(options?: {
  readonly contaminate?: "trajectory-reuse";
}): FakeInertReplayLearning {
  const gatedRounds: number[] = [];
  return {
    async gateRound({ round }) {
      gatedRounds.push(round);
      if (options?.contaminate === "trajectory-reuse") {
        return { mode: "reused" };
      }
      return { mode: "fresh" };
    },
    verificationShortcut() {
      return false;
    },
    get gatedRounds() {
      return [...gatedRounds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/** One durable execution row the fake API world holds. */
export interface FakeReplayExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  /** The replay ordinal the submission's task body carried. */
  readonly replayOrdinal: number;
  status: string;
  readonly createdAt: number;
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * replay-population semantics at the customer boundary:
 *
 *  - POST /executions — the per-replay create semantics (each replay
 *    lands its OWN durable execution under its OWN idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (the fake simulates the platform driving each
 *    replay to completion), never backwards;
 *  - GET /executions/:id/events — the world-scheduled control
 *    trajectory surfaced as the public step-event journal (the varying
 *    rows' per-replay equivalent orderings; the app mechanically
 *    re-derives the platform's own trajectory digest over this read);
 *  - GET /executions/:id/results — the honest per-replay result: the
 *    route's modelCalls (each replay's OWN dispatches), the honest
 *    verification statuses and honestly-absent offline usage.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `driftOrdinal` drifts the k-th replay's trajectory events (the
 * drifted-trajectory catch); `dropOrdinal` loses the k-th replay's
 * trajectory read (a 404 — the partial-population catch);
 * `leakyOrdinal` binds the k-th replay's submission key to the FIRST
 * replay's execution (the duplicate-replay catch at the customer
 * boundary); `smoothedVariance` schedules the varying row's EVERY
 * replay identically (the fabricated-determinism catch: the observed
 * distribution loses its variance and mismatches the pin).
 */
export function createWorkloadReplayFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The adversarial knob: the k-th replay's events drift. */
  readonly driftOrdinal?: number;
  /** The adversarial knob: the k-th replay's trajectory read is lost. */
  readonly dropOrdinal?: number;
  /** The adversarial knob: the k-th replay's key binds the FIRST execution. */
  readonly leakyOrdinal?: number;
  /** The adversarial knob: the varying row's replays are all scheduled identically. */
  readonly smoothedVariance?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeReplayExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeReplayExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string): WorkloadReplayCorpusRow | null =>
    WORKLOAD_REPLAY_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The world's per-replay effect ordering for one corpus row. */
  const scheduleFor = (row: WorkloadReplayCorpusRow, replayOrdinal: number): readonly number[] => {
    const declarationOrder = row.workload.effects.map((_, index) => index);
    if (row.replayOrderings === undefined || row.replayOrderings.length === 0) {
      return row.effectOrderings?.[0] ?? declarationOrder;
    }
    if (options.smoothedVariance === true) {
      // The SMOOTHED world: every replay of a varying row is scheduled
      // identically — the population loses its legitimate variance.
      return row.replayOrderings[0] ?? declarationOrder;
    }
    return (
      row.replayOrderings[(replayOrdinal - 1) % row.replayOrderings.length] ?? declarationOrder
    );
  };

  /**
   * The row's honest world-scheduled trajectory events: the canonical
   * steps under the per-replay schedule (the drift knob mutates the
   * last step post-read).
   */
  const eventsFor = (row: FakeReplayExecutionRow, drifted: boolean): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    let steps = controlTrajectoryStepsOf({
      workload: corpusRow.workload,
      effectOrder: scheduleFor(corpusRow, row.replayOrdinal),
    });
    if (drifted) {
      steps = steps.map((step, index) =>
        index === steps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
      );
    }
    return trajectoryEventsOf(steps).map((event, index) => ({
      eventId: `${row.id}-ev-${index + 1}`,
      executionId: row.id,
      type: event.type,
      sequence: event.sequence,
      occurredAt: new Date(row.createdAt + index).toISOString(),
      payload: {},
    }));
  };

  /** The row's honest per-replay model-call count. */
  const modelCallsFor = (rowId: string): number => {
    const corpusRow = rowById(rowId);
    return corpusRow === null ? 0 : corpusRow.expectedModelCallsPerReplay;
  };

  /** The row's honest verification statuses (the anyFail discipline). */
  const verificationFor = (rowId: string): string[] => {
    const corpusRow = rowById(rowId);
    if (corpusRow === null || corpusRow.expectedTerminal === "COMPLETED") {
      return ["PASS", "PASS"];
    }
    // The honest FAILED shape: the guard criterion FAILs visibly and
    // the population criterion PASSes (the empty trajectory verified).
    return ["FAIL", "PASS"];
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
      const fingerprint = JSON.stringify(body ?? null);
      const task = (body.task ?? null) as { rowId?: unknown; replay?: unknown } | null;
      const taskRowId = String(task?.rowId ?? "");
      const replayOrdinal = Number(task?.replay ?? 0);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row = rows.get(existing.executionId);
        if (row !== undefined) {
          return jsonResponse(201, {
            executionId: row.id,
            applicationId: body.applicationId ?? "app-1",
            status: row.status,
            createdAt: new Date(row.createdAt).toISOString(),
            replayed: true,
            lastEventSequence: 1,
          });
        }
      }
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          retryable: false,
        });
      }
      // The LEAKY ledger knob: the k-th replay's key binds the FIRST
      // replay's durable execution — the shoulder-in at the customer
      // boundary (a duplicate replay identity).
      if (options.leakyOrdinal === replayOrdinal && rows.size > 0) {
        const first = [...rows.values()].find((candidate) => candidate.replayOrdinal === 1);
        if (first !== undefined) {
          records.set(key, { fingerprint, executionId: first.id });
          return jsonResponse(201, {
            executionId: first.id,
            applicationId: body.applicationId ?? "app-1",
            status: first.status,
            createdAt: new Date(first.createdAt).toISOString(),
            replayed: true,
            lastEventSequence: 1,
          });
        }
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        taskRowId,
        replayOrdinal,
        status: "CREATED",
        createdAt: clock.now().getTime(),
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
      const corpusRow = rowById(row.taskRowId);
      const honestTerminal =
        corpusRow === null ? "FAILED" : (options.terminal ?? corpusRow.expectedTerminal);
      // The row settles on the read path (the fake simulates the
      // platform driving the replay) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "workload-replay.population.v1", input: "replay" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt:
          row.status === "COMPLETED" || row.status === "FAILED"
            ? new Date(clock.now().getTime()).toISOString()
            : null,
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
      // The DROP knob: the k-th replay's trajectory read is lost — the
      // population read shows a gap (the partial-population catch).
      if (options.dropOrdinal === row.replayOrdinal) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution events not found (the replay's trajectory read was dropped)",
          retryable: false,
        });
      }
      // The DRIFT knob: the k-th replay's surfaced trajectory drifts —
      // its digest lands outside the pinned class.
      const drifted = options.driftOrdinal === row.replayOrdinal;
      return jsonResponse(200, eventsFor(row, drifted));
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
      const corpusRow = rowById(row.taskRowId);
      const pass = row.status === "COMPLETED";
      const needsDispatch = corpusRow?.needsDispatch ?? false;
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "workload-replay",
          modelCalls: modelCallsFor(row.taskRowId),
        },
        cost: pass && needsDispatch ? { totalMicroUsd: "40", currency: "usd" } : null,
        usage: needsDispatch ? { inputTokens: 30, outputTokens: 6 } : null,
        outputArtifacts: [],
        verification: verificationFor(row.taskRowId).map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        warnings: [],
        terminalAt:
          row.status === "COMPLETED" || row.status === "FAILED"
            ? new Date(clock.now().getTime()).toISOString()
            : null,
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
