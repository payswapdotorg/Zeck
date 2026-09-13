/**
 * The platform-side learned-structure discovery engine (VAL-032).
 *
 * The mechanical engine of the discovery slice: it mines the RECORDED
 * trajectory populations (VAL-031's replay ledger — the read-only
 * input; the recorded populations are never rewritten) for LEARNABLE
 * structure and records every discovery as a PROPOSAL in the
 * deterministicization lifecycle's candidate registry — never as an
 * applied change (discovery proposes; application is VAL-033+'s
 * scope).
 *
 * The four candidate kinds (the vocabulary this slice pins):
 *
 *   * `reuse` — a repeated sub-trajectory SHAPE across workloads (the
 *     same structural sub-trajectory recurs in two or more distinct
 *     workloads: a reusable routine);
 *   * `cache` — a stable input→output transformation (the same
 *     workload-input digest maps to the same observed output digest
 *     across replays — a cacheable transformation, even when the
 *     trajectory itself legitimately varies);
 *   * `competence` — a recurring competence step-pattern (the same
 *     ordered step pattern recurs across the replays: a competence
 *     the executions already share);
 *   * `deterministicization` — a stable-across-replays segment (one
 *     workload's replay population reproduces the IDENTICAL trajectory
 *     digest across every replay: the segment is determinizable).
 *
 * The discovery oracle (the PURE derivations that make a proposal
 * trustworthy):
 *
 *   * `deriveEvidenceCitationCompleteness` — every cited trajectory
 *     digest and replay identity is a MEMBER of the recorded
 *     population (a fabricated citation FAILs) and every
 *     generalization cites its FULL population (an uncited proposal
 *     FAILs; a partial-population citation FAILs; a single-observation
 *     population is not evidence for a generalization);
 *   * `deriveCandidateKindFidelity` — the proposal's kind matches the
 *     mined structure (repeated shapes ⇒ reuse, stable input→output ⇒
 *     cache, recurring patterns ⇒ competence, stable segments ⇒
 *     deterministicization) and the proposal cites the structure the
 *     miner actually mined (a fabricated structure digest FAILs);
 *   * `deriveConservatism` — a varying segment (VAL-031's
 *     honestly-reported variance) is NEVER proposed as a
 *     deterministicization candidate: a deterministicization proposal
 *     over a population with any varying workload FAILs (a
 *     variance-smoothing proposal);
 *   * `deriveNoApplication` — a proposal that mutates ANY frozen state
 *     (the recorded populations, the frozen baseline registry) FAILs,
 *     and a proposal recorded past the `proposed` lifecycle stage (an
 *     APPLIED candidate) FAILs — discovery proposes, never applies;
 *   * `deriveRefusalHonesty` — a refusal is honest only when the
 *     recorded structure genuinely lacks the declared candidate kind
 *     (a discovery that hides learnable structure FAILs just as one
 *     that invents it does).
 *
 * Honesty invariants:
 *   * the recorded trajectory populations are READ-ONLY inputs — the
 *     discovery never rewrites a recorded observation, a frozen
 *     manifest or a workload;
 *   * every proposal cites payload-free FNV-1a DIGESTS only (never
 *     payload bytes);
 *   * a proposal lands in the candidate registry at the `proposed`
 *     lifecycle stage (the deterministicization contract's lifecycle:
 *     observe → characterize → propose → … → promotion — promotion is
 *     never this slice's act);
 *   * an honestly-varying population is reported varying and never
 *     smoothed into a deterministicization candidate;
 *   * usage is measured on the live rail and honestly none-reported
 *     offline; latency is always measured.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch (env-gated, BYOK, measured — never
 * fabricated).
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type { ControlDispatch, TrajectoryStepRecord } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The discovery vocabulary (the candidate-kind grammar)
// ---------------------------------------------------------------------------

/**
 * The discovery phase's learning mode: learning DISCOVERS and PROPOSES
 * — it never applies (application is VAL-033+'s scope; a proposal that
 * mutates state FAILs mechanically).
 */
export const DISCOVERY_LEARNING_PHASE = "discovery" as const;

/**
 * The longitudinal-experiment kind every discovery run registers as
 * (the VAL-007 experiment vocabulary — a learning-discovery
 * measurement).
 */
export const DISCOVERY_EXPERIMENT_KIND = "learning-discovery";

/**
 * The candidate-kind vocabulary (the four learnable structures the
 * discovery mines the recorded populations for):
 *
 *   * `reuse` — a repeated sub-trajectory shape across workloads;
 *   * `cache` — a stable input→output transformation across replays;
 *   * `competence` — a recurring competence step-pattern;
 *   * `deterministicization` — a segment stable across identical
 *     replays (determinizable).
 */
export const CANDIDATE_KINDS = ["reuse", "cache", "competence", "deterministicization"] as const;

export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export function isCandidateKind(value: string): value is CandidateKind {
  return (CANDIDATE_KINDS as readonly string[]).includes(value);
}

/**
 * The discovery-probe kinds the corpus declares (the vocabulary the
 * later discrimination phases drive over the adversarial fixture
 * variants — designed here, pinned now):
 *
 *   * `uncited-proposal` — a proposal whose evidence citation is empty
 *     (an uncited proposal FAILs);
 *   * `partial-population` — a proposal citing only part of the
 *     recorded population (a partial-population generalization FAILs);
 *   * `fabricated-citation` — a proposal citing a digest that is not a
 *     member of the recorded population (a fabricated citation FAILs);
 *   * `variance-smoothing` — a deterministicization proposal over an
 *     honestly-varying population (a variance-smoothing proposal
 *     FAILs);
 *   * `state-mutation` — a proposal whose recording mutates frozen
 *     state or lands past the `proposed` stage (a state-mutating
 *     proposal FAILs).
 */
export const DISCOVERY_PROBE_KINDS = [
  "uncited-proposal",
  "partial-population",
  "fabricated-citation",
  "variance-smoothing",
  "state-mutation",
] as const;

export type DiscoveryProbeKind = (typeof DISCOVERY_PROBE_KINDS)[number];

export function isDiscoveryProbeKind(value: string): value is DiscoveryProbeKind {
  return (DISCOVERY_PROBE_KINDS as readonly string[]).includes(value);
}

/**
 * The deterministicization lifecycle's candidate stages (the
 * deterministicization contract's promotion ladder, pinned as the
 * candidate-registry grammar): a discovery proposal lands at
 * `proposed` — every stage after it is an APPLICATION-level act that
 * belongs to VAL-033+, never to discovery.
 */
export const CANDIDATE_LIFECYCLE_STAGES = [
  "observed",
  "characterized",
  "proposed",
  "offline-replayed",
  "differentially-evaluated",
  "property-tested",
  "mutation-tested",
  "shadow-executed",
  "canaried",
  "promoted",
] as const;

export type CandidateLifecycleStage = (typeof CANDIDATE_LIFECYCLE_STAGES)[number];

export function isCandidateLifecycleStage(value: string): value is CandidateLifecycleStage {
  return (CANDIDATE_LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/** The ONLY lifecycle stage a discovery proposal may land at. */
export const PROPOSAL_LIFECYCLE_STAGE: CandidateLifecycleStage = "proposed";

/**
 * Whether a lifecycle stage is an APPLICATION-level act (any stage
 * past `proposed` on the pinned ladder — offline replay, differential
 * evaluation, testing, shadow execution, canary, promotion). A
 * discovery proposal recorded at an applied stage FAILs the
 * no-application discipline.
 */
export function isAppliedLifecycleStage(stage: string): boolean {
  const ladder = CANDIDATE_LIFECYCLE_STAGES as readonly string[];
  const stageIndex = ladder.indexOf(stage);
  const proposalIndex = ladder.indexOf(PROPOSAL_LIFECYCLE_STAGE);
  return stageIndex > proposalIndex;
}

/**
 * The honest refusal reasons (a refusal is honest only when the
 * recorded structure genuinely justifies it):
 *
 *   * `varying-population` — the declared deterministicization
 *     question meets an honestly-varying population (VAL-031's
 *     reported variance is never smoothed into a candidate);
 *   * `no-dispatched-work` — the recorded population holds no
 *     dispatched model work (a guard-rejected population: there is no
 *     AI execution subgraph to learn from);
 *   * `no-learnable-structure` — the recorded population holds no
 *     structure of the declared candidate kind.
 */
export const REFUSAL_REASONS = [
  "varying-population",
  "no-dispatched-work",
  "no-learnable-structure",
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export function isRefusalReason(value: string): value is RefusalReason {
  return (REFUSAL_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The recorded replay observation (VAL-031's ledger vocabulary)
// ---------------------------------------------------------------------------

/**
 * ONE recorded replay observation — the read-only input unit the
 * discovery mines (VAL-031's replay-ledger vocabulary: the replay's
 * immutable ledger identity and its observed trajectory digest, plus
 * the payload-free structural digests the mining derives its four
 * signals from). Every field is a digest or an identity — payload
 * bytes never enter the mining basis.
 */
export interface RecordedReplayObservation {
  /** The workload whose replay population this observation belongs to. */
  readonly workloadId: string;
  /** 1-based ordinal within the workload's replay population. */
  readonly replayOrdinal: number;
  /** The replay's immutable VAL-031 ledger identity (exp-workload-replay-…). */
  readonly replayIdentity: string;
  /** The replay's observed trajectory digest (the pinned-class member). */
  readonly trajectoryDigest: string;
  /**
   * The replay's repeated sub-trajectory SHAPE digest (the reuse
   * signal: shapes shared across DISTINCT workloads).
   */
  readonly subTrajectoryShapeDigest: string;
  /** The replay's workload input digest (the cache signal's input side). */
  readonly inputDigest: string;
  /** The replay's observed output digest (the cache signal's output side). */
  readonly outputDigest: string;
  /** The replay's competence step-pattern digest (the competence signal). */
  readonly stepPatternDigest: string;
  /** The replay's dispatched model rounds (zero on guard-rejected workloads). */
  readonly dispatchedRounds: number;
}

/**
 * The canonical digest over the repeated sub-trajectory's shape (PURE —
 * FNV-1a over the shape's step identity, payload-free).
 */
export function subTrajectoryShapeDigestOf(shape: readonly string[]): string {
  return longitudinalDigestOf(["sub-trajectory-shape", ...shape]);
}

/**
 * The canonical digest over one replay's competence step pattern (PURE
 * — FNV-1a over the ordered step identities, payload-free).
 */
export function stepPatternDigestOf(pattern: readonly string[]): string {
  return longitudinalDigestOf(["step-pattern", ...pattern]);
}

/**
 * The canonical digest over a workload's input basis (PURE — the
 * workload identity the input rides, payload-free).
 */
export function workloadInputDigestOf(input: {
  readonly appId: string;
  readonly workloadId: string;
  readonly workloadRevision: number;
}): string {
  return longitudinalDigestOf([
    "workload-input",
    input.appId,
    input.workloadId,
    `r${input.workloadRevision}`,
  ]);
}

/**
 * The canonical digest over a workload's observed output basis (PURE —
 * the applied effect set, canonically sorted, payload-free).
 */
export function workloadOutputDigestOf(
  effects: readonly {
    readonly effect: string;
    readonly key: string;
    readonly amountMicro: number;
  }[],
): string {
  return longitudinalDigestOf([
    "workload-output",
    ...[...effects]
      .map((effect) => [effect.effect, effect.key, effect.amountMicro] as const)
      .sort((left, right) => left.join("|").localeCompare(right.join("|"))),
  ]);
}

/** The canonical digest over one recorded population (PURE, payload-free). */
export function recordedPopulationDigestOf(
  population: readonly RecordedReplayObservation[],
): string {
  return longitudinalDigestOf(
    [...population]
      .map((observation) => [
        observation.workloadId,
        observation.replayOrdinal,
        observation.replayIdentity,
        observation.trajectoryDigest,
      ])
      .sort((left, right) => left.join(":").localeCompare(right.join(":"))),
  );
}

// ---------------------------------------------------------------------------
// The mined learnable structure (the four signals)
// ---------------------------------------------------------------------------

/** A reuse candidate: one sub-trajectory shape repeated across workloads. */
export interface ReuseShapeCandidate {
  readonly shapeDigest: string;
  /** The DISTINCT workloads whose replays carry the shape. */
  readonly workloadIds: readonly string[];
  readonly occurrences: number;
}

/** A cache candidate: one stable input→output transformation. */
export interface CacheTransformCandidate {
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly occurrences: number;
}

/** A competence candidate: one recurring step pattern. */
export interface CompetencePatternCandidate {
  readonly patternDigest: string;
  readonly occurrences: number;
}

/**
 * A deterministicization candidate: one workload's replay population
 * reproducing the IDENTICAL trajectory digest across every replay (a
 * stable-across-replays segment — determinizable).
 */
export interface StableSegmentCandidate {
  readonly workloadId: string;
  readonly trajectoryDigest: string;
  readonly replays: number;
}

/**
 * The honestly-reported variance: one workload whose replay population
 * reproduced MORE THAN ONE trajectory digest (VAL-031's varying
 * population — REPORTED here, never smoothed).
 */
export interface VaryingSegmentReport {
  readonly workloadId: string;
  readonly observedDigests: readonly string[];
}

/** The mined learnable structure (the PURE mining basis, digests only). */
export interface MinedLearnableStructure {
  readonly reuseCandidates: readonly ReuseShapeCandidate[];
  readonly cacheCandidates: readonly CacheTransformCandidate[];
  readonly competenceCandidates: readonly CompetencePatternCandidate[];
  readonly deterministicizationCandidates: readonly StableSegmentCandidate[];
  readonly varyingSegments: readonly VaryingSegmentReport[];
  /** The dispatch-bearing observations (the learnable-work floor). */
  readonly dispatchedObservations: number;
  readonly populationSize: number;
  /** The canonical digest over this structure (payload-free). */
  readonly digest: string;
}

/**
 * Derive the mined learnable structure from a recorded population
 * (PURE): the four candidate signals plus the honest variance report.
 *
 *   * reuse — sub-trajectory shapes grouped across DISTINCT workloads
 *     (≥ 2 workloads carrying the same shape digest);
 *   * cache — input→output transformations recurring across replays
 *     (≥ 2 occurrences of the same input digest → output digest pair);
 *   * competence — step patterns recurring across replays (≥ 2
 *     occurrences of the same ordered pattern);
 *   * deterministicization — per workload, a trajectory digest
 *     reproduced by EVERY replay of that workload's population;
 *   * varying — per workload, more than one observed trajectory digest
 *     (the honest variance VAL-031 reported — REPORTED, never
 *     smoothed).
 *
 * Guard-rejected populations (zero dispatched rounds everywhere) hold
 * no learnable structure: every signal requires dispatched model work.
 */
export function mineLearnableStructureOf(
  population: readonly RecordedReplayObservation[],
): MinedLearnableStructure {
  const dispatched = population.filter((observation) => observation.dispatchedRounds > 0);

  // The reuse signal: shapes shared across DISTINCT workloads.
  const shapeGroups = new Map<string, { workloads: Set<string>; occurrences: number }>();
  for (const observation of dispatched) {
    const group = shapeGroups.get(observation.subTrajectoryShapeDigest) ?? {
      workloads: new Set<string>(),
      occurrences: 0,
    };
    group.workloads.add(observation.workloadId);
    group.occurrences += 1;
    shapeGroups.set(observation.subTrajectoryShapeDigest, group);
  }
  const reuseCandidates: ReuseShapeCandidate[] = [...shapeGroups.entries()]
    .filter(([, group]) => group.workloads.size >= 2)
    .map(([shapeDigest, group]) => ({
      shapeDigest,
      workloadIds: [...group.workloads].sort(),
      occurrences: group.occurrences,
    }))
    .sort((left, right) => left.shapeDigest.localeCompare(right.shapeDigest));

  // The cache signal: recurring input→output transformations.
  const transformGroups = new Map<
    string,
    { inputDigest: string; outputDigest: string; occurrences: number }
  >();
  for (const observation of dispatched) {
    const key = `${observation.inputDigest}->${observation.outputDigest}`;
    const group = transformGroups.get(key) ?? {
      inputDigest: observation.inputDigest,
      outputDigest: observation.outputDigest,
      occurrences: 0,
    };
    group.occurrences += 1;
    transformGroups.set(key, group);
  }
  const cacheCandidates: CacheTransformCandidate[] = [...transformGroups.values()]
    .filter((group) => group.occurrences >= 2)
    .sort((left, right) => left.inputDigest.localeCompare(right.inputDigest));

  // The competence signal: recurring step patterns.
  const patternGroups = new Map<string, number>();
  for (const observation of dispatched) {
    patternGroups.set(
      observation.stepPatternDigest,
      (patternGroups.get(observation.stepPatternDigest) ?? 0) + 1,
    );
  }
  const competenceCandidates: CompetencePatternCandidate[] = [...patternGroups.entries()]
    .filter(([, occurrences]) => occurrences >= 2)
    .map(([patternDigest, occurrences]) => ({ patternDigest, occurrences }))
    .sort((left, right) => left.patternDigest.localeCompare(right.patternDigest));

  // The deterministicization signal + the honest variance report: per
  // workload, the observed trajectory-digest distribution.
  const workloadGroups = new Map<string, { digests: string[]; replays: number }>();
  for (const observation of dispatched) {
    const group = workloadGroups.get(observation.workloadId) ?? { digests: [], replays: 0 };
    group.digests.push(observation.trajectoryDigest);
    group.replays += 1;
    workloadGroups.set(observation.workloadId, group);
  }
  const deterministicizationCandidates: StableSegmentCandidate[] = [];
  const varyingSegments: VaryingSegmentReport[] = [];
  for (const [workloadId, group] of [...workloadGroups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const distinct = [...new Set(group.digests)];
    if (distinct.length === 1) {
      deterministicizationCandidates.push({
        workloadId,
        trajectoryDigest: distinct[0] ?? "",
        replays: group.replays,
      });
    } else {
      varyingSegments.push({ workloadId, observedDigests: distinct.sort() });
    }
  }

  const basis = {
    reuseCandidates,
    cacheCandidates,
    competenceCandidates,
    deterministicizationCandidates,
    varyingSegments,
    dispatchedObservations: dispatched.length,
    populationSize: population.length,
  };
  return { ...basis, digest: minedStructureDigestOf(basis) };
}

/**
 * The canonical digest over a mined structure (PURE): the four signal
 * lists plus the variance report, each canonically sorted — the
 * payload-free fingerprint every proposal's `minedStructureDigest`
 * must reproduce.
 */
export function minedStructureDigestOf(structure: Omit<MinedLearnableStructure, "digest">): string {
  return longitudinalDigestOf([
    "mined-structure",
    structure.reuseCandidates.map((candidate) => [
      candidate.shapeDigest,
      ...candidate.workloadIds,
      candidate.occurrences,
    ]),
    structure.cacheCandidates.map((candidate) => [
      candidate.inputDigest,
      candidate.outputDigest,
      candidate.occurrences,
    ]),
    structure.competenceCandidates.map((candidate) => [
      candidate.patternDigest,
      candidate.occurrences,
    ]),
    structure.deterministicizationCandidates.map((candidate) => [
      candidate.workloadId,
      candidate.trajectoryDigest,
      candidate.replays,
    ]),
    structure.varyingSegments.map((report) => [report.workloadId, ...report.observedDigests]),
    structure.dispatchedObservations,
    structure.populationSize,
  ]);
}

/**
 * The size of the mined structure's signal for one candidate kind
 * (PURE): zero means the recorded population holds no structure of
 * that kind (a proposal of that kind FAILs fidelity; an honest
 * discovery refuses).
 */
export function kindSignalSizeOf(structure: MinedLearnableStructure, kind: CandidateKind): number {
  switch (kind) {
    case "reuse":
      return structure.reuseCandidates.length;
    case "cache":
      return structure.cacheCandidates.length;
    case "competence":
      return structure.competenceCandidates.length;
    case "deterministicization":
      return structure.deterministicizationCandidates.length;
  }
}

// ---------------------------------------------------------------------------
// The proposal record (the payload-free discovery artifact)
// ---------------------------------------------------------------------------

/** The proposal's evidence citation: digests only, never payload bytes. */
export interface ProposalEvidenceCitation {
  /** The cited trajectory digests (every member of the recorded population). */
  readonly trajectoryDigests: readonly string[];
  /** The cited replay identities (every replay of the recorded population). */
  readonly replayIdentities: readonly string[];
}

/**
 * The proposal record (the discovery's ONLY artifact): the candidate
 * kind, the evidence citation (the FULL recorded population —
 * trajectory digests + replay identities), the digest of the mined
 * structure the proposal generalizes from, and the lifecycle stage
 * (always `proposed` — never applied).
 */
export interface DiscoveryProposalRecord {
  /** The stable proposal identity (the derived cand-<kind>-<digest> form). */
  readonly proposalId: string;
  readonly kind: CandidateKind;
  readonly citation: ProposalEvidenceCitation;
  readonly minedStructureDigest: string;
  readonly lifecycleStage: CandidateLifecycleStage;
}

/**
 * The canonical FULL-population citation (PURE): every distinct
 * trajectory digest the population observed (sorted) and every replay
 * identity (in population order). A generalization cites its FULL
 * population — anything less FAILs completeness.
 */
export function canonicalCitationOf(
  population: readonly RecordedReplayObservation[],
): ProposalEvidenceCitation {
  return {
    trajectoryDigests: [...new Set(population.map((o) => o.trajectoryDigest))].sort(),
    replayIdentities: population.map((o) => o.replayIdentity),
  };
}

/**
 * The stable proposal identity (PURE — the derived
 * `cand-<kind>-<digest>` form over the proposal's own content: kind +
 * citation + mined structure digest; never a minted random id).
 */
export function proposalIdentityIdOf(record: Omit<DiscoveryProposalRecord, "proposalId">): string {
  return `cand-${DISCOVERY_EXPERIMENT_KIND}-${longitudinalDigestOf([
    record.kind,
    record.citation.trajectoryDigests,
    record.citation.replayIdentities,
    record.minedStructureDigest,
    record.lifecycleStage,
  ])}`;
}

// ---------------------------------------------------------------------------
// Evidence-citation completeness (the discovery oracle's citation leg)
// ---------------------------------------------------------------------------

/** The evidence-citation completeness verdict. */
export interface EvidenceCitationCompletenessVerdict {
  /** Every cited digest/identity is a population member AND the full population is cited. */
  readonly complete: boolean;
  readonly populationSize: number;
  readonly citedTrajectoryDigests: number;
  readonly citedReplayIdentities: number;
  /** Cited digests that are NOT members of the recorded population (fabricated). */
  readonly fabricatedTrajectoryDigests: readonly string[];
  /** Cited identities that are NOT members of the recorded population (fabricated). */
  readonly fabricatedReplayIdentities: readonly string[];
  /** Population digests the citation MISSED (uncited / partial). */
  readonly uncitedTrajectoryDigests: readonly string[];
  /** Population identities the citation MISSED (uncited / partial). */
  readonly uncitedReplayIdentities: readonly string[];
  /** A generalization demands at least two observations (a population of one is not evidence). */
  readonly minimumEvidence: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the evidence-citation completeness (PURE — the discovery
 * oracle's citation leg): every cited trajectory digest and replay
 * identity must be a MEMBER of the recorded population (a fabricated
 * citation FAILs), every generalization must cite its FULL population
 * (an uncited proposal FAILs; a partial-population citation — a
 * missing digest or a missing replay identity — FAILs), and the
 * population must hold at least two observations (a generalization
 * from a single observation FAILs — one replay is an anecdote, not a
 * population).
 */
export function deriveEvidenceCitationCompleteness(input: {
  /** The recorded population the proposal generalizes from (read-only). */
  readonly population: readonly RecordedReplayObservation[];
  /** The proposal's evidence citation under test. */
  readonly citation: ProposalEvidenceCitation;
}): EvidenceCitationCompletenessVerdict {
  const populationDigests = [...new Set(input.population.map((o) => o.trajectoryDigest))];
  const populationIdentities = input.population.map((o) => o.replayIdentity);
  const citedDigests = [...new Set(input.citation.trajectoryDigests)];
  const citedIdentities = [...new Set(input.citation.replayIdentities)];

  const fabricatedTrajectoryDigests = citedDigests.filter(
    (digest) => !populationDigests.includes(digest),
  );
  const fabricatedReplayIdentities = citedIdentities.filter(
    (identity) => !populationIdentities.includes(identity),
  );
  const uncitedTrajectoryDigests = populationDigests.filter(
    (digest) => !citedDigests.includes(digest),
  );
  const uncitedReplayIdentities = populationIdentities.filter(
    (identity) => !citedIdentities.includes(identity),
  );
  const minimumEvidence = input.population.length >= 2;
  const noFabrication =
    fabricatedTrajectoryDigests.length === 0 && fabricatedReplayIdentities.length === 0;
  const fullPopulation =
    uncitedTrajectoryDigests.length === 0 && uncitedReplayIdentities.length === 0;
  const complete = noFabrication && fullPopulation && minimumEvidence;

  return {
    complete,
    populationSize: input.population.length,
    citedTrajectoryDigests: citedDigests.length,
    citedReplayIdentities: citedIdentities.length,
    fabricatedTrajectoryDigests,
    fabricatedReplayIdentities,
    uncitedTrajectoryDigests,
    uncitedReplayIdentities,
    minimumEvidence,
    criteria: [
      {
        criterionId: "citation-no-fabrication",
        strategy: "deterministic",
        status: noFabrication ? "PASS" : "FAIL",
        evidence: [
          `populationDigests:${populationDigests.length}`,
          `populationIdentities:${populationIdentities.length}`,
          `fabricatedDigests:${fabricatedTrajectoryDigests.length === 0 ? "none" : fabricatedTrajectoryDigests.join(",")}`,
          `fabricatedIdentities:${fabricatedReplayIdentities.length === 0 ? "none" : fabricatedReplayIdentities.join(",")}`,
          noFabrication
            ? "every-cited-member-recorded (the citation cites only recorded evidence)"
            : "FABRICATED-CITATION (a cited digest or identity is not a member of the recorded population)",
        ],
      },
      {
        criterionId: "citation-full-population",
        strategy: "deterministic",
        status: fullPopulation ? "PASS" : "FAIL",
        evidence: [
          `citedDigests:${citedDigests.length}/${populationDigests.length}`,
          `citedIdentities:${citedIdentities.length}/${populationIdentities.length}`,
          `uncitedDigests:${uncitedTrajectoryDigests.length === 0 ? "none" : uncitedTrajectoryDigests.join(",")}`,
          `uncitedIdentities:${uncitedReplayIdentities.length === 0 ? "none" : uncitedReplayIdentities.join(",")}`,
          citedIdentities.length === 0
            ? "UNCITED-PROPOSAL (a generalization with no evidence citation)"
            : fullPopulation
              ? "the-generalization-cites-its-full-population"
              : "PARTIAL-POPULATION (the citation covers only part of the recorded population)",
        ],
      },
      {
        criterionId: "citation-minimum-evidence",
        strategy: "deterministic",
        status: minimumEvidence ? "PASS" : "FAIL",
        evidence: [
          `populationSize:${input.population.length}`,
          minimumEvidence
            ? "population-of-many (a generalization rests on a population)"
            : "SINGLE-OBSERVATION (one replay is an anecdote, not a population)",
        ],
      },
      {
        criterionId: "citation-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `populationSize:${input.population.length}`,
          `citedDigests:${citedDigests.length}`,
          `citedIdentities:${citedIdentities.length}`,
          `fabricated:${fabricatedTrajectoryDigests.length + fabricatedReplayIdentities.length}`,
          `uncited:${uncitedTrajectoryDigests.length + uncitedReplayIdentities.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Candidate-kind fidelity (the proposal's kind matches the mined structure)
// ---------------------------------------------------------------------------

/** The candidate-kind fidelity verdict. */
export interface CandidateKindFidelityVerdict {
  /** The proposal's kind is exactly the structure the mining found, and the cited structure is the mined one. */
  readonly faithful: boolean;
  readonly proposalKind: CandidateKind;
  /** The mined structure's signal size for the proposal's kind (0 = mismatch). */
  readonly signalSize: number;
  /** The proposal's minedStructureDigest equals the structure the miner derived. */
  readonly structureDigestMatches: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the candidate-kind fidelity (PURE — the discovery oracle's
 * kind leg): the proposal's kind must match the MINED structure —
 * repeated sub-trajectory shapes ⇒ `reuse`, stable input→output
 * digests ⇒ `cache`, recurring competence step-patterns ⇒
 * `competence`, stable-across-replays segments ⇒
 * `deterministicization`. A proposal of a kind whose mined signal is
 * EMPTY FAILs (a mismatch), and a proposal whose
 * `minedStructureDigest` differs from the digest of the structure the
 * miner actually derived FAILs (a fabricated structure citation).
 */
export function deriveCandidateKindFidelity(input: {
  /** The proposal under test. */
  readonly proposal: DiscoveryProposalRecord;
  /** The structure the miner derived from the cited population. */
  readonly structure: MinedLearnableStructure;
}): CandidateKindFidelityVerdict {
  const signalSize = kindSignalSizeOf(input.structure, input.proposal.kind);
  const kindMatches = signalSize > 0;
  const structureDigestMatches = input.proposal.minedStructureDigest === input.structure.digest;
  const faithful = kindMatches && structureDigestMatches;

  const kindBasis: Record<CandidateKind, string> = {
    reuse: "repeated sub-trajectory shapes across workloads",
    cache: "stable input→output digests across replays",
    competence: "recurring competence step-patterns",
    deterministicization: "segments stable across identical replays",
  };

  return {
    faithful,
    proposalKind: input.proposal.kind,
    signalSize,
    structureDigestMatches,
    criteria: [
      {
        criterionId: "kind-fidelity",
        strategy: "deterministic",
        status: kindMatches ? "PASS" : "FAIL",
        evidence: [
          `proposalKind:${input.proposal.kind}`,
          `signalSize:${signalSize}`,
          `minedBasis:${kindBasis[input.proposal.kind]}`,
          kindMatches
            ? "the-kind-matches-the-mined-structure"
            : "KIND-MISMATCH (the mined structure holds no signal of the proposal's kind)",
        ],
      },
      {
        criterionId: "mined-structure-digest",
        strategy: "deterministic",
        status: structureDigestMatches ? "PASS" : "FAIL",
        evidence: [
          `proposalStructureDigest:${input.proposal.minedStructureDigest}`,
          `minedStructureDigest:${input.structure.digest}`,
          structureDigestMatches
            ? "the-proposal-cites-the-mined-structure"
            : "FABRICATED-STRUCTURE (the proposal cites a structure the mining did not derive)",
        ],
      },
      {
        criterionId: "kind-fidelity-summary",
        strategy: "deterministic",
        status: faithful ? "PASS" : "FAIL",
        evidence: [
          `faithful:${String(faithful)}`,
          `kindMatches:${String(kindMatches)}`,
          `structureDigestMatches:${String(structureDigestMatches)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Conservatism (a varying segment is never a deterministicization candidate)
// ---------------------------------------------------------------------------

/** The conservatism verdict. */
export interface ConservatismVerdict {
  /** No deterministicization proposal rides an honestly-varying population. */
  readonly conservative: boolean;
  readonly proposalKind: CandidateKind | null;
  /** The workloads whose replay populations honestly vary (REPORTED, never smoothed). */
  readonly varyingWorkloadIds: readonly string[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the conservatism (PURE — the discovery oracle's honesty leg):
 * a varying segment — VAL-031's honestly-reported variance — is NEVER
 * proposed as a deterministicization candidate. A
 * deterministicization proposal over a population with ANY varying
 * workload FAILs (a variance-smoothing proposal: it would smooth the
 * reported variance into a fake determinism). A proposal of another
 * kind over a varying population is judged by its OWN signal (a cache
 * candidate over legitimately-varying orderings is REAL structure,
 * not smoothing) — and an honest refusal or an absent proposal is
 * always conservative.
 */
export function deriveConservatism(input: {
  /** The proposal under test (null when the discovery honestly refused). */
  readonly proposal: DiscoveryProposalRecord | null;
  /** The structure the miner derived from the recorded population. */
  readonly structure: MinedLearnableStructure;
}): ConservatismVerdict {
  const varyingWorkloadIds = input.structure.varyingSegments.map((report) => report.workloadId);
  const smoothing =
    input.proposal !== null &&
    input.proposal.kind === "deterministicization" &&
    varyingWorkloadIds.length > 0;
  const conservative = !smoothing;

  return {
    conservative,
    proposalKind: input.proposal?.kind ?? null,
    varyingWorkloadIds,
    criteria: [
      {
        criterionId: "conservatism-no-variance-smoothing",
        strategy: "deterministic",
        status: conservative ? "PASS" : "FAIL",
        evidence: [
          `proposalKind:${input.proposal?.kind ?? "none (an honest refusal)"}`,
          `varyingWorkloads:${varyingWorkloadIds.length === 0 ? "none" : varyingWorkloadIds.join(",")}`,
          conservative
            ? "no-deterministicization-over-variance (a varying segment is never proposed)"
            : "VARIANCE-SMOOTHING (a deterministicization proposal over an honestly-varying population)",
        ],
      },
      {
        criterionId: "conservatism-variance-reported",
        strategy: "deterministic",
        status: "PASS",
        evidence: [
          `varyingSegments:${
            input.structure.varyingSegments
              .map((report) => `${report.workloadId}:{${report.observedDigests.join(",")}}`)
              .join(";") || "none"
          }`,
          "the-variance-is-reported-never-smoothed (VAL-031's honest report rides the structure)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// No-application (discovery proposes, never applies)
// ---------------------------------------------------------------------------

/** The candidate registry's own facts (the lifecycle candidates). */
export interface CandidateRegistryFacts {
  readonly candidates: readonly {
    readonly proposalId: string;
    readonly kind: CandidateKind;
    readonly lifecycleStage: CandidateLifecycleStage;
    /** The canonical digest over the recorded candidate's citation. */
    readonly citationDigest: string;
    readonly minedStructureDigest: string;
  }[];
  /** Candidates recorded PAST the proposed stage (an application-level act). */
  readonly appliedCandidateCount: number;
}

/** The no-application verdict. */
export interface NoApplicationVerdict {
  /** The discovery mutated no frozen state and applied no proposal. */
  readonly inert: boolean;
  /** The frozen inputs' digest is unchanged by the discovery run. */
  readonly frozenInputUnchanged: boolean;
  /** The proposal (if any) landed at the `proposed` lifecycle stage. */
  readonly proposalStageProposed: boolean;
  /** The registry holds no applied candidate. */
  readonly appliedCandidateCount: number;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the no-application discipline (PURE — the discovery oracle's
 * scope leg): a proposal that mutates ANY frozen state — the recorded
 * replay populations, the frozen baseline registry, a workload —
 * FAILs (the digest over the frozen inputs must be UNCHANGED by the
 * discovery run), and a proposal recorded past the `proposed`
 * lifecycle stage (an applied/promoted candidate) or a registry that
 * already holds applied candidates FAILs — discovery proposes,
 * VAL-033+ applies.
 */
export function deriveNoApplication(input: {
  /** The frozen-input digest BEFORE the discovery run. */
  readonly beforeFrozenDigest: string;
  /** The frozen-input digest AFTER the discovery run. */
  readonly afterFrozenDigest: string;
  /** The proposal the discovery recorded (null on an honest refusal). */
  readonly proposal: DiscoveryProposalRecord | null;
  /** The candidate registry's own facts AFTER the recording. */
  readonly registryFacts: CandidateRegistryFacts | null;
}): NoApplicationVerdict {
  const frozenInputUnchanged = input.beforeFrozenDigest === input.afterFrozenDigest;
  const proposalStageProposed =
    input.proposal === null || !isAppliedLifecycleStage(input.proposal.lifecycleStage);
  const appliedCandidateCount = input.registryFacts?.appliedCandidateCount ?? 0;
  const noAppliedCandidates = appliedCandidateCount === 0;
  const inert = frozenInputUnchanged && proposalStageProposed && noAppliedCandidates;

  return {
    inert,
    frozenInputUnchanged,
    proposalStageProposed,
    appliedCandidateCount,
    criteria: [
      {
        criterionId: "no-application-frozen-inputs",
        strategy: "deterministic",
        status: frozenInputUnchanged ? "PASS" : "FAIL",
        evidence: [
          `before:${input.beforeFrozenDigest}`,
          `after:${input.afterFrozenDigest}`,
          frozenInputUnchanged
            ? "frozen-inputs-unchanged (the recorded populations, the frozen manifests and the workloads are read-only)"
            : "STATE-MUTATION (the discovery mutated frozen state — the registry, the ledger or a workload)",
        ],
      },
      {
        criterionId: "no-application-lifecycle-stage",
        strategy: "deterministic",
        status: proposalStageProposed ? "PASS" : "FAIL",
        evidence: [
          `lifecycleStage:${input.proposal?.lifecycleStage ?? "none (an honest refusal)"}`,
          `proposedStage:${PROPOSAL_LIFECYCLE_STAGE}`,
          proposalStageProposed
            ? "proposal-stage-only (discovery proposes, never applies)"
            : "APPLIED-PROPOSAL (a proposal recorded past the proposed stage — application is VAL-033+'s scope)",
        ],
      },
      {
        criterionId: "no-application-registry-inert",
        strategy: "deterministic",
        status: noAppliedCandidates ? "PASS" : "FAIL",
        evidence: [
          `appliedCandidates:${appliedCandidateCount}`,
          noAppliedCandidates
            ? "registry-holds-proposals-only (no candidate was applied or promoted)"
            : "APPLIED-CANDIDATES (the registry already holds applied candidates)",
        ],
      },
      {
        criterionId: "no-application-summary",
        strategy: "deterministic",
        status: inert ? "PASS" : "FAIL",
        evidence: [
          `inert:${String(inert)}`,
          `frozenInputUnchanged:${String(frozenInputUnchanged)}`,
          `proposalStageProposed:${String(proposalStageProposed)}`,
          `appliedCandidateCount:${appliedCandidateCount}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refusal honesty (an honest refusal is justified by the recorded structure)
// ---------------------------------------------------------------------------

/** The refusal-honesty verdict. */
export interface RefusalHonestyVerdict {
  /** The refusal is mechanically justified by the recorded structure. */
  readonly honest: boolean;
  readonly reason: RefusalReason | null;
  readonly justified: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the refusal honesty (PURE): a refusal is honest only when
 * the recorded structure GENUINELY justifies it — `varying-population`
 * only when the declared deterministicization question meets a varying
 * workload, `no-dispatched-work` only when the population holds no
 * dispatched model work, `no-learnable-structure` only when the
 * declared kind's signal is empty. A refusal that hides learnable
 * structure (the signal fires but the discovery refuses anyway) FAILs
 * just as an invented proposal does — and a proposal accompanied by a
 * refusal (or vice versa) is a malformed outcome that FAILs.
 */
export function deriveRefusalHonesty(input: {
  /** The declared candidate kind the discovery question targets. */
  readonly candidateKind: CandidateKind;
  /** The miner's refusal under test (null when a proposal was emitted). */
  readonly refusal: { readonly reason: RefusalReason } | null;
  /** Whether the miner emitted a proposal alongside the refusal under test. */
  readonly proposalEmitted: boolean;
  /** The structure the miner derived from the recorded population. */
  readonly structure: MinedLearnableStructure;
}): RefusalHonestyVerdict {
  const malformed = (input.refusal !== null) === input.proposalEmitted;
  let justified = false;
  let basis = "";
  if (input.refusal === null) {
    justified = !input.proposalEmitted;
    basis = "no-refusal-to-judge (the discovery emitted a proposal)";
  } else {
    switch (input.refusal.reason) {
      case "varying-population":
        justified =
          input.candidateKind === "deterministicization" &&
          input.structure.varyingSegments.length > 0;
        basis = "the declared deterministicization question meets an honestly-varying population";
        break;
      case "no-dispatched-work":
        justified = input.structure.dispatchedObservations === 0;
        basis = "the recorded population holds no dispatched model work (a guard rejection)";
        break;
      case "no-learnable-structure":
        justified =
          kindSignalSizeOf(input.structure, input.candidateKind) === 0 &&
          input.structure.dispatchedObservations > 0 &&
          !(
            input.candidateKind === "deterministicization" &&
            input.structure.varyingSegments.length > 0
          );
        basis = "the recorded population holds no structure of the declared kind";
        break;
    }
  }
  const honest = !malformed && justified;

  return {
    honest,
    reason: input.refusal?.reason ?? null,
    justified,
    criteria: [
      {
        criterionId: "refusal-well-formed",
        strategy: "deterministic",
        status: malformed ? "FAIL" : "PASS",
        evidence: [
          `refusal:${input.refusal?.reason ?? "none"}`,
          `proposalEmitted:${String(input.proposalEmitted)}`,
          malformed
            ? "MALFORMED-OUTCOME (a refusal and a proposal are mutually exclusive)"
            : "the-outcome-is-either-a-proposal-or-a-refusal",
        ],
      },
      {
        criterionId: "refusal-justified",
        strategy: "deterministic",
        status: justified ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal?.reason ?? "none"}`,
          `candidateKind:${input.candidateKind}`,
          `declaredSignalSize:${kindSignalSizeOf(input.structure, input.candidateKind)}`,
          `varyingSegments:${input.structure.varyingSegments.length}`,
          `dispatchedObservations:${input.structure.dispatchedObservations}`,
          justified
            ? `justified (${basis})`
            : "UNJUSTIFIED-REFUSAL (the recorded structure supports the declared kind — hiding learnable structure FAILs)",
        ],
      },
      {
        criterionId: "refusal-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `wellFormed:${String(!malformed)}`,
          `justified:${String(justified)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The honest discovery outcome (the PURE mining oracle)
// ---------------------------------------------------------------------------

/** The miner's outcome: the mined structure plus the proposal or the honest refusal. */
export interface DiscoveryMiningOutcome {
  readonly structure: MinedLearnableStructure;
  readonly proposal: DiscoveryProposalRecord | null;
  readonly refusal: { readonly reason: RefusalReason } | null;
}

/**
 * Derive the HONEST discovery outcome for one declared candidate kind
 * over one recorded population (PURE — the reference miner): the
 * structure is mined mechanically, the conservative guards run in
 * order (no dispatched work ⇒ nothing to learn from a guard-rejected
 * population; a varying population ⇒ never a deterministicization
 * candidate), an empty declared-kind signal ⇒ an honest refusal, and
 * otherwise the proposal cites the FULL population with the mined
 * structure digest at the `proposed` lifecycle stage.
 */
export function deriveHonestDiscoveryOutcome(input: {
  readonly candidateKind: CandidateKind;
  readonly population: readonly RecordedReplayObservation[];
}): DiscoveryMiningOutcome {
  const structure = mineLearnableStructureOf(input.population);

  if (structure.dispatchedObservations === 0) {
    return { structure, proposal: null, refusal: { reason: "no-dispatched-work" } };
  }
  if (input.candidateKind === "deterministicization" && structure.varyingSegments.length > 0) {
    return { structure, proposal: null, refusal: { reason: "varying-population" } };
  }
  if (kindSignalSizeOf(structure, input.candidateKind) === 0) {
    return { structure, proposal: null, refusal: { reason: "no-learnable-structure" } };
  }

  const basis = {
    kind: input.candidateKind,
    citation: canonicalCitationOf(input.population),
    minedStructureDigest: structure.digest,
    lifecycleStage: PROPOSAL_LIFECYCLE_STAGE,
  };
  return {
    structure,
    proposal: { ...basis, proposalId: proposalIdentityIdOf(basis) },
    refusal: null,
  };
}

// ---------------------------------------------------------------------------
// The discovery-driver seam (the read-only ledger input + the candidate registry)
// ---------------------------------------------------------------------------

/**
 * The replay-ledger input's own facts (the frozen-input snapshot
 * basis): every recorded population's canonical digest plus the frozen
 * baseline registry's digest — the read-only world the discovery runs
 * against (VAL-031's ledger and VAL-030's manifests are never
 * rewritten by a discovery).
 */
export interface ReplayLedgerInputFacts {
  readonly populations: readonly {
    readonly rowId: string;
    readonly populationDigest: string;
  }[];
  /** The digest over the frozen baseline registry's committed manifests. */
  readonly baselineRegistryDigest: string;
}

/** The replay-ledger input port: the READ-ONLY recorded populations. */
export interface ReplayLedgerInputPort {
  /** Serve one discovery row's recorded population (read-only). */
  populationFor(row: LearningDiscoveryCorpusRow): readonly RecordedReplayObservation[];
  /** The ledger's own facts (the frozen-input snapshot basis). */
  facts(): ReplayLedgerInputFacts;
}

/**
 * The canonical digest over the replay-ledger input's facts (PURE —
 * the frozen-input fingerprint the no-application discipline snapshots
 * before and after every discovery run).
 */
export function replayLedgerInputDigestOf(facts: ReplayLedgerInputFacts): string {
  return longitudinalDigestOf([
    "replay-ledger-input",
    facts.populations.map((population) => [population.rowId, population.populationDigest]),
    facts.baselineRegistryDigest,
  ]);
}

/**
 * The candidate-registry port (the deterministicization lifecycle's
 * registry — the VAL-004/005 candidate grammar): proposals land as
 * lifecycle candidates at the `proposed` stage. The registry is
 * APPEND-ONLY: a duplicate proposalId with IDENTICAL content REPLAYS
 * (idempotent); a DIFFERENT proposal under an already-recorded id is
 * REFUSED. Recording a proposal is NOT an application — promoting one
 * is, and a registry that mutates frozen state or records past
 * `proposed` FAILs the discovery mechanically.
 */
export interface CandidateRegistryPort {
  propose(
    record: DiscoveryProposalRecord,
  ): Promise<{ readonly accepted: boolean; readonly replayed: boolean; readonly refused: boolean }>;
  facts(): CandidateRegistryFacts;
}

/**
 * The discovery miner port (the seam the real mining engine binds at
 * the crown): reads one row's recorded population and returns the
 * mined structure plus the proposal it generalizes to (or the honest
 * refusal). The platform's PURE `deriveHonestDiscoveryOutcome` is the
 * reference implementation; the deterministic fixtures pin the
 * adversarial variants (uncited, partial, fabricated, smoothing).
 */
export interface DiscoveryMinerPort {
  mine(input: {
    readonly rowId: string;
    readonly candidateKind: CandidateKind;
    readonly population: readonly RecordedReplayObservation[];
  }): DiscoveryMiningOutcome;
}

// ---------------------------------------------------------------------------
// The corpus-row contract (the discovery oracle)
// ---------------------------------------------------------------------------

/**
 * The learning-discovery corpus row (the full oracle — AC1's per-row
 * contract): the VAL-031 replay populations this row mines (read-only
 * references), the recorded evidence population (trajectory digests +
 * replay identities — VAL-031's ledger vocabulary, digests only), the
 * candidate kind the discovery question targets, and the expected
 * proposal the discovery derivation must emit (or the honest refusal
 * it must report).
 */
export interface LearningDiscoveryCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-031 replay populations this row mines (read-only ledger references). */
  readonly replayPopulationRefs: readonly string[];
  /** The recorded evidence population (the read-only mining basis — digests only). */
  readonly population: readonly RecordedReplayObservation[];
  /** The candidate kind the discovery question targets (reuse/cache/competence/deterministicization). */
  readonly candidateKind: CandidateKind;
  /** The expected outcome (the oracle proper). */
  readonly expected: {
    /** Whether the discovery must emit a proposal for this row. */
    readonly emitsProposal: boolean;
    /** The expected proposal kind (null on an honest refusal). */
    readonly kind: CandidateKind | null;
    /** The expected refusal reason (null when a proposal is emitted). */
    readonly refusalReason: RefusalReason | null;
    /** The expected mined-structure digest the proposal must cite. */
    readonly minedStructureDigest: string | null;
    /** The discovery run's own dispatch demand (0 offline; the live row's confirmation round). */
    readonly modelCalls: number;
    /** The discovery run's honest terminal (an honest refusal is a COMPLETED discovery). */
    readonly terminal: "COMPLETED" | "FAILED";
  };
  /** The pinned discovery-trajectory class (the app's re-derivation target). */
  readonly expectedTrajectoryClass: readonly string[];
  /** The discovery-probe vocabulary (the phase-2 discrimination hooks). */
  readonly probe?: { readonly kind: DiscoveryProbeKind };
  /** Whether the discovery run demands a REAL model confirmation dispatch (the live row). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}

// ---------------------------------------------------------------------------
// The discovery trajectory (the app's re-derivation basis)
// ---------------------------------------------------------------------------

/**
 * The canonical discovery-run trajectory (PURE): the steps ONE
 * discovery run records — the live row's REAL confirmation round
 * (dispatch), the read-only population read, the structure mining,
 * the citation derivation, the mechanical verification and the
 * registry recording (or the honest refusal). The app re-derives this
 * trajectory's digest over the PUBLIC step-event journal — never
 * trusting the platform's claim.
 */
export function discoveryTrajectoryStepsOf(input: {
  readonly populationDigest: string;
  readonly minedStructureDigest: string;
  readonly proposal: DiscoveryProposalRecord | null;
  readonly refusalReason: RefusalReason | null;
  /** The discovery run's own REAL confirmation dispatches (the live row). */
  readonly confirmationRounds: number;
}): TrajectoryStepRecord[] {
  const steps: TrajectoryStepRecord[] = [];
  for (let round = 1; round <= input.confirmationRounds; round += 1) {
    steps.push({
      ordinal: steps.length + 1,
      kind: "dispatch",
      detail: `confirmation-round-${round}`,
      digest: longitudinalDigestOf(["dispatch", "confirmation", round, "fresh"]),
    });
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "effect",
    detail: "population-read",
    digest: input.populationDigest,
  });
  steps.push({
    ordinal: steps.length + 1,
    kind: "effect",
    detail: "structure-mined",
    digest: input.minedStructureDigest,
  });
  if (input.proposal !== null) {
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "citation-derived",
      digest: longitudinalDigestOf([
        "citation",
        input.proposal.citation.trajectoryDigests,
        input.proposal.citation.replayIdentities,
      ]),
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "verification",
      detail: "proposal-verified",
      digest: longitudinalDigestOf([
        "proposal-verified",
        input.proposal.kind,
        input.proposal.proposalId,
      ]),
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "registry-recorded",
      digest: longitudinalDigestOf(["registry-recorded", input.proposal.proposalId]),
    });
  } else {
    steps.push({
      ordinal: steps.length + 1,
      kind: "verification",
      detail: "refusal-recorded",
      digest: longitudinalDigestOf(["refusal-recorded", input.refusalReason ?? "none"]),
    });
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "verification",
    detail: "criteria-recorded",
    digest: longitudinalDigestOf([
      "criteria-recorded",
      input.proposal?.kind ?? "refusal",
      input.populationDigest,
    ]),
  });
  return steps;
}

// ---------------------------------------------------------------------------
// The discovery driver
// ---------------------------------------------------------------------------

/** The full discovery-run result (the honest contract). */
export interface LearningDiscoveryResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly structure: MinedLearnableStructure;
  readonly proposal: DiscoveryProposalRecord | null;
  readonly refusal: { readonly reason: RefusalReason } | null;
  readonly citation: EvidenceCitationCompletenessVerdict | null;
  readonly fidelity: CandidateKindFidelityVerdict | null;
  readonly conservatism: ConservatismVerdict;
  readonly refusalHonesty: RefusalHonestyVerdict | null;
  readonly noApplication: NoApplicationVerdict;
  /** The registry recording receipt (null when nothing was recorded). */
  readonly registryRecording: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly observedModelCalls: number;
  /** The discovery run's measured usage (the live row; null offline). */
  readonly usage: LabUsage | null;
  /** The discovery run's measured latency (ms). */
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * Drive ONE discovery corpus row through the platform path: read the
 * row's recorded population from the READ-ONLY replay-ledger input
 * (the served population must match the row's pin — the recorded
 * populations are never rewritten), mine the learnable structure
 * through the miner seam, mechanically verify the mined outcome (the
 * evidence-citation completeness, the candidate-kind fidelity, the
 * conservatism and — on a refusal — the refusal honesty), record the
 * VERIFIED proposal into the candidate registry (a proposal that
 * FAILs any verification leg is NEVER proposed — the catch is named),
 * and snapshot the frozen inputs before and after so the
 * no-application discipline proves the discovery mutated nothing.
 *
 * The live row additionally drives ONE REAL confirmation dispatch
 * through the dispatch seam (env-gated, measured — never fabricated);
 * an offline discovery dispatches no model at all.
 */
export async function driveLearningDiscovery(options: {
  readonly row: LearningDiscoveryCorpusRow;
  /** The READ-ONLY replay-ledger input (VAL-031's recorded populations). */
  readonly ledgerInput: ReplayLedgerInputPort;
  /** The mining seam (the reference miner is PURE). */
  readonly miner: DiscoveryMinerPort;
  /** The deterministicization lifecycle's candidate registry. */
  readonly registry: CandidateRegistryPort;
  /** The dispatch seam (the live row's REAL confirmation round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<LearningDiscoveryResult> {
  const { row } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL confirmation round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const startedAt = options.now().getTime();

  // ---- the read-only population read (the served population must be the pin) ----
  const population = options.ledgerInput.populationFor(row);
  const servedAsPinned =
    recordedPopulationDigestOf(population) === recordedPopulationDigestOf(row.population);

  // ---- the frozen-input snapshot BEFORE the run ----
  const beforeFrozenDigest = replayLedgerInputDigestOf(options.ledgerInput.facts());

  // ---- the mining seam (the structure + the proposal or the refusal) ----
  const mined = options.miner.mine({
    rowId: row.rowId,
    candidateKind: row.candidateKind,
    population,
  });

  // ---- the mechanical verification of the mined outcome ----
  let citation: EvidenceCitationCompletenessVerdict | null = null;
  let fidelity: CandidateKindFidelityVerdict | null = null;
  let refusalHonesty: RefusalHonestyVerdict | null = null;
  if (mined.proposal !== null) {
    citation = deriveEvidenceCitationCompleteness({
      population,
      citation: mined.proposal.citation,
    });
    fidelity = deriveCandidateKindFidelity({
      proposal: mined.proposal,
      structure: mined.structure,
    });
  } else {
    refusalHonesty = deriveRefusalHonesty({
      candidateKind: row.candidateKind,
      refusal: mined.refusal,
      proposalEmitted: false,
      structure: mined.structure,
    });
  }
  const conservatism = deriveConservatism({
    proposal: mined.proposal,
    structure: mined.structure,
  });
  const proposalVerified =
    citation?.complete === true && fidelity?.faithful === true && conservatism.conservative;
  const outcomeWellFormed = (mined.proposal !== null) !== (mined.refusal !== null);

  // ---- the registry recording (ONLY a verified proposal is ever proposed) ----
  let registryRecording: { accepted: boolean; replayed: boolean } | null = null;
  if (mined.proposal !== null && proposalVerified) {
    const receipt = await options.registry.propose(mined.proposal);
    registryRecording = { accepted: receipt.accepted, replayed: receipt.replayed };
  }

  // ---- the frozen-input snapshot AFTER the run (the no-application proof) ----
  const afterFrozenDigest = replayLedgerInputDigestOf(options.ledgerInput.facts());
  const noApplication = deriveNoApplication({
    beforeFrozenDigest,
    afterFrozenDigest,
    proposal: mined.proposal,
    registryFacts: options.registry.facts(),
  });

  // ---- the live row's REAL confirmation round (measured, never fabricated) ----
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;
  let observedModelCalls = 0;
  if (row.needsDispatch && options.dispatch !== undefined) {
    for (let round = 1; round <= row.expected.modelCalls; round += 1) {
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ round, attempt });
        if (outcome.kind === "success") {
          observedModelCalls += 1;
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
        if (!retryable || attempt > retry.maxExtraAttempts) {
          failure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await retry.sleep(retry.backoffMs);
      }
      if (failure !== null) {
        break;
      }
    }
  }

  // ---- the row-level mechanical criteria ----
  const criteria = deriveLearningDiscoveryRowCriteria({
    row,
    servedAsPinned,
    population,
    mined,
    citation,
    fidelity,
    conservatism,
    refusalHonesty,
    noApplication,
    registryRecording,
    outcomeWellFormed,
    observedModelCalls,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    !outcomeWellFormed;

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    structure: mined.structure,
    proposal: mined.proposal,
    refusal: mined.refusal,
    citation,
    fidelity,
    conservatism,
    refusalHonesty,
    noApplication,
    registryRecording,
    observedModelCalls,
    usage,
    latencyMs: options.now().getTime() - startedAt,
    failure,
  };
}

/**
 * Derive the row-level mechanical criteria (PURE): the read-only
 * population pin leg (the ledger input served the row's recorded
 * population exactly), the citation-completeness / kind-fidelity /
 * conservatism legs (on a proposal), the refusal-honesty leg (on a
 * refusal), the registry landing (the proposal is recorded at the
 * `proposed` stage under the derived identity), the no-application
 * legs, the expected-outcome contract (the emitted kind or the
 * refusal reason matches the row's pin), the payload-free digest
 * discipline and the honest accounting (usage measured on the live
 * rail, honestly none offline; latency always measured).
 */
export function deriveLearningDiscoveryRowCriteria(input: {
  readonly row: LearningDiscoveryCorpusRow;
  /** Whether the ledger input served the row's pinned population exactly. */
  readonly servedAsPinned: boolean;
  readonly population: readonly RecordedReplayObservation[];
  readonly mined: DiscoveryMiningOutcome;
  readonly citation: EvidenceCitationCompletenessVerdict | null;
  readonly fidelity: CandidateKindFidelityVerdict | null;
  readonly conservatism: ConservatismVerdict;
  readonly refusalHonesty: RefusalHonestyVerdict | null;
  readonly noApplication: NoApplicationVerdict;
  readonly registryRecording: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly outcomeWellFormed: boolean;
  readonly observedModelCalls: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row, mined } = input;

  // 1. The read-only population pin (the ledger input is the read-only input).
  criteria.push({
    criterionId: "population-served-as-pinned",
    strategy: "deterministic",
    status: input.servedAsPinned ? "PASS" : "FAIL",
    evidence: [
      `row:${row.rowId}`,
      `populationRefs:${row.replayPopulationRefs.join(",")}`,
      `populationSize:${input.population.length}`,
      input.servedAsPinned
        ? "served-as-pinned (the recorded population is the read-only input — never rewritten)"
        : "POPULATION-MISMATCH (the ledger input served a population the row does not pin)",
    ],
  });

  // 2-3. The citation + fidelity legs (on a proposal).
  if (input.citation !== null) {
    criteria.push(...input.citation.criteria);
  }
  if (input.fidelity !== null) {
    criteria.push(...input.fidelity.criteria);
  }

  // 4. The conservatism legs.
  criteria.push(...input.conservatism.criteria);

  // 5. The refusal-honesty legs (on a refusal).
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // 6. The registry landing (the proposal lands as a lifecycle candidate).
  const registryLanded = mined.proposal === null ? true : input.registryRecording?.accepted;
  criteria.push({
    criterionId: "registry-landing",
    strategy: "deterministic",
    status: registryLanded ? "PASS" : "FAIL",
    evidence: [
      `proposal:${mined.proposal?.proposalId ?? "none (an honest refusal)"}`,
      `lifecycleStage:${mined.proposal?.lifecycleStage ?? "none"}`,
      `accepted:${String(input.registryRecording?.accepted ?? false)}`,
      `replayed:${String(input.registryRecording?.replayed ?? false)}`,
      registryLanded
        ? "proposal-landed-as-lifecycle-candidate (the VAL-004/005 candidate grammar)"
        : "NOT-RECORDED (a verified proposal never landed in the candidate registry)",
    ],
  });

  // 7. The no-application legs.
  criteria.push(...input.noApplication.criteria);

  // 8. The expected-outcome contract (the emitted kind / the refusal reason).
  const expectedKind = row.expected.kind;
  const expectedRefusal = row.expected.refusalReason;
  const outcomeMatches = row.expected.emitsProposal
    ? mined.proposal !== null &&
      mined.proposal.kind === expectedKind &&
      mined.refusal === null &&
      mined.proposal.minedStructureDigest === row.expected.minedStructureDigest
    : mined.proposal === null && mined.refusal !== null && mined.refusal.reason === expectedRefusal;
  criteria.push({
    criterionId: "discovery-outcome-contract",
    strategy: "deterministic",
    status: outcomeMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedProposal:${String(row.expected.emitsProposal)}`,
      `expectedKind:${expectedKind ?? "none"}`,
      `expectedRefusal:${expectedRefusal ?? "none"}`,
      `observedKind:${mined.proposal?.kind ?? "none"}`,
      `observedRefusal:${mined.refusal?.reason ?? "none"}`,
      `expectedStructureDigest:${row.expected.minedStructureDigest ?? "none"}`,
      `observedStructureDigest:${mined.proposal?.minedStructureDigest ?? "none"}`,
      outcomeMatches
        ? "the-discovery-reproduces-the-pinned-outcome"
        : "OUTCOME-MISMATCH (the discovery outcome differs from the pinned oracle)",
    ],
  });

  // 9. The outcome well-formedness (a proposal XOR a refusal).
  criteria.push({
    criterionId: "discovery-outcome-well-formed",
    strategy: "deterministic",
    status: input.outcomeWellFormed ? "PASS" : "FAIL",
    evidence: [
      `proposal:${mined.proposal !== null ? "emitted" : "none"}`,
      `refusal:${mined.refusal !== null ? "reported" : "none"}`,
      input.outcomeWellFormed
        ? "exactly-one-outcome (a proposal or a refusal, never both, never neither)"
        : "MALFORMED-OUTCOME (the miner emitted both or neither)",
    ],
  });

  // 10. The payload-free digest discipline (every digest is 8-hex, never payload bytes).
  const digestsUnderTest = [
    ...(mined.proposal?.citation.trajectoryDigests ?? []),
    ...(mined.proposal?.citation.replayIdentities.map(
      (identity) => identity.split("-").pop() ?? "",
    ) ?? []),
    mined.proposal?.minedStructureDigest ?? "",
  ].filter((digest) => digest.length > 0);
  const digestsWellFormed = digestsUnderTest.every((digest) => /^[0-9a-f]{8}$/.test(digest));
  criteria.push({
    criterionId: "payload-free-digest-discipline",
    strategy: "deterministic",
    status: digestsWellFormed ? "PASS" : "FAIL",
    evidence: [
      `digests:${digestsUnderTest.length}`,
      digestsWellFormed
        ? "digests-only (payload bytes never enter the evidence)"
        : "MALFORMED-DIGEST (a cited digest is not a payload-free FNV-1a digest)",
    ],
  });

  // 11. The discovery run's own dispatch total (offline zero; the live row's confirmation).
  criteria.push({
    criterionId: "discovery-own-dispatch-total",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-discovery-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the discovery under- or over-dispatched)",
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side discovery contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/** One discovery run's app-side observation (the public-boundary read). */
export interface AppDiscoveryObservation {
  /** The durable execution the discovery submission landed. */
  readonly executionId: string;
  /** True when the submission key REPLAYED an existing execution (a shoulder-in). */
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The proposal read back from the public result read (null when refused). */
  readonly proposal: {
    readonly proposalId: string;
    readonly kind: string;
    readonly citation: ProposalEvidenceCitation;
    readonly minedStructureDigest: string;
    readonly lifecycleStage: string;
  } | null;
  /** The refusal read back from the public result read (null when a proposal was emitted). */
  readonly refusal: { readonly reason: string } | null;
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
}

/**
 * Judge the app-side observations against the row's discovery contract
 * (PURE): the submission landed its OWN durable execution, the
 * terminal↔criteria agreement and the expected terminal hold, the
 * read-back proposal matches the row's pinned oracle — the kind, the
 * mined-structure digest, the `proposed` lifecycle stage (an applied
 * proposal never passes) and the evidence-citation completeness
 * re-derived AT the boundary over the row's declared population (an
 * uncited, partial or fabricated citation never passes) — the
 * conservatism re-derived at the boundary (a variance-smoothing
 * proposal never passes), an honest refusal is reported with its
 * pinned reason and no proposal, the discovery made its OWN
 * dispatches, and the app-side trajectory digest over the public
 * events read is a member of the row's pinned discovery-trajectory
 * class.
 */
export function verifyLearningDiscoveryAppContract(input: {
  readonly row: LearningDiscoveryCorpusRow;
  readonly observation: AppDiscoveryObservation;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row, observation } = input;

  // 1. The submission landed its own durable execution.
  criteria.push({
    criterionId: "app-submission-landed",
    strategy: "deterministic",
    status: observation.rejection === null && observation.executionId !== "" ? "PASS" : "FAIL",
    evidence: [
      `executionId:${observation.executionId || "none"}`,
      `replayed:${String(observation.replayed)}`,
      `rejection:${observation.rejection?.code ?? "none"}`,
      observation.rejection === null && observation.executionId !== ""
        ? "the-discovery-submission-landed-its-own-execution"
        : "REJECTED (the discovery submission never landed a durable execution)",
    ],
  });

  // 2-3. The terminal agreement + the expected terminal.
  const agreement =
    observation.terminal !== null &&
    observation.verificationStatuses.length > 0 &&
    ((observation.terminal === "COMPLETED" &&
      observation.verificationStatuses.every((status) => status === "PASS")) ||
      (observation.terminal === "FAILED" && observation.verificationStatuses.includes("FAIL")));
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement ? "PASS" : "FAIL",
    evidence: [
      `terminal:${observation.terminal ?? "none"}`,
      `statuses:${observation.verificationStatuses.join(",") || "none"}`,
      agreement
        ? "the-terminal-agrees-with-the-criteria"
        : "DISAGREEMENT (the terminal contradicts the verification statuses)",
    ],
  });
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: observation.terminal === row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.terminal}`,
      `observed:${observation.terminal ?? "none"}`,
      `note:an honest refusal is a COMPLETED discovery, never a fabricated failure`,
    ],
  });

  // 4. The proposal legs (the row expects a proposal) or the refusal legs.
  if (row.expected.emitsProposal) {
    const emitted = observation.proposal !== null && observation.refusal === null;
    criteria.push({
      criterionId: "app-proposal-emitted",
      strategy: "deterministic",
      status: emitted ? "PASS" : "FAIL",
      evidence: [
        `expectedKind:${row.expected.kind ?? "none"}`,
        `observedKind:${observation.proposal?.kind ?? "none"}`,
        `refusal:${observation.refusal?.reason ?? "none"}`,
        emitted
          ? "the-discovery-emitted-its-pinned-proposal"
          : "MISSING-PROPOSAL (the pinned oracle demands a proposal — a hidden discovery FAILs)",
      ],
    });
    if (observation.proposal !== null) {
      criteria.push({
        criterionId: "app-proposal-kind-matches-pin",
        strategy: "deterministic",
        status: observation.proposal.kind === row.expected.kind ? "PASS" : "FAIL",
        evidence: [
          `expected:${row.expected.kind ?? "none"}`,
          `observed:${observation.proposal.kind}`,
          observation.proposal.kind === row.expected.kind
            ? "the-proposals-kind-matches-the-pin"
            : "KIND-MISMATCH (the proposal's kind differs from the pinned oracle)",
        ],
      });
      criteria.push({
        criterionId: "app-proposal-structure-digest-pinned",
        strategy: "deterministic",
        status:
          observation.proposal.minedStructureDigest === row.expected.minedStructureDigest
            ? "PASS"
            : "FAIL",
        evidence: [
          `expected:${row.expected.minedStructureDigest ?? "none"}`,
          `observed:${observation.proposal.minedStructureDigest}`,
          observation.proposal.minedStructureDigest === row.expected.minedStructureDigest
            ? "the-proposal-cites-the-pinned-mined-structure"
            : "STRUCTURE-MISMATCH (the proposal cites a structure the pin does not hold)",
        ],
      });
      // The evidence-citation completeness re-derived AT the boundary.
      const citation = deriveEvidenceCitationCompleteness({
        population: row.population,
        citation: observation.proposal.citation,
      });
      criteria.push(
        ...citation.criteria.map((criterion) => ({
          ...criterion,
          criterionId: `app-${criterion.criterionId}`,
        })),
      );
      // The conservatism re-derived AT the boundary (the app mines the
      // row's declared population itself — never trusting the claim).
      const structure = mineLearnableStructureOf(row.population);
      const conservatism = deriveConservatism({
        proposal: {
          proposalId: observation.proposal.proposalId,
          kind: isCandidateKind(observation.proposal.kind) ? observation.proposal.kind : "reuse",
          citation: observation.proposal.citation,
          minedStructureDigest: observation.proposal.minedStructureDigest,
          lifecycleStage: isCandidateLifecycleStage(observation.proposal.lifecycleStage)
            ? observation.proposal.lifecycleStage
            : PROPOSAL_LIFECYCLE_STAGE,
        },
        structure,
      });
      criteria.push(
        ...conservatism.criteria.map((criterion) => ({
          ...criterion,
          criterionId: `app-${criterion.criterionId}`,
        })),
      );
    }
  } else {
    const refused = observation.proposal === null && observation.refusal !== null;
    criteria.push({
      criterionId: "app-refusal-honest",
      strategy: "deterministic",
      status: refused ? "PASS" : "FAIL",
      evidence: [
        `expectedReason:${row.expected.refusalReason ?? "none"}`,
        `observedReason:${observation.refusal?.reason ?? "none"}`,
        `proposal:${observation.proposal?.kind ?? "none"}`,
        refused
          ? "the-discovery-refused-honestly (never a fabricated proposal)"
          : "FABRICATED-OUTCOME (the pinned oracle demands an honest refusal — a proposal never passes)",
      ],
    });
    if (observation.refusal !== null) {
      criteria.push({
        criterionId: "app-refusal-reason-pinned",
        strategy: "deterministic",
        status: observation.refusal.reason === row.expected.refusalReason ? "PASS" : "FAIL",
        evidence: [
          `expected:${row.expected.refusalReason ?? "none"}`,
          `observed:${observation.refusal.reason}`,
        ],
      });
    }
  }

  // 5. The proposal's lifecycle stage (never applied at the boundary).
  if (observation.proposal !== null) {
    const stageProposed = observation.proposal.lifecycleStage === PROPOSAL_LIFECYCLE_STAGE;
    criteria.push({
      criterionId: "app-proposal-lifecycle-proposed",
      strategy: "deterministic",
      status: stageProposed ? "PASS" : "FAIL",
      evidence: [
        `lifecycleStage:${observation.proposal.lifecycleStage}`,
        `proposedStage:${PROPOSAL_LIFECYCLE_STAGE}`,
        stageProposed
          ? "proposal-stage-only (the boundary read back a proposal, not an application)"
          : "APPLIED-PROPOSAL (the boundary read back an applied candidate — discovery never applies)",
      ],
    });
  }

  // 6. The discovery run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-discovery-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the discovery under- or over-dispatched)",
    ],
  });

  // 7. The app-side trajectory membership (never trust the platform's claim).
  const inClass =
    observation.trajectoryDigest !== null &&
    row.expectedTrajectoryClass.includes(observation.trajectoryDigest);
  criteria.push({
    criterionId: "app-discovery-trajectory-in-class",
    strategy: "deterministic",
    status: inClass ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${observation.trajectoryDigest ?? "none"}`,
      `classSize:${row.expectedTrajectoryClass.length}`,
      inClass
        ? "in-class (the app re-derived the discovery trajectory over the public journal)"
        : "OUT-OF-CLASS (the observed discovery trajectory drifted from the pinned class)",
    ],
  });

  return criteria;
}
