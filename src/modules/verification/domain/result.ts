/**
 * Verification results (verification module domain; WORK-013).
 *
 * THE durable evidence record of the verification authority
 * (`IMPLEMENTATION.md` §12: "Every verifier returns an evidence record,
 * not merely a boolean"). A result answers the full provenance question
 * set of the WORK-013 result model:
 *
 *   What was evaluated?      — `target` (kind + ref + revision binding)
 *   Against what criteria?   — `criterionId` + `criteriaVersion`
 *   Using which evaluator?   — `evaluator` (kind + identity + version)
 *   What evidence was used?  — `evidence` (durable references)
 *   What was the result?     — `status` (PASS | FAIL | INCONCLUSIVE)
 *   When?                    — `recordedAt`
 *   For which execution?     — `executionId` (+ application/tenant scope)
 *   Under which policy?      — `policyEvidence` (admission provenance)
 *   By whom or what?         — `recordedBy` + `evaluationId` provenance
 *
 * STATUS SEMANTICS (frozen — `spec/contracts.md` error taxonomy pairs
 * VERIFICATION_FAILED / VERIFICATION_INCONCLUSIVE with the FAIL /
 * INCONCLUSIVE states):
 *
 *   PASS         — the evidence satisfies the declared criteria.
 *   FAIL         — the evidence demonstrates the criteria were NOT met.
 *   INCONCLUSIVE — the available evidence is insufficient to establish
 *                  PASS or FAIL. It NEVER silently becomes PASS: the
 *                  conclusion logic treats an INCONCLUSIVE required
 *                  criterion as unmet (escalation/replan territory, never
 *                  acceptance), and the storage boundary physically
 *                  requires evidence + criteria binding for every PASS
 *                  (migration 0007) so "provider HTTP 200 → PASS" and
 *                  "missing evidence → PASS" are unrepresentable.
 *
 * Results are IMMUTABLE once recorded (revision/provenance-bound — no
 * mutable "verification truth"): the physical append-only boundary is
 * migration 0007's trigger; the domain surface here simply has no update
 * path.
 *
 * VERIFICATION vs the OTHER SUCCESS AXES (the VER-001 separation):
 * provider success, tool success, execution success and verification
 * PASS are disjoint vocabularies. The provider axis lives in the models
 * module (its provider outcome classes), the tool axis in the tools
 * module (its tool outcome classes) — neither can be stored here:
 * `status` is CHECK-bound to PASS | FAIL | INCONCLUSIVE at the storage
 * boundary.
 */

export const VERIFICATION_STATUSES = ["PASS", "FAIL", "INCONCLUSIVE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export function isVerificationStatus(value: string): value is VerificationStatus {
  return (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/**
 * What a verification evaluates (substrate-neutral per ACR-003 /
 * ADR-0016: the target may be an execution output, a plan revision, an
 * artifact, a tool output, a model output, a structured record, or a
 * comparison candidate — evidence about the result, never one modality).
 */
export const VERIFICATION_TARGET_KINDS = [
  "execution-output",
  "plan-revision",
  "artifact",
  "tool-output",
  "model-output",
  "record",
  "candidate",
] as const;

export type VerificationTargetKind = (typeof VERIFICATION_TARGET_KINDS)[number];

export function isVerificationTargetKind(value: string): value is VerificationTargetKind {
  return (VERIFICATION_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The target binding. `ref` is the target identity in ITS OWN identity
 * system (execution output reference, plan revision id, artifact digest,
 * tool invocation id, candidate id) — verification never creates a
 * parallel artifact identity (it CONSUMES existing identity/lineage).
 * `revision` binds the result to a specific revision of the target
 * (e.g. the plan revision id or artifact digest): a result for an older
 * revision is STALE for a newer one and the conclusion logic counts
 * only revision-matching results.
 */
export interface VerificationTarget {
  readonly kind: VerificationTargetKind;
  readonly ref: string;
  readonly revision?: string;
}

export const EVALUATOR_KINDS = ["deterministic", "model", "human"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export function isEvaluatorKind(value: string): value is EvaluatorKind {
  return (EVALUATOR_KINDS as readonly string[]).includes(value);
}

/**
 * WHO/WHAT produced the assessment. Version is mandatory (M20: evaluator
 * version not recorded is unrepresentable) — evaluators register with an
 * explicit version and every result records it.
 */
export interface EvaluatorIdentity {
  readonly kind: EvaluatorKind;
  readonly id: string;
  readonly version: string;
}

/** Durable policy-admission provenance (the WORK-007 evidence shape). */
export interface VerificationPolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

/** The provenance chain: which governed evaluation produced this result. */
export interface ResultProvenance {
  /** The durable evaluation journal identity (verification.evaluations). */
  readonly evaluationId: string;
  /** The acting principal (service actor or human decision submitter). */
  readonly actorId: string;
  /** Why this evaluation ran (caller-supplied cause class). */
  readonly cause?: string;
  /** For human results: the request the decision answers. */
  readonly humanRequestId?: string;
}

/** The durable, immutable verification result (migration 0007 shape). */
export interface VerificationResultRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly target: VerificationTarget;
  readonly criterionId: string;
  readonly criteriaVersion: number;
  readonly evaluator: EvaluatorIdentity;
  readonly status: VerificationStatus;
  /** Optional scalar confidence in [0,1] (judged criteria may carry it). */
  readonly confidence?: number;
  readonly observations: readonly string[];
  /** Durable evidence references considered (non-empty for PASS). */
  readonly evidence: readonly string[];
  readonly policyEvidence?: VerificationPolicyEvidence;
  readonly provenance: ResultProvenance;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface ResultValidationIssues {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Validate a result BEFORE it becomes durable. The domain half of the
 * VERIFICATION-SEPARATION checkpoint: PASS without evidence, PASS without
 * criteria binding, results without evaluator identity/version, detached
 * provenance (no evaluation), and unknown status/target vocabularies are
 * rejected here — and PHYSICALLY unrepresentable at the storage boundary
 * (migration 0007 CHECK constraints).
 */
export function validateResult(result: {
  id?: unknown;
  applicationId?: unknown;
  tenantId?: unknown;
  executionId?: unknown;
  target?: unknown;
  criterionId?: unknown;
  criteriaVersion?: unknown;
  evaluator?: unknown;
  status?: unknown;
  confidence?: unknown;
  observations?: unknown;
  evidence?: unknown;
  provenance?: unknown;
  recordedBy?: unknown;
}): ResultValidationIssues {
  const issues: string[] = [];
  if (typeof result.id !== "string" || result.id.length === 0) {
    issues.push("id must be a non-empty string");
  }
  if (typeof result.applicationId !== "string" || result.applicationId.length === 0) {
    issues.push("applicationId must be a non-empty string");
  }
  if (typeof result.tenantId !== "string" || result.tenantId.length === 0) {
    issues.push("tenantId must be a non-empty string");
  }
  if (typeof result.executionId !== "string" || result.executionId.length === 0) {
    issues.push("executionId must be a non-empty string");
  }
  if (
    result.target === null ||
    typeof result.target !== "object" ||
    typeof (result.target as VerificationTarget).kind !== "string" ||
    !isVerificationTargetKind((result.target as VerificationTarget).kind) ||
    typeof (result.target as VerificationTarget).ref !== "string" ||
    (result.target as VerificationTarget).ref.length === 0
  ) {
    issues.push("target must carry a known kind and a non-empty ref");
  }
  if (typeof result.criterionId !== "string" || result.criterionId.length === 0) {
    issues.push("criterionId must be a non-empty string (criteria binding is mandatory)");
  }
  if (
    typeof result.criteriaVersion !== "number" ||
    !Number.isInteger(result.criteriaVersion) ||
    result.criteriaVersion < 1
  ) {
    issues.push("criteriaVersion must be a positive integer");
  }
  if (
    result.evaluator === null ||
    typeof result.evaluator !== "object" ||
    !isEvaluatorKind((result.evaluator as EvaluatorIdentity)?.kind ?? "") ||
    typeof (result.evaluator as EvaluatorIdentity)?.id !== "string" ||
    (result.evaluator as EvaluatorIdentity).id.length === 0 ||
    typeof (result.evaluator as EvaluatorIdentity)?.version !== "string" ||
    (result.evaluator as EvaluatorIdentity).version.length === 0
  ) {
    issues.push("evaluator must carry a known kind, a non-empty id and a non-empty version");
  }
  if (typeof result.status !== "string" || !isVerificationStatus(result.status)) {
    issues.push("status must be one of PASS|FAIL|INCONCLUSIVE");
  }
  if (result.confidence !== undefined) {
    if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1) {
      issues.push("confidence must be a number in [0,1] when present");
    }
  }
  if (
    result.observations !== undefined &&
    (!Array.isArray(result.observations) ||
      result.observations.some((observation) => typeof observation !== "string"))
  ) {
    issues.push("observations must be an array of strings");
  }
  if (!Array.isArray(result.evidence) || result.evidence.some((ref) => typeof ref !== "string")) {
    issues.push("evidence must be an array of reference strings");
  } else if (result.status === "PASS" && result.evidence.length === 0) {
    issues.push("PASS requires at least one evidence reference (no evidence, no PASS)");
  }
  if (
    result.provenance === null ||
    typeof result.provenance !== "object" ||
    typeof (result.provenance as ResultProvenance)?.evaluationId !== "string" ||
    (result.provenance as ResultProvenance).evaluationId.length === 0 ||
    typeof (result.provenance as ResultProvenance)?.actorId !== "string" ||
    (result.provenance as ResultProvenance).actorId.length === 0
  ) {
    issues.push("provenance must bind the evaluationId and actorId (no detached results)");
  }
  if (typeof result.recordedBy !== "string" || result.recordedBy.length === 0) {
    issues.push("recordedBy must be a non-empty string");
  }
  return { ok: issues.length === 0, issues };
}
