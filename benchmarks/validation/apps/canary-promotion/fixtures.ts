/**
 * The canary-promotion application's deterministic fixtures (VAL-035,
 * AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fake candidate registry — VAL-032's proposals pre-seeded as
 *     the READ-ONLY input (the registry identities the canary corpus
 *     pins, re-derived exactly as VAL-032 recorded them, plus the
 *     not-yet-shadow-executed entry the premature-refusal row refuses
 *     honestly). The registry is never rewritten by an honest run;
 *     the REWRITE-REGISTRY ledger variant reaches into its store and
 *     REWRITES a candidate's entry (the read-only catch);
 *   * the fake candidate lifecycle ledger — the RECORDED VAL-033 +
 *     VAL-034 walk pre-seeded for every shadow-executed candidate (the
 *     read-only input) plus the APPEND-ONLY canary transitions: the
 *     `canaried` rung, then the `promoted` rung on a clean full ramp
 *     (an identical re-append REPLAYS; a different transition under a
 *     recorded key is REFUSED). The adversarial variants are the
 *     discrimination shapes: `jump-to-promoted` lands the append at
 *     `promoted` directly (skipping the canaried rung),
 *     `broken-walk` pre-seeds the walk WITHOUT the shadow-executed
 *     transition (the canary refuses honestly where the row pinned a
 *     promotion), `wrong-stage` lands at `property-tested`,
 *     `evidence-less` appends without evidence, and
 *     `rewrite-registry` REWRITES the registry's own candidate entry
 *     on append;
 *   * the fake canary ledger — APPEND-ONLY: the decision ledger (every
 *     step's decision with its policy citations and checks), the
 *     divergence ledger (per-step divergences case-by-case with both
 *     sides' digests), the rollback-event ledger (the EXERCISED
 *     rollback records) and the canary cost ledger (booked APART under
 *     the canary marker). The `smoothing-decisions` variant rewrites a
 *     beyond-budget decision's kind to `advance` (a smoothed breach),
 *     the `decisionless` variant drops a step's decision append, and
 *     the `unmarked-double-booking` variant books the canary cost onto
 *     the SERVED rails without its canary marker (the customer is
 *     billed for the canary);
 *   * the fake traffic source — the recorded workload mix serve (the
 *     honest source serves the row's declared population exactly);
 *   * the fake canary serving path — the customer-facing slice serve:
 *     the honest path serves the INCUMBENT's executed digest outside
 *     the step's granted slice and the REPLACEMENT's digest inside it,
 *     and the revert is complete and mechanical. The adversarial
 *     variants are the discrimination shapes: `over-slice` serves the
 *     replacement BEYOND the step's pinned slice (an unpromoted
 *     candidate serving beyond its canary slice) and
 *     `partial-rollback` leaves the LAST slice case still serving the
 *     replacement after the revert (never partial);
 *   * the fake canary runtime — the replacement serving its granted
 *     slice, delegating to the platform's PURE honest canary step
 *     derivation; the adversarial variants are the discrimination
 *     shapes: ESCAPING (the untrusted code exercises network access
 *     MID-CANARY — a containment violation), BREACHING (a slice
 *     outcome digest is perturbed so the step observes a divergence)
 *     and UNMEASURED (the canary cost is never measured);
 *   * the fake API world — the transport-level fake implementing the
 *     platform's OWN canary semantics at the customer boundary, with
 *     the same discrimination knobs;
 *   * the tick clock — the deterministic injectable clock.
 *
 * Everything is digests and identities — payload bytes never enter
 * the fixtures, and no credential is ever read.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  CanaryCostLedgerEntry,
  CanaryDecisionRecord,
  CanaryDivergenceRecord,
  CanaryLedgerPort,
  CanaryLedgerReceipt,
  CanaryLifecycleLedgerPort,
  CanaryRuntimePort,
  CanaryServingPathPort,
  CanaryStepOutcome,
  CanaryTrafficSourcePort,
  CanaryVerdictKind,
  DifferentialCase,
  RollbackEventRecord,
  ServedAccountingSnapshot,
} from "../../platform/canary-promotion";
import {
  CANARY_COST_MARKER,
  canaryCostDigestOf,
  canaryDecisionDigestOf,
  canarySliceDigestOf,
  canaryTrajectoryStepsOf,
  deriveHonestCanaryStep,
  rampScheduleDigestOf,
  referenceCanaryMeasurementOf,
  rollbackPlanDigestOf,
  sliceCaseIdsOf,
} from "../../platform/canary-promotion";
import type {
  EquivalenceRegistryFacts,
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
} from "../../platform/equivalence-testing";
import { differentialPopulationDigestOf } from "../../platform/equivalence-testing";
import type { DiscoveryProposalRecord } from "../../platform/learning-discovery";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import type { SourceProposalPin } from "../equivalence-testing/corpus";
import {
  CANARY_PROMOTION_CORPUS,
  notYetShadowedWalkOf,
  PINNED_REGISTRY_ENTRIES,
  pinnedCanaryRampOf,
  priorWalkOf,
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
 * Create the fake candidate registry: pre-seeded with the canary
 * corpus's pinned VAL-032 proposals (the registry identities the
 * canary rows cite — read-only inputs, never rewritten by an honest
 * run). The store is internally mutable ONLY so the REWRITE-REGISTRY
 * ledger variant can perform its rewrite (the discrimination shape
 * the read-only discipline catches).
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
      return longitudinalDigestOf(["candidate-registry", facts()]);
    },
    store() {
      return entries;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake candidate lifecycle ledger (recorded walk + append-only canary)
// ---------------------------------------------------------------------------

/** The fake lifecycle ledger's adversarial variants (the discrimination shapes). */
export type FakeLifecycleVariant =
  | "jump-to-promoted"
  | "broken-walk"
  | "wrong-stage"
  | "evidence-less"
  | "rewrite-registry";

/** The fake candidate lifecycle ledger (with its own transitions view). */
export interface FakeLifecycleLedger extends CanaryLifecycleLedgerPort {
  /** The proposals whose canary transitions landed, in append order. */
  readonly landedProposalIds: readonly string[];
}

/**
 * The candidates whose recorded walk the ledger pre-seeds: every
 * shadow-executed source of the pinned corpus gets the FULL evidenced
 * chain (the read-only input); the not-yet-shadow-executed entry gets
 * VAL-033's landing WITHOUT the shadow append (its canary refuses
 * honestly).
 */
function preSeededWalks(): readonly LifecycleTransitionRecord[] {
  const transitions: LifecycleTransitionRecord[] = [];
  const seeded = new Set<string>();
  for (const row of CANARY_PROMOTION_CORPUS) {
    if (row.expected.refusalReason === null) {
      if (seeded.has(row.sourceProposalId)) {
        continue;
      }
      seeded.add(row.sourceProposalId);
      for (const prior of priorWalkOf(row)) {
        transitions.push({ ...prior });
      }
    } else if (row.expected.refusalReason === "candidate-not-shadow-executed") {
      if (seeded.has(row.sourceProposalId)) {
        continue;
      }
      seeded.add(row.sourceProposalId);
      for (const prior of notYetShadowedWalkOf(row.sourceProposalId)) {
        transitions.push({ ...prior });
      }
    }
  }
  return transitions;
}

/**
 * Create the fake candidate lifecycle ledger: the RECORDED VAL-033 +
 * VAL-034 walk pre-seeded for every shadow-executed candidate (the
 * `offline-replayed` + `differentially-evaluated` + `shadow-executed`
 * transitions with their canonical evidence digests — the read-only
 * input), plus the APPEND-ONLY canary transitions (an IDENTICAL
 * re-append REPLAYS idempotently; a DIFFERENT transition under a
 * recorded (proposalId, stage) key is REFUSED). The adversarial
 * variants are the discrimination shapes the lifecycle-completeness /
 * read-only derivations catch:
 *
 *   * `jump-to-promoted` — the canary append lands at `promoted`
 *     DIRECTLY (skipping the canaried rung — a jumped rung);
 *   * `broken-walk` — the pre-seeded walk DROPS the shadow-executed
 *     transition (the candidate never earned the canary's source
 *     rung — the honest run refuses where the row pinned a promotion);
 *   * `wrong-stage` — the canary append lands at `property-tested` (a
 *     wrong-stage landing — not this slice's append);
 *   * `evidence-less` — the canary append lands without its evidence
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

  // The recorded VAL-033 + VAL-034 walk (the read-only pre-seed).
  for (const prior of preSeededWalks()) {
    if (variant === "broken-walk" && prior.toStage === "shadow-executed") {
      continue;
    }
    transitions.push({ ...prior });
    ordinals.set(prior.proposalId, prior.ordinal);
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
        variant === "jump-to-promoted"
          ? ("promoted" as const)
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
// The fake canary ledger (append-only decisions/divergences/rollbacks/cost)
// ---------------------------------------------------------------------------

/** The fake canary ledger's adversarial variants (the discrimination shapes). */
export type FakeCanaryLedgerVariant =
  | "smoothing-decisions"
  | "decisionless"
  | "unmarked-double-booking";

/** The fake canary ledger (the decision/divergence/rollback/cost ledgers). */
export interface FakeCanaryLedger extends CanaryLedgerPort {
  /** The proposals whose decisions landed, in append order. */
  readonly decisionProposalIds: readonly string[];
}

/**
 * Create the fake canary ledger: APPEND-ONLY — the decision ledger
 * (every step's decision with its policy citations and checks; an
 * identical re-append REPLAYS, a different decision under a recorded
 * (proposalId, stepIndex) key is REFUSED), the divergence ledger
 * (per-step divergences case-by-case with both sides' digests), the
 * rollback-event ledger (the EXERCISED rollback records) and the
 * canary cost ledger (booked APART under the canary marker). The
 * adversarial variants are the discrimination shapes the
 * policy-explicitness / breach-honesty / cost-separation derivations
 * catch:
 *
 *   * `smoothing-decisions` — a beyond-budget decision's kind is
 *     REWRITTEN to `advance` on append (a smoothed breach that
 *     advances anyway);
 *   * `decisionless` — the FIRST decision append is DROPPED (an
 *     executed step without its decision — its policy was never
 *     stated);
 *   * `unmarked-double-booking` — the canary cost is booked WITHOUT
 *     its canary marker AND onto the SERVED accounting rails — the
 *     customer is billed for the canary (the cost-separation catch).
 */
export function createCanaryLedger(options?: {
  readonly variant?: FakeCanaryLedgerVariant;
  /** The serving path whose billed total the double-booking variant inflates. */
  readonly servingPath?: FakeCanaryServingPath;
}): FakeCanaryLedger {
  const decisions: CanaryDecisionRecord[] = [];
  const divergences: CanaryDivergenceRecord[] = [];
  const rollbackEvents: RollbackEventRecord[] = [];
  const costs: CanaryCostLedgerEntry[] = [];
  const decisionOrdinals = new Map<string, number>();
  const divergenceOrdinals = new Map<string, number>();
  const rollbackOrdinals = new Map<string, number>();
  const decisionProposalIds: string[] = [];
  let decisionAppendCount = 0;
  const variant = options?.variant;

  return {
    async appendDecision(record): Promise<CanaryLedgerReceipt> {
      decisionAppendCount += 1;
      if (variant === "decisionless" && decisionAppendCount === 1) {
        // The DECISIONLESS world: the first executed step's decision
        // never lands — its policy was never stated.
        return { accepted: true, replayed: false, refused: false };
      }
      const kind =
        variant === "smoothing-decisions" && record.kind === "breach-rollback"
          ? ("advance" as const)
          : record.kind;
      const stored: CanaryDecisionRecord = { ...record, kind };
      const existing = decisions.find(
        (decision) =>
          decision.proposalId === record.proposalId && decision.stepIndex === record.stepIndex,
      );
      if (existing !== undefined) {
        const { ordinal: _existingOrdinal, ...existingContent } = existing;
        const { ordinal: _storedOrdinal, ...storedContent } = stored;
        if (canaryDecisionDigestOf(existingContent) === canaryDecisionDigestOf(storedContent)) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      const ordinal = (decisionOrdinals.get(record.proposalId) ?? 0) + 1;
      decisionOrdinals.set(record.proposalId, ordinal);
      decisions.push({ ...stored, ordinal });
      if (!decisionProposalIds.includes(record.proposalId)) {
        decisionProposalIds.push(record.proposalId);
      }
      return { accepted: true, replayed: false, refused: false };
    },
    decisionsFor(proposalId: string) {
      return decisions
        .filter((decision) => decision.proposalId === proposalId)
        .map((decision) => ({ ...decision }));
    },
    async appendDivergence(record): Promise<CanaryLedgerReceipt> {
      const existing = divergences.find(
        (divergence) =>
          divergence.proposalId === record.proposalId &&
          divergence.stepIndex === record.stepIndex &&
          divergence.caseId === record.caseId,
      );
      if (existing !== undefined) {
        if (
          existing.incumbentDigest === record.incumbentDigest &&
          existing.replacementDigest === record.replacementDigest
        ) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      const key = `${record.proposalId}:${record.stepIndex}`;
      const ordinal = (divergenceOrdinals.get(key) ?? 0) + 1;
      divergenceOrdinals.set(key, ordinal);
      divergences.push({ ...record, ordinal });
      return { accepted: true, replayed: false, refused: false };
    },
    divergencesFor(proposalId: string) {
      return divergences
        .filter((divergence) => divergence.proposalId === proposalId)
        .map((divergence) => ({ ...divergence }));
    },
    async appendRollbackEvent(record): Promise<CanaryLedgerReceipt> {
      const existing = rollbackEvents.find(
        (event) => event.proposalId === record.proposalId && event.stepIndex === record.stepIndex,
      );
      if (existing !== undefined) {
        if (existing.planDigest === record.planDigest) {
          return { accepted: true, replayed: true, refused: false };
        }
        return { accepted: false, replayed: false, refused: true };
      }
      const ordinal = (rollbackOrdinals.get(record.proposalId) ?? 0) + 1;
      rollbackOrdinals.set(record.proposalId, ordinal);
      rollbackEvents.push({ ...record, ordinal });
      return { accepted: true, replayed: false, refused: false };
    },
    rollbackEventsFor(proposalId: string) {
      return rollbackEvents
        .filter((event) => event.proposalId === proposalId)
        .map((event) => ({ ...event }));
    },
    async bookCanaryCost(entry): Promise<CanaryLedgerReceipt> {
      const existing = costs.find(
        (cost) =>
          cost.proposalId === entry.proposalId &&
          cost.microUsd === entry.microUsd &&
          cost.latencyMs === entry.latencyMs,
      );
      if (existing !== undefined) {
        return { accepted: true, replayed: true, refused: false };
      }
      const ordinal = costs.filter((cost) => cost.proposalId === entry.proposalId).length + 1;
      if (variant === "unmarked-double-booking") {
        // The UNMARKED DOUBLE-BOOKING: the canary's cost lands in the
        // served totals too — the customer is billed for the canary —
        // and the booking loses its canary marker (unattributable
        // apart-booking).
        options?.servingPath?.addBilledMicroUsd(entry.microUsd);
        costs.push({
          proposalId: entry.proposalId,
          marker: "" as typeof entry.marker,
          microUsd: entry.microUsd,
          latencyMs: entry.latencyMs,
          ordinal,
        });
        return { accepted: true, replayed: false, refused: false };
      }
      costs.push({ ...entry, ordinal });
      return { accepted: true, replayed: false, refused: false };
    },
    canaryCostsFor(proposalId: string) {
      return costs.filter((cost) => cost.proposalId === proposalId).map((cost) => ({ ...cost }));
    },
    get decisionProposalIds() {
      return [...decisionProposalIds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake incumbent executor (deterministic)
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
 */
export function createIncumbentExecutor(): FakeIncumbentExecutor {
  const servedCaseIds: string[] = [];
  return {
    async outcomeFor(input: { readonly dcase: DifferentialCase }) {
      servedCaseIds.push(input.dcase.caseId);
      return { digest: input.dcase.incumbentDigest };
    },
    get servedCaseIds() {
      return [...servedCaseIds];
    },
  };
}

// ---------------------------------------------------------------------------
// The fake traffic source (the recorded workload mix)
// ---------------------------------------------------------------------------

/** The fake traffic source (the recorded workload mix serve). */
export interface FakeTrafficSource extends CanaryTrafficSourcePort {
  /** The populations served, in serve order. */
  readonly serveCount: number;
}

/**
 * Create the fake traffic source: the recorded workload mix serve —
 * the honest source serves the row's declared traffic population
 * exactly.
 */
export function createTrafficSource(): FakeTrafficSource {
  let serveCount = 0;
  return {
    async populationFor(input) {
      serveCount += 1;
      return [...input.population];
    },
    get serveCount() {
      return serveCount;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake canary serving path (the slice serve + the mechanical revert)
// ---------------------------------------------------------------------------

/** The fake canary serving path's adversarial variants (the discrimination shapes). */
export type FakeServingPathVariant = "over-slice" | "partial-rollback";

/** The fake canary serving path (the slice serve + the revert + the accounting). */
export interface FakeCanaryServingPath extends CanaryServingPathPort {
  /** The case ids served, in serve order. */
  readonly servedCaseIds: readonly string[];
  /**
   * Inflate the BILLED total (the reach-in the DOUBLE-BOOKING canary
   * ledger variant uses — the served accounting's own incumbent basis
   * stays immutable so the delta is visible).
   */
  addBilledMicroUsd(delta: number): void;
}

/**
 * Create the fake canary serving path: the customer-facing slice
 * serve — the honest path serves the INCUMBENT's executed digest on
 * every case OUTSIDE the step's granted slice and the REPLACEMENT's
 * digest on every case INSIDE it (the slice is the deterministic
 * membership of the step's pinned fraction), books the incumbent's own
 * measured cost to the served accounting (3 micro-usd per serve plus
 * the 1 micro-usd base — the honest served basis; the billed total
 * starts equal to it), and the revert is complete and mechanical (the
 * WHOLE slice reverts to the incumbent). The adversarial variants are
 * the discrimination shapes the slice-isolation / rollback-completeness
 * derivations catch:
 *
 *   * `over-slice` — the replacement is ALSO served on the FIRST
 *     non-slice case of every step (an unpromoted candidate serving
 *     beyond its canary slice);
 *   * `partial-rollback` — the revert leaves the LAST slice case
 *     still serving the replacement (never partial).
 */
export function createCanaryServingPath(options?: {
  readonly variant?: FakeServingPathVariant;
}): FakeCanaryServingPath {
  const servedCaseIds: string[] = [];
  let incumbentMicroUsd = 1;
  let billedMicroUsd = 1;
  let latencyMs = 0;
  const variant = options?.variant;
  return {
    async serveStep(input) {
      servedCaseIds.push(input.tcase.caseId);
      incumbentMicroUsd += 3;
      billedMicroUsd += 3;
      latencyMs += 7;
      if (input.inSlice && input.replacementDigest !== null) {
        return { servedSource: "replacement", servedDigest: input.replacementDigest };
      }
      if (variant === "over-slice" && !input.inSlice) {
        // The OVER-SLICE world: the replacement is served beyond the
        // step's pinned slice — an unpromoted candidate serving beyond
        // its canary slice.
        return {
          servedSource: "replacement",
          servedDigest: longitudinalDigestOf(["over-slice-serve", input.tcase.caseId]),
        };
      }
      return { servedSource: "incumbent", servedDigest: input.incumbentDigest };
    },
    async revertToIncumbent(input) {
      const observations = input.sliceCaseIds.map((caseId, index) => {
        if (variant === "partial-rollback" && index === input.sliceCaseIds.length - 1) {
          // The PARTIAL-ROLLBACK world: the last slice case is LEFT
          // serving the replacement after the revert — never partial.
          return { caseId, servedSource: "replacement" };
        }
        return { caseId, servedSource: "incumbent" };
      });
      return observations;
    },
    servedAccounting(): ServedAccountingSnapshot {
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
// The fake canary runtime (the replacement serving its granted slice)
// ---------------------------------------------------------------------------

/** The fake canary runtime's adversarial variants (the discrimination shapes). */
export type FakeCanaryRuntimeVariant = "escaping" | "breaching" | "unmeasured";

/** The fake canary runtime (the replacement serving its granted slice). */
export interface FakeCanaryRuntime extends CanaryRuntimePort {
  /** The steps the runtime executed, in run order. */
  readonly runCount: number;
}

/**
 * Create the fake canary runtime: the replacement serving its granted
 * slice (the incumbent serves the remainder), delegating to the
 * platform's PURE honest canary step derivation (the reference
 * runtime). The adversarial variants are the discrimination shapes:
 *
 *   * `escaping` — the untrusted code exercises NETWORK ACCESS
 *     MID-CANARY (an undeclared, ungranted capability — a containment
 *     violation);
 *   * `breaching` — the FIRST slice case's replacement digest is
 *     perturbed so the step observes a real divergence (the
 *     beyond-budget trigger over an otherwise-clean row);
 *   * `unmeasured` — the canary cost is never measured.
 */
export function createCanaryRuntime(options?: {
  readonly variant?: FakeCanaryRuntimeVariant;
}): FakeCanaryRuntime {
  let runCount = 0;
  return {
    async runCanaryStep(input): Promise<CanaryStepOutcome> {
      runCount += 1;
      const honest = deriveHonestCanaryStep({
        sourceProposalId: input.sourceProposalId,
        replacementShape: input.replacementShape,
        declaredCapabilities: input.declaredCapabilities,
        acceptanceCriterion: input.acceptanceCriterion,
        trafficPopulation: input.trafficPopulation,
        stepIndex: input.stepIndex,
        sliceFraction: input.sliceFraction,
        budgetLimit: input.budgetLimit,
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
      if (variant === "breaching") {
        const first = honest.sliceCaseIds[0];
        if (first === undefined) {
          return honest;
        }
        return {
          ...honest,
          outcomes: honest.outcomes.map((outcome) =>
            outcome.caseId === first
              ? {
                  caseId: outcome.caseId,
                  digest: longitudinalDigestOf(["breaching-perturbation", outcome.caseId]),
                  claimedAgrees: false,
                }
              : outcome,
          ),
          aggregateClaim: {
            assertedDivergenceCount: honest.aggregateClaim?.assertedDivergenceCount + 1 ?? 1,
            assertedWithinBudget: false,
          },
        };
      }
      if (variant === "unmeasured") {
        return { ...honest, canaryCost: null };
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
export interface FakeCanaryExecutionRow {
  readonly id: string;
  readonly key: string;
  /** The corpus rowId the submission's task body carried. */
  readonly taskRowId: string;
  status: string;
  readonly createdAt: number;
}

/**
 * The executed steps' aggregate reference canary measurement (the
 * honest cost basis: the ramp STOPS at the breach — only the executed
 * steps' slices ever measure their canary cost).
 */
function executedCanaryCostOf(
  ramp: ReturnType<typeof pinnedCanaryRampOf>,
  executedSteps: readonly { readonly stepIndex: number }[],
): { readonly microUsd: number; readonly latencyMs: number } {
  return executedSteps.reduce(
    (total, step) => {
      const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
      const measurement = referenceCanaryMeasurementOf(honest?.sliceCaseIds ?? []);
      return {
        microUsd: total.microUsd + measurement.microUsd,
        latencyMs: total.latencyMs + measurement.latencyMs,
      };
    },
    { microUsd: 0, latencyMs: 0 },
  );
}

/**
 * The transport-level fake public API implementing the platform's OWN
 * canary semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each canary
 *    submission lands its OWN durable execution under its OWN
 *    idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path (an honest refusal is a COMPLETED run; an honest
 *    rollback is an honest FAILED), never backwards;
 *  - GET /executions/:id/events — the canonical canary trajectory
 *    surfaced as the public step-event journal (the app mechanically
 *    re-derives the trajectory digest over this read — never trusting
 *    the platform's claim);
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the run's own dispatches — zero offline, the
 *    live row's REAL residual-AI round), the honest verification
 *    statuses, honestly-absent offline usage, the canary verdict read
 *    back (the kind, the refusal reason, the breaching step, the final
 *    stage), the lifecycle landing (the pinned final stage only), the
 *    read-back canary decisions (with their policy citations and
 *    checks), the per-case slice comparisons (both sides' digests +
 *    the claimed agreement), the rollback events (with their residual
 *    serves) and the rollback-plan record, the customer-facing served
 *    outcomes, the canary cost measurement, the served accounting
 *    (incumbent basis + billed total), the canary-ledger booking with
 *    its marker, and the exercised capabilities.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `skipped` surfaces the landing past the pinned final stage
 * (`promoted`); `unchecked` strips the decisions' policy
 * citations/checks; `smoothed` flips the breaching step's decision to
 * an advance claiming a within-budget count; `overslice` serves the
 * replacement beyond the step's slice; `foreigntenant` serves a
 * foreign case outside the population; `partialrollback` leaves a
 * residual case serving the replacement after the revert;
 * `planmissing` surfaces no recorded rollback plan; `escaping`
 * exercises network access mid-canary; `unmeasured` surfaces no
 * canary cost; `unmarked` surfaces the canary booking without its
 * marker; `billed` inflates the served total by the canary cost.
 */
export function createCanaryFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** The adversarial knob: the landing surfaces past the pinned final stage. */
  readonly skipped?: boolean;
  /** The adversarial knob: the decisions cite no stated-and-checked policy. */
  readonly unchecked?: boolean;
  /** The adversarial knob: the breaching step's decision advances anyway. */
  readonly smoothed?: boolean;
  /** The adversarial knob: the replacement is served beyond the step's slice. */
  readonly overslice?: boolean;
  /** The adversarial knob: a foreign case (outside the population) is served the replacement. */
  readonly foreigntenant?: boolean;
  /** The adversarial knob: the revert leaves a residual case serving the replacement. */
  readonly partialrollback?: boolean;
  /** The adversarial knob: no rollback plan is surfaced as recorded. */
  readonly planmissing?: boolean;
  /** The adversarial knob: the replacement exercises network access mid-canary. */
  readonly escaping?: boolean;
  /** The adversarial knob: the canary cost is never measured. */
  readonly unmeasured?: boolean;
  /** The adversarial knob: the canary booking loses its canary marker. */
  readonly unmarked?: boolean;
  /** The adversarial knob: the served total is inflated by the canary cost. */
  readonly billed?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, FakeCanaryExecutionRow>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, FakeCanaryExecutionRow>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string) =>
    CANARY_PROMOTION_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The world's surfaced run for one corpus row (the honest derivation + the knobs). */
  const surfacedRunOf = (rowId: string) => {
    const row = rowById(rowId);
    if (row === null) {
      return null;
    }
    const refusal =
      row.expected.refusalReason === null ? null : { reason: row.expected.refusalReason };
    const ramp = pinnedCanaryRampOf(row);
    const executedSteps =
      refusal !== null
        ? []
        : row.expected.breachingStepIndex === null
          ? row.rampSchedule
          : row.rampSchedule.filter(
              (step) => step.stepIndex <= (row.expected.breachingStepIndex ?? 0),
            );

    const decisions = executedSteps.map((step) => {
      const divergences =
        ramp.divergencesByStep.find((entry) => entry.stepIndex === step.stepIndex)
          ?.divergenceCaseIds ?? [];
      const breaching = divergences.length > row.failureBudget.maxDivergencesPerStep;
      const smoothedDecision =
        options.smoothed === true && breaching
          ? { kind: "advance" as const, observedDivergenceCount: 0 }
          : {
              kind: (breaching ? "breach-rollback" : "advance") as string,
              observedDivergenceCount: divergences.length,
            };
      return {
        stepIndex: step.stepIndex,
        kind: smoothedDecision.kind,
        sliceFraction: step.trafficFraction,
        observedDivergenceCount: smoothedDecision.observedDivergenceCount,
        budgetLimit: row.failureBudget.maxDivergencesPerStep,
        policyCitations: {
          rampScheduleDigest:
            options.unchecked === true ? "" : rampScheduleDigestOf(row.rampSchedule),
          failureBudgetStated: options.unchecked !== true,
          toleranceStated: options.unchecked !== true,
        },
        policyChecks: {
          rampChecked: options.unchecked !== true,
          budgetChecked: options.unchecked !== true,
          toleranceChecked: options.unchecked !== true,
        },
      };
    });

    const sliceComparisons =
      refusal === null
        ? executedSteps.flatMap((step) => {
            const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
            if (honest === undefined) {
              return [];
            }
            return honest.outcomes.map((outcome) => {
              const tcase = row.trafficPopulation.find(
                (candidate) => candidate.caseId === outcome.caseId,
              );
              return {
                stepIndex: step.stepIndex,
                caseId: outcome.caseId,
                incumbentDigest: tcase?.incumbentDigest ?? "",
                replacementDigest: outcome.digest,
                claimedAgrees: outcome.claimedAgrees,
              };
            });
          })
        : [];

    const rollbackEvents =
      refusal !== null || row.expected.breachingStepIndex === null
        ? []
        : [
            {
              stepIndex: row.expected.breachingStepIndex ?? 0,
              residualReplacementCaseIds:
                options.partialrollback === true
                  ? [
                      ramp.steps.find(
                        (entry) => entry.stepIndex === row.expected.breachingStepIndex,
                      )?.sliceCaseIds[0] ?? "",
                    ]
                  : [],
            },
          ];

    const servedOutcomes =
      refusal === null
        ? executedSteps.flatMap((step) => {
            const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
            const sliceCaseIds = honest?.sliceCaseIds ?? [];
            const serves = row.trafficPopulation.map((tcase) => {
              const inSlice = sliceCaseIds.includes(tcase.caseId);
              const replacementDigest =
                honest?.outcomes.find((outcome) => outcome.caseId === tcase.caseId)?.digest ?? "";
              if (inSlice) {
                return {
                  stepIndex: step.stepIndex,
                  caseId: tcase.caseId,
                  servedSource: "replacement",
                  servedDigest: replacementDigest,
                };
              }
              if (options.overslice === true) {
                const firstNonSlice = row.trafficPopulation.find(
                  (candidate) => !sliceCaseIds.includes(candidate.caseId),
                );
                if (firstNonSlice !== undefined && firstNonSlice.caseId === tcase.caseId) {
                  return {
                    stepIndex: step.stepIndex,
                    caseId: tcase.caseId,
                    servedSource: "replacement",
                    servedDigest: longitudinalDigestOf(["over-slice-serve", tcase.caseId]),
                  };
                }
              }
              return {
                stepIndex: step.stepIndex,
                caseId: tcase.caseId,
                servedSource: "incumbent",
                servedDigest: tcase.incumbentDigest,
              };
            });
            if (options.foreigntenant === true) {
              serves.push({
                stepIndex: step.stepIndex,
                caseId: "foreign-tenant-case",
                servedSource: "replacement",
                servedDigest: longitudinalDigestOf(["foreign-tenant-serve", step.stepIndex]),
              });
            }
            return serves;
          })
        : [];

    const exercised =
      refusal !== null
        ? []
        : options.escaping === true
          ? [...row.declaredCapabilities, "network-access"]
          : [...row.declaredCapabilities];

    const canaryCost =
      refusal === null && options.unmeasured !== true
        ? executedCanaryCostOf(ramp, executedSteps)
        : null;
    const servedIncumbentMicroUsd =
      refusal === null ? 3 * row.trafficPopulation.length * executedSteps.length + 1 : 0;
    const servedCostMicroUsd =
      options.billed === true && canaryCost !== null
        ? servedIncumbentMicroUsd + canaryCost.microUsd
        : servedIncumbentMicroUsd;

    const verdictKind: CanaryVerdictKind =
      options.escaping === true
        ? "containment-violation"
        : refusal !== null
          ? "honest-refusal"
          : row.expected.breachingStepIndex !== null
            ? "honest-rollback"
            : "clean-promotion";

    return {
      row,
      refusal,
      decisions,
      sliceComparisons,
      rollbackEvents,
      servedOutcomes,
      exercised,
      canaryCost,
      servedIncumbentMicroUsd,
      servedCostMicroUsd,
      verdictKind,
    };
  };

  /** The row's honest canary trajectory events under the surfaced run. */
  const eventsFor = (row: FakeCanaryExecutionRow): unknown[] => {
    const corpusRow = rowById(row.taskRowId);
    if (corpusRow === null) {
      return [];
    }
    const ramp = pinnedCanaryRampOf(corpusRow);
    const executedSteps =
      corpusRow.expected.refusalReason !== null
        ? []
        : corpusRow.expected.breachingStepIndex === null
          ? corpusRow.rampSchedule
          : corpusRow.rampSchedule.filter(
              (step) => step.stepIndex <= (corpusRow.expected.breachingStepIndex ?? 0),
            );
    const steps = canaryTrajectoryStepsOf({
      proposalId: corpusRow.sourceProposalId,
      populationDigest: differentialPopulationDigestOf(corpusRow.trafficPopulation),
      steps: executedSteps.map((step) => {
        const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
        return {
          stepIndex: step.stepIndex,
          sliceDigest: canarySliceDigestOf({
            proposalId: corpusRow.sourceProposalId,
            stepIndex: step.stepIndex,
            sliceCaseIds: honest?.sliceCaseIds ?? [],
          }),
          decisionKind:
            step.stepIndex === corpusRow.expected.breachingStepIndex
              ? ("breach-rollback" as const)
              : ("advance" as const),
          divergenceCount:
            ramp.divergencesByStep.find((entry) => entry.stepIndex === step.stepIndex)
              ?.divergenceCaseIds.length ?? 0,
          rollbackExercised: step.stepIndex === corpusRow.expected.breachingStepIndex,
        };
      }),
      canaryCostDigest:
        corpusRow.expected.refusalReason === null
          ? canaryCostDigestOf({
              proposalId: corpusRow.sourceProposalId,
              marker: CANARY_COST_MARKER,
              microUsd: executedCanaryCostOf(ramp, executedSteps).microUsd,
              latencyMs: executedCanaryCostOf(ramp, executedSteps).latencyMs,
            })
          : null,
      landedStages:
        corpusRow.expected.finalStage === "promoted"
          ? (["canaried", "promoted"] as const)
          : corpusRow.expected.finalStage === "canaried"
            ? (["canaried"] as const)
            : [],
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
      // platform driving the canary run) — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "canary-promotion.governed-ramp.v1", input: "canary" },
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
          strategyClass: "canary-promotion",
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
                breachingStepIndex: surfaced.row.expected.breachingStepIndex,
                finalStage:
                  options.skipped === true ? "promoted" : surfaced.row.expected.finalStage,
              },
        lifecycleLanding:
          surfaced === null || surfaced.row.expected.finalStage === null
            ? null
            : {
                proposalId: surfaced.row.sourceProposalId,
                finalStage:
                  options.skipped === true ? "promoted" : surfaced.row.expected.finalStage,
              },
        decisions: surfaced?.decisions ?? [],
        sliceComparisons: surfaced?.sliceComparisons ?? [],
        rollbackEvents: surfaced?.rollbackEvents ?? [],
        rollbackPlanRecorded: options.planmissing !== true,
        servedOutcomes: surfaced?.servedOutcomes ?? [],
        canaryCost: surfaced?.canaryCost ?? null,
        servedAccounting: {
          incumbentMicroUsd: surfaced?.servedIncumbentMicroUsd ?? 0,
          billedMicroUsd: surfaced?.servedCostMicroUsd ?? 0,
        },
        canaryLedgerBookedMicroUsd: surfaced?.canaryCost?.microUsd ?? null,
        canaryMarkerPresent: surfaced?.canaryCost == null ? null : options.unmarked !== true,
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
 * lifecycle ledger (the recorded VAL-033 + VAL-034 walk), the
 * append-only canary ledger, the deterministic incumbent executor,
 * the recorded traffic source, the slice serving path and the honest
 * canary runtime — the world every offline row passes over (the
 * adversarial variants are the discrimination worlds).
 */
export function createHonestCanaryStack(): {
  readonly registry: FakeCandidateRegistry;
  readonly lifecycle: FakeLifecycleLedger;
  readonly canaryLedger: FakeCanaryLedger;
  readonly incumbentExecutor: FakeIncumbentExecutor;
  readonly trafficSource: FakeTrafficSource;
  readonly servingPath: FakeCanaryServingPath;
  readonly canaryRuntime: FakeCanaryRuntime;
  readonly clock: TickClock;
} {
  const clock = createTickClock();
  const registry = createCandidateRegistry();
  const servingPath = createCanaryServingPath();
  return {
    registry,
    lifecycle: createLifecycleLedger(),
    canaryLedger: createCanaryLedger(),
    incumbentExecutor: createIncumbentExecutor(),
    trafficSource: createTrafficSource(),
    servingPath,
    canaryRuntime: createCanaryRuntime(),
    clock,
  };
}

/**
 * The row's recorded rollback plan (the reversibility contract's
 * record — the digest the driver appends its rollback events under).
 */
export function rollbackPlanOf(proposalId: string): { readonly planDigest: string } {
  return {
    planDigest: rollbackPlanDigestOf({
      proposalId,
      revertsServingTo: "incumbent",
      scopeFraction: 1,
    }),
  };
}

/**
 * The deterministic slice membership re-export (the consistency
 * tests' basis): the slice is a pure function of the population and
 * the pinned fraction.
 */
export { sliceCaseIdsOf };
