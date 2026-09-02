/**
 * Computer-use admission ports (tools module outbound; WORK-027,
 * CUI-002/AC-4).
 *
 * The REQUIRED authority seams of the computer-use service — the same
 * authorities every other governed tool consults, never reimplemented
 * here, never bypassed:
 *
 *   - `ComputerUsePolicyAdmission` — the WORK-007 policy engine decides
 *     the tool/provider/host/secretRef facts BEFORE any environment
 *     interaction (a denial is journaled and thrown typed; ZERO
 *     environment activity is possible on a denial — the
 *     policy-before-side-effect ordering proof);
 *   - `ComputerUseCapabilityGate` — the WORK-005 capability registry
 *     arbitrates the capability atoms the admitted modes require;
 *   - `ComputerUseSecretMediation` — the WORK-003 connections catalog
 *     mediates credential access REFERENCE-ONLY (raw secret values
 *     never cross into the tools module).
 *
 * Budget admission is the WORK-004 `BudgetAuthority` consumed directly
 * (the tool-runtime precedent), so there is no separate port here.
 */

import type { ComputerUsePolicyEvidence } from "../domain/computer-use";

export interface ComputerUsePolicyAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  /** The computer-use tool fact (session | action | escalation | termination). */
  readonly toolFact: string;
  /** The environment/provider capability id the work would dispatch through. */
  readonly providerCapabilityId: string;
  /** Network hosts the admitted stage would egress to. */
  readonly hosts: readonly string[];
  /** Secret reference the admitted stage would materialize (null = none). */
  readonly secretRef: string | null;
}

export type ComputerUsePolicyAdmissionDecision =
  | {
      readonly allowed: true;
      readonly evidence?: ComputerUsePolicyEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface ComputerUsePolicyAdmission {
  admit(request: ComputerUsePolicyAdmissionRequest): Promise<ComputerUsePolicyAdmissionDecision>;
}

export interface ComputerUseCapabilityGateRequest {
  readonly requirementAtoms: readonly string[];
}

export interface ComputerUseCapabilityGateDecision {
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
  /** The arbitrated satisfaction evidence (claimId@version + evidence kind). */
  readonly satisfactions: readonly string[];
}

export interface ComputerUseCapabilityGate {
  resolve(request: ComputerUseCapabilityGateRequest): Promise<ComputerUseCapabilityGateDecision>;
}

export interface ComputerUseSecretMediationRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly connectionRef: string;
}

export type ComputerUseSecretMediationOutcome =
  | {
      readonly mediated: true;
      /** OPAQUE grant reference — raw secret values never cross this seam. */
      readonly grantRef: string;
    }
  | {
      readonly mediated: false;
      readonly reason: string;
    };

export interface ComputerUseSecretMediation {
  mediate(request: ComputerUseSecretMediationRequest): Promise<ComputerUseSecretMediationOutcome>;
}
