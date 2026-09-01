/**
 * Settlement correlation and resource-delivery evidence (economics module
 * domain; WORK-032, ECO-006; ADR-0018 "verification of economic
 * outcomes").
 *
 * SETTLEMENT IS NOT DELIVERY and NEITHER IS VERIFICATION:
 *
 * ```text
 * payment success != resource delivered != execution success
 * ```
 *
 * A `SettlementObservationRecord` is the CORRELATED EXTERNAL EVIDENCE of
 * a rail transaction against its originating economic action. It is
 * deliberately NOT a Zeck truth source (ECO-003/ECO-006): money movement
 * truth lives in the budgets module's canonical ledger; delivery truth is
 * decided by the verification module over `DeliveryObservationRecord`
 * evidence. External settlement records recorded out-of-band (webhook,
 * reconciliation) are correlated evidence ONLY — they can never settle a
 * budget reservation, consume an authorization or complete an execution.
 */

import type { EconomicMicroUsd } from "./money";
import type { EconomicCurrency } from "./vocabulary";

export const SETTLEMENT_OBSERVATION_STATUSES = ["observed", "confirmed", "failed"] as const;

export type SettlementObservationStatus = (typeof SETTLEMENT_OBSERVATION_STATUSES)[number];

export interface SettlementObservationRecord {
  readonly id: string;
  readonly economicActionId: string;
  readonly authorizationId: string | null;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Neutral rail identity of the observing rail. */
  readonly railId: string;
  /** The rail's own transaction reference (opaque, external). */
  readonly railTransactionRef: string;
  readonly status: SettlementObservationStatus;
  readonly settledAmountMicroUsd: EconomicMicroUsd;
  readonly currency: EconomicCurrency;
  readonly observedAt: string;
  /** Digest of the neutral protocol evidence (raw payloads never stored). */
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export const DELIVERY_OBSERVATION_KINDS = [
  "resource-receipt",
  "http-delivery",
  "service-result",
] as const;

export type DeliveryObservationKind = (typeof DELIVERY_OBSERVATION_KINDS)[number];

export function isDeliveryObservationKind(value: string): value is DeliveryObservationKind {
  return (DELIVERY_OBSERVATION_KINDS as readonly string[]).includes(value);
}

/**
 * Evidence that the paid-for resource/service was (or was not) delivered.
 * This is EVIDENCE ONLY: the verification module independently decides
 * whether delivery happened against declared criteria (a settlement alone
 * produces NO delivery evidence and can never produce a PASS verdict).
 */
export interface DeliveryObservationRecord {
  readonly id: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly kind: DeliveryObservationKind;
  /** Content digest of the delivered artifact/observation (deterministic). */
  readonly digest: string;
  /** Opaque reference to the delivered content (resource URL, ref…). */
  readonly contentRef: string;
  readonly observedAt: string;
  readonly recordedAt: string;
}

/**
 * The delivery-evidence bundle the verification module's economic-delivery
 * target resolver consumes: action identity + authorization state + the
 * correlated settlement + the delivery observations. Settlement and
 * delivery are reported SEPARATELY — conflating them is the exact failure
 * the verification discrimination suite red-records.
 */
export interface EconomicDeliveryEvidence {
  readonly economicActionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly settlement: SettlementObservationRecord | null;
  readonly deliveries: readonly DeliveryObservationRecord[];
}
