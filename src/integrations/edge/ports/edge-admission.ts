/**
 * Edge admission ports (edge integration outbound; WORK-029,
 * EDGE-003/AC-4).
 *
 * The REQUIRED authority seams of the edge governance service — the
 * same authorities every other governed surface consults, never
 * reimplemented here, never bypassed:
 *
 *   - `EdgePolicyAdmission` — the WORK-007 policy engine decides the
 *     edge tool/device/controller facts BEFORE any external controller
 *     interaction (a denial is journaled and thrown typed; ZERO
 *     actuator-path activity is possible on a denial — the
 *     policy-before-side-effect ordering proof);
 *   - `EdgeCapabilityGate` — the WORK-005 capability registry
 *     arbitrates the capability atoms the device declared and the
 *     envelope/command requires.
 *
 * Budget admission is the WORK-004 `BudgetAuthority` consumed directly
 * (the tool-runtime/computer-use precedent), so there is no separate
 * port here. Human approval is the edge approval ledger (the WORK-011
 * approval discipline reused — durable request + attributable decision
 * + full binding re-validation at dispatch), with the gate manifesting
 * on the executions lifecycle through the ledger port's wait-human /
 * resume commands.
 */

import type { EdgePolicyEvidence } from "../domain/edge";

export interface EdgePolicyAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  /** The execution binding (null for device-level management operations). */
  readonly executionId: string | null;
  /** The edge tool fact (device-register | envelope | command | revocation). */
  readonly toolFact: string;
  /** The device's opaque controller reference (an egress-like fact). */
  readonly controllerRef: string;
  /** The actuator channels the governed operation would drive. */
  readonly channels: readonly string[];
}

export type EdgePolicyAdmissionDecision =
  | {
      readonly allowed: true;
      readonly evidence?: EdgePolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface EdgePolicyAdmission {
  admit(request: EdgePolicyAdmissionRequest): Promise<EdgePolicyAdmissionDecision>;
}

export interface EdgeCapabilityGateRequest {
  readonly requirementAtoms: readonly string[];
}

export interface EdgeCapabilityGateDecision {
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
  /** The arbitrated satisfaction evidence (claimId@version + evidence kind). */
  readonly satisfactions: readonly string[];
}

export interface EdgeCapabilityGate {
  resolve(request: EdgeCapabilityGateRequest): Promise<EdgeCapabilityGateDecision>;
}
