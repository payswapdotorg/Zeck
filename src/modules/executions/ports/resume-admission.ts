/**
 * Resume re-admission ports (executions module inbound seams; WORK-028,
 * LNG-003 / acceptance criterion 4).
 *
 * THE MATERIALIZITY SEAM: a resume whose facts are MATERIALLY CHANGED
 * from the checkpointed facts (see
 * `domain/checkpoint.ts#materialChangeBetween` — the explicit rule)
 * MUST re-enter the CURRENT admission controls BEFORE the resume
 * transition commits. These ports are the consulted authorities:
 *
 *   * `ResumePolicyReAdmission` — the POLICY dimension. Implemented by
 *     the executions-side adapter
 *     `adapters/policy-resume-admission.ts` against the REAL policies
 *     engine (the WORK-007 authority — the same engine behind the
 *     frozen `authorize` seam). A denial is journaled on the ledger
 *     (`resume-denied`) and the resume fails closed `POLICY_DENIED`.
 *
 *   * `ResourceReAdmission` — the RESOURCE/CAPABILITY dimension (the
 *     sandbox compute-environment re-consultation). Implemented in the
 *     sandbox module (`sandbox/adapters/execution-resume-readmission.ts`,
 *     exported from its public barrel) against the environment catalog:
 *     the environment must still exist, be available, match the
 *     declared specification digest (no stale admission), and satisfy
 *     the required capabilities.
 *
 *   * the BUDGET dimension re-uses the WORK-004 `BudgetAuthority` seam
 *     directly (the same seam the frozen `start` dispatch consults) —
 *     no new budget port exists.
 *
 * Authority discipline: the ports decide, this module never
 * reimplements them; both are REQUIRED at long-running service
 * construction — there is deliberately NO default-allow implementation
 * in this module (a materially changed resume without an admission
 * authority fails closed).
 */

import type { ExecutionRecord } from "../domain/execution";
import type { MaterialChangeDimension } from "../domain/checkpoint";
import type { ResumeFacts } from "../domain/checkpoint";

/** The neutral denial code the authority selects (frozen taxonomy). */
export type ResumeReAdmissionDenialCode = "POLICY_DENIED" | "CAPABILITY_UNAVAILABLE";

/** The request: the execution + the materially-changed resume facts. */
export interface ResumeReAdmissionRequest {
  readonly execution: ExecutionRecord;
  readonly actorId: string;
  /** The resume facts the caller intends to run under (post-change). */
  readonly resumeFacts: ResumeFacts;
  /** The checkpointed facts (pre-change) — provenance for the decision. */
  readonly checkpointedFacts: ResumeFacts;
  /** The changed dimensions (never empty when this seam is consulted). */
  readonly materialChange: readonly MaterialChangeDimension[];
}

export interface ResumeReAdmissionDecision {
  readonly allowed: boolean;
  /** Machine-readable denial reason when not allowed. */
  readonly reason?: string;
  /** The typed denial code the service surfaces (frozen taxonomy). */
  readonly denialCode?: ResumeReAdmissionDenialCode;
}

/** The POLICY re-admission seam (the WORK-007 engine behind it). */
export interface ResumePolicyReAdmission {
  readmit(request: ResumeReAdmissionRequest): Promise<ResumeReAdmissionDecision>;
}

/**
 * The RESOURCE re-admission seam (sandbox compute environments): the
 * environment binding + capability set of a materially changed resume
 * must still be admitted by the CURRENT authority state.
 */
export interface ResourceReAdmission {
  readmit(request: ResumeReAdmissionRequest): Promise<ResumeReAdmissionDecision>;
}
