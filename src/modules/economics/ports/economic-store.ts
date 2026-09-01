/**
 * Economic store port (economics module outbound; WORK-032).
 *
 * Provider-neutral durable storage for economic actions, bounded payment
 * authorizations, settlement observations, delivery observations and the
 * append-only action event ledger. The SQL implementation (migration
 * 0014) makes the invariants PHYSICAL (write-once identity cores,
 * forward-only transitions, append-only events, unique correlation);
 * the in-memory implementation is the unit-test substrate.
 *
 * Scope discipline: every read/write is application/tenant-scoped from
 * the caller's server-derived context — cross-tenant access returns
 * null (fail closed) rather than another tenant's rows.
 */

import type { PaymentAuthorizationRecord } from "../domain/authorization";
import type { EconomicActionRecord } from "../domain/economic-action";
import type { EconomicActionEvent } from "../domain/events";
import type { DeliveryObservationRecord, SettlementObservationRecord } from "../domain/settlement";

export interface InsertEconomicActionInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly proposedBy: string;
  readonly purpose: string;
  readonly recipientKind: string;
  readonly recipientId: string;
  readonly amountKind: "exact" | "range";
  readonly amountMinMicroUsd: string;
  readonly amountMaxMicroUsd: string;
  readonly currency: string;
  readonly expiresAt: string;
  readonly requiredCapabilities: Readonly<Record<string, unknown>[]>;
  readonly railPreference: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InsertAuthorizationInput {
  readonly id: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly constraints: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly reservationOperationId: string;
  readonly admissionEvidence: Readonly<Record<string, unknown>>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface InsertSettlementInput {
  readonly id: string;
  readonly economicActionId: string;
  readonly authorizationId: string | null;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly railId: string;
  readonly railTransactionRef: string;
  readonly status: string;
  readonly settledAmountMicroUsd: string;
  readonly currency: string;
  readonly observedAt: string;
  readonly evidenceDigest: string;
  readonly recordedAt: string;
}

export interface InsertDeliveryInput {
  readonly id: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly digest: string;
  readonly contentRef: string;
  readonly observedAt: string;
  readonly recordedAt: string;
}

export interface InsertEventInput {
  readonly eventId: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sequence: number;
  readonly type: string;
  readonly cause: string;
  readonly reference: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface EconomicStore {
  insertEconomicAction(input: InsertEconomicActionInput): Promise<EconomicActionRecord>;

  getEconomicAction(applicationId: string, id: string): Promise<EconomicActionRecord | null>;

  /**
   * Forward-only guarded transition of an economic action. The store MUST
   * derive the row's current status under a lock (or equivalent
   * conditional write) and fail closed on any illegal/rewind transition —
   * never from a pre-lock read.
   */
  transitionEconomicAction(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<EconomicActionRecord>;

  insertAuthorization(input: InsertAuthorizationInput): Promise<PaymentAuthorizationRecord>;

  getAuthorizationById(
    applicationId: string,
    id: string,
  ): Promise<PaymentAuthorizationRecord | null>;

  getAuthorizationForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<PaymentAuthorizationRecord | null>;

  /**
   * Guarded authorization transition (active -> consumed/expired/revoked
   * only); same locked re-derive discipline as action transitions.
   */
  transitionAuthorization(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<PaymentAuthorizationRecord>;

  insertSettlement(input: InsertSettlementInput): Promise<SettlementObservationRecord>;

  getSettlementForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<SettlementObservationRecord | null>;

  findSettlementByRef(
    applicationId: string,
    railId: string,
    railTransactionRef: string,
  ): Promise<SettlementObservationRecord | null>;

  insertDelivery(input: InsertDeliveryInput): Promise<DeliveryObservationRecord>;

  listDeliveries(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly DeliveryObservationRecord[]>;

  appendEvent(input: InsertEventInput): Promise<EconomicActionEvent>;

  listEvents(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly EconomicActionEvent[]>;

  /** Read-surface for the delivery-evidence bundle (verification seam). */
  listActionsOfApplication(applicationId: string): Promise<readonly EconomicActionRecord[]>;

  listAuthorizationsOfApplication(
    applicationId: string,
  ): Promise<readonly PaymentAuthorizationRecord[]>;

  listSettlementsOfApplication(
    applicationId: string,
  ): Promise<readonly SettlementObservationRecord[]>;

  listDeliveriesOfApplication(applicationId: string): Promise<readonly DeliveryObservationRecord[]>;
}
