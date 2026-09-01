/**
 * Bounded payment authorization (economics module domain; WORK-032,
 * ECO-002; ADR-0018 "agent payment guardrails").
 *
 * The bounded/tokenized agent-payment authorization: a set of constraints
 * (recipient/seller, maximum amount, currency, purpose/resource, expiry,
 * execution/application/tenant scope, single-use policy) that a payment
 * attempt must satisfy EXACTLY. It is deliberately NOT a raw credential:
 * there is no field where a card number, key or secret could even appear,
 * and it is only ever usable THROUGH the economics module's charge path
 * (which re-evaluates every constraint deterministically).
 *
 * AUTHORIZATION != INTENT (the action proposed it), != TRANSACTION (the
 * rail charge executes it), != SETTLEMENT, != VERIFICATION.
 *
 * Deterministic constraint evaluation (ECO-002): `evaluateAuthorizationUse`
 * is pure, total, deterministic code — no LLM, no policy re-resolution, no
 * I/O. The POLICY authority was already consulted before this record
 * could be minted (service ordering: policy -> capability -> budget ->
 * authorization issuance); this evaluation is the substitution/replay
 * firewall for every USE of the authorization.
 */

import type { EconomicCapabilityRequirement } from "./capabilities";
import type { EconomicAmount } from "./economic-action";
import type { EconomicMicroUsd } from "./money";
import { amountWithinBounds } from "./money";
import type { EconomicCurrency, EconomicPurpose, RecipientReference } from "./vocabulary";
import { sameRecipient } from "./vocabulary";

export const PAYMENT_AUTHORIZATION_STATUSES = ["active", "consumed", "expired", "revoked"] as const;

export type PaymentAuthorizationStatus = (typeof PAYMENT_AUTHORIZATION_STATUSES)[number];

/** v1 reuse policy: bounded authorizations are SINGLE-USE by construction. */
export const PAYMENT_AUTHORIZATION_REUSE_POLICIES = ["single-use"] as const;

export type PaymentAuthorizationReusePolicy = (typeof PAYMENT_AUTHORIZATION_REUSE_POLICIES)[number];

/**
 * The constraint set of a bounded payment authorization (ECO-002). Every
 * field is a hard pin; the rail adapter is additionally required to be
 * able to express the rail-side subset of these (see `rail.ts`).
 */
export interface PaymentAuthorizationConstraints {
  /** The exact pinned recipient/seller (substitution is unrepresentable). */
  readonly recipient: RecipientReference;
  /** Inclusive amount bounds ([min, max]; exact authorizations pin min == max). */
  readonly minAmountMicroUsd: EconomicMicroUsd;
  readonly maxAmountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  /** The pinned purpose/resource this authorization may pay for. */
  readonly purpose: EconomicPurpose;
  /** Hard expiry (ISO-8601 UTC instant): the authorization dies here. */
  readonly expiresAt: string;
  /** Execution/application/tenant scope pins. */
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** v1: single-use only — a charge attempt consumes the authorization. */
  readonly reuse: PaymentAuthorizationReusePolicy;
  /** Capabilities the paid-for resource requires (admission-checked). */
  readonly requiredCapabilities: readonly EconomicCapabilityRequirement[];
}

export interface PaymentAuthorizationRecord {
  readonly id: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly constraints: PaymentAuthorizationConstraints;
  readonly status: PaymentAuthorizationStatus;
  /**
   * The budgets module's reservation operation id (`econ-<actionId>`) —
   * the canonical spending hold this authorization rides. UNIQUE per
   * action: double reservation is unrepresentable (ECO-003).
   */
  readonly reservationOperationId: string;
  /** Durable policy-admission provenance recorded at issuance. */
  readonly admissionEvidence: Readonly<Record<string, unknown>>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

/** The proposed use of an authorization (what the charge wants to do). */
export interface AuthorizationUse {
  readonly economicActionId: string;
  readonly recipient: RecipientReference;
  readonly amountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  readonly purpose: EconomicPurpose;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export type AuthorizationUseDenialCode =
  | "authorization-not-active"
  | "authorization-expired"
  | "authorization-mismatch"
  | "amount-out-of-bounds"
  | "recipient-substitution"
  | "currency-substitution"
  | "purpose-substitution"
  | "execution-substitution"
  | "tenant-substitution";

export type AuthorizationUseEvaluation =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: AuthorizationUseDenialCode; readonly detail: string };

/**
 * DETERMINISTIC use evaluation (the substitution/replay firewall):
 *
 *  - status: only `active` authorizations may be used (replay of consumed
 *    or revoked ones fails closed);
 *  - expiry: `now` after `expiresAt` is EXPIRED (time-based replay dies);
 *  - recipient: exact kind+id equality (seller/recipient substitution);
 *  - amount: inclusive bounds (agent-controlled amount escalation dies);
 *  - currency: exact equality (currency substitution);
 *  - purpose: exact equality (purpose/resource substitution);
 *  - execution/application/tenant: exact equality (scope substitution and
 *    cross-tenant/cross-application replay die with distinct codes).
 *
 * Pure and total: no I/O, no clock reads (the caller injects `now`), no
 * LLM, no policy re-resolution. Every denial is machine-readable.
 */
export function evaluateAuthorizationUse(
  authorization: PaymentAuthorizationRecord,
  use: AuthorizationUse,
  now: Date,
): AuthorizationUseEvaluation {
  if (authorization.status !== "active") {
    return {
      allowed: false,
      code: "authorization-not-active",
      detail: `authorization is ${authorization.status}, not active`,
    };
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    return {
      allowed: false,
      code: "authorization-expired",
      detail: `authorization expired at ${authorization.expiresAt}`,
    };
  }
  if (authorization.economicActionId !== use.economicActionId) {
    return {
      allowed: false,
      code: "authorization-mismatch",
      detail: "authorization belongs to a different economic action",
    };
  }
  if (!sameRecipient(authorization.constraints.recipient, use.recipient)) {
    return {
      allowed: false,
      code: "recipient-substitution",
      detail: `authorization is pinned to recipient ${authorization.constraints.recipient.kind}:${authorization.constraints.recipient.id}`,
    };
  }
  if (authorization.constraints.currency !== use.currency) {
    return {
      allowed: false,
      code: "currency-substitution",
      detail: `authorization is pinned to currency ${authorization.constraints.currency}`,
    };
  }
  if (authorization.constraints.purpose !== use.purpose) {
    return {
      allowed: false,
      code: "purpose-substitution",
      detail: `authorization is pinned to purpose ${authorization.constraints.purpose}`,
    };
  }
  if (
    !amountWithinBounds(
      use.amountMicroUsd,
      authorization.constraints.minAmountMicroUsd,
      authorization.constraints.maxAmountMicroUsd,
    )
  ) {
    return {
      allowed: false,
      code: "amount-out-of-bounds",
      detail: `amount ${use.amountMicroUsd} outside authorization bounds [${authorization.constraints.minAmountMicroUsd}, ${authorization.constraints.maxAmountMicroUsd}]`,
    };
  }
  if (authorization.constraints.executionId !== use.executionId) {
    return {
      allowed: false,
      code: "execution-substitution",
      detail: "authorization is pinned to a different execution",
    };
  }
  if (authorization.constraints.applicationId !== use.applicationId) {
    return {
      allowed: false,
      code: "tenant-substitution",
      detail: "authorization is pinned to a different application",
    };
  }
  if (authorization.constraints.tenantId !== use.tenantId) {
    return {
      allowed: false,
      code: "tenant-substitution",
      detail: "authorization is pinned to a different tenant",
    };
  }
  return { allowed: true };
}

/** Map an economic action (intent) into its bounded authorization constraints. */
export function constraintsOfAction(action: {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly purpose: EconomicPurpose;
  readonly recipient: RecipientReference;
  readonly amount: EconomicAmount;
  readonly currency: EconomicCurrency;
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly EconomicCapabilityRequirement[];
}): PaymentAuthorizationConstraints {
  return {
    recipient: action.recipient,
    minAmountMicroUsd:
      action.amount.kind === "exact" ? action.amount.microUsd : action.amount.minMicroUsd,
    maxAmountMicroUsd:
      action.amount.kind === "exact" ? action.amount.microUsd : action.amount.maxMicroUsd,
    currency: action.currency,
    purpose: action.purpose,
    expiresAt: action.expiresAt,
    executionId: action.executionId,
    applicationId: action.applicationId,
    tenantId: action.tenantId,
    reuse: "single-use",
    requiredCapabilities: action.requiredCapabilities,
  };
}
