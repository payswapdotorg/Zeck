/**
 * Messaging admission ports (deployments module inbound seams; WORK-025,
 * MOD-009 — the admission chain BEFORE governed side effects).
 *
 * The four REQUIRED seams the messaging conversation service consults
 * BEFORE any rail send (the external side effect) and before any paid
 * inference dispatch, in the frozen order (the models-gateway /
 * IMPLEMENTATION.md §7 discipline — the same chain the realtime
 * fabric uses):
 *
 *   1. TENANT — server-derived scope resolution (identity/tenant
 *      first; the durable rows' tenant decides, never a caller
 *      assertion);
 *   2. POLICY — the effective policy admission (no default-allow
 *      exists; a denial is journaled then typed `POLICY_DENIED` — zero
 *      rail sends);
 *   3. CAPABILITY — the capability authority resolution (unmet
 *      requirements fail closed `CAPABILITY_UNAVAILABLE` before any
 *      dispatch);
 *   4. BUDGET — reservation before PAID dispatch only (deterministic
 *      routes need no reservation; a denial/missing budget is typed
 *      `BUDGET_EXCEEDED` before the paid dispatch);
 *   5. SECRET — mediated access for the rail channel's credentials
 *      (references only; the mediating authority decides availability
 *      — raw secret values NEVER cross into the conversation fabric).
 *
 * Each seam is its own authority's consultee: the deployments module
 * owns none of these decisions and re-implements none of them (the
 * duplicate-authority prohibition — MOD-004 discipline extended to the
 * messaging fabric). Adapters consume the REAL module public surfaces
 * (policies/capabilities/budgets/connections) in `adapters/`.
 */

import type { MessagingRouteClass } from "../domain/messaging";

/** The messaging actions the policy admission evaluates. */
export type MessagingPolicyAction = "conversation-start" | "message-send" | "human-escalation";

/** Durable policy-admission provenance (the WORK-007 evidence shape). */
export interface MessagingAdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

export interface MessagingPolicyAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly conversationId: string | null;
  readonly deploymentId: string;
  readonly action: MessagingPolicyAction;
  readonly channelKind: string;
  /** The neutral rail capability id that would transport the side effect. */
  readonly railCapabilityId: string;
  /** The route class of the reply being sent (message-send only). */
  readonly routeClass: MessagingRouteClass | null;
  /** Secret reference the rail channel would materialize (never a value). */
  readonly secretRef: string | null;
}

export type MessagingPolicyAdmissionDecision =
  | {
      readonly allowed: true;
      readonly evidence?: MessagingAdmissionEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly evidence?: MessagingAdmissionEvidence;
    };

export interface MessagingPolicyAdmission {
  admit(request: MessagingPolicyAdmissionRequest): Promise<MessagingPolicyAdmissionDecision>;
}

/** Capability-admission request: the neutral capabilities a dispatch requires. */
export interface MessagingCapabilityAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly conversationId: string | null;
  /** The PINNED plan's required capabilities (the deployment profile declaration). */
  readonly requiredCapabilities: readonly string[];
  /** The rail's neutral adapter capability id that would transport the message. */
  readonly railCapabilityId: string;
}

export interface MessagingCapabilityAdmissionDecision {
  readonly satisfied: boolean;
  /** Unmet requirement names (machine-readable). */
  readonly unmet: readonly string[];
}

export interface MessagingCapabilityAdmission {
  resolve(
    request: MessagingCapabilityAdmissionRequest,
  ): Promise<MessagingCapabilityAdmissionDecision>;
}

/** Budget reservation command (paid dispatch only). */
export interface MessagingBudgetReserveCommand {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The logical billable operation (unique per application). */
  readonly operationId: string;
  readonly userId?: string;
  readonly amountMicroUsd: string;
  readonly reason: string;
}

export interface MessagingBudgetReservation {
  readonly reservationId: string;
  readonly amountMicroUsd: string;
  readonly converged: boolean;
}

export interface MessagingBudgetAdmission {
  reserve(command: MessagingBudgetReserveCommand): Promise<MessagingBudgetReservation>;
  settle(input: {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly operationId: string;
    readonly actualAmountMicroUsd: string;
  }): Promise<{ readonly reservationId: string; readonly settled: boolean }>;
  release(input: {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly operationId: string;
  }): Promise<{ readonly reservationId: string; readonly released: boolean }>;
}

/** Mediated secret access for the rail channel (references only). */
export interface MessagingSecretMediationRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly conversationId: string | null;
  /** The neutral connection reference carrying the rail channel credential. */
  readonly connectionRef: string;
}

export type MessagingSecretMediationOutcome =
  | {
      readonly mediated: true;
      /** Opaque mediated grant reference (NEVER a raw secret value). */
      readonly grantRef: string;
    }
  | {
      readonly mediated: false;
      readonly reason: string;
    };

export interface MessagingSecretMediation {
  mediate(request: MessagingSecretMediationRequest): Promise<MessagingSecretMediationOutcome>;
}
