/**
 * Verification admission port (verification module outbound; WORK-013).
 *
 * ENFORCES the frozen "policy before dispatch" invariant at the
 * verification boundary (`spec/architecture.md` §2.4, architecture-lock
 * invariant 3): no evaluator is executed, no human-evaluation request is
 * created and no candidate comparison runs before the policy admission
 * decision allows it. Policy remains authoritative over whether
 * evaluation, model-based judging, human escalation and candidate
 * comparison are allowed (`spec/architecture.md` §16 "user/human
 * escalation" is a policy-controlled dimension).
 *
 * This port is REQUIRED at service construction: a verification service
 * that cannot consult the policy authority is not constructible — there
 * is deliberately NO default-allow implementation in this module (the
 * WORK-010 `ToolAdmission` discipline: "no default-allow exists"). The
 * production adapter (`adapters/policy-verification-admission.ts`)
 * delegates to the REAL WORK-007 policy engine; tests inject fakes.
 */

import type { EvaluatorIdentity, VerificationPolicyEvidence } from "../domain/result";

/** The governed verification actions the authority admits. */
export const VERIFICATION_ADMISSION_ACTIONS = [
  "evaluate",
  "model-evaluation",
  "human-evaluation",
  "compare-candidates",
] as const;

export type VerificationAdmissionAction = (typeof VERIFICATION_ADMISSION_ACTIONS)[number];

export interface VerificationAdmissionRequest {
  readonly action: VerificationAdmissionAction;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /**
   * The evaluator that would run (evaluate/model-evaluation actions): the
   * authority sees WHO would assess, and — for model judges — the
   * provider-neutral rail references the judge dispatch would use.
   */
  readonly evaluator?: EvaluatorIdentity;
  /** Provider-neutral rail references a model-judge dispatch would use. */
  readonly provider?: string;
  readonly model?: string;
}

export type VerificationAdmissionDecision =
  | {
      readonly allowed: true;
      /** Durable admission provenance (effective policy identity + digest). */
      readonly evidence?: VerificationPolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface VerificationAdmission {
  admit(request: VerificationAdmissionRequest): Promise<VerificationAdmissionDecision>;
}
