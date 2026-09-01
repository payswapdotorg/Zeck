/**
 * In-memory fakes of the economics module ports (unit-test substrate;
 * WORK-032).
 *
 * Faithful to the durable contract the SQL adapter implements (migration
 * 0014): write-once identity cores, forward-only status transitions,
 * terminal immutability, unique authorization-per-action and
 * reservation-operation correlation, settlement convergence on the
 * (application, rail, rail-transaction-ref) identity, gapless per-action
 * event sequences and append-only event/delivery/settlement rows.
 *
 * Concurrency/locking cannot be simulated here (no interleaving exists in
 * a single-threaded store) — the real-PostgreSQL suites own those proofs.
 */

import { PlatformError } from "../../../shared/errors";
import type { PaymentAuthorizationRecord } from "../domain/authorization";
import type { EconomicCapabilityRequirement } from "../domain/capabilities";
import type { EconomicActionRecord, EconomicActionStatus } from "../domain/economic-action";
import { economicActionCanTransition } from "../domain/economic-action";
import type { EconomicActionEvent } from "../domain/events";
import type { DeliveryObservationRecord, SettlementObservationRecord } from "../domain/settlement";
import type { RecipientKind, RecipientReference } from "../domain/vocabulary";
import type {
  EconomicStore,
  InsertAuthorizationInput,
  InsertDeliveryInput,
  InsertEconomicActionInput,
  InsertEventInput,
  InsertSettlementInput,
} from "../ports/economic-store";

function toActionRecord(input: InsertEconomicActionInput): EconomicActionRecord {
  return {
    id: input.id,
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    executionId: input.executionId,
    proposedBy: input.proposedBy,
    purpose: input.purpose as EconomicActionRecord["purpose"],
    recipient: {
      kind: input.recipientKind as RecipientKind,
      id: input.recipientId,
    } as RecipientReference,
    amount:
      input.amountKind === "exact"
        ? {
            kind: "exact",
            microUsd: input.amountMinMicroUsd,
          }
        : {
            kind: "range",
            minMicroUsd: input.amountMinMicroUsd,
            maxMicroUsd: input.amountMaxMicroUsd,
          },
    currency: input.currency as EconomicActionRecord["currency"],
    expiresAt: input.expiresAt,
    requiredCapabilities:
      input.requiredCapabilities as unknown as readonly EconomicCapabilityRequirement[],
    railPreference: input.railPreference,
    metadata: input.metadata,
    status: input.status as EconomicActionStatus,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function toAuthorizationRecord(input: InsertAuthorizationInput): PaymentAuthorizationRecord {
  return {
    id: input.id,
    economicActionId: input.economicActionId,
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    constraints: input.constraints as unknown as PaymentAuthorizationRecord["constraints"],
    status: input.status as PaymentAuthorizationRecord["status"],
    reservationOperationId: input.reservationOperationId,
    admissionEvidence: input.admissionEvidence,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    consumedAt: null,
    createdAt: input.createdAt,
  };
}

export class InMemoryEconomicStore implements EconomicStore {
  private readonly actions = new Map<string, EconomicActionRecord>();
  private readonly authorizations = new Map<string, PaymentAuthorizationRecord>();
  private readonly settlements = new Map<string, SettlementObservationRecord>();
  private readonly deliveries = new Map<string, DeliveryObservationRecord>();
  private readonly events: EconomicActionEvent[] = [];

  async insertEconomicAction(input: InsertEconomicActionInput): Promise<EconomicActionRecord> {
    if (this.actions.has(input.id)) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "economic action identity already exists",
        details: { id: input.id },
      });
    }
    const record = toActionRecord(input);
    this.actions.set(record.id, record);
    return record;
  }

  async getEconomicAction(applicationId: string, id: string): Promise<EconomicActionRecord | null> {
    const record = this.actions.get(id);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }

  async transitionEconomicAction(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<EconomicActionRecord> {
    const current = await this.getEconomicAction(applicationId, id);
    if (current === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "economic action not found in this application",
        details: { id },
      });
    }
    if (!from.includes(current.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action is ${current.status}; expected one of ${from.join(", ")}`,
        details: { id, status: current.status },
      });
    }
    if (!economicActionCanTransition(current.status, to as EconomicActionStatus)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action transition ${current.status} -> ${to} is not in the frozen lifecycle`,
        details: { id, from: current.status, to },
      });
    }
    const next: EconomicActionRecord = {
      ...current,
      status: to as EconomicActionStatus,
      updatedAt:
        typeof patch.updatedAt === "string"
          ? patch.updatedAt
          : (patch.metadata as Record<string, unknown> | undefined) !== undefined
            ? current.updatedAt
            : current.updatedAt,
      ...(patch.metadata !== undefined
        ? {
            metadata: {
              ...current.metadata,
              ...(patch.metadata as Readonly<Record<string, unknown>>),
            },
          }
        : {}),
    };
    this.actions.set(id, next);
    return next;
  }

  async insertAuthorization(input: InsertAuthorizationInput): Promise<PaymentAuthorizationRecord> {
    for (const existing of this.authorizations.values()) {
      if (existing.economicActionId === input.economicActionId) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "an authorization already exists for this economic action (one per action)",
          details: { economicActionId: input.economicActionId },
        });
      }
      if (existing.reservationOperationId === input.reservationOperationId) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "reservation operation already carries an authorization",
          details: { reservationOperationId: input.reservationOperationId },
        });
      }
    }
    const record = toAuthorizationRecord(input);
    this.authorizations.set(record.id, record);
    return record;
  }

  async getAuthorizationById(
    applicationId: string,
    id: string,
  ): Promise<PaymentAuthorizationRecord | null> {
    const record = this.authorizations.get(id);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }

  async getAuthorizationForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<PaymentAuthorizationRecord | null> {
    for (const record of this.authorizations.values()) {
      if (record.applicationId === applicationId && record.economicActionId === economicActionId) {
        return record;
      }
    }
    return null;
  }

  async transitionAuthorization(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<PaymentAuthorizationRecord> {
    const current = await this.getAuthorizationById(applicationId, id);
    if (current === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "authorization not found in this application",
        details: { id },
      });
    }
    if (!from.includes(current.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `authorization is ${current.status}; expected one of ${from.join(", ")}`,
        details: { id, status: current.status },
      });
    }
    const next: PaymentAuthorizationRecord = {
      ...current,
      status: to as PaymentAuthorizationRecord["status"],
      ...(to === "consumed" && typeof patch.consumedAt === "string"
        ? { consumedAt: patch.consumedAt }
        : {}),
    };
    this.authorizations.set(id, next);
    return next;
  }

  async insertSettlement(input: InsertSettlementInput): Promise<SettlementObservationRecord> {
    // Converge on the external identity (application, rail, ref): a
    // duplicate settlement from retries returns the durable row.
    for (const existing of this.settlements.values()) {
      if (
        existing.applicationId === input.applicationId &&
        existing.railId === input.railId &&
        existing.railTransactionRef === input.railTransactionRef
      ) {
        return existing;
      }
    }
    const record: SettlementObservationRecord = {
      id: input.id,
      economicActionId: input.economicActionId,
      authorizationId: input.authorizationId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      railId: input.railId,
      railTransactionRef: input.railTransactionRef,
      status: input.status as SettlementObservationRecord["status"],
      settledAmountMicroUsd: input.settledAmountMicroUsd,
      currency: input.currency as SettlementObservationRecord["currency"],
      observedAt: input.observedAt,
      evidenceDigest: input.evidenceDigest,
      recordedAt: input.recordedAt,
    };
    this.settlements.set(record.id, record);
    return record;
  }

  async getSettlementForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<SettlementObservationRecord | null> {
    const rows = [...this.settlements.values()].filter(
      (row) => row.applicationId === applicationId && row.economicActionId === economicActionId,
    );
    // The charge-path row (authorization-bound) is the primary record;
    // otherwise the latest external observation.
    const chargeRow = rows.find((row) => row.authorizationId !== null);
    if (chargeRow !== undefined) {
      return chargeRow;
    }
    return (
      rows
        .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0))
        .at(-1) ?? null
    );
  }

  async findSettlementByRef(
    applicationId: string,
    railId: string,
    railTransactionRef: string,
  ): Promise<SettlementObservationRecord | null> {
    for (const row of this.settlements.values()) {
      if (
        row.applicationId === applicationId &&
        row.railId === railId &&
        row.railTransactionRef === railTransactionRef
      ) {
        return row;
      }
    }
    return null;
  }

  async insertDelivery(input: InsertDeliveryInput): Promise<DeliveryObservationRecord> {
    const record: DeliveryObservationRecord = {
      id: input.id,
      economicActionId: input.economicActionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      kind: input.kind as DeliveryObservationRecord["kind"],
      digest: input.digest,
      contentRef: input.contentRef,
      observedAt: input.observedAt,
      recordedAt: input.recordedAt,
    };
    this.deliveries.set(record.id, record);
    return record;
  }

  async listDeliveries(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly DeliveryObservationRecord[]> {
    return [...this.deliveries.values()].filter(
      (row) => row.applicationId === applicationId && row.economicActionId === economicActionId,
    );
  }

  async appendEvent(input: InsertEventInput): Promise<EconomicActionEvent> {
    const existing = this.events.filter(
      (event) => event.economicActionId === input.economicActionId,
    );
    const expected = existing.length + 1;
    if (input.sequence !== expected) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action events are gapless per action (expected sequence ${expected}, got ${input.sequence})`,
        details: { economicActionId: input.economicActionId },
      });
    }
    const event: EconomicActionEvent = {
      eventId: input.eventId,
      economicActionId: input.economicActionId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      sequence: input.sequence,
      type: input.type as EconomicActionEvent["type"],
      cause: input.cause,
      reference: input.reference,
      payload: input.payload,
      occurredAt: input.occurredAt,
    };
    this.events.push(event);
    return event;
  }

  async listEvents(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly EconomicActionEvent[]> {
    return this.events.filter(
      (event) =>
        event.applicationId === applicationId && event.economicActionId === economicActionId,
    );
  }

  async listActionsOfApplication(applicationId: string): Promise<readonly EconomicActionRecord[]> {
    return [...this.actions.values()].filter((row) => row.applicationId === applicationId);
  }

  async listAuthorizationsOfApplication(
    applicationId: string,
  ): Promise<readonly PaymentAuthorizationRecord[]> {
    return [...this.authorizations.values()].filter((row) => row.applicationId === applicationId);
  }

  async listSettlementsOfApplication(
    applicationId: string,
  ): Promise<readonly SettlementObservationRecord[]> {
    return [...this.settlements.values()].filter((row) => row.applicationId === applicationId);
  }

  async listDeliveriesOfApplication(
    applicationId: string,
  ): Promise<readonly DeliveryObservationRecord[]> {
    return [...this.deliveries.values()].filter((row) => row.applicationId === applicationId);
  }
}
