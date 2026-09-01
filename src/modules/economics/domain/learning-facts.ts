/**
 * Economic outcome facts — the Learning input projection (economics module
 * domain; WORK-032, ECO-008; ADR-0018 "learning and optimization").
 *
 * Economic outcomes feed Learning as EVIDENCE/RECOMMENDATIONS ONLY:
 * this projection is a pure function over durable economic records
 * producing neutral, closed-shape fact records that a learning consumer
 * (telemetry/composition surfaces) may ingest. Learning NEVER authorizes
 * spending: the economics service's admission chain has NO learning
 * input at all (the pinned service deps prove that mechanically), and
 * learning scores cannot satisfy, mint or extend a payment authorization
 * (the substitution firewall re-evaluates constraints deterministically
 * on every use).
 *
 * The shape deliberately mirrors the learning module's neutral fact style
 * (closed vocabulary, schema-versioned, no callbacks, no authority
 * semantics) — structural compatibility without importing the learning
 * module (the observation-island boundary stays intact).
 */

import type { PaymentAuthorizationRecord } from "./authorization";
import type { EconomicActionRecord } from "./economic-action";
import type { DeliveryObservationRecord, SettlementObservationRecord } from "./settlement";

export const ECONOMIC_OUTCOME_FACT_SCHEMA_VERSION = 1;

export const ECONOMIC_OUTCOME_FACT_OUTCOMES = [
  "settled",
  "failed",
  "denied",
  "expired",
  "proposed",
  "authorized",
  "executing",
] as const;

export type EconomicOutcomeFactOutcome = (typeof ECONOMIC_OUTCOME_FACT_OUTCOMES)[number];

export interface EconomicOutcomeFact {
  readonly schemaVersion: number;
  readonly economicActionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly purpose: string;
  /** The rail that settled (null when no charge happened). */
  readonly railId: string | null;
  readonly currency: string;
  readonly settledAmountMicroUsd: string | null;
  /**
   * Delivery status as EVIDENCE (what delivery observations exist), never
   * a verification verdict: "observed" when delivery evidence exists,
   * "none" otherwise. Verification decides delivered/not-delivered.
   */
  readonly deliveryEvidence: "observed" | "none";
  readonly outcome: EconomicOutcomeFactOutcome;
  readonly denialCause: string | null;
  readonly recordedAt: string;
}

/**
 * Pure projection: durable economic records -> neutral learning facts.
 * No authority semantics, no policy/budget input, no spending effect —
 * data out only.
 */
export function economicOutcomeFacts(
  actions: readonly EconomicActionRecord[],
  settlements: readonly SettlementObservationRecord[],
  authorizations: readonly PaymentAuthorizationRecord[],
  deliveries: readonly DeliveryObservationRecord[],
): readonly EconomicOutcomeFact[] {
  const settlementByAction = new Map<string, SettlementObservationRecord>();
  for (const settlement of settlements) {
    const existing = settlementByAction.get(settlement.economicActionId);
    if (existing === undefined) {
      settlementByAction.set(settlement.economicActionId, settlement);
    }
  }
  const deliveriesByAction = new Map<string, DeliveryObservationRecord[]>();
  for (const delivery of deliveries) {
    const list = deliveriesByAction.get(delivery.economicActionId) ?? [];
    list.push(delivery);
    deliveriesByAction.set(delivery.economicActionId, list);
  }
  const authorizationByAction = new Map<string, PaymentAuthorizationRecord>();
  for (const authorization of authorizations) {
    authorizationByAction.set(authorization.economicActionId, authorization);
  }
  return actions.map((action) => {
    const settlement = settlementByAction.get(action.id) ?? null;
    const actionDeliveries = deliveriesByAction.get(action.id) ?? [];
    return {
      schemaVersion: ECONOMIC_OUTCOME_FACT_SCHEMA_VERSION,
      economicActionId: action.id,
      executionId: action.executionId,
      applicationId: action.applicationId,
      purpose: action.purpose,
      railId: settlement?.railId ?? null,
      currency: action.currency,
      settledAmountMicroUsd: settlement?.settledAmountMicroUsd ?? null,
      deliveryEvidence: actionDeliveries.length > 0 ? ("observed" as const) : ("none" as const),
      outcome: action.status,
      denialCause:
        action.status === "denied" ? String(action.metadata.denialCause ?? "unknown") : null,
      recordedAt: action.updatedAt,
    };
  });
}
