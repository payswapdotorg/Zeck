/**
 * Optimization decision records (platform execution-ir plane; WORK-049 /
 * E1.1 foundation — ADR-0020 "Required decision evidence").
 *
 * Every material optimization decision is recorded as an APPEND-ONLY
 * EVIDENCE record carrying exactly the ADR-0020 evidence contract:
 *
 *   input constraints → candidate representations (with bounded,
 *   attributed cost/latency/quality/reliability expectations) → the
 *   selected representation → cost/latency expectations → quality
 *   expectation → transformation basis → provenance.
 *
 * Non-negotiable properties (architecture invariant 5, ADR-0020):
 *
 *  - the decision record is EVIDENCE ONLY. It never authorizes an
 *    action: there is no admission surface on the record or its store,
 *    and no execution path consults it for authorization (boundary
 *    proof in the architecture tests);
 *  - the record is content-addressed (`decisionId` = digest over the
 *    canonical decision form, so re-recording the same decision is a
 *    bounded no-op and content drift produces a different identity);
 *  - building a decision VALIDATES everything: the constraint set, the
 *    candidate claims, the selection, and HARD-constraint compliance —
 *    a decision whose selected candidate violates a hard constraint is
 *    rejected before it exists (fail closed);
 *  - provenance is exact and replayable: governed plan identity
 *    (planId/revision), derived IR identity (irId), per-constraint
 *    authority sources, and the record digest for downstream
 *    integrity verification.
 *
 * The E1.1 foundation's transformation basis is closed to exactly two
 * codes: `identity` (the untransformed IR as the base representation)
 * and `representation-substitution` (choosing among candidate
 * representations). The compiler transformations (constant folding,
 * dead-step elimination, …) arrive with WORK-050 and will extend the
 * vocabulary through their own Work Order — never here.
 */

import { canonicalJson, isCanonicalizable } from "./canonical";
import type { ConstraintViolation, OptimizationConstraint } from "./constraints";
import { enforceHardConstraints, validateConstraintSet } from "./constraints";
import type { CandidateEvaluation, CandidateRepresentation } from "./cost-model";
import { evaluateCandidate, validateCandidateRepresentation } from "./cost-model";
import type { ExecutionIr, IrDigestPort } from "./ir";
import { validateExecutionIr } from "./ir";

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------

/**
 * The transformation basis codes legal in the E1.1 foundation. The
 * WORK-050 compiler transformations extend this vocabulary in their own
 * Work Order (closed here to prevent compiler scope creep in the
 * foundation).
 */
export const TRANSFORMATION_BASIS_CODES = ["identity", "representation-substitution"] as const;
export type TransformationBasisCode = (typeof TRANSFORMATION_BASIS_CODES)[number];

export const DECISION_INVARIANT_CODES = [
  "decision-shape",
  "decision-vocabulary",
  "decision-provenance",
  "decision-hard-constraint-violation",
  "decision-selection",
  "decision-identity-mismatch",
] as const;
export type DecisionInvariantCode = (typeof DECISION_INVARIANT_CODES)[number];

/** The typed, bounded decision-record validation error. */
export class DecisionValidationError extends Error {
  readonly invariant: DecisionInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: DecisionInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "DecisionValidationError";
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
  invariant: DecisionInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  const boundedDetails: Record<string, string | number | boolean | null> = {};
  if (details !== undefined) {
    for (const [key, value] of Object.entries(details)) {
      boundedDetails[key] = typeof value === "string" ? bounded(value) : value;
    }
  }
  throw new DecisionValidationError(invariant, message, boundedDetails);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASIS_DETAIL_MAX = 500;

// ---------------------------------------------------------------------------
// The decision record
// ---------------------------------------------------------------------------

/**
 * The transformation basis: the typed code plus a bounded human-auditable
 * detail of WHY the transformation is semantics-preserving.
 */
export interface TransformationBasis {
  readonly code: TransformationBasisCode;
  readonly detail: string;
}

/**
 * The decision provenance chain: governed plan → derived IR → this
 * decision. Exact, closed and replayable (the audit module verifies it
 * deterministically).
 */
export interface DecisionProvenance {
  readonly planProvenance: {
    /** The governed plan's content-addressed identity. */
    readonly planId: string;
    readonly planRevision: number;
  };
  readonly derivationProvenance: {
    /** The derived IR's content-addressed identity. */
    readonly irId: string;
    /** The IR provenance source (must be the governed-plan derivation). */
    readonly source: string;
  };
  /** The producer identity (this foundation; the compiler is WORK-050). */
  readonly recordedVia: "execution-ir-foundation";
}

/** The recorded expectation of the SELECTED representation. */
export interface SelectedExpectation {
  readonly candidateId: string;
  readonly representationClass: string;
  readonly expectedCostMicroUsd: string;
  readonly expectedLatencyMs: number;
  readonly expectedSuccessfulResolutionCostMicroUsd: string;
  readonly basis: { readonly basis: string; readonly source: string };
}

/** One recorded candidate verdict (the full comparison evidence). */
export interface RecordedCandidateVerdict {
  readonly candidateId: string;
  readonly representationClass: string;
  readonly claim: CandidateRepresentation["claim"];
  readonly evaluation: CandidateEvaluation;
}

/**
 * The optimization decision record — append-only EVIDENCE, never an
 * authorization.
 */
export interface OptimizationDecisionRecord {
  /** Content-derived identity: digest over the canonical decision form. */
  readonly decisionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The execution this decision belongs to, when plan-bound. */
  readonly executionId?: string;
  readonly planId: string;
  readonly irId: string;
  /** The assurance threshold the selection was evaluated against. */
  readonly qualityThreshold: number;
  /** Input constraints (hard + soft, with authority sources). */
  readonly constraints: readonly OptimizationConstraint[];
  /** Every candidate considered, with claims and evaluations. */
  readonly candidates: readonly RecordedCandidateVerdict[];
  readonly selectedCandidateId: string;
  readonly selectedExpectation: SelectedExpectation;
  readonly transformationBasis: TransformationBasis;
  readonly provenance: DecisionProvenance;
  readonly recordedAt: string;
  /** sha256 over the canonical FULL record form (integrity for consumers). */
  readonly recordDigest: string;
}

/** The record form excluding derived identity/integrity fields. */
type DecisionRecordForm = Omit<
  OptimizationDecisionRecord,
  "decisionId" | "recordedAt" | "recordDigest"
>;

/** Canonical decision form — the exact bytes the `decisionId` covers. */
export function canonicalDecisionForm(form: DecisionRecordForm): string {
  if (!isCanonicalizable(form)) {
    throw new TypeError("decision form is not canonicalizable");
  }
  return canonicalJson(form);
}

// ---------------------------------------------------------------------------
// Building a decision (validates everything, fail closed)
// ---------------------------------------------------------------------------

export interface BuildDecisionInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The derived Execution IR (re-validated here). */
  readonly ir: ExecutionIr;
  /** The governing constraint set (validated; must be non-empty). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The candidate representations considered. */
  readonly candidates: readonly CandidateRepresentation[];
  /** The assurance threshold applied to candidate quality. */
  readonly qualityThreshold: number;
  /** The candidate chosen as the selected representation. */
  readonly selectedCandidateId: string;
  readonly transformationBasis: TransformationBasis;
  readonly recordedAt: string;
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    reject("decision-shape", `${what} must be a UUID`, { got: bounded(value) });
  }
  return value;
}

/**
 * Build an optimization decision record. TOTAL validation:
 * identities, constraint set (non-empty — the governing inputs are part
 * of the evidence contract), candidate claims, the selection (the
 * selected candidate must be one of the recorded candidates and must
 * satisfy the quality threshold), and HARD-constraint compliance over
 * the IR + candidates (any violation rejects the decision before it
 * exists). The decision content is digest-addressed: `decisionId` is
 * derived, never caller-supplied.
 */
export function buildOptimizationDecision(
  input: BuildDecisionInput,
  digest: IrDigestPort,
): OptimizationDecisionRecord {
  requireUuid(input.applicationId, "decision applicationId");
  requireUuid(input.tenantId, "decision tenantId");
  if (input.executionId !== undefined) {
    requireUuid(input.executionId, "decision executionId");
  }

  const ir = validateExecutionIr(input.ir, digest);
  const constraints = validateConstraintSet(input.constraints);
  if (constraints.length === 0) {
    // A decision with no governing inputs is unprovenanced optimization —
    // rejected (the evidence contract requires the input constraints).
    reject("decision-provenance", "a decision must record at least its governing constraints");
  }

  const seen = new Set<string>();
  const candidates = input.candidates.map((candidate) => {
    const representation = validateCandidateRepresentation(candidate);
    if (seen.has(representation.candidateId)) {
      reject("decision-selection", "candidate ids must be unique within the decision", {
        candidateId: representation.candidateId,
      });
    }
    seen.add(representation.candidateId);
    return representation;
  });
  if (candidates.length === 0) {
    reject("decision-selection", "a decision must record at least one candidate representation");
  }
  const selected = candidates.find(
    (candidate) => candidate.candidateId === input.selectedCandidateId,
  );
  if (selected === undefined) {
    reject(
      "decision-selection",
      "selectedCandidateId must reference one of the recorded candidates",
      {
        selectedCandidateId: bounded(input.selectedCandidateId),
      },
    );
  }

  if (
    !Number.isFinite(input.qualityThreshold) ||
    input.qualityThreshold < 0 ||
    input.qualityThreshold > 1
  ) {
    reject("decision-shape", "qualityThreshold must be a probability in [0, 1]");
  }

  if (
    typeof input.transformationBasis !== "object" ||
    input.transformationBasis === null ||
    Array.isArray(input.transformationBasis)
  ) {
    reject("decision-shape", "transformationBasis must be an object");
  }
  const basisCode = input.transformationBasis.code;
  if (
    typeof basisCode !== "string" ||
    !(TRANSFORMATION_BASIS_CODES as readonly string[]).includes(basisCode)
  ) {
    reject("decision-vocabulary", "transformation basis code is outside the closed vocabulary", {
      got: bounded(basisCode),
    });
  }
  const basisDetail = input.transformationBasis.detail;
  if (
    typeof basisDetail !== "string" ||
    basisDetail.length === 0 ||
    basisDetail.length > BASIS_DETAIL_MAX
  ) {
    reject("decision-shape", "transformation basis detail must be bounded non-empty text");
  }

  if (typeof input.recordedAt !== "string" || input.recordedAt.length === 0) {
    reject("decision-shape", "recordedAt must be a non-empty string");
  }

  // Hard-constraint enforcement: fail closed BEFORE the record exists.
  const violations = enforceHardConstraints(ir, candidates, constraints);
  if (violations.length > 0) {
    reject("decision-hard-constraint-violation", "the decision violates hard constraints", {
      violations: violations.length,
      first: violations[0]?.code ?? "unknown",
      constraintId: violations[0]?.constraintId ?? "unknown",
    });
  }

  // The selected candidate must satisfy the quality-preserving rule
  // (ADR-0020: a cheaper representation below the threshold is invalid).
  const selectedEvaluation = evaluateCandidate(selected, input.qualityThreshold);
  if (!selectedEvaluation.valid) {
    reject(
      "decision-selection",
      "the selected candidate is below the required quality threshold (quality-preserving economics)",
      {
        selectedCandidateId: selected.candidateId,
        expectedQuality: selectedEvaluation.qualityExpectation.expectedQuality,
        threshold: input.qualityThreshold,
      },
    );
  }

  const verdicts: RecordedCandidateVerdict[] = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    representationClass: candidate.representationClass,
    claim: candidate.claim,
    evaluation: evaluateCandidate(candidate, input.qualityThreshold),
  }));

  const form: DecisionRecordForm = {
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    planId: ir.planId,
    irId: ir.irId,
    qualityThreshold: input.qualityThreshold,
    constraints,
    candidates: verdicts,
    selectedCandidateId: input.selectedCandidateId,
    selectedExpectation: {
      candidateId: selected.candidateId,
      representationClass: selected.representationClass,
      expectedCostMicroUsd: selected.claim.expectedCostMicroUsd,
      expectedLatencyMs: selected.claim.expectedLatencyMs,
      expectedSuccessfulResolutionCostMicroUsd:
        selectedEvaluation.expectedSuccessfulResolutionCostMicroUsd,
      basis: { basis: selected.claim.basis.basis, source: selected.claim.basis.source },
    },
    transformationBasis: { code: basisCode as TransformationBasisCode, detail: basisDetail },
    provenance: {
      planProvenance: { planId: ir.planId, planRevision: ir.planRevision },
      derivationProvenance: { irId: ir.irId, source: ir.provenance.source },
      recordedVia: "execution-ir-foundation",
    },
  };

  const decisionId = digest.sha256Hex(canonicalDecisionForm(form));
  const record: OptimizationDecisionRecord = {
    ...form,
    decisionId,
    recordedAt: input.recordedAt,
    recordDigest: digest.sha256Hex(
      canonicalJson({ ...form, decisionId, recordedAt: input.recordedAt }),
    ),
  };
  return record;
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) decision record
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Total, deterministic validation of a decision-record value (e.g. after
 * a durable round-trip): full shape, vocabularies, selection coherence,
 * provenance chain, AND identity verification — `decisionId` must be the
 * digest of the canonical form and `recordDigest` the digest of the
 * full record (tampered or foreign rows are rejected at read time).
 */
export function validateOptimizationDecision(
  value: unknown,
  digest: IrDigestPort,
): OptimizationDecisionRecord {
  if (!isRecord(value)) {
    reject("decision-shape", "optimization decision record must be an object");
  }
  const record = value;
  if (typeof record.decisionId !== "string" || !SHA256_HEX.test(record.decisionId)) {
    reject("decision-shape", "decisionId must be a sha256 hex digest", {
      got: bounded(record.decisionId),
    });
  }
  requireUuid(record.applicationId, "decision applicationId");
  requireUuid(record.tenantId, "decision tenantId");
  if (record.executionId !== undefined) {
    requireUuid(record.executionId, "decision executionId");
  }
  if (typeof record.planId !== "string" || !SHA256_HEX.test(record.planId)) {
    reject("decision-shape", "decision planId must be a sha256 hex digest");
  }
  if (typeof record.irId !== "string" || !SHA256_HEX.test(record.irId)) {
    reject("decision-shape", "decision irId must be a sha256 hex digest");
  }
  if (
    !Number.isFinite(record.qualityThreshold) ||
    (record.qualityThreshold as number) < 0 ||
    (record.qualityThreshold as number) > 1
  ) {
    reject("decision-shape", "decision qualityThreshold must be a probability in [0, 1]");
  }
  if (!Array.isArray(record.constraints) || record.constraints.length === 0) {
    reject("decision-provenance", "decision must carry its governing constraints");
  }
  validateConstraintSet(record.constraints);
  if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
    reject("decision-selection", "decision must carry at least one candidate representation");
  }
  const candidateIds = new Set<string>();
  for (const candidate of record.candidates) {
    const representation = validateCandidateRepresentation(candidate);
    if (candidateIds.has(representation.candidateId)) {
      reject("decision-selection", "candidate ids must be unique within the decision");
    }
    candidateIds.add(representation.candidateId);
    if (!isRecord(candidate.evaluation)) {
      reject("decision-shape", "each recorded candidate must carry its evaluation");
    }
  }
  if (
    typeof record.selectedCandidateId !== "string" ||
    !candidateIds.has(record.selectedCandidateId)
  ) {
    reject(
      "decision-selection",
      "selectedCandidateId must reference one of the recorded candidates",
      {
        got: bounded(record.selectedCandidateId),
      },
    );
  }
  if (!isRecord(record.selectedExpectation)) {
    reject("decision-shape", "decision must carry the selected expectation");
  }
  if (!isRecord(record.transformationBasis)) {
    reject("decision-shape", "decision must carry the transformation basis");
  }
  if (
    typeof record.transformationBasis.code !== "string" ||
    !(TRANSFORMATION_BASIS_CODES as readonly string[]).includes(record.transformationBasis.code)
  ) {
    reject("decision-vocabulary", "transformation basis code is outside the closed vocabulary", {
      got: bounded(record.transformationBasis.code),
    });
  }
  if (
    typeof record.transformationBasis.detail !== "string" ||
    record.transformationBasis.detail.length === 0 ||
    record.transformationBasis.detail.length > BASIS_DETAIL_MAX
  ) {
    reject("decision-shape", "transformation basis detail must be bounded non-empty text");
  }
  if (!isRecord(record.provenance)) {
    reject("decision-provenance", "decision must carry provenance");
  }
  if (!isRecord(record.provenance.planProvenance)) {
    reject("decision-provenance", "decision provenance must carry the plan provenance");
  }
  if (record.provenance.planProvenance.planId !== record.planId) {
    reject("decision-provenance", "plan provenance must match the decision's planId");
  }
  if (!isRecord(record.provenance.derivationProvenance)) {
    reject("decision-provenance", "decision provenance must carry the derivation provenance");
  }
  if (record.provenance.derivationProvenance.irId !== record.irId) {
    reject("decision-provenance", "derivation provenance must match the decision's irId");
  }
  if (record.provenance.recordedVia !== "execution-ir-foundation") {
    reject(
      "decision-provenance",
      "decision provenance recordedVia is outside the closed vocabulary",
      {
        got: bounded(record.provenance.recordedVia),
      },
    );
  }
  if (typeof record.recordedAt !== "string" || record.recordedAt.length === 0) {
    reject("decision-shape", "recordedAt must be a non-empty string");
  }
  if (typeof record.recordDigest !== "string" || !SHA256_HEX.test(record.recordDigest)) {
    reject("decision-shape", "recordDigest must be a sha256 hex digest");
  }

  // Identity verification: decisionId covers the canonical form (all
  // fields except the derived identity, the volatile timestamp and the
  // integrity digest); recordDigest covers the full record.
  const form: Record<string, unknown> = {
    applicationId: record.applicationId,
    tenantId: record.tenantId,
    ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
    planId: record.planId,
    irId: record.irId,
    qualityThreshold: record.qualityThreshold,
    constraints: record.constraints,
    candidates: record.candidates,
    selectedCandidateId: record.selectedCandidateId,
    selectedExpectation: record.selectedExpectation,
    transformationBasis: record.transformationBasis,
    provenance: record.provenance,
  };
  const computedDecisionId = digest.sha256Hex(canonicalJson(form));
  if (computedDecisionId !== record.decisionId) {
    reject(
      "decision-identity-mismatch",
      "decision content does not digest to the claimed decisionId",
      {
        claimed: record.decisionId,
        computed: computedDecisionId,
      },
    );
  }
  const computedRecordDigest = digest.sha256Hex(
    canonicalJson({ ...form, decisionId: record.decisionId, recordedAt: record.recordedAt }),
  );
  if (computedRecordDigest !== record.recordDigest) {
    reject(
      "decision-identity-mismatch",
      "record content does not digest to the claimed recordDigest",
      {
        claimed: record.recordDigest,
        computed: computedRecordDigest,
      },
    );
  }

  return record as unknown as OptimizationDecisionRecord;
}

/** The hard-constraint violations of an (already valid) IR + candidates. */
export function decisionConstraintViolations(
  ir: ExecutionIr,
  candidates: readonly CandidateRepresentation[],
  constraints: readonly OptimizationConstraint[],
): readonly ConstraintViolation[] {
  return enforceHardConstraints(ir, candidates, constraints);
}
