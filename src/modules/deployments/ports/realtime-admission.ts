/**
 * Realtime admission ports (deployments module inbound seams; WORK-024,
 * MOD-006 criterion 5 — the admission chain BEFORE governed side
 * effects).
 *
 * The four REQUIRED seams the realtime session service consults BEFORE
 * any rail delivery (the external side effect) and before any paid
 * inference dispatch, in the frozen order (the models-gateway /
 * IMPLEMENTATION.md §7 discipline):
 *
 *   1. TENANT — server-derived scope resolution (identity/tenant first;
 *      the durable rows' tenant decides, never a caller assertion);
 *   2. POLICY — the effective policy admission (no default-allow
 *      exists; a denial is journaled then typed `POLICY_DENIED` — zero
 *      rail deliveries);
 *   3. CAPABILITY — the capability authority resolution (unmet
 *      requirements fail closed `CAPABILITY_UNAVAILABLE` before any
 *      dispatch);
 *   4. BUDGET — reservation before PAID dispatch only (deterministic
 *      routes need no reservation — MOD-007; a denial/missing budget is
 *      typed `BUDGET_EXCEEDED` before the paid dispatch);
 *   5. SECRET — mediated access for the rail channel's credentials
 *      (references only; the mediating authority decides availability —
 *      raw secret values NEVER cross into the session fabric).
 *
 * Each seam is its own authority's consultee: the deployments module
 * owns none of these decisions and re-implements none of them (the
 * duplicate-authority prohibition — MOD-004 discipline extended to the
 * realtime fabric). Adapters consume the REAL module public surfaces
 * (policies/capabilities/budgets/connections) in `adapters/`.
 */

import type { RealtimeRouteClass } from "../domain/realtime";

/** The realtime actions the policy admission evaluates. */
export type RealtimePolicyAction = "session-start" | "turn-dispatch" | "human-transfer";

/** Durable policy-admission provenance (the WORK-007 evidence shape). */
export interface RealtimeAdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

export interface RealtimePolicyAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string | null;
  readonly deploymentId: string;
  readonly action: RealtimePolicyAction;
  readonly channelKind: string;
  /** The neutral rail capability id that would transport the side effect. */
  readonly railCapabilityId: string;
  /** The route class of the turn being dispatched (turn actions only). */
  readonly routeClass: RealtimeRouteClass | null;
  /** Secret reference the rail channel would materialize (never a value). */
  readonly secretRef: string | null;
}

export type RealtimePolicyAdmissionDecision =
  | {
      readonly allowed: true;
      readonly evidence?: RealtimeAdmissionEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly evidence?: RealtimeAdmissionEvidence;
    };

export interface RealtimePolicyAdmission {
  admit(request: RealtimePolicyAdmissionRequest): Promise<RealtimePolicyAdmissionDecision>;
}

/** Capability-admission request: the neutral capabilities a dispatch requires. */
export interface RealtimeCapabilityAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string | null;
  /** The PINNED plan's required capabilities (the deployment profile declaration). */
  readonly requiredCapabilities: readonly string[];
  /** The rail's neutral adapter capability id that would transport the turn. */
  readonly railCapabilityId: string;
}

export interface RealtimeCapabilityAdmissionDecision {
  readonly satisfied: boolean;
  /** Unmet requirement names (machine-readable). */
  readonly unmet: readonly string[];
}

export interface RealtimeCapabilityAdmission {
  resolve(
    request: RealtimeCapabilityAdmissionRequest,
  ): Promise<RealtimeCapabilityAdmissionDecision>;
}

/** Budget reservation command (paid dispatch only — MOD-007). */
export interface RealtimeBudgetReserveCommand {
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

export interface RealtimeBudgetReservation {
  readonly reservationId: string;
  readonly amountMicroUsd: string;
  readonly converged: boolean;
}

export interface RealtimeBudgetAdmission {
  reserve(command: RealtimeBudgetReserveCommand): Promise<RealtimeBudgetReservation>;
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
export interface RealtimeSecretMediationRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId: string | null;
  /** The neutral connection reference carrying the rail channel credential. */
  readonly connectionRef: string;
}

export type RealtimeSecretMediationOutcome =
  | {
      readonly mediated: true;
      /** Opaque mediated grant reference (NEVER a raw secret value). */
      readonly grantRef: string;
    }
  | {
      readonly mediated: false;
      readonly reason: string;
    };

export interface RealtimeSecretMediation {
  mediate(request: RealtimeSecretMediationRequest): Promise<RealtimeSecretMediationOutcome>;
}
