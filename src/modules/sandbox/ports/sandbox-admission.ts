/**
 * Sandbox admission port (sandbox module outbound; WORK-012, ENV-001/002).
 *
 * ENFORCES the frozen "policy before dispatch" invariant at the sandbox
 * boundary (`spec/architecture.md` §2.4, architecture-lock invariant 3,
 * `IMPLEMENTATION.md` §7): no sandbox is admitted — and therefore nothing
 * can execute in any environment — before the policy admission decision
 * allows it. This is the sandbox-module twin of the tools `ToolAdmission`
 * and agents `AgentAdmission` seams (the WORK-010/011 discipline): the
 * port is REQUIRED at service construction — there is deliberately NO
 * default-allow implementation in this module. Production composition
 * roots inject the policy engine through the `createPolicySandboxAdmission`
 * adapter; tests inject allow/deny fakes.
 *
 * The request carries the DECLARED admission facts of the environment
 * specification (kind, network hosts, secret references — the
 * admission-relevant dimensions the catalog resolved) plus the execution
 * binding. The decision is the authority's; this port decides nothing
 * locally, and there is no sandbox-specific policy engine anywhere in
 * this module (discrimination M2/M23-class).
 */

import type { SandboxEnvironmentKind } from "../domain/environment";
import type { SandboxPolicyEvidence } from "../domain/sandbox";

export interface SandboxAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /** The environment kind that would be admitted. */
  readonly kind: SandboxEnvironmentKind;
  /** Network hosts the environment declares (empty when egress none). */
  readonly hosts: readonly string[];
  /** Secret references the environment declares (empty when access none). */
  readonly secretRefs: readonly string[];
}

export type SandboxAdmissionDecision =
  | {
      readonly allowed: true;
      /** Durable admission provenance (effective policy identity + digest). */
      readonly evidence?: SandboxPolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface SandboxAdmission {
  admit(request: SandboxAdmissionRequest): Promise<SandboxAdmissionDecision>;
}
