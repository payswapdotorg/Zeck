/**
 * Agent admission port (agents module outbound; WORK-011, AGT-005/
 * ACP-003 + the policy-before-dispatch invariant).
 *
 * The agents-module twin of the tools `ToolAdmission` seam (WORK-010):
 * NO agent session is created and NO runtime receives work before the
 * policy authority has decided. The port is REQUIRED at service
 * construction — there is deliberately NO default-allow implementation
 * in this module (discrimination M10: "policy admission removed" is
 * unrepresentable, not merely discouraged). Production composition roots
 * inject the policy engine through the `createPolicyAgentAdmission`
 * adapter; tests inject allow/deny fakes.
 *
 * The authority decides EVERYTHING the runtime will see:
 *   - the effective permission set (the requested ∩ approved
 *     intersection — an agent cannot self-grant, discrimination M9);
 *   - the effective autonomy mode (which designates whether the human
 *     approval gate engages, AGT-006/ACP-004);
 *   - durable admission provenance (the WORK-007 evidence shape) that
 *     the session record and the execution ledger both carry.
 *
 * This port decides nothing locally; it is an input, never an authority.
 */

import type { AutonomyMode } from "../../policies/public";
import type { RequestedPermissions } from "../domain/agent-version";
import type { EffectivePermissions, SessionPolicyEvidence } from "../domain/permissions";

export interface AgentAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  /** The agent definition's REQUESTED permissions (input, never authority). */
  readonly requestedPermissions: Readonly<RequestedPermissions>;
  /** The agent definition's autonomy ceiling (policy may tighten it). */
  readonly requestedAutonomy: AutonomyMode;
}

export type AgentAdmissionDecision =
  | {
      readonly allowed: true;
      /** The policy-approved intersection (the runtime-visible set ONLY). */
      readonly effectivePermissions: Readonly<EffectivePermissions>;
      /** The effective autonomy mode granted to this session. */
      readonly autonomy: AutonomyMode;
      /** Durable admission provenance (policy set identity + digest). */
      readonly evidence: SessionPolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface AgentAdmission {
  admit(request: AgentAdmissionRequest): Promise<AgentAdmissionDecision>;
}
