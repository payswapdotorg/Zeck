/**
 * The longitudinal-baseline application's deterministic fixtures
 * (VAL-030, AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the frozen-artifact world — the content-addressed manifest
 *     fixtures: the append-only frozen-baseline registry (a correction
 *     is a NEW workload revision; an edit of a committed pin is
 *     refused) plus the `admitEdits` variant that OVERWRITES a
 *     committed revision (the registry-edit discrimination catch), and
 *     the default registry that commits the whole corpus together with
 *     the superseded RAG revision 1 — the append-only correction
 *     history frozen as fixture facts;
 *   * the fake longitudinal ledger — the exactly-once
 *     longitudinal-experiment identity per control run (the first
 *     observation RECORDS the identity, a same-content re-observation
 *     REPLAYS it, a different-content re-observation is REFUSED — the
 *     identity's content is immutable), plus the LEAKY variant that
 *     admits DUPLICATE identities for one control run (the
 *     exactly-once discrimination catch);
 *   * the fake recorder — the trajectory capture with deterministic
 *     digests (the first capture per execution is the immutable
 *     recorded baseline; a re-run captures a fresh trajectory), plus
 *     the DRIFT variants: `rerun` drifts the re-run's captured
 *     trajectory (the re-run equivalence catch) and `recorded` drifts
 *     the recorded baseline itself (the freeze-integrity catch);
 *   * the inert-learning fake — the competence-system gate every
 *     dispatch round passes: every round FRESH, no caching hints, no
 *     verification shortcut (learning explicitly INERT), plus the
 *     CONTAMINATED variants (`trajectory-reuse` — the round is served
 *     from a reuse cache and dispatches nothing; `caching-hint` — the
 *     round dispatches WITH a hint; `competence-shortcut` — the
 *     verification boundary is shortcircuited);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam: the create/replay semantics at the POST
 *     boundary, the honest terminal shapes at the read boundary, the
 *     canonical trajectory events at the events read (the app
 *     mechanically re-derives the platform's own trajectory digest),
 *     and the discrimination knobs (a contaminated run that
 *     under-dispatches; a drifting recorder between re-runs; a LEAKY
 *     ledger that mints a second execution on the re-issued key).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  BaselineManifestEntry,
  BaselineRegistryEntry,
  BaselineWorkloadRevision,
  ControlLearningPort,
  ControlRecorderPort,
  ControlRoundMode,
  FrozenBaselineRegistryPort,
  LearningContaminationKind,
  LedgerObservation,
  LongitudinalCorpusRow,
  LongitudinalLedgerFacts,
  LongitudinalLedgerPort,
  RecordedTrajectory,
  TrajectoryStepRecord,
} from "../../platform/longitudinal-baseline";
import {
  controlIdentityIdOf,
  controlTrajectoryStepsOf,
  trajectoryDigestOf,
  trajectoryEventsOf,
} from "../../platform/longitudinal-baseline";
import { baselineManifestFor, LONGITUDINAL_CORPUS } from "./corpus";

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
// The frozen-artifact world (the content-addressed manifest registry)
// ---------------------------------------------------------------------------

/** The fake append-only frozen-baseline registry (with its observable count). */
export interface FakeBaselineRegistry extends FrozenBaselineRegistryPort {
  /** The committed entries in commit order (the append-only history). */
  readonly committed: readonly BaselineRegistryEntry[];
}

/**
 * Create the frozen-baseline registry fixture. The registry is
 * APPEND-ONLY: a commit for a new pin appends; an identical re-commit
 * is idempotent; a DIFFERENT manifest under an already-committed pin
 * is REFUSED (a correction must be a NEW workload revision — never an
 * edit). The `admitEdits` variant is the ADVERSARIAL registry that
 * OVERWRITES the committed revision in place (the registry-edit
 * discrimination catch — the freeze-integrity derivation must FAIL it).
 */
export function createFrozenBaselineRegistry(options?: {
  readonly admitEdits?: boolean;
}): FakeBaselineRegistry {
  const entries: BaselineRegistryEntry[] = [];
  const pinOf = (manifest: BaselineManifestEntry): string =>
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
        if (options?.admitEdits !== true) {
          throw new Error(
            `append-only violation: the pin ${pin} is already committed with different content — ` +
              "a correction must be a NEW workload revision, never an edit",
          );
        }
        // The ADVERSARIAL registry: the forbidden edit overwrites the
        // committed revision (the freeze-integrity catch).
        const edited: BaselineRegistryEntry = {
          workloadRevision: manifest.workloadRevision,
          manifest,
          committedAt,
        };
        entries[existingIndex] = edited;
        return edited;
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
    get committed() {
      return [...entries];
    },
  };
}

/**
 * The superseded RAG workload revision 1 — the correction history the
 * default registry freezes BEFORE the corrected revision 2 (the
 * append-only discipline as fixture facts: revision 1 stays intact and
 * verifiable after the correction).
 */
export const SUPERSEDED_RAG_WORKLOAD: BaselineWorkloadRevision = {
  workloadId: "golden:rag-retrieval",
  revision: 1,
  dispatchRounds: 2,
  quotaMicro: 6_000,
  effects: [
    { effect: "rag:citations-attached", key: "CIT-201", amountMicro: 2_000 },
    { effect: "rag:index-updated", key: "IDX-201", amountMicro: 800 },
  ],
};

/** The superseded RAG revision-1 manifest (the registry's first commit). */
export const SUPERSEDED_RAG_MANIFEST: BaselineManifestEntry = baselineManifestFor(
  {
    appId: "portfolio:rag",
    appVersion: "v1",
    taskKind: "rag.retrieve.v1",
    integrationSurface: "sdk",
  },
  SUPERSEDED_RAG_WORKLOAD,
);

/**
 * Create the default frozen-baseline registry: the superseded RAG
 * revision 1 committed FIRST (the correction history), then every
 * corpus row's manifest in corpus order — deterministic, committed with
 * repository-reproducible stamps.
 */
export function createDefaultFrozenBaselineRegistry(): FakeBaselineRegistry {
  const registry = createFrozenBaselineRegistry();
  registry.commit(SUPERSEDED_RAG_MANIFEST, "2025-01-01T00:00:00.000Z");
  for (const [index, row] of LONGITUDINAL_CORPUS.entries()) {
    registry.commit(row.manifest, `2025-01-01T00:${String(index + 1).padStart(2, "0")}:00.000Z`);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// The fake longitudinal ledger (exactly-once identity per experiment key)
// ---------------------------------------------------------------------------

/** The fake longitudinal ledger (with its own facts view). */
export interface FakeLongitudinalLedger extends LongitudinalLedgerPort {
  facts(): LongitudinalLedgerFacts;
}

/**
 * Create the fake longitudinal ledger: ONE immutable
 * longitudinal-experiment identity per control run (the VAL-007
 * discipline). The first observation RECORDS the identity (the stable
 * derived form); a same-content re-observation REPLAYS it (never a
 * second identity); a different-content re-observation is REFUSED (the
 * identity's content is immutable). The `leaky` variant is the
 * ADVERSARIAL ledger that admits DUPLICATE identities for one control
 * run (the exactly-once discrimination catch).
 */
export function createFakeLongitudinalLedger(options?: {
  readonly leaky?: boolean;
}): FakeLongitudinalLedger {
  const identities: {
    readonly identityId: string;
    readonly runKey: string;
    readonly contentDigest: string;
  }[] = [];
  let duplicates = 0;
  return {
    async observeControlRun({ runKey, contentDigest }): Promise<LedgerObservation> {
      const existing = identities.find((identity) => identity.runKey === runKey);
      if (existing !== undefined && options?.leaky !== true) {
        if (existing.contentDigest === contentDigest) {
          return {
            identityId: existing.identityId,
            replayed: true,
            refused: false,
            contentDigest,
          };
        }
        // The identity's content is IMMUTABLE — the honest refusal.
        return {
          identityId: existing.identityId,
          replayed: false,
          refused: true,
          contentDigest,
        };
      }
      // A fresh key — or the LEAKY duplicate the adversarial ledger mints.
      duplicates += 1;
      const identityId =
        existing === undefined
          ? controlIdentityIdOf(runKey)
          : `${controlIdentityIdOf(runKey)}-dup-${duplicates}`;
      identities.push({ identityId, runKey, contentDigest });
      return { identityId, replayed: false, refused: false, contentDigest };
    },
    facts(): LongitudinalLedgerFacts {
      return { identities: [...identities] };
    },
  };
}

// ---------------------------------------------------------------------------
// The fake recorder (trajectory capture with deterministic digests)
// ---------------------------------------------------------------------------

/** The fake control recorder (with its observable capture count). */
export interface FakeControlRecorder extends ControlRecorderPort {
  /** The total steps captured across every capture. */
  readonly captureCount: number;
}

/**
 * Create the fake control recorder: the trajectory capture with
 * deterministic digests. The FIRST capture per execution is the
 * immutable recorded BASELINE; a re-run (a second `beginCapture`)
 * captures a fresh trajectory the equivalence derivation judges.
 *
 * The DRIFT variants are the ADVERSARIAL recorder shapes: `rerun`
 * drifts the RE-RUN's captured trajectory (a step's detail mutates
 * post-capture — the re-run equivalence catch) and `recorded` drifts
 * the RECORDED BASELINE itself (the freeze-integrity catch — the
 * recomputed digest disagrees with the digest declared at record
 * time).
 */
export function createFakeControlRecorder(options?: {
  readonly drift?: "rerun" | "recorded";
}): FakeControlRecorder {
  const baseline = new Map<string, TrajectoryStepRecord[]>();
  const latest = new Map<string, TrajectoryStepRecord[]>();
  const captureCounts = new Map<string, number>();
  let totalCaptures = 0;

  /** The deterministic post-capture drift (the last step's detail mutates). */
  const drifted = (steps: readonly TrajectoryStepRecord[]): TrajectoryStepRecord[] =>
    steps.map((step, index) =>
      index === steps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
    );

  return {
    beginCapture(executionId) {
      captureCounts.set(executionId, (captureCounts.get(executionId) ?? 0) + 1);
      latest.set(executionId, []);
    },
    capture(executionId, step) {
      totalCaptures += 1;
      const current = latest.get(executionId);
      if (current === undefined) {
        latest.set(executionId, [step]);
        baseline.set(executionId, [step]);
        return;
      }
      current.push(step);
      if (!baseline.has(executionId)) {
        baseline.set(executionId, current);
      }
    },
    latestCapture(executionId): RecordedTrajectory | null {
      const steps = latest.get(executionId);
      if (steps === undefined || steps.length === 0) {
        return null;
      }
      const rerunHappened = (captureCounts.get(executionId) ?? 0) >= 2;
      const effective = options?.drift === "rerun" && rerunHappened ? drifted(steps) : [...steps];
      // The declared digest is the digest AT RECORD TIME (the unmutated
      // capture) — the drift is a post-capture mutation.
      return { steps: effective, declaredDigest: trajectoryDigestOf(steps) };
    },
    baselineCapture(executionId): RecordedTrajectory | null {
      const steps = baseline.get(executionId);
      if (steps === undefined || steps.length === 0) {
        return null;
      }
      const effective = options?.drift === "recorded" ? drifted(steps) : [...steps];
      return { steps: effective, declaredDigest: trajectoryDigestOf(steps) };
    },
    get captureCount() {
      return totalCaptures;
    },
  };
}

// ---------------------------------------------------------------------------
// The inert-learning fake (the competence-system gate)
// ---------------------------------------------------------------------------

/** The fake competence-system gate (with its observed rounds). */
export interface FakeInertLearning extends ControlLearningPort {
  /** The rounds the gate observed, in gate order. */
  readonly gatedRounds: readonly number[];
}

/**
 * Create the inert-learning fake: the competence-system gate every
 * dispatch round of the CONTROL run passes. The honest (inert) gate
 * returns FRESH for every round and never shortcircuits the
 * verification boundary — learning is explicitly INERT (the reference
 * arm).
 *
 * The CONTAMINATED variants are the phase-2 discrimination shapes:
 * `trajectory-reuse` (every round is served from a reuse cache — the
 * round dispatches NOTHING), `caching-hint` (every round dispatches
 * WITH a caching hint — the trajectory shape is unchanged, only the
 * inert-learning compliance catches it) and `competence-shortcut`
 * (the verification boundary is shortcircuited — the trajectory lacks
 * the verification step).
 */
export function createInertLearningFake(options?: {
  readonly contaminate?: LearningContaminationKind;
}): FakeInertLearning {
  const gatedRounds: number[] = [];
  return {
    async gateRound({ round }): Promise<{ readonly mode: ControlRoundMode }> {
      gatedRounds.push(round);
      if (options?.contaminate === "trajectory-reuse") {
        return { mode: "reused" };
      }
      if (options?.contaminate === "caching-hint") {
        return { mode: "hinted" };
      }
      return { mode: "fresh" };
    },
    verificationShortcut(): boolean {
      return options?.contaminate === "competence-shortcut";
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
export interface FakeControlExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
  /** Whether the submission key was re-issued (the drift knob's trigger). */
  replayed: boolean;
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * control-run semantics at the customer boundary:
 *
 *  - POST /executions — the create/replay semantics (the first
 *    insert's synchronous critical section wins; a same-fingerprint
 *    re-issue REPLAYS the committed receipt with identity preserved; a
 *    different fingerprint gets the typed 409 IDEMPOTENCY_KEY_REUSED);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (the fake simulates the platform driving the
 *    control run to completion), never backwards;
 *  - GET /executions/:id/events — the row's canonical control
 *    trajectory surfaced as the public step-event journal (the app
 *    mechanically re-derives the platform's own trajectory digest over
 *    this read — never trusting the platform's claim);
 *  - GET /executions/:id/results — the honest control-run result: the
 *    route's modelCalls (the control run's OWN dispatches), the honest
 *    verification statuses and honestly-absent offline usage.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `trajectoryVariant` selects the equivalent effect ordering (the
 * equivalence-class rows); `contaminatedLearning` makes the run
 * UNDER-DISPATCH (zero model calls, no dispatch events — the reuse
 * shape the inert contract catches); `driftRecorder` drifts the
 * trajectory events AFTER a re-issue (the drift-between-re-runs catch);
 * `leakyLedger` mints a SECOND execution on the re-issued key (the
 * ledger-duplication catch at the customer boundary).
 */
export function createLongitudinalFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The equivalent effect-ordering index (the equivalence-class rows). */
  readonly trajectoryVariant?: number;
  /** The adversarial knob: the run under-dispatches (the reuse shape). */
  readonly contaminatedLearning?: boolean;
  /** The adversarial knob: the events drift after a re-issue. */
  readonly driftRecorder?: boolean;
  /** The adversarial knob: a re-issued key mints a SECOND execution. */
  readonly leakyLedger?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeControlExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeControlExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string): LongitudinalCorpusRow | null =>
    LONGITUDINAL_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The row's effective effect ordering (the variant knob). */
  const effectOrderFor = (row: LongitudinalCorpusRow): readonly number[] => {
    if (row.effectOrderings === undefined) {
      return row.workload.effects.map((_, index) => index);
    }
    return row.effectOrderings[options.trajectoryVariant ?? 0] ?? row.effectOrderings[0] ?? [];
  };

  /**
   * The row's honest control-trajectory events: the canonical steps
   * under the effective ordering (the contaminated knob drops the
   * dispatch events — the reused run made no fresh dispatches).
   */
  const eventsFor = (row: FakeControlExecutionRow, drifted: boolean): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    let steps = controlTrajectoryStepsOf({
      workload: corpusRow.workload,
      effectOrder: effectOrderFor(corpusRow),
    });
    if (options.contaminatedLearning === true) {
      steps = steps.filter((step) => step.kind !== "dispatch");
    }
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

  /** The row's honest model-call count (the contaminated knob under-dispatches). */
  const modelCallsFor = (rowId: string): number => {
    const corpusRow = rowById(rowId);
    if (corpusRow === null) {
      return 0;
    }
    return options.contaminatedLearning === true ? 0 : corpusRow.expectedModelCalls;
  };

  /** The row's honest verification statuses (the anyFail discipline). */
  const verificationFor = (rowId: string): string[] => {
    const corpusRow = rowById(rowId);
    if (corpusRow === null || corpusRow.expectedTerminal === "COMPLETED") {
      return ["PASS", "PASS"];
    }
    // The honest FAILED shape: the guard criterion FAILs visibly and
    // the freeze criterion PASSes (the empty trajectory verified).
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
      const existing = records.get(key);
      if (
        existing !== undefined &&
        existing.fingerprint === fingerprint &&
        options.leakyLedger !== true
      ) {
        const row = rows.get(existing.executionId);
        if (row !== undefined) {
          row.replayed = true;
        }
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
        replayed: false,
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
      // platform driving the control run) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "longitudinal-baseline.control.v1", input: "control" },
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
      // The DRIFT knob: after the submission key was re-issued (the
      // control re-run), the surfaced trajectory drifts — the
      // re-run's digest lands outside the recorded class.
      const drifted = options.driftRecorder === true && row.replayed;
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
          strategyClass: "longitudinal-baseline",
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
