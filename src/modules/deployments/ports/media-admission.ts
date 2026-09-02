/**
 * Media generation admission ports (deployments module inbound seams;
 * WORK-026, MOD-013 — the admission chain BEFORE the PAID dispatch).
 *
 * The four REQUIRED seams the media generation service consults
 * BEFORE the paid rail dispatch (the models-gateway / IMPLEMENTATION.md
 * §7 discipline — the same chain the messaging and realtime fabrics
 * use), in the frozen order:
 *
 *   1. TENANT — server-derived scope resolution (identity/tenant
 *      first; the durable rows' tenant decides, never a caller
 *      assertion);
 *   2. POLICY — the effective policy admission (no default-allow
 *      exists; a denial is journaled then typed `POLICY_DENIED` —
 *      zero paid dispatches);
 *   3. CAPABILITY — the capability authority resolution (unmet
 *      requirements fail closed `CAPABILITY_UNAVAILABLE` before the
 *      dispatch — provider selection is downstream of capability and
 *      policy admission, never before);
 *   4. BUDGET — reservation before the PAID dispatch ONLY (media
 *      generation is always paid; a denial/missing budget is typed
 *      `BUDGET_EXCEEDED` BEFORE the paid dispatch — MOD-013's
 *      budget-before-paid-dispatch core);
 *   5. SECRET — mediated access for the rail channel's credentials
 *      (references only; the mediating authority decides availability
 *      — raw secret values NEVER cross into the media fabric).
 *
 * Each seam is its own authority's consultee: the deployments module
 * owns none of these decisions and re-implements none of them (the
 * duplicate-authority prohibition). Adapters consume the REAL module
 * public surfaces (policies/capabilities/budgets/connections) in
 * `adapters/`.
 */

/** The media actions the policy admission evaluates. */
export type MediaPolicyAction = "job-submit" | "job-cancel" | "variant-derive";

/** Durable policy-admission provenance (the WORK-007 evidence shape). */
export interface MediaAdmissionEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

export interface MediaPolicyAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly jobId: string | null;
  readonly deploymentId: string;
  readonly action: MediaPolicyAction;
  /** The neutral generation kind of the job (job-submit only). */
  readonly generationKind: string | null;
  /** The neutral rail capability id that would transport the paid dispatch. */
  readonly railCapabilityId: string;
  /** Secret reference the rail channel would materialize (never a value). */
  readonly secretRef: string | null;
}

export type MediaPolicyAdmissionDecision =
  | {
      readonly allowed: true;
      readonly evidence?: MediaAdmissionEvidence;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly evidence?: MediaAdmissionEvidence;
    };

export interface MediaPolicyAdmission {
  admit(request: MediaPolicyAdmissionRequest): Promise<MediaPolicyAdmissionDecision>;
}

/** Capability-admission request: the neutral capabilities a dispatch requires. */
export interface MediaCapabilityAdmissionRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly jobId: string | null;
  /** The PINNED plan's required capabilities (the deployment profile declaration). */
  readonly requiredCapabilities: readonly string[];
  /** The rail's neutral adapter capability id that would transport the job. */
  readonly railCapabilityId: string;
  /** The neutral generation kind (a media-generation capability atom). */
  readonly generationKind: string;
}

export interface MediaCapabilityAdmissionDecision {
  readonly satisfied: boolean;
  /** Unmet requirement names (machine-readable). */
  readonly unmet: readonly string[];
}

export interface MediaCapabilityAdmission {
  resolve(request: MediaCapabilityAdmissionRequest): Promise<MediaCapabilityAdmissionDecision>;
}

/** Budget reservation command (the paid dispatch only — always). */
export interface MediaBudgetReserveCommand {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The logical billable operation (unique per application — the dispatch discriminator). */
  readonly operationId: string;
  readonly userId?: string;
  readonly amountMicroUsd: string;
  readonly reason: string;
}

export interface MediaBudgetReservation {
  readonly reservationId: string;
  readonly amountMicroUsd: string;
  readonly converged: boolean;
}

export interface MediaBudgetAdmission {
  reserve(command: MediaBudgetReserveCommand): Promise<MediaBudgetReservation>;
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
export interface MediaSecretMediationRequest {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly jobId: string | null;
  /** The neutral connection reference carrying the rail channel credential. */
  readonly connectionRef: string;
}

export type MediaSecretMediationOutcome =
  | {
      readonly mediated: true;
      /** Opaque mediated grant reference (NEVER a raw secret value). */
      readonly grantRef: string;
    }
  | {
      readonly mediated: false;
      readonly reason: string;
    };

export interface MediaSecretMediation {
  mediate(request: MediaSecretMediationRequest): Promise<MediaSecretMediationOutcome>;
}
