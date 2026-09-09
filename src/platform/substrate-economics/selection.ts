/**
 * Substrate selection (platform substrate-economics plane; WORK-054 /
 * E1.1 charter wave member 4 — ADR-0019, ADR-0020).
 *
 * THE least-expense-sufficient selection — the Work Order's second
 * scope item and ADR-0020's quality-preserving economics applied to
 * compute substrates:
 *
 *   "Zeck can compare compute substrates by expected quality,
 *    readiness, latency, reliability and cost, then choose the least
 *    expensive sufficient substrate."
 *
 * The selection is a PURE function of (declared substrate facts,
 * constraints, configuration): required quality is a HARD FLOOR (a
 * below-floor candidate is INVALID — never merely "more expensive");
 * economics minimize above it. The comparison semantics are
 * deterministic and fully recorded:
 *
 *   sufficient  → quality ≥ floor, reliability ≥ floor (when set),
 *                 total latency (readiness + execution) ≤ ceiling
 *                 (when set), isolation ≥ floor (when set), expected
 *                 successful-resolution cost ≤ ceiling (when set);
 *   least cost  → among sufficient (substrate, mode) pairs, the
 *                 lowest expected successful-resolution cost
 *                 `ceil((startup + execution) / reliability)`;
 *   tie-break   → lower total latency, then substrateId, then
 *                 version, then the availability-mode rank — a TOTAL
 *                 order (the (substrateId, version, mode) key is
 *                 unique), so the same inputs ALWAYS produce the same
 *                 selection (architecture invariant 5).
 *
 * Every insufficient candidate carries EXACTLY ONE closed reason code
 * (recorded, never silent). ZERO candidates is legal (zero-provider
 * operation — invariant 7): the outcome is a typed `no-candidates`,
 * never a fallback default substrate (mandatory adoption is
 * impossible).
 *
 * The selection record is CONTENT-ADDRESSED EVIDENCE: `selectionId` is
 * the digest of the canonical record form (everything except the
 * derived identity, the volatile timestamp and the facts provenance
 * digests are covered — the factsDigest/constraintsDigest/
 * readinessDigest ARE covered so a drifted input produces a different
 * identity). It is evidence ONLY: nothing consults it for
 * authorization (invariant 8 / ADR-0020 — the decision record never
 * authorizes an action).
 *
 * The selection constraints are derived READ-ONLY from the WORK-049
 * optimization constraint set (`deriveSelectionConstraints`): the
 * foundation's quality floors, latency ceiling, isolation floor and
 * budget ceiling ARE the selection's governing inputs — the plane
 * defines no second authority vocabulary (invariant 1; the derivation
 * carries the source constraint ids as provenance).
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import {
  ISOLATION_LEVELS,
  type IsolationLevel,
  type OptimizationConstraint,
  validateConstraintSet,
} from "../execution-ir/constraints";
import type { IrDigestPort } from "../execution-ir/ir";
import {
  AVAILABILITY_MODE_RANK,
  boundedDetail,
  MAX_SUBSTRATE_CANDIDATES,
  READINESS_FRESHNESS_WINDOW_BOUNDS,
  rejectSubstrate,
  SUBSTRATE_SELECTOR_VERSION,
  type SubstrateAvailabilityMode,
  type SubstrateInsufficiencyCode,
  type SubstrateSelectionOutcome,
} from "./catalog";
import {
  canonicalCandidateSetJson,
  offeredModes,
  validateSubstrateCandidateSet,
} from "./facts";
import {
  classifyReadiness,
  expectedExecutionEconomics,
  type ReadinessObservation,
  type SubstrateEconomics,
  validateReadinessObservations,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// Selection constraints (typed, derived read-only from the foundation)
// ---------------------------------------------------------------------------

/**
 * The governing selection constraints — the sufficiency floors and
 * ceilings. `minQuality` is REQUIRED (quality-preserving economics:
 * a selection without its quality floor is unprovenanced optimization
 * and is rejected before it exists).
 */
export interface SubstrateSelectionConstraints {
  /** REQUIRED quality floor in [0, 1] (the hard floor — never widened). */
  readonly minQuality: number;
  /** Optional reliability floor in (0, 1]. */
  readonly minReliability?: number;
  /** Optional total-latency ceiling (readiness + execution, ms). */
  readonly maxTotalLatencyMs?: number;
  /** Optional isolation floor on the frozen ladder. */
  readonly requiredIsolation?: IsolationLevel;
  /** Optional expected successful-resolution cost ceiling (integer micro-USD). */
  readonly maxExpectedCostMicroUsd?: string;
}

const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total, deterministic validation of the selection constraints. */
export function validateSubstrateSelectionConstraints(
  value: unknown,
): SubstrateSelectionConstraints {
  if (!isRecord(value)) {
    rejectSubstrate("selection-constraint-shape", "selection constraints must be an object");
  }
  if (
    typeof value.minQuality !== "number" ||
    !Number.isFinite(value.minQuality) ||
    value.minQuality < 0 ||
    value.minQuality > 1
  ) {
    rejectSubstrate("selection-constraint-shape", "minQuality must be a probability in [0, 1]", {
      got: boundedDetail(value.minQuality),
    });
  }
  if (
    value.minReliability !== undefined &&
    (typeof value.minReliability !== "number" ||
      !Number.isFinite(value.minReliability) ||
      value.minReliability <= 0 ||
      value.minReliability > 1)
  ) {
    rejectSubstrate("selection-constraint-shape", "minReliability must be in (0, 1]", {
      got: boundedDetail(value.minReliability),
    });
  }
  if (
    value.maxTotalLatencyMs !== undefined &&
    (typeof value.maxTotalLatencyMs !== "number" ||
      !Number.isFinite(value.maxTotalLatencyMs) ||
      value.maxTotalLatencyMs < 0)
  ) {
    rejectSubstrate("selection-constraint-shape", "maxTotalLatencyMs must be finite non-negative");
  }
  if (
    value.requiredIsolation !== undefined &&
    (typeof value.requiredIsolation !== "string" ||
      !(ISOLATION_LEVELS as readonly string[]).includes(value.requiredIsolation))
  ) {
    rejectSubstrate(
      "selection-constraint-shape",
      "requiredIsolation must be on the frozen ladder",
      {
        got: boundedDetail(value.requiredIsolation),
      },
    );
  }
  if (
    value.maxExpectedCostMicroUsd !== undefined &&
    (typeof value.maxExpectedCostMicroUsd !== "string" ||
      !MICRO_USD_PATTERN.test(value.maxExpectedCostMicroUsd))
  ) {
    rejectSubstrate(
      "selection-constraint-shape",
      "maxExpectedCostMicroUsd must be an integer micro-USD string",
      {
        got: boundedDetail(value.maxExpectedCostMicroUsd),
      },
    );
  }
  return {
    minQuality: value.minQuality,
    ...(value.minReliability === undefined
      ? {}
      : { minReliability: value.minReliability as number }),
    ...(value.maxTotalLatencyMs === undefined
      ? {}
      : { maxTotalLatencyMs: value.maxTotalLatencyMs as number }),
    ...(value.requiredIsolation === undefined
      ? {}
      : { requiredIsolation: value.requiredIsolation as IsolationLevel }),
    ...(value.maxExpectedCostMicroUsd === undefined
      ? {}
      : { maxExpectedCostMicroUsd: value.maxExpectedCostMicroUsd as string }),
  };
}

/** The derived constraints plus their foundation provenance. */
export interface DerivedSelectionConstraints {
  readonly constraints: SubstrateSelectionConstraints;
  /** The constraint ids the floors/ceilings were derived from (read-only evidence). */
  readonly sourceConstraintIds: readonly string[];
}

/**
 * Derive the selection constraints READ-ONLY from the WORK-049
 * optimization constraint set: the foundation's HARD quality floors,
 * latency ceiling, isolation floor and budget ceiling ARE the
 * selection's governing inputs.
 *
 * Fail-closed: at least one HARD quality constraint carrying
 * `minQuality` is REQUIRED (the assurance threshold — the
 * verification/policy authority's contract). SOFT constraints are
 * recorded inputs, never selection floors (the foundation's own
 * discipline). Multiple hard floors compose to the STRICTEST value
 * (never the loosest — derivation may never widen).
 */
export function deriveSelectionConstraints(
  constraints: readonly OptimizationConstraint[],
): DerivedSelectionConstraints {
  const validated = validateConstraintSet(constraints);
  let minQuality: number | null = null;
  let minReliability: number | null = null;
  let maxTotalLatencyMs: number | null = null;
  let requiredIsolation: IsolationLevel | null = null;
  let maxExpectedCostMicroUsd: string | null = null;
  const sourceConstraintIds: string[] = [];
  for (const constraint of validated) {
    if (constraint.enforcement === "soft") {
      // Recorded, never enforced — the foundation discipline.
      continue;
    }
    let matched = false;
    if (constraint.kind === "quality") {
      const payload = constraint.payload as { minQuality?: number; minReliability?: number };
      if (payload.minQuality !== undefined) {
        minQuality =
          minQuality === null ? payload.minQuality : Math.max(minQuality, payload.minQuality);
        matched = true;
      }
      if (payload.minReliability !== undefined) {
        minReliability =
          minReliability === null
            ? payload.minReliability
            : Math.max(minReliability, payload.minReliability);
        matched = true;
      }
    } else if (constraint.kind === "latency") {
      const payload = constraint.payload as { maxLatencyMs?: number };
      if (payload.maxLatencyMs !== undefined) {
        maxTotalLatencyMs =
          maxTotalLatencyMs === null
            ? payload.maxLatencyMs
            : Math.min(maxTotalLatencyMs, payload.maxLatencyMs);
        matched = true;
      }
    } else if (constraint.kind === "side-effect") {
      const payload = constraint.payload as {
        isolation?: { minIsolation?: IsolationLevel };
      };
      const floor = payload.isolation?.minIsolation;
      if (floor !== undefined) {
        requiredIsolation = ladderMax(requiredIsolation, floor);
        matched = true;
      }
    } else if (constraint.kind === "budget") {
      const payload = constraint.payload as { maxCostMicroUsd?: string };
      if (payload.maxCostMicroUsd !== undefined) {
        maxExpectedCostMicroUsd =
          maxExpectedCostMicroUsd === null
            ? payload.maxCostMicroUsd
            : BigInt(maxExpectedCostMicroUsd) <= BigInt(payload.maxCostMicroUsd)
              ? maxExpectedCostMicroUsd
              : payload.maxCostMicroUsd;
        matched = true;
      }
    }
    if (matched) {
      sourceConstraintIds.push(constraint.constraintId);
    }
  }
  if (minQuality === null) {
    rejectSubstrate(
      "selection-constraint-shape",
      "substrate selection requires an explicit hard quality floor (the assurance threshold) — an unprovenanced selection is rejected before it exists",
    );
  }
  return {
    constraints: validateSubstrateSelectionConstraints({
      minQuality,
      ...(minReliability === null ? {} : { minReliability: minReliability }),
      ...(maxTotalLatencyMs === null ? {} : { maxTotalLatencyMs }),
      ...(requiredIsolation === null ? {} : { requiredIsolation }),
      ...(maxExpectedCostMicroUsd === null ? {} : { maxExpectedCostMicroUsd }),
    }),
    sourceConstraintIds,
  };
}

function ladderMax(current: IsolationLevel | null, candidate: IsolationLevel): IsolationLevel {
  if (current === null) {
    return candidate;
  }
  const currentRank = (ISOLATION_LEVELS as readonly string[]).indexOf(current);
  const candidateRank = (ISOLATION_LEVELS as readonly string[]).indexOf(candidate);
  return candidateRank > currentRank ? candidate : current;
}

/** The frozen ladder rank (higher = more isolated). */
function isolationRank(level: IsolationLevel): number {
  return (ISOLATION_LEVELS as readonly string[]).indexOf(level);
}

// ---------------------------------------------------------------------------
// The selection input and the candidate verdicts
// ---------------------------------------------------------------------------

/** The readiness input (bounded, explicit — no ambient clocks). */
export interface SubstrateReadinessInput {
  readonly observations: readonly ReadinessObservation[];
  readonly nowEpochMs: number;
  readonly freshnessWindowMs: number;
}

export interface SubstrateSelectionInput {
  /** The declared candidate set (0..64 — zero is legal: zero-provider). */
  readonly candidates: readonly unknown[];
  /** The governing selection constraints (validated). */
  readonly constraints: unknown;
  /** Optional foundation provenance: the source constraint ids the constraints were derived from. */
  readonly sourceConstraintIds?: readonly string[];
  /** Optional readiness observations (the warm/snapshot decision INPUT). */
  readonly readiness?: SubstrateReadinessInput;
  /** The explicit record timestamp (determinism: never a clock read). */
  readonly recordedAt: string;
}

/** One (substrate, mode) verdict — the full comparison evidence. */
export interface SubstrateCandidateVerdict {
  readonly substrateId: string;
  readonly version: string;
  readonly adapterRef: string;
  readonly mode: SubstrateAvailabilityMode;
  readonly economics: SubstrateEconomics;
  readonly sufficient: boolean;
  /** EXACTLY ONE closed reason code when insufficient (never silent). */
  readonly insufficiencyCode?: SubstrateInsufficiencyCode;
  readonly insufficiencyDetail?: string;
}

/** The selected (substrate, mode) with its economics. */
export interface SelectedSubstrate {
  readonly substrateId: string;
  readonly version: string;
  readonly adapterRef: string;
  readonly mode: SubstrateAvailabilityMode;
  readonly economics: SubstrateEconomics;
}

/** The content-addressed selection record — EVIDENCE ONLY. */
export interface SubstrateSelectionRecord {
  /** Digest over the canonical record form (content identity). */
  readonly selectionId: string;
  readonly selectorVersion: string;
  readonly outcome: SubstrateSelectionOutcome;
  readonly constraints: SubstrateSelectionConstraints;
  readonly sourceConstraintIds: readonly string[];
  /**
   * Every candidate verdict, in the deterministic comparison order:
   * sufficient first (least-cost order), then insufficient in
   * (substrateId, version, modeRank) order.
   */
  readonly candidates: readonly SubstrateCandidateVerdict[];
  readonly selected: SelectedSubstrate | null;
  readonly selectionBasis: string;
  readonly provenance: {
    /** Digest over the canonical declared candidate set. */
    readonly factsDigest: string;
    /** Digest over the canonical constraints + source ids. */
    readonly constraintsDigest: string;
    /** Digest over the canonical readiness input (null when absent). */
    readonly readinessDigest: string | null;
  };
  readonly recordedAt: string;
}

/** The full selection result (the record plus the typed outcome). */
export interface SubstrateSelectionResult {
  readonly record: SubstrateSelectionRecord;
  readonly outcome: SubstrateSelectionOutcome;
  readonly selected: SelectedSubstrate | null;
  readonly verdicts: readonly SubstrateCandidateVerdict[];
}

const SELECTION_BASIS =
  "least-expected-successful-resolution-cost;floors:quality-required,reliability,ceiling:latency,cost,isolation;ties:latency,substrateId,version,mode-rank(snapshot<warm<cold)";

function validateReadinessInput(value: unknown): SubstrateReadinessInput | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    rejectSubstrate("readiness-observation-shape", "readiness input must be an object");
  }
  const observations = validateReadinessObservations(value.observations as readonly unknown[]);
  if (
    typeof value.nowEpochMs !== "number" ||
    !Number.isInteger(value.nowEpochMs) ||
    value.nowEpochMs < 0
  ) {
    rejectSubstrate(
      "readiness-observation-shape",
      "readiness nowEpochMs must be a non-negative integer",
    );
  }
  if (
    typeof value.freshnessWindowMs !== "number" ||
    !Number.isInteger(value.freshnessWindowMs) ||
    value.freshnessWindowMs < READINESS_FRESHNESS_WINDOW_BOUNDS.min ||
    value.freshnessWindowMs > READINESS_FRESHNESS_WINDOW_BOUNDS.max
  ) {
    rejectSubstrate(
      "readiness-observation-shape",
      "readiness freshnessWindowMs is outside its bounds",
    );
  }
  return { observations, nowEpochMs: value.nowEpochMs, freshnessWindowMs: value.freshnessWindowMs };
}

// ---------------------------------------------------------------------------
// The sufficiency check (quality is a hard floor)
// ---------------------------------------------------------------------------

/**
 * Judge one (candidate, mode) economics against the constraints.
 * Returns sufficient + EXACTLY ONE closed reason code when not (the
 * FIRST failed dimension in the fixed order quality → reliability →
 * latency → cost — deterministic, never silent). The ISOLATION floor
 * is judged by the caller over the descriptor's declared isolation
 * class (the ladder fact, not the execution claim).
 */
function judgeSufficiency(
  economics: SubstrateEconomics,
  constraints: SubstrateSelectionConstraints,
): { sufficient: boolean; code?: SubstrateInsufficiencyCode; detail?: string } {
  if (economics.execution.expectedQuality < constraints.minQuality) {
    return {
      sufficient: false,
      code: "quality-below-floor",
      detail: `expected quality ${economics.execution.expectedQuality} is below the required floor ${constraints.minQuality}`,
    };
  }
  if (
    constraints.minReliability !== undefined &&
    economics.execution.expectedReliability < constraints.minReliability
  ) {
    return {
      sufficient: false,
      code: "reliability-below-floor",
      detail: `expected reliability ${economics.execution.expectedReliability} is below the required floor ${constraints.minReliability}`,
    };
  }
  if (
    constraints.maxTotalLatencyMs !== undefined &&
    economics.totalLatencyMs > constraints.maxTotalLatencyMs
  ) {
    return {
      sufficient: false,
      code: "latency-above-ceiling",
      detail: `total latency ${economics.totalLatencyMs}ms exceeds the ceiling ${constraints.maxTotalLatencyMs}ms`,
    };
  }
  if (
    constraints.maxExpectedCostMicroUsd !== undefined &&
    BigInt(economics.expectedSuccessfulResolutionCostMicroUsd) >
      BigInt(constraints.maxExpectedCostMicroUsd)
  ) {
    return {
      sufficient: false,
      code: "cost-above-ceiling",
      detail: `expected successful-resolution cost ${economics.expectedSuccessfulResolutionCostMicroUsd} exceeds the ceiling ${constraints.maxExpectedCostMicroUsd}`,
    };
  }
  return { sufficient: true };
}

// ---------------------------------------------------------------------------
// The deterministic comparison order (a TOTAL order)
// ---------------------------------------------------------------------------

function compareVerdicts(a: SubstrateCandidateVerdict, b: SubstrateCandidateVerdict): number {
  const costA = BigInt(a.economics.expectedSuccessfulResolutionCostMicroUsd);
  const costB = BigInt(b.economics.expectedSuccessfulResolutionCostMicroUsd);
  if (costA !== costB) {
    return costA < costB ? -1 : 1;
  }
  if (a.economics.totalLatencyMs !== b.economics.totalLatencyMs) {
    return a.economics.totalLatencyMs - b.economics.totalLatencyMs;
  }
  if (a.substrateId !== b.substrateId) {
    return a.substrateId < b.substrateId ? -1 : 1;
  }
  if (a.version !== b.version) {
    return a.version < b.version ? -1 : 1;
  }
  return AVAILABILITY_MODE_RANK[a.mode] - AVAILABILITY_MODE_RANK[b.mode];
}

// ---------------------------------------------------------------------------
// The selection itself
// ---------------------------------------------------------------------------

/**
 * The least-expense-sufficient substrate selection — PURE, total and
 * deterministic. Zero candidates is legal (the zero-provider outcome);
 * no sufficient candidate is a typed fail-closed outcome (never a
 * below-floor selection, never a fallback). The selection record is
 * content-addressed evidence — it authorizes nothing.
 */
export function selectSubstrate(
  input: SubstrateSelectionInput,
  digest: IrDigestPort,
): SubstrateSelectionResult {
  const constraints = validateSubstrateSelectionConstraints(input.constraints);
  if (typeof input.recordedAt !== "string" || input.recordedAt.length === 0) {
    rejectSubstrate("selection-constraint-shape", "recordedAt must be a non-empty string");
  }
  const sourceConstraintIds =
    input.sourceConstraintIds === undefined ? [] : [...input.sourceConstraintIds];
  if (
    !sourceConstraintIds.every(
      (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
    )
  ) {
    rejectSubstrate(
      "selection-constraint-shape",
      "sourceConstraintIds must be neutral constraint slugs",
    );
  }
  const candidates = validateSubstrateCandidateSet(input.candidates);
  if (candidates.length > MAX_SUBSTRATE_CANDIDATES) {
    rejectSubstrate(
      "selection-candidate-set",
      `candidate set exceeds the bound of ${MAX_SUBSTRATE_CANDIDATES}`,
    );
  }
  const readiness = validateReadinessInput(input.readiness ?? null);

  const verdicts: SubstrateCandidateVerdict[] = [];
  for (const descriptor of candidates) {
    const classification =
      readiness === null
        ? { kind: "unknown" as const }
        : classifyReadiness(
            readiness.observations,
            descriptor.substrateId,
            readiness.nowEpochMs,
            readiness.freshnessWindowMs,
          );
    for (const mode of offeredModes(descriptor)) {
      const economics = expectedExecutionEconomics(descriptor, mode, classification);
      // The isolation floor compares the DESCRIPTOR's isolation class
      // (the economics carry the execution claim; the ladder fact is
      // the substrate's declared isolation).
      const isolationJudgement =
        constraints.requiredIsolation !== undefined &&
        isolationRank(descriptor.isolation) < isolationRank(constraints.requiredIsolation)
          ? {
              sufficient: false,
              code: "isolation-below-floor" as SubstrateInsufficiencyCode,
              detail: `substrate isolation ${descriptor.isolation} is below the required floor ${constraints.requiredIsolation}`,
            }
          : null;
      const judgement =
        isolationJudgement !== null ? isolationJudgement : judgeSufficiency(economics, constraints);
      verdicts.push({
        substrateId: descriptor.substrateId,
        version: descriptor.version,
        adapterRef: descriptor.adapterRef,
        mode,
        economics,
        sufficient: judgement.sufficient,
        ...(judgement.code === undefined ? {} : { insufficiencyCode: judgement.code }),
        ...(judgement.detail === undefined ? {} : { insufficiencyDetail: judgement.detail }),
      });
    }
  }

  const sufficient = verdicts.filter((verdict) => verdict.sufficient).sort(compareVerdicts);
  const insufficient = verdicts
    .filter((verdict) => !verdict.sufficient)
    .sort((a, b) => compareVerdicts(a, b));
  const ordered: readonly SubstrateCandidateVerdict[] = [...sufficient, ...insufficient];
  const winner = sufficient[0] ?? null;
  const outcome: SubstrateSelectionOutcome =
    candidates.length === 0
      ? "no-candidates"
      : winner === null
        ? "no-sufficient-substrate"
        : "selected";

  const selected: SelectedSubstrate | null =
    winner === null
      ? null
      : {
          substrateId: winner.substrateId,
          version: winner.version,
          adapterRef: winner.adapterRef,
          mode: winner.mode,
          economics: winner.economics,
        };

  const factsDigest = digest.sha256Hex(canonicalCandidateSetJson(candidates));
  const constraintsDigest = digest.sha256Hex(
    canonicalJson({ constraints, sourceConstraintIds: sourceConstraintIds as readonly string[] }),
  );
  const readinessDigest =
    readiness === null
      ? null
      : digest.sha256Hex(
          canonicalJson({
            observations: readiness.observations,
            nowEpochMs: readiness.nowEpochMs,
            freshnessWindowMs: readiness.freshnessWindowMs,
          }),
        );

  const form = {
    candidates: ordered,
    constraints,
    outcome,
    provenance: { constraintsDigest, factsDigest, readinessDigest },
    selectorVersion: SUBSTRATE_SELECTOR_VERSION,
    selected,
    selectionBasis: SELECTION_BASIS,
    sourceConstraintIds: sourceConstraintIds as readonly string[],
  };
  if (!isCanonicalizable(form)) {
    throw new TypeError("selection form is not canonicalizable");
  }
  const selectionId = digest.sha256Hex(canonicalJson(form));
  const record: SubstrateSelectionRecord = {
    ...form,
    selectionId,
    recordedAt: input.recordedAt,
  };
  return { record, outcome, selected, verdicts: ordered };
}

// ---------------------------------------------------------------------------
// Selection record validation (deterministic audit / replay)
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of a (deserialized) selection record
 * INCLUDING identity verification: `selectionId` must be the digest of
 * the canonical record form (tampered or foreign records are rejected
 * at read time — the deterministic audit replay).
 */
export function validateSubstrateSelectionRecord(
  value: unknown,
  digest: IrDigestPort,
): SubstrateSelectionRecord {
  if (!isRecord(value)) {
    rejectSubstrate("selection-constraint-shape", "selection record must be an object");
  }
  if (typeof value.selectionId !== "string" || !/^[0-9a-f]{64}$/.test(value.selectionId)) {
    rejectSubstrate("selection-constraint-shape", "selectionId must be a sha256 hex digest");
  }
  if (value.selectorVersion !== SUBSTRATE_SELECTOR_VERSION) {
    rejectSubstrate(
      "selection-constraint-shape",
      "selectorVersion is outside the closed vocabulary",
      {
        got: boundedDetail(value.selectorVersion),
      },
    );
  }
  if (
    typeof value.outcome !== "string" ||
    !["selected", "no-sufficient-substrate", "no-candidates"].includes(value.outcome)
  ) {
    rejectSubstrate("selection-constraint-shape", "outcome is outside the closed vocabulary");
  }
  if (typeof value.selectionBasis !== "string" || value.selectionBasis !== SELECTION_BASIS) {
    rejectSubstrate(
      "selection-constraint-shape",
      "selectionBasis does not match the frozen comparison semantics",
    );
  }
  if (typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
    rejectSubstrate("selection-constraint-shape", "recordedAt must be non-empty");
  }
  const constraints = validateSubstrateSelectionConstraints(value.constraints);
  if (!Array.isArray(value.sourceConstraintIds)) {
    rejectSubstrate("selection-constraint-shape", "sourceConstraintIds must be an array");
  }
  if (!Array.isArray(value.candidates)) {
    rejectSubstrate("selection-candidate-set", "record candidates must be an array");
  }
  if (!isRecord(value.provenance)) {
    rejectSubstrate("selection-constraint-shape", "record provenance must be an object");
  }
  const provenance = value.provenance as Record<string, unknown>;
  for (const field of ["factsDigest", "constraintsDigest"] as const) {
    if (
      typeof provenance[field] !== "string" ||
      !/^[0-9a-f]{64}$/.test(provenance[field] as string)
    ) {
      rejectSubstrate(
        "selection-constraint-shape",
        `provenance ${field} must be a sha256 hex digest`,
      );
    }
  }
  if (
    provenance.readinessDigest !== null &&
    provenance.readinessDigest !== undefined &&
    (typeof provenance.readinessDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(provenance.readinessDigest))
  ) {
    rejectSubstrate(
      "selection-constraint-shape",
      "provenance readinessDigest must be a sha256 hex digest or null",
    );
  }

  // Identity verification: the canonical form digests to selectionId.
  const form = {
    candidates: value.candidates,
    constraints,
    outcome: value.outcome,
    provenance: {
      constraintsDigest: provenance.constraintsDigest,
      factsDigest: provenance.factsDigest,
      readinessDigest: provenance.readinessDigest ?? null,
    },
    selectorVersion: value.selectorVersion,
    selected: value.selected ?? null,
    selectionBasis: value.selectionBasis,
    sourceConstraintIds: value.sourceConstraintIds,
  };
  if (!isCanonicalizable(form)) {
    rejectSubstrate("selection-constraint-shape", "selection record form is not canonicalizable");
  }
  const computed = digest.sha256Hex(canonicalJson(form));
  if (computed !== value.selectionId) {
    rejectSubstrate(
      "selection-constraint-shape",
      "record content does not digest to the claimed selectionId",
      {
        claimed: value.selectionId,
        computed,
      },
    );
  }
  return value as unknown as SubstrateSelectionRecord;
}
