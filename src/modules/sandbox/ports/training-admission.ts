/**
 * Training admission port (sandbox module outbound; WORK-030).
 *
 * ENFORCES the frozen "policy before dispatch" invariant at the
 * training-workload boundary (the sandbox-admission twin for the
 * accelerator axis): no training workload is admitted — and therefore
 * no accelerator allocation can ever happen — before the policy
 * admission decision allows it. The request carries the workload's
 * DECLARED admission facts (workload kind, accelerator class, the
 * resource estimate's cost class, secret references) plus the execution
 * binding; the decision is the authority's. This port decides nothing
 * locally, and there is no training-specific policy engine anywhere in
 * this module.
 */

import type { AcceleratorClass, TrainingWorkloadKind } from "../domain/workload";

export interface TrainingAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly workloadKind: TrainingWorkloadKind;
  readonly acceleratorClass: AcceleratorClass;
  /** The declared cost class of the resource estimate ("uncosted" never occurs — training is paid compute). */
  readonly estimatedCostMicroUsd: string;
  /** Secret references the workload declares (empty when access none). */
  readonly secretRefs: readonly string[];
}

export type TrainingAdmissionDecision =
  | {
      readonly allowed: true;
      /** Durable admission provenance (effective policy identity + digest). */
      readonly evidence?: {
        readonly policySetId: string;
        readonly policySetVersion: number;
        readonly policyContentHash: string;
        readonly restrictionSetDigest: string;
      };
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface TrainingAdmission {
  admit(request: TrainingAdmissionRequest): Promise<TrainingAdmissionDecision>;
}
