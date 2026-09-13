/**
 * The learning-discovery application's deterministic fixtures (VAL-032,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the replay-ledger input world — VAL-031's recorded replay
 *     populations as the READ-ONLY input: every discovery row's
 *     recorded observations (the immutable replay identities + the
 *     observed trajectory digests + the payload-free structural
 *     digests, re-declared exactly as VAL-031 recorded them) plus the
 *     frozen-baseline registry digest over the referenced manifests.
 *     The recorded populations are never rewritten by an honest
 *     discovery; the MISMATCH variant serves a drifted population
 *     (the read-only pin catch);
 *   * the fake candidate registry — proposals land as lifecycle
 *     candidates at the `proposed` stage (the VAL-004/005 candidate
 *     grammar): append-only, idempotent on identical re-proposals,
 *     refusing a DIFFERENT proposal under a recorded id. The MUTATING
 *     variants are the discrimination shapes: `mutate-recorded-population`
 *     REWRITES a frozen recorded observation on propose (the
 *     state-mutation catch) and `promote-proposal` records the
 *     candidate past the proposed stage (an application-level act —
 *     discovery proposes, never applies);
 *   * the fake miner — deterministic structure mining delegating to
 *     the platform's PURE honest discovery derivation, plus the
 *     adversarial variants: UNCITED (an empty evidence citation),
 *     PARTIAL (a citation missing the last recorded replay),
 *     FABRICATED (a citation naming digests the ledger never
 *     recorded), SMOOTHING (a deterministicization proposal over an
 *     honestly-varying population) and HIDING (an unjustified refusal
 *     that hides learnable structure);
 *   * the fake public API world — the transport-level fake
 *     implementing the discovery semantics at the customer boundary
 *     (the per-row create semantics; the honest terminal on the read
 *     path; the discovery trajectory surfaced as the public
 *     step-event journal; the proposal or the honest refusal surfaced
 *     on the result read) with the discrimination knobs
 *     `uncited`/`partial`/`fabricated`/`smoothing`/`mutating`
 *     (promoted) and the `terminal` override.
 *
 * Everything is deterministic (the tick clock advances with simulated
 * roundtrips; every digest is a payload-free FNV-1a constant) — every
 * offline row is repository-reproducible with zero credentials.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  CandidateKind,
  CandidateLifecycleStage,
  CandidateRegistryFacts,
  CandidateRegistryPort,
  DiscoveryMinerPort,
  DiscoveryMiningOutcome,
  DiscoveryProposalRecord,
  LearningDiscoveryCorpusRow,
  RecordedReplayObservation,
  RefusalReason,
  ReplayLedgerInputFacts,
  ReplayLedgerInputPort,
} from "../../platform/learning-discovery";
import {
  canonicalCitationOf,
  deriveHonestDiscoveryOutcome,
  discoveryTrajectoryStepsOf,
  PROPOSAL_LIFECYCLE_STAGE,
  proposalIdentityIdOf,
  recordedPopulationDigestOf,
  replayLedgerInputDigestOf,
} from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import type { WorkloadReplayCorpusRow } from "../../platform/workload-replay";
import { LEARNING_DISCOVERY_CORPUS, REFERENCED_REPLAY_ROWS } from "./corpus";

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
// The replay-ledger input world (VAL-031's recorded populations, read-only)
// ---------------------------------------------------------------------------

/**
 * The frozen-baseline registry digest over the referenced VAL-031
 * replay populations' pinned manifests (PURE — VAL-030's frozen
 * manifests as the read-only input fingerprint; a discovery never
 * rewrites them).
 */
export function frozenBaselineRegistryDigestOf(rows: readonly WorkloadReplayCorpusRow[]): string {
  return longitudinalDigestOf(
    rows.map((row) => [
      row.manifest.appId,
      row.manifest.workloadId,
      `r${row.manifest.workloadRevision}`,
      row.manifest.manifestDigest,
    ]),
  );
}

/** The fake replay-ledger input (with its own read-only facts view). */
export interface FakeReplayLedgerInput extends ReplayLedgerInputPort {
  /** The full frozen-input digest (the no-application snapshot basis). */
  frozenDigest(): string;
  /** The stored observations (the internally-mutable store the MUTATING registry reaches). */
  store(): ReadonlyMap<string, RecordedReplayObservation[]>;
}

/**
 * Create the fake replay-ledger input world: every discovery row's
 * recorded population is served from an internally-held store
 * initialized from the corpus (the recorded facts re-declared exactly
 * as VAL-031 recorded them — the discovery reads them; it never
 * rewrites them). The MISMATCH variant serves a DRIFTED population
 * (the last recorded observation dropped — a partial serve), so the
 * read-only pin leg FAILs mechanically.
 */
export function createReplayLedgerInput(options?: {
  readonly mismatch?: boolean;
}): FakeReplayLedgerInput {
  const populations = new Map<string, RecordedReplayObservation[]>();
  for (const row of LEARNING_DISCOVERY_CORPUS) {
    populations.set(
      row.rowId,
      row.population.map((observation) => ({ ...observation })),
    );
  }
  const facts = (): ReplayLedgerInputFacts => ({
    populations: [...populations.entries()]
      .map(([rowId, observations]) => ({
        rowId,
        populationDigest: recordedPopulationDigestOf(observations),
      }))
      .sort((left, right) => left.rowId.localeCompare(right.rowId)),
    baselineRegistryDigest: frozenBaselineRegistryDigestOf(REFERENCED_REPLAY_ROWS),
  });
  return {
    populationFor(row) {
      const observations = populations.get(row.rowId) ?? [];
      if (options?.mismatch === true) {
        // The MISMATCH world: the last recorded observation is dropped —
        // a partial serve of the row's pinned population.
        return observations.slice(0, -1);
      }
      return observations.map((observation) => ({ ...observation }));
    },
    facts,
    frozenDigest() {
      return replayLedgerInputDigestOf(facts());
    },
    store() {
      return populations;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake candidate registry (the VAL-004/005 lifecycle grammar)
// ---------------------------------------------------------------------------

/** The fake candidate registry (with its own facts view). */
export interface FakeCandidateRegistry extends CandidateRegistryPort {
  /** The recorded proposal ids, in recording order. */
  readonly recordedProposalIds: readonly string[];
}

/**
 * Create the fake candidate registry: proposals land as lifecycle
 * candidates at the `proposed` stage — append-only (an IDENTICAL
 * re-proposal REPLAYS idempotently; a DIFFERENT proposal under a
 * recorded id is REFUSED).
 *
 * The adversarial variants (the discrimination shapes):
 * `mutate-recorded-population` REWRITES a frozen recorded observation
 * of the population the proposal cites when recording (the
 * state-mutation catch — the frozen-input digest changes); and
 * `promote-proposal` records the candidate past the proposed stage
 * (`promoted` — an application-level act: the registry then holds an
 * APPLIED candidate and the no-application derivation FAILs
 * mechanically).
 */
export function createCandidateRegistry(options?: {
  readonly mutation?: "mutate-recorded-population" | "promote-proposal";
  /** The ledger input the mutating variant reaches into (frozen state). */
  readonly ledgerInput?: FakeReplayLedgerInput;
}): FakeCandidateRegistry {
  const candidates: {
    proposalId: string;
    kind: CandidateKind;
    lifecycleStage: CandidateLifecycleStage;
    citationDigest: string;
    minedStructureDigest: string;
  }[] = [];
  const citationDigestOf = (record: DiscoveryProposalRecord): string =>
    longitudinalDigestOf([record.citation.trajectoryDigests, record.citation.replayIdentities]);
  const mutateRecordedPopulation = (record: DiscoveryProposalRecord): void => {
    const ledgerInput = options?.ledgerInput;
    if (ledgerInput === undefined) {
      return;
    }
    const firstCited = record.citation.replayIdentities[0];
    if (firstCited === undefined) {
      return;
    }
    for (const observations of ledgerInput.store().values()) {
      if (observations.some((observation) => observation.replayIdentity === firstCited)) {
        // The STATE MUTATION: the first recorded observation's
        // trajectory digest is rewritten — a frozen recorded fact.
        const first = observations[0];
        if (first !== undefined) {
          observations[0] = {
            ...first,
            trajectoryDigest: longitudinalDigestOf(["mutation-fabricated", record.proposalId]),
          };
        }
        return;
      }
    }
  };
  return {
    async propose(record) {
      const existing = candidates.find((candidate) => candidate.proposalId === record.proposalId);
      if (existing !== undefined) {
        if (existing.citationDigest === citationDigestOf(record)) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      if (options?.mutation === "mutate-recorded-population") {
        mutateRecordedPopulation(record);
      }
      candidates.push({
        proposalId: record.proposalId,
        kind: record.kind,
        lifecycleStage:
          options?.mutation === "promote-proposal" ? "promoted" : record.lifecycleStage,
        citationDigest: citationDigestOf(record),
        minedStructureDigest: record.minedStructureDigest,
      });
      return { accepted: true, replayed: false, refused: false };
    },
    facts(): CandidateRegistryFacts {
      return {
        candidates: candidates.map((candidate) => ({ ...candidate })),
        appliedCandidateCount: candidates.filter(
          (candidate) => candidate.lifecycleStage !== PROPOSAL_LIFECYCLE_STAGE,
        ).length,
      };
    },
    get recordedProposalIds() {
      return candidates.map((candidate) => candidate.proposalId);
    },
  };
}

// ---------------------------------------------------------------------------
// The fake miner (deterministic structure mining + the adversarial variants)
// ---------------------------------------------------------------------------

/** The fake miner's adversarial variants (the discrimination shapes). */
export type FakeMinerVariant = "uncited" | "partial" | "fabricated" | "smoothing" | "hiding";

/** The fake miner (delegating to the PURE honest derivation by default). */
export interface FakeDiscoveryMiner extends DiscoveryMinerPort {
  /** The populations the miner observed, in mining order. */
  readonly minedRowIds: readonly string[];
}

/**
 * Create the fake discovery miner: deterministic structure mining
 * delegating to the platform's PURE honest discovery derivation (the
 * reference miner). The adversarial variants:
 *
 *   * `uncited` — the honest proposal with an EMPTY evidence citation
 *     (an uncited proposal FAILs the completeness derivation);
 *   * `partial` — the citation drops the LAST recorded replay
 *     identity (and the last trajectory digest when the population
 *     recorded more than one) — a partial-population generalization;
 *   * `fabricated` — the citation names a phantom trajectory digest
 *     and a phantom replay identity the ledger never recorded — a
 *     fabricated evidence citation;
 *   * `smoothing` — where the honest derivation REFUSES the
 *     deterministicization question over an honestly-varying
 *     population, the variant emits a deterministicization proposal
 *     citing the full population anyway — a variance-smoothing
 *     fabrication;
 *   * `hiding` — where the honest derivation EMITS a proposal, the
 *     variant refuses with `no-learnable-structure` — a refusal that
 *     hides learnable structure.
 */
export function createDiscoveryMiner(options?: {
  readonly variant?: FakeMinerVariant;
}): FakeDiscoveryMiner {
  const minedRowIds: string[] = [];
  return {
    mine(input): DiscoveryMiningOutcome {
      minedRowIds.push(input.rowId);
      const honest = deriveHonestDiscoveryOutcome({
        candidateKind: input.candidateKind,
        population: input.population,
      });
      const variant = options?.variant;
      // The HIDING variant: an unjustified refusal that hides learnable
      // structure (the honest derivation EMITTED a proposal).
      if (variant === "hiding" && honest.proposal !== null) {
        return {
          structure: honest.structure,
          proposal: null,
          refusal: { reason: "no-learnable-structure" },
        };
      }
      if (variant === undefined || honest.proposal === null) {
        if (variant === "smoothing" && honest.refusal?.reason === "varying-population") {
          // The SMOOTHING variant: a deterministicization proposal over
          // the honestly-varying population (citing it in full — the
          // fabrication is the KIND, not the citation).
          const basis = {
            kind: "deterministicization" as const,
            citation: canonicalCitationOf(input.population),
            minedStructureDigest: honest.structure.digest,
            lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
          };
          return {
            structure: honest.structure,
            proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
            refusal: null,
          };
        }
        return honest;
      }
      const proposal = honest.proposal;
      if (variant === "uncited") {
        const basis = {
          kind: proposal.kind,
          citation: { trajectoryDigests: [], replayIdentities: [] },
          minedStructureDigest: proposal.minedStructureDigest,
          lifecycleStage: proposal.lifecycleStage,
        };
        return {
          structure: honest.structure,
          proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
          refusal: null,
        };
      }
      if (variant === "partial") {
        const basis = {
          kind: proposal.kind,
          citation: {
            trajectoryDigests: proposal.citation.trajectoryDigests.slice(0, -1),
            replayIdentities: proposal.citation.replayIdentities.slice(0, -1),
          },
          minedStructureDigest: proposal.minedStructureDigest,
          lifecycleStage: proposal.lifecycleStage,
        };
        return {
          structure: honest.structure,
          proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
          refusal: null,
        };
      }
      if (variant === "fabricated") {
        const phantomDigest = longitudinalDigestOf(["phantom-trajectory", input.rowId]);
        const phantomIdentity = `exp-workload-replay-${longitudinalDigestOf(["phantom-identity", input.rowId])}`;
        const basis = {
          kind: proposal.kind,
          citation: {
            trajectoryDigests: [...proposal.citation.trajectoryDigests, phantomDigest],
            replayIdentities: [...proposal.citation.replayIdentities, phantomIdentity],
          },
          minedStructureDigest: proposal.minedStructureDigest,
          lifecycleStage: proposal.lifecycleStage,
        };
        return {
          structure: honest.structure,
          proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
          refusal: null,
        };
      }
      return honest;
    },
    get minedRowIds() {
      return [...minedRowIds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/** One durable execution row the fake API world holds. */
export interface FakeDiscoveryExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * discovery semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each discovery
 *    submission lands its OWN durable execution under its OWN
 *    idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (an honest refusal is a COMPLETED discovery, never
 *    a fabricated failure), never backwards;
 *  - GET /executions/:id/events — the canonical discovery trajectory
 *    surfaced as the public step-event journal (the app mechanically
 *    re-derives the discovery trajectory digest over this read —
 *    never trusting the platform's claim);
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the discovery run's own dispatches — zero
 *    offline, the live row's REAL confirmation round), the honest
 *    verification statuses, honestly-absent offline usage, and the
 *    discovery outcome read back (the proposal record or the honest
 *    refusal).
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `uncited`/`partial`/`fabricated` corrupt the read-back proposal's
 * evidence citation; `smoothing` surfaces a deterministicization
 * proposal where the honest outcome is the varying-population
 * refusal; `mutating` surfaces the proposal past the proposed stage
 * (`promoted` — an applied candidate, the state-mutation shape at the
 * boundary).
 */
export function createLearningDiscoveryFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The adversarial knob: the read-back proposal's citation is empty. */
  readonly uncited?: boolean;
  /** The adversarial knob: the read-back citation covers only part of the population. */
  readonly partial?: boolean;
  /** The adversarial knob: the read-back citation names phantom members. */
  readonly fabricated?: boolean;
  /** The adversarial knob: a deterministicization proposal over the varying population. */
  readonly smoothing?: boolean;
  /** The adversarial knob: the read-back proposal is applied (promoted). */
  readonly mutating?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeDiscoveryExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeDiscoveryExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string): LearningDiscoveryCorpusRow | null =>
    LEARNING_DISCOVERY_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The world's surfaced discovery outcome for one corpus row. */
  const surfacedOutcomeOf = (
    row: LearningDiscoveryCorpusRow,
  ): {
    readonly proposal: DiscoveryProposalRecord | null;
    readonly refusal: { readonly reason: RefusalReason } | null;
  } => {
    const honest = deriveHonestDiscoveryOutcome({
      candidateKind: row.candidateKind,
      population: row.population,
    });
    if (honest.proposal === null) {
      if (options.smoothing === true && honest.refusal?.reason === "varying-population") {
        const basis = {
          kind: "deterministicization" as const,
          citation: canonicalCitationOf(row.population),
          minedStructureDigest: honest.structure.digest,
          lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
        };
        return { proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) }, refusal: null };
      }
      return {
        proposal: null,
        refusal: {
          reason: (honest.refusal?.reason ?? "no-learnable-structure") as RefusalReason,
        },
      };
    }
    const proposal = honest.proposal;
    if (options.uncited === true) {
      const basis = {
        kind: proposal.kind,
        citation: { trajectoryDigests: [], replayIdentities: [] },
        minedStructureDigest: proposal.minedStructureDigest,
        lifecycleStage: proposal.lifecycleStage,
      };
      return { proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) }, refusal: null };
    }
    if (options.partial === true) {
      const basis = {
        kind: proposal.kind,
        citation: {
          trajectoryDigests: proposal.citation.trajectoryDigests.slice(0, -1),
          replayIdentities: proposal.citation.replayIdentities.slice(0, -1),
        },
        minedStructureDigest: proposal.minedStructureDigest,
        lifecycleStage: proposal.lifecycleStage,
      };
      return { proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) }, refusal: null };
    }
    if (options.fabricated === true) {
      const phantomDigest = longitudinalDigestOf(["phantom-trajectory", row.rowId]);
      const phantomIdentity = `exp-workload-replay-${longitudinalDigestOf(["phantom-identity", row.rowId])}`;
      const basis = {
        kind: proposal.kind,
        citation: {
          trajectoryDigests: [...proposal.citation.trajectoryDigests, phantomDigest],
          replayIdentities: [...proposal.citation.replayIdentities, phantomIdentity],
        },
        minedStructureDigest: proposal.minedStructureDigest,
        lifecycleStage: proposal.lifecycleStage,
      };
      return { proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) }, refusal: null };
    }
    if (options.mutating === true) {
      const basis = {
        kind: proposal.kind,
        citation: proposal.citation,
        minedStructureDigest: proposal.minedStructureDigest,
        lifecycleStage: "promoted" as CandidateLifecycleStage,
      };
      return { proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) }, refusal: null };
    }
    return { proposal, refusal: null };
  };

  /** The row's honest discovery trajectory events under the surfaced outcome. */
  const eventsFor = (row: FakeDiscoveryExecutionRow): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    const surfaced = surfacedOutcomeOf(corpusRow);
    const steps = discoveryTrajectoryStepsOf({
      populationDigest: recordedPopulationDigestOf(corpusRow.population),
      minedStructureDigest: deriveHonestDiscoveryOutcome({
        candidateKind: corpusRow.candidateKind,
        population: corpusRow.population,
      }).structure.digest,
      proposal: surfaced.proposal,
      refusalReason: surfaced.refusal?.reason ?? null,
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
      // platform driving the discovery) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "learning-discovery.proposal.v1", input: "discovery" },
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
      const surfaced =
        corpusRow === null
          ? { proposal: null, refusal: { reason: "no-learnable-structure" as const } }
          : surfacedOutcomeOf(corpusRow);
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "learning-discovery",
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
        proposal:
          surfaced.proposal === null
            ? null
            : {
                proposalId: surfaced.proposal.proposalId,
                kind: surfaced.proposal.kind,
                citation: {
                  trajectoryDigests: [...surfaced.proposal.citation.trajectoryDigests],
                  replayIdentities: [...surfaced.proposal.citation.replayIdentities],
                },
                minedStructureDigest: surfaced.proposal.minedStructureDigest,
                lifecycleStage: surfaced.proposal.lifecycleStage,
              },
        refusal: surfaced.refusal,
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
