/**
 * Economic action service contracts (economics module application;
 * WORK-032). Command/outcome shapes of the governed economic-action
 * boundary — split from the implementation so the API layer and tests
 * consume the shapes without the service wiring.
 */

import type { BudgetAuthority } from "../../budgets/public";
import type { ExecutionService } from "../../executions/public";
import type { PaymentAuthorizationRecord } from "../domain/authorization";
import type { EconomicActionRecord } from "../domain/economic-action";
import type { PaymentRail } from "../domain/rail";
import type { DeliveryObservationRecord, SettlementObservationRecord } from "../domain/settlement";

/**
 * The executions seam (structural pick — the smallest execution surface
 * economics needs): the canonical ledger's step-event write path, whose
 * own scope enforcement binds every economic action to its execution,
 * application and tenant identity.
 */
export type EconomicExecutionLedger = Pick<ExecutionService, "recordStepEvent">;

export interface EconomicCommandScope {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface CreateEconomicActionCommand extends EconomicCommandScope {
  readonly executionId: string;
  readonly purpose: string;
  readonly recipient: { readonly kind: string; readonly id: string };
  readonly amount:
    | { readonly kind: "exact"; readonly microUsd: string }
    | { readonly kind: "range"; readonly minMicroUsd: string; readonly maxMicroUsd: string };
  readonly currency: string;
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly {
    readonly kind: string;
    readonly name: string;
    readonly minVersion?: string;
  }[];
  readonly railPreference?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateEconomicActionOutcome {
  readonly action: EconomicActionRecord;
  readonly replayed: boolean;
}

export interface AuthorizeEconomicActionCommand extends EconomicCommandScope {
  readonly economicActionId: string;
}

export interface AuthorizeEconomicActionOutcome {
  readonly action: EconomicActionRecord;
  readonly authorization: PaymentAuthorizationRecord | null;
  /** Durable denial outcome (journal-then-fail; replayed on retry). */
  readonly denied?: { readonly cause: "policy" | "capability" | "budget"; readonly reason: string };
  readonly replayed: boolean;
}

export interface ChargeEconomicActionCommand extends EconomicCommandScope {
  readonly economicActionId: string;
  /**
   * The concrete charge amount (required for range-bounded actions; the
   * pinned amount for exact actions when omitted). Always substitution-
   * checked against the authorization bounds.
   */
  readonly amountMicroUsd?: string;
}

export interface ChargeEconomicActionOutcome {
  readonly action: EconomicActionRecord;
  readonly authorization: PaymentAuthorizationRecord;
  readonly settlement: SettlementObservationRecord;
  readonly replayed: boolean;
}

export interface RecordExternalSettlementCommand extends EconomicCommandScope {
  readonly economicActionId: string;
  readonly railId: string;
  readonly railTransactionRef: string;
  readonly status: "observed" | "confirmed" | "failed";
  readonly settledAmountMicroUsd: string;
  readonly currency: string;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

export interface RecordExternalSettlementOutcome {
  readonly settlement: SettlementObservationRecord;
  readonly replayed: boolean;
}

export interface RecordDeliveryObservationCommand extends EconomicCommandScope {
  readonly economicActionId: string;
  readonly kind: "resource-receipt" | "http-delivery" | "service-result";
  readonly digest: string;
  readonly contentRef: string;
  readonly observedAt: string;
}

export interface RecordDeliveryOutcome {
  readonly delivery: DeliveryObservationRecord;
  readonly replayed: boolean;
}

export interface EconomicDeliveryEvidenceBundle {
  readonly economicActionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly settlement: SettlementObservationRecord | null;
  readonly deliveries: readonly DeliveryObservationRecord[];
}

export interface EconomicActionService {
  createEconomicAction(
    command: CreateEconomicActionCommand,
    idempotencyKey: string,
  ): Promise<CreateEconomicActionOutcome>;
  authorizeEconomicAction(
    command: AuthorizeEconomicActionCommand,
    idempotencyKey: string,
  ): Promise<AuthorizeEconomicActionOutcome>;
  chargeEconomicAction(
    command: ChargeEconomicActionCommand,
    rail: PaymentRail,
    idempotencyKey: string,
  ): Promise<ChargeEconomicActionOutcome>;
  recordExternalSettlement(
    command: RecordExternalSettlementCommand,
    idempotencyKey: string,
  ): Promise<RecordExternalSettlementOutcome>;
  recordDeliveryObservation(
    command: RecordDeliveryObservationCommand,
    idempotencyKey: string,
  ): Promise<RecordDeliveryOutcome>;
  getEconomicAction(applicationId: string, id: string): Promise<EconomicActionRecord | null>;
  listEconomicActionEvents(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly import("../domain/events").EconomicActionEvent[]>;
  /** The delivery-evidence bundle the verification authority consumes. */
  deliveryEvidence(
    applicationId: string,
    economicActionId: string,
  ): Promise<EconomicDeliveryEvidenceBundle | null>;
  /** The pure learning-input projection (ECO-008; evidence only). */
  economicOutcomeFacts(
    applicationId: string,
  ): Promise<readonly import("../domain/learning-facts").EconomicOutcomeFact[]>;
}

/** Pinned, exact service dependency surface (architecture-gated). */
export interface EconomicActionServiceDeps {
  readonly store: import("../ports/economic-store").EconomicStore;
  readonly idempotency: import("../ports/economic-idempotency").EconomicsIdempotencyPort;
  /** REQUIRED: the policy authority seam (no default-allow exists). */
  readonly policy: import("../ports/policy-admission").EconomicPolicyAdmissionPort;
  /** REQUIRED: the capability authority seam. */
  readonly capabilities: import("../ports/capability-admission").EconomicCapabilityAdmissionPort;
  /**
   * REQUIRED: the budgets module's reservation/settlement authority — the
   * canonical spending-control surface (reserve before authorization
   * issuance, settle/release on outcome; never reimplemented here).
   */
  readonly budget: BudgetAuthority;
  /** REQUIRED: the executions module's canonical ledger step-event seam. */
  readonly executions: EconomicExecutionLedger;
  readonly generateId: () => string;
  readonly now: () => Date;
}
