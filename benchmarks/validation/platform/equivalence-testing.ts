/**
 * The platform-side candidate equivalence-testing engine (VAL-033).
 *
 * The mechanical engine of the equivalence slice: it takes the
 * discovery's PROPOSALS (VAL-032's candidate registry entries — the
 * READ-ONLY input; a proposal is never rewritten), generates the
 * deterministic replacement as ISOLATED untrusted code (the granted
 * isolation surface is the ALLOWED capability set for untrusted
 * synthesized code — pure computation + granted fixture reads,
 * NOTHING else), drives the DIFFERENTIAL evaluation (the replacement
 * against the incumbent AI implementation over the representative
 * historical inputs — VAL-031's recorded replay populations, the
 * cited replay identities — plus the pinned adversarial cases), and
 * records the equivalence verdict with an EXPLICIT, mechanically
 * verified acceptance criterion.
 *
 * The equivalence oracle (the PURE derivations that make a verdict
 * trustworthy):
 *
 *   * `deriveReplacementIsolation` — the replacement's declared
 *     capability set vs its granted surface: an undeclared capability
 *     (network, platform state mutation, credential access, tenant
 *     boundary crossing) is a containment VIOLATION (FAIL); a
 *     within-surface exercise is contained;
 *   * `deriveDifferentialEquivalence` — the differential evaluation
 *     oracle: a case where the replacement diverges from its stated
 *     criterion FAILs (recorded as an honest divergence, never
 *     smoothed); a criterion that is stated but never checked (or
 *     checkable-but-unchecked) FAILs; equality is NOT required for
 *     semantic outputs but the criterion must be EXPLICIT and
 *     mechanically evaluated;
 *   * `deriveProvenanceCompleteness` — the verdict must cite its
 *     source proposal (the VAL-032 registry identity) AND the full
 *     differential population (the historical replay inputs + the
 *     pinned adversarial cases): a broken provenance chain (uncited
 *     proposal, phantom citation) FAILs and a PARTIAL population
 *     (missing adversarial cases or a subset of the cited replay
 *     identities) FAILs;
 *   * `deriveStageDiscipline` — the lifecycle append is
 *     `proposed → offline-replayed → differentially-evaluated` ONLY
 *     (the deterministicization contract's "equivalence-verified"
 *     stage mapped onto the pinned ladder): any jump past
 *     differentially-evaluated FAILs and a stage transition without
 *     its evidence FAILs;
 *   * `deriveEquivalenceRefusalHonesty` — an honest refusal (a
 *     proposal whose evidence does not support replacement) is
 *     justified only by the registry's own state.
 *
 * Standing rules (the contract this slice pins):
 *
 *   * the candidate registry's EXISTING entries are read-only inputs
 *     (VAL-030/031/032's registries and ledgers are never rewritten);
 *     the equivalence run APPENDS verdicts to the candidate lifecycle
 *     ledger — it never rewrites a proposal;
 *   * every verdict cites payload-free FNV-1a DIGESTS only (never
 *     payload bytes);
 *   * the offline rows dispatch no model at all (usage honestly
 *     none-reported offline); the live row's residual-AI confirmation
 *     round is REAL, measured, env-gated — never fabricated;
 *   * latency is always measured.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type {
  CandidateLifecycleStage,
  DiscoveryProposalRecord,
  ProposalEvidenceCitation,
} from "./learning-discovery";
import { CANDIDATE_LIFECYCLE_STAGES } from "./learning-discovery";
import type { ControlDispatch, TrajectoryStepRecord } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The equivalence vocabulary (the replacement grammar)
// ---------------------------------------------------------------------------

/**
 * The equivalence phase's learning mode: equivalence TESTS and RECORDS
 * — it generates the isolated replacement, drives the differential
 * evaluation and appends the verdict; it never promotes (shadow,
 * canary and promotion are VAL-034/035's scope).
 */
export const EQUIVALENCE_LEARNING_PHASE = "equivalence" as const;

/** The longitudinal-experiment kind every equivalence run registers as. */
export const EQUIVALENCE_EXPERIMENT_KIND = "equivalence-testing";

/**
 * The replacement-shape vocabulary (the deterministicization
 * contract's candidate classes — the shapes a synthesized
 * deterministic replacement may take):
 *
 *   * `deterministic-function` — the whole segment is a pure function
 *     of its inputs (an exact-digest reproduction);
 *   * `retrieval-pipeline` — the segment becomes a lookup: the stable
 *     input→output transformation is served from the granted fixture
 *     store (a cache-shaped replacement);
 *   * `split-preprocessing-residual` — the deterministic
 *     preprocessing is split off and only the residual AI leg remains
 *     (the live row's shape — its residual leg demands a REAL model
 *     round);
 *   * `reusable-tool` — the repeated routine becomes a reusable tool
 *     invoked in place of the incumbent sub-trajectory;
 *   * `removed-call` — the segment's call is removed entirely (the
 *     incumbent's redundant call disappears — the outcome digest
 *     changes by construction).
 */
export const REPLACEMENT_SHAPES = [
  "deterministic-function",
  "retrieval-pipeline",
  "split-preprocessing-residual",
  "reusable-tool",
  "removed-call",
] as const;

export type ReplacementShape = (typeof REPLACEMENT_SHAPES)[number];

export function isReplacementShape(value: string): value is ReplacementShape {
  return (REPLACEMENT_SHAPES as readonly string[]).includes(value);
}

/**
 * The granted isolation surface's ALLOWED capability set for
 * untrusted synthesized code: PURE computation plus reads of the
 * GRANTED fixtures — NOTHING else. Any other exercised capability is
 * an isolation escape (a containment violation).
 */
export const ISOLATION_CAPABILITIES = ["pure-computation", "granted-fixture-read"] as const;

export type IsolationCapability = (typeof ISOLATION_CAPABILITIES)[number];

export function isIsolationCapability(value: string): value is IsolationCapability {
  return (ISOLATION_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The isolation ESCAPE directions (the untrusted-code discipline's
 * forbidden surface): network access, platform state mutation,
 * credential access and tenant-boundary crossing. A replacement that
 * attempts ANY of these FAILs and is recorded as a containment
 * violation — never silently forgiven.
 */
export const ISOLATION_ESCAPE_DIRECTIONS = [
  "network-access",
  "platform-state-mutation",
  "credential-access",
  "tenant-boundary-crossing",
] as const;

export type IsolationEscapeDirection = (typeof ISOLATION_ESCAPE_DIRECTIONS)[number];

export function isIsolationEscapeDirection(value: string): value is IsolationEscapeDirection {
  return (ISOLATION_ESCAPE_DIRECTIONS as readonly string[]).includes(value);
}

/** The containment verdicts (isolated untrusted code is either contained or in violation). */
export const CONTAINMENT_VERDICTS = ["contained", "violation"] as const;

export type ContainmentVerdict = (typeof CONTAINMENT_VERDICTS)[number];

/**
 * The acceptance-criterion vocabulary (the EXPLICIT criterion every
 * differential evaluation must state and mechanically evaluate —
 * equality is NOT required for semantic outputs, but the criterion
 * must be explicit and checked):
 *
 *   * `exact-digest-equality` — the replacement's outcome digest must
 *     equal the incumbent's on every case;
 *   * `digest-class-equality` — the replacement's outcome digest must
 *     be a member of the case's pinned digest class (the honest
 *     form of "semantically equivalent" — either equivalent ordering
 *     passes);
 *   * `per-case-tolerance` — the per-case divergences the criterion
 *     EXPLICITLY tolerates (a declared tolerated-case set; a
 *     divergent case outside the set FAILs).
 */
export const ACCEPTANCE_CRITERION_KINDS = [
  "exact-digest-equality",
  "digest-class-equality",
  "per-case-tolerance",
] as const;

export type AcceptanceCriterionKind = (typeof ACCEPTANCE_CRITERION_KINDS)[number];

export function isAcceptanceCriterionKind(value: string): value is AcceptanceCriterionKind {
  return (ACCEPTANCE_CRITERION_KINDS as readonly string[]).includes(value);
}

/** The explicit acceptance criterion (stated up front, mechanically evaluated). */
export interface AcceptanceCriterion {
  readonly kind: AcceptanceCriterionKind;
  /**
   * The per-case tolerance declaration (only meaningful for
   * `per-case-tolerance`): the case ids whose divergences the
   * criterion explicitly tolerates. A divergent case outside the set
   * FAILs; a tolerated id that is not a member of the differential
   * population is a malformed criterion.
   */
  readonly toleratedCaseIds?: readonly string[];
}

/**
 * The equivalence verdict kinds (the per-row outcome vocabulary):
 *
 *   * `equivalence-pass` — the replacement satisfied its explicit
 *     criterion over the full differential population;
 *   * `honest-divergence` — a differential case diverged from the
 *     stated criterion and the divergence is RECORDED (never
 *     smoothed) — the row FAILs honestly;
 *   * `containment-violation` — the replacement attempted to escape
 *     its granted isolation surface;
 *   * `honest-refusal` — the proposal's own evidence does not support
 *     replacement (unregistered, un-proposed or insufficient) and the
 *     run refused honestly.
 *   * `evaluation-invalid` — the verdict's mechanical shape is
 *     untrustworthy (broken provenance, an unchecked criterion, a
 *     smoothed divergence, a broken stage walk): an internal honesty
 *     failure, never a passable outcome.
 */
export const EQUIVALENCE_VERDICTS = [
  "equivalence-pass",
  "honest-divergence",
  "containment-violation",
  "honest-refusal",
  "evaluation-invalid",
] as const;

export type EquivalenceVerdictKind = (typeof EQUIVALENCE_VERDICTS)[number];

export function isEquivalenceVerdictKind(value: string): value is EquivalenceVerdictKind {
  return (EQUIVALENCE_VERDICTS as readonly string[]).includes(value);
}

/**
 * The honest refusal reasons (an equivalence run refuses only when
 * the registry's own state genuinely justifies it — the proposal's
 * evidence does not support replacement):
 *
 *   * `proposal-unregistered` — the cited proposal identity is not a
 *     member of the candidate registry (a phantom proposal);
 *   * `proposal-stage-not-proposed` — the registry entry has not yet
 *     reached the `proposed` stage (an observed/characterized
 *     candidate is not testable — it is not yet a proposal);
 *   * `proposal-evidence-insufficient` — the proposal's own evidence
 *     citation is too thin to test a replacement against (a single
 *     replay is an anecdote, not a population).
 */
export const EQUIVALENCE_REFUSAL_REASONS = [
  "proposal-unregistered",
  "proposal-stage-not-proposed",
  "proposal-evidence-insufficient",
] as const;

export type EquivalenceRefusalReason = (typeof EQUIVALENCE_REFUSAL_REASONS)[number];

export function isEquivalenceRefusalReason(value: string): value is EquivalenceRefusalReason {
  return (EQUIVALENCE_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The equivalence-probe kinds the corpus declares (the vocabulary the
 * later discrimination phases drive over the adversarial fixture
 * variants — designed here, pinned now):
 *
 *   * `broken-provenance` — the verdict's proposal citation is
 *     uncited or phantom (a broken provenance chain FAILs);
 *   * `partial-population` — the differential population covers only
 *     part of the cited evidence (FAILs);
 *   * `unchecked-criterion` — the acceptance criterion is stated but
 *     never checked (FAILs);
 *   * `divergence-smoothing` — a divergent case is claimed equivalent
 *     (a smoothed divergence FAILs);
 *   * `skipped-stage` — the lifecycle append jumps past the
 *     differentially-evaluated stage (or skips a stage / lands
 *     evidence-less) (FAILs);
 *   * `containment-escape` — the replacement exercises a capability
 *     outside its granted surface (a containment violation FAILs).
 */
export const EQUIVALENCE_PROBE_KINDS = [
  "broken-provenance",
  "partial-population",
  "unchecked-criterion",
  "divergence-smoothing",
  "skipped-stage",
  "containment-escape",
] as const;

export type EquivalenceProbeKind = (typeof EQUIVALENCE_PROBE_KINDS)[number];

export function isEquivalenceProbeKind(value: string): value is EquivalenceProbeKind {
  return (EQUIVALENCE_PROBE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The lifecycle ladder (the equivalence slice's walk)
// ---------------------------------------------------------------------------

/**
 * The lifecycle stage an equivalence verdict lands a proposal at: the
 * deterministicization contract's "equivalence-verified" stage mapped
 * onto the pinned candidate ladder. The walk is
 * `proposed → offline-replayed → differentially-evaluated` — NEVER
 * beyond (property-tested/mutation-tested/shadow-executed/canaried/
 * promoted are later slices' acts; a skipped-stage advance FAILs
 * mechanically).
 */
export const EQUIVALENT_STAGE: CandidateLifecycleStage = "differentially-evaluated";

/** The FIRST stage transition the equivalence slice appends (the offline replay). */
export const OFFLINE_REPLAY_STAGE: CandidateLifecycleStage = "offline-replayed";

/** The ONLY lifecycle stage an equivalence run may advance FROM. */
export const EQUIVALENCE_SOURCE_STAGE: CandidateLifecycleStage = "proposed";

/** The ladder index of a stage (its position on the pinned candidate ladder). */
export function lifecycleStageIndexOf(stage: CandidateLifecycleStage): number {
  return (CANDIDATE_LIFECYCLE_STAGES as readonly string[]).indexOf(stage);
}

/**
 * Whether a lifecycle stage is BEYOND the equivalence slice's scope
 * (any stage past `differentially-evaluated` on the pinned ladder —
 * property/mutation testing, shadow execution, canary, promotion). An
 * equivalence run that advances a proposal to any of these FAILs the
 * stage discipline mechanically (a skipped-stage promotion).
 */
export function isBeyondEquivalenceScope(stage: CandidateLifecycleStage): boolean {
  return lifecycleStageIndexOf(stage) > lifecycleStageIndexOf(EQUIVALENT_STAGE);
}

// ---------------------------------------------------------------------------
// The differential case vocabulary (the population under test)
// ---------------------------------------------------------------------------

/**
 * ONE differential case — the unit of the differential population:
 * either a historical replay input (a cited VAL-031 replay identity
 * with its recorded incumbent outcome digest) or a pinned adversarial
 * case (with its pinned incumbent digest and its pinned digest
 * class). Every field is a digest or an identity — payload bytes
 * never enter the differential basis.
 */
export interface DifferentialCase {
  /** The case identity (the cited replay identity, or the adversarial pin id). */
  readonly caseId: string;
  /** The case's source: a historical replay input or a pinned adversarial case. */
  readonly source: "historical-replay" | "adversarial";
  /**
   * The source reference: the VAL-031 replay identity (historical) or
   * the adversarial pin id (the corpus's declared adversarial case).
   */
  readonly sourceRef: string;
  /** The case's input digest (the workload-input digest the case rides). */
  readonly inputDigest: string;
  /** The pinned incumbent outcome digest (the recorded / pinned incumbent result). */
  readonly incumbentDigest: string;
  /**
   * The case's pinned digest class (the honest set of digests the
   * incumbent's semantics admits for this input — a single member
   * for deterministic segments, both equivalent members for
   * legitimately-varying ones).
   */
  readonly classDigests: readonly string[];
}

/**
 * The canonical digest over one differential case (PURE — FNV-1a over
 * the case's identity + input + incumbent digest + class, payload-free).
 */
export function differentialCaseDigestOf(dcase: DifferentialCase): string {
  return longitudinalDigestOf([
    "differential-case",
    dcase.caseId,
    dcase.source,
    dcase.inputDigest,
    dcase.incumbentDigest,
    [...dcase.classDigests].sort(),
  ]);
}

/** The canonical digest over a differential population (PURE, payload-free). */
export function differentialPopulationDigestOf(population: readonly DifferentialCase[]): string {
  return longitudinalDigestOf(
    [...population]
      .map((dcase) => differentialCaseDigestOf(dcase))
      .sort((l, r) => l.localeCompare(r)),
  );
}

/**
 * The canonical digest over a stage-transition's evidence basis (PURE
 * — FNV-1a over the proposal + the evidence members, payload-free):
 * the digest every lifecycle append must carry as its
 * `evidenceDigest` (a transition without evidence FAILs).
 */
export function lifecycleEvidenceDigestOf(input: {
  readonly proposalId: string;
  readonly stage: CandidateLifecycleStage;
  readonly members: readonly string[];
}): string {
  return longitudinalDigestOf(["lifecycle-evidence", input.proposalId, input.stage, input.members]);
}

// ---------------------------------------------------------------------------
// The reference replacement outcome (the deterministic reference)
// ---------------------------------------------------------------------------

/**
 * The selector index of a digest modulo the class size (PURE — the
 * deterministic member selector the reference replacement shapes use;
 * a pure function of payload-free digests).
 */
function digestSelectorIndexOf(basis: string, classSize: number): number {
  if (classSize <= 1) {
    return 0;
  }
  return Number.parseInt(longitudinalDigestOf(["selector", basis]), 16) % classSize;
}

/**
 * The REFERENCE replacement outcome digest for one differential case
 * (PURE — the deterministic reference implementation every honest
 * replacement runtime must reproduce): the shape's deterministic
 * member of the case's pinned digest class.
 *
 *   * `deterministic-function` — the class's canonical member (the
 *     exact reproduction of a deterministic incumbent);
 *   * `retrieval-pipeline` — the member the input digest selects (the
 *     lookup's deterministic answer);
 *   * `split-preprocessing-residual` — the member the case identity
 *     selects (the split preprocessing's deterministic answer);
 *   * `reusable-tool` — the member the case+input basis selects (the
 *     tool's deterministic answer);
 *   * `removed-call` — a NOVEL digest (the incumbent's redundant call
 *     is gone: the trajectory digest changes by construction).
 */
export function referenceReplacementOutcomeDigestOf(input: {
  readonly shape: ReplacementShape;
  readonly caseId: string;
  readonly inputDigest: string;
  readonly classDigests: readonly string[];
}): string {
  const sorted = [...new Set(input.classDigests)].sort();
  if (sorted.length === 0) {
    return longitudinalDigestOf(["replacement-empty-class", input.shape, input.caseId]);
  }
  const pick = (index: number): string => sorted[index] ?? sorted[0] ?? "";
  switch (input.shape) {
    case "deterministic-function":
      return pick(0);
    case "retrieval-pipeline":
      return pick(digestSelectorIndexOf(input.inputDigest, sorted.length));
    case "split-preprocessing-residual":
      return pick(digestSelectorIndexOf(input.caseId, sorted.length));
    case "reusable-tool":
      return pick(digestSelectorIndexOf(`${input.caseId}|${input.inputDigest}`, sorted.length));
    case "removed-call":
      return longitudinalDigestOf(["replacement-removed-call", input.caseId, input.inputDigest]);
  }
}

// ---------------------------------------------------------------------------
// Replacement isolation (the untrusted-code discipline)
// ---------------------------------------------------------------------------

/** The replacement-isolation verdict. */
export interface ReplacementIsolationVerdict {
  /** The replacement stayed within its granted surface (and its declaration). */
  readonly contained: boolean;
  /** The containment verdict (`contained` or `violation`). */
  readonly containment: ContainmentVerdict;
  /** Capabilities the replacement DECLARED that the granted surface does not grant. */
  readonly declaredNotGranted: readonly string[];
  /** Capabilities the runtime EXERCISED that the replacement did not declare. */
  readonly undeclaredExercises: readonly string[];
  /** The exercised capabilities OUTSIDE the granted surface (the named escape directions). */
  readonly escapeDirections: readonly string[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the replacement isolation (PURE — the untrusted-code
 * discipline's oracle): the replacement's DECLARED capability set
 * must lie within its GRANTED surface (a demanded-but-ungranted
 * capability FAILs), and everything the runtime EXERCISED must be
 * both declared and granted — an undeclared or ungranted exercise is
 * a containment VIOLATION (FAIL): network access, platform state
 * mutation, credential access and tenant-boundary crossing are the
 * pinned escape directions, and each is recorded as a containment
 * violation — never silently forgiven. A within-surface,
 * within-declaration exercise is `contained`.
 */
export function deriveReplacementIsolation(input: {
  /** The replacement's declared capability set (what it says it needs). */
  readonly declaredCapabilities: readonly string[];
  /** The granted isolation surface (the ALLOWED capability set). */
  readonly grantedSurface: readonly string[];
  /** The capabilities the runtime OBSERVED the replacement exercising. */
  readonly exercisedCapabilities: readonly string[];
}): ReplacementIsolationVerdict {
  const declared = [...new Set(input.declaredCapabilities)];
  const granted = [...new Set(input.grantedSurface)];
  const exercised = [...new Set(input.exercisedCapabilities)];

  const declaredNotGranted = declared.filter((capability) => !granted.includes(capability));
  const undeclaredExercises = exercised.filter((capability) => !declared.includes(capability));
  const ungrantedExercises = exercised.filter((capability) => !granted.includes(capability));
  const escapeDirections = ungrantedExercises.filter((capability) =>
    (ISOLATION_ESCAPE_DIRECTIONS as readonly string[]).includes(capability),
  );
  const contained =
    declaredNotGranted.length === 0 &&
    undeclaredExercises.length === 0 &&
    ungrantedExercises.length === 0;
  const containment: ContainmentVerdict = contained ? "contained" : "violation";

  return {
    contained,
    containment,
    declaredNotGranted,
    undeclaredExercises,
    escapeDirections,
    criteria: [
      {
        criterionId: "isolation-declared-within-surface",
        strategy: "deterministic",
        status: declaredNotGranted.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `declared:${declared.join(",") || "none"}`,
          `granted:${granted.join(",") || "none"}`,
          declaredNotGranted.length === 0
            ? "declaration-within-surface (the replacement demands only granted capabilities)"
            : `UNGRANTED-DEMAND (the replacement declared capabilities outside its granted surface: ${declaredNotGranted.join(",")})`,
        ],
      },
      {
        criterionId: "isolation-exercised-declared",
        strategy: "deterministic",
        status: undeclaredExercises.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `exercised:${exercised.join(",") || "none"}`,
          `declared:${declared.join(",") || "none"}`,
          undeclaredExercises.length === 0
            ? "no-undeclared-exercise (the runtime exercised only declared capabilities)"
            : `UNDECLARED-EXERCISE (the runtime exercised undeclared capabilities: ${undeclaredExercises.join(",")})`,
        ],
      },
      {
        criterionId: "isolation-no-escape",
        strategy: "deterministic",
        status: ungrantedExercises.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `exercised:${exercised.join(",") || "none"}`,
          `granted:${granted.join(",") || "none"}`,
          `escapeDirections:${escapeDirections.length === 0 ? "none" : escapeDirections.join(",")}`,
          ungrantedExercises.length === 0
            ? "within-surface (the untrusted replacement touched only its granted surface)"
            : escapeDirections.length > 0
              ? `CONTAINMENT-VIOLATION (the replacement escaped its isolation boundary: ${escapeDirections.join(",")})`
              : `CONTAINMENT-VIOLATION (the replacement exercised ungranted capabilities: ${ungrantedExercises.join(",")})`,
        ],
      },
      {
        criterionId: "isolation-summary",
        strategy: "deterministic",
        status: contained ? "PASS" : "FAIL",
        evidence: [
          `containment:${containment}`,
          `declaredNotGranted:${declaredNotGranted.length}`,
          `undeclaredExercises:${undeclaredExercises.length}`,
          `ungrantedExercises:${ungrantedExercises.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The differential evaluation oracle
// ---------------------------------------------------------------------------

/** One executed side's outcome for one differential case (digests only). */
export interface DifferentialCaseOutcome {
  readonly caseId: string;
  readonly digest: string;
}

/** The replacement side's outcome: the digest plus the runtime's OWN equivalence claim. */
export interface ReplacementCaseOutcome extends DifferentialCaseOutcome {
  /** The runtime's claimed criterion satisfaction for this case (the smoothing cross-check). */
  readonly claimedEquivalent: boolean;
}

/** One recorded divergence (an honest divergence is recorded, never smoothed). */
export interface RecordedDivergence {
  readonly caseId: string;
  readonly incumbentDigest: string;
  readonly replacementDigest: string;
}

/** The differential-equivalence verdict. */
export interface DifferentialEquivalenceVerdict {
  /** The replacement satisfied its explicit criterion over the full population (checked, unsmoothed). */
  readonly equivalent: boolean;
  /** The criterion was stated explicitly (an unstated criterion FAILs). */
  readonly criterionExplicit: boolean;
  /** Every case of the population was mechanically evaluated (an unchecked criterion FAILs). */
  readonly fullyEvaluated: boolean;
  /** The criterion's kind (`null` when unstated). */
  readonly criterionKind: AcceptanceCriterionKind | null;
  /** The cases where the replacement diverges from its stated criterion (recorded honestly). */
  readonly divergences: readonly RecordedDivergence[];
  /** The divergent cases whose divergence the runtime SMOOTHED (claimed equivalent). */
  readonly smoothedDivergences: readonly RecordedDivergence[];
  /** The population cases the evaluation never checked. */
  readonly unevaluatedCaseIds: readonly string[];
  /** The population cases with a missing incumbent or replacement outcome. */
  readonly missingOutcomeCaseIds: readonly string[];
  /** The canonical digest over this verdict (payload-free). */
  readonly digest: string;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Whether one case satisfies the stated criterion (PURE — the
 * per-case mechanical evaluation): `exact-digest-equality` demands
 * digest identity; `digest-class-equality` demands membership of the
 * case's pinned digest class; `per-case-tolerance` demands identity
 * OR the case's explicit presence in the tolerated set. An unstated
 * criterion (`null`) is never satisfied — it is not a criterion.
 */
export function criterionSatisfiedForCase(input: {
  readonly dcase: DifferentialCase;
  readonly replacementDigest: string;
  readonly incumbentDigest: string;
  readonly criterion: AcceptanceCriterion | null;
}): boolean {
  if (input.criterion === null) {
    return false;
  }
  switch (input.criterion.kind) {
    case "exact-digest-equality":
      return input.replacementDigest === input.incumbentDigest;
    case "digest-class-equality":
      return input.dcase.classDigests.includes(input.replacementDigest);
    case "per-case-tolerance":
      return (
        input.replacementDigest === input.incumbentDigest ||
        (input.criterion.toleratedCaseIds ?? []).includes(input.dcase.caseId)
      );
  }
}

/**
 * Derive the differential equivalence (PURE — the differential
 * evaluation oracle): the acceptance criterion must be EXPLICIT (a
 * replacement accepted under an unstated criterion FAILs) and
 * mechanically evaluated over EVERY case of the differential
 * population (a criterion stated but never checked — or
 * checkable-but-unchecked — FAILs, with the unevaluated cases
 * named); each case is then evaluated against the stated criterion
 * (equality is NOT required for semantic outputs — the class and
 * tolerance criteria are honest — but the criterion is the contract);
 * and a divergent case FAILs, recorded as an honest divergence with
 * its case id and both digests — NEVER smoothed. A runtime that
 * claims equivalence for a divergent case (a smoothed divergence)
 * FAILs the honesty leg on top of the divergence itself.
 */
export function deriveDifferentialEquivalence(input: {
  /** The differential population under test (the full cited population + the pinned adversarial cases). */
  readonly population: readonly DifferentialCase[];
  /** The EXPLICIT acceptance criterion (null when unstated — an unstated criterion FAILs). */
  readonly criterion: AcceptanceCriterion | null;
  /** The incumbent side's executed outcome digests. */
  readonly incumbentOutcomes: readonly DifferentialCaseOutcome[];
  /** The replacement side's executed outcomes (with the runtime's own claims). */
  readonly replacementOutcomes: readonly ReplacementCaseOutcome[];
  /** The case ids the evaluation actually checked (the checked surface). */
  readonly evaluatedCaseIds: readonly string[];
}): DifferentialEquivalenceVerdict {
  const criterionExplicit = input.criterion !== null;
  const evaluated = new Set(input.evaluatedCaseIds);
  const incumbentByCase = new Map(
    input.incumbentOutcomes.map((outcome) => [outcome.caseId, outcome.digest]),
  );
  const replacementByCase = new Map(
    input.replacementOutcomes.map((outcome) => [outcome.caseId, outcome]),
  );

  const unevaluatedCaseIds = input.population
    .map((dcase) => dcase.caseId)
    .filter((caseId) => !evaluated.has(caseId));
  const missingOutcomeCaseIds = input.population
    .map((dcase) => dcase.caseId)
    .filter((caseId) => !incumbentByCase.has(caseId) || !replacementByCase.has(caseId));
  const fullyEvaluated = unevaluatedCaseIds.length === 0 && missingOutcomeCaseIds.length === 0;

  const divergences: RecordedDivergence[] = [];
  const smoothedDivergences: RecordedDivergence[] = [];
  const malformedTolerance: string[] = [];
  if (criterionExplicit) {
    const populationIds = new Set(input.population.map((dcase) => dcase.caseId));
    for (const tolerated of input.criterion?.toleratedCaseIds ?? []) {
      if (!populationIds.has(tolerated)) {
        malformedTolerance.push(tolerated);
      }
    }
  }

  for (const dcase of input.population) {
    const incumbentDigest = incumbentByCase.get(dcase.caseId);
    const replacementOutcome = replacementByCase.get(dcase.caseId);
    if (incumbentDigest === undefined || replacementOutcome === undefined) {
      continue;
    }
    const satisfied = criterionSatisfiedForCase({
      dcase,
      replacementDigest: replacementOutcome.digest,
      incumbentDigest,
      criterion: input.criterion,
    });
    if (!satisfied) {
      const divergence: RecordedDivergence = {
        caseId: dcase.caseId,
        incumbentDigest,
        replacementDigest: replacementOutcome.digest,
      };
      divergences.push(divergence);
      if (replacementOutcome.claimedEquivalent) {
        smoothedDivergences.push(divergence);
      }
    } else if (!replacementOutcome.claimedEquivalent) {
      // A satisfied case claimed NON-equivalent is a false-divergence
      // claim — an honesty defect the oracle records.
      smoothedDivergences.push({
        caseId: dcase.caseId,
        incumbentDigest,
        replacementDigest: replacementOutcome.digest,
      });
    }
  }

  const noDivergence = divergences.length === 0;
  const noSmoothing = smoothedDivergences.length === 0;
  const wellFormedTolerance = malformedTolerance.length === 0;
  const equivalent =
    criterionExplicit && fullyEvaluated && noDivergence && noSmoothing && wellFormedTolerance;

  const basis = {
    criterionKind: input.criterion?.kind ?? null,
    divergences: divergences.map((divergence) => divergence.caseId),
    smoothedDivergences: smoothedDivergences.map((divergence) => divergence.caseId),
    unevaluatedCaseIds,
    missingOutcomeCaseIds,
    malformedTolerance,
  };
  const digest = longitudinalDigestOf(["differential-verdict", basis.criterionKind, basis]);

  const criteria: LabVerificationCriterion[] = [];
  criteria.push({
    criterionId: "criterion-explicit",
    strategy: "deterministic",
    status: criterionExplicit ? "PASS" : "FAIL",
    evidence: [
      `criterion:${input.criterion?.kind ?? "none"}`,
      `toleratedCaseIds:${(input.criterion?.toleratedCaseIds ?? []).join(",") || "none"}`,
      criterionExplicit
        ? "the-acceptance-criterion-is-stated (equality is not required for semantic outputs — an explicit criterion is)"
        : "UNSTATED-CRITERION (a replacement accepted under an unstated criterion FAILs)",
    ],
  });
  criteria.push({
    criterionId: "criterion-checked",
    strategy: "deterministic",
    status: fullyEvaluated ? "PASS" : "FAIL",
    evidence: [
      `populationSize:${input.population.length}`,
      `evaluatedCaseIds:${input.evaluatedCaseIds.length}`,
      `unevaluatedCaseIds:${unevaluatedCaseIds.join(",") || "none"}`,
      `missingOutcomeCaseIds:${missingOutcomeCaseIds.join(",") || "none"}`,
      fullyEvaluated
        ? "the-criterion-was-mechanically-evaluated-over-every-case (both sides' outcomes digest-recorded)"
        : unevaluatedCaseIds.length === 0
          ? "UNCHECKED-CRITERION (the criterion is stated but the outcomes were never recorded for every case)"
          : "UNCHECKED-CRITERION (the criterion is stated but never checked over the full population)",
    ],
  });
  criteria.push({
    criterionId: "differential-criterion-satisfied",
    strategy: "deterministic",
    status: noDivergence ? "PASS" : "FAIL",
    evidence: [
      `criterionKind:${input.criterion?.kind ?? "none"}`,
      `divergences:${divergences.length === 0 ? "none" : divergences.map((divergence) => `${divergence.caseId}:{incumbent:${divergence.incumbentDigest},replacement:${divergence.replacementDigest}}`).join(";")}`,
      noDivergence
        ? "every-case-satisfies-the-stated-criterion"
        : "HONEST-DIVERGENCE (a differential case where the replacement diverges from its stated criterion — recorded, never smoothed)",
    ],
  });
  criteria.push({
    criterionId: "divergence-honesty-no-smoothing",
    strategy: "deterministic",
    status: noSmoothing ? "PASS" : "FAIL",
    evidence: [
      `smoothedDivergences:${smoothedDivergences.length === 0 ? "none" : smoothedDivergences.map((divergence) => divergence.caseId).join(",")}`,
      noSmoothing
        ? "every-claim-matches-the-mechanical-evaluation (a divergence is reported as a divergence)"
        : "DIVERGENCE-SMOOTHING (the runtime claimed equivalence the mechanical evaluation contradicts)",
    ],
  });
  if (criterionExplicit && input.criterion?.kind === "per-case-tolerance") {
    criteria.push({
      criterionId: "criterion-well-formed-tolerance",
      strategy: "deterministic",
      status: wellFormedTolerance ? "PASS" : "FAIL",
      evidence: [
        `malformedTolerance:${malformedTolerance.join(",") || "none"}`,
        wellFormedTolerance
          ? "the-tolerated-set-cites-population-members-only"
          : "MALFORMED-CRITERION (the tolerated set names cases outside the differential population)",
      ],
    });
  }
  criteria.push({
    criterionId: "differential-equivalence-summary",
    strategy: "deterministic",
    status: equivalent ? "PASS" : "FAIL",
    evidence: [
      `equivalent:${String(equivalent)}`,
      `criterionExplicit:${String(criterionExplicit)}`,
      `fullyEvaluated:${String(fullyEvaluated)}`,
      `divergences:${divergences.length}`,
      `smoothedDivergences:${smoothedDivergences.length}`,
      `digest:${digest}`,
    ],
  });

  return {
    equivalent,
    criterionExplicit,
    fullyEvaluated,
    criterionKind: input.criterion?.kind ?? null,
    divergences,
    smoothedDivergences,
    unevaluatedCaseIds,
    missingOutcomeCaseIds,
    digest,
    criteria,
  };
}

/** The canonical digest over a differential verdict (PURE, payload-free). */
export function differentialVerdictDigestOf(
  verdict: Omit<DifferentialEquivalenceVerdict, "digest" | "criteria">,
): string {
  return longitudinalDigestOf([
    "differential-verdict",
    verdict.criterionKind,
    verdict.divergences.map((divergence) => divergence.caseId),
    verdict.smoothedDivergences.map((divergence) => divergence.caseId),
    verdict.unevaluatedCaseIds,
    verdict.missingOutcomeCaseIds,
  ]);
}

// ---------------------------------------------------------------------------
// Provenance completeness (the verdict cites its proposal + its full population)
// ---------------------------------------------------------------------------

/** The provenance-completeness verdict. */
export interface ProvenanceCompletenessVerdict {
  /** The verdict cites its source proposal AND the full differential population. */
  readonly complete: boolean;
  /** The verdict's cited proposal id (null when uncited). */
  readonly citedProposalId: string | null;
  /** Population replay identities the coverage MISSED (a partial population). */
  readonly missingReplayIdentities: readonly string[];
  /** Pinned adversarial cases the coverage MISSED (a partial population). */
  readonly missingAdversarialCaseIds: readonly string[];
  /** Covered identities that are NOT members of the proposal's citation (fabricated coverage). */
  readonly fabricatedReplayIdentities: readonly string[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the provenance completeness (PURE — the equivalence oracle's
 * provenance leg): the verdict must CITE its source proposal — the
 * VAL-032 registry identity the row tests (an UNCITED verdict FAILs;
 * a PHANTOM citation — an id the registry never recorded — FAILs; a
 * citation that mismatches the row's pinned proposal FAILs) — AND its
 * FULL differential population: every replay identity of the
 * proposal's own evidence citation PLUS every pinned adversarial case
 * (a PARTIAL population — missing adversarial cases or a subset of
 * the cited replay identities — FAILs, and a covered identity the
 * proposal never cited is a FABRICATED population).
 */
export function deriveProvenanceCompleteness(input: {
  /** The candidate registry's own recorded proposal identities (the read-only input). */
  readonly registryProposalIds: readonly string[];
  /** The proposal id the row's verdict is expected to cite (the pin). */
  readonly expectedProposalId: string;
  /** The proposal id the verdict actually cites (null when uncited). */
  readonly citedProposalId: string | null;
  /** The REGISTRY entry's own evidence citation (the proposal's cited replay identities). */
  readonly proposalCitedReplayIdentities: readonly string[];
  /** The row's pinned adversarial case ids (the adversarial half of the population). */
  readonly pinnedAdversarialCaseIds: readonly string[];
  /** The replay identities the differential population actually covered (the historical half). */
  readonly coveredReplayIdentities: readonly string[];
  /** The adversarial case ids the differential population actually covered. */
  readonly coveredAdversarialCaseIds: readonly string[];
}): ProvenanceCompletenessVerdict {
  const cited = input.citedProposalId;
  const uncited = cited === null;
  const phantom = cited !== null && !input.registryProposalIds.includes(cited);
  const mismatched = cited !== null && cited !== input.expectedProposalId;
  const proposalCited = !uncited && !phantom;

  const citedIdentities = [...new Set(input.proposalCitedReplayIdentities)];
  const coveredReplays = [...new Set(input.coveredReplayIdentities)];
  const pinnedAdversarial = [...new Set(input.pinnedAdversarialCaseIds)];
  const coveredAdversarial = [...new Set(input.coveredAdversarialCaseIds)];

  const missingReplayIdentities = citedIdentities.filter(
    (identity) => !coveredReplays.includes(identity),
  );
  const missingAdversarialCaseIds = pinnedAdversarial.filter(
    (caseId) => !coveredAdversarial.includes(caseId),
  );
  const fabricatedReplayIdentities = coveredReplays.filter(
    (identity) => !citedIdentities.includes(identity),
  );

  const complete =
    proposalCited &&
    !mismatched &&
    missingReplayIdentities.length === 0 &&
    missingAdversarialCaseIds.length === 0 &&
    fabricatedReplayIdentities.length === 0;

  return {
    complete,
    citedProposalId: cited,
    missingReplayIdentities,
    missingAdversarialCaseIds,
    fabricatedReplayIdentities,
    criteria: [
      {
        criterionId: "provenance-proposal-cited",
        strategy: "deterministic",
        status: proposalCited ? "PASS" : "FAIL",
        evidence: [
          `citedProposal:${cited ?? "none"}`,
          `registryProposals:${input.registryProposalIds.length}`,
          uncited
            ? "UNCITED-VERDICT (the verdict does not cite its source proposal — the VAL-032 registry identity)"
            : phantom
              ? "PHANTOM-CITATION (the verdict cites a proposal the registry never recorded)"
              : "the-verdict-cites-a-registry-member",
        ],
      },
      {
        criterionId: "provenance-proposal-matches-pin",
        strategy: "deterministic",
        status: !mismatched ? "PASS" : "FAIL",
        evidence: [
          `expected:${input.expectedProposalId}`,
          `cited:${cited ?? "none"}`,
          mismatched
            ? "PROPOSAL-MISMATCH (the verdict cites a proposal other than the row's pinned source)"
            : "the-cited-proposal-is-the-pinned-source",
        ],
      },
      {
        criterionId: "provenance-full-population",
        strategy: "deterministic",
        status:
          missingReplayIdentities.length === 0 && missingAdversarialCaseIds.length === 0
            ? "PASS"
            : "FAIL",
        evidence: [
          `citedReplays:${citedIdentities.length}`,
          `coveredReplays:${coveredReplays.length}`,
          `pinnedAdversarial:${pinnedAdversarial.length}`,
          `coveredAdversarial:${coveredAdversarial.length}`,
          `missingReplays:${missingReplayIdentities.join(",") || "none"}`,
          `missingAdversarial:${missingAdversarialCaseIds.join(",") || "none"}`,
          missingReplayIdentities.length === 0 && missingAdversarialCaseIds.length === 0
            ? "the-verdict-cites-its-full-differential-population"
            : "PARTIAL-POPULATION (the differential population covers only part of the cited evidence — the historical replay inputs and the pinned adversarial cases are both mandatory)",
        ],
      },
      {
        criterionId: "provenance-no-fabricated-coverage",
        strategy: "deterministic",
        status: fabricatedReplayIdentities.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `fabricatedReplays:${fabricatedReplayIdentities.join(",") || "none"}`,
          fabricatedReplayIdentities.length === 0
            ? "the-covered-replays-are-members-of-the-proposals-citation"
            : "FABRICATED-POPULATION (the coverage names replay identities the proposal never cited)",
        ],
      },
      {
        criterionId: "provenance-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `cited:${cited ?? "none"}`,
          `missingReplays:${missingReplayIdentities.length}`,
          `missingAdversarial:${missingAdversarialCaseIds.length}`,
          `fabricated:${fabricatedReplayIdentities.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage discipline (proposed → offline-replayed → differentially-evaluated ONLY)
// ---------------------------------------------------------------------------

/** One append-only lifecycle transition the ledger recorded. */
export interface LifecycleTransitionRecord {
  readonly proposalId: string;
  readonly toStage: CandidateLifecycleStage;
  /** The digest of the evidence justifying the transition (empty = evidence-less). */
  readonly evidenceDigest: string;
  /** 1-based append order within the proposal's walk. */
  readonly ordinal: number;
}

/** The stage-discipline verdict. */
export interface StageDisciplineVerdict {
  /** The walk is exactly proposed → offline-replayed → differentially-evaluated, each evidenced. */
  readonly disciplined: boolean;
  /** The walk's stages, in append order. */
  readonly walk: readonly CandidateLifecycleStage[];
  /** Any transition landing PAST the differentially-evaluated stage (a skipped-stage promotion). */
  readonly beyondScopeStages: readonly CandidateLifecycleStage[];
  /** Any stage advance that skipped a ladder rung (an illegal jump). */
  readonly skippedStageTransitions: readonly number[];
  /** The ordinals of transitions that landed without evidence. */
  readonly evidenceLessOrdinals: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the stage discipline (PURE — the lifecycle ladder's
 * oracle): the equivalence slice's append is
 * `proposed → offline-replayed → differentially-evaluated` ONLY —
 * every stage past `differentially-evaluated` on the pinned ladder
 * (property-tested, mutation-tested, shadow-executed, canaried,
 * promoted) is BEYOND this slice's scope and FAILs mechanically (a
 * skipped-stage advance); every consecutive transition must advance
 * EXACTLY one ladder rung (a jump FAILs); and every transition must
 * carry its evidence digest (an evidence-less transition FAILs). The
 * starting stage must be `proposed` (the registry's own record).
 */
export function deriveStageDiscipline(input: {
  /** The registry's own stage for the proposal (the walk's start). */
  readonly proposalStage: CandidateLifecycleStage;
  /** The ledger's recorded transitions for the proposal, in append order. */
  readonly transitions: readonly LifecycleTransitionRecord[];
  /** Whether the run expected its verdict to LAND (append) at the equivalence stage. */
  readonly expectedLanding: boolean;
}): StageDisciplineVerdict {
  const walk = input.transitions.map((transition) => transition.toStage);
  const proposalIndex = lifecycleStageIndexOf(EQUIVALENCE_SOURCE_STAGE);
  const _finalIndex = lifecycleStageIndexOf(EQUIVALENT_STAGE);

  const beyondScopeStages = walk.filter((stage) => isBeyondEquivalenceScope(stage));
  const skippedStageTransitions: number[] = [];
  let previousIndex = proposalIndex;
  for (const stage of walk) {
    const stageIndex = lifecycleStageIndexOf(stage);
    if (stageIndex > previousIndex + 1) {
      skippedStageTransitions.push(stageIndex);
    }
    previousIndex = Math.max(previousIndex, stageIndex);
  }
  const evidenceLessOrdinals = input.transitions
    .filter((transition) => (transition.evidenceDigest ?? "").length === 0)
    .map((transition) => transition.ordinal);

  const startsAtProposed = input.proposalStage === EQUIVALENCE_SOURCE_STAGE;
  const noBeyondScope = beyondScopeStages.length === 0;
  const noSkips = skippedStageTransitions.length === 0;
  const allEvidenced = evidenceLessOrdinals.length === 0;
  const expectedWalk: CandidateLifecycleStage[] = [OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE];
  const landingMatch = input.expectedLanding
    ? walk.length === expectedWalk.length &&
      walk.every((stage, index) => stage === expectedWalk[index])
    : walk.length === 0;
  const disciplined = startsAtProposed && noBeyondScope && noSkips && allEvidenced && landingMatch;

  return {
    disciplined,
    walk,
    beyondScopeStages,
    skippedStageTransitions,
    evidenceLessOrdinals,
    criteria: [
      {
        criterionId: "stage-discipline-source-proposed",
        strategy: "deterministic",
        status: startsAtProposed ? "PASS" : "FAIL",
        evidence: [
          `proposalStage:${input.proposalStage}`,
          `expectedSource:${EQUIVALENCE_SOURCE_STAGE}`,
          startsAtProposed
            ? "the-walk-starts-from-proposed (the registry's own record)"
            : "NOT-PROPOSED (the candidate has not reached the proposed stage — it is not yet testable)",
        ],
      },
      {
        criterionId: "stage-discipline-never-beyond-equivalence",
        strategy: "deterministic",
        status: noBeyondScope ? "PASS" : "FAIL",
        evidence: [
          `walk:${walk.join("→") || "none"}`,
          `equivalentStage:${EQUIVALENT_STAGE}`,
          `beyondScope:${beyondScopeStages.join(",") || "none"}`,
          noBeyondScope
            ? "equivalence-verified-only (shadow, canary and promotion are later slices' acts)"
            : "SKIPPED-STAGE (the lifecycle append advanced past the differentially-evaluated stage — an out-of-scope promotion)",
        ],
      },
      {
        criterionId: "stage-discipline-no-jumps",
        strategy: "deterministic",
        status: noSkips ? "PASS" : "FAIL",
        evidence: [
          `walk:${walk.join("→") || "none"}`,
          `skippedStageTransitions:${skippedStageTransitions.join(",") || "none"}`,
          noSkips
            ? "every-transition-advances-exactly-one-rung"
            : "SKIPPED-STAGE (a stage transition jumped a ladder rung — offline-replayed precedes differentially-evaluated)",
        ],
      },
      {
        criterionId: "stage-discipline-every-transition-evidenced",
        strategy: "deterministic",
        status: allEvidenced ? "PASS" : "FAIL",
        evidence: [
          `transitions:${input.transitions.length}`,
          `evidenceLessOrdinals:${evidenceLessOrdinals.join(",") || "none"}`,
          allEvidenced
            ? "every-stage-transition-carries-its-evidence-digest"
            : "EVIDENCE-LESS-TRANSITION (a stage transition without its evidence FAILs)",
        ],
      },
      {
        criterionId: "stage-discipline-landing",
        strategy: "deterministic",
        status: landingMatch ? "PASS" : "FAIL",
        evidence: [
          `expectedLanding:${String(input.expectedLanding)}`,
          `expectedWalk:${input.expectedLanding ? expectedWalk.join("→") : "(none)"}`,
          `observedWalk:${walk.join("→") || "none"}`,
          landingMatch
            ? "the-ledger-holds-exactly-the-equivalence-walk"
            : "LANDING-MISMATCH (the ledger's walk for the proposal differs from the equivalence walk)",
        ],
      },
      {
        criterionId: "stage-discipline-summary",
        strategy: "deterministic",
        status: disciplined ? "PASS" : "FAIL",
        evidence: [
          `disciplined:${String(disciplined)}`,
          `walk:${walk.join("→") || "none"}`,
          `beyondScope:${beyondScopeStages.length}`,
          `skips:${skippedStageTransitions.length}`,
          `evidenceLess:${evidenceLessOrdinals.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refusal honesty (a refusal is justified by the registry's own state)
// ---------------------------------------------------------------------------

/** The refusal-honesty verdict. */
export interface EquivalenceRefusalHonestyVerdict {
  /** The refusal is mechanically justified by the registry's own state. */
  readonly honest: boolean;
  readonly reason: EquivalenceRefusalReason | null;
  readonly justified: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the refusal honesty (PURE): an equivalence run refuses only
 * when the proposal's own evidence does not support replacement —
 * `proposal-unregistered` only when the cited identity is not a
 * member of the registry, `proposal-stage-not-proposed` only when the
 * registry entry has not reached the `proposed` stage, and
 * `proposal-evidence-insufficient` only when the proposal's own
 * citation holds fewer than two replays (a single replay is an
 * anecdote, not a population). A refusal that hides a testable
 * proposal FAILs just as a fabricated verdict does — and a refusal
 * accompanied by an evaluation (or vice versa) is a malformed outcome
 * that FAILs.
 */
export function deriveEquivalenceRefusalHonesty(input: {
  /** The run's refusal under test (null when an evaluation was emitted). */
  readonly refusal: { readonly reason: EquivalenceRefusalReason } | null;
  /** Whether the run emitted an evaluation alongside the refusal under test. */
  readonly evaluationEmitted: boolean;
  /** The registry's own entry for the row's cited proposal (null when unregistered). */
  readonly registryEntry: {
    readonly lifecycleStage: CandidateLifecycleStage;
    readonly citation: ProposalEvidenceCitation;
  } | null;
}): EquivalenceRefusalHonestyVerdict {
  const malformed = (input.refusal !== null) === input.evaluationEmitted;
  let justified = false;
  let basis = "";
  if (input.refusal === null) {
    justified = !input.evaluationEmitted;
    basis = "no-refusal-to-judge (the run emitted an evaluation)";
  } else {
    switch (input.refusal.reason) {
      case "proposal-unregistered":
        justified = input.registryEntry === null;
        basis = "the cited proposal identity is not a member of the candidate registry";
        break;
      case "proposal-stage-not-proposed":
        justified =
          input.registryEntry !== null &&
          input.registryEntry.lifecycleStage !== EQUIVALENCE_SOURCE_STAGE;
        basis = "the registry entry has not reached the proposed stage";
        break;
      case "proposal-evidence-insufficient":
        justified =
          input.registryEntry !== null &&
          input.registryEntry.lifecycleStage === EQUIVALENCE_SOURCE_STAGE &&
          input.registryEntry.citation.replayIdentities.length < 2;
        basis = "the proposal's own evidence citation is too thin to test a replacement against";
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
          `evaluationEmitted:${String(input.evaluationEmitted)}`,
          malformed
            ? "MALFORMED-OUTCOME (a refusal and an evaluation are mutually exclusive)"
            : "the-outcome-is-either-an-evaluation-or-a-refusal",
        ],
      },
      {
        criterionId: "refusal-justified",
        strategy: "deterministic",
        status: justified ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal?.reason ?? "none"}`,
          `registryStage:${input.registryEntry?.lifecycleStage ?? "none"}`,
          `citationSize:${input.registryEntry?.citation.replayIdentities.length ?? 0}`,
          justified
            ? `justified (${basis})`
            : "UNJUSTIFIED-REFUSAL (the registry's own state supports the replacement test — hiding it FAILs)",
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
// The honest replacement run (the PURE reference runtime)
// ---------------------------------------------------------------------------

/** The replacement runtime's run outcome (the seam's return shape). */
export interface ReplacementRunOutcome {
  /** The replacement side's per-case outcomes (digest + the runtime's own claim). */
  readonly outcomes: readonly ReplacementCaseOutcome[];
  /** The capabilities the runtime observed the replacement exercising. */
  readonly exercisedCapabilities: readonly string[];
  /** The proposal id the verdict cites (null when uncited). */
  readonly citedProposalId: string | null;
  /** The case ids the runtime actually evaluated (the checked surface). */
  readonly evaluatedCaseIds: readonly string[];
}

/**
 * Derive the HONEST replacement run for one row over one differential
 * population (PURE — the reference runtime): the outcomes are the
 * shape's deterministic reference digests, the per-case claims are
 * the MECHANICAL criterion evaluations (never smoothed), the
 * exercised capabilities are exactly the declaration, the citation is
 * the row's source proposal, and the checked surface is the FULL
 * population. The deterministic fixtures pin the adversarial
 * variants (escaping, uncited, partial, unchecked, smoothing).
 */
export function deriveHonestReplacementRun(input: {
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly acceptanceCriterion: AcceptanceCriterion | null;
  readonly population: readonly DifferentialCase[];
}): ReplacementRunOutcome {
  return {
    outcomes: input.population.map((dcase) => ({
      caseId: dcase.caseId,
      digest: referenceReplacementOutcomeDigestOf({
        shape: input.replacementShape,
        caseId: dcase.caseId,
        inputDigest: dcase.inputDigest,
        classDigests: dcase.classDigests,
      }),
      claimedEquivalent: criterionSatisfiedForCase({
        dcase,
        replacementDigest: referenceReplacementOutcomeDigestOf({
          shape: input.replacementShape,
          caseId: dcase.caseId,
          inputDigest: dcase.inputDigest,
          classDigests: dcase.classDigests,
        }),
        incumbentDigest: dcase.incumbentDigest,
        criterion: input.acceptanceCriterion,
      }),
    })),
    exercisedCapabilities: [...input.declaredCapabilities],
    citedProposalId: input.sourceProposalId,
    evaluatedCaseIds: input.population.map((dcase) => dcase.caseId),
  };
}

/**
 * Derive the observed equivalence verdict kind (PURE): an honest
 * refusal when the run refused; a containment violation when the
 * replacement escaped its granted surface; an honest divergence when
 * a case diverged from its stated criterion over a complete,
 * fully-evaluated, unsmoothed differential; an equivalence pass when
 * every leg holds; and `evaluation-invalid` when the verdict's
 * mechanical shape is untrustworthy (a broken provenance chain, an
 * unchecked criterion or a smoothed divergence — an internal honesty
 * failure that is never passable).
 */
export function deriveEquivalenceVerdictKind(input: {
  readonly refusal: { readonly reason: EquivalenceRefusalReason } | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly differential: DifferentialEquivalenceVerdict | null;
  readonly provenance: ProvenanceCompletenessVerdict | null;
}): EquivalenceVerdictKind {
  if (input.refusal !== null) {
    return "honest-refusal";
  }
  if (input.isolation !== null && !input.isolation.contained) {
    return "containment-violation";
  }
  if (input.differential === null || input.provenance === null) {
    return "evaluation-invalid";
  }
  if (
    !input.provenance.complete ||
    !input.differential.fullyEvaluated ||
    input.differential.smoothedDivergences.length > 0 ||
    !input.differential.criterionExplicit
  ) {
    return "evaluation-invalid";
  }
  if (input.differential.divergences.length > 0) {
    return "honest-divergence";
  }
  return "equivalence-pass";
}

// ---------------------------------------------------------------------------
// The driver seam (the read-only registry + the append-only ledger)
// ---------------------------------------------------------------------------

/** The candidate registry's own facts (the read-only proposal view). */
export interface EquivalenceRegistryFacts {
  readonly proposals: readonly {
    readonly proposalId: string;
    readonly kind: string;
    readonly lifecycleStage: CandidateLifecycleStage;
    /** The canonical digest over the recorded proposal's citation. */
    readonly citationDigest: string;
  }[];
  /** Entries the registry holds PAST the proposed stage (an applied candidate). */
  readonly appliedCandidateCount: number;
}

/**
 * The candidate-registry read port (the READ-ONLY input): the
 * VAL-032 registry entries — proposals at the `proposed` stage with
 * their evidence citations. The equivalence run NEVER rewrites an
 * entry; a registry whose digest changes over a run FAILs the
 * read-only discipline.
 */
export interface CandidateRegistryReadPort {
  proposalFor(proposalId: string): DiscoveryProposalRecord | null;
  facts(): EquivalenceRegistryFacts;
}

/**
 * The canonical digest over the registry's facts (PURE — the
 * read-only fingerprint the driver snapshots before and after every
 * run: the registry entries are frozen inputs).
 */
export function equivalenceRegistryDigestOf(facts: EquivalenceRegistryFacts): string {
  return longitudinalDigestOf([
    "candidate-registry",
    facts.proposals.map((proposal) => [
      proposal.proposalId,
      proposal.kind,
      proposal.lifecycleStage,
      proposal.citationDigest,
    ]),
    facts.appliedCandidateCount,
  ]);
}

/**
 * The candidate lifecycle ledger port (APPEND-ONLY): the equivalence
 * run APPENDS verdicts to the candidate lifecycle — the
 * `offline-replayed` and `differentially-evaluated` transitions with
 * their evidence digests. The ledger never REWRITES a proposal: an
 * identical re-append REPLAYS (idempotent), a different transition
 * under the same (proposalId, toStage) is REFUSED, and a ledger that
 * mutates the registry or advances a proposal beyond the equivalence
 * stage FAILs the driver mechanically.
 */
export interface CandidateLifecycleLedgerPort {
  append(record: Omit<LifecycleTransitionRecord, "ordinal">): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }>;
  transitionsFor(proposalId: string): readonly LifecycleTransitionRecord[];
}

/** The incumbent-executor port (the incumbent AI implementation seam). */
export interface IncumbentExecutorPort {
  /** Serve the incumbent's outcome digest for one differential case (digests only). */
  outcomeFor(input: { readonly dcase: DifferentialCase }): Promise<{ readonly digest: string }>;
}

/** The replacement-runtime port (the isolated untrusted code seam). */
export interface ReplacementRuntimePort {
  run(input: {
    readonly sourceProposalId: string;
    readonly replacementShape: ReplacementShape;
    readonly declaredCapabilities: readonly string[];
    readonly acceptanceCriterion: AcceptanceCriterion | null;
    readonly population: readonly DifferentialCase[];
  }): Promise<ReplacementRunOutcome>;
}

// ---------------------------------------------------------------------------
// The corpus-row contract (the equivalence oracle)
// ---------------------------------------------------------------------------

/**
 * The equivalence-testing corpus row (the full oracle — AC1's per-row
 * contract): the source proposal (the VAL-032 registry identity the
 * row tests, with its evidence citation — the read-only input), the
 * replacement shape (the synthesized deterministic program with its
 * declared capabilities and granted isolation surface), the
 * differential population (the cited historical replay inputs + the
 * pinned adversarial cases, each with its pinned incumbent digest and
 * digest class), the EXPLICIT acceptance criterion, and the expected
 * verdict (the equivalence pass, the honest divergence, the
 * containment violation or the honest refusal).
 */
export interface EquivalenceCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-032 registry identity this row tests (the read-only source proposal). */
  readonly sourceProposalId: string;
  /** The replacement shape the row generates as isolated untrusted code. */
  readonly replacementShape: ReplacementShape;
  /** The replacement's DECLARED capability set. */
  readonly declaredCapabilities: readonly string[];
  /** The granted isolation surface (the ALLOWED capability set). */
  readonly grantedIsolationSurface: readonly string[];
  /** The differential population (the cited historical replay inputs + the pinned adversarial cases). */
  readonly differentialPopulation: readonly DifferentialCase[];
  /** The EXPLICIT acceptance criterion (null never passes — an unstated criterion FAILs). */
  readonly acceptanceCriterion: AcceptanceCriterion;
  /** The expected verdict (the oracle proper). */
  readonly expected: {
    readonly verdict: Exclude<
      EquivalenceVerdictKind,
      "evaluation-invalid" | "containment-violation"
    >;
    /** The expected refusal reason (null when an evaluation is expected). */
    readonly refusalReason: EquivalenceRefusalReason | null;
    /** The expected divergent case ids (an honest divergence is pinned case-by-case). */
    readonly divergenceCaseIds: readonly string[];
    /** The run's own dispatch demand (0 offline; the live row's residual-AI confirmation round). */
    readonly modelCalls: number;
    /** The run's honest terminal (an honest divergence FAILs honestly; an honest refusal COMPLETES). */
    readonly terminal: "COMPLETED" | "FAILED";
  };
  /** The pinned equivalence-trajectory class (the app's re-derivation target). */
  readonly expectedTrajectoryClass: readonly string[];
  /** The equivalence-probe vocabulary (the phase-2 discrimination hooks). */
  readonly probe?: { readonly kind: EquivalenceProbeKind };
  /** Whether the run demands a REAL residual-AI model round (the live row). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}

// ---------------------------------------------------------------------------
// The equivalence trajectory (the app's re-derivation basis)
// ---------------------------------------------------------------------------

/**
 * The canonical equivalence-run trajectory (PURE): the steps ONE
 * equivalence run records — the live row's REAL residual-AI
 * confirmation round (dispatch), the read-only proposal read, the
 * differential population serve, the incumbent execution, the isolated
 * replacement execution, the isolation verification, the differential
 * evaluation, the provenance verification, the lifecycle append (or
 * the honest refusal) and the criteria recording. The app re-derives
 * this trajectory's digest over the PUBLIC step-event journal — never
 * trusting the platform's claim.
 */
export function equivalenceTrajectoryStepsOf(input: {
  readonly proposalId: string;
  readonly populationDigest: string;
  readonly incumbentExecutionDigest: string;
  readonly replacementExecutionDigest: string;
  readonly isolationContainment: ContainmentVerdict | null;
  readonly differentialVerdictDigest: string | null;
  readonly refusalReason: EquivalenceRefusalReason | null;
  /** The run's own REAL residual-AI confirmation dispatches (the live row). */
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
    detail: "proposal-read",
    digest: longitudinalDigestOf(["proposal-read", input.proposalId]),
  });
  if (input.refusalReason !== null) {
    // The honest-refusal path: nothing executes, nothing lands.
    steps.push({
      ordinal: steps.length + 1,
      kind: "verification",
      detail: "refusal-recorded",
      digest: longitudinalDigestOf(["refusal-recorded", input.refusalReason]),
    });
  } else {
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "population-served",
      digest: input.populationDigest,
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "incumbent-executed",
      digest: input.incumbentExecutionDigest,
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "replacement-executed",
      digest: input.replacementExecutionDigest,
    });
    if (input.isolationContainment !== null) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: "isolation-verified",
        digest: longitudinalDigestOf(["isolation-verified", input.isolationContainment]),
      });
    }
    if (input.differentialVerdictDigest !== null) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: "differential-evaluated",
        digest: input.differentialVerdictDigest,
      });
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: "lifecycle-appended",
        digest: longitudinalDigestOf(["lifecycle-appended", input.proposalId, EQUIVALENT_STAGE]),
      });
    } else {
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: "refusal-recorded",
        digest: longitudinalDigestOf(["refusal-recorded", input.refusalReason ?? "none"]),
      });
    }
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "verification",
    detail: "criteria-recorded",
    digest: longitudinalDigestOf(["criteria-recorded", input.proposalId, input.populationDigest]),
  });
  return steps;
}

// ---------------------------------------------------------------------------
// The equivalence driver
// ---------------------------------------------------------------------------

/** The full equivalence-run result (the honest contract). */
export interface EquivalenceRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  /** The observed verdict kind (the honest derivation, never the runtime's claim). */
  readonly verdict: EquivalenceVerdictKind;
  readonly refusal: { readonly reason: EquivalenceRefusalReason } | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly differential: DifferentialEquivalenceVerdict | null;
  readonly provenance: ProvenanceCompletenessVerdict | null;
  readonly refusalHonesty: EquivalenceRefusalHonestyVerdict | null;
  readonly stageDiscipline: StageDisciplineVerdict | null;
  /** The lifecycle landing receipt (null when nothing was appended). */
  readonly ledgerLanding: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly observedModelCalls: number;
  /** The run's measured usage (the live row; null offline — honestly none-reported). */
  readonly usage: LabUsage | null;
  /** The run's measured latency (ms). */
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * Drive ONE equivalence corpus row through the platform path: read
 * the row's source proposal from the READ-ONLY candidate registry
 * (the VAL-032 entries — never rewritten; a proposal whose own
 * evidence does not support replacement yields an HONEST refusal),
 * build the differential population (the proposal's cited historical
 * replay inputs + the row's pinned adversarial cases), execute the
 * INCUMBENT and the ISOLATED REPLACEMENT over the SAME population
 * with both sides' outcomes digest-recorded, mechanically verify the
 * run (the replacement isolation, the differential equivalence, the
 * provenance completeness, the stage discipline), APPEND the verified
 * verdict to the candidate lifecycle ledger (the
 * offline-replayed + differentially-evaluated transitions with their
 * evidence digests — never rewriting a proposal), and snapshot the
 * registry before and after so the read-only discipline proves the
 * run mutated nothing.
 *
 * The live row additionally drives ONE REAL residual-AI confirmation
 * dispatch through the dispatch seam (env-gated, measured — never
 * fabricated); an offline equivalence run dispatches no model at all.
 */
export async function driveEquivalenceRun(options: {
  readonly row: EquivalenceCorpusRow;
  /** The READ-ONLY candidate registry (VAL-032's proposals). */
  readonly registry: CandidateRegistryReadPort;
  /** The APPEND-ONLY candidate lifecycle ledger. */
  readonly ledger: CandidateLifecycleLedgerPort;
  /** The incumbent executor seam (the incumbent AI implementation). */
  readonly incumbentExecutor: IncumbentExecutorPort;
  /** The replacement runtime seam (the isolated untrusted code). */
  readonly replacementRuntime: ReplacementRuntimePort;
  /** The dispatch seam (the live row's REAL residual-AI confirmation round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<EquivalenceRunResult> {
  const { row } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL residual-AI confirmation round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const startedAt = options.now().getTime();

  // ---- the frozen-registry snapshot BEFORE the run ----
  const beforeRegistryDigest = equivalenceRegistryDigestOf(options.registry.facts());

  // ---- the read-only source-proposal read ----
  const sourceProposal = options.registry.proposalFor(row.sourceProposalId);

  let refusal: { reason: EquivalenceRefusalReason } | null = null;
  if (sourceProposal === null) {
    refusal = { reason: "proposal-unregistered" };
  } else if (sourceProposal.lifecycleStage !== EQUIVALENCE_SOURCE_STAGE) {
    refusal = { reason: "proposal-stage-not-proposed" };
  } else if (sourceProposal.citation.replayIdentities.length < 2) {
    refusal = { reason: "proposal-evidence-insufficient" };
  }

  let isolation: ReplacementIsolationVerdict | null = null;
  let differential: DifferentialEquivalenceVerdict | null = null;
  let provenance: ProvenanceCompletenessVerdict | null = null;
  let refusalHonesty: EquivalenceRefusalHonestyVerdict | null = null;
  let stageDiscipline: StageDisciplineVerdict | null = null;
  let ledgerLanding: { accepted: boolean; replayed: boolean } | null = null;
  let servedAsPinned = true;
  let incumbentOutcomes: DifferentialCaseOutcome[] = [];
  let replacementRun: ReplacementRunOutcome | null = null;

  if (refusal !== null) {
    // ---- the honest-refusal path (the proposal's evidence does not
    //      support replacement: nothing executes, nothing lands) ----
    refusalHonesty = deriveEquivalenceRefusalHonesty({
      refusal,
      evaluationEmitted: false,
      registryEntry:
        sourceProposal === null
          ? null
          : {
              lifecycleStage: sourceProposal.lifecycleStage,
              citation: sourceProposal.citation,
            },
    });
  } else {
    // ---- the population serve (the incumbent digests must be the pins) ----
    const population = row.differentialPopulation;
    incumbentOutcomes = [];
    for (const dcase of population) {
      const outcome = await options.incumbentExecutor.outcomeFor({ dcase });
      incumbentOutcomes.push({ caseId: dcase.caseId, digest: outcome.digest });
      if (outcome.digest !== dcase.incumbentDigest) {
        servedAsPinned = false;
      }
    }

    // ---- the isolated replacement execution ----
    replacementRun = await options.replacementRuntime.run({
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      population,
    });
    const runOutcome = replacementRun;

    // ---- the mechanical verification of the run ----
    isolation = deriveReplacementIsolation({
      declaredCapabilities: row.declaredCapabilities,
      grantedSurface: row.grantedIsolationSurface,
      exercisedCapabilities: runOutcome.exercisedCapabilities,
    });
    differential = deriveDifferentialEquivalence({
      population,
      criterion: row.acceptanceCriterion,
      incumbentOutcomes,
      replacementOutcomes: runOutcome.outcomes,
      evaluatedCaseIds: runOutcome.evaluatedCaseIds,
    });
    const coveredReplayIdentities = population
      .filter((dcase) => dcase.source === "historical-replay")
      .filter((dcase) => runOutcome.evaluatedCaseIds.includes(dcase.caseId))
      .map((dcase) => dcase.sourceRef);
    const coveredAdversarialCaseIds = population
      .filter((dcase) => dcase.source === "adversarial")
      .filter((dcase) => runOutcome.evaluatedCaseIds.includes(dcase.caseId))
      .map((dcase) => dcase.caseId);
    provenance = deriveProvenanceCompleteness({
      registryProposalIds: options.registry
        .facts()
        .proposals.map((proposal) => proposal.proposalId),
      expectedProposalId: row.sourceProposalId,
      citedProposalId: runOutcome.citedProposalId,
      proposalCitedReplayIdentities: sourceProposal?.citation.replayIdentities ?? [],
      pinnedAdversarialCaseIds: population
        .filter((dcase) => dcase.source === "adversarial")
        .map((dcase) => dcase.caseId),
      coveredReplayIdentities,
      coveredAdversarialCaseIds,
    });

    // ---- the lifecycle append (ONLY a trustworthy verdict ever lands:
    //      contained + complete provenance + fully evaluated + unsmoothed;
    //      an HONEST DIVERGENCE still lands — the evaluation happened) ----
    const verdictTrustworthy =
      isolation.contained &&
      provenance.complete &&
      differential.fullyEvaluated &&
      differential.criterionExplicit &&
      differential.smoothedDivergences.length === 0;
    if (verdictTrustworthy && sourceProposal !== null) {
      const replayEvidence = lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: OFFLINE_REPLAY_STAGE,
        members: coveredReplayIdentities,
      });
      const differentialEvidence = lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: EQUIVALENT_STAGE,
        members: [differential.digest],
      });
      const replayReceipt = await options.ledger.append({
        proposalId: row.sourceProposalId,
        toStage: OFFLINE_REPLAY_STAGE,
        evidenceDigest: replayEvidence,
      });
      const finalReceipt = await options.ledger.append({
        proposalId: row.sourceProposalId,
        toStage: EQUIVALENT_STAGE,
        evidenceDigest: differentialEvidence,
      });
      ledgerLanding = {
        accepted: replayReceipt.accepted && finalReceipt.accepted,
        replayed: replayReceipt.replayed || finalReceipt.replayed,
      };
    }

    // ---- the stage discipline (the ledger's walk for the proposal) ----
    stageDiscipline = deriveStageDiscipline({
      proposalStage: sourceProposal?.lifecycleStage ?? EQUIVALENCE_SOURCE_STAGE,
      transitions: options.ledger.transitionsFor(row.sourceProposalId),
      expectedLanding: ledgerLanding !== null,
    });
  }

  // ---- the frozen-registry snapshot AFTER the run (the read-only proof) ----
  const afterRegistryDigest = equivalenceRegistryDigestOf(options.registry.facts());
  const registryUnchanged = beforeRegistryDigest === afterRegistryDigest;

  // ---- the live row's REAL residual-AI confirmation round (measured) ----
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

  const verdict = deriveEquivalenceVerdictKind({ refusal, isolation, differential, provenance });

  // ---- the row-level mechanical criteria ----
  const criteria = deriveEquivalenceRowCriteria({
    row,
    servedAsPinned,
    refusal,
    refusalHonesty,
    isolation,
    differential,
    provenance,
    stageDiscipline,
    ledgerLanding,
    registryUnchanged,
    observedModelCalls,
    verdict,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    (refusal !== null) === (differential !== null);

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    verdict,
    refusal,
    isolation,
    differential,
    provenance,
    refusalHonesty,
    stageDiscipline,
    ledgerLanding,
    observedModelCalls,
    usage,
    latencyMs: options.now().getTime() - startedAt,
    failure,
  };
}

/**
 * Derive the row-level mechanical criteria (PURE): the population pin
 * leg (the served incumbent digests are the recorded/pinned digests),
 * the isolation legs (the untrusted-code discipline), the
 * differential legs (the explicit, checked, unsmoothed criterion with
 * divergences recorded honestly), the provenance legs (the cited
 * proposal + the full differential population), the stage-discipline
 * legs (proposed → offline-replayed → differentially-evaluated only),
 * the ledger landing, the read-only registry legs, the
 * expected-verdict contract (the observed verdict matches the pinned
 * oracle — the kind, the refusal reason and the divergent cases), the
 * payload-free digest discipline and the honest accounting.
 */
export function deriveEquivalenceRowCriteria(input: {
  readonly row: EquivalenceCorpusRow;
  /** Whether the incumbent executor served the population's pinned digests exactly. */
  readonly servedAsPinned: boolean;
  readonly refusal: { readonly reason: EquivalenceRefusalReason } | null;
  readonly refusalHonesty: EquivalenceRefusalHonestyVerdict | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly differential: DifferentialEquivalenceVerdict | null;
  readonly provenance: ProvenanceCompletenessVerdict | null;
  readonly stageDiscipline: StageDisciplineVerdict | null;
  readonly ledgerLanding: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly registryUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly verdict: EquivalenceVerdictKind;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  // 1. The population pin (the served incumbent digests are the pins).
  if (input.differential !== null) {
    criteria.push({
      criterionId: "population-served-as-pinned",
      strategy: "deterministic",
      status: input.servedAsPinned ? "PASS" : "FAIL",
      evidence: [
        `row:${row.rowId}`,
        `populationSize:${row.differentialPopulation.length}`,
        `historicalCases:${row.differentialPopulation.filter((dcase) => dcase.source === "historical-replay").length}`,
        `adversarialCases:${row.differentialPopulation.filter((dcase) => dcase.source === "adversarial").length}`,
        input.servedAsPinned
          ? "served-as-pinned (the incumbent outcomes are the recorded/pinned digests — the read-only input)"
          : "POPULATION-MISMATCH (the incumbent executor served a digest the population does not pin)",
      ],
    });
  }

  // 2-5. The isolation / differential / provenance / stage legs.
  if (input.isolation !== null) {
    criteria.push(...input.isolation.criteria);
  }
  if (input.differential !== null) {
    criteria.push(...input.differential.criteria);
  }
  if (input.provenance !== null) {
    criteria.push(...input.provenance.criteria);
  }
  if (input.stageDiscipline !== null) {
    criteria.push(...input.stageDiscipline.criteria);
  }
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // 6. The ledger landing (the verdict appends to the candidate lifecycle).
  const shouldLand =
    input.refusal === null &&
    input.isolation?.contained === true &&
    input.provenance?.complete === true &&
    input.differential?.fullyEvaluated === true &&
    input.differential?.criterionExplicit === true &&
    (input.differential?.smoothedDivergences.length ?? 0) === 0;
  const landedCorrectly = shouldLand
    ? input.ledgerLanding?.accepted === true
    : input.ledgerLanding === null;
  criteria.push({
    criterionId: "ledger-landing",
    strategy: "deterministic",
    status: landedCorrectly ? "PASS" : "FAIL",
    evidence: [
      `proposal:${row.sourceProposalId}`,
      `shouldLand:${String(shouldLand)}`,
      `accepted:${String(input.ledgerLanding?.accepted ?? false)}`,
      `replayed:${String(input.ledgerLanding?.replayed ?? false)}`,
      landedCorrectly
        ? "the-verdict-appended-to-the-candidate-lifecycle (append-only, never rewriting a proposal)"
        : "LEDGER-LANDING-MISMATCH (a trustworthy verdict never landed, or an untrustworthy one did)",
    ],
  });

  // 7. The read-only registry (the VAL-032 entries are frozen inputs).
  criteria.push({
    criterionId: "registry-read-only",
    strategy: "deterministic",
    status: input.registryUnchanged ? "PASS" : "FAIL",
    evidence: [
      `registryUnchanged:${String(input.registryUnchanged)}`,
      input.registryUnchanged
        ? "the-candidate-registrys-existing-entries-are-read-only-inputs"
        : "REGISTRY-MUTATION (the run rewrote a proposal — the equivalence verdict APPENDS, never rewrites)",
    ],
  });

  // 8. The expected-verdict contract (the observed verdict is the pinned oracle).
  const verdictMatches =
    input.verdict === row.expected.verdict &&
    (input.refusal === null
      ? row.expected.refusalReason === null
      : input.refusal.reason === row.expected.refusalReason) &&
    (input.differential === null
      ? row.expected.divergenceCaseIds.length === 0
      : JSON.stringify(input.differential.divergences.map((divergence) => divergence.caseId)) ===
        JSON.stringify(row.expected.divergenceCaseIds));
  criteria.push({
    criterionId: "equivalence-verdict-contract",
    strategy: "deterministic",
    status: verdictMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedVerdict:${row.expected.verdict}`,
      `observedVerdict:${input.verdict}`,
      `expectedRefusal:${row.expected.refusalReason ?? "none"}`,
      `observedRefusal:${input.refusal?.reason ?? "none"}`,
      `expectedDivergences:${row.expected.divergenceCaseIds.join(",") || "none"}`,
      `observedDivergences:${input.differential?.divergences.map((divergence) => divergence.caseId).join(",") || "none"}`,
      verdictMatches
        ? "the-equivalence-run-reproduces-the-pinned-verdict"
        : "VERDICT-MISMATCH (the observed verdict differs from the pinned oracle)",
    ],
  });

  // 9. The outcome well-formedness (a refusal XOR an evaluation).
  const wellFormed = (input.refusal !== null) !== (input.differential !== null);
  criteria.push({
    criterionId: "equivalence-outcome-well-formed",
    strategy: "deterministic",
    status: wellFormed ? "PASS" : "FAIL",
    evidence: [
      `refusal:${input.refusal !== null ? "reported" : "none"}`,
      `evaluation:${input.differential !== null ? "emitted" : "none"}`,
      wellFormed
        ? "exactly-one-outcome (an evaluation or a refusal, never both, never neither)"
        : "MALFORMED-OUTCOME (the run emitted both or neither)",
    ],
  });

  // 10. The payload-free digest discipline (every digest is 8-hex FNV-1a).
  const digestsUnderTest = [
    ...row.differentialPopulation.map((dcase) => dcase.inputDigest),
    ...row.differentialPopulation.map((dcase) => dcase.incumbentDigest),
    ...row.differentialPopulation.flatMap((dcase) => dcase.classDigests),
    ...(input.differential?.divergences.map((divergence) => divergence.replacementDigest) ?? []),
  ];
  const digestsWellFormed = digestsUnderTest.every((digest) => /^[0-9a-f]{8}$/.test(digest));
  criteria.push({
    criterionId: "payload-free-digest-discipline",
    strategy: "deterministic",
    status: digestsWellFormed ? "PASS" : "FAIL",
    evidence: [
      `digests:${digestsUnderTest.length}`,
      digestsWellFormed
        ? "digests-only (payload bytes never enter the evidence — both sides' outcomes digest-recorded)"
        : "MALFORMED-DIGEST (an outcome digest is not a payload-free FNV-1a digest)",
    ],
  });

  // 11. The run's own dispatch total (offline zero; the live row's confirmation).
  criteria.push({
    criterionId: "equivalence-own-dispatch-total",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-equivalence-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side equivalence contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/** One equivalence run's app-side observation (the public-boundary read). */
export interface AppEquivalenceObservation {
  /** The durable execution the equivalence submission landed. */
  readonly executionId: string;
  /** True when the submission key REPLAYED an existing execution (a shoulder-in). */
  readonly replayed: boolean;
  readonly rejection: { readonly code: string } | null;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The verdict read back from the public result read (null when unreadable). */
  readonly verdict: {
    readonly kind: string;
    readonly refusalReason: string | null;
    readonly divergenceCaseIds: readonly string[];
    readonly escapeDirections: readonly string[];
  } | null;
  /** The lifecycle landing read back from the public result read. */
  readonly lifecycleLanding: {
    readonly proposalId: string;
    readonly finalStage: string;
  } | null;
  /** The read-back per-case outcomes (both sides' digests — the boundary re-derivation basis). */
  readonly outcomes: readonly {
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
    readonly claimedEquivalent: boolean;
  }[];
  /** The capabilities the read-back reports the replacement exercising. */
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
}

/**
 * Judge the app-side observations against the row's equivalence
 * contract (PURE): the submission landed its OWN durable execution,
 * the terminal↔criteria agreement and the expected terminal hold, the
 * read-back verdict matches the row's pinned oracle (the kind, the
 * refusal reason and the divergent cases), the read-back lifecycle
 * landing is the equivalence stage ONLY (a landing past
 * differentially-evaluated never passes), the differential evaluation
 * is RE-DERIVED at the boundary over the row's declared population
 * and the READ-BACK outcome digests (never trusting the platform's
 * claimed verdict — an unchecked criterion or a smoothed divergence
 * never passes), the isolation is re-derived at the boundary over the
 * read-back exercised capabilities (a containment escape never
 * passes), the run made its OWN dispatches, and the app-side
 * trajectory digest over the public events read is a member of the
 * row's pinned equivalence-trajectory class.
 */
export function verifyEquivalenceTestingAppContract(input: {
  readonly row: EquivalenceCorpusRow;
  readonly observation: AppEquivalenceObservation;
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
        ? "the-equivalence-submission-landed-its-own-execution"
        : "REJECTED (the equivalence submission never landed a durable execution)",
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
      `note:an honest divergence FAILs honestly; an honest refusal is a COMPLETED run`,
    ],
  });

  // 4. The read-back verdict matches the pinned oracle.
  if (observation.verdict !== null) {
    const kindMatches = observation.verdict.kind === row.expected.verdict;
    criteria.push({
      criterionId: "app-verdict-kind-pinned",
      strategy: "deterministic",
      status: kindMatches ? "PASS" : "FAIL",
      evidence: [
        `expected:${row.expected.verdict}`,
        `observed:${observation.verdict.kind}`,
        kindMatches
          ? "the-read-back-verdict-matches-the-pin"
          : "VERDICT-MISMATCH (the read-back verdict differs from the pinned oracle)",
      ],
    });
    if (row.expected.refusalReason !== null) {
      criteria.push({
        criterionId: "app-refusal-reason-pinned",
        strategy: "deterministic",
        status: observation.verdict.refusalReason === row.expected.refusalReason ? "PASS" : "FAIL",
        evidence: [
          `expected:${row.expected.refusalReason}`,
          `observed:${observation.verdict.refusalReason ?? "none"}`,
        ],
      });
    }
    if (row.expected.verdict === "honest-divergence") {
      const divergencesMatch =
        JSON.stringify([...observation.verdict.divergenceCaseIds]) ===
        JSON.stringify([...row.expected.divergenceCaseIds]);
      criteria.push({
        criterionId: "app-divergence-cases-pinned",
        strategy: "deterministic",
        status: divergencesMatch ? "PASS" : "FAIL",
        evidence: [
          `expected:${row.expected.divergenceCaseIds.join(",") || "none"}`,
          `observed:${observation.verdict.divergenceCaseIds.join(",") || "none"}`,
          divergencesMatch
            ? "the-honest-divergence-is-recorded-case-by-case (never smoothed)"
            : "DIVERGENCE-MISMATCH (the recorded divergence differs from the pinned oracle)",
        ],
      });
    }
  }

  // 5. The lifecycle landing: the equivalence stage ONLY (never beyond).
  if (observation.lifecycleLanding !== null) {
    const landingOk =
      observation.lifecycleLanding.proposalId === row.sourceProposalId &&
      observation.lifecycleLanding.finalStage === EQUIVALENT_STAGE;
    criteria.push({
      criterionId: "app-lifecycle-landing-equivalence-stage-only",
      strategy: "deterministic",
      status: landingOk ? "PASS" : "FAIL",
      evidence: [
        `proposal:${observation.lifecycleLanding.proposalId}`,
        `finalStage:${observation.lifecycleLanding.finalStage}`,
        `equivalentStage:${EQUIVALENT_STAGE}`,
        landingOk
          ? "equivalence-verified-only (the candidate lifecycle lands at differentially-evaluated — shadow/canary/promotion are later slices)"
          : "OUT-OF-SCOPE-LANDING (the candidate landed past the equivalence stage — a skipped-stage promotion never passes)",
      ],
    });
  } else if (row.expected.verdict !== "honest-refusal") {
    criteria.push({
      criterionId: "app-lifecycle-landing-present",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-LANDING (an evaluated verdict must append to the candidate lifecycle)",
      ],
    });
  }

  // 6. The differential evaluation RE-DERIVED at the boundary (never
  //    trusting the platform's claim).
  if (observation.outcomes.length > 0) {
    const boundaryDifferential = deriveDifferentialEquivalence({
      population: row.differentialPopulation,
      criterion: row.acceptanceCriterion,
      incumbentOutcomes: observation.outcomes.map((outcome) => ({
        caseId: outcome.caseId,
        digest: outcome.incumbentDigest,
      })),
      replacementOutcomes: observation.outcomes.map((outcome) => ({
        caseId: outcome.caseId,
        digest: outcome.replacementDigest,
        claimedEquivalent: outcome.claimedEquivalent,
      })),
      evaluatedCaseIds: observation.outcomes.map((outcome) => outcome.caseId),
    });
    criteria.push(
      ...boundaryDifferential.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
    // 7. The isolation re-derived at the boundary.
    const boundaryIsolation = deriveReplacementIsolation({
      declaredCapabilities: row.declaredCapabilities,
      grantedSurface: row.grantedIsolationSurface,
      exercisedCapabilities: observation.exercisedCapabilities,
    });
    criteria.push(
      ...boundaryIsolation.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  } else if (row.expected.verdict !== "honest-refusal") {
    criteria.push({
      criterionId: "app-outcomes-readable",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-OUTCOMES (the boundary could not read both sides' outcome digests)",
      ],
    });
  }

  // 8. The run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-equivalence-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // 9. The app-side trajectory membership (never trust the platform's claim).
  const inClass =
    observation.trajectoryDigest !== null &&
    row.expectedTrajectoryClass.includes(observation.trajectoryDigest);
  criteria.push({
    criterionId: "app-equivalence-trajectory-in-class",
    strategy: "deterministic",
    status: inClass ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${observation.trajectoryDigest ?? "none"}`,
      `classSize:${row.expectedTrajectoryClass.length}`,
      inClass
        ? "in-class (the app re-derived the equivalence trajectory over the public journal)"
        : "OUT-OF-CLASS (the observed equivalence trajectory drifted from the pinned class)",
    ],
  });

  return criteria;
}
