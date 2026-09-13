/**
 * The equivalence-testing application's deterministic fixtures (VAL-033,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fake candidate registry — VAL-032's proposals pre-seeded
 *     as the READ-ONLY input (the registry identities the corpus
 *     pins, re-derived exactly as VAL-032 recorded them, plus the
 *     fixture-only degenerate entries the refusal rows refuse
 *     honestly). The registry is never rewritten by an honest run;
 *     the LEAKY ledger variant reaches into its store and REWRITES a
 *     proposal's entry (the read-only catch);
 *   * the fake lifecycle ledger — APPEND-ONLY verdicts: the
 *     offline-replayed + differentially-evaluated transitions with
 *     their evidence digests (identical re-appends REPLAY; a
 *     different transition under a recorded key is REFUSED). The
 *     adversarial variants are the discrimination shapes:
 *     `skip-to-promoted` lands the append at `promoted` (a
 *     skipped-stage promotion), `skip-offline-replay` drops the
 *     offline-replayed transition (a jumped rung), `evidence-less`
 *     appends without evidence, and `rewrite-registry` REWRITES the
 *     registry's own proposal entry on append (a proposal rewrite —
 *     the verdict APPENDS, never rewrites);
 *   * the fake incumbent executor — deterministic per-case digests
 *     delegating to the population's pinned incumbent digests; the
 *     DIVERGENT variant perturbs the served digest on the last case
 *     (a drifted serve: the read-only population pin catch);
 *   * the fake replacement runtime — the ISOLATED untrusted-code
 *     seam delegating to the platform's PURE honest replacement
 *     derivation; the adversarial variants are the discrimination
 *     shapes: ESCAPING (the untrusted code exercises network access —
 *     a containment violation), UNCITED (the verdict cites no
 *     proposal — a broken provenance chain), PARTIAL (the evaluation
 *     drops the pinned adversarial cases — a partial population),
 *     UNCHECKED (the criterion is stated but nothing is checked) and
 *     SMOOTHING (a perturbed case is claimed equivalent — a smoothed
 *     divergence);
 *   * the fake API world — the transport-level fake implementing the
 *     platform's OWN equivalence semantics at the customer boundary,
 *     with the same discrimination knobs;
 *   * the tick clock — the deterministic injectable clock.
 *
 * Everything is digests and identities — payload bytes never enter
 * the fixtures, and no credential is ever read.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  CandidateLifecycleLedgerPort,
  CandidateRegistryReadPort,
  DifferentialCase,
  EquivalenceRegistryFacts,
  EquivalenceVerdictKind,
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
  ReplacementRunOutcome,
  ReplacementRuntimePort,
} from "../../platform/equivalence-testing";
import {
  deriveHonestReplacementRun,
  differentialPopulationDigestOf,
  EQUIVALENT_STAGE,
  equivalenceRegistryDigestOf,
  equivalenceTrajectoryStepsOf,
  OFFLINE_REPLAY_STAGE,
} from "../../platform/equivalence-testing";
import type { DiscoveryProposalRecord } from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import {
  EQUIVALENCE_TESTING_CORPUS,
  PINNED_REGISTRY_ENTRIES,
  pinnedRunOf,
  type SourceProposalPin,
} from "./corpus";

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
// The fake candidate registry (VAL-032's proposals, read-only)
// ---------------------------------------------------------------------------

/** The fake candidate registry (with its own read-only facts view). */
export interface FakeCandidateRegistry extends CandidateRegistryReadPort {
  /** The full read-only fingerprint (the registry-unchanged snapshot basis). */
  digest(): string;
  /** The stored entries (the internally-mutable store the LEAKY ledger reaches). */
  store(): Map<string, SourceProposalPin>;
}

/**
 * Create the fake candidate registry: pre-seeded with the corpus's
 * pinned VAL-032 proposals (the registry identities the rows test —
 * read-only inputs, never rewritten by an honest run). The store is
 * internally mutable ONLY so the LEAKY ledger variant can perform its
 * rewrite (the discrimination shape the read-only discipline catches).
 */
export function createCandidateRegistry(): FakeCandidateRegistry {
  const entries = new Map<string, SourceProposalPin>();
  for (const pin of PINNED_REGISTRY_ENTRIES) {
    entries.set(pin.proposalId, { ...pin });
  }
  const facts = (): EquivalenceRegistryFacts => ({
    proposals: [...entries.values()]
      .map((pin) => ({
        proposalId: pin.proposalId,
        kind: pin.kind,
        lifecycleStage: pin.lifecycleStage,
        citationDigest: longitudinalDigestOf([
          pin.citation.trajectoryDigests,
          pin.citation.replayIdentities,
        ]),
      }))
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
    appliedCandidateCount: [...entries.values()].filter((pin) => pin.lifecycleStage !== "proposed")
      .length,
  });
  return {
    proposalFor(proposalId: string): DiscoveryProposalRecord | null {
      const pin = entries.get(proposalId);
      if (pin === undefined) {
        return null;
      }
      return {
        proposalId: pin.proposalId,
        kind: pin.kind,
        citation: {
          trajectoryDigests: [...pin.citation.trajectoryDigests],
          replayIdentities: [...pin.citation.replayIdentities],
        },
        minedStructureDigest: pin.minedStructureDigest,
        lifecycleStage: pin.lifecycleStage,
      };
    },
    facts,
    digest() {
      return equivalenceRegistryDigestOf(facts());
    },
    store() {
      return entries;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake lifecycle ledger (append-only + the adversarial variants)
// ---------------------------------------------------------------------------

/** The fake ledger's adversarial variants (the discrimination shapes). */
export type FakeLedgerVariant =
  | "skip-to-promoted"
  | "skip-offline-replay"
  | "evidence-less"
  | "rewrite-registry";

/** The fake candidate lifecycle ledger (with its own transitions view). */
export interface FakeLifecycleLedger extends CandidateLifecycleLedgerPort {
  /** The proposals whose verdicts landed, in append order. */
  readonly landedProposalIds: readonly string[];
}

/**
 * Create the fake candidate lifecycle ledger: APPEND-ONLY verdicts —
 * the equivalence walk's `offline-replayed` and
 * `differentially-evaluated` transitions with their evidence digests
 * (an IDENTICAL re-append REPLAYS idempotently; a DIFFERENT
 * transition under a recorded (proposalId, stage) key is REFUSED).
 * The ledger never rewrites a proposal; the adversarial variants are
 * the discrimination shapes the stage-discipline / read-only
 * derivations catch:
 *
 *   * `skip-to-promoted` — every append lands at `promoted` (a
 *     skipped-stage promotion: the walk jumps past the equivalence
 *     stage);
 *   * `skip-offline-replay` — the `offline-replayed` append is
 *     dropped (the walk jumps a rung);
 *   * `evidence-less` — the transitions append without their evidence
 *     digests;
 *   * `rewrite-registry` — the append REWRITES the registry's own
 *     proposal entry (mutating the read-only input).
 */
export function createLifecycleLedger(options?: {
  readonly variant?: FakeLedgerVariant;
  /** The read-only registry the rewrite variant reaches into (frozen state). */
  readonly registry?: FakeCandidateRegistry;
}): FakeLifecycleLedger {
  const transitions: LifecycleTransitionRecord[] = [];
  const ordinals = new Map<string, number>();
  const landed: string[] = [];
  const variant = options?.variant;

  const rewriteRegistry = (proposalId: string): void => {
    const registry = options?.registry;
    if (registry === undefined) {
      return;
    }
    const entry = registry.store().get(proposalId);
    if (entry !== undefined) {
      // The REWRITE: the registry's own proposal entry is mutated —
      // a frozen recorded fact.
      registry.store().set(proposalId, { ...entry, lifecycleStage: "promoted" });
    }
  };

  return {
    async append(record) {
      if (variant === "skip-offline-replay" && record.toStage === OFFLINE_REPLAY_STAGE) {
        // The dropped rung: the offline-replayed transition never lands.
        return { accepted: true, replayed: false, refused: false };
      }
      const landedStage = variant === "skip-to-promoted" ? ("promoted" as const) : record.toStage;
      const evidenceDigest = variant === "evidence-less" ? "" : record.evidenceDigest;
      const _key = `${record.proposalId}:${landedStage}`;
      const existing = transitions.find(
        (transition) =>
          transition.proposalId === record.proposalId && transition.toStage === landedStage,
      );
      if (existing !== undefined) {
        if (existing.evidenceDigest === evidenceDigest) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      if (variant === "rewrite-registry") {
        rewriteRegistry(record.proposalId);
      }
      const ordinal = (ordinals.get(record.proposalId) ?? 0) + 1;
      ordinals.set(record.proposalId, ordinal);
      const transition: LifecycleTransitionRecord = {
        proposalId: record.proposalId,
        toStage: landedStage,
        evidenceDigest,
        ordinal,
      };
      transitions.push(transition);
      if (!landed.includes(record.proposalId)) {
        landed.push(record.proposalId);
      }
      return { accepted: true, replayed: false, refused: false };
    },
    transitionsFor(proposalId: string) {
      return transitions
        .filter((transition) => transition.proposalId === proposalId)
        .map((transition) => ({ ...transition }));
    },
    get landedProposalIds() {
      return [...landed];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake incumbent executor (deterministic + the DIVERGENT variant)
// ---------------------------------------------------------------------------

/** The fake incumbent executor (the incumbent AI implementation seam). */
export interface FakeIncumbentExecutor extends IncumbentExecutorPort {
  /** The case ids served, in serve order. */
  readonly servedCaseIds: readonly string[];
}

/**
 * Create the fake incumbent executor: deterministic per-case digests
 * delegating to each case's pinned incumbent digest (the recorded
 * historical digest / the pinned adversarial member — the read-only
 * input). The DIVERGENT variant perturbs the served digest on the
 * LAST case (a drifted serve: the population pin catch).
 */
export function createIncumbentExecutor(options?: {
  readonly variant?: "divergent";
}): FakeIncumbentExecutor {
  const servedCaseIds: string[] = [];
  return {
    async outcomeFor(input: { readonly dcase: DifferentialCase }) {
      servedCaseIds.push(input.dcase.caseId);
      if (options?.variant === "divergent") {
        // The DIVERGENT world: the FIRST-served case's digest drifts —
        // the incumbent serves a digest the population does not pin.
        if (servedCaseIds.length === 1) {
          return { digest: longitudinalDigestOf(["divergent-incumbent", input.dcase.caseId]) };
        }
      }
      return { digest: input.dcase.incumbentDigest };
    },
    get servedCaseIds() {
      return [...servedCaseIds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake replacement runtime (isolation-enforced + the adversarial variants)
// ---------------------------------------------------------------------------

/** The fake replacement runtime's adversarial variants (the discrimination shapes). */
export type FakeReplacementRuntimeVariant =
  | "escaping"
  | "uncited"
  | "partial"
  | "unchecked"
  | "smoothing";

/** The fake replacement runtime (the isolated untrusted-code seam). */
export interface FakeReplacementRuntime extends ReplacementRuntimePort {
  /** The rows the runtime executed, in run order. */
  readonly runCount: number;
}

/**
 * Create the fake replacement runtime: the ISOLATED untrusted-code
 * seam delegating to the platform's PURE honest replacement
 * derivation (the reference runtime). The adversarial variants:
 *
 *   * `escaping` — the untrusted code exercises NETWORK ACCESS (an
 *     undeclared, ungranted capability — a containment violation);
 *   * `uncited` — the verdict cites NO proposal (a broken provenance
 *     chain);
 *   * `partial` — the evaluation drops the pinned ADVERSARIAL cases
 *     (a partial differential population);
 *   * `unchecked` — the criterion is stated but NOTHING is checked
 *     (an empty evaluated surface);
 *   * `smoothing` — the first case's replacement digest is perturbed
 *     to diverge while the runtime CLAIMS equivalence (a smoothed
 *     divergence).
 */
export function createReplacementRuntime(options?: {
  readonly variant?: FakeReplacementRuntimeVariant;
}): FakeReplacementRuntime {
  let runCount = 0;
  return {
    async run(input): Promise<ReplacementRunOutcome> {
      runCount += 1;
      const honest = deriveHonestReplacementRun({
        sourceProposalId: input.sourceProposalId,
        replacementShape: input.replacementShape,
        declaredCapabilities: input.declaredCapabilities,
        acceptanceCriterion: input.acceptanceCriterion,
        population: input.population,
      });
      const variant = options?.variant;
      if (variant === undefined) {
        return honest;
      }
      if (variant === "escaping") {
        return {
          ...honest,
          exercisedCapabilities: [...honest.exercisedCapabilities, "network-access"],
        };
      }
      if (variant === "uncited") {
        return { ...honest, citedProposalId: null };
      }
      if (variant === "partial") {
        const historical = input.population.filter((dcase) => dcase.source === "historical-replay");
        return {
          ...honest,
          outcomes: honest.outcomes.filter((outcome) =>
            historical.some((dcase) => dcase.caseId === outcome.caseId),
          ),
          evaluatedCaseIds: historical.map((dcase) => dcase.caseId),
        };
      }
      if (variant === "unchecked") {
        return {
          ...honest,
          outcomes: honest.outcomes.map((outcome) => ({ ...outcome, claimedEquivalent: false })),
          evaluatedCaseIds: [],
        };
      }
      if (variant === "smoothing") {
        const first = input.population[0];
        if (first === undefined) {
          return honest;
        }
        return {
          ...honest,
          outcomes: honest.outcomes.map((outcome) =>
            outcome.caseId === first.caseId
              ? {
                  caseId: outcome.caseId,
                  digest: longitudinalDigestOf(["smoothed-perturbation", outcome.caseId]),
                  claimedEquivalent: true,
                }
              : outcome,
          ),
        };
      }
      return honest;
    },
    get runCount() {
      return runCount;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/** One durable execution row the fake API world holds. */
export interface FakeEquivalenceExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * equivalence semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each
 *    equivalence submission lands its OWN durable execution under its
 *    OWN idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (an honest refusal is a COMPLETED run; an honest
 *    divergence is an honest FAILED), never backwards;
 *  - GET /executions/:id/events — the canonical equivalence
 *    trajectory surfaced as the public step-event journal (the app
 *    mechanically re-derives the trajectory digest over this read —
 *    never trusting the platform's claim);
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the run's own dispatches — zero offline, the
 *    live row's REAL residual-AI round), the honest verification
 *    statuses, honestly-absent offline usage, the equivalence verdict
 *    read back (the kind, the refusal reason, the divergent cases,
 *    the escape directions), the lifecycle landing (the equivalence
 *    stage ONLY), the per-case outcomes (both sides' digests) and the
 *    exercised capabilities.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `uncited` surfaces no lifecycle landing; `partial` surfaces only
 * the historical outcomes; `unchecked` surfaces no outcomes at all;
 * `smoothing` perturbs one case's digest while claiming equivalence;
 * `escaping` exercises network access; `skipped` surfaces the landing
 * past the equivalence stage (`promoted`).
 */
export function createEquivalenceFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The adversarial knob: no lifecycle landing is surfaced. */
  readonly uncited?: boolean;
  /** The adversarial knob: only the historical outcomes are surfaced. */
  readonly partial?: boolean;
  /** The adversarial knob: no outcomes are surfaced at all. */
  readonly unchecked?: boolean;
  /** The adversarial knob: one case is perturbed but claimed equivalent. */
  readonly smoothing?: boolean;
  /** The adversarial knob: the replacement exercises network access. */
  readonly escaping?: boolean;
  /** The adversarial knob: the landing surfaces past the equivalence stage. */
  readonly skipped?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeEquivalenceExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeEquivalenceExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string) =>
    EQUIVALENCE_TESTING_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The world's surfaced run for one corpus row (the honest derivation + the knobs). */
  const surfacedRunOf = (rowId: string) => {
    const row = rowById(rowId);
    if (row === null) {
      return null;
    }
    const { honestRun, differential } = pinnedRunOf(row);
    const refusal =
      row.expected.verdict === "honest-refusal"
        ? { reason: row.expected.refusalReason ?? "proposal-unregistered" }
        : null;

    let outcomes = honestRun.outcomes.map((outcome) => {
      const dcase = row.differentialPopulation.find(
        (candidate) => candidate.caseId === outcome.caseId,
      );
      return {
        caseId: outcome.caseId,
        incumbentDigest: dcase?.incumbentDigest ?? "",
        replacementDigest: outcome.digest,
        claimedEquivalent: outcome.claimedEquivalent,
      };
    });
    if (options.partial === true) {
      outcomes = outcomes.filter((outcome) =>
        row.differentialPopulation.some(
          (dcase) => dcase.caseId === outcome.caseId && dcase.source === "historical-replay",
        ),
      );
    }
    if (options.unchecked === true) {
      outcomes = [];
    }
    if (options.smoothing === true) {
      const first = outcomes[0];
      if (first !== undefined) {
        outcomes = outcomes.map((outcome) =>
          outcome.caseId === first.caseId
            ? {
                caseId: outcome.caseId,
                incumbentDigest: outcome.incumbentDigest,
                replacementDigest: longitudinalDigestOf(["smoothed-perturbation", outcome.caseId]),
                claimedEquivalent: true,
              }
            : outcome,
        );
      }
    }

    const exercised =
      options.escaping === true
        ? [...row.declaredCapabilities, "network-access"]
        : [...row.declaredCapabilities];

    const verdictKind: EquivalenceVerdictKind =
      options.escaping === true
        ? "containment-violation"
        : refusal !== null
          ? "honest-refusal"
          : differential.equivalent
            ? "equivalence-pass"
            : "honest-divergence";
    const escapeDirections = options.escaping === true ? ["network-access"] : [];

    return {
      row,
      refusal,
      differential,
      outcomes,
      exercised,
      verdictKind,
      escapeDirections,
    };
  };

  /** The row's honest equivalence trajectory events under the surfaced run. */
  const eventsFor = (row: FakeEquivalenceExecutionRow): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    const { honestRun, differential } = pinnedRunOf(corpusRow);
    const steps = equivalenceTrajectoryStepsOf({
      proposalId: corpusRow.sourceProposalId,
      populationDigest: differentialPopulationDigestOf(corpusRow.differentialPopulation),
      incumbentExecutionDigest: longitudinalDigestOf([
        "incumbent-executed",
        ...corpusRow.differentialPopulation.map((dcase) => dcase.incumbentDigest),
      ]),
      replacementExecutionDigest: longitudinalDigestOf([
        "replacement-executed",
        ...honestRun.outcomes.map((outcome) => outcome.digest),
      ]),
      isolationContainment: corpusRow.expected.verdict === "honest-refusal" ? null : "contained",
      differentialVerdictDigest:
        corpusRow.expected.verdict === "honest-refusal" ? null : differential.digest,
      refusalReason: corpusRow.expected.refusalReason,
      confirmationRounds: corpusRow.expected.modelCalls,
    });
    return trajectoryEventsOf(steps).map((event, index) => ({
      eventId: `${row.id}-ev-${index + 1}`,
      executionId: row.id,
      type: event.type,
      sequence: event.sequence,
      occurredAt: new Date(row.createdAt + index).toISOString(),
      payload: {},
    }));
  };

  /** The row's honest verification statuses (the anyFail discipline). */
  const verificationFor = (rowId: string): string[] => {
    const corpusRow = rowById(rowId);
    if (corpusRow === null || corpusRow.expected.terminal === "COMPLETED") {
      return ["PASS", "PASS"];
    }
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
      const task = (body.task ?? null) as { rowId?: unknown } | null;
      const taskRowId = String(task?.rowId ?? "");
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
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, {
        id,
        key,
        taskRowId,
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
        corpusRow === null ? "FAILED" : (options.terminal ?? corpusRow.expected.terminal);
      // The row settles on the read path (the fake simulates the
      // platform driving the equivalence run) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "equivalence-testing.verdict.v1", input: "equivalence" },
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
      return jsonResponse(200, eventsFor(row));
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
      const surfaced = corpusRow === null ? null : surfacedRunOf(corpusRow.rowId);
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "equivalence-testing",
          modelCalls: corpusRow?.expected.modelCalls ?? 0,
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
        verdict:
          surfaced === null
            ? null
            : {
                kind: surfaced.verdictKind,
                refusalReason: surfaced.refusal?.reason ?? null,
                divergenceCaseIds:
                  surfaced.differential?.divergences.map((divergence) => divergence.caseId) ?? [],
                escapeDirections: surfaced.escapeDirections,
              },
        lifecycleLanding:
          surfaced === null || options.uncited === true || surfaced.refusal !== null
            ? null
            : {
                proposalId: surfaced.row.sourceProposalId,
                finalStage: options.skipped === true ? "promoted" : EQUIVALENT_STAGE,
              },
        outcomes: surfaced?.outcomes ?? [],
        exercisedCapabilities: surfaced?.exercised ?? [],
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

// ---------------------------------------------------------------------------
// The honest stack (the driver's default fake world)
// ---------------------------------------------------------------------------

/**
 * The honest fake stack: the read-only registry, the append-only
 * ledger, the deterministic incumbent executor and the isolated
 * honest replacement runtime — the world every offline row passes
 * over (the adversarial variants are the discrimination worlds).
 */
export function createHonestEquivalenceStack(): {
  readonly registry: FakeCandidateRegistry;
  readonly ledger: FakeLifecycleLedger;
  readonly incumbentExecutor: FakeIncumbentExecutor;
  readonly replacementRuntime: FakeReplacementRuntime;
  readonly clock: TickClock;
} {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  return {
    registry,
    ledger: createLifecycleLedger(),
    incumbentExecutor: createIncumbentExecutor(),
    replacementRuntime: createReplacementRuntime(),
    clock,
  };
}
