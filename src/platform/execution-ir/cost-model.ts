/**
 * The expected successful-resolution cost model (platform execution-ir
 * plane; WORK-049 / E1.1 foundation — ADR-0020).
 *
 * The E1.1 objective is "the lowest expected-cost execution
 * representation that satisfies policy, capability, quality,
 * reliability, latency, verification and side-effect constraints". This
 * module is the FOUNDATION's evaluation machinery:
 *
 *  - every cost claim is BOUNDED (integer micro-USD money, finite
 *    non-negative latency, [0,1] quality, (0,1] reliability) and carries
 *    an EXPLICIT estimation basis (observed | estimated | defaulted)
 *    with a bounded attribution source — unbounded or unattributed
 *    claims are rejected by validation, never silently rounded
 *    (architecture invariant 4, discrimination-tested);
 *  - the expected cost of a SUCCESSFULLY RESOLVED outcome is
 *    `ceil(expectedCost / reliability)` — bounded integer arithmetic
 *    with typed overflow rejection (a zero-reliability claim is
 *    unrepresentable: its expected successful-resolution cost is
 *    unbounded);
 *  - QUALITY-PRESERVING ECONOMICS (ADR-0020): a candidate whose
 *    expected quality is below the required assurance threshold is
 *    INVALID — never merely "more expensive". A cheaper representation
 *    below the threshold cannot win a selection;
 *  - the selection basis is deterministic and fully recorded: valid
 *    candidates order by expected successful-resolution cost ascending,
 *    ties broken by the canonical representation ladder, then by
 *    candidate id. The comparison itself is EVIDENCE — it never
 *    authorizes anything (invariant 5; budget/execution admission stays
 *    with the existing authorities).
 *
 * Representation classes are the canonical E1.1 ladder
 * (deterministic → cache/reuse → verified competence → programmatic →
 * sufficient model → stronger model → parallel/multi-agent → computer
 * use → human escalation) as neutral vocabulary — no provider/vendor
 * semantics (invariant 8).
 */

import { canonicalJson, isCanonicalizable } from "./canonical";
import type { IrDigestPort } from "./ir";

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------

/**
 * The estimation bases every cost claim must declare (ADR-0020: "bounded,
 * auditable expected-cost claims with an explicit estimation basis").
 */
export const COST_BASES = ["observed", "estimated", "defaulted"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/**
 * The canonical representation ladder (E1.1 charter "Canonical execution
 * representation ladder"; ADR-0020 "The compiler may select and
 * compose"). Index order IS the canonical preference order — cheapest
 * sufficient representation first. Neutral vocabulary only.
 */
export const REPRESENTATION_CLASSES = [
  "deterministic-computation",
  "cache-reuse",
  "verified-competence",
  "programmatic-execution",
  "sufficient-model",
  "stronger-model",
  "parallel-multi-agent",
  "computer-use",
  "human-escalation",
] as const;
export type RepresentationClass = (typeof REPRESENTATION_CLASSES)[number];

export function representationLadderRank(representationClass: RepresentationClass): number {
  return REPRESENTATION_CLASSES.indexOf(representationClass);
}

/**
 * Cost-model invariant codes (typed, bounded rejections).
 */
export const COST_MODEL_INVARIANT_CODES = [
  "claim-shape",
  "unattributed-cost",
  "unbounded-cost",
  "unreliable-representation",
  "candidate-shape",
  "no-admissible-candidate",
] as const;
export type CostModelInvariantCode = (typeof COST_MODEL_INVARIANT_CODES)[number];

/** The typed, bounded cost-model validation error. */
export class CostModelError extends Error {
  readonly invariant: CostModelInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: CostModelInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "CostModelError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details });
  }
}

const DETAIL_LIMIT = 200;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

function reject(
  invariant: CostModelInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
    }
  }
  throw new CostModelError(invariant, message, boundedDetails);
}

// ---------------------------------------------------------------------------
// Bounded money convention (integer micro-USD — the platform convention)
// ---------------------------------------------------------------------------

/**
 * The bounded money universe for IR cost claims: integer micro-USD in
 * [0, 10^18) — the same bound the budgets module's money domain uses.
 * Claims outside the bound are rejected as unbounded.
 */
export const MAX_IR_COST_MICRO_USD = "999999999999999999";
const MAX_COST_BIGINT = 999999999999999999n;
const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

function parseBoundedMicroUsd(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !MICRO_USD_PATTERN.test(value)) {
    reject("unbounded-cost", `${what} must be an integer micro-USD string in [0, 10^18)`, {
      got: bounded(value),
    });
  }
  const parsed = BigInt(value);
  if (parsed > MAX_COST_BIGINT) {
    reject("unbounded-cost", `${what} exceeds the bounded money universe`, { got: bounded(value) });
  }
  return parsed;
}

const MAX_LATENCY_MS = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Cost claims
// ---------------------------------------------------------------------------

/**
 * The explicit estimation basis EVERY cost claim must carry. `source` is
 * a bounded attribution string naming where the number came from (e.g.
 * "planning.route-table", "capability-catalog-default"); `evidenceDigest`
 * optionally pins the evidence bytes the claim was derived from.
 */
export interface CostBasisAttribution {
  readonly basis: CostBasis;
  readonly source: string;
  readonly evidenceDigest?: string;
}

/**
 * A bounded, attributed cost expectation for one candidate
 * representation.
 */
export interface CostClaim {
  /** Integer micro-USD, [0, 10^18). */
  readonly expectedCostMicroUsd: string;
  /** Finite non-negative milliseconds. */
  readonly expectedLatencyMs: number;
  /** Expected quality in [0, 1]. */
  readonly expectedQuality: number;
  /** Expected success probability in (0, 1] — zero is unrepresentable. */
  readonly expectedReliability: number;
  /** REQUIRED explicit estimation basis (unattributed claims are rejected). */
  readonly basis: CostBasisAttribution;
}

const ATTRIBUTION_SOURCE_MAX = 200;

/**
 * Total, deterministic validation of a cost claim. Rejects unbounded
 * numbers, out-of-universe quality/reliability and UNATTRIBUTED claims
 * (the "never unbounded or unattributed numbers" invariant).
 */
export function validateCostClaim(value: unknown): CostClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("claim-shape", "cost claim must be an object");
  }
  const record = value as Record<string, unknown>;
  parseBoundedMicroUsd(record.expectedCostMicroUsd, "cost claim expectedCostMicroUsd");
  if (
    typeof record.expectedLatencyMs !== "number" ||
    !Number.isFinite(record.expectedLatencyMs) ||
    record.expectedLatencyMs < 0 ||
    record.expectedLatencyMs > MAX_LATENCY_MS
  ) {
    reject("unbounded-cost", "cost claim expectedLatencyMs must be finite in [0, 2^53-1]", {
      got: bounded(record.expectedLatencyMs),
    });
  }
  if (
    typeof record.expectedQuality !== "number" ||
    !Number.isFinite(record.expectedQuality) ||
    record.expectedQuality < 0 ||
    record.expectedQuality > 1
  ) {
    reject("claim-shape", "cost claim expectedQuality must be a probability in [0, 1]", {
      got: bounded(record.expectedQuality),
    });
  }
  if (
    typeof record.expectedReliability !== "number" ||
    !Number.isFinite(record.expectedReliability) ||
    record.expectedReliability <= 0 ||
    record.expectedReliability > 1
  ) {
    // A zero-reliability representation has UNBOUNDED expected
    // successful-resolution cost — unrepresentable in the bounded model.
    reject("unreliable-representation", "cost claim expectedReliability must be in (0, 1]", {
      got: bounded(record.expectedReliability),
    });
  }
  const basis = record.basis;
  if (typeof basis !== "object" || basis === null || Array.isArray(basis)) {
    reject("unattributed-cost", "cost claim must carry an estimation basis");
  }
  const basisRecord = basis as Record<string, unknown>;
  if (
    typeof basisRecord.basis !== "string" ||
    !(COST_BASES as readonly string[]).includes(basisRecord.basis)
  ) {
    reject("unattributed-cost", "cost claim basis is outside the closed estimation vocabulary", {
      got: bounded(basisRecord.basis),
    });
  }
  if (
    typeof basisRecord.source !== "string" ||
    basisRecord.source.length === 0 ||
    basisRecord.source.length > ATTRIBUTION_SOURCE_MAX
  ) {
    reject("unattributed-cost", "cost claim basis source must be a bounded non-empty string", {
      got: bounded(basisRecord.source),
    });
  }
  if (
    basisRecord.evidenceDigest !== undefined &&
    (typeof basisRecord.evidenceDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(basisRecord.evidenceDigest))
  ) {
    reject("claim-shape", "cost claim basis evidenceDigest must be a sha256 hex digest");
  }
  return {
    expectedCostMicroUsd: record.expectedCostMicroUsd as string,
    expectedLatencyMs: record.expectedLatencyMs as number,
    expectedQuality: record.expectedQuality as number,
    expectedReliability: record.expectedReliability as number,
    basis: {
      basis: basisRecord.basis as CostBasis,
      source: basisRecord.source as string,
      ...(basisRecord.evidenceDigest === undefined
        ? {}
        : { evidenceDigest: basisRecord.evidenceDigest }),
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate representations
// ---------------------------------------------------------------------------

const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_MAX = 500;

/**
 * A candidate representation of the governed plan (one point in the
 * E1.1 search space). WORK-049 represents and evaluates candidates; the
 * compiler that GENERATES them is WORK-050.
 */
export interface CandidateRepresentation {
  /** Stable candidate identifier, unique within a decision. */
  readonly candidateId: string;
  readonly representationClass: RepresentationClass;
  /** Bounded human-auditable description of the representation. */
  readonly description?: string;
  readonly claim: CostClaim;
  /**
   * The IR variant this candidate represents. The BASE representation
   * references the derived IR's `irId`; a transformed variant carries
   * its own variant identity (produced by the WORK-050 compiler).
   * Absent when the candidate is a partial representation choice.
   */
  readonly variantIrId?: string;
}

/** Total, deterministic validation of a candidate representation. */
export function validateCandidateRepresentation(value: unknown): CandidateRepresentation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("candidate-shape", "candidate representation must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.candidateId !== "string" || !CANDIDATE_ID.test(record.candidateId)) {
    reject("candidate-shape", "candidate candidateId must be a lowercase slug", {
      got: bounded(record.candidateId),
    });
  }
  if (
    typeof record.representationClass !== "string" ||
    !(REPRESENTATION_CLASSES as readonly string[]).includes(record.representationClass)
  ) {
    reject(
      "candidate-shape",
      "candidate representationClass is outside the closed neutral ladder vocabulary",
      { got: bounded(record.representationClass) },
    );
  }
  if (record.description !== undefined) {
    if (
      typeof record.description !== "string" ||
      record.description.length === 0 ||
      record.description.length > DESCRIPTION_MAX
    ) {
      reject("candidate-shape", "candidate description must be bounded when present");
    }
  }
  if (record.variantIrId !== undefined) {
    if (typeof record.variantIrId !== "string" || !/^[0-9a-f]{64}$/.test(record.variantIrId)) {
      reject("candidate-shape", "candidate variantIrId must be a sha256 hex digest");
    }
  }
  const claim = validateCostClaim(record.claim);
  return {
    candidateId: record.candidateId as string,
    representationClass: record.representationClass as RepresentationClass,
    ...(record.description === undefined ? {} : { description: record.description as string }),
    claim,
    ...(record.variantIrId === undefined ? {} : { variantIrId: record.variantIrId as string }),
  };
}

// ---------------------------------------------------------------------------
// Expected successful-resolution evaluation
// ---------------------------------------------------------------------------

/** Why a candidate is invalid as a representation choice. */
export type CandidateInadmissibleCode = "quality-below-threshold";

/** The evaluated expectation of one candidate against one threshold. */
export interface CandidateEvaluation {
  readonly candidateId: string;
  readonly representationClass: RepresentationClass;
  /** False when the candidate violates the quality-preserving rule. */
  readonly valid: boolean;
  readonly inadmissibleReason?: CandidateInadmissibleCode;
  /**
   * Expected cost of a SUCCESSFULLY RESOLVED outcome:
   * ceil(expectedCost / reliability), bounded integer micro-USD.
   */
  readonly expectedSuccessfulResolutionCostMicroUsd: string;
  readonly expectedLatencyMs: number;
  readonly qualityExpectation: {
    readonly expectedQuality: number;
    readonly threshold: number;
    readonly meetsThreshold: boolean;
  };
  readonly basis: CostBasisAttribution;
}

/**
 * Evaluate one candidate against the required quality/reliability
 * threshold. The expected successful-resolution cost is computed with
 * bounded integer arithmetic and a conservative ceiling; overflow past
 * the bounded money universe is a typed rejection (never a silent
 * infinity).
 */
export function evaluateCandidate(
  candidate: CandidateRepresentation,
  qualityThreshold: number,
): CandidateEvaluation {
  if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 1) {
    reject("claim-shape", "quality threshold must be a probability in [0, 1]", {
      got: bounded(qualityThreshold),
    });
  }
  const claim = validateCostClaim(candidate.claim);
  const cost = parseBoundedMicroUsd(claim.expectedCostMicroUsd, "claim cost");
  const reliability = claim.expectedReliability;
  // ceil(cost / reliability) in bounded integer arithmetic: reliability
  // is (0,1], so the quotient is finite; compute with scaled integers.
  const scaled = BigInt(Math.round(reliability * 1e12));
  if (scaled <= 0n) {
    reject("unreliable-representation", "reliability scaling collapsed to zero", {
      reliability: bounded(reliability),
    });
  }
  const quotient = (cost * 1000000000000n + scaled - 1n) / scaled;
  if (quotient > MAX_COST_BIGINT) {
    reject("unbounded-cost", "expected successful-resolution cost exceeds the bounded universe", {
      expectedCostMicroUsd: claim.expectedCostMicroUsd,
      reliability: bounded(reliability),
    });
  }
  const meetsThreshold = claim.expectedQuality >= qualityThreshold;
  return {
    candidateId: candidate.candidateId,
    representationClass: candidate.representationClass,
    valid: meetsThreshold,
    ...(meetsThreshold ? {} : { inadmissibleReason: "quality-below-threshold" as const }),
    expectedSuccessfulResolutionCostMicroUsd: quotient.toString(),
    expectedLatencyMs: claim.expectedLatencyMs,
    qualityExpectation: {
      expectedQuality: claim.expectedQuality,
      threshold: qualityThreshold,
      meetsThreshold,
    },
    basis: claim.basis,
  };
}

// ---------------------------------------------------------------------------
// Deterministic selection basis
// ---------------------------------------------------------------------------

export interface CandidateSelection {
  readonly kind: "selected" | "no-admissible-candidate";
  readonly selected: CandidateEvaluation | null;
  /**
   * Every evaluation, in the deterministic selection order: valid
   * candidates first, ordered by expected successful-resolution cost
   * ascending, ties by canonical representation-ladder rank, ties by
   * candidateId; invalid candidates follow in input order. This IS the
   * auditable comparison basis (why the cheaper did or did not win).
   */
  readonly evaluations: readonly CandidateEvaluation[];
  /** The frozen, human-auditable selection-basis statement. */
  readonly selectionBasis: string;
}

function compareEvaluations(a: CandidateEvaluation, b: CandidateEvaluation): number {
  const costA = BigInt(a.expectedSuccessfulResolutionCostMicroUsd);
  const costB = BigInt(b.expectedSuccessfulResolutionCostMicroUsd);
  if (costA !== costB) {
    return costA < costB ? -1 : 1;
  }
  const rankA = representationLadderRank(a.representationClass);
  const rankB = representationLadderRank(b.representationClass);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  if (a.candidateId !== b.candidateId) {
    return a.candidateId < b.candidateId ? -1 : 1;
  }
  return 0;
}

/**
 * Select the least expensive sufficient candidate representation —
 * DETERMINISTIC, and evidence only (never an authorization).
 *
 * Ordering: expected successful-resolution cost ascending; ties broken
 * by the canonical representation ladder (cheaper-in-ladder first),
 * then by candidate id. Candidates below the quality threshold are
 * INVALID and can never win (quality-preserving economics).
 */
export function selectCandidate(
  candidates: readonly CandidateRepresentation[],
  qualityThreshold: number,
): CandidateSelection {
  const seen = new Set<string>();
  const validated = candidates.map((candidate) => {
    const representation = validateCandidateRepresentation(candidate);
    if (seen.has(representation.candidateId)) {
      reject("candidate-shape", "candidate ids must be unique within a decision", {
        candidateId: representation.candidateId,
      });
    }
    seen.add(representation.candidateId);
    return representation;
  });
  const evaluations = validated.map((candidate) => evaluateCandidate(candidate, qualityThreshold));
  const valid = evaluations.filter((evaluation) => evaluation.valid).sort(compareEvaluations);
  const invalid = evaluations.filter((evaluation) => !evaluation.valid);
  const ordered = [...valid, ...invalid];
  const selected = valid[0] ?? null;
  return {
    kind: selected === null ? "no-admissible-candidate" : "selected",
    selected,
    evaluations: ordered,
    selectionBasis:
      "lowest-expected-successful-resolution-cost;ties:representation-ladder,candidateId;quality-threshold-applied-as-validity",
  };
}

// ---------------------------------------------------------------------------
// Canonical claim serialization (digest stability for decision records)
// ---------------------------------------------------------------------------

/** Canonical JSON of a candidate (closed universe, sorted keys). */
export function canonicalCandidateForm(candidate: CandidateRepresentation): string {
  if (!isCanonicalizable(candidate)) {
    throw new TypeError("candidate is not canonicalizable");
  }
  return canonicalJson(candidate);
}

/** Digest of the candidate form (integrity pinning for evidence). */
export function candidateDigest(candidate: CandidateRepresentation, digest: IrDigestPort): string {
  return digest.sha256Hex(canonicalCandidateForm(candidate));
}
