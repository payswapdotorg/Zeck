/**
 * The platform-side shadow deterministic-execution engine (VAL-034).
 *
 * The mechanical engine of the shadow slice: it takes VAL-033's
 * DIFFERENTIALLY-EVALUATED candidates (the lifecycle identities whose
 * recorded walk already ends at `differentially-evaluated` — the
 * READ-ONLY input; a recorded walk is never rewritten) and runs the
 * deterministic replacement IN THE SHADOW: every shadow execution
 * drives the INCUMBENT path (the served leg) AND the deterministic
 * REPLACEMENT path (the observation leg) over the SAME traffic
 * population — the recorded workload mix (VAL-031's recorded replay
 * populations) plus the pinned injected traffic probes — and produces
 * the REGRESSION COMPARISON: the per-case shadow-vs-incumbent outcome
 * agreement under the row's EXPLICIT comparison criterion, the measured
 * latency and cost deltas, and the divergence ledger. The replacement's
 * outcomes are recorded but NEVER served to the customer (the
 * incumbent's outcome is always the served one — the served-source pin).
 *
 * The shadow oracle (the PURE derivations that make a regression
 * comparison trustworthy):
 *
 *   * `deriveServingIsolation` — the served outcome must be the
 *     INCUMBENT's: a served outcome sourced from the replacement (an
 *     EXPLICIT leak) or a served digest that is the shadow's own (a
 *     DISGUISED leak) FAILs mechanically with the leak named; the
 *     shadow's outcome is observation-only;
 *   * `deriveShadowPopulationCompleteness` — the shadow comparison
 *     must cover the FULL traffic population: a dropped case, a
 *     duplicated case or a population that does not match the recorded
 *     workload mix FAILs (the VAL-031 population-completeness pattern
 *     carried into the shadow);
 *   * `deriveRegressionHonesty` — the regression evidence is PER-CASE:
 *     an asserted AGGREGATE without per-case records FAILs, an asserted
 *     agreement drawn from a subset of the population FAILs, a
 *     divergent case claimed agreeing (a smoothed divergence) FAILs and
 *     an agreeing case claimed diverging (a false divergence) FAILs;
 *     every divergence is recorded case-by-case with BOTH sides'
 *     digests — never smoothed, never aggregated away;
 *   * `deriveShadowCostSeparation` — the shadow's measured cost is
 *     booked to the SHADOW ledger, never the served accounting: a
 *     served total inflated by the shadow cost (a BILLED shadow) FAILs,
 *     and an unmeasured or unbooked shadow cost FAILs (the customer is
 *     never billed for the shadow);
 *   * `deriveShadowStageDiscipline` — the lifecycle append is
 *     `differentially-evaluated → shadow-executed` ONLY, with its
 *     evidence digest: any jump past shadow-executed (canaried or
 *     promoted — VAL-035's scope) FAILs, an evidence-less transition
 *     FAILs, and a candidate whose recorded walk has not yet reached
 *     `differentially-evaluated` FAILs (a premature shadow);
 *   * `deriveShadowRefusalHonesty` — an honest refusal is justified
 *     only by the registry's/lifecycle's own state (an unregistered
 *     candidate, or one not yet differentially evaluated).
 *
 * The isolation discipline carries into the shadow (the containment
 * carry-over): the replacement still runs inside its GRANTED isolation
 * surface DURING the shadow — an escape mid-shadow is a containment
 * violation that FAILs and is recorded (VAL-033's
 * `deriveReplacementIsolation` is reused verbatim).
 *
 * Digest discipline: every identity, citation, comparison and cost
 * entry carries an FNV-1a payload-free digest; payload bytes never
 * enter the evidence. Latency is always measured; usage is honestly
 * none-reported offline and measured only on the live rail.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";
import type {
  AcceptanceCriterion,
  CandidateLifecycleLedgerPort,
  ContainmentVerdict,
  DifferentialCase,
  EquivalenceRegistryFacts,
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
  ReplacementIsolationVerdict,
  ReplacementShape,
} from "./equivalence-testing";
import {
  criterionSatisfiedForCase,
  deriveReplacementIsolation,
  differentialPopulationDigestOf,
  EQUIVALENT_STAGE,
  equivalenceRegistryDigestOf,
  lifecycleEvidenceDigestOf,
  OFFLINE_REPLAY_STAGE,
  referenceReplacementOutcomeDigestOf,
} from "./equivalence-testing";
import type { CandidateLifecycleStage, DiscoveryProposalRecord } from "./learning-discovery";
import { CANDIDATE_LIFECYCLE_STAGES } from "./learning-discovery";
import type { ControlDispatch, TrajectoryStepRecord } from "./longitudinal-baseline";
import { isRetryableDispatchCategory, longitudinalDigestOf } from "./longitudinal-baseline";

// ---------------------------------------------------------------------------
// The shadow vocabulary (the observation-only grammar)
// ---------------------------------------------------------------------------

/**
 * The shadow phase's learning mode: the shadow OBSERVES and RECORDS —
 * it runs the replacement beside the incumbent over the live traffic,
 * records the regression comparison and appends its stage transition;
 * it never serves (the served outcome is always the incumbent's) and
 * never promotes (canary and promotion are VAL-035's scope).
 */
export const SHADOW_LEARNING_PHASE = "shadow" as const;

/** The longitudinal-experiment kind every shadow run registers as. */
export const SHADOW_EXPERIMENT_KIND = "shadow-execution";

/**
 * The shadow-mode vocabulary: the shadow runs BESIDE the incumbent in
 * OBSERVATION-ONLY mode — its outcomes are recorded for the regression
 * comparison and never served. A "serving" shadow is not a mode: it is
 * a LEAK, caught mechanically by `deriveServingIsolation` (the
 * served-source pin below).
 */
export const SHADOW_MODES = ["observation-only"] as const;

export type ShadowMode = (typeof SHADOW_MODES)[number];

export function isShadowMode(value: string): value is ShadowMode {
  return (SHADOW_MODES as readonly string[]).includes(value);
}

/**
 * The served-outcome source vocabulary: the outcome handed to the
 * customer is sourced either from the INCUMBENT (the pin — always) or
 * from the REPLACEMENT (a leaked shadow — never legal).
 */
export const SERVED_SOURCE_VALUES = ["incumbent", "replacement"] as const;

export type ServedSource = (typeof SERVED_SOURCE_VALUES)[number];

export function isServedSource(value: string): value is ServedSource {
  return (SERVED_SOURCE_VALUES as readonly string[]).includes(value);
}

/**
 * The SERVED-SOURCE PIN: the customer-facing outcome is ALWAYS the
 * incumbent's. A served outcome sourced from the replacement (the
 * shadow leaking into the serving path) FAILs mechanically with the
 * leak named — the shadow is observation-only.
 */
export const SERVED_SOURCE_PIN: ServedSource = "incumbent";

/** The observation source of the shadow leg's recorded outcomes (never served). */
export const SHADOW_OBSERVATION_SOURCE = "replacement" as const;

/**
 * The shadow verdict kinds (the per-row outcome vocabulary):
 *
 *   * `shadow-agreement` — the shadow reproduced the incumbent's
 *     outcomes over the full traffic population under the row's
 *     explicit comparison criterion (a clean regression comparison);
 *   * `honest-divergence` — shadow cases diverged from the criterion
 *     and every divergence is RECORDED case-by-case with both sides'
 *     digests (never smoothed) — the row FAILs honestly but the shadow
 *     still landed (the comparison is the record);
 *   * `containment-violation` — the replacement escaped its granted
 *     isolation surface MID-SHADOW (the containment carry-over);
 *   * `honest-refusal` — the candidate's own lifecycle state does not
 *     support a shadow run (unregistered, or not yet
 *     differentially-evaluated) and the run refused honestly;
 *   * `shadow-invalid` — the run's mechanical shape is untrustworthy (a
 *     leaked serve, a partial population, an aggregate-only or smoothed
 *     regression claim, a billed shadow, a broken stage walk): an
 *     internal honesty failure, never a passable outcome.
 */
export const SHADOW_VERDICTS = [
  "shadow-agreement",
  "honest-divergence",
  "containment-violation",
  "honest-refusal",
  "shadow-invalid",
] as const;

export type ShadowVerdictKind = (typeof SHADOW_VERDICTS)[number];

export function isShadowVerdictKind(value: string): value is ShadowVerdictKind {
  return (SHADOW_VERDICTS as readonly string[]).includes(value);
}

/**
 * The honest refusal reasons (a shadow run refuses only when the
 * candidate's own recorded state genuinely justifies it):
 *
 *   * `candidate-unregistered` — the cited candidate identity is not a
 *     member of the candidate registry (a phantom candidate);
 *   * `candidate-not-differentially-evaluated` — the candidate's
 *     recorded lifecycle walk has not yet reached the
 *     `differentially-evaluated` stage (VAL-033's landing) — a
 *     premature shadow refuses honestly.
 */
export const SHADOW_REFUSAL_REASONS = [
  "candidate-unregistered",
  "candidate-not-differentially-evaluated",
] as const;

export type ShadowRefusalReason = (typeof SHADOW_REFUSAL_REASONS)[number];

export function isShadowRefusalReason(value: string): value is ShadowRefusalReason {
  return (SHADOW_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The shadow-probe kinds the corpus declares (the vocabulary the later
 * discrimination phases drive over the adversarial fixture variants —
 * designed here, pinned now):
 *
 *   * `leaked-outcome` — the serving path serves the REPLACEMENT's
 *     outcome (the shadow leaking into the customer path — FAILs);
 *   * `dropped-case` — the traffic source drops (or duplicates, or
 *     swaps) a case of the recorded workload mix (a partial shadow
 *     population — FAILs);
 *   * `smoothed-aggregate` — the regression claim is an aggregate
 *     without the per-case records, or a subset-agreement, or a
 *     divergent case claimed agreeing (FAILs);
 *   * `billed-shadow` — the shadow's cost is booked onto the served
 *     accounting rails (the customer billed for the shadow — FAILs);
 *   * `skipped-stage` — the lifecycle append jumps past
 *     shadow-executed (canaried/promoted) or lands evidence-less, or
 *     rewrites the registry (FAILs);
 *   * `mid-shadow-escape` — the replacement exercises a capability
 *     outside its granted surface DURING the shadow (a containment
 *     violation — FAILs).
 */
export const SHADOW_PROBE_KINDS = [
  "leaked-outcome",
  "dropped-case",
  "smoothed-aggregate",
  "billed-shadow",
  "skipped-stage",
  "mid-shadow-escape",
] as const;

export type ShadowProbeKind = (typeof SHADOW_PROBE_KINDS)[number];

export function isShadowProbeKind(value: string): value is ShadowProbeKind {
  return (SHADOW_PROBE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The lifecycle ladder (the shadow slice's walk)
// ---------------------------------------------------------------------------

/**
 * The lifecycle stage a shadow run lands a candidate at: the ONLY
 * stage this slice advances to. The walk is
 * `differentially-evaluated → shadow-executed` — NEVER beyond
 * (canaried and promoted are VAL-035's scope; a skipped-stage advance
 * FAILs mechanically).
 */
export const SHADOW_STAGE: CandidateLifecycleStage = "shadow-executed";

/**
 * The ONLY lifecycle stage a shadow run may advance FROM: VAL-033's
 * landing. A candidate whose recorded walk has not yet reached it is
 * premature and refuses honestly.
 */
export const SHADOW_SOURCE_STAGE: CandidateLifecycleStage = "differentially-evaluated";

/** The ladder index of a stage (its position on the pinned candidate ladder). */
export function lifecycleStageIndexOf(stage: CandidateLifecycleStage): number {
  return (CANDIDATE_LIFECYCLE_STAGES as readonly string[]).indexOf(stage);
}

/**
 * Whether a lifecycle stage is BEYOND the shadow slice's scope (any
 * stage past `shadow-executed` on the pinned ladder — canary and
 * promotion). A shadow run that advances a candidate to any of these
 * FAILs the stage discipline mechanically (a skipped-stage promotion).
 */
export function isBeyondShadowScope(stage: CandidateLifecycleStage): boolean {
  return lifecycleStageIndexOf(stage) > lifecycleStageIndexOf(SHADOW_STAGE);
}

// ---------------------------------------------------------------------------
// The traffic-case vocabulary (the workload mix under the shadow)
// ---------------------------------------------------------------------------

/**
 * ONE traffic case — the unit of the shadow's traffic population: a
 * historical replay input (a cited VAL-031 replay identity with its
 * recorded incumbent outcome digest) or a pinned injected traffic
 * probe (with its pinned incumbent digest and digest class). The
 * shadow drives BOTH paths (incumbent + replacement) over the SAME
 * cases. The shape is VAL-033's differential case verbatim — the
 * shadow population consumes the recorded populations' output.
 */
export type ShadowTrafficCase = DifferentialCase;

/** The canonical digest over one traffic case (PURE — FNV-1a, payload-free). */
export function shadowTrafficCaseDigestOf(tcase: ShadowTrafficCase): string {
  return longitudinalDigestOf([
    "shadow-traffic-case",
    tcase.caseId,
    tcase.source,
    tcase.inputDigest,
    tcase.incumbentDigest,
    [...tcase.classDigests].sort(),
  ]);
}

/**
 * The canonical digest over a shadow traffic population (PURE,
 * payload-free — the population digest every trajectory and lifecycle
 * append carries).
 */
export function shadowPopulationDigestOf(population: readonly ShadowTrafficCase[]): string {
  return differentialPopulationDigestOf(population);
}

/** One executed leg's outcome for one traffic case (digests only). */
export interface ShadowCaseOutcome {
  readonly caseId: string;
  readonly digest: string;
}

/**
 * One per-case regression comparison record (the divergence-ledger
 * record shape): both sides' digests and the run's own agreement claim
 * (cross-checked mechanically — never trusted).
 */
export interface ShadowComparisonRecord {
  readonly caseId: string;
  readonly incumbentDigest: string;
  readonly shadowDigest: string;
  /** The run's OWN claimed agreement for the case (the smoothing cross-check). */
  readonly agrees: boolean;
}

/** The canonical digest over one comparison record (PURE, payload-free). */
export function shadowComparisonDigestOf(record: ShadowComparisonRecord): string {
  return longitudinalDigestOf([
    "shadow-comparison",
    record.caseId,
    record.incumbentDigest,
    record.shadowDigest,
    record.agrees,
  ]);
}

/**
 * ONE recorded shadow divergence (the append-only divergence ledger's
 * record): the case id and BOTH sides' outcome digests — recorded
 * case-by-case, never smoothed, never aggregated away.
 */
export interface ShadowDivergenceRecord {
  readonly proposalId: string;
  readonly caseId: string;
  readonly incumbentDigest: string;
  readonly shadowDigest: string;
  /** 1-based append order within the candidate's divergence ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one divergence record (PURE, payload-free). */
export function shadowDivergenceDigestOf(record: Omit<ShadowDivergenceRecord, "ordinal">): string {
  return longitudinalDigestOf([
    "shadow-divergence",
    record.proposalId,
    record.caseId,
    record.incumbentDigest,
    record.shadowDigest,
  ]);
}

/**
 * The shadow's OWN measured cost + latency (measured SEPARATELY from
 * the served accounting — the shadow-cost measurement shape). The
 * customer is never billed for these; they book to the shadow cost
 * ledger.
 */
export interface ShadowCostMeasurement {
  readonly microUsd: number;
  readonly latencyMs: number;
}

/** The served accounting's snapshot (the customer-facing bill basis). */
export interface ServedAccountingSnapshot {
  /** The incumbent's own measured cost (the honest served basis). */
  readonly incumbentMicroUsd: number;
  /** What the served accounting bills in total (must equal the incumbent basis). */
  readonly billedMicroUsd: number;
  readonly latencyMs: number;
}

/** ONE booked shadow-cost ledger entry (the append-only shadow cost ledger). */
export interface ShadowCostLedgerEntry {
  readonly proposalId: string;
  readonly microUsd: number;
  readonly latencyMs: number;
  /** 1-based append order within the candidate's cost ledger. */
  readonly ordinal: number;
}

/** The canonical digest over one shadow-cost ledger entry (PURE, payload-free). */
export function shadowCostDigestOf(entry: Omit<ShadowCostLedgerEntry, "ordinal">): string {
  return longitudinalDigestOf(["shadow-cost", entry.proposalId, entry.microUsd, entry.latencyMs]);
}

/**
 * ONE customer-facing served outcome (the serving-isolation basis):
 * the case id, the outcome's SOURCE (`incumbent` — the pin — or
 * `replacement` — a leak) and the served digest.
 */
export interface ServedOutcomeRecord {
  readonly caseId: string;
  readonly servedSource: string;
  readonly servedDigest: string;
}

// ---------------------------------------------------------------------------
// Serving isolation (the served outcome is ALWAYS the incumbent's)
// ---------------------------------------------------------------------------

/** The serving-isolation verdict (the leak oracle). */
export interface ServingIsolationVerdict {
  /** The served outcomes are all the incumbent's (no leak, no wrong serve). */
  readonly isolated: boolean;
  /** The leak kind (an explicit replacement-sourced serve, or a disguised digest leak). */
  readonly leakKind: "explicit-leak" | "disguised-leak" | null;
  /** The cases whose served outcome was sourced from the replacement (the named leaks). */
  readonly leakedCaseIds: readonly string[];
  /** The cases served a digest that is neither the incumbent's nor the shadow's (a wrong serve). */
  readonly wrongServeCaseIds: readonly string[];
  /** The traffic cases never served at all (a missing serve). */
  readonly unservedCaseIds: readonly string[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the serving isolation (PURE — the shadow's first oracle): the
 * served outcome must be the INCUMBENT's on EVERY traffic case — a
 * served outcome sourced from the replacement (an EXPLICIT leak: the
 * shadow leaking into the serving path) FAILs mechanically with the
 * leak named; a served digest that is the SHADOW's own while claiming
 * the incumbent source (a DISGUISED leak) FAILs just the same; any
 * other digest is a WRONG serve; an unserved case FAILs. The shadow's
 * outcome is OBSERVATION-ONLY: it never affects the served outcome,
 * and its recording is the regression comparison's basis — never a
 * serving input.
 */
export function deriveServingIsolation(input: {
  /** The shadow's traffic population (the full recorded mix). */
  readonly population: readonly ShadowTrafficCase[];
  /** The incumbent leg's executed outcome digests. */
  readonly incumbentOutcomes: readonly ShadowCaseOutcome[];
  /** The shadow leg's executed outcome digests (the observation-only side). */
  readonly shadowOutcomes: readonly ShadowCaseOutcome[];
  /** The customer-facing served outcomes (source + digest per case). */
  readonly servedOutcomes: readonly ServedOutcomeRecord[];
}): ServingIsolationVerdict {
  const incumbentByCase = new Map(
    input.incumbentOutcomes.map((outcome) => [outcome.caseId, outcome.digest]),
  );
  const shadowByCase = new Map(
    input.shadowOutcomes.map((outcome) => [outcome.caseId, outcome.digest]),
  );
  const servedByCase = new Map(input.servedOutcomes.map((outcome) => [outcome.caseId, outcome]));

  const explicitLeakCaseIds: string[] = [];
  const disguisedLeakCaseIds: string[] = [];
  const wrongServeCaseIds: string[] = [];
  const unservedCaseIds: string[] = [];

  for (const tcase of input.population) {
    const served = servedByCase.get(tcase.caseId);
    if (served === undefined) {
      unservedCaseIds.push(tcase.caseId);
      continue;
    }
    if (served.servedSource !== SERVED_SOURCE_PIN) {
      explicitLeakCaseIds.push(tcase.caseId);
      continue;
    }
    const incumbentDigest = incumbentByCase.get(tcase.caseId);
    const shadowDigest = shadowByCase.get(tcase.caseId);
    if (served.servedDigest !== incumbentDigest) {
      if (shadowDigest !== undefined && served.servedDigest === shadowDigest) {
        // The serve claims the incumbent source but carries the
        // shadow's own digest — a disguised leak.
        disguisedLeakCaseIds.push(tcase.caseId);
      } else {
        wrongServeCaseIds.push(tcase.caseId);
      }
    }
  }

  const leakedCaseIds = [...explicitLeakCaseIds, ...disguisedLeakCaseIds];
  const leakKind =
    explicitLeakCaseIds.length > 0
      ? "explicit-leak"
      : disguisedLeakCaseIds.length > 0
        ? "disguised-leak"
        : null;
  const isolated =
    leakedCaseIds.length === 0 && wrongServeCaseIds.length === 0 && unservedCaseIds.length === 0;

  return {
    isolated,
    leakKind,
    leakedCaseIds,
    wrongServeCaseIds,
    unservedCaseIds,
    criteria: [
      {
        criterionId: "serving-source-pinned-incumbent",
        strategy: "deterministic",
        status: explicitLeakCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `servedSourcePin:${SERVED_SOURCE_PIN}`,
          `servedOutcomes:${input.servedOutcomes.length}`,
          `population:${input.population.length}`,
          explicitLeakCaseIds.length === 0
            ? "every-served-outcome-is-sourced-from-the-incumbent (the served-source pin)"
            : `LEAKED-SHADOW (the served outcome was sourced from the replacement on cases ${explicitLeakCaseIds.join(",")} — the shadow is observation-only, never a serving source)`,
        ],
      },
      {
        criterionId: "serving-digest-is-incumbents",
        strategy: "deterministic",
        status:
          disguisedLeakCaseIds.length === 0 && wrongServeCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `disguisedLeaks:${disguisedLeakCaseIds.join(",") || "none"}`,
          `wrongServes:${wrongServeCaseIds.join(",") || "none"}`,
          disguisedLeakCaseIds.length > 0
            ? `LEAKED-SHADOW-DISGUISED (the serve claims the incumbent source but carries the shadow's own digest on cases ${disguisedLeakCaseIds.join(",")})`
            : wrongServeCaseIds.length > 0
              ? `WRONG-SERVE (the served digest is neither the incumbent's nor the shadow's on cases ${wrongServeCaseIds.join(",")})`
              : "every-served-digest-is-the-incumbents-executed-digest",
        ],
      },
      {
        criterionId: "serving-every-case-served",
        strategy: "deterministic",
        status: unservedCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `unservedCaseIds:${unservedCaseIds.join(",") || "none"}`,
          unservedCaseIds.length === 0
            ? "every-traffic-case-was-served-from-the-incumbent-path"
            : "UNSERVED-CASE (a traffic case of the recorded mix was never served)",
        ],
      },
      {
        criterionId: "serving-isolation-summary",
        strategy: "deterministic",
        status: isolated ? "PASS" : "FAIL",
        evidence: [
          `isolated:${String(isolated)}`,
          `leakKind:${leakKind ?? "none"}`,
          `leakedCaseIds:${leakedCaseIds.join(",") || "none"}`,
          `wrongServeCaseIds:${wrongServeCaseIds.length}`,
          `unservedCaseIds:${unservedCaseIds.length}`,
          isolated
            ? "serving-isolated (the shadow's outcome never reached the customer path — observation-only)"
            : "SHADOW-LEAK (the shadow leaked into the serving path — the served outcome must ALWAYS be the incumbent's)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shadow population completeness (the FULL recorded workload mix)
// ---------------------------------------------------------------------------

/** One workload-class bucket of the traffic mix (the recorded mix basis). */
export interface WorkloadMixBucket {
  readonly workloadClass: string;
  readonly count: number;
}

/** The shadow population-completeness verdict. */
export interface ShadowPopulationCompletenessVerdict {
  /** The shadow comparison covers the FULL recorded traffic population, mix included. */
  readonly complete: boolean;
  /** Recorded traffic cases the shadow comparison MISSED (a dropped case). */
  readonly missingCaseIds: readonly string[];
  /** Cases covered MORE THAN ONCE (a duplicated case). */
  readonly duplicatedCaseIds: readonly string[];
  /** Covered cases that are NOT members of the recorded population (a swapped/foreign case). */
  readonly foreignCaseIds: readonly string[];
  /** The recorded workload mix (per class). */
  readonly recordedMix: readonly WorkloadMixBucket[];
  /** The observed workload mix (per class — the recorded basis for foreign cases). */
  readonly observedMix: readonly WorkloadMixBucket[];
  /** Whether the observed mix matches the recorded mix exactly. */
  readonly mixMatches: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the shadow population completeness (PURE — the shadow's
 * population oracle, the VAL-031 pattern carried into the shadow): the
 * shadow comparison must cover the FULL traffic population — every
 * recorded case of the workload mix the row replays. A DROPPED case
 * (a recorded case the comparison never covered) FAILs; a DUPLICATED
 * case (a case compared more than once — an inflated mix weight)
 * FAILs; a FOREIGN case (a covered case the recorded population does
 * not hold) FAILs; and a population whose WORKLOAD MIX does not match
 * the recorded mix (per-class counts differ) FAILs even when the total
 * count matches — the shadow replays the recorded mix, not a
 * lookalike.
 */
export function deriveShadowPopulationCompleteness(input: {
  /** The recorded traffic population's case ids (the row's declaration — the mix pin). */
  readonly recordedCaseIds: readonly string[];
  /** The recorded workload class per case id (the mix basis). */
  readonly workloadClassByCaseId: Readonly<Record<string, string>>;
  /** The case ids the shadow comparison actually covered (duplicates visible). */
  readonly observedCaseIds: readonly string[];
}): ShadowPopulationCompletenessVerdict {
  const recorded = [...new Set(input.recordedCaseIds)];
  const observed = [...input.observedCaseIds];

  const missingCaseIds = recorded.filter((caseId) => !observed.includes(caseId));
  const seen = new Map<string, number>();
  for (const caseId of observed) {
    seen.set(caseId, (seen.get(caseId) ?? 0) + 1);
  }
  const duplicatedCaseIds = observed.filter((caseId) => (seen.get(caseId) ?? 0) > 1);
  const foreignCaseIds = [...new Set(observed.filter((caseId) => !recorded.includes(caseId)))];

  const classOf = (caseId: string): string => input.workloadClassByCaseId[caseId] ?? "unrecorded";
  const bucketOf = (caseIds: readonly string[]): WorkloadMixBucket[] => {
    const counts = new Map<string, number>();
    for (const caseId of caseIds) {
      counts.set(classOf(caseId), (counts.get(classOf(caseId)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([workloadClass, count]) => ({ workloadClass, count }))
      .sort((left, right) => left.workloadClass.localeCompare(right.workloadClass));
  };
  const recordedMix = bucketOf(recorded);
  const observedMix = bucketOf([...new Set(observed)]);
  const mixMatches =
    recordedMix.length === observedMix.length &&
    recordedMix.every(
      (bucket, index) =>
        observedMix[index]?.workloadClass === bucket.workloadClass &&
        observedMix[index]?.count === bucket.count,
    );

  const complete =
    missingCaseIds.length === 0 &&
    duplicatedCaseIds.length === 0 &&
    foreignCaseIds.length === 0 &&
    mixMatches;

  return {
    complete,
    missingCaseIds,
    duplicatedCaseIds,
    foreignCaseIds,
    recordedMix,
    observedMix,
    mixMatches,
    criteria: [
      {
        criterionId: "population-no-dropped-case",
        strategy: "deterministic",
        status: missingCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `recordedCases:${recorded.length}`,
          `observedCases:${new Set(observed).size}`,
          `missingCaseIds:${missingCaseIds.join(",") || "none"}`,
          missingCaseIds.length === 0
            ? "the-shadow-comparison-covered-every-recorded-traffic-case"
            : `DROPPED-CASE (the shadow comparison missed recorded traffic cases: ${missingCaseIds.join(",")})`,
        ],
      },
      {
        criterionId: "population-no-duplicated-case",
        strategy: "deterministic",
        status: duplicatedCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `observedTotal:${observed.length}`,
          `duplicatedCaseIds:${[...new Set(duplicatedCaseIds)].join(",") || "none"}`,
          duplicatedCaseIds.length === 0
            ? "no-traffic-case-was-compared-more-than-once"
            : `DUPLICATED-CASE (traffic cases compared more than once — an inflated mix weight: ${[...new Set(duplicatedCaseIds)].join(",")})`,
        ],
      },
      {
        criterionId: "population-no-foreign-case",
        strategy: "deterministic",
        status: foreignCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `foreignCaseIds:${foreignCaseIds.join(",") || "none"}`,
          foreignCaseIds.length === 0
            ? "every-compared-case-is-a-member-of-the-recorded-population"
            : `FOREIGN-CASE (the comparison covered cases the recorded population does not hold: ${foreignCaseIds.join(",")})`,
        ],
      },
      {
        criterionId: "population-workload-mix-matches",
        strategy: "deterministic",
        status: mixMatches ? "PASS" : "FAIL",
        evidence: [
          `recordedMix:${recordedMix.map((b) => `${b.workloadClass}=${b.count}`).join(",") || "none"}`,
          `observedMix:${observedMix.map((b) => `${b.workloadClass}=${b.count}`).join(",") || "none"}`,
          mixMatches
            ? "the-shadow-replays-the-recorded-workload-mix (per-class counts identical)"
            : "MIX-MISMATCH (the shadow population does not match the recorded workload mix — per-class counts differ)",
        ],
      },
      {
        criterionId: "population-completeness-summary",
        strategy: "deterministic",
        status: complete ? "PASS" : "FAIL",
        evidence: [
          `complete:${String(complete)}`,
          `missing:${missingCaseIds.length}`,
          `duplicated:${new Set(duplicatedCaseIds).size}`,
          `foreign:${foreignCaseIds.length}`,
          `mixMatches:${String(mixMatches)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Regression honesty (per-case evidence, never smoothed aggregates)
// ---------------------------------------------------------------------------

/** The runtime's asserted aggregate regression claim (cross-checked, never trusted). */
export interface ShadowAggregateClaim {
  readonly assertedAgreement: boolean;
  readonly assertedDivergenceCount: number;
}

/** The regression-honesty verdict (the per-case evidence oracle). */
export interface RegressionHonestyVerdict {
  /** The regression evidence is complete, per-case, unsmoothed and aggregate-consistent. */
  readonly honest: boolean;
  /** Every traffic case holds a per-case comparison record (no aggregate-only claims). */
  readonly perCaseEvidenceComplete: boolean;
  /** Recorded cases whose per-case record is MISSING (an aggregate-only or subset claim). */
  readonly missingCaseIds: readonly string[];
  /** Compared cases that are not members of the population (fabricated evidence). */
  readonly foreignCaseIds: readonly string[];
  /** Divergent cases the run CLAIMED agreeing (a smoothed divergence). */
  readonly smoothedCaseIds: readonly string[];
  /** Agreeing cases the run CLAIMED diverging (a false-divergence claim). */
  readonly falseDivergenceCaseIds: readonly string[];
  /** Whether the run asserted ANY aggregate at all (an absent aggregate FAILs). */
  readonly aggregatePresent: boolean;
  /** Whether the asserted aggregate matches the mechanical evaluation. */
  readonly aggregateMatches: boolean;
  /** The mechanically-evaluated divergent case ids (the honest record, case-by-case). */
  readonly mechanicalDivergenceCaseIds: readonly string[];
  /** The canonical digest over this verdict (payload-free). */
  readonly digest: string;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the regression honesty (PURE — the shadow's evidence
 * oracle): the regression comparison's evidence is PER-CASE — every
 * traffic case of the population holds a comparison record with BOTH
 * sides' digests. An asserted AGGREGATE without the per-case records
 * (an aggregate-only claim) FAILs with the missing cases named; an
 * asserted agreement drawn from a SUBSET of the population FAILs just
 * the same; a divergent case claimed agreeing (a SMOOTHED divergence)
 * FAILs and an agreeing case claimed diverging (a FALSE divergence)
 * FAILs — every divergence is recorded case-by-case with both sides'
 * digests, never smoothed; a record for a case outside the population
 * is FABRICATED evidence and FAILs; and the asserted aggregate must
 * MATCH the mechanical evaluation (an aggregate that contradicts the
 * per-case evidence FAILs). Agreement itself is evaluated under the
 * row's EXPLICIT comparison criterion (VAL-033's acceptance-criterion
 * vocabulary, carried into the regression comparison).
 */
export function deriveRegressionHonesty(input: {
  /** The shadow's traffic population (the full recorded mix). */
  readonly population: readonly ShadowTrafficCase[];
  /** The row's EXPLICIT comparison criterion (null = unstated — never satisfied). */
  readonly criterion: AcceptanceCriterion | null;
  /** The incumbent leg's executed outcome digests. */
  readonly incumbentOutcomes: readonly ShadowCaseOutcome[];
  /** The shadow leg's executed outcomes with the run's own agreement claims. */
  readonly shadowOutcomes: readonly (ShadowCaseOutcome & { readonly claimedAgrees: boolean })[];
  /** The cases the run actually compared (the per-case evidence surface). */
  readonly comparedCaseIds: readonly string[];
  /** The run's asserted aggregate (null when none was asserted). */
  readonly aggregateClaim: ShadowAggregateClaim | null;
}): RegressionHonestyVerdict {
  const incumbentByCase = new Map(
    input.incumbentOutcomes.map((outcome) => [outcome.caseId, outcome.digest]),
  );
  const shadowByCase = new Map(input.shadowOutcomes.map((outcome) => [outcome.caseId, outcome]));
  const compared = new Set(input.comparedCaseIds);

  const missingCaseIds = input.population
    .map((tcase) => tcase.caseId)
    .filter((caseId) => !compared.has(caseId));
  const foreignCaseIds = [...new Set(input.comparedCaseIds)].filter(
    (caseId) => !input.population.some((tcase) => tcase.caseId === caseId),
  );
  const perCaseEvidenceComplete = missingCaseIds.length === 0 && foreignCaseIds.length === 0;

  const mechanicalDivergenceCaseIds: string[] = [];
  const smoothedCaseIds: string[] = [];
  const falseDivergenceCaseIds: string[] = [];
  const malformedDigestCaseIds: string[] = [];
  for (const tcase of input.population) {
    const incumbentDigest = incumbentByCase.get(tcase.caseId);
    const shadowOutcome = shadowByCase.get(tcase.caseId);
    if (incumbentDigest === undefined || shadowOutcome === undefined) {
      // An unexecuted leg is a missing outcome (the per-case evidence
      // leg catches the gap; nothing to evaluate here).
      continue;
    }
    if (!/^[0-9a-f]{8}$/.test(incumbentDigest) || !/^[0-9a-f]{8}$/.test(shadowOutcome.digest)) {
      malformedDigestCaseIds.push(tcase.caseId);
    }
    const agreesMechanically = criterionSatisfiedForCase({
      dcase: tcase,
      replacementDigest: shadowOutcome.digest,
      incumbentDigest,
      criterion: input.criterion,
    });
    if (!agreesMechanically) {
      mechanicalDivergenceCaseIds.push(tcase.caseId);
      if (shadowOutcome.claimedAgrees) {
        smoothedCaseIds.push(tcase.caseId);
      }
    } else if (!shadowOutcome.claimedAgrees) {
      falseDivergenceCaseIds.push(tcase.caseId);
    }
  }

  const aggregatePresent = input.aggregateClaim !== null;
  const mechanicalDivergenceCount = mechanicalDivergenceCaseIds.length;
  const aggregateMatches =
    aggregatePresent &&
    input.aggregateClaim !== null &&
    input.aggregateClaim.assertedDivergenceCount === mechanicalDivergenceCount &&
    input.aggregateClaim.assertedAgreement === (mechanicalDivergenceCount === 0);

  const noSmoothing = smoothedCaseIds.length === 0 && falseDivergenceCaseIds.length === 0;
  const honest =
    perCaseEvidenceComplete &&
    noSmoothing &&
    aggregatePresent &&
    aggregateMatches &&
    malformedDigestCaseIds.length === 0;

  const digest = longitudinalDigestOf([
    "shadow-regression",
    input.criterion?.kind ?? null,
    mechanicalDivergenceCaseIds,
    smoothedCaseIds,
    falseDivergenceCaseIds,
    missingCaseIds,
    foreignCaseIds,
    aggregateMatches,
  ]);

  return {
    honest,
    perCaseEvidenceComplete,
    missingCaseIds,
    foreignCaseIds,
    smoothedCaseIds,
    falseDivergenceCaseIds,
    aggregatePresent,
    aggregateMatches,
    mechanicalDivergenceCaseIds,
    digest,
    criteria: [
      {
        criterionId: "regression-per-case-evidence",
        strategy: "deterministic",
        status: perCaseEvidenceComplete ? "PASS" : "FAIL",
        evidence: [
          `populationSize:${input.population.length}`,
          `comparedCaseIds:${input.comparedCaseIds.length}`,
          `missingCaseIds:${missingCaseIds.join(",") || "none"}`,
          `foreignCaseIds:${foreignCaseIds.join(",") || "none"}`,
          perCaseEvidenceComplete
            ? "every-traffic-case-holds-a-per-case-comparison-record (both sides' digests)"
            : missingCaseIds.length > 0
              ? `AGGREGATE-ONLY (the regression claim was asserted without the per-case records — cases ${missingCaseIds.join(",")} hold no evidence)`
              : `FABRICATED-EVIDENCE (comparison records cite cases outside the population: ${foreignCaseIds.join(",")})`,
        ],
      },
      {
        criterionId: "regression-no-smoothing",
        strategy: "deterministic",
        status: noSmoothing ? "PASS" : "FAIL",
        evidence: [
          `smoothedCaseIds:${smoothedCaseIds.join(",") || "none"}`,
          `falseDivergenceCaseIds:${falseDivergenceCaseIds.join(",") || "none"}`,
          noSmoothing
            ? "every-claim-matches-the-mechanical-evaluation (a divergence is reported as a divergence)"
            : smoothedCaseIds.length > 0
              ? `DIVERGENCE-SMOOTHING (divergent cases claimed agreeing: ${smoothedCaseIds.join(",")} — a divergence is recorded case-by-case, never smoothed)`
              : `FALSE-DIVERGENCE (agreeing cases claimed diverging: ${falseDivergenceCaseIds.join(",")})`,
        ],
      },
      {
        criterionId: "regression-aggregate-honest",
        strategy: "deterministic",
        status: aggregatePresent && aggregateMatches ? "PASS" : "FAIL",
        evidence: [
          `aggregatePresent:${String(aggregatePresent)}`,
          `assertedAgreement:${String(input.aggregateClaim?.assertedAgreement ?? "none")}`,
          `assertedDivergenceCount:${input.aggregateClaim?.assertedDivergenceCount ?? "none"}`,
          `mechanicalDivergenceCount:${mechanicalDivergenceCount}`,
          !aggregatePresent
            ? "ABSENT-AGGREGATE (the run asserted no aggregate at all — the summary claim is mandatory)"
            : aggregateMatches
              ? "the-asserted-aggregate-matches-the-mechanical-evaluation"
              : "AGGREGATE-CONTRADICTION (the asserted aggregate contradicts the per-case evidence)",
        ],
      },
      {
        criterionId: "regression-digests-well-formed",
        strategy: "deterministic",
        status: malformedDigestCaseIds.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `malformedDigestCaseIds:${malformedDigestCaseIds.join(",") || "none"}`,
          malformedDigestCaseIds.length === 0
            ? "both-sides-digests-are-payload-free-FNV-1a (8-hex)"
            : "MALFORMED-DIGEST (a comparison record carries a non-digest outcome)",
        ],
      },
      {
        criterionId: "regression-agreement-under-criterion",
        strategy: "deterministic",
        status: mechanicalDivergenceCount === 0 ? "PASS" : "FAIL",
        evidence: [
          `criterionKind:${input.criterion?.kind ?? "none"}`,
          `divergences:${mechanicalDivergenceCaseIds.join(",") || "none"}`,
          mechanicalDivergenceCount === 0
            ? "every-traffic-case-agrees-under-the-stated-criterion"
            : "HONEST-DIVERGENCE (a shadow case diverged from the stated criterion — recorded case-by-case with both digests, never smoothed; the row FAILs honestly)",
        ],
      },
      {
        criterionId: "regression-honesty-summary",
        strategy: "deterministic",
        status: honest ? "PASS" : "FAIL",
        evidence: [
          `honest:${String(honest)}`,
          `perCaseEvidenceComplete:${String(perCaseEvidenceComplete)}`,
          `mechanicalDivergences:${mechanicalDivergenceCount}`,
          `smoothed:${smoothedCaseIds.length}`,
          `falseDivergences:${falseDivergenceCaseIds.length}`,
          `aggregateMatches:${String(aggregateMatches)}`,
          `digest:${digest}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shadow cost separation (the customer is never billed for the shadow)
// ---------------------------------------------------------------------------

/** The shadow cost-separation verdict. */
export interface ShadowCostSeparationVerdict {
  /** The shadow's cost is measured, booked to the shadow ledger, and absent from the served bill. */
  readonly separated: boolean;
  /** The shadow's billed-onto-served delta (nonzero = a billed shadow). */
  readonly billedOntoServedMicroUsd: number;
  /** Whether the shadow's cost was MEASURED at all. */
  readonly shadowCostMeasured: boolean;
  /** Whether the shadow ledger booked exactly the measured shadow cost. */
  readonly bookedCorrectly: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the shadow cost separation (PURE — the accounting oracle):
 * the shadow's measured cost must be booked to the SHADOW cost ledger,
 * NEVER the served accounting — the customer is never billed for the
 * shadow. A served total inflated by the shadow cost (a BILLED
 * shadow) FAILs with the billed delta named; a shadow that ran without
 * a measured cost (an UNMEASURED shadow) FAILs; a measured cost the
 * shadow ledger did not book exactly (UNBOOKED or MISBOOKED) FAILs.
 * The served accounting's own basis is the incumbent's measured cost
 * — nothing else.
 */
export function deriveShadowCostSeparation(input: {
  /** The incumbent leg's own measured cost (the honest served basis). */
  readonly incumbentCostMicroUsd: number;
  /** The shadow leg's own measured cost (null = unmeasured — FAILs). */
  readonly shadowCostMicroUsd: number | null;
  /** What the served accounting bills in total (must equal the incumbent basis). */
  readonly servedTotalMicroUsd: number;
  /** What the shadow cost ledger booked (null = nothing booked). */
  readonly shadowLedgerBookedMicroUsd: number | null;
}): ShadowCostSeparationVerdict {
  const shadowCostMeasured = input.shadowCostMicroUsd !== null;
  const billedOntoServedMicroUsd = Math.max(
    0,
    input.servedTotalMicroUsd - input.incumbentCostMicroUsd,
  );
  const servedExcludesShadow = input.servedTotalMicroUsd === input.incumbentCostMicroUsd;
  const bookedCorrectly =
    shadowCostMeasured &&
    input.shadowLedgerBookedMicroUsd !== null &&
    input.shadowLedgerBookedMicroUsd === input.shadowCostMicroUsd;
  const separated = servedExcludesShadow && shadowCostMeasured && bookedCorrectly;

  return {
    separated,
    billedOntoServedMicroUsd,
    shadowCostMeasured,
    bookedCorrectly,
    criteria: [
      {
        criterionId: "cost-served-excludes-shadow",
        strategy: "deterministic",
        status: servedExcludesShadow ? "PASS" : "FAIL",
        evidence: [
          `incumbentCostMicroUsd:${input.incumbentCostMicroUsd}`,
          `servedTotalMicroUsd:${input.servedTotalMicroUsd}`,
          `billedOntoServedMicroUsd:${billedOntoServedMicroUsd}`,
          servedExcludesShadow
            ? "the-served-accounting-bills-the-incumbent-only (the customer is never billed for the shadow)"
            : `BILLED-SHADOW (the shadow's cost was booked onto the served accounting rails — ${billedOntoServedMicroUsd} micro-usd of shadow cost in the customer's bill)`,
        ],
      },
      {
        criterionId: "cost-shadow-measured",
        strategy: "deterministic",
        status: shadowCostMeasured ? "PASS" : "FAIL",
        evidence: [
          `shadowCostMicroUsd:${input.shadowCostMicroUsd ?? "none"}`,
          shadowCostMeasured
            ? "the-shadows-cost-was-measured (separately from the served accounting)"
            : "UNMEASURED-SHADOW-COST (the shadow ran without a cost measurement — an honest run measures its shadow cost)",
        ],
      },
      {
        criterionId: "cost-shadow-ledger-books-shadow",
        strategy: "deterministic",
        status: bookedCorrectly ? "PASS" : "FAIL",
        evidence: [
          `shadowLedgerBookedMicroUsd:${input.shadowLedgerBookedMicroUsd ?? "none"}`,
          `expectedBookedMicroUsd:${input.shadowCostMicroUsd ?? "none"}`,
          bookedCorrectly
            ? "the-shadow-cost-ledger-booked-exactly-the-measured-shadow-cost"
            : input.shadowLedgerBookedMicroUsd === null
              ? "UNBOOKED-SHADOW-COST (the measured shadow cost never booked to the shadow ledger)"
              : "MISBOOKED-SHADOW-COST (the shadow ledger's booking differs from the measured shadow cost)",
        ],
      },
      {
        criterionId: "cost-separation-summary",
        strategy: "deterministic",
        status: separated ? "PASS" : "FAIL",
        evidence: [
          `separated:${String(separated)}`,
          `servedExcludesShadow:${String(servedExcludesShadow)}`,
          `shadowCostMeasured:${String(shadowCostMeasured)}`,
          `bookedCorrectly:${String(bookedCorrectly)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Stage discipline (differentially-evaluated → shadow-executed ONLY)
// ---------------------------------------------------------------------------

/** The shadow stage-discipline verdict. */
export interface ShadowStageDisciplineVerdict {
  /** The walk is exactly the recorded VAL-033 landing + the evidenced shadow append. */
  readonly disciplined: boolean;
  /** The candidate's recorded walk BEFORE the shadow append (VAL-033's landing). */
  readonly priorWalk: readonly CandidateLifecycleStage[];
  /** The stages the shadow run appended, in append order. */
  readonly appendedWalk: readonly CandidateLifecycleStage[];
  /** Appended stages landing PAST shadow-executed (a skipped-stage promotion). */
  readonly beyondScopeStages: readonly CandidateLifecycleStage[];
  /** Appended stages that are not the shadow stage (a wrong-stage landing). */
  readonly wrongStageLandings: readonly CandidateLifecycleStage[];
  /** The ordinals of appended transitions that landed without evidence. */
  readonly evidenceLessOrdinals: readonly number[];
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the shadow stage discipline (PURE — the lifecycle ladder's
 * shadow oracle): the candidate's RECORDED walk must already end at
 * `differentially-evaluated` (VAL-033's landing — exactly the
 * offline-replayed → differentially-evaluated walk; a candidate whose
 * walk has not reached it is PREMATURE and a shadow run refuses
 * honestly rather than appending), and the shadow run's append is the
 * SINGLE `shadow-executed` transition with its evidence digest — NEVER
 * a stage past `shadow-executed` (canaried and promoted are VAL-035's
 * scope: a skipped-stage advance FAILs mechanically), never a
 * wrong-stage landing, never an evidence-less transition.
 */
export function deriveShadowStageDiscipline(input: {
  /** The ledger's recorded walk for the candidate BEFORE the shadow append. */
  readonly priorWalk: readonly CandidateLifecycleStage[];
  /** The transitions the shadow run appended, in append order. */
  readonly appendedTransitions: readonly LifecycleTransitionRecord[];
  /** Whether the run expected its verdict to LAND (append) at the shadow stage. */
  readonly expectedLanding: boolean;
}): ShadowStageDisciplineVerdict {
  const priorWalk = [...input.priorWalk];
  const appendedWalk = input.appendedTransitions.map((transition) => transition.toStage);
  const expectedPriorWalk: CandidateLifecycleStage[] = [OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE];

  const priorWalkComplete =
    priorWalk.length === expectedPriorWalk.length &&
    priorWalk.every((stage, index) => stage === expectedPriorWalk[index]);

  const beyondScopeStages = appendedWalk.filter((stage) => isBeyondShadowScope(stage));
  const wrongStageLandings = appendedWalk.filter((stage) => stage !== SHADOW_STAGE);
  const evidenceLessOrdinals = input.appendedTransitions
    .filter((transition) => (transition.evidenceDigest ?? "").length === 0)
    .map((transition) => transition.ordinal);

  const landingMatch = input.expectedLanding
    ? appendedWalk.length === 1 && appendedWalk[0] === SHADOW_STAGE
    : appendedWalk.length === 0;

  const disciplined =
    priorWalkComplete &&
    beyondScopeStages.length === 0 &&
    wrongStageLandings.length === 0 &&
    evidenceLessOrdinals.length === 0 &&
    landingMatch;

  return {
    disciplined,
    priorWalk,
    appendedWalk,
    beyondScopeStages,
    wrongStageLandings,
    evidenceLessOrdinals,
    criteria: [
      {
        criterionId: "stage-discipline-source-differentially-evaluated",
        strategy: "deterministic",
        status: priorWalkComplete ? "PASS" : "FAIL",
        evidence: [
          `priorWalk:${priorWalk.join("→") || "none"}`,
          `expectedPriorWalk:${expectedPriorWalk.join("→")}`,
          priorWalkComplete
            ? "the-candidates-recorded-walk-ends-at-differentially-evaluated (VAL-033's landing — the read-only input)"
            : "PREMATURE-SHADOW (the candidate's recorded walk has not yet reached the differentially-evaluated stage — a premature shadow refuses honestly)",
        ],
      },
      {
        criterionId: "stage-discipline-never-beyond-shadow",
        strategy: "deterministic",
        status: beyondScopeStages.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          `shadowStage:${SHADOW_STAGE}`,
          `beyondScope:${beyondScopeStages.join(",") || "none"}`,
          beyondScopeStages.length === 0
            ? "shadow-executed-only (canary and promotion are VAL-035's acts — never this slice's)"
            : "SKIPPED-STAGE (the lifecycle append advanced past the shadow-executed stage — an out-of-scope promotion)",
        ],
      },
      {
        criterionId: "stage-discipline-landing-is-shadow-stage",
        strategy: "deterministic",
        status: wrongStageLandings.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          `wrongStageLandings:${wrongStageLandings.join(",") || "none"}`,
          wrongStageLandings.length === 0
            ? "every-appended-transition-lands-at-shadow-executed"
            : "WRONG-STAGE-LANDING (the shadow slice appends the shadow-executed transition only — property/mutation stages are not this slice's acts)",
        ],
      },
      {
        criterionId: "stage-discipline-every-transition-evidenced",
        strategy: "deterministic",
        status: evidenceLessOrdinals.length === 0 ? "PASS" : "FAIL",
        evidence: [
          `appendedTransitions:${input.appendedTransitions.length}`,
          `evidenceLessOrdinals:${evidenceLessOrdinals.join(",") || "none"}`,
          evidenceLessOrdinals.length === 0
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
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          landingMatch
            ? "the-ledger-holds-exactly-the-recorded-walk-plus-the-shadow-append"
            : "LANDING-MISMATCH (the ledger's shadow append differs from the single shadow-executed transition)",
        ],
      },
      {
        criterionId: "stage-discipline-summary",
        strategy: "deterministic",
        status: disciplined ? "PASS" : "FAIL",
        evidence: [
          `disciplined:${String(disciplined)}`,
          `priorWalk:${priorWalk.join("→") || "none"}`,
          `appendedWalk:${appendedWalk.join("→") || "none"}`,
          `beyondScope:${beyondScopeStages.length}`,
          `evidenceLess:${evidenceLessOrdinals.length}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refusal honesty (a refusal is justified by the candidate's own state)
// ---------------------------------------------------------------------------

/** The shadow refusal-honesty verdict. */
export interface ShadowRefusalHonestyVerdict {
  /** The refusal is mechanically justified by the registry's/lifecycle's own state. */
  readonly honest: boolean;
  readonly reason: ShadowRefusalReason | null;
  readonly justified: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the refusal honesty (PURE): a shadow run refuses only when
 * the candidate's own recorded state genuinely justifies it —
 * `candidate-unregistered` only when the cited identity is not a
 * member of the candidate registry, and
 * `candidate-not-differentially-evaluated` only when the candidate's
 * recorded lifecycle walk has not yet reached the
 * differentially-evaluated stage. A refusal that hides a shadowable
 * candidate FAILs just as a fabricated comparison does — and a
 * refusal accompanied by a comparison (or vice versa) is a malformed
 * outcome that FAILs.
 */
export function deriveShadowRefusalHonesty(input: {
  /** The run's refusal under test (null when a comparison was emitted). */
  readonly refusal: { readonly reason: ShadowRefusalReason } | null;
  /** Whether the run emitted a comparison alongside the refusal under test. */
  readonly comparisonEmitted: boolean;
  /** The registry's own entry for the row's cited candidate (null when unregistered). */
  readonly registryEntry: {
    readonly lifecycleStage: CandidateLifecycleStage;
    /** Whether the candidate's recorded walk ends at the differentially-evaluated stage. */
    readonly walkEndsAtDifferentiallyEvaluated: boolean;
  } | null;
}): ShadowRefusalHonestyVerdict {
  const malformed = (input.refusal !== null) === input.comparisonEmitted;
  let justified = false;
  let basis = "";
  if (input.refusal === null) {
    justified = !input.comparisonEmitted;
    basis = "no-refusal-to-judge (the run emitted a comparison)";
  } else {
    switch (input.refusal.reason) {
      case "candidate-unregistered":
        justified = input.registryEntry === null;
        basis = "the cited candidate identity is not a member of the candidate registry";
        break;
      case "candidate-not-differentially-evaluated":
        justified =
          input.registryEntry !== null && !input.registryEntry.walkEndsAtDifferentiallyEvaluated;
        basis =
          "the candidate's recorded lifecycle walk has not yet reached the differentially-evaluated stage";
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
          `comparisonEmitted:${String(input.comparisonEmitted)}`,
          malformed
            ? "MALFORMED-OUTCOME (a refusal and a comparison are mutually exclusive)"
            : "the-outcome-is-either-a-comparison-or-a-refusal",
        ],
      },
      {
        criterionId: "refusal-justified",
        strategy: "deterministic",
        status: justified ? "PASS" : "FAIL",
        evidence: [
          `reason:${input.refusal?.reason ?? "none"}`,
          `registryStage:${input.registryEntry?.lifecycleStage ?? "none"}`,
          `walkEndsAtDifferentiallyEvaluated:${String(
            input.registryEntry?.walkEndsAtDifferentiallyEvaluated ?? false,
          )}`,
          justified
            ? `justified (${basis})`
            : "UNJUSTIFIED-REFUSAL (the candidate's own state supports the shadow run — hiding it FAILs)",
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
// The honest shadow run (the PURE reference runtime)
// ---------------------------------------------------------------------------

/** The shadow runtime's run outcome (the seam's return shape). */
export interface ShadowRunOutcome {
  /** The shadow leg's per-case outcomes (digest + the runtime's own agreement claim). */
  readonly outcomes: readonly (ShadowCaseOutcome & { readonly claimedAgrees: boolean })[];
  /** The run's asserted aggregate regression claim (cross-checked mechanically). */
  readonly aggregateClaim: ShadowAggregateClaim | null;
  /** The cases the runtime actually compared (the per-case evidence surface). */
  readonly comparedCaseIds: readonly string[];
  /** The capabilities the runtime observed the replacement exercising mid-shadow. */
  readonly exercisedCapabilities: readonly string[];
  /** The candidate id the run cites (null when uncited). */
  readonly citedProposalId: string | null;
  /** The shadow's OWN measured cost + latency (measured separately; null = unmeasured). */
  readonly shadowCost: ShadowCostMeasurement | null;
}

/**
 * The deterministic REFERENCE shadow-cost measurement (the controlled
 * world's honest measurement): a pure function of the shadowed
 * population's size — the fixture world's measured shadow cost + the
 * measured shadow latency. The LIVE rail's measurement is REAL and
 * rides the dispatch seam instead.
 */
export function referenceShadowMeasurementOf(
  population: readonly ShadowTrafficCase[],
): ShadowCostMeasurement {
  return {
    microUsd: 2 * population.length + 1,
    latencyMs: 4 * population.length + 2,
  };
}

/**
 * Derive the HONEST shadow run for one row over one traffic
 * population (PURE — the reference runtime): the shadow leg's
 * outcomes are the shape's deterministic reference digests (VAL-033's
 * reference replacement, carried into the shadow), the per-case
 * agreement claims are the MECHANICAL criterion evaluations (never
 * smoothed), the asserted aggregate is the mechanical count, the
 * compared surface is the FULL population, the exercised capabilities
 * are exactly the declaration, the citation is the row's source
 * candidate, and the shadow cost is the reference measurement (booked
 * to the shadow ledger, never the served accounting). The
 * deterministic fixtures pin the adversarial variants (escaping,
 * aggregate-only, subset-compared, smoothing).
 */
export function deriveHonestShadowRun(input: {
  readonly sourceProposalId: string;
  readonly replacementShape: ReplacementShape;
  readonly declaredCapabilities: readonly string[];
  readonly acceptanceCriterion: AcceptanceCriterion | null;
  readonly trafficPopulation: readonly ShadowTrafficCase[];
}): ShadowRunOutcome {
  const outcomes = input.trafficPopulation.map((tcase) => {
    const digest = referenceReplacementOutcomeDigestOf({
      shape: input.replacementShape,
      caseId: tcase.caseId,
      inputDigest: tcase.inputDigest,
      classDigests: tcase.classDigests,
    });
    return {
      caseId: tcase.caseId,
      digest,
      claimedAgrees: criterionSatisfiedForCase({
        dcase: tcase,
        replacementDigest: digest,
        incumbentDigest: tcase.incumbentDigest,
        criterion: input.acceptanceCriterion,
      }),
    };
  });
  const divergences = outcomes.filter((outcome) => !outcome.claimedAgrees);
  return {
    outcomes,
    aggregateClaim: {
      assertedAgreement: divergences.length === 0,
      assertedDivergenceCount: divergences.length,
    },
    comparedCaseIds: input.trafficPopulation.map((tcase) => tcase.caseId),
    exercisedCapabilities: [...input.declaredCapabilities],
    citedProposalId: input.sourceProposalId,
    shadowCost: referenceShadowMeasurementOf(input.trafficPopulation),
  };
}

/**
 * Derive the observed shadow verdict kind (PURE): an honest refusal
 * when the run refused; a containment violation when the replacement
 * escaped its granted surface MID-SHADOW; `shadow-invalid` when the
 * run's mechanical shape is untrustworthy (a leaked serve, a partial
 * population, an aggregate-only or smoothed regression claim, a
 * billed shadow); an honest divergence when cases diverged over a
 * complete, unsmoothed, separated comparison (recorded case-by-case —
 * the row FAILs honestly but the shadow still landed); and a shadow
 * agreement when every leg holds.
 */
export function deriveShadowVerdictKind(input: {
  readonly refusal: { readonly reason: ShadowRefusalReason } | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly servingIsolation: ServingIsolationVerdict | null;
  readonly populationCompleteness: ShadowPopulationCompletenessVerdict | null;
  readonly regressionHonesty: RegressionHonestyVerdict | null;
  readonly costSeparation: ShadowCostSeparationVerdict | null;
}): ShadowVerdictKind {
  if (input.refusal !== null) {
    return "honest-refusal";
  }
  if (input.isolation !== null && !input.isolation.contained) {
    return "containment-violation";
  }
  if (
    input.servingIsolation === null ||
    input.populationCompleteness === null ||
    input.regressionHonesty === null ||
    input.costSeparation === null
  ) {
    return "shadow-invalid";
  }
  if (
    !input.servingIsolation.isolated ||
    !input.populationCompleteness.complete ||
    !input.regressionHonesty.honest ||
    !input.costSeparation.separated
  ) {
    return "shadow-invalid";
  }
  if (input.regressionHonesty.mechanicalDivergenceCaseIds.length > 0) {
    return "honest-divergence";
  }
  return "shadow-agreement";
}

// ---------------------------------------------------------------------------
// The driver seams (the read-only registry + the append-only ledgers)
// ---------------------------------------------------------------------------

/**
 * The candidate registry read port (the READ-ONLY input): VAL-032's
 * proposal records — the registry identities the shadow rows cite.
 * The shadow run NEVER rewrites an entry; a registry whose digest
 * changes over a run FAILs the read-only discipline.
 */
export interface ShadowCandidateRegistryPort {
  candidateFor(proposalId: string): DiscoveryProposalRecord | null;
  facts(): EquivalenceRegistryFacts;
}

/**
 * The canonical digest over the registry's facts (PURE — the
 * read-only fingerprint the driver snapshots before and after every
 * run: the registry entries are frozen inputs).
 */
export function shadowRegistryDigestOf(facts: EquivalenceRegistryFacts): string {
  return equivalenceRegistryDigestOf(facts);
}

/**
 * The candidate lifecycle ledger port (APPEND-ONLY): the shadow run
 * APPENDS the `shadow-executed` transition with its evidence digest
 * to the candidate lifecycle — the recorded VAL-033 walk (the
 * pre-seeded `offline-replayed` + `differentially-evaluated`
 * transitions) is a read-only input the append NEVER rewrites. An
 * identical re-append REPLAYS (idempotent); a different transition
 * under a recorded (proposalId, stage) key is REFUSED.
 */
export type ShadowLifecycleLedgerPort = CandidateLifecycleLedgerPort;

/**
 * The shadow ledger port (APPEND-ONLY): the divergence ledger — every
 * shadow divergence recorded case-by-case with both sides' digests —
 * and the shadow cost ledger — the shadow's measured cost booked
 * apart from the served accounting. Neither is ever rewritten; an
 * identical re-append REPLAYS idempotently.
 */
export interface ShadowLedgerPort {
  appendDivergence(record: Omit<ShadowDivergenceRecord, "ordinal">): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }>;
  divergencesFor(proposalId: string): readonly ShadowDivergenceRecord[];
  bookShadowCost(entry: Omit<ShadowCostLedgerEntry, "ordinal">): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }>;
  costsFor(proposalId: string): readonly ShadowCostLedgerEntry[];
}

/** The traffic-source port (the recorded workload mix serve). */
export interface TrafficSourcePort {
  /**
   * Serve the recorded traffic population for one shadow run (the
   * honest source serves the row's declared population exactly; the
   * adversarial variants drop / duplicate / swap cases).
   */
  populationFor(input: {
    readonly population: readonly ShadowTrafficCase[];
  }): Promise<readonly ShadowTrafficCase[]>;
}

/** The serving-path port (the customer-facing serve + the served accounting). */
export interface ServingPathPort {
  /**
   * Serve ONE traffic case's customer-facing outcome. The honest path
   * serves the INCUMBENT's executed digest (the served-source pin);
   * the LEAKY variants serve the shadow's own outcome.
   */
  serve(input: {
    readonly tcase: ShadowTrafficCase;
    readonly incumbentDigest: string;
    readonly shadowDigest: string;
  }): Promise<{ readonly servedSource: string; readonly servedDigest: string }>;
  /** The served accounting's snapshot (the incumbent basis + the billed total). */
  servedAccounting(): ServedAccountingSnapshot;
}

/** The shadow-runtime port (the replacement executing in shadow, observation-only). */
export interface ShadowRuntimePort {
  runShadow(input: {
    readonly sourceProposalId: string;
    readonly replacementShape: ReplacementShape;
    readonly declaredCapabilities: readonly string[];
    readonly acceptanceCriterion: AcceptanceCriterion | null;
    readonly trafficPopulation: readonly ShadowTrafficCase[];
  }): Promise<ShadowRunOutcome>;
}

// ---------------------------------------------------------------------------
// The corpus-row contract (the shadow oracle)
// ---------------------------------------------------------------------------

/**
 * The shadow-execution corpus row (the full oracle — AC1's per-row
 * contract): the shadowed candidate (the VAL-033 differentially
 * evaluated lifecycle identity — the registry entry whose recorded
 * walk ends at `differentially-evaluated`), the replacement shape
 * (carried over from the differential evaluation, with its declared
 * capabilities and granted isolation surface — the containment
 * carry-over), the traffic population (the workload mix the shadow
 * replays: the cited recorded replay populations plus the pinned
 * injected traffic probes, with the workload-class mix basis), the
 * EXPLICIT comparison criterion (the regression agreement basis), and
 * the expected verdict (the shadow agreement, the honest divergence
 * with its divergent cases pinned case-by-case, or the honest
 * refusal).
 */
export interface ShadowCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /** The VAL-033 differentially-evaluated lifecycle identity this row shadows. */
  readonly sourceProposalId: string;
  /** The replacement shape (carried over from VAL-033's differential evaluation). */
  readonly replacementShape: ReplacementShape;
  /** The replacement's DECLARED capability set (the granted surface's demand). */
  readonly declaredCapabilities: readonly string[];
  /** The granted isolation surface (the ALLOWED capability set — carried over). */
  readonly grantedIsolationSurface: readonly string[];
  /** The traffic population (the workload mix the shadow replays). */
  readonly trafficPopulation: readonly ShadowTrafficCase[];
  /** The recorded workload class per traffic case (the mix basis). */
  readonly trafficWorkloadClasses: Readonly<Record<string, string>>;
  /** The EXPLICIT comparison criterion (the regression agreement basis). */
  readonly acceptanceCriterion: AcceptanceCriterion;
  /** The expected verdict (the oracle proper). */
  readonly expected: {
    readonly verdict: Exclude<ShadowVerdictKind, "shadow-invalid" | "containment-violation">;
    /** The expected refusal reason (null when a comparison is expected). */
    readonly refusalReason: ShadowRefusalReason | null;
    /** The expected divergent case ids (an honest divergence is pinned case-by-case). */
    readonly divergenceCaseIds: readonly string[];
    /** The run's own dispatch demand (0 offline; the live row's REAL confirmation round). */
    readonly modelCalls: number;
    /** The run's honest terminal (an honest divergence FAILs honestly; a refusal COMPLETES). */
    readonly terminal: "COMPLETED" | "FAILED";
  };
  /** The pinned shadow-trajectory class (the app's re-derivation target). */
  readonly expectedTrajectoryClass: readonly string[];
  /** The shadow-probe vocabulary (the phase-2 discrimination hooks). */
  readonly probe?: { readonly kind: ShadowProbeKind };
  /** Whether the run demands a REAL residual-AI model round (the live row). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
}

// ---------------------------------------------------------------------------
// The shadow trajectory (the app's re-derivation basis)
// ---------------------------------------------------------------------------

/**
 * The canonical shadow-run trajectory (PURE): the steps ONE shadow
 * run records — the live row's REAL residual-AI confirmation round
 * (dispatch), the read-only candidate read, the traffic population
 * serve, the incumbent-served leg, the shadow-executed leg (the
 * observation), the isolation verification (the containment
 * carry-over), the regression comparison, the divergence-ledger
 * append, the shadow-cost booking, the lifecycle append (or the
 * honest refusal) and the criteria recording. The app re-derives this
 * trajectory's digest over the PUBLIC step-event journal — never
 * trusting the platform's claim.
 */
export function shadowTrajectoryStepsOf(input: {
  readonly proposalId: string;
  readonly populationDigest: string;
  readonly servedExecutionDigest: string;
  readonly shadowExecutionDigest: string;
  readonly isolationContainment: ContainmentVerdict | null;
  readonly regressionVerdictDigest: string | null;
  readonly divergenceCount: number;
  readonly shadowCostDigest: string | null;
  readonly refusalReason: ShadowRefusalReason | null;
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
    detail: "candidate-read",
    digest: longitudinalDigestOf(["candidate-read", input.proposalId]),
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
      detail: "traffic-served",
      digest: input.populationDigest,
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "incumbent-served",
      digest: input.servedExecutionDigest,
    });
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: "shadow-executed",
      digest: input.shadowExecutionDigest,
    });
    if (input.isolationContainment !== null) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: "isolation-verified",
        digest: longitudinalDigestOf(["isolation-verified", input.isolationContainment]),
      });
    }
    if (input.regressionVerdictDigest !== null) {
      steps.push({
        ordinal: steps.length + 1,
        kind: "verification",
        detail: "regression-compared",
        digest: input.regressionVerdictDigest,
      });
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: "divergences-recorded",
        digest: longitudinalDigestOf(["divergences-recorded", input.divergenceCount]),
      });
      if (input.shadowCostDigest !== null) {
        steps.push({
          ordinal: steps.length + 1,
          kind: "effect",
          detail: "shadow-cost-booked",
          digest: input.shadowCostDigest,
        });
      }
      steps.push({
        ordinal: steps.length + 1,
        kind: "effect",
        detail: "lifecycle-appended",
        digest: longitudinalDigestOf(["lifecycle-appended", input.proposalId, SHADOW_STAGE]),
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
// The shadow driver
// ---------------------------------------------------------------------------

/** The full shadow-run result (the honest contract). */
export interface ShadowRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  /** The observed verdict kind (the honest derivation, never the runtime's claim). */
  readonly verdict: ShadowVerdictKind;
  readonly refusal: { readonly reason: ShadowRefusalReason } | null;
  readonly servingIsolation: ServingIsolationVerdict | null;
  readonly populationCompleteness: ShadowPopulationCompletenessVerdict | null;
  readonly regressionHonesty: RegressionHonestyVerdict | null;
  readonly costSeparation: ShadowCostSeparationVerdict | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly refusalHonesty: ShadowRefusalHonestyVerdict | null;
  readonly stageDiscipline: ShadowStageDisciplineVerdict | null;
  /** The lifecycle landing receipt (null when nothing was appended). */
  readonly ledgerLanding: { readonly accepted: boolean; readonly replayed: boolean } | null;
  /** The number of divergence records appended to the shadow ledger. */
  readonly divergencesAppended: number;
  /** Whether the shadow cost booked to the shadow ledger. */
  readonly shadowCostBooked: boolean;
  readonly observedModelCalls: number;
  /** The run's measured usage (the live row; null offline — honestly none-reported). */
  readonly usage: LabUsage | null;
  /** The run's measured latency (ms). */
  readonly latencyMs: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * Drive ONE shadow corpus row through the platform path: read the
 * row's candidate from the READ-ONLY candidate registry (the VAL-032
 * entry — never rewritten; a candidate whose recorded lifecycle walk
 * has not yet reached `differentially-evaluated` yields an HONEST
 * refusal), serve the recorded traffic population (the workload mix),
 * execute the INCUMBENT path over the traffic and SERVE its outcomes
 * through the serving path (the served leg — the customer-facing
 * outcomes, the served-source pin ALWAYS the incumbent), execute the
 * ISOLATED REPLACEMENT in SHADOW over the SAME traffic (the
 * observation leg — its outcomes recorded, never served), mechanically
 * verify the run (the serving isolation, the population completeness,
 * the regression honesty, the cost separation, the containment
 * carry-over, the stage discipline), APPEND the mechanically-derived
 * divergences to the divergence ledger and the measured shadow cost to
 * the shadow cost ledger, APPEND the verified `shadow-executed`
 * transition to the candidate lifecycle ledger (never rewriting the
 * recorded VAL-033 walk), and snapshot the registry before and after
 * so the read-only discipline proves the run mutated nothing.
 *
 * The live row additionally drives ONE REAL residual-AI confirmation
 * dispatch through the dispatch seam (env-gated, measured — never
 * fabricated); an offline shadow run dispatches no model at all.
 */
export async function driveShadowRun(options: {
  readonly row: ShadowCorpusRow;
  /** The READ-ONLY candidate registry (VAL-032's proposals). */
  readonly registry: ShadowCandidateRegistryPort;
  /** The APPEND-ONLY candidate lifecycle ledger (the pre-seeded VAL-033 walk). */
  readonly lifecycle: ShadowLifecycleLedgerPort;
  /** The APPEND-ONLY shadow ledger (divergences + shadow cost). */
  readonly shadowLedger: ShadowLedgerPort;
  /** The incumbent executor seam (the incumbent AI implementation). */
  readonly incumbentExecutor: IncumbentExecutorPort;
  /** The traffic source seam (the recorded workload mix serve). */
  readonly trafficSource: TrafficSourcePort;
  /** The serving path seam (the customer-facing serve + the served accounting). */
  readonly servingPath: ServingPathPort;
  /** The shadow runtime seam (the replacement executing in shadow). */
  readonly shadowRuntime: ShadowRuntimePort;
  /** The dispatch seam (the live row's REAL residual-AI confirmation round). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<ShadowRunResult> {
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
  const beforeRegistryDigest = shadowRegistryDigestOf(options.registry.facts());

  // ---- the read-only candidate read ----
  const candidate = options.registry.candidateFor(row.sourceProposalId);
  // The recorded walk BEFORE this run's append, EXCLUDING any prior
  // shadow landing (an honest re-drive REPLAYS the identical shadow
  // transition — the recorded VAL-033 walk is the read-only prefix).
  const preDriveTransitions = options.lifecycle.transitionsFor(row.sourceProposalId);
  const priorWalk = preDriveTransitions
    .filter((transition) => transition.toStage !== SHADOW_STAGE)
    .map((transition) => transition.toStage);
  const walkEndsAtDifferentiallyEvaluated =
    priorWalk.length >= 2 && priorWalk[priorWalk.length - 1] === EQUIVALENT_STAGE;

  let refusal: { reason: ShadowRefusalReason } | null = null;
  if (candidate === null) {
    refusal = { reason: "candidate-unregistered" };
  } else if (!walkEndsAtDifferentiallyEvaluated) {
    refusal = { reason: "candidate-not-differentially-evaluated" };
  }

  let servingIsolation: ServingIsolationVerdict | null = null;
  let populationCompleteness: ShadowPopulationCompletenessVerdict | null = null;
  let regressionHonesty: RegressionHonestyVerdict | null = null;
  let costSeparation: ShadowCostSeparationVerdict | null = null;
  let isolation: ReplacementIsolationVerdict | null = null;
  let refusalHonesty: ShadowRefusalHonestyVerdict | null = null;
  let stageDiscipline: ShadowStageDisciplineVerdict | null = null;
  let ledgerLanding: { accepted: boolean; replayed: boolean } | null = null;
  let divergencesAppended = 0;
  let shadowCostBooked = false;
  let servedAsPinned = true;
  let incumbentOutcomes: ShadowCaseOutcome[] = [];
  let shadowRun: ShadowRunOutcome | null = null;

  if (refusal !== null) {
    // ---- the honest-refusal path (the candidate's own recorded state
    //      does not support a shadow run: nothing executes, nothing lands) ----
    refusalHonesty = deriveShadowRefusalHonesty({
      refusal,
      comparisonEmitted: false,
      registryEntry:
        candidate === null
          ? null
          : {
              lifecycleStage: candidate.lifecycleStage,
              walkEndsAtDifferentiallyEvaluated,
            },
    });
  } else {
    // ---- the traffic serve (the recorded workload mix) ----
    const servedPopulation = await options.trafficSource.populationFor({
      population: row.trafficPopulation,
    });

    // ---- the shadow leg (the replacement executes in shadow — observation-only) ----
    shadowRun = await options.shadowRuntime.runShadow({
      sourceProposalId: row.sourceProposalId,
      replacementShape: row.replacementShape,
      declaredCapabilities: row.declaredCapabilities,
      acceptanceCriterion: row.acceptanceCriterion,
      trafficPopulation: servedPopulation,
    });
    const runOutcome = shadowRun;

    // ---- the served leg (the incumbent executes + the customer is served) ----
    incumbentOutcomes = [];
    const servedOutcomes: ServedOutcomeRecord[] = [];
    for (const tcase of servedPopulation) {
      const outcome = await options.incumbentExecutor.outcomeFor({ dcase: tcase });
      incumbentOutcomes.push({ caseId: tcase.caseId, digest: outcome.digest });
      if (outcome.digest !== tcase.incumbentDigest) {
        servedAsPinned = false;
      }
      const shadowDigest =
        runOutcome.outcomes.find((shadowOutcome) => shadowOutcome.caseId === tcase.caseId)
          ?.digest ?? "";
      const served = await options.servingPath.serve({
        tcase,
        incumbentDigest: outcome.digest,
        shadowDigest,
      });
      servedOutcomes.push({
        caseId: tcase.caseId,
        servedSource: served.servedSource,
        servedDigest: served.servedDigest,
      });
    }

    // ---- the mechanical verification of the run ----
    servingIsolation = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes,
      shadowOutcomes: runOutcome.outcomes,
      servedOutcomes,
    });
    populationCompleteness = deriveShadowPopulationCompleteness({
      recordedCaseIds: row.trafficPopulation.map((tcase) => tcase.caseId),
      workloadClassByCaseId: row.trafficWorkloadClasses,
      observedCaseIds: servedPopulation.map((tcase) => tcase.caseId),
    });
    regressionHonesty = deriveRegressionHonesty({
      population: row.trafficPopulation,
      criterion: row.acceptanceCriterion,
      incumbentOutcomes,
      shadowOutcomes: runOutcome.outcomes,
      comparedCaseIds: runOutcome.comparedCaseIds,
      aggregateClaim: runOutcome.aggregateClaim,
    });
    isolation = deriveReplacementIsolation({
      declaredCapabilities: row.declaredCapabilities,
      grantedSurface: row.grantedIsolationSurface,
      exercisedCapabilities: runOutcome.exercisedCapabilities,
    });

    // ---- the shadow cost booking (the shadow's OWN ledger — the
    //      measurement is real whenever the shadow ran) ----
    if (runOutcome.shadowCost !== null) {
      const costReceipt = await options.shadowLedger.bookShadowCost({
        proposalId: row.sourceProposalId,
        microUsd: runOutcome.shadowCost.microUsd,
        latencyMs: runOutcome.shadowCost.latencyMs,
      });
      shadowCostBooked = costReceipt.accepted || costReceipt.replayed;
    }

    // ---- the cost separation (after the booking, over the CURRENT books) ----
    const accounting = options.servingPath.servedAccounting();
    const booked = options.shadowLedger
      .costsFor(row.sourceProposalId)
      .reduce((total, entry) => total + entry.microUsd, 0);
    costSeparation = deriveShadowCostSeparation({
      incumbentCostMicroUsd: accounting.incumbentMicroUsd,
      shadowCostMicroUsd: runOutcome.shadowCost?.microUsd ?? null,
      servedTotalMicroUsd: accounting.billedMicroUsd,
      shadowLedgerBookedMicroUsd: booked > 0 ? booked : null,
    });

    // ---- the divergence-ledger append (ONLY mechanically-derived,
    //      trustworthy per-case evidence ever lands: complete
    //      population + complete unsmoothed per-case records) ----
    const evidenceTrustworthy =
      populationCompleteness.complete &&
      regressionHonesty.perCaseEvidenceComplete &&
      regressionHonesty.smoothedCaseIds.length === 0 &&
      regressionHonesty.falseDivergenceCaseIds.length === 0;
    if (evidenceTrustworthy) {
      for (const caseId of regressionHonesty.mechanicalDivergenceCaseIds) {
        const incumbentDigest = incumbentOutcomes.find(
          (outcome) => outcome.caseId === caseId,
        )?.digest;
        const shadowDigest = runOutcome.outcomes.find(
          (outcome) => outcome.caseId === caseId,
        )?.digest;
        if (incumbentDigest === undefined || shadowDigest === undefined) {
          continue;
        }
        await options.shadowLedger.appendDivergence({
          proposalId: row.sourceProposalId,
          caseId,
          incumbentDigest,
          shadowDigest,
        });
        divergencesAppended += 1;
      }
    }

    // ---- the lifecycle append (ONLY a trustworthy shadow ever lands:
    //      contained + serving-isolated + complete population + honest
    //      regression + separated cost; an HONEST DIVERGENCE still
    //      lands — the comparison is the record) ----
    const verdictTrustworthy =
      isolation.contained &&
      servingIsolation.isolated &&
      populationCompleteness.complete &&
      regressionHonesty.honest &&
      costSeparation.separated;
    if (verdictTrustworthy) {
      const shadowEvidence = lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: SHADOW_STAGE,
        members: [regressionHonesty.digest],
      });
      const receipt = await options.lifecycle.append({
        proposalId: row.sourceProposalId,
        toStage: SHADOW_STAGE,
        evidenceDigest: shadowEvidence,
      });
      ledgerLanding = { accepted: receipt.accepted, replayed: receipt.replayed };
    }

    // ---- the stage discipline (the recorded walk + the shadow append) ----
    const postTransitions = options.lifecycle.transitionsFor(row.sourceProposalId);
    stageDiscipline = deriveShadowStageDiscipline({
      priorWalk,
      appendedTransitions: postTransitions.slice(priorWalk.length),
      expectedLanding: ledgerLanding !== null,
    });
  }

  // ---- the frozen-registry snapshot AFTER the run (the read-only proof) ----
  const afterRegistryDigest = shadowRegistryDigestOf(options.registry.facts());
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

  const verdict = deriveShadowVerdictKind({
    refusal,
    isolation,
    servingIsolation,
    populationCompleteness,
    regressionHonesty,
    costSeparation,
  });

  // ---- the row-level mechanical criteria ----
  const criteria = deriveShadowRowCriteria({
    row,
    servedAsPinned,
    refusal,
    refusalHonesty,
    servingIsolation,
    populationCompleteness,
    regressionHonesty,
    costSeparation,
    isolation,
    stageDiscipline,
    ledgerLanding,
    divergencesAppended,
    registryUnchanged,
    observedModelCalls,
    verdict,
    failure,
  });

  const anyFail =
    failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    (refusal !== null) === (regressionHonesty !== null);

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    verdict,
    refusal,
    servingIsolation,
    populationCompleteness,
    regressionHonesty,
    costSeparation,
    isolation,
    refusalHonesty,
    stageDiscipline,
    ledgerLanding,
    divergencesAppended,
    shadowCostBooked,
    observedModelCalls,
    usage,
    latencyMs: options.now().getTime() - startedAt,
    failure,
  };
}

/**
 * Derive the row-level mechanical criteria (PURE): the population pin
 * leg (the served incumbent digests are the recorded/pinned digests),
 * the serving-isolation legs (the served outcome is ALWAYS the
 * incumbent's — a leaked shadow FAILs with the leak named), the
 * population-completeness legs (the full recorded workload mix), the
 * regression-honesty legs (per-case evidence, never smoothed
 * aggregates), the cost-separation legs (the shadow cost booked apart,
 * never billed), the containment legs (the isolation carry-over), the
 * stage-discipline legs (differentially-evaluated → shadow-executed
 * only), the refusal-honesty legs, the ledger landing, the read-only
 * registry legs, the expected-verdict contract (the observed verdict
 * matches the pinned oracle — the kind, the refusal reason and the
 * divergent cases), the payload-free digest discipline and the honest
 * accounting.
 */
export function deriveShadowRowCriteria(input: {
  readonly row: ShadowCorpusRow;
  /** Whether the incumbent executor served the population's pinned digests exactly. */
  readonly servedAsPinned: boolean;
  readonly refusal: { readonly reason: ShadowRefusalReason } | null;
  readonly refusalHonesty: ShadowRefusalHonestyVerdict | null;
  readonly servingIsolation: ServingIsolationVerdict | null;
  readonly populationCompleteness: ShadowPopulationCompletenessVerdict | null;
  readonly regressionHonesty: RegressionHonestyVerdict | null;
  readonly costSeparation: ShadowCostSeparationVerdict | null;
  readonly isolation: ReplacementIsolationVerdict | null;
  readonly stageDiscipline: ShadowStageDisciplineVerdict | null;
  readonly ledgerLanding: { readonly accepted: boolean; readonly replayed: boolean } | null;
  readonly divergencesAppended: number;
  readonly registryUnchanged: boolean;
  readonly observedModelCalls: number;
  readonly verdict: ShadowVerdictKind;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const { row } = input;

  // 1. The population pin (the served incumbent digests are the pins).
  if (input.regressionHonesty !== null) {
    criteria.push({
      criterionId: "population-served-as-pinned",
      strategy: "deterministic",
      status: input.servedAsPinned ? "PASS" : "FAIL",
      evidence: [
        `row:${row.rowId}`,
        `populationSize:${row.trafficPopulation.length}`,
        `historicalCases:${row.trafficPopulation.filter((tcase) => tcase.source === "historical-replay").length}`,
        `injectedProbes:${row.trafficPopulation.filter((tcase) => tcase.source === "adversarial").length}`,
        input.servedAsPinned
          ? "served-as-pinned (the incumbent outcomes are the recorded/pinned digests — the read-only input)"
          : "POPULATION-MISMATCH (the incumbent executor served a digest the population does not pin)",
      ],
    });
  }

  // 2-8. The serving-isolation / population / regression / cost /
  //      containment / stage / refusal legs.
  if (input.servingIsolation !== null) {
    criteria.push(...input.servingIsolation.criteria);
  }
  if (input.populationCompleteness !== null) {
    criteria.push(...input.populationCompleteness.criteria);
  }
  if (input.regressionHonesty !== null) {
    criteria.push(...input.regressionHonesty.criteria);
  }
  if (input.costSeparation !== null) {
    criteria.push(...input.costSeparation.criteria);
  }
  if (input.isolation !== null) {
    criteria.push(...input.isolation.criteria);
  }
  if (input.stageDiscipline !== null) {
    criteria.push(...input.stageDiscipline.criteria);
  }
  if (input.refusalHonesty !== null) {
    criteria.push(...input.refusalHonesty.criteria);
  }

  // 9. The divergence-ledger append (every divergence recorded case-by-case).
  const expectedDivergences =
    input.regressionHonesty === null
      ? 0
      : input.regressionHonesty.mechanicalDivergenceCaseIds.length;
  const divergenceLedgerCorrect =
    input.refusal !== null
      ? input.divergencesAppended === 0
      : input.divergencesAppended === expectedDivergences;
  criteria.push({
    criterionId: "divergence-ledger-case-by-case",
    strategy: "deterministic",
    status: divergenceLedgerCorrect ? "PASS" : "FAIL",
    evidence: [
      `proposal:${row.sourceProposalId}`,
      `mechanicalDivergences:${expectedDivergences}`,
      `appended:${input.divergencesAppended}`,
      divergenceLedgerCorrect
        ? "every-divergence-recorded-case-by-case (both sides' digests, never smoothed)"
        : "DIVERGENCE-LEDGER-MISMATCH (the divergence ledger does not hold exactly the mechanically-derived divergences)",
    ],
  });

  // 10. The ledger landing (the verified shadow appends to the candidate lifecycle).
  const shouldLand =
    input.refusal === null &&
    input.isolation?.contained === true &&
    input.servingIsolation?.isolated === true &&
    input.populationCompleteness?.complete === true &&
    input.regressionHonesty?.honest === true &&
    input.costSeparation?.separated === true;
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
        ? "the-shadow-appended-to-the-candidate-lifecycle (append-only, never rewriting the recorded walk)"
        : "LEDGER-LANDING-MISMATCH (a trustworthy shadow never landed, or an untrustworthy one did)",
    ],
  });

  // 11. The read-only registry (the VAL-032 entries are frozen inputs).
  criteria.push({
    criterionId: "registry-read-only",
    strategy: "deterministic",
    status: input.registryUnchanged ? "PASS" : "FAIL",
    evidence: [
      `registryUnchanged:${String(input.registryUnchanged)}`,
      input.registryUnchanged
        ? "the-candidate-registrys-existing-entries-are-read-only-inputs"
        : "REGISTRY-MUTATION (the run rewrote a candidate — the shadow verdict APPENDS, never rewrites)",
    ],
  });

  // 12. The expected-verdict contract (the observed verdict is the pinned oracle).
  const verdictMatches =
    input.verdict === row.expected.verdict &&
    (input.refusal === null
      ? row.expected.refusalReason === null
      : input.refusal.reason === row.expected.refusalReason) &&
    (input.regressionHonesty === null
      ? row.expected.divergenceCaseIds.length === 0
      : JSON.stringify(input.regressionHonesty.mechanicalDivergenceCaseIds) ===
        JSON.stringify(row.expected.divergenceCaseIds));
  criteria.push({
    criterionId: "shadow-verdict-contract",
    strategy: "deterministic",
    status: verdictMatches ? "PASS" : "FAIL",
    evidence: [
      `expectedVerdict:${row.expected.verdict}`,
      `observedVerdict:${input.verdict}`,
      `expectedRefusal:${row.expected.refusalReason ?? "none"}`,
      `observedRefusal:${input.refusal?.reason ?? "none"}`,
      `expectedDivergences:${row.expected.divergenceCaseIds.join(",") || "none"}`,
      `observedDivergences:${input.regressionHonesty?.mechanicalDivergenceCaseIds.join(",") || "none"}`,
      verdictMatches
        ? "the-shadow-run-reproduces-the-pinned-verdict"
        : "VERDICT-MISMATCH (the observed verdict differs from the pinned oracle)",
    ],
  });

  // 13. The outcome well-formedness (a refusal XOR a comparison).
  const wellFormed = (input.refusal !== null) !== (input.regressionHonesty !== null);
  criteria.push({
    criterionId: "shadow-outcome-well-formed",
    strategy: "deterministic",
    status: wellFormed ? "PASS" : "FAIL",
    evidence: [
      `refusal:${input.refusal !== null ? "reported" : "none"}`,
      `comparison:${input.regressionHonesty !== null ? "emitted" : "none"}`,
      wellFormed
        ? "exactly-one-outcome (a comparison or a refusal, never both, never neither)"
        : "MALFORMED-OUTCOME (the run emitted both or neither)",
    ],
  });

  // 14. The payload-free digest discipline (every digest is 8-hex FNV-1a).
  const digestsUnderTest = [
    ...row.trafficPopulation.map((tcase) => tcase.inputDigest),
    ...row.trafficPopulation.map((tcase) => tcase.incumbentDigest),
    ...row.trafficPopulation.flatMap((tcase) => tcase.classDigests),
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

  // 15. The run's own dispatch total (offline zero; the live row's confirmation).
  criteria.push({
    criterionId: "shadow-own-dispatch-total",
    strategy: "deterministic",
    status: input.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${input.observedModelCalls}`,
      input.observedModelCalls === row.expected.modelCalls
        ? "the-shadow-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side shadow contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/** One shadow run's app-side observation (the public-boundary read). */
export interface AppShadowObservation {
  /** The durable execution the shadow submission landed. */
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
    readonly leakKind: string | null;
  } | null;
  /** The lifecycle landing read back from the public result read. */
  readonly lifecycleLanding: {
    readonly proposalId: string;
    readonly finalStage: string;
  } | null;
  /** The read-back per-case comparison records (both sides' digests — the boundary re-derivation basis). */
  readonly comparisons: readonly {
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly shadowDigest: string;
    readonly claimedAgrees: boolean;
  }[];
  /** The read-back asserted aggregate claim. */
  readonly aggregateClaim: ShadowAggregateClaim | null;
  /** The read-back customer-facing served outcomes (source + digest per case). */
  readonly servedOutcomes: readonly {
    readonly caseId: string;
    readonly servedSource: string;
    readonly servedDigest: string;
  }[];
  /** The read-back shadow cost measurement (null when unmeasured). */
  readonly shadowCost: ShadowCostMeasurement | null;
  /** The read-back served accounting's incumbent basis (null when unreadable). */
  readonly servedIncumbentMicroUsd: number | null;
  /** The read-back served accounting's billed total (null when unreadable). */
  readonly servedCostMicroUsd: number | null;
  /** The read-back shadow ledger booking (null when nothing booked). */
  readonly shadowLedgerBookedMicroUsd: number | null;
  /** The capabilities the read-back reports the replacement exercising mid-shadow. */
  readonly exercisedCapabilities: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
}

/**
 * Judge the app-side observations against the row's shadow contract
 * (PURE): the submission landed its OWN durable execution, the
 * terminal↔criteria agreement and the expected terminal hold, the
 * read-back verdict matches the row's pinned oracle (the kind, the
 * refusal reason and the divergent cases — pinned case-by-case, never
 * smoothed), the read-back lifecycle landing is the shadow stage ONLY
 * (a landing past shadow-executed never passes), the regression
 * comparison is RE-DERIVED at the boundary over the row's declared
 * population and the READ-BACK per-case records (never trusting the
 * platform's claimed verdict — an aggregate-only claim or a smoothed
 * divergence never passes), the serving isolation is re-derived at the
 * boundary over the read-back served outcomes (a leaked shadow
 * outcome never passes), the population completeness is re-derived at
 * the boundary over the read-back compared cases, the cost separation
 * is re-derived at the boundary over the read-back costs (a billed
 * shadow never passes), the run made its OWN dispatches, and the
 * app-side trajectory digest over the public events read is a member
 * of the row's pinned shadow-trajectory class.
 */
export function verifyShadowExecutionAppContract(input: {
  readonly row: ShadowCorpusRow;
  readonly observation: AppShadowObservation;
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
        ? "the-shadow-submission-landed-its-own-execution"
        : "REJECTED (the shadow submission never landed a durable execution)",
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

  // 5. The lifecycle landing: the shadow stage ONLY (never beyond).
  if (observation.lifecycleLanding !== null) {
    const landingOk =
      observation.lifecycleLanding.proposalId === row.sourceProposalId &&
      observation.lifecycleLanding.finalStage === SHADOW_STAGE;
    criteria.push({
      criterionId: "app-lifecycle-landing-shadow-stage-only",
      strategy: "deterministic",
      status: landingOk ? "PASS" : "FAIL",
      evidence: [
        `proposal:${observation.lifecycleLanding.proposalId}`,
        `finalStage:${observation.lifecycleLanding.finalStage}`,
        `shadowStage:${SHADOW_STAGE}`,
        landingOk
          ? "shadow-executed-only (the candidate lifecycle lands at shadow-executed — canary/promotion are later slices)"
          : "OUT-OF-SCOPE-LANDING (the candidate landed past or short of the shadow stage — a skipped-stage promotion never passes)",
      ],
    });
  } else if (row.expected.verdict !== "honest-refusal") {
    criteria.push({
      criterionId: "app-lifecycle-landing-present",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-LANDING (an executed shadow must append to the candidate lifecycle)",
      ],
    });
  }

  // 6-9. The boundary re-derivations (never trust the platform's claim).
  if (observation.comparisons.length > 0) {
    const boundaryRegression = deriveRegressionHonesty({
      population: row.trafficPopulation,
      criterion: row.acceptanceCriterion,
      incumbentOutcomes: observation.comparisons.map((comparison) => ({
        caseId: comparison.caseId,
        digest: comparison.incumbentDigest,
      })),
      shadowOutcomes: observation.comparisons.map((comparison) => ({
        caseId: comparison.caseId,
        digest: comparison.shadowDigest,
        claimedAgrees: comparison.claimedAgrees,
      })),
      comparedCaseIds: observation.comparisons.map((comparison) => comparison.caseId),
      aggregateClaim: observation.aggregateClaim,
    });
    criteria.push(
      ...boundaryRegression.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );

    const boundaryServing = deriveServingIsolation({
      population: row.trafficPopulation,
      incumbentOutcomes: observation.comparisons.map((comparison) => ({
        caseId: comparison.caseId,
        digest: comparison.incumbentDigest,
      })),
      shadowOutcomes: observation.comparisons.map((comparison) => ({
        caseId: comparison.caseId,
        digest: comparison.shadowDigest,
      })),
      servedOutcomes: observation.servedOutcomes,
    });
    criteria.push(
      ...boundaryServing.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );

    const boundaryPopulation = deriveShadowPopulationCompleteness({
      recordedCaseIds: row.trafficPopulation.map((tcase) => tcase.caseId),
      workloadClassByCaseId: row.trafficWorkloadClasses,
      observedCaseIds: observation.comparisons.map((comparison) => comparison.caseId),
    });
    criteria.push(
      ...boundaryPopulation.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );

    const boundaryCost = deriveShadowCostSeparation({
      incumbentCostMicroUsd:
        observation.servedIncumbentMicroUsd === null ? 0 : observation.servedIncumbentMicroUsd,
      shadowCostMicroUsd: observation.shadowCost?.microUsd ?? null,
      servedTotalMicroUsd:
        observation.servedCostMicroUsd === null ? -1 : observation.servedCostMicroUsd,
      shadowLedgerBookedMicroUsd: observation.shadowLedgerBookedMicroUsd,
    });
    criteria.push(
      ...boundaryCost.criteria.map((criterion) => ({
        ...criterion,
        criterionId: `app-${criterion.criterionId}`,
      })),
    );
  } else if (row.expected.verdict !== "honest-refusal") {
    criteria.push({
      criterionId: "app-comparisons-readable",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `expectedVerdict:${row.expected.verdict}`,
        "MISSING-COMPARISONS (the boundary could not read the per-case comparison records)",
      ],
    });
  }

  // 10. The run's own dispatches.
  criteria.push({
    criterionId: "app-own-dispatches",
    strategy: "deterministic",
    status: observation.observedModelCalls === row.expected.modelCalls ? "PASS" : "FAIL",
    evidence: [
      `expected:${row.expected.modelCalls}`,
      `observed:${observation.observedModelCalls ?? "none"}`,
      observation.observedModelCalls === row.expected.modelCalls
        ? "the-shadow-run-made-its-own-dispatches"
        : "WRONG-DISPATCH-TOTAL (the run under- or over-dispatched)",
    ],
  });

  // 11. The app-side trajectory membership (never trust the platform's claim).
  const inClass =
    observation.trajectoryDigest !== null &&
    row.expectedTrajectoryClass.includes(observation.trajectoryDigest);
  criteria.push({
    criterionId: "app-shadow-trajectory-in-class",
    strategy: "deterministic",
    status: inClass ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${observation.trajectoryDigest ?? "none"}`,
      `classSize:${row.expectedTrajectoryClass.length}`,
      inClass
        ? "in-class (the app re-derived the shadow trajectory over the public journal)"
        : "OUT-OF-CLASS (the observed shadow trajectory drifted from the pinned class)",
    ],
  });

  return criteria;
}
