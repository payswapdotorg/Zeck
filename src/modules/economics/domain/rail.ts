/**
 * The provider-neutral payment-rail contract (economics module domain;
 * WORK-032, ECO-004; ADR-0018 "payment-rail abstraction").
 *
 * Payment rails are REPLACEABLE ADAPTERS, not Zeck authorities (ECO-004):
 * this port is the entire rail surface the economics module knows about.
 * Rail implementations live OUTSIDE this module (the repository's
 * integration adapter convention — `src/integrations/payment-rails/`);
 * they are injected per call, so rail/provider replacement is a
 * composition change that provably changes no authority decision.
 *
 * FAIL CLOSED (the work order's implementation requirement): a rail that
 * cannot express the required safety constraints (recipient pinning,
 * amount ceiling, currency pinning, expiry) is REFUSED before any charge
 * — `railCanExpressConstraints` is the deterministic gate.
 *
 * CREDENTIAL SAFETY: `RailPaymentRequest` has NO credential field — no
 * card number, key, token or secret can even be represented on the
 * request. Rail credentials live inside the owning adapter's private
 * configuration (server-side composition), never on the contract, never
 * across the agent/public API/SDK/CLI boundary (mechanically scanned).
 */

import type { EconomicMicroUsd } from "./money";
import type { EconomicCurrency, EconomicPurpose, RecipientReference } from "./vocabulary";

/**
 * What a rail must be able to express for Zeck to use it (the REQUIRED
 * safety-constraint subset from ADR-0018's guardrail list — the four
 * constraints the platform cannot enforce on the far side of the rail).
 */
export interface RailConstraintCapabilities {
  /** The rail can pin the charge to the exact recipient/seller. */
  readonly pinsRecipient: boolean;
  /** The rail can enforce a hard maximum amount for the charge. */
  readonly enforcesAmountCeiling: boolean;
  /** The rail can pin the charge currency. */
  readonly pinsCurrency: boolean;
  /** The rail can enforce an expiry on the delegated authorization. */
  readonly enforcesExpiry: boolean;
}

export const REQUIRED_RAIL_CAPABILITY_KEYS: readonly (keyof RailConstraintCapabilities)[] = [
  "pinsRecipient",
  "enforcesAmountCeiling",
  "pinsCurrency",
  "enforcesExpiry",
];

/**
 * Deterministic fail-closed gate: the rail must express EVERY required
 * safety constraint. A rail that cannot is refused BEFORE any charge
 * (CAPABILITY_UNAVAILABLE — never silently degraded).
 */
export function railCanExpressConstraints(capabilities: RailConstraintCapabilities): boolean {
  return REQUIRED_RAIL_CAPABILITY_KEYS.every((key) => capabilities[key] === true);
}

/** The neutral charge request (all fields are hard pins — no credentials). */
export interface RailPaymentRequest {
  readonly economicActionId: string;
  readonly authorizationId: string;
  readonly recipient: RecipientReference;
  readonly amountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  readonly purpose: EconomicPurpose;
  /** The authorization expiry the rail must honor. */
  readonly expiresAt: string;
  /** Rail-side idempotency (retries converge on the rail's own record). */
  readonly idempotencyKey: string;
  /** Zeck-side correlation reference (echoed on observations). */
  readonly correlationRef: string;
}

export const RAIL_SETTLEMENT_STATUSES = ["succeeded", "failed", "pending"] as const;

export type RailSettlementStatus = (typeof RAIL_SETTLEMENT_STATUSES)[number];

/**
 * A rail's settlement OBSERVATION — correlated external evidence, never a
 * Zeck truth source (ECO-006): the economics module records it against the
 * originating economic action, but budget accounting flows ONLY through
 * the budgets authority and delivery is decided ONLY by verification.
 */
export interface RailSettlementObservation {
  readonly railId: string;
  readonly railTransactionRef: string;
  readonly status: RailSettlementStatus;
  readonly settledAmountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  readonly observedAt: string;
  /** Neutral protocol evidence (never credentials; digest-safe shapes). */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * The payment-rail adapter port (ECO-004). Implementations are
 * replaceable adapters outside this module; they receive the bounded
 * request and return an observation. They hold NO Zeck authority: they
 * cannot decide policy, budgets, capabilities, execution state or
 * verification (the architecture gates pin that no authority import
 * exists in the integration tree).
 */
export interface PaymentRail {
  /** Neutral rail identity (opaque string; never a provider SDK type). */
  readonly railId: string;
  readonly capabilities: RailConstraintCapabilities;
  charge(request: RailPaymentRequest): Promise<RailSettlementObservation>;
}
