/**
 * The shadow-execution application's deterministic fixtures (VAL-034,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fake candidate registry — VAL-032's proposals pre-seeded as
 *     the READ-ONLY input (the registry identities the corpus pins,
 *     re-derived exactly as VAL-032 recorded them, plus the
 *     fixture-only degenerate entry the premature-refusal row refuses
 *     honestly). The registry is never rewritten by an honest run;
 *     the LEAKY ledger variant reaches into its store and REWRITES a
 *     candidate's entry (the read-only catch);
 *   * the fake candidate lifecycle ledger — the RECORDED VAL-033 walk
 *     pre-seeded for every differentially-evaluated candidate (the
 *     read-only input) plus the APPEND-ONLY shadow transition: the
 *     single `shadow-executed` append with its evidence digest (an
 *     identical re-append REPLAYS; a different transition under a
 *     recorded key is REFUSED). The adversarial variants are the
 *     discrimination shapes: `skip-to-canaried` lands the append at
 *     `canaried` (a skipped-stage promotion), `wrong-stage` lands at
 *     `property-tested` (a wrong-stage landing), `evidence-less`
 *     appends without evidence, and `rewrite-registry` REWRITES the
 *     registry's own candidate entry on append;
 *   * the fake shadow ledger — APPEND-ONLY: the divergence ledger
 *     (every divergence case-by-case with both sides' digests) and
 *     the shadow cost ledger (the shadow's measured cost, booked
 *     apart from the served accounting). The `double-booking`
 *     variant books the shadow cost onto the SERVED accounting rails
 *     (the customer is billed for the shadow);
 *   * the fake incumbent executor — deterministic per-case digests
 *     delegating to the traffic population's pinned incumbent
 *     digests; the DIVERGENT variant perturbs the served digest on
 *     the first case (a drifted serve: the read-only population pin
 *     catch);
 *   * the fake traffic source — the recorded workload mix serve; the
 *     DROPPED variant drops the last recorded case, the DUPLICATED
 *     variant serves the first case twice, and the MIXED-UP variant
 *     swaps the last case for a foreign one (the population
 *     completeness catches);
 *   * the fake serving path — the customer-facing serve: the honest
 *     path serves the INCUMBENT's executed digest (the served-source
 *     pin) and books the incumbent's cost to the served accounting;
 *     the LEAKY variant serves the REPLACEMENT's outcome (an explicit
 *     leak) and the DISGUISED variant claims the incumbent source
 *     while serving the shadow's digest;
 *   * the fake shadow runtime — the replacement executing in SHADOW
 *     (observation-only), delegating to the platform's PURE honest
 *     shadow derivation; the adversarial variants are the
 *     discrimination shapes: ESCAPING (the untrusted code exercises
 *     network access MID-SHADOW — a containment violation),
 *     AGGREGATE-ONLY (an asserted aggregate without the per-case
 *     records), SUBSET-COMPARED (an asserted agreement from a subset
 *     of the population), SMOOTHING (a perturbed case claimed
 *     agreeing) and UNMEASURED (the shadow cost never measured);
 *   * the fake API world — the transport-level fake implementing the
 *     platform's OWN shadow semantics at the customer boundary, with
 *     the same discrimination knobs;
 *   * the tick clock — the deterministic injectable clock.
 *
 * Everything is digests and identities — payload bytes never enter
 * the fixtures, and no credential is ever read.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  DiscoveryProposalRecord,
  EquivalenceRegistryFacts,
} from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import type {
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
  ServingPathPort,
  ShadowCostLedgerEntry,
  ShadowDivergenceRecord,
  ShadowLedgerPort,
  ShadowLifecycleLedgerPort,
  ShadowRunOutcome,
  ShadowRuntimePort,
  ShadowTrafficCase,
  ShadowVerdictKind,
  TrafficSourcePort,
} from "../../platform/shadow-execution";
import {
  deriveHonestShadowRun,
  referenceShadowMeasurementOf,
  SHADOW_STAGE,
  shadowCostDigestOf,
  shadowPopulationDigestOf,
  shadowRegistryDigestOf,
  shadowTrajectoryStepsOf,
} from "../../platform/shadow-execution";
import {
  PINNED_REGISTRY_ENTRIES,
  pinnedShadowRunOf,
  priorWalkOf,
  SHADOW_EXECUTION_CORPUS,
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
export interface FakeCandidateRegistry {
  candidateFor(proposalId: string): DiscoveryProposalRecord | null;
  facts(): EquivalenceRegistryFacts;
  /** The full read-only fingerprint (the registry-unchanged snapshot basis). */
  digest(): string;
  /** The stored entries (the internally-mutable store the LEAKY ledger reaches). */
  store(): Map<string, SourceProposalPin>;
}

/**
 * Create the fake candidate registry: pre-seeded with the corpus's
 * pinned VAL-032 proposals (the registry identities the shadow rows
 * cite — read-only inputs, never rewritten by an honest run). The
 * store is internally mutable ONLY so the LEAKY ledger variant can
 * perform its rewrite (the discrimination shape the read-only
 * discipline catches).
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
    candidateFor(proposalId: string): DiscoveryProposalRecord | null {
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
      return shadowRegistryDigestOf(facts());
    },
    store() {
      return entries;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake candidate lifecycle ledger (recorded walk + append-only shadow)
// ---------------------------------------------------------------------------

/** The fake lifecycle ledger's adversarial variants (the discrimination shapes). */
export type FakeLifecycleVariant =
  | "skip-to-canaried"
  | "wrong-stage"
  | "evidence-less"
  | "rewrite-registry";

/** The fake candidate lifecycle ledger (with its own transitions view). */
export interface FakeLifecycleLedger extends ShadowLifecycleLedgerPort {
  /** The proposals whose shadow transitions landed, in append order. */
  readonly landedProposalIds: readonly string[];
}

/**
 * The candidates whose recorded VAL-033 walk the ledger pre-seeds
 * (every differentially-evaluated source of the pinned corpus — the
 * read-only input; the degenerate premature candidate's walk NEVER
 * started).
 */
function differentiallyEvaluatedProposalIds(): readonly string[] {
  const ids = new Set<string>();
  for (const row of SHADOW_EXECUTION_CORPUS) {
    if (row.expected.refusalReason === null) {
      ids.add(row.sourceProposalId);
    }
  }
  return [...ids];
}

/**
 * Create the fake candidate lifecycle ledger: the RECORDED VAL-033
 * walk pre-seeded for every differentially-evaluated candidate (the
 * `offline-replayed` + `differentially-evaluated` transitions with
 * their canonical evidence digests — the read-only input), plus the
 * APPEND-ONLY shadow transition (an IDENTICAL re-append REPLAYS
 * idempotently; a DIFFERENT transition under a recorded (proposalId,
 * stage) key is REFUSED). The adversarial variants are the
 * discrimination shapes the stage-discipline / read-only derivations
 * catch:
 *
 *   * `skip-to-canaried` — every shadow append lands at `canaried` (a
 *     skipped-stage promotion past shadow-executed);
 *   * `wrong-stage` — the shadow append lands at `property-tested` (a
 *     wrong-stage landing — not this slice's append);
 *   * `evidence-less` — the shadow append lands without its evidence
 *     digest;
 *   * `rewrite-registry` — the append REWRITES the registry's own
 *     candidate entry (mutating the read-only input).
 */
export function createLifecycleLedger(options?: {
  readonly variant?: FakeLifecycleVariant;
  /** The read-only registry the rewrite variant reaches into (frozen state). */
  readonly registry?: FakeCandidateRegistry;
}): FakeLifecycleLedger {
  const transitions: LifecycleTransitionRecord[] = [];
  const ordinals = new Map<string, number>();
  const landed: string[] = [];
  const variant = options?.variant;

  // The recorded VAL-033 walk (the read-only pre-seed).
  for (const proposalId of differentiallyEvaluatedProposalIds()) {
    const row = SHADOW_EXECUTION_CORPUS.find(
      (candidate) => candidate.sourceProposalId === proposalId,
    );
    if (row === undefined) {
      continue;
    }
    for (const prior of priorWalkOf(row)) {
      transitions.push({ ...prior });
      ordinals.set(proposalId, prior.ordinal);
    }
  }

  const rewriteRegistry = (proposalId: string): void => {
    const registry = options?.registry;
    if (registry === undefined) {
      return;
    }
    const entry = registry.store().get(proposalId);
    if (entry !== undefined) {
      // The REWRITE: the registry's own candidate entry is mutated —
      // a frozen recorded fact.
      registry.store().set(proposalId, { ...entry, lifecycleStage: "promoted" });
    }
  };

  return {
    async append(record) {
      const landedStage =
        variant === "skip-to-canaried"
          ? ("canaried" as const)
          : variant === "wrong-stage"
            ? ("property-tested" as const)
            : record.toStage;
      const evidenceDigest = variant === "evidence-less" ? "" : record.evidenceDigest;
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
// The fake shadow ledger (append-only divergences + shadow cost)
// ---------------------------------------------------------------------------

/** The fake shadow ledger's adversarial variants (the discrimination shapes). */
export type FakeShadowLedgerVariant = "double-booking";

/** The fake shadow ledger (the divergence ledger + the shadow cost ledger). */
export interface FakeShadowLedger extends ShadowLedgerPort {
  /** The proposals whose divergences landed, in append order. */
  readonly divergenceProposalIds: readonly string[];
}

/**
 * Create the fake shadow ledger: APPEND-ONLY — the divergence ledger
 * (every divergence case-by-case with both sides' digests; an
 * identical re-append REPLAYS, a different record under a recorded
 * (proposalId, caseId) key is REFUSED) and the shadow cost ledger
 * (the shadow's measured cost booked APART from the served
 * accounting; an identical re-booking REPLAYS). The `double-booking`
 * variant books the shadow cost onto the SERVED accounting rails as
 * well — the customer is billed for the shadow (the cost-separation
 * catch).
 */
export function createShadowLedger(options?: {
  readonly variant?: FakeShadowLedgerVariant;
  /** The serving path whose billed total the double-booking variant inflates. */
  readonly servingPath?: FakeServingPath;
}): FakeShadowLedger {
  const divergences: ShadowDivergenceRecord[] = [];
  const costs: ShadowCostLedgerEntry[] = [];
  const divergenceOrdinals = new Map<string, number>();
  const divergenceProposalIds: string[] = [];
  const variant = options?.variant;

  return {
    async appendDivergence(record) {
      const existing = divergences.find(
        (divergence) =>
          divergence.proposalId === record.proposalId && divergence.caseId === record.caseId,
      );
      if (existing !== undefined) {
        if (
          existing.incumbentDigest === record.incumbentDigest &&
          existing.shadowDigest === record.shadowDigest
        ) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      const ordinal = (divergenceOrdinals.get(record.proposalId) ?? 0) + 1;
      divergenceOrdinals.set(record.proposalId, ordinal);
      divergences.push({ ...record, ordinal });
      if (!divergenceProposalIds.includes(record.proposalId)) {
        divergenceProposalIds.push(record.proposalId);
      }
      return { accepted: true, replayed: false, refused: false };
    },
    divergencesFor(proposalId: string) {
      return divergences
        .filter((divergence) => divergence.proposalId === proposalId)
        .map((divergence) => ({ ...divergence }));
    },
    async bookShadowCost(entry) {
      const existing = costs.find((cost) => cost.proposalId === entry.proposalId);
      if (existing !== undefined) {
        if (existing.microUsd === entry.microUsd && existing.latencyMs === entry.latencyMs) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      costs.push({ ...entry, ordinal: 1 });
      if (variant === "double-booking") {
        // The DOUBLE-BOOKING: the shadow's cost ALSO lands in the
        // served totals — the customer is billed for the shadow.
        options?.servingPath?.addBilledMicroUsd(entry.microUsd);
      }
      return { accepted: true, replayed: false, refused: false };
    },
    costsFor(proposalId: string) {
      return costs.filter((cost) => cost.proposalId === proposalId).map((cost) => ({ ...cost }));
    },
    get divergenceProposalIds() {
      return [...divergenceProposalIds];
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
 * historical digest / the pinned probe member — the read-only input).
 * The DIVERGENT variant perturbs the served digest on the FIRST-served
 * case (a drifted serve: the population pin catch).
 */
export function createIncumbentExecutor(options?: {
  readonly variant?: "divergent";
}): FakeIncumbentExecutor {
  const servedCaseIds: string[] = [];
  return {
    async outcomeFor(input: { readonly dcase: ShadowTrafficCase }) {
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
// The fake traffic source (the recorded workload mix + the variants)
// ---------------------------------------------------------------------------

/** The fake traffic source's adversarial variants (the discrimination shapes). */
export type FakeTrafficSourceVariant = "dropped" | "duplicated" | "mixed-up";

/** The fake traffic source (the recorded workload mix serve). */
export interface FakeTrafficSource extends TrafficSourcePort {
  /** The populations served, in serve order. */
  readonly serveCount: number;
}

/**
 * Create the fake traffic source: the recorded workload mix serve —
 * the honest source serves the row's declared traffic population
 * exactly. The adversarial variants are the discrimination shapes the
 * population-completeness derivation catches:
 *
 *   * `dropped` — the LAST recorded traffic case never reaches the
 *     shadow comparison (a dropped case);
 *   * `duplicated` — the FIRST case is served TWICE (an inflated mix
 *     weight);
 *   * `mixed-up` — the last case is swapped for a FOREIGN case the
 *     recorded population does not hold (a mismatched mix).
 */
export function createTrafficSource(options?: {
  readonly variant?: FakeTrafficSourceVariant;
}): FakeTrafficSource {
  let serveCount = 0;
  return {
    async populationFor(input) {
      serveCount += 1;
      const variant = options?.variant;
      if (variant === undefined || input.population.length === 0) {
        return [...input.population];
      }
      if (variant === "dropped") {
        return input.population.slice(0, -1);
      }
      if (variant === "duplicated") {
        const first = input.population[0];
        return first === undefined
          ? [...input.population]
          : [first, ...input.population.map((tcase) => ({ ...tcase }))];
      }
      // mixed-up: the last recorded case is swapped for a foreign one.
      const last = input.population[input.population.length - 1];
      return last === undefined
        ? [...input.population]
        : [
            ...input.population.slice(0, -1),
            {
              ...last,
              caseId: `foreign-traffic-${last.caseId}`,
              sourceRef: `foreign-traffic-${last.sourceRef}`,
              inputDigest: longitudinalDigestOf(["foreign-traffic", last.caseId]),
              incumbentDigest: longitudinalDigestOf(["foreign-incumbent", last.caseId]),
            },
          ];
    },
    get serveCount() {
      return serveCount;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake serving path (the customer-facing serve + the LEAK variants)
// ---------------------------------------------------------------------------

/** The fake serving path's adversarial variants (the leak shapes). */
export type FakeServingPathVariant = "leaky" | "disguised";

/** The fake serving path (the customer-facing serve + the served accounting). */
export interface FakeServingPath extends ServingPathPort {
  /** The case ids served, in serve order. */
  readonly servedCaseIds: readonly string[];
  /**
   * Inflate the BILLED total (the reach-in the DOUBLE-BOOKING shadow
   * ledger variant uses — the served accounting's own incumbent basis
   * stays immutable so the delta is visible).
   */
  addBilledMicroUsd(delta: number): void;
}

/**
 * Create the fake serving path: the customer-facing serve — the
 * honest path serves the INCUMBENT's executed digest on every case
 * (the served-source pin) and books the incumbent's own measured cost
 * to the served accounting (3 micro-usd per serve plus the 1 micro-usd
 * base — the honest served basis; the billed total starts equal to
 * it). The adversarial variants are the leak shapes the
 * serving-isolation derivation catches:
 *
 *   * `leaky` — the customer is served the REPLACEMENT's outcome (an
 *     explicit leak: the shadow leaking into the serving path);
 *   * `disguised` — the serve CLAIMS the incumbent source while
 *     carrying the shadow's own digest (a disguised leak).
 */
export function createServingPath(options?: {
  readonly variant?: FakeServingPathVariant;
}): FakeServingPath {
  const servedCaseIds: string[] = [];
  let incumbentMicroUsd = 1;
  let billedMicroUsd = 1;
  let latencyMs = 0;
  return {
    async serve(input) {
      servedCaseIds.push(input.tcase.caseId);
      incumbentMicroUsd += 3;
      billedMicroUsd += 3;
      latencyMs += 7;
      if (options?.variant === "leaky") {
        return { servedSource: "replacement", servedDigest: input.shadowDigest };
      }
      if (options?.variant === "disguised") {
        return { servedSource: "incumbent", servedDigest: input.shadowDigest };
      }
      return { servedSource: "incumbent", servedDigest: input.incumbentDigest };
    },
    servedAccounting() {
      return { incumbentMicroUsd, billedMicroUsd, latencyMs };
    },
    addBilledMicroUsd(delta: number) {
      billedMicroUsd += delta;
    },
    get servedCaseIds() {
      return [...servedCaseIds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake shadow runtime (observation-only + the adversarial variants)
// ---------------------------------------------------------------------------

/** The fake shadow runtime's adversarial variants (the discrimination shapes). */
export type FakeShadowRuntimeVariant =
  | "escaping"
  | "aggregate-only"
  | "subset-compared"
  | "smoothing"
  | "unmeasured";

/** The fake shadow runtime (the replacement executing in shadow). */
export interface FakeShadowRuntime extends ShadowRuntimePort {
  /** The rows the runtime executed, in run order. */
  readonly runCount: number;
}

/**
 * Create the fake shadow runtime: the replacement executing in SHADOW
 * (observation-only — its outcomes are recorded, never served),
 * delegating to the platform's PURE honest shadow derivation (the
 * reference runtime). The adversarial variants:
 *
 *   * `escaping` — the untrusted code exercises NETWORK ACCESS
 *     MID-SHADOW (an undeclared, ungranted capability — a containment
 *     violation);
 *   * `aggregate-only` — the run asserts an aggregate agreement
 *     WITHOUT any per-case records (an aggregate-only claim);
 *   * `subset-compared` — the per-case records cover only a SUBSET of
 *     the population while the aggregate asserts full agreement;
 *   * `smoothing` — the first case's shadow digest is perturbed to
 *     diverge while the runtime CLAIMS agreement (a smoothed
 *     divergence);
 *   * `unmeasured` — the shadow cost is never measured.
 */
export function createShadowRuntime(options?: {
  readonly variant?: FakeShadowRuntimeVariant;
}): FakeShadowRuntime {
  let runCount = 0;
  return {
    async runShadow(input): Promise<ShadowRunOutcome> {
      runCount += 1;
      const honest = deriveHonestShadowRun({
        sourceProposalId: input.sourceProposalId,
        replacementShape: input.replacementShape,
        declaredCapabilities: input.declaredCapabilities,
        acceptanceCriterion: input.acceptanceCriterion,
        trafficPopulation: input.trafficPopulation,
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
      if (variant === "aggregate-only") {
        return {
          ...honest,
          outcomes: [],
          comparedCaseIds: [],
          aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
        };
      }
      if (variant === "subset-compared") {
        return {
          ...honest,
          comparedCaseIds: honest.comparedCaseIds.slice(0, -1),
        };
      }
      if (variant === "smoothing") {
        const first = input.trafficPopulation[0];
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
                  claimedAgrees: true,
                }
              : outcome,
          ),
          aggregateClaim: { assertedAgreement: true, assertedDivergenceCount: 0 },
        };
      }
      if (variant === "unmeasured") {
        return { ...honest, shadowCost: null };
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
export interface FakeShadowExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * shadow semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each shadow
 *    submission lands its OWN durable execution under its OWN
 *    idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (an honest refusal is a COMPLETED run; an honest
 *    divergence is an honest FAILED), never backwards;
 *  - GET /executions/:id/events — the canonical shadow trajectory
 *    surfaced as the public step-event journal (the app mechanically
 *    re-derives the trajectory digest over this read — never trusting
 *    the platform's claim);
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the run's own dispatches — zero offline, the
 *    live row's REAL residual-AI round), the honest verification
 *    statuses, honestly-absent offline usage, the shadow verdict read
 *    back (the kind, the refusal reason, the divergent cases, the leak
 *    kind), the lifecycle landing (the shadow stage ONLY), the
 *    per-case comparison records (both sides' digests + the claimed
 *    agreement), the asserted aggregate, the customer-facing served
 *    outcomes, the shadow cost measurement, the served accounting
 *    (incumbent basis + billed total), the shadow-ledger booking and
 *    the exercised capabilities.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `leaked` serves the replacement's outcome on the first case;
 * `disguised` claims the incumbent source while serving the shadow's
 * digest; `dropped` surfaces only a subset of the per-case records;
 * `aggregateOnly` surfaces no per-case records at all; `smoothed`
 * perturbs one case's digest while claiming agreement; `billed`
 * inflates the served total by the shadow cost; `skipped` surfaces
 * the landing past the shadow stage (`canaried`); `escaping` exercises
 * network access mid-shadow; `unmeasured` surfaces no shadow cost.
 */
export function createShadowFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The adversarial knob: the replacement's outcome is served (an explicit leak). */
  readonly leaked?: boolean;
  /** The adversarial knob: the shadow's digest served under the incumbent source (a disguised leak). */
  readonly disguised?: boolean;
  /** The adversarial knob: only a subset of the per-case records is surfaced. */
  readonly dropped?: boolean;
  /** The adversarial knob: no per-case records are surfaced at all. */
  readonly aggregateOnly?: boolean;
  /** The adversarial knob: one case is perturbed but claimed agreeing. */
  readonly smoothed?: boolean;
  /** The adversarial knob: the served total is inflated by the shadow cost. */
  readonly billed?: boolean;
  /** The adversarial knob: the landing surfaces past the shadow stage. */
  readonly skipped?: boolean;
  /** The adversarial knob: the replacement exercises network access mid-shadow. */
  readonly escaping?: boolean;
  /** The adversarial knob: the shadow cost is never measured. */
  readonly unmeasured?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeShadowExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeShadowExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string) =>
    SHADOW_EXECUTION_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The world's surfaced run for one corpus row (the honest derivation + the knobs). */
  const surfacedRunOf = (rowId: string) => {
    const row = rowById(rowId);
    if (row === null) {
      return null;
    }
    const { honestRun, regression } = pinnedShadowRunOf(row);
    const refusal =
      row.expected.refusalReason === null ? null : { reason: row.expected.refusalReason };

    let comparisons = honestRun.outcomes.map((outcome) => {
      const tcase = row.trafficPopulation.find((candidate) => candidate.caseId === outcome.caseId);
      return {
        caseId: outcome.caseId,
        incumbentDigest: tcase?.incumbentDigest ?? "",
        shadowDigest: outcome.digest,
        claimedAgrees: outcome.claimedAgrees,
      };
    });
    if (refusal !== null) {
      // The honest-refusal path: nothing executed, nothing compared.
      comparisons = [];
    }
    if (options.dropped === true) {
      comparisons = comparisons.slice(0, -1);
    }
    if (options.aggregateOnly === true) {
      comparisons = [];
    }
    if (options.smoothed === true) {
      const first = comparisons[0];
      if (first !== undefined) {
        comparisons = comparisons.map((comparison) =>
          comparison.caseId === first.caseId
            ? {
                caseId: comparison.caseId,
                incumbentDigest: comparison.incumbentDigest,
                shadowDigest: longitudinalDigestOf(["smoothed-perturbation", comparison.caseId]),
                claimedAgrees: true,
              }
            : comparison,
        );
      }
    }

    const servedOutcomes =
      refusal !== null
        ? []
        : row.trafficPopulation.map((tcase) => {
            const shadowDigest =
              honestRun.outcomes.find((outcome) => outcome.caseId === tcase.caseId)?.digest ?? "";
            if (options.leaked === true && tcase.caseId === row.trafficPopulation[0]?.caseId) {
              return {
                caseId: tcase.caseId,
                servedSource: "replacement",
                servedDigest: shadowDigest,
              };
            }
            if (options.disguised === true && tcase.caseId === row.trafficPopulation[0]?.caseId) {
              return {
                caseId: tcase.caseId,
                servedSource: "incumbent",
                servedDigest: shadowDigest,
              };
            }
            return {
              caseId: tcase.caseId,
              servedSource: "incumbent",
              servedDigest: tcase.incumbentDigest,
            };
          });

    const exercised =
      refusal !== null
        ? []
        : options.escaping === true
          ? [...row.declaredCapabilities, "network-access"]
          : [...row.declaredCapabilities];

    const shadowMeasurement =
      refusal !== null || options.unmeasured === true
        ? null
        : referenceShadowMeasurementOf(row.trafficPopulation);
    const servedIncumbentMicroUsd = refusal === null ? 3 * row.trafficPopulation.length + 1 : 0;
    const servedCostMicroUsd =
      options.billed === true && shadowMeasurement !== null
        ? servedIncumbentMicroUsd + shadowMeasurement.microUsd
        : servedIncumbentMicroUsd;

    const verdictKind: ShadowVerdictKind =
      options.escaping === true
        ? "containment-violation"
        : refusal !== null
          ? "honest-refusal"
          : regression.mechanicalDivergenceCaseIds.length > 0
            ? "honest-divergence"
            : "shadow-agreement";

    return {
      row,
      refusal,
      regression,
      comparisons,
      servedOutcomes,
      exercised,
      shadowMeasurement,
      servedIncumbentMicroUsd,
      servedCostMicroUsd,
      verdictKind,
    };
  };

  /** The row's honest shadow trajectory events under the surfaced run. */
  const eventsFor = (row: FakeShadowExecutionRow): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    const { honestRun, regression } = pinnedShadowRunOf(corpusRow);
    const shadowMeasurement = referenceShadowMeasurementOf(corpusRow.trafficPopulation);
    const steps = shadowTrajectoryStepsOf({
      proposalId: corpusRow.sourceProposalId,
      populationDigest: shadowPopulationDigestOf(corpusRow.trafficPopulation),
      servedExecutionDigest: longitudinalDigestOf([
        "incumbent-served",
        ...corpusRow.trafficPopulation.map((tcase) => tcase.incumbentDigest),
      ]),
      shadowExecutionDigest: longitudinalDigestOf([
        "shadow-executed",
        ...honestRun.outcomes.map((outcome) => outcome.digest),
      ]),
      isolationContainment: corpusRow.expected.refusalReason === null ? "contained" : null,
      regressionVerdictDigest: corpusRow.expected.refusalReason === null ? regression.digest : null,
      divergenceCount: corpusRow.expected.divergenceCaseIds.length,
      shadowCostDigest:
        corpusRow.expected.refusalReason === null
          ? shadowCostDigestOf({
              proposalId: corpusRow.sourceProposalId,
              microUsd: shadowMeasurement.microUsd,
              latencyMs: shadowMeasurement.latencyMs,
            })
          : null,
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
      // platform driving the shadow run) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "shadow-execution.regression.v1", input: "shadow" },
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
          strategyClass: "shadow-execution",
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
                divergenceCaseIds: surfaced.regression?.mechanicalDivergenceCaseIds ?? [],
                leakKind:
                  options.leaked === true
                    ? "explicit-leak"
                    : options.disguised === true
                      ? "disguised-leak"
                      : null,
              },
        lifecycleLanding:
          surfaced === null || surfaced.refusal !== null
            ? null
            : {
                proposalId: surfaced.row.sourceProposalId,
                finalStage: options.skipped === true ? "canaried" : SHADOW_STAGE,
              },
        comparisons: surfaced?.comparisons ?? [],
        aggregate:
          surfaced !== null && surfaced.refusal === null && surfaced.regression.honest
            ? {
                assertedAgreement:
                  (surfaced.regression?.mechanicalDivergenceCaseIds.length ?? 0) === 0,
                assertedDivergenceCount:
                  surfaced.regression?.mechanicalDivergenceCaseIds.length ?? 0,
              }
            : null,
        servedOutcomes: surfaced?.servedOutcomes ?? [],
        shadowCost: surfaced?.shadowMeasurement ?? null,
        servedAccounting: {
          incumbentMicroUsd: surfaced?.servedIncumbentMicroUsd ?? 0,
          billedMicroUsd: surfaced?.servedCostMicroUsd ?? 0,
        },
        shadowLedgerBookedMicroUsd: surfaced?.shadowMeasurement?.microUsd ?? null,
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
 * The honest fake stack: the read-only registry, the pre-seeded
 * lifecycle ledger (the recorded VAL-033 walk), the append-only shadow
 * ledger, the deterministic incumbent executor, the recorded traffic
 * source, the incumbent-served serving path and the observation-only
 * honest shadow runtime — the world every offline row passes over
 * (the adversarial variants are the discrimination worlds).
 */
export function createHonestShadowStack(): {
  readonly registry: FakeCandidateRegistry;
  readonly lifecycle: FakeLifecycleLedger;
  readonly shadowLedger: FakeShadowLedger;
  readonly incumbentExecutor: FakeIncumbentExecutor;
  readonly trafficSource: FakeTrafficSource;
  readonly servingPath: FakeServingPath;
  readonly shadowRuntime: FakeShadowRuntime;
  readonly clock: TickClock;
} {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createServingPath();
  return {
    registry,
    lifecycle: createLifecycleLedger(),
    shadowLedger: createShadowLedger(),
    incumbentExecutor: createIncumbentExecutor(),
    trafficSource: createTrafficSource(),
    servingPath,
    shadowRuntime: createShadowRuntime(),
    clock,
  };
}
