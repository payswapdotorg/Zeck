/**
 * The platform-side repeated workload-replay driver (VAL-031).
 *
 * The mechanical engine of the trajectory-analysis slice: it replays the
 * FROZEN baseline corpus (VAL-030's pinned manifests — the registry is
 * the READ-ONLY input; replays never rewrite the manifests) N times per
 * row with learning still INERT, captures EVERY replay's full
 * trajectory through the recorder, and analyzes the trajectory
 * population for the pre-learning facts every later learning claim must
 * account for.
 *
 *   * the replay-population vocabulary — the replay count N, the
 *     population-probe kinds (the discriminations designed here and
 *     pinned now: `duplicate-replay`, `dropped-replay`,
 *     `drifted-trajectory`, `partial-population`,
 *     `fabricated-determinism`) and the stability kinds (which rows are
 *     deterministic across identical replays and which legitimately
 *     vary);
 *   * the PURE derivations that make the population analysis
 *     trustworthy — `derivePopulationCompleteness` (exactly N replays
 *     per row: no duplicates, no gaps — a replay that shoulders INTO an
 *     existing trajectory identity FAILS, a dropped replay FAILS),
 *     `deriveTrajectoryClassMembership` (every replay's digest is a
 *     member of the row's VAL-030 pinned equivalence class — an
 *     out-of-class trajectory FAILS), `deriveStabilityHonesty` (the
 *     analysis is honest about variance: deterministic rows show
 *     identical digests across replays; varying rows are REPORTED
 *     varying with their observed distribution — a smoothed variance or
 *     a fabricated determinism FAILs; a stability claim from a partial
 *     replay set FAILs), `deriveReplayAccountingHonesty` (the VAL-006
 *     discipline over the replay population: per-replay usage measured
 *     or honestly none, per-replay latency always measured, population
 *     totals summed from measured values — never estimated) and
 *     `deriveLatencyDistribution` (min/max/median over the MEASURED
 *     per-replay latencies — never estimated);
 *   * the digest discipline (FNV-1a over canonical content, inherited
 *     from the VAL-030 slice — payload digests only, never payload
 *     bytes in evidence);
 *   * the replay-driver seam: one replay population drives its N
 *     replays through the platform path (the workload admission — the
 *     guard precedes ANY dispatch or effect work; the gated dispatch
 *     rounds with learning explicitly INERT; the effect steps; the
 *     verification step; the trajectory capture through the recorder)
 *     and records ONE immutable trajectory identity per replay per the
 *     VAL-007/030 ledger discipline — a shoulder-in, a dropped
 *     observation or a drifted identity content each FAIL
 *     mechanically.
 *
 * Honesty invariants:
 *   * exactly N replays per row — a duplicated replay identity, a
 *     missing ordinal or a gap in the identity set FAILs the
 *     population;
 *   * every replay's trajectory digest is a member of the row's pinned
 *     VAL-030 equivalence class — a drifting replay is mechanically
 *     out of class;
 *   * the stability report is derived from the OBSERVED population and
 *     judged against the corpus pin — variance is REPORTED, never
 *     smoothed into a fake determinism claim, and determinism is never
 *     fabricated over an observed variance;
 *   * latency is always measured; usage is measured on the live rail
 *     and honestly none-reported offline; population totals are sums of
 *     MEASURED per-replay values;
 *   * the frozen baseline registry is read-only input — a replay
 *     population whose pinned manifest is not committed FAILs the pin
 *     leg (replays never rewrite the manifests);
 *   * evidence carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch (env-gated, BYOK, measured — never
 * fabricated).
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type {
  BaselineAppArtifact,
  BaselineManifestEntry,
  BaselineRegistryEntry,
  BaselineWorkloadRevision,
  ControlDispatch,
  ControlLearningPort,
  ControlRoundMode,
  RecordedTrajectory,
  TrajectoryStepRecord,
} from "./longitudinal-baseline";
import {
  controlTrajectoryStepsOf,
  deriveTerminalCriteriaAgreement,
  deriveWorkloadAdmission,
  identityContentDigestOf,
  isRetryableDispatchCategory,
  longitudinalDigestOf,
  trajectoryDigestOf,
} from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The replay-population vocabulary (the pre-learning facts)
// ---------------------------------------------------------------------------

/**
 * The replay population's learning mode: learning stays explicitly
 * INERT for every replay — the pre-learning trajectory population is
 * measured BEFORE any learning happens (the reference facts every
 * later learning claim must account for).
 */
export const REPLAY_LEARNING_MODE = "inert" as const;

/**
 * The longitudinal-experiment kind every replay registers as (the
 * VAL-007 experiment vocabulary — a workload-replay measurement).
 */
export const REPLAY_EXPERIMENT_KIND = "workload-replay";

/**
 * The population-probe kinds the corpus declares (the vocabulary the
 * later discrimination phases drive over the adversarial fixture
 * variants — designed here, pinned now):
 *
 *   * `duplicate-replay` — a replay shoulders INTO an existing
 *     trajectory identity (a duplicate ledger identity for one
 *     workload's replay population);
 *   * `dropped-replay` — a replay's immutable ledger observation is
 *     lost (the population has a gap);
 *   * `drifted-trajectory` — a replay's captured trajectory drifts out
 *     of the row's pinned equivalence class;
 *   * `partial-population` — a stability claim asserted from a partial
 *     replay set (fewer than N observations);
 *   * `fabricated-determinism` — an analysis that claims determinism
 *     over an observed variance (a smoothed variance / fake
 *     determinism).
 */
export const POPULATION_PROBE_KINDS = [
  "duplicate-replay",
  "dropped-replay",
  "drifted-trajectory",
  "partial-population",
  "fabricated-determinism",
] as const;

export type PopulationProbeKind = (typeof POPULATION_PROBE_KINDS)[number];

export function isPopulationProbeKind(value: string): value is PopulationProbeKind {
  return (POPULATION_PROBE_KINDS as readonly string[]).includes(value);
}

/**
 * The trajectory-stability kinds: which rows are deterministic across
 * identical replays (identical digests across the N replays) and which
 * legitimately vary (the observed distribution is REPORTED, never
 * smoothed).
 */
export const STABILITY_KINDS = ["deterministic", "varying"] as const;

export type StabilityKind = (typeof STABILITY_KINDS)[number];

export function isStabilityKind(value: string): value is StabilityKind {
  return (STABILITY_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The corpus-row contract (the replay-population oracle)
// ---------------------------------------------------------------------------

/** One digest-distribution entry: a trajectory digest and its replay count. */
export interface DigestDistributionEntry {
  readonly digest: string;
  readonly count: number;
}

/**
 * The pinned stability expectation (the corpus's population oracle):
 * the stability kind plus the exact digest distribution the analysis
 * derivation must reproduce. Deterministic rows pin one digest at
 * count N (identical digests across the N replays); varying rows pin
 * the legitimately-varying distribution (each declared digest at its
 * declared count).
 */
export interface ReplayStabilityPin {
  readonly kind: StabilityKind;
  readonly distribution: readonly DigestDistributionEntry[];
}

/**
 * The replay-population corpus row (the full oracle — AC1's per-row
 * contract): the pinned baseline manifest entry (from VAL-030's frozen
 * registry — read-only input, digests over the pinned artifacts, never
 * the artifacts copied), the replay count N, the pinned
 * trajectory-class membership and the expected population statistics.
 */
export interface WorkloadReplayCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-030 corpus row this population replays (the frozen baseline). */
  readonly baselineRowId: string;
  /** The pinned baseline manifest entry (VAL-030's registry input). */
  readonly manifest: BaselineManifestEntry;
  /** The frozen app artifact the manifest's app digest addresses. */
  readonly appArtifact: BaselineAppArtifact;
  /** The golden workload revision the manifest's workload digest addresses. */
  readonly workload: BaselineWorkloadRevision;
  /** The declared equivalent effect orderings (VAL-030's class basis). */
  readonly effectOrderings?: readonly (readonly number[])[];
  /**
   * The replay count N — the population size: exactly N replays, no
   * duplicates, no gaps.
   */
  readonly replayCount: number;
  /**
   * The world's per-replay effect-ordering schedule (the varying rows'
   * legitimate variance basis — replay k schedules
   * `replayOrderings[(k-1) % length]`). Absent on deterministic rows:
   * every replay schedules the declaration order.
   */
  readonly replayOrderings?: readonly (readonly number[])[];
  /** The expected terminal of EVERY replay in the population. */
  readonly expectedTerminal: "COMPLETED" | "FAILED";
  /**
   * The pinned trajectory-digest equivalence class (VAL-030's freeze):
   * every replay's digest must be a member — out-of-class FAILS.
   */
  readonly expectedTrajectoryClass: readonly string[];
  /** The pinned population statistics (the stability oracle). */
  readonly expectedStability: ReplayStabilityPin;
  /** Every replay's OWN dispatch demand (the inert-learning floor). */
  readonly expectedModelCallsPerReplay: number;
  /** The population-probe vocabulary (the phase-2 discrimination hooks). */
  readonly probe?: { readonly kind: PopulationProbeKind };
  /** Whether every replay's work demands a REAL model dispatch. */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    /** The population's honest terminal (every replay's terminal). */
    readonly terminal: "COMPLETED" | "FAILED";
    /** The row's total replays (the population size). */
    readonly replays: number;
    /** The row's total distinct durable executions (one per replay). */
    readonly appCreated: number;
    /** The row's total replayed submissions (an honest population: zero). */
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** Exactly ONE immutable ledger identity per replay: N. */
    readonly ledgerIdentities: number;
  };
}

// ---------------------------------------------------------------------------
// The replay identity derivations (the VAL-007/030 ledger discipline)
// ---------------------------------------------------------------------------

/**
 * The replay population's key basis: one replay of one pinned baseline
 * is ONE longitudinal experiment — the replay ordinal distinguishes
 * the N replays of one population.
 */
export function replayKeyOf(input: {
  readonly populationId: string;
  readonly manifest: BaselineManifestEntry;
  readonly replayOrdinal: number;
}): string {
  return [
    "replay",
    input.manifest.appId,
    input.manifest.workloadId,
    `r${input.manifest.workloadRevision}`,
    input.populationId,
    `replay-${input.replayOrdinal}`,
  ].join(":");
}

/**
 * The stable longitudinal-experiment identity for one replay (the
 * VAL-007 `exp-<kind>-<digest>` form, content-derived — never a minted
 * random id).
 */
export function replayIdentityIdOf(replayKey: string): string {
  return `exp-${REPLAY_EXPERIMENT_KIND}-${longitudinalDigestOf(replayKey)}`;
}

// ---------------------------------------------------------------------------
// The canonical digest distribution (the population statistics basis)
// ---------------------------------------------------------------------------

/**
 * The canonical digest distribution over the observed digests (PURE):
 * entries sorted by digest with positive counts — the population
 * statistic every comparison uses (claim ↔ observation ↔ pin).
 */
export function canonicalDigestDistributionOf(
  digests: readonly (string | null)[],
): DigestDistributionEntry[] {
  const counts = new Map<string, number>();
  for (const digest of digests) {
    if (digest === null) {
      continue;
    }
    counts.set(digest, (counts.get(digest) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([digest, count]) => ({ digest, count }))
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

/**
 * The honest stability report derived from the OBSERVED population
 * (PURE): the observed stability kind (distinct digests ≤ 1 →
 * deterministic; otherwise varying) with the observed digest
 * distribution. This is what an honest analysis reports — variance is
 * REPORTED, never smoothed.
 */
export function deriveStabilityReportOf(
  observedDigests: readonly (string | null)[],
): ReplayStabilityPin {
  const distribution = canonicalDigestDistributionOf(observedDigests);
  const kind: StabilityKind = distribution.length <= 1 ? "deterministic" : "varying";
  return { kind, distribution };
}

// ---------------------------------------------------------------------------
// Population completeness (exactly N replays — no duplicates, no gaps)
// ---------------------------------------------------------------------------

/** One replay's population entry (the derivation's input — digests only). */
export interface ReplayPopulationEntry {
  /** 1-based ordinal within the replay population. */
  readonly replayOrdinal: number;
  /** The replay's immutable ledger identity (null when dropped). */
  readonly identityId: string | null;
  /** True when the observation REPLAYED an existing identity (a shoulder-in). */
  readonly replayed: boolean;
}

/** The population-completeness verdict. */
export interface PopulationCompletenessVerdict {
  /** Exactly N replays, no duplicates, no gaps, distinct identities. */
  readonly complete: boolean;
  readonly observedCount: number;
  readonly expectedCount: number;
  /** Ordinals observed more than once (a duplicated replay). */
  readonly duplicateOrdinals: readonly number[];
  /** Ordinals 1..N never observed (a gap). */
  readonly missingOrdinals: readonly number[];
  /** Ordinals whose observation carried NO identity (a dropped replay). */
  readonly droppedOrdinals: readonly number[];
  /** Identity ids bound by more than one replay (a shoulder-in). */
  readonly duplicateIdentityIds: readonly string[];
  /** Ordinals whose observation replayed an existing identity. */
  readonly replayedOrdinals: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the population completeness (PURE): exactly N replays per row
 * — no duplicates, no gaps. A replay that shoulders INTO an existing
 * trajectory identity (a duplicate ledger identity for one workload's
 * replay population, or an observation that replayed an existing
 * identity) FAILS; a dropped replay (a null identity observation) or a
 * missing ordinal FAILS; a population larger than N FAILS just as a
 * partial one does.
 */
export function derivePopulationCompleteness(input: {
  readonly replayCount: number;
  readonly replays: readonly ReplayPopulationEntry[];
}): PopulationCompletenessVerdict {
  const expectedCount = input.replayCount;
  const observedCount = input.replays.length;

  const ordinalCounts = new Map<number, number>();
  const identityCounts = new Map<string, number>();
  const droppedOrdinals: number[] = [];
  const replayedOrdinals: number[] = [];
  for (const replay of input.replays) {
    ordinalCounts.set(replay.replayOrdinal, (ordinalCounts.get(replay.replayOrdinal) ?? 0) + 1);
    if (replay.identityId === null) {
      droppedOrdinals.push(replay.replayOrdinal);
    } else {
      identityCounts.set(replay.identityId, (identityCounts.get(replay.identityId) ?? 0) + 1);
    }
    if (replay.replayed) {
      replayedOrdinals.push(replay.replayOrdinal);
    }
  }
  const duplicateOrdinals = [...ordinalCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([ordinal]) => ordinal)
    .sort((left, right) => left - right);
  const duplicateIdentityIds = [...identityCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([identityId]) => identityId)
    .sort();
  const missingOrdinals: number[] = [];
  for (let ordinal = 1; ordinal <= expectedCount; ordinal += 1) {
    if (!ordinalCounts.has(ordinal)) {
      missingOrdinals.push(ordinal);
    }
  }

  const countExact =
    expectedCount >= 1 && observedCount === expectedCount && missingOrdinals.length === 0;
  const noDuplicates =
    duplicateOrdinals.length === 0 &&
    duplicateIdentityIds.length === 0 &&
    replayedOrdinals.length === 0;
  const noGaps = droppedOrdinals.length === 0;
  const complete = countExact && noDuplicates && noGaps;

  return {
    complete,
    observedCount,
    expectedCount,
    duplicateOrdinals,
    missingOrdinals,
    droppedOrdinals,
    duplicateIdentityIds,
    replayedOrdinals,
    criteria: [
      {
        criterionId: "population-exactly-n",
        strategy: "deterministic",
        status: countExact ? "PASS" : "FAIL",
        evidence: [
          `expectedReplays:${expectedCount}`,
          `observedReplays:${observedCount}`,
          `missingOrdinals:${missingOrdinals.length === 0 ? "none" : missingOrdinals.join(",")}`,
          countExact
            ? "exactly-N (the full replay population)"
            : "WRONG-COUNT (the population is partial or oversized)",
        ],
      },
      {
        criterionId: "population-no-duplicate-replays",
        strategy: "deterministic",
        status: noDuplicates ? "PASS" : "FAIL",
        evidence: [
          `duplicateOrdinals:${duplicateOrdinals.length === 0 ? "none" : duplicateOrdinals.join(",")}`,
          `replayedOrdinals:${replayedOrdinals.length === 0 ? "none" : replayedOrdinals.join(",")}`,
          `duplicateIdentityIds:${duplicateIdentityIds.length === 0 ? "none" : duplicateIdentityIds.join(",")}`,
          noDuplicates
            ? "no-duplicates (every replay is its own experiment)"
            : "DUPLICATED-REPLAY (a replay shouldered into an existing trajectory identity)",
        ],
      },
      {
        criterionId: "population-no-gaps",
        strategy: "deterministic",
        status: noGaps ? "PASS" : "FAIL",
        evidence: [
          `droppedOrdinals:${droppedOrdinals.length === 0 ? "none" : droppedOrdinals.join(",")}`,
          noGaps
            ? "no-gaps (every replay's immutable identity landed)"
            : "GAP (a replay's ledger observation was dropped)",
        ],
      },
      {
        criterionId: "population-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `expected:${expectedCount}`,
          `observed:${observedCount}`,
          `duplicates:${duplicateOrdinals.length + duplicateIdentityIds.length + replayedOrdinals.length}`,
          `gaps:${missingOrdinals.length + droppedOrdinals.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Trajectory-class membership (every replay in the pinned class)
// ---------------------------------------------------------------------------

/** One replay's membership observation. */
export interface ReplayMembershipEntry {
  readonly replayOrdinal: number;
  /** The replay's observed trajectory digest (null when never captured). */
  readonly digest: string | null;
}

/** The trajectory-class membership verdict. */
export interface TrajectoryClassMembershipVerdict {
  /** Every replay's digest is a member of the pinned class. */
  readonly allInClass: boolean;
  /** The per-replay membership view (digests only). */
  readonly members: readonly {
    readonly replayOrdinal: number;
    readonly digest: string | null;
    readonly inClass: boolean;
  }[];
  readonly classSize: number;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the trajectory-class membership (PURE): every replay's
 * observed digest must be a MEMBER of the row's pinned VAL-030
 * equivalence class — a drifting replay is mechanically out of class,
 * and a replay whose trajectory was never captured (a null digest)
 * fails its membership leg honestly.
 */
export function deriveTrajectoryClassMembership(input: {
  readonly expectedClass: readonly string[];
  readonly observed: readonly ReplayMembershipEntry[];
}): TrajectoryClassMembershipVerdict {
  const classSize = input.expectedClass.length;
  const members = input.observed.map((entry) => ({
    replayOrdinal: entry.replayOrdinal,
    digest: entry.digest,
    inClass: entry.digest !== null && input.expectedClass.includes(entry.digest),
  }));
  const outOfClass = members.filter((member) => !member.inClass);
  const allInClass = classSize > 0 && outOfClass.length === 0;
  const criteria: LabVerificationCriterion[] = [
    {
      criterionId: "trajectory-class-membership",
      strategy: "deterministic",
      status: allInClass ? "PASS" : "FAIL",
      evidence: [
        `replays:${members.length}`,
        `classSize:${classSize}`,
        `outOfClass:${outOfClass.length === 0 ? "none" : outOfClass.map((m) => m.replayOrdinal).join(",")}`,
        allInClass
          ? "every-replay-in-class (each replay reproduced the pinned baseline class)"
          : "OUT-OF-CLASS (a replay's trajectory drifted outside the recorded class)",
      ],
    },
  ];
  for (const member of outOfClass) {
    criteria.push({
      criterionId: `trajectory-class-membership-replay-${member.replayOrdinal}`,
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `replayOrdinal:${member.replayOrdinal}`,
        `observedDigest:${member.digest ?? "none"}`,
        `classSize:${classSize}`,
        member.digest === null
          ? "NOT-CAPTURED (the replay's trajectory was never captured)"
          : "DRIFTED (the replay's trajectory digest is outside the pinned class)",
      ],
    });
  }
  return { allInClass, members, classSize, criteria };
}

// ---------------------------------------------------------------------------
// Stability honesty (variance is REPORTED, never smoothed)
// ---------------------------------------------------------------------------

/** The stability-honesty verdict. */
export interface StabilityHonestyVerdict {
  /** The claim, the observation and the pin all agree honestly. */
  readonly honest: boolean;
  /** The stability kind the OBSERVED population shows. */
  readonly observedKind: StabilityKind;
  /** The observed digest distribution (REPORTED, never smoothed). */
  readonly observedDistribution: readonly DigestDistributionEntry[];
  /** The stability kind the analysis CLAIMED. */
  readonly claimedKind: StabilityKind;
  /** The stability kind the corpus PINNED. */
  readonly expectedKind: StabilityKind;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the stability honesty (PURE — the replay-population oracle's
 * variance discipline): the analysis's CLAIMED stability report is
 * judged against the OBSERVED population and the corpus PIN. A
 * deterministic claim over an observed variance FAILS (a fabricated
 * determinism — a smoothed variance); a varying claim over a
 * deterministic population FAILs (a misreport); a claim that
 * contradicts the pin FAILs; a stability claim asserted from a partial
 * replay set (fewer than N observations, or a null digest among them)
 * FAILs — the full population's evidence is required; and a varying
 * claim must carry the observed distribution exactly (the observed
 * distribution, never a smoothed one).
 */
export function deriveStabilityHonesty(input: {
  /** The corpus's pinned stability expectation. */
  readonly expected: ReplayStabilityPin;
  /** The stability claim under test (the reported analysis). */
  readonly claimed: ReplayStabilityPin;
  /** The per-replay observed digests, in ordinal order (null = missing). */
  readonly observedDigests: readonly (string | null)[];
  readonly expectedReplayCount: number;
}): StabilityHonestyVerdict {
  const observedDistribution = canonicalDigestDistributionOf(input.observedDigests);
  const observedKind: StabilityKind =
    observedDistribution.length <= 1 ? "deterministic" : "varying";
  const missingObservations = input.observedDigests.filter((digest) => digest === null).length;
  const populationComplete =
    input.expectedReplayCount >= 1 &&
    input.observedDigests.length === input.expectedReplayCount &&
    missingObservations === 0;

  // 1. The full population's evidence (never a partial replay set).
  const claimMatchesObservation = input.claimed.kind === observedKind;
  const claimMatchesPin = input.claimed.kind === input.expected.kind;
  const distributionKeyOf = (entries: readonly DigestDistributionEntry[]): string =>
    entries.map((entry) => `${entry.digest}x${entry.count}`).join("|");
  const pinDistributionOf = (pin: ReplayStabilityPin): readonly DigestDistributionEntry[] =>
    canonicalDigestDistributionOf(
      pin.distribution.flatMap((entry) => Array.from({ length: entry.count }, () => entry.digest)),
    );
  const observedKey = distributionKeyOf(observedDistribution);
  const claimedKey = distributionKeyOf(pinDistributionOf(input.claimed));
  const expectedKey = distributionKeyOf(pinDistributionOf(input.expected));
  const observedMatchesClaimed = observedKey === claimedKey;
  const observedMatchesPin = observedKey === expectedKey;

  const honest =
    populationComplete &&
    claimMatchesObservation &&
    claimMatchesPin &&
    observedMatchesClaimed &&
    observedMatchesPin;

  const fabrication =
    input.claimed.kind === "deterministic" && observedKind === "varying"
      ? "FABRICATED-DETERMINISM (the claim smoothed an observed variance)"
      : input.claimed.kind === "varying" && observedKind === "deterministic"
        ? "MISREPORTED-VARYING (the observed population is deterministic)"
        : null;

  return {
    honest,
    observedKind,
    observedDistribution,
    claimedKind: input.claimed.kind,
    expectedKind: input.expected.kind,
    criteria: [
      {
        criterionId: "stability-full-population",
        strategy: "deterministic",
        status: populationComplete ? "PASS" : "FAIL",
        evidence: [
          `expectedReplays:${input.expectedReplayCount}`,
          `observedReplays:${input.observedDigests.length}`,
          `missingObservations:${missingObservations}`,
          populationComplete
            ? "full-population (the claim rests on every replay's evidence)"
            : "PARTIAL-POPULATION (a stability claim without the full population's evidence)",
        ],
      },
      {
        criterionId: "stability-claim-matches-observation",
        strategy: "deterministic",
        status: claimMatchesObservation ? "PASS" : "FAIL",
        evidence: [
          `claimedKind:${input.claimed.kind}`,
          `observedKind:${observedKind}`,
          `observedDistribution:${observedDistribution.map((e) => `${e.digest}x${e.count}`).join("|")}`,
          claimMatchesObservation
            ? "the-claim-reports-the-observed-population"
            : (fabrication ?? "CLAIM-DISAGREES-WITH-THE-OBSERVATION"),
        ],
      },
      {
        criterionId: "stability-claim-matches-pin",
        strategy: "deterministic",
        status: claimMatchesPin && observedMatchesPin ? "PASS" : "FAIL",
        evidence: [
          `claimedKind:${input.claimed.kind}`,
          `pinnedKind:${input.expected.kind}`,
          `pinnedDistribution:${expectedKey}`,
          claimMatchesPin && observedMatchesPin
            ? "the-claim-reproduces-the-pinned-population-statistics"
            : "DISTRIBUTION-MISMATCH (the observed population statistics differ from the pin)",
        ],
      },
      {
        criterionId: "stability-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `populationComplete:${String(populationComplete)}`,
          `claimMatchesObservation:${String(claimMatchesObservation)}`,
          `claimMatchesPin:${String(claimMatchesPin && observedMatchesPin)}`,
          `observedMatchesClaimed:${String(observedMatchesClaimed)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Latency distribution (measured, never estimated)
// ---------------------------------------------------------------------------

/** The latency-distribution verdict (min/max/median over measured values). */
export interface LatencyDistributionVerdict {
  /** Every per-replay latency was measured (never estimated). */
  readonly measured: boolean;
  readonly count: number;
  readonly minMs: number | null;
  readonly maxMs: number | null;
  readonly medianMs: number | null;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the latency distribution (PURE): the min/max/median over the
 * MEASURED per-replay latencies. A null or negative entry FAILs (latency
 * is never estimated); a partial latency population (fewer than N
 * entries) FAILs — the distribution is a population statistic.
 */
export function deriveLatencyDistribution(input: {
  readonly perReplayLatencyMs: readonly (number | null)[];
  readonly expectedReplayCount: number;
}): LatencyDistributionVerdict {
  const values = input.perReplayLatencyMs.filter(
    (latency): latency is number =>
      typeof latency === "number" && Number.isFinite(latency) && latency >= 0,
  );
  const allMeasured = values.length === input.perReplayLatencyMs.length;
  const countComplete =
    values.length === input.expectedReplayCount && input.expectedReplayCount >= 1;
  const sorted = [...values].sort((left, right) => left - right);
  const minMs = sorted[0] ?? null;
  const maxMs = sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null);
  const medianMs =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? (sorted[(sorted.length - 1) / 2] ?? 0)
        : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
  const measured = allMeasured && countComplete;
  return {
    measured,
    count: values.length,
    minMs,
    maxMs,
    medianMs,
    criteria: [
      {
        criterionId: "latency-measured",
        strategy: "deterministic",
        status: allMeasured ? "PASS" : "FAIL",
        evidence: [
          `entries:${input.perReplayLatencyMs.length}`,
          `measuredEntries:${values.length}`,
          allMeasured
            ? "every-latency-measured (never estimated)"
            : "NOT-MEASURED (a null or invalid latency entry — latency is never estimated)",
        ],
      },
      {
        criterionId: "latency-population-complete",
        strategy: "deterministic",
        status: countComplete ? "PASS" : "FAIL",
        evidence: [
          `expectedReplays:${input.expectedReplayCount}`,
          `measuredEntries:${values.length}`,
          countComplete
            ? "full-latency-population"
            : "PARTIAL-LATENCY-POPULATION (the latency distribution is a population statistic)",
        ],
      },
      {
        criterionId: "latency-distribution",
        strategy: "deterministic",
        status: measured ? "PASS" : "FAIL",
        evidence: [
          `count:${values.length}`,
          `minMs:${minMs ?? "none"}`,
          `maxMs:${maxMs ?? "none"}`,
          `medianMs:${medianMs ?? "none"}`,
          measured ? "measured-min-max-median" : "distribution-untrustworthy",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Accounting honesty over the replay population (VAL-006 discipline)
// ---------------------------------------------------------------------------

/** The population's measured accounting totals (sums of measured values). */
export interface ReplayPopulationTotals {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number | null;
  readonly totalLatencyMs: number;
}

/** The replay accounting-honesty verdict. */
export interface ReplayAccountingHonestyVerdict {
  readonly honest: boolean;
  /** The measured population totals (null when dishonest/unmeasured). */
  readonly totals: ReplayPopulationTotals | null;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the replay accounting honesty (PURE — the VAL-006 discipline
 * over the replay population): per-replay usage is MEASURED on the
 * live rail (a live row without measured usage per replay FAILs) and
 * NONE-REPORTED honestly offline (a fabricated usage on an offline
 * replay FAILs — the offline replays dispatch no model); per-replay
 * latency is ALWAYS measured (never estimated); and the population
 * totals are SUMS of the measured per-replay values — never estimates.
 * A partial accounting population (fewer than N entries) FAILs.
 */
export function deriveReplayAccountingHonesty(input: {
  readonly needsDispatch: boolean;
  readonly perReplayUsage: readonly (LabUsage | null)[];
  readonly perReplayLatencyMs: readonly (number | null)[];
  readonly expectedReplayCount: number;
}): ReplayAccountingHonestyVerdict {
  const countsComplete =
    input.perReplayUsage.length === input.expectedReplayCount &&
    input.perReplayLatencyMs.length === input.expectedReplayCount &&
    input.expectedReplayCount >= 1;
  const usageHonest = input.needsDispatch
    ? input.perReplayUsage.every(
        (usage) => usage !== null && usage.inputTokens >= 0 && usage.outputTokens >= 0,
      )
    : input.perReplayUsage.every((usage) => usage === null);
  const latencies = input.perReplayLatencyMs.filter(
    (latency): latency is number =>
      typeof latency === "number" && Number.isFinite(latency) && latency >= 0,
  );
  const latencyMeasured = latencies.length === input.perReplayLatencyMs.length;
  const honest = countsComplete && usageHonest && latencyMeasured;

  const totalInputTokens = input.perReplayUsage.reduce(
    (sum, usage) => sum + (usage?.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = input.perReplayUsage.reduce(
    (sum, usage) => sum + (usage?.outputTokens ?? 0),
    0,
  );
  const costEntries = input.perReplayUsage.filter(
    (usage): usage is LabUsage => usage?.costUsd !== undefined,
  );
  const totalCostUsd =
    costEntries.length === input.expectedReplayCount && input.needsDispatch
      ? costEntries.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0)
      : null;
  const totalLatencyMs = latencies.reduce((sum, latency) => sum + latency, 0);
  const totals: ReplayPopulationTotals | null = honest
    ? { totalInputTokens, totalOutputTokens, totalCostUsd, totalLatencyMs }
    : null;

  return {
    honest,
    totals,
    criteria: [
      {
        criterionId: "replay-accounting-population",
        strategy: "deterministic",
        status: countsComplete ? "PASS" : "FAIL",
        evidence: [
          `expectedReplays:${input.expectedReplayCount}`,
          `usageEntries:${input.perReplayUsage.length}`,
          `latencyEntries:${input.perReplayLatencyMs.length}`,
          countsComplete
            ? "per-replay-accounting-complete"
            : "PARTIAL-ACCOUNTING (the totals are population statistics — every replay's entry is required)",
        ],
      },
      {
        criterionId: "replay-usage-honest",
        strategy: "deterministic",
        status: usageHonest ? "PASS" : "FAIL",
        evidence: [
          input.needsDispatch
            ? `usage:measured-per-replay (${input.perReplayUsage.filter((usage) => usage !== null).length}/${input.expectedReplayCount})`
            : `usage:${input.perReplayUsage.every((usage) => usage === null) ? "none-reported (offline — honest)" : "FABRICATED (an offline replay dispatches no model)"}`,
        ],
      },
      {
        criterionId: "replay-latency-measured",
        strategy: "deterministic",
        status: latencyMeasured ? "PASS" : "FAIL",
        evidence: [
          `entries:${input.perReplayLatencyMs.length}`,
          `measuredEntries:${latencies.length}`,
          latencyMeasured ? "every-latency-measured" : "NOT-MEASURED (latency is never estimated)",
        ],
      },
      {
        criterionId: "replay-population-totals",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `totalInputTokens:${totalInputTokens}`,
          `totalOutputTokens:${totalOutputTokens}`,
          `totalCostUsd:${totalCostUsd ?? "none"}`,
          `totalLatencyMs:${totalLatencyMs}`,
          honest
            ? "totals-summed-from-measured-per-replay-values"
            : "totals-withheld (dishonest accounting)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The lifecycle ports (bound to the REAL platform path at the crown)
// ---------------------------------------------------------------------------

/** The replay ledger's own facts (the derivation's input — digests only). */
export interface ReplayLedgerFacts {
  readonly identities: readonly {
    readonly identityId: string;
    readonly replayKey: string;
    readonly contentDigest: string;
  }[];
}

/** One replay identity observation the driver made through the ledger. */
export interface ReplayObservation {
  readonly contentDigest: string;
  readonly identityId: string | null;
  /** True when the ledger replayed an existing identity (a shoulder-in). */
  readonly replayed: boolean;
  /** True when the ledger honestly REFUSED (immutable identity content). */
  readonly refused: boolean;
  /** True when the ledger LOST the observation (the dropped-replay shape). */
  readonly dropped: boolean;
}

/**
 * The replay ledger port (the VAL-007/030 ledger discipline at the
 * replay boundary): ONE immutable trajectory identity per replay. The
 * first observation RECORDS the identity; a same-content
 * re-observation REPLAYS it (never a second identity); a
 * different-content re-observation is REFUSED (the identity's content
 * is immutable). The LEAKY variant lets a replay shoulder into an
 * existing identity (the duplicate-replay catch) and the DROPPED
 * variant loses an observation (the dropped-replay catch).
 */
export interface ReplayLedgerPort {
  observeReplay(input: {
    readonly replayKey: string;
    readonly contentDigest: string;
  }): Promise<ReplayObservation>;
  /** The ledger's own facts (the derivation's input). */
  facts(): ReplayLedgerFacts;
}

/**
 * The replay recorder port: the trajectory capture with deterministic
 * digests, ONE capture per replay. The recorder IS the world's
 * scheduling seam: a replay population over a row whose world
 * schedules different (equivalent) effect orderings per replay
 * captures legitimately-varying trajectories — the variance basis the
 * stability honesty REPORTS. The DRIFT variant mutates a replay's
 * captured steps post-capture (the drifted-trajectory catch).
 */
export interface ReplayRecorderPort {
  /** Begin a fresh capture for one replay of one population. */
  beginReplayCapture(executionId: string, replayOrdinal: number): void;
  /** Capture one trajectory step (digests only). */
  capture(executionId: string, replayOrdinal: number, step: TrajectoryStepRecord): void;
  /** The replay's captured trajectory (null when nothing was captured). */
  replayCapture(executionId: string, replayOrdinal: number): RecordedTrajectory | null;
}

/** The replay learning port — learning stays explicitly INERT (VAL-030's gate). */
export type ReplayLearningPort = ControlLearningPort;

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** One replay's outcome within the population. */
export interface ReplayedRunOutcome {
  readonly replayOrdinal: number;
  readonly outcome: "COMPLETED" | "FAILED";
  /** The replay's observed trajectory digest (the recorder's own read). */
  readonly trajectoryDigest: string | null;
  /** The replay's immutable ledger identity (null when dropped). */
  readonly identityId: string | null;
  /** True when the observation replayed an existing identity (a shoulder-in). */
  readonly replayed: boolean;
  /** The replay's OWN model dispatches (fresh or hinted rounds). */
  readonly modelCalls: number;
  /** The replay's measured usage (the live row; null offline). */
  readonly usage: LabUsage | null;
  /** The replay's measured latency (ms). */
  readonly latencyMs: number;
  /** The honest failure cause (null on healthy replays). */
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/** The full replay-population result (the honest analysis contract). */
export interface WorkloadReplayResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly population: PopulationCompletenessVerdict;
  readonly membership: TrajectoryClassMembershipVerdict;
  readonly stability: StabilityHonestyVerdict;
  readonly accounting: ReplayAccountingHonestyVerdict;
  readonly latency: LatencyDistributionVerdict;
  /** The per-replay outcomes, in ordinal order. */
  readonly replays: readonly ReplayedRunOutcome[];
  /** The population's total model dispatches (N replays × own rounds). */
  readonly observedModelCalls: number;
  /** The population's measured usage totals (the live row; null offline). */
  readonly usage: LabUsage | null;
  /** The population's total measured latency (ms). */
  readonly totalLatencyMs: number;
  /** The honest failure cause (null on healthy populations). */
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The replay chain (one replay's machinery)
// ---------------------------------------------------------------------------

interface ReplayChainOptions {
  readonly executionId: string;
  readonly replayOrdinal: number;
  readonly row: WorkloadReplayCorpusRow;
  readonly recorder: ReplayRecorderPort;
  readonly learning: ReplayLearningPort;
  readonly dispatch?: ControlDispatch;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}

/** One driven replay chain's outcome. */
interface ReplayChainOutcome {
  readonly outcome: "COMPLETED" | "FAILED";
  readonly modelCalls: number;
  readonly usage: LabUsage | null;
  readonly rounds: readonly { readonly mode: ControlRoundMode }[];
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * Drive ONE replay's machinery (the VAL-030 control-chain semantics,
 * replayed): the workload admission (the guard precedes ANY dispatch
 * or effect work — a rejected workload records EXACTLY the
 * guard-rejection trajectory, so a guard-row population honestly
 * replays the FAILED shape N times), the gated dispatch rounds (each
 * round passes the competence-system gate the replay contract demands
 * be inert; a REUSED round dispatches nothing and is mechanically
 * visible), the effect steps in declaration order (the recorder's
 * world-scheduling seam owns the equivalent ordering — the varying
 * rows' legitimate variance basis), the verification step (UNLESS the
 * competence system shortcuts it — the honest catch), and the
 * trajectory capture through the recorder.
 */
async function driveReplayChain(options: ReplayChainOptions): Promise<ReplayChainOutcome> {
  const { row, recorder } = options;
  const steps: TrajectoryStepRecord[] = [];
  const rounds: { mode: ControlRoundMode }[] = [];
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;

  /** Capture one step through the recorder (ordinal = the capture order). */
  const capture = (step: Omit<TrajectoryStepRecord, "ordinal">): void => {
    const record: TrajectoryStepRecord = { ordinal: steps.length + 1, ...step };
    steps.push(record);
    recorder.capture(options.executionId, options.replayOrdinal, record);
  };

  // ---- the workload admission (the guard precedes any work) ----
  const admission = deriveWorkloadAdmission(row.workload);
  if (!admission.allowed) {
    capture({
      kind: "verification",
      detail: "guard-rejected",
      digest: longitudinalDigestOf([
        "guard-rejected",
        admission.demandedMicro,
        row.workload.quotaMicro,
      ]),
    });
    return {
      outcome: "FAILED",
      modelCalls: 0,
      usage: null,
      rounds: [],
      failure: {
        category: "precondition-rejected",
        message: admission.reason ?? "the budget guard rejected the workload",
      },
    };
  }

  // ---- the gated dispatch rounds (the replay's own model work) ----
  for (let round = 1; round <= row.workload.dispatchRounds; round += 1) {
    const gate = await options.learning.gateRound({ round });
    rounds.push({ mode: gate.mode });
    if (gate.mode === "reused") {
      // A REUSED round dispatched NOTHING — no step, no model call (the
      // contamination the inert contract catches).
      continue;
    }
    if (row.needsDispatch && options.dispatch !== undefined) {
      let roundFailure: { category: string; message: string } | null = null;
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ round, attempt });
        if (outcome.kind === "success") {
          if (outcome.usage !== undefined) {
            usage = {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              ...(outcome.usage.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
            };
          }
          break;
        }
        const retryable = isRetryableDispatchCategory(outcome.category ?? "");
        if (!retryable || attempt > options.retry.maxExtraAttempts) {
          roundFailure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await options.retry.sleep(options.retry.backoffMs);
      }
      if (roundFailure !== null) {
        failure = roundFailure;
        break;
      }
    }
    capture({
      kind: "dispatch",
      detail: `round-${round}`,
      digest: longitudinalDigestOf(["dispatch", round, gate.mode]),
    });
  }

  // ---- the effect steps (declaration order — the world schedules) ----
  if (failure === null) {
    for (const effect of row.workload.effects) {
      capture({
        kind: "effect",
        detail: effect.effect,
        digest: longitudinalDigestOf([effect.effect, effect.key, effect.amountMicro]),
      });
    }
  }

  // ---- the verification step (UNLESS the competence shortcut skips it) ----
  if (failure === null && !options.learning.verificationShortcut()) {
    capture({
      kind: "verification",
      detail: "criteria-recorded",
      digest: longitudinalDigestOf([
        "criteria-recorded",
        ...row.workload.effects.map((effect) => effect.effect).sort(),
      ]),
    });
  }

  return {
    outcome: failure === null ? "COMPLETED" : "FAILED",
    modelCalls: rounds.filter((round) => round.mode !== "reused").length,
    usage,
    rounds,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The replay-population driver
// ---------------------------------------------------------------------------

/**
 * Drive one replay-population corpus row through the platform path:
 * N replays (each with learning explicitly INERT) — every replay
 * drives the admission → the gated rounds → the effects → the
 * verification chain, captures its trajectory through the recorder,
 * and records ONE immutable ledger identity (the VAL-007/030
 * discipline — one replay, one identity). After the population, the
 * analysis derivations run mechanically: population completeness,
 * trajectory-class membership, stability honesty (the honest report
 * derived from the OBSERVED population, judged against the pin),
 * accounting honesty and the latency distribution. The honest terminal
 * is FAILED when any replay failed, any criterion failed or any
 * failure was observed — never a partial-success shortcut.
 */
export async function driveWorkloadReplay(options: {
  readonly row: WorkloadReplayCorpusRow;
  /** The replay population's identity basis (one population, N replays). */
  readonly populationId: string;
  /** The frozen-baseline registry (VAL-030's read-only input). */
  readonly registry: {
    entryFor(pin: {
      readonly appId: string;
      readonly workloadId: string;
      readonly workloadRevision: number;
    }): BaselineRegistryEntry | null;
  };
  readonly ledger: ReplayLedgerPort;
  readonly recorder: ReplayRecorderPort;
  readonly learning: ReplayLearningPort;
  /** The dispatch seam (the live row only). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<WorkloadReplayResult> {
  const { row } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL model round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const populationStartedAt = options.now().getTime();
  const replays: ReplayedRunOutcome[] = [];
  const registryEntry = options.registry.entryFor({
    appId: row.manifest.appId,
    workloadId: row.manifest.workloadId,
    workloadRevision: row.manifest.workloadRevision,
  });

  // ---- the N replays (one immutable identity per replay) ----
  for (let replayOrdinal = 1; replayOrdinal <= row.replayCount; replayOrdinal += 1) {
    const replayKey = replayKeyOf({
      populationId: options.populationId,
      manifest: row.manifest,
      replayOrdinal,
    });
    const replayStartedAt = options.now().getTime();
    options.recorder.beginReplayCapture(options.populationId, replayOrdinal);
    const chain = await driveReplayChain({
      executionId: options.populationId,
      replayOrdinal,
      row,
      recorder: options.recorder,
      learning: options.learning,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      retry,
      now: options.now,
    });
    const capture = options.recorder.replayCapture(options.populationId, replayOrdinal);
    const trajectoryDigest = capture === null ? null : trajectoryDigestOf(capture.steps);
    const observation = await options.ledger.observeReplay({
      replayKey,
      contentDigest: identityContentDigestOf({
        manifestDigest: row.manifest.manifestDigest,
        trajectoryDigest: trajectoryDigest ?? "",
      }),
    });
    replays.push({
      replayOrdinal,
      outcome: chain.outcome,
      trajectoryDigest,
      identityId: observation.identityId,
      replayed: observation.replayed,
      modelCalls: chain.modelCalls,
      usage: chain.usage,
      latencyMs: options.now().getTime() - replayStartedAt,
      failure: chain.failure,
    });
  }

  // ---- the population analysis (the mechanical oracle) ----
  const population = derivePopulationCompleteness({
    replayCount: row.replayCount,
    replays: replays.map((replay) => ({
      replayOrdinal: replay.replayOrdinal,
      identityId: replay.identityId,
      replayed: replay.replayed,
    })),
  });
  const membership = deriveTrajectoryClassMembership({
    expectedClass: row.expectedTrajectoryClass,
    observed: replays.map((replay) => ({
      replayOrdinal: replay.replayOrdinal,
      digest: replay.trajectoryDigest,
    })),
  });
  const observedDigests = replays.map((replay) => replay.trajectoryDigest);
  const stability = deriveStabilityHonesty({
    expected: row.expectedStability,
    // The driver's report is DERIVED from the observed population —
    // the honest report (variance is reported, never smoothed).
    claimed: deriveStabilityReportOf(observedDigests),
    observedDigests,
    expectedReplayCount: row.replayCount,
  });
  const accounting = deriveReplayAccountingHonesty({
    needsDispatch: row.needsDispatch,
    perReplayUsage: replays.map((replay) => replay.usage),
    perReplayLatencyMs: replays.map((replay) => replay.latencyMs),
    expectedReplayCount: row.replayCount,
  });
  const latency = deriveLatencyDistribution({
    perReplayLatencyMs: replays.map((replay) => replay.latencyMs),
    expectedReplayCount: row.replayCount,
  });

  // ---- the ledger's own view (the identity count + the totals) ----
  const populationPrefix = replayKeyOf({
    populationId: options.populationId,
    manifest: row.manifest,
    replayOrdinal: 1,
  }).slice(0, -"replay-1".length);
  const ledgerIdentityCount = options.ledger
    .facts()
    .identities.filter((identity) => identity.replayKey.startsWith(populationPrefix)).length;
  const observedModelCalls = replays.reduce((sum, replay) => sum + replay.modelCalls, 0);
  const totals = accounting.totals;
  const usage: LabUsage | null = row.needsDispatch
    ? {
        inputTokens: totals?.totalInputTokens ?? 0,
        outputTokens: totals?.totalOutputTokens ?? 0,
        ...(totals !== null && typeof totals.totalCostUsd === "number"
          ? { costUsd: totals.totalCostUsd }
          : {}),
      }
    : null;
  const totalLatencyMs = options.now().getTime() - populationStartedAt;
  const failure = replays.find((replay) => replay.failure !== null)?.failure ?? null;

  const criteria = deriveWorkloadReplayRowCriteria({
    row,
    populationId: options.populationId,
    registryEntry,
    population,
    membership,
    stability,
    accounting,
    latency,
    replays,
    ledgerIdentityCount,
    observedModelCalls,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    replays.some((replay) => replay.outcome === "FAILED");

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    population,
    membership,
    stability,
    accounting,
    latency,
    replays,
    observedModelCalls,
    usage,
    totalLatencyMs,
    failure,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the frozen-baseline
 * pin leg (the registry holds the pinned manifest — replays never
 * rewrite the manifests), the population-completeness legs, the
 * trajectory-class membership legs, the stability-honesty legs, the
 * accounting-honesty legs, the latency-distribution legs, the replay
 * identity stability (every observed identity is the derived stable
 * VAL-007 form), the ledger identity count (exactly N), the
 * population dispatch total (N replays × the row's own dispatch
 * demand) and the honest outcome contract.
 */
export function deriveWorkloadReplayRowCriteria(input: {
  readonly row: WorkloadReplayCorpusRow;
  readonly populationId: string;
  readonly registryEntry: BaselineRegistryEntry | null;
  readonly population: PopulationCompletenessVerdict;
  readonly membership: TrajectoryClassMembershipVerdict;
  readonly stability: StabilityHonestyVerdict;
  readonly accounting: ReplayAccountingHonestyVerdict;
  readonly latency: LatencyDistributionVerdict;
  readonly replays: readonly ReplayedRunOutcome[];
  readonly ledgerIdentityCount: number;
  readonly observedModelCalls: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];

  // 1. The frozen-baseline pin (the read-only registry input).
  const pinCommitted =
    input.registryEntry !== null &&
    input.registryEntry.manifest.manifestDigest === input.row.manifest.manifestDigest &&
    input.registryEntry.workloadRevision === input.row.manifest.workloadRevision;
  criteria.push({
    criterionId: "baseline-pin-committed",
    strategy: "deterministic",
    status: pinCommitted ? "PASS" : "FAIL",
    evidence: [
      `baseline:${input.row.baselineRowId}`,
      `pinnedManifestDigest:${input.row.manifest.manifestDigest}`,
      input.registryEntry === null
        ? "registryEntry:none (the pinned baseline was never committed)"
        : `registryManifestDigest:${input.registryEntry.manifest.manifestDigest}`,
      pinCommitted
        ? "committed (the frozen baseline is the read-only input — replays never rewrite it)"
        : "UNCOMMITTED (the replay population references a baseline the registry does not hold)",
    ],
  });

  // 2-5. The population, membership, stability, accounting + latency legs.
  criteria.push(...input.population.criteria);
  criteria.push(...input.membership.criteria);
  criteria.push(...input.stability.criteria);
  criteria.push(...input.accounting.criteria);
  criteria.push(...input.latency.criteria);

  // 6. The replay identity stability (the derived stable VAL-007 form).
  const unstableReplays = input.replays.filter(
    (replay) =>
      replay.identityId !== null &&
      replay.identityId !==
        replayIdentityIdOf(
          replayKeyOf({
            populationId: input.populationId,
            manifest: input.row.manifest,
            replayOrdinal: replay.replayOrdinal,
          }),
        ),
  );
  criteria.push({
    criterionId: "replay-identity-stable",
    strategy: "deterministic",
    status: unstableReplays.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `replays:${input.replays.length}`,
      `unstable:${unstableReplays.length === 0 ? "none" : unstableReplays.map((r) => r.replayOrdinal).join(",")}`,
      unstableReplays.length === 0
        ? "every-identity-in-the-derived-stable-form"
        : "UNSTABLE (an identity is not the derived exp-<kind>-<digest> form)",
    ],
  });

  // 7. The ledger identity count (exactly one per replay).
  criteria.push({
    criterionId: "ledger-identities-exactly-n",
    strategy: "deterministic",
    status: input.ledgerIdentityCount === input.row.replayCount ? "PASS" : "FAIL",
    evidence: [
      `expected:${input.row.replayCount}`,
      `observed:${input.ledgerIdentityCount}`,
      input.ledgerIdentityCount === input.row.replayCount
        ? "one-immutable-identity-per-replay"
        : "WRONG-IDENTITY-COUNT (a replay identity was dropped or duplicated)",
    ],
  });

  // 8. The population dispatch total (the inert-learning floor × N).
  const expectedPopulationModelCalls =
    input.row.expectedModelCallsPerReplay * input.row.replayCount;
  criteria.push({
    criterionId: "population-own-dispatch-total",
    strategy: "deterministic",
    status: input.observedModelCalls === expectedPopulationModelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedPopulationModelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === expectedPopulationModelCalls
        ? "the-population-made-its-own-dispatches"
        : "UNDER-DISPATCHED (a reused or shortcut round dispatched nothing)",
    ],
  });

  // 9. The honest outcome contract (the derived terminal vs the pin).
  const derivedTerminal: "COMPLETED" | "FAILED" = input.failure !== null ? "FAILED" : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${input.row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side replay contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/** One replay's app-side observation (the public-boundary read). */
export interface AppReplayObservation {
  readonly replayOrdinal: number;
  /** The durable execution the replay's submission landed. */
  readonly executionId: string;
  /** True when the submission key REPLAYED an existing execution (a shoulder-in). */
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
}

/**
 * Judge the app-side observations against the row's replay-population
 * contract (PURE): the population completeness at the customer
 * boundary (exactly N landed replays — every submission landed its
 * OWN durable execution; a shoulder-in that replays an existing
 * execution or a rejected submission FAILs), per replay the
 * terminal↔criteria agreement, the expected terminal, the
 * trajectory-class membership (the app mechanically re-derives the
 * digest over the public events read — never trusting the platform's
 * claim) and the replay's own dispatch count, and at the population
 * level the stability honesty (the app-derived report judged against
 * the pin — a smoothed variance is unrepresentable) and the population
 * dispatch total.
 */
export function verifyWorkloadReplayAppContract(input: {
  readonly row: WorkloadReplayCorpusRow;
  readonly replays: readonly AppReplayObservation[];
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  // 1. The population completeness at the customer boundary (the
  //    execution id is the replay's durable identity basis here).
  const completeness = derivePopulationCompleteness({
    replayCount: row.replayCount,
    replays: input.replays.map((replay) => ({
      replayOrdinal: replay.replayOrdinal,
      identityId:
        replay.rejection === null && replay.executionId !== "" ? replay.executionId : null,
      replayed: replay.replayed,
    })),
  });
  criteria.push(
    ...completeness.criteria.map((criterion) => ({
      ...criterion,
      criterionId: `app-${criterion.criterionId}`,
    })),
  );
  const rejectedReplays = input.replays.filter(
    (replay) => replay.rejection !== null || replay.executionId === "",
  );
  criteria.push({
    criterionId: "app-replay-submissions-landed",
    strategy: "deterministic",
    status: rejectedReplays.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `replays:${input.replays.length}`,
      `rejected:${rejectedReplays.length === 0 ? "none" : rejectedReplays.map((r) => r.replayOrdinal).join(",")}`,
      rejectedReplays.length === 0
        ? "every-replay-submission-landed-its-own-execution"
        : "REJECTED (a replay submission never landed a durable execution)",
    ],
  });

  // 2-5. The per-replay contract legs.
  for (const replay of input.replays) {
    const agreement = deriveTerminalCriteriaAgreement({
      terminal: replay.terminal,
      verificationStatuses: replay.verificationStatuses,
    });
    criteria.push({
      criterionId: `app-replay-${replay.replayOrdinal}-terminal-criteria-agreement`,
      strategy: "deterministic",
      status: agreement.agreement ? "PASS" : "FAIL",
      evidence: agreement.evidence,
    });
    criteria.push({
      criterionId: `app-replay-${replay.replayOrdinal}-expected-terminal`,
      strategy: "deterministic",
      status: replay.terminal === row.expected.terminal ? "PASS" : "FAIL",
      evidence: [`expected:${row.expected.terminal}`, `observed:${replay.terminal ?? "none"}`],
    });
    const membership =
      replay.trajectoryDigest !== null &&
      row.expectedTrajectoryClass.includes(replay.trajectoryDigest);
    criteria.push({
      criterionId: `app-replay-${replay.replayOrdinal}-trajectory-class-membership`,
      strategy: "deterministic",
      status: membership ? "PASS" : "FAIL",
      evidence: [
        `trajectoryDigest:${replay.trajectoryDigest ?? "none"}`,
        `classSize:${row.expectedTrajectoryClass.length}`,
        membership
          ? "in-class"
          : "OUT-OF-CLASS (the observed trajectory drifted from the recorded baseline)",
      ],
    });
    criteria.push({
      criterionId: `app-replay-${replay.replayOrdinal}-own-dispatches`,
      strategy: "deterministic",
      status: replay.observedModelCalls === row.expectedModelCallsPerReplay ? "PASS" : "FAIL",
      evidence: [
        `expected:${row.expectedModelCallsPerReplay}`,
        `observed:${replay.observedModelCalls ?? "none"}`,
        replay.observedModelCalls === row.expectedModelCallsPerReplay
          ? "the-replay-made-its-own-dispatches"
          : "UNDER-DISPATCHED (a reused or shortcut round dispatched nothing)",
      ],
    });
  }

  // 6. The population stability honesty (the app-derived report judged
  //    against the pin — a smoothed variance is unrepresentable).
  const observedDigests = input.replays.map((replay) => replay.trajectoryDigest);
  const stability = deriveStabilityHonesty({
    expected: row.expectedStability,
    claimed: deriveStabilityReportOf(observedDigests),
    observedDigests,
    expectedReplayCount: row.replayCount,
  });
  criteria.push(
    ...stability.criteria.map((criterion) => ({
      ...criterion,
      criterionId: `app-${criterion.criterionId}`,
    })),
  );

  // 7. The population dispatch total (the inert-learning floor × N).
  const observedTotal = input.replays.reduce(
    (sum, replay) => sum + (replay.observedModelCalls ?? 0),
    0,
  );
  const expectedTotal = row.expectedModelCallsPerReplay * row.replayCount;
  criteria.push({
    criterionId: "app-population-dispatch-total",
    strategy: "deterministic",
    status: observedTotal === expectedTotal ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedTotal}`,
      `observed:${observedTotal}`,
      observedTotal === expectedTotal
        ? "the-population-made-its-own-dispatches"
        : "UNDER-DISPATCHED (the population under-dispatched)",
    ],
  });

  return criteria;
}
