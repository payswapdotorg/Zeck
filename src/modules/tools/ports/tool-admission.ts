/**
 * Tool admission port (tools module outbound; WORK-010, TOL-001).
 *
 * ENFORCES the frozen "policy before dispatch" invariant at the tool
 * boundary (`spec/architecture.md` §2.4, architecture-lock invariant 3,
 * `IMPLEMENTATION.md` §7): no tool adapter receives executable work before
 * the policy admission decision allows it. This is the tools-module twin
 * of the models `DispatchAdmission` seam (WORK-003/007): the port is
 * REQUIRED at runtime construction — there is deliberately NO
 * default-allow implementation in this module, so the invariant holds by
 * construction even before the policies authority is wired in. Production
 * composition roots inject the policy engine through the
 * `createPolicyToolAdmission` adapter; tests inject allow/deny fakes.
 *
 * The request carries the DECLARED dispatch facts of the contract (tool
 * identity, network hosts, secret references — the admission-relevant
 * dimensions the registry resolved) plus the execution binding. The
 * decision is the authority's; this port decides nothing locally.
 */

import type { ToolPolicyEvidence } from "../domain/invocation";

export interface ToolAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /** The tool identity that would be dispatched. */
  readonly toolId: string;
  /** Network hosts the tool contract declares (empty when egress none). */
  readonly hosts: readonly string[];
  /** Secret references the tool contract declares (empty when access none). */
  readonly secretRefs: readonly string[];
}

export type ToolAdmissionDecision =
  | {
      readonly allowed: true;
      /** Durable admission provenance (effective policy identity + digest). */
      readonly evidence?: ToolPolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface ToolAdmission {
  admit(request: ToolAdmissionRequest): Promise<ToolAdmissionDecision>;
}
